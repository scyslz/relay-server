import { fork, exec } from 'child_process';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { Route } from '../../../shared/types';
import { RouteEngine, ExecutionRequest, ExecutionResult, EngineOptions, DEFAULT_ENGINE_OPTIONS } from '../types';
import { transformRouteToModule, routeModuleFileName } from '../transform';
import { ensureBareImportsInstalled, resolveBundledImport } from '../modules';

// Directory of this engine module. `__dirname` exists when bundled as CJS
// (production: dist/, where worker.cjs is copied next to server.cjs); in ESM
// (tsx dev) it is undefined, so fall back to import.meta.url (engine/process/,
// where worker.cjs lives in the source tree).
const MODULE_DIR = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

interface WorkerEntry {
  proc: any;
  pending: Map<number, { resolve: (r: ExecutionResult) => void; reject: (e: Error) => void }>;
  busy: boolean;
  index: number;
  // last time this worker finished/started serving (for idle shrink)
  lastUsed: number;
  // set before kill by shrink so the exit handler won't respawn it
  retired?: boolean;
}

// Simple round-robin process pool for route execution. Scripts with very
// different loads are separated because each process gets its own V8 heap;
// the default pool gives one worker for concurrency + isolation, and can be
// scaled via RELAY_ENGINE_POOL.
export class ProcessEngine implements RouteEngine {
  readonly name = 'process' as const;
  private opts: Required<EngineOptions> & { poolSize?: number };
  private workers: WorkerEntry[] = [];
  private rr = 0;
  private workerFile: string;
  private nextId = 1;
  private disposed = false;
  private shrinkTimer?: any;

  constructor(options: EngineOptions = {}, workerFile?: string) {
    this.opts = { ...DEFAULT_ENGINE_OPTIONS, ...options } as any;
    this.workerFile = workerFile || path.join(MODULE_DIR, 'worker.cjs');
    this.ensurePool();
    this.startShrinkTimer();
  }

  private minPoolSize(): number {
    return this.opts.minPoolSize ?? this.opts.poolSize ?? Math.max(1, Math.min(os.cpus().length, 2));
  }

  private maxPoolSize(): number {
    return this.opts.maxPoolSize ?? Math.max(this.minPoolSize(), os.cpus().length * 2);
  }

  private ensurePool() {
    const size = this.minPoolSize();
    while (this.workers.length < size) {
      this.workers.push(this.spawnWorker(this.workers.length));
    }
  }

  // Periodically reap idle workers above the minimum size.
  private startShrinkTimer() {
    this.shrinkTimer = setInterval(() => {
      if (this.disposed) return;
      const min = this.minPoolSize();
      if (this.workers.length <= min) return;
      const now = Date.now();
      const idleMs = this.opts.idleMs ?? 60 * 1000;
      let reclaimed = 0;
      for (let i = this.workers.length - 1; i >= min; i--) {
        const w = this.workers[i];
        if (w.busy || now - w.lastUsed < idleMs) continue;
        w.retired = true;
        this.workers.splice(i, 1);
        try { w.proc.kill(); } catch {}
        reclaimed++;
      }
      if (reclaimed > 0) {
        console.log(`[Process] Auto-shrunk pool ${this.workers.length + reclaimed} -> ${this.workers.length} (idle reclaim)`);
      }
    }, 5 * 1000);
    if (typeof (this.shrinkTimer as any).unref === 'function') (this.shrinkTimer as any).unref();
  }

  private spawnWorker(index: number): WorkerEntry {
    const proc = fork(this.workerFile, [
      this.opts.scriptsDir,
      this.opts.modulesDir,
      String(!!this.opts.allowFs)
    ], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });

    // Resource limits per worker process.
    try {
      exec(`renice -n 5 -p ${proc.pid}`, () => {});
    } catch {}
    const cpu = index % os.cpus().length;
    try {
      exec(`taskset -pc ${cpu} ${proc.pid}`, () => {});
    } catch {}

    const entry: WorkerEntry = { proc, pending: new Map(), busy: false, index, lastUsed: Date.now() };
    proc.on('message', (msg: any) => {
      if (!msg || msg.id === undefined) return;
      const pend = entry.pending.get(msg.id);
      if (!pend) return;
      entry.pending.delete(msg.id);
      entry.busy = false;
      entry.lastUsed = Date.now();
      if (msg.type === 'result') {
        pend.resolve(msg.result as ExecutionResult);
      } else if (msg.type === 'error') {
        pend.reject(new Error(msg.error));
      } else if (msg.type === 'ready') {
        pend.resolve(undefined as ExecutionResult);
      }
      // Replenish pool: any worker that finishes returns to the rotation.
    });
    proc.on('exit', (code: number | null) => {
      const idx = this.workers.indexOf(entry);
      if (idx !== -1) {
        if (entry.retired) {
          // Shrink path: worker was killed intentionally, don't respawn.
          this.workers.splice(idx, 1);
        } else {
          this.workers[idx] = this.spawnWorker(entry.index);
        }
      }
      // Reject all pending requests of the dead worker.
      for (const [, pend] of entry.pending) {
        pend.reject(new Error(`worker exited (code ${code})`));
      }
      entry.pending.clear();
    });
    proc.on('error', (err: Error) => {
      for (const [, pend] of entry.pending) pend.reject(err);
      entry.pending.clear();
    });
    return entry;
  }
private async pickWorker(): Promise<WorkerEntry> {
    // round-robin, prefer least-recently-busy
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[(this.rr + i) % this.workers.length];
      if (!w.busy) {
        this.rr = (this.rr + i + 1) % this.workers.length;
        w.lastUsed = Date.now();
        return w;
      }
    }
    // All busy: grow the pool up to maxPoolSize before queueing.
    if (this.workers.length < this.maxPoolSize()) {
      const w = this.spawnWorker(this.workers.length);
      this.workers.push(w);
      this.rr = (this.rr + 1) % this.workers.length;
      console.log(`[Process] Pool grown to ${this.workers.length} (load)`);
      return w;
    }
    // All busy — wait for the least-loaded worker to free up.
    const start = Date.now();
    while (Date.now() - start < this.opts.timeoutMs) {
      await new Promise(r => setTimeout(r, 10));
      const w = this.workers.find(x => !x.busy);
      if (w) { w.lastUsed = Date.now(); return w; }
    }
    throw new Error('all worker processes busy (pool exhausted)');
  }

  async warmUp(route: Route): Promise<void> {
    const source = this.buildSource(route);
    const hash = this.hashFor(route.code);
    await ensureBareImportsInstalled(route.code, {
      modulesDir: this.opts.modulesDir,
      scriptsDir: this.opts.scriptsDir,
      autoInstall: this.opts.autoInstall
    });
    // Send a warm message to one worker.
    const w = await this.pickWorker();
    w.busy = true;
    w.lastUsed = Date.now();
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(id);
        w.busy = false;
        reject(new Error('warmUp timeout'));
      }, this.opts.timeoutMs);
      w.pending.set(id, {
        resolve: () => { clearTimeout(timer); w.busy = false; resolve(); },
        reject: (e) => { clearTimeout(timer); w.busy = false; reject(e); }
      });
      w.proc.send({ type: 'warm', id, routeId: route.id, hash, source });
    });
  }

  async execute(route: Route, reqInfo: ExecutionRequest): Promise<ExecutionResult> {
    const source = this.buildSource(route);
    const hash = this.hashFor(route.code);
    await ensureBareImportsInstalled(route.code, {
      modulesDir: this.opts.modulesDir,
      scriptsDir: this.opts.scriptsDir,
      autoInstall: this.opts.autoInstall
    });
    const w = await this.pickWorker();
    w.busy = true;
    const id = this.nextId++;
    return new Promise<ExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(id);
        w.busy = false;
        reject(new Error(`route execution timeout after ${this.opts.timeoutMs}ms`));
      }, this.opts.timeoutMs);
      w.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      w.proc.send({ type: 'execute', id, routeId: route.id, hash, source, request: reqInfo });
    });
  }

  private buildSource(route: Route): string {
    return transformRouteToModule(route.code);
  }

  private hashFor(code: string): string {
    return createHash('sha1').update(code).digest('hex').slice(0, 12);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.shrinkTimer) { clearInterval(this.shrinkTimer); this.shrinkTimer = null; }
    for (const w of this.workers) {
      try { w.proc.kill(); } catch {}
    }
    this.workers = [];
  }
}