import ivm from 'isolated-vm';
import os from 'os';
import path from 'path';
import * as crypto from 'crypto';
import * as fsMod from 'fs';
import { WebSocket as WsWebSocket } from 'ws';
import { Route } from '../../../src/types';
import { RouteEngine, ExecutionRequest, ExecutionResult, EngineOptions, DEFAULT_ENGINE_OPTIONS } from '../types';
import { ensureBareImportsInstalled, InstallContext } from '../modules';
import { bundleRoute } from './bundler';
import { buildPrelude } from './prelude';

// The isolatedvm engine runs each route inside a real V8 isolate with a memory
// cap and no shared process. Capabilities are bridged to the host through a
// small set of callbacks; no function, fs handle or node builtin leaks in by
// default. Route code is bundled with esbuild so npm imports work in the
// sandbox, while node builtins are gated by an allow-list shim.

const SANDBOX_MAIN = `
globalThis.__state = { status: 200, headers: {}, body: null, sent: false };
globalThis.response = {
  status: (c) => { __state.status = c; return response; },
  setHeader: (k, v) => { __state.headers[k] = v; return response; },
  json: (d) => { __state.headers['Content-Type'] = 'application/json'; __state.body = JSON.stringify(d, null, 2); __state.sent = true; return response; },
  send: (d) => {
    if (typeof d === 'object') { __state.headers['Content-Type'] = 'application/json'; __state.body = JSON.stringify(d, null, 2); }
    else { if (!__state.headers['Content-Type']) __state.headers['Content-Type'] = 'text/plain; charset=utf-8'; __state.body = String(d); }
    __state.sent = true; return response;
  },
  redirect: (u) => { __state.status = 302; __state.headers['Location'] = u; __state.body = 'Redirecting to ' + u; __state.sent = true; return response; }
};
globalThis.__fetchPending = {};
globalThis.__fetchSeq = 0;
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  const id = ++globalThis.__fetchSeq;
  globalThis.__fetchPending[id] = { resolve, reject };
  __hostFetchStart(String(url), JSON.stringify(init || {}), id);
});
globalThis.__fetchResolved = (id, resultJson, errMsg) => {
  const p = globalThis.__fetchPending[id];
  if (!p) return;
  delete globalThis.__fetchPending[id];
  if (errMsg) { const e = new Error(errMsg); e.code = 'FETCH_ERR'; p.reject(e); return; }
  const raw = JSON.parse(resultJson);
  const headerPairs = Object.entries(raw.headers || {});
  p.resolve({
    status: raw.status, ok: raw.ok, statusText: raw.statusText,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        const hit = headerPairs.find(([k]) => k.toLowerCase() === key);
        return hit ? hit[1] : null;
      },
      has: (name) => {
        const key = String(name).toLowerCase();
        return headerPairs.some(([k]) => k.toLowerCase() === key);
      },
      entries: () => headerPairs[Symbol.iterator](),
      forEach: (cb) => { for (const [k, v] of headerPairs) cb(v, k, { get: () => null }); }
    },
    text: async () => raw.body,
    json: async () => JSON.parse(raw.body)
  });
};
globalThis.console = {
  log: (...a) => { __hostLog('log', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
  warn: (...a) => { __hostLog('warn', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
  error: (...a) => { __hostLog('error', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
  info: (...a) => { __hostLog('info', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); }
};
globalThis.setTimeout = (fn, ms) => { const id = __hostTimerStart('timeout', ms); __timerCbs[id] = fn; return id; };
globalThis.clearTimeout = (id) => { delete __timerCbs[id]; __hostTimerClear(id); };
globalThis.setInterval = (fn, ms) => { const id = __hostTimerStart('interval', ms); __timerCbs[id] = fn; return id; };
globalThis.clearInterval = (id) => { delete __timerCbs[id]; __hostTimerClear(id); };
globalThis.__timerCbs = {};
globalThis.__timerFire = (id) => { const f = __timerCbs[id]; if (f) { delete __timerCbs[id]; f(); } };
globalThis.__timerFireInterval = (id) => { const f = __timerCbs[id]; if (f) f(); };
globalThis.__tlsInsecure = false;
globalThis.__wsMap = {};
globalThis.__wsSeq = 0;
globalThis.WebSocket = class {
  constructor(url) {
    this.id = ++globalThis.__wsSeq;
    this.url = String(url);
    this.readyState = 0;
    globalThis.__wsMap[this.id] = this;
    __hostWsStart(this.url, __tlsInsecure, this.id);
  }
  send(data) { __hostWsSend(this.id, String(data)); }
  close() { __hostWsClose(this.id); }
};
globalThis.__wsEvent = (id, type, data) => {
  const ws = globalThis.__wsMap[id];
  if (!ws) return;
  if (type === 'open') { ws.readyState = 1; if (ws.onopen) ws.onopen({}); }
  else if (type === 'message') { if (ws.onmessage) ws.onmessage({ data }); }
  else if (type === 'close') { ws.readyState = 3; if (ws.onclose) ws.onclose({ code: 1000, wasClean: true }); delete globalThis.__wsMap[id]; }
  else if (type === 'error') { if (ws.onerror) ws.onerror(new Error(data)); }
};
`;

// Globals the esbuild CJS bundle needs (module/exports/require). `require`
// routes node: builtins to the prelude shims; anything unshimmed throws.
const SANDBOX_MODULES = `
globalThis.require = (id) => {
  const b = String(id).replace(/^node:/, '');
  if (b === 'crypto') return __crypto;
  if (b === 'path') return __path;
  if (b === 'util') return __util;
  if (typeof __fs !== 'undefined' && b === 'fs') return __fs;
  throw new Error('node builtin not available in sandbox: ' + id);
};
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;
globalThis.__dirname = '/';
globalThis.__filename = '/route.js';
globalThis.fs = typeof __fs !== 'undefined' ? __fs : undefined;
`;

const SANDBOX_INVOKE = `
globalThis.__invoke = async (reqJson) => {
  globalThis.request = JSON.parse(reqJson);
  const fn = module.exports.default;
  if (typeof fn !== 'function') {
    __hostLog('error', 'invoke: module.exports.default is not a function, type=' + typeof fn);
    throw new Error('route module has no default export (check transform)');
  }
  const r = await fn({ request, response, fetch, console, fs });
  if (r !== undefined) {
    __hostLog('info', 'invoke: route returned type=' + typeof r);
  }
  return r;
};
`;

// Per-request state reset. The sandbox globals above are evaluated once per
// context; before every route run we wipe per-request state so a reused
// context never leaks data between requests. __fetchSeq/__wsSeq are NOT reset:
// ids must stay monotonic across requests so async host callbacks (whose close
// events may fire after the current request ends) can never collide with a
// later request's connection/fetch on the same reused context.
const SANDBOX_RESET = `
globalThis.__state = { status: 200, headers: {}, body: null, sent: false };
globalThis.__fetchPending = {};
globalThis.__timerCbs = {};
globalThis.__wsMap = {};
globalThis.request = { path: '/' };
globalThis.module.exports = {};
globalThis.exports = globalThis.module.exports;
`;

interface IsolateEntry {
  iso: ivm.Isolate;
  busy: boolean;
  index: number;
  // host-side timers created for this isolate (cleared on timeout/dispose)
  timers: Map<number, NodeJS.Timeout>;
  wsConns: Map<number, import('ws').WebSocket>;
  // persistent context reused across requests (created lazily on first use)
  ctx?: ivm.Context;
  // per-context compiled reset script (compiled once, run per request)
  resetScript?: ivm.Script;
  // compiled route bundles, keyed by `${route.id}:${hash}`; a Script is bound
  // to its isolate, so each pool entry keeps its own copy.
  bundleScripts: Map<string, ivm.Script>;
  // logs buffer of the request currently running on this entry
  currentLogs: string[];
  // last time this entry finished or started serving a request (for shrink)
  lastUsed: number;
}

export class IsolatedVmEngine implements RouteEngine {
  readonly name = 'isolatedvm' as const;
  private opts: Required<EngineOptions> & { poolSize?: number };
  private pool: IsolateEntry[] = [];
  private rr = 0;
  private nextTimerId = 1;
  private bundleCache = new Map<string, string>();
  private disposed = false;
  private installCtx: InstallContext;
  private shrinkTimer?: any;

  constructor(options: EngineOptions = {}) {
    this.opts = { ...DEFAULT_ENGINE_OPTIONS, ...options } as any;
    this.installCtx = {
      modulesDir: this.opts.modulesDir,
      scriptsDir: this.opts.scriptsDir,
      autoInstall: this.opts.autoInstall
    };
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
    while (this.pool.length < size) {
      this.pool.push(this.createEntry(this.pool.length));
    }
  }

  private createEntry(index: number): IsolateEntry {
    return {
      iso: new ivm.Isolate({ memoryLimit: this.opts.memoryLimitMb }),
      busy: false,
      index,
      timers: new Map(),
      wsConns: new Map(),
      bundleScripts: new Map(),
      currentLogs: [],
      lastUsed: Date.now()
    };
  }

  // Periodically reclaim idle pool entries that exceed the minimum size. This
  // keeps the pool small during quiet periods while letting it grow under load.
  private startShrinkTimer() {
    this.shrinkTimer = setInterval(() => {
      if (this.disposed) return;
      const min = this.minPoolSize();
      if (this.pool.length <= min) return;
      const now = Date.now();
      const idleMs = this.opts.idleMs ?? 60 * 1000;
      const reclaimed: number[] = [];
      for (let i = this.pool.length - 1; i >= min; i--) {
        const e = this.pool[i];
        if (!e.busy && now - e.lastUsed >= idleMs) reclaimed.push(i);
      }
      if (reclaimed.length === 0) return;
      for (const i of reclaimed) {
        const e = this.pool[i];
        this.clearTimers(e);
        this.clearWs(e);
        e.bundleScripts.clear();
        try { e.ctx?.release(); } catch {}
        try { e.iso.dispose(); } catch {}
      }
      // Remove reclaimed entries (indices sorted desc, splice safe).
      for (const i of reclaimed.sort((a, b) => b - a)) {
        this.pool.splice(i, 1);
      }
      console.log(`[IsolatedVM] Auto-shrunk pool ${this.pool.length + reclaimed.length} -> ${this.pool.length} (idle reclaim)`);
    }, 5 * 1000);
    if (typeof (this.shrinkTimer as any).unref === 'function') (this.shrinkTimer as any).unref();
  }

  // Static part of the sandbox (prelude + globals + module shims + invoke) is
  // evaluated exactly once per context. Only the route bundle (which differs
  // per request) is re-evaluated on each run.
  private buildStaticSandboxCode(): string {
    const prelude = buildPrelude({
      crypto: true,
      path: true,
      util: true,
      fs: this.opts.allowFs
    });
    return `${prelude}\n${SANDBOX_MAIN}\n${SANDBOX_MODULES}\n${SANDBOX_INVOKE}`;
  }

  // Route bundles are evaluated inside a function scope so re-running a bundle
  // on a reused context does not redeclare top-level const/let/var globals.
  private wrapBundleCode(bundle: string): string {
    return `(() => {\n${bundle}\n})();`;
  }

  private async ensureContext(entry: IsolateEntry): Promise<ivm.Context> {
    if (entry.ctx) return entry.ctx;
    const ctx = await entry.iso.createContext();
    entry.ctx = ctx;
    this.installBridges(entry, ctx);
    await ctx.eval(this.buildStaticSandboxCode());
    // Compile the per-request reset once so reuse is cheap; the route bundle
    // itself is compiled lazily in execute() and cached per entry.
    entry.resetScript = await entry.iso.compileScript(SANDBOX_RESET);
    return ctx;
  }

  private async pick(): Promise<IsolateEntry> {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this.rr + i) % this.pool.length];
      if (!e.busy) {
        this.rr = (this.rr + i + 1) % this.pool.length;
        e.lastUsed = Date.now();
        return e;
      }
    }
    // All busy: grow the pool up to maxPoolSize before queueing.
    if (this.pool.length < this.maxPoolSize()) {
      const e = this.createEntry(this.pool.length);
      this.pool.push(e);
      this.rr = (this.rr + 1) % this.pool.length;
      console.log(`[IsolatedVM] Pool grown to ${this.pool.length} (load)`);
      return e;
    }
    const start = Date.now();
    while (Date.now() - start < this.opts.timeoutMs) {
      await new Promise(r => setTimeout(r, 5));
      const e = this.pool.find(x => !x.busy);
      if (e) return e;
    }
    throw new Error('all isolated-vm sandboxes busy (pool exhausted)');
  }

  private async getBundle(route: Route): Promise<{ bundle: string; hash: string }> {
    const resolvedCode = route.code; // note: URL template resolution is done by server.ts before engine sees routes
    const hash = crypto.createHash('sha1').update(resolvedCode).digest('hex').slice(0, 12);
    const key = `${route.id}:${hash}`;
    let b = this.bundleCache.get(key);
    if (!b) {
      await ensureBareImportsInstalled(route.code, this.installCtx);
      b = await bundleRoute(route.code, this.opts.scriptsDir);
      this.bundleCache.set(key, b);
      if (this.bundleCache.size > 200) {
        // simple FIFO eviction
        const first = this.bundleCache.keys().next().value;
        if (first !== undefined) this.bundleCache.delete(first);
      }
    }
    return { bundle: b, hash };
  }

  private installBridges(entry: IsolateEntry, ctx: ivm.Context) {
    const iso = entry.iso;
    // fetch bridge: a synchronous "start" callback registers the fetch on the
    // host; when the host fetch settles it pushes the result back into the
    // sandbox via __fetchResolved. (isolated-vm async callbacks cannot return
    // a promise value — see laverdet/isolated-vm#530 — so the result is
    // delivered by pushing into the sandbox instead.)
    ctx.global.setSync('__hostFetchStart', new ivm.Callback(
      (url: string, initJson: string, id: number) => {
        void this.runHostFetch(ctx, id, url, initJson);
        return 0;
      }
    ));
    // console bridge
    ctx.global.setSync('__hostLog', new ivm.Callback(
      (tag: string, line: string) => { entry.currentLogs.push(`[${tag.toUpperCase()}] ${line}`.slice(0, 2000)); return 0; }
    ));
    // node builtin shim bridge
    ctx.global.setSync('__hostBuiltin', new ivm.Callback(
      (id: string, argsJson: string) => this.runBuiltin(id, argsJson)
    ));
    // timer bridge
    ctx.global.setSync('__hostTimerStart', new ivm.Callback(
      (mode: string, ms: number) => {
        const id = this.nextTimerId++;
        const timer = mode === 'interval' ? setInterval(() => {
          try {
            const fire = ctx.global.getSync('__timerFireInterval', { reference: true });
            fire.applySync(undefined, [id], { arguments: { copy: true } });
          } catch {}
        }, Math.max(0, ms)) : setTimeout(() => {
          entry.timers.delete(id);
          try {
            const fire = ctx.global.getSync('__timerFire', { reference: true });
            fire.applySync(undefined, [id], { arguments: { copy: true } });
          } catch {}
        }, Math.max(0, ms));
        entry.timers.set(id, timer);
        return id;
      }
    ));
    ctx.global.setSync('__hostTimerClear', new ivm.Callback(
      (id: number) => {
        const t = entry.timers.get(id);
        if (t) { clearTimeout(t); clearInterval(t); entry.timers.delete(id); }
        return 0;
      }
    ));
    // websocket bridge (same sync-start + host-push pattern as fetch)
    entry.wsConns = entry.wsConns || new Map<number, import('ws').WebSocket>();
    ctx.global.setSync('__hostWsStart', new ivm.Callback(
      (url: string, insecure: boolean, sandboxId: number) => {
        void this.runHostWs(entry, sandboxId, url, insecure);
        return 0;
      }
    ));
    ctx.global.setSync('__hostWsSend', new ivm.Callback(
      (sandboxId: number, data: string) => {
        const ws = entry.wsConns?.get(sandboxId);
        if (ws && ws.readyState === 1) { ws.send(data); }
        return 0;
      }
    ));
    ctx.global.setSync('__hostWsClose', new ivm.Callback(
      (sandboxId: number) => {
        const ws = entry.wsConns?.get(sandboxId);
        if (ws) { try { ws.close(); } catch {} }
        return 0;
      }
    ));
  }

  private clearTimers(entry: IsolateEntry) {
    for (const [, t] of entry.timers) { clearTimeout(t); clearInterval(t); }
    entry.timers.clear();
  }

  private clearWs(entry: IsolateEntry) {
    for (const [, ws] of entry.wsConns) {
      try { if (ws.readyState === 1 || ws.readyState === 0) ws.close(); } catch {}
    }
    entry.wsConns.clear();
  }

  private async runHostFetch(ctx: ivm.Context, id: number, url: string, initJson: string): Promise<void> {
    let init: any = {};
    try { init = JSON.parse(initJson || '{}'); } catch {}
    const { fetch: f, Agent } = await import('undici');
    const opts: any = { method: init.method || 'GET', headers: init.headers || {} };
    if (init.body != null) opts.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    // Standard RequestInit fields the bridge now honors (transparently passed
    // through to the host's undici fetch). Earlier versions only emitted
    // method/headers/body; the rest were silently dropped.
    if (typeof init.redirect === 'string') opts.redirect = init.redirect;
    if (typeof init.compress === 'boolean') opts.compress = init.compress;
    if (Number.isFinite(init.maxRedirects)) opts.maxRedirects = init.maxRedirects;
    if (typeof init.duplex === 'string') opts.duplex = init.duplex;
    // Fetch-scoped TLS bypass. A route skips TLS certificate verification per
    // call via the non-standard `insecure: true` (or `rejectUnauthorized:false`
    // / `tls:{rejectUnauthorized:false}`) init field — useful when most of the
    // route needs strict TLS but one call hits a self-signed internal endpoint.
    const wantInsecure = init.insecure === true
      || init.rejectUnauthorized === false
      || (init.tls && init.tls.rejectUnauthorized === false);
    if (wantInsecure) opts.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    // Per-request timeout: AbortSignal cannot cross the isolate boundary, so
    // the route passes a numeric `timeoutMs`; the host materializes one via
    // AbortController. Native undici fetch honors `signal` natively.
    let ac: AbortController | undefined;
    if (Number.isFinite(init.timeoutMs) && init.timeoutMs > 0) {
      ac = new AbortController();
      opts.signal = ac.signal;
      setTimeout(() => ac!.abort(new Error(`fetch timeout after ${init.timeoutMs}ms`)), init.timeoutMs);
    }
    try {
      const res = await f(url, opts);
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v: string, k: string) => { headers[k] = v; });
      const result = JSON.stringify({ status: res.status, ok: res.ok, statusText: res.statusText, headers, body: text });
      this.pushFetchResult(ctx, id, result, null);
    } catch (e: any) {
      this.pushFetchResult(ctx, id, null, e.message || 'FETCH_ERR');
    }
  }

  private pushFetchResult(ctx: ivm.Context, id: number, resultJson: string | null, errMsg: string | null): void {
    try {
      const fn = ctx.global.getSync('__fetchResolved', { reference: true });
      fn.applySync(undefined, [id, resultJson, errMsg], { arguments: { copy: true } });
    } catch (e) {
      // sandbox may have already released the context on timeout; ignore
    }
  }

  private runHostWs(entry: IsolateEntry, sandboxId: number, url: string, insecure: boolean): void {
    try {
      const ws = new WsWebSocket(url, { rejectUnauthorized: !insecure });
      entry.wsConns.set(sandboxId, ws);
      ws.on('open', () => { this.pushWsEvent(entry, sandboxId, 'open', ''); });
      ws.on('message', (data: Buffer | string) => { this.pushWsEvent(entry, sandboxId, 'message', String(data)); });
      ws.on('close', (code: number) => {
        this.pushWsEvent(entry, sandboxId, 'close', String(code));
        if (entry.wsConns.get(sandboxId) === ws) entry.wsConns.delete(sandboxId);
      });
      ws.on('error', (err: Error) => {
        this.pushWsEvent(entry, sandboxId, 'error', err.message);
        try { ws.close(); } catch {}
        if (entry.wsConns.get(sandboxId) === ws) entry.wsConns.delete(sandboxId);
      });
    } catch (e: any) {
      this.pushWsEvent(entry, sandboxId, 'error', e.message || 'WS_ERR');
    }
  }

  private async pushWsEvent(entry: IsolateEntry, sandboxId: number, type: string, data: string): Promise<void> {
    const ctx = entry.ctx;
    if (!ctx) return;
    try {
      const fn = ctx.global.getSync('__wsEvent', { reference: true });
      fn.applySync(undefined, [sandboxId, type, data], { arguments: { copy: true } });
    } catch (e) {
      // context may have been released on timeout
    }
  }
private runBuiltin(id: string, argsJson: string): any {
    const a = JSON.parse(argsJson || '[]');
    try {
      switch (id) {
        case 'crypto.createHash': {
          const hex = crypto.createHash(a[0]).update(String(a[1] ?? '')).digest(a[2] || 'hex') as string | Buffer;
          return { ok: true, hex: typeof hex === 'string' ? hex : hex.toString('hex') };
        }
        case 'crypto.createHmac': {
          const hex = crypto.createHmac(a[0], a[1]).update(String(a[2] ?? '')).digest(a[3] || 'hex') as string | Buffer;
          return { ok: true, hex: typeof hex === 'string' ? hex : hex.toString('hex') };
        }
        case 'crypto.randomBytes': {
          return { ok: true, b64: crypto.randomBytes(a[0] || 16).toString('base64') };
        }
        case 'crypto.randomUUID': {
          return { ok: true, uuid: crypto.randomUUID() };
        }
        case 'fs.readFileSync': {
          if (!this.opts.allowFs) return { ok: false, err: 'fs access disabled in sandbox' };
          return { ok: true, data: fsMod.readFileSync(a[0], 'utf-8') };
        }
        case 'fs.writeFileSync': {
          if (!this.opts.allowFs) return { ok: false, err: 'fs access disabled in sandbox' };
          fsMod.writeFileSync(a[0], a[1], 'utf-8');
          return { ok: true };
        }
        case 'fs.existsSync': {
          if (!this.opts.allowFs) return { ok: false, err: 'fs access disabled in sandbox' };
          return { ok: true, exists: fsMod.existsSync(a[0]) };
        }
        case 'fs.mkdirSync': {
          if (!this.opts.allowFs) return { ok: false, err: 'fs access disabled in sandbox' };
          fsMod.mkdirSync(a[0], { recursive: true });
          return { ok: true };
        }
        case 'fs.readdirSync': {
          if (!this.opts.allowFs) return { ok: false, err: 'fs access disabled in sandbox' };
          return { ok: true, list: fsMod.readdirSync(a[0]) };
        }
        default:
          return { ok: false, err: `no host shim for ${id}` };
      }
    } catch (e: any) {
      return { ok: false, err: e.message };
    }
  }

  async warmUp(route: Route): Promise<void> {
    // Bundle + parse the code; surfaces syntax / missing-package errors early.
    await this.getBundle(route);
  }
  async execute(route: Route, reqInfo: ExecutionRequest): Promise<ExecutionResult> {
    const start = Date.now();
    const logs: string[] = [];
    let bundle: string;
    let hash: string;
    try {
      const got = await this.getBundle(route);
      bundle = got.bundle;
      hash = got.hash;
    } catch (e: any) {
      logs.push(`[ERROR] Route bundle failed: ${e.message}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Script Execution Exception Isolated', routeId: route.id, message: e.message }, null, 2),
        logs,
        error: e.message,
        stack: e.stack,
        durationMs: Date.now() - start
      };
    }

    const entry = await this.pick();
    entry.busy = true;
    entry.currentLogs = logs;
    try {
      const ctx = await this.ensureContext(entry);
      if (entry.resetScript) {
        await entry.resetScript.run(ctx);
      } else {
        await ctx.eval(SANDBOX_RESET);
      }

      const key = `${route.id}:${hash}`;
      let bundleScript = entry.bundleScripts.get(key);
      if (!bundleScript) {
        bundleScript = await entry.iso.compileScript(this.wrapBundleCode(bundle));
        entry.bundleScripts.set(key, bundleScript);
        if (entry.bundleScripts.size > 200) {
          const first = entry.bundleScripts.keys().next().value;
          if (first !== undefined) entry.bundleScripts.delete(first);
        }
      }
      await bundleScript.run(ctx);
      const invoke = ctx.global.getSync('__invoke', { reference: true });

      const execPromise = invoke.apply(undefined, [JSON.stringify(reqInfo)], {
        arguments: { copy: true },
        result: { promise: true }
      }) as Promise<unknown>;

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        execPromise.catch((e: Error) => ({ __sandboxError: e })),
        new Promise<{ __sandboxError: Error }>((resolve) => {
          timeoutHandle = setTimeout(() => { timedOut = true; resolve({ __sandboxError: new Error(`route execution timeout after ${this.opts.timeoutMs}ms`) }); }, this.opts.timeoutMs);
        })
      ]) as { __sandboxError?: Error };

      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (timedOut) {
        throw new Error(`route execution timeout after ${this.opts.timeoutMs}ms`);
      }
      if (result && result.__sandboxError) {
        throw result.__sandboxError;
      }

      const state = await ctx.global.get('__state', { copy: true }) as any;
      if (!state.sent && state.body === null) {
        state.body = JSON.stringify({ message: 'Route executed successfully (No response payload explicitly sent)' });
      }
      return {
        statusCode: state.status || 200,
        headers: state.headers || { 'Content-Type': 'application/json' },
        body: state.body,
        logs,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      logs.push(`[ERROR] Route Script Exception caught: ${err.message}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Script Execution Exception Isolated',
          routeId: route.id,
          message: err.message,
          stack: err.stack
        }, null, 2),
        logs,
        error: err.message,
        stack: err.stack,
        durationMs: Date.now() - start
      };
    } finally {
      this.clearTimers(entry);
      this.clearWs(entry);
      entry.currentLogs = [];
      entry.busy = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.shrinkTimer) { clearInterval(this.shrinkTimer); this.shrinkTimer = null; }
    for (const e of this.pool) {
      this.clearTimers(e);
      this.clearWs(e);
      e.bundleScripts.clear();
      try { e.ctx?.release(); } catch {}
      try { e.iso.dispose(); } catch {}
    }
    this.pool = [];
  }
}