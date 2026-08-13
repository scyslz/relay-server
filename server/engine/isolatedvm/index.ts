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
// Cross-request state lives in maps keyed by globally-monotonic ids
// (fetch/timer/ws). Because ids never repeat while a context is reused, host
// callbacks for one in-flight request can never collide with another: request
// interleaving on a single isolate is therefore safe. Per-request state
// (request/response/fetch/console) is built per-invocation in SANDBOX_INVOKE.
globalThis.__fetchPending = {};
globalThis.__fetchSeq = 0;
globalThis.__slotFn = undefined;
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
// Global timer/ws versions are only reached by bundled dependency code (npm
// packages) whose timer/ws references live outside the route's run() scope.
// They are host-owned: owner id 0, cleaned up on timeout/dispose only, never
// per-request. The route body itself gets per-request closures from __invoke.
globalThis.setTimeout = (fn, ms) => { const id = __hostTimerStart(0, 'timeout', ms); __timerCbs[id] = fn; return id; };
globalThis.clearTimeout = (id) => { delete __timerCbs[id]; __hostTimerClear(id); };
globalThis.setInterval = (fn, ms) => { const id = __hostTimerStart(0, 'interval', ms); __timerCbs[id] = fn; return id; };
globalThis.clearInterval = (id) => { delete __timerCbs[id]; __hostTimerClear(id); };
globalThis.__timerCbs = {};
globalThis.__timerFire = (id) => { const f = __timerCbs[id]; if (f) { delete __timerCbs[id]; f(); } };
globalThis.__timerFireInterval = (id) => { const f = __timerCbs[id]; if (f) f(); };
globalThis.__timerRemove = (id) => { delete globalThis.__timerCbs[id]; };
globalThis.__tlsInsecure = false;
globalThis.__wsMap = {};
globalThis.__wsSeq = 0;
globalThis.WebSocket = class {
  constructor(url) {
    this.id = ++globalThis.__wsSeq;
    this.url = String(url);
    this.readyState = 0;
    globalThis.__wsMap[this.id] = this;
    __hostWsStart(0, this.url, __tlsInsecure, this.id);
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
globalThis.__wsRemove = (id) => { delete globalThis.__wsMap[id]; };
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

// __invoke builds a fully per-request sandbox in closures: request, response,
// fetch and console are scoped to a single invocation, so many requests can run
// concurrently (interleaved) on the same isolate. The route fn is captured
// synchronously (in the host's sync runStep below) into __slotFn right before
// invoke is dispatched, and read here before the first await — so other
// requests cannot clobber it. Shared global tables are keyed by monotonic ids
// and never collide. reqId routes logs back to the right request's buffer.
// Note: there is intentionally no per-request reset of the shared global tables
// (__fetchPending/__timerCbs/__wsMap); interleaved requests must keep them.
const SANDBOX_INVOKE = `
globalThis.__invoke = async (reqJson, reqId) => {
  const fn = globalThis.__slotFn;
  const request = JSON.parse(reqJson);
  if (typeof fn !== 'function') {
    __hostLog(reqId, 'error', 'invoke: route fn unavailable, type=' + typeof fn);
    throw new Error('route module has no default export (check transform)');
  }
  var state = { status: 200, headers: {}, body: null, sent: false };
  var response = {
    status: (c) => { state.status = c; return response; },
    setHeader: (k, v) => { state.headers[k] = v; return response; },
    json: (d) => { state.headers['Content-Type'] = 'application/json'; state.body = JSON.stringify(d, null, 2); state.sent = true; return response; },
    send: (d) => {
      if (typeof d === 'object') { state.headers['Content-Type'] = 'application/json'; state.body = JSON.stringify(d, null, 2); }
      else { if (!state.headers['Content-Type']) state.headers['Content-Type'] = 'text/plain; charset=utf-8'; state.body = String(d); }
      state.sent = true; return response;
    },
    redirect: (u) => { state.status = 302; state.headers['Location'] = u; state.body = 'Redirecting to ' + u; state.sent = true; return response; }
  };
  var fetch = (url, init) => new Promise((resolve, reject) => {
    const id = ++globalThis.__fetchSeq;
    globalThis.__fetchPending[id] = { resolve, reject };
    __hostFetchStart(reqId, String(url), JSON.stringify(init || {}), id);
  });
  // Per-request timer/websocket closures. These are the ones the route body
  // sees (via the run() destructured params), and they close over reqId so the
  // host attributes every timer/ws to exactly this request for per-request
  // cleanup. No shared "active request" marker is consulted, which removes the
  // attribution race for timers/ws created after an await. The global
  // (SANDBOX_MAIN) versions remain for bundled dependency code that references
  // timers/WebSocket outside the route function scope; those are host-owned
  // and only cleaned up on timeout/dispose.
  var setTimeout = (fn, ms) => { const id = __hostTimerStart(reqId, 'timeout', ms); __timerCbs[id] = fn; return id; };
  var setInterval = (fn, ms) => { const id = __hostTimerStart(reqId, 'interval', ms); __timerCbs[id] = fn; return id; };
  var clearTimeout = (id) => { delete __timerCbs[id]; __hostTimerClear(id); };
  var clearInterval = (id) => { delete __timerCbs[id]; __hostTimerClear(id); };
  var WebSocket = class {
    constructor(url) {
      this.id = ++globalThis.__wsSeq;
      this.url = String(url);
      this.readyState = 0;
      globalThis.__wsMap[this.id] = this;
      __hostWsStart(reqId, this.url, __tlsInsecure, this.id);
    }
    send(data) { __hostWsSend(this.id, String(data)); }
    close() { __hostWsClose(this.id); }
  };
  var console = {
    log: (...a) => { __hostLog(reqId, 'log', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
    warn: (...a) => { __hostLog(reqId, 'warn', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
    error: (...a) => { __hostLog(reqId, 'error', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
    info: (...a) => { __hostLog(reqId, 'info', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); }
  };
  const r = await fn({ request, response, fetch, console, fs, setTimeout, setInterval, clearTimeout, clearInterval, WebSocket });
  if (r !== undefined) {
    __hostLog(reqId, 'info', 'invoke: route returned type=' + typeof r);
  }
  return JSON.stringify({ state, result: r });
};
`;

// Per-request state used to be reset via a per-run script. With request
// interleaving that is gone: shared global tables (__fetchPending/__timerCbs/
// __wsMap) are keyed by globally-monotonic ids and are deliberately NOT cleared
// between requests, and all genuinely per-request state lives in __invoke
// closures. The bundle wrapper resets module.exports itself (see wrapBundleCode).

interface IsolateEntry {
  iso: ivm.Isolate;
  // number of requests currently executing (interleaved) on this entry
  active: number;
  // set when a request on this entry timed out; the isolate may be holding
  // abandoned promises/resources, so it is recycled once idle
  dirty: boolean;
  index: number;
  // host-side timers created for this isolate, keyed by timer id
  timers: Map<number, NodeJS.Timeout>;
  // which request owns each host timer (for per-request cleanup)
  timerOwner: Map<number, number>;
  wsConns: Map<number, import('ws').WebSocket>;
  // which request owns each host ws connection (for per-request cleanup)
  wsOwner: Map<number, number>;
  // host-side in-flight fetch AbortControllers, keyed by sandbox fetch id
  fetchAbort: Map<number, AbortController>;
  // which request owns each in-flight host fetch (for per-request cleanup)
  fetchOwner: Map<number, number>;
  // persistent context reused across requests (created lazily on first use)
  ctx?: ivm.Context;
  // in-flight context creation (concurrency guard for interleaved first touches)
  ctxPromise?: Promise<ivm.Context>;
  // compiled route bundles, keyed by `${route.id}:${hash}`; a Script is bound
  // to its isolate, so each pool entry keeps its own copy.
  bundleScripts: Map<string, ivm.Script>;
  // logs buffers per in-flight request (interleaved requests keep separate logs)
  logsByReq: Map<number, string[]>;
  // last time this entry finished or started serving a request (for shrink)
  lastUsed: number;
}

export class IsolatedVmEngine implements RouteEngine {
  readonly name = 'isolatedvm' as const;
  private opts: Required<EngineOptions> & { poolSize?: number };
  private pool: IsolateEntry[] = [];
  private rr = 0;
  private nextTimerId = 1;
  private nextReqId = 1;
  private bundleCache = new Map<string, string>();
  // in-flight bundle builds per cache key, so concurrent first touches of the
  // same route share one esbuild/install instead of each redoing the work
  private bundleInFlight = new Map<string, Promise<string>>();
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
      active: 0,
      dirty: false,
      index,
      timers: new Map(),
      timerOwner: new Map(),
      wsConns: new Map(),
      wsOwner: new Map(),
      fetchAbort: new Map(),
      fetchOwner: new Map(),
      bundleScripts: new Map(),
      logsByReq: new Map(),
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
        if (e.active === 0 && now - e.lastUsed >= idleMs) reclaimed.push(i);
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
  // module.exports is reset here (before the bundle runs) and the route's
  // default export is captured into __slotFn, from where __invoke reads it
  // synchronously. Because the host runs this script with runSync and then
  // dispatches invoke with no intervening await, another interleaved request's
  // bundle can never clobber __slotFn in between.
  private wrapBundleCode(bundle: string): string {
    return `(() => {
  globalThis.module.exports = {};
  globalThis.exports = globalThis.module.exports;
  ${bundle}
  globalThis.__slotFn = globalThis.module.exports.default;
})();`;
  }

  private async ensureContext(entry: IsolateEntry): Promise<ivm.Context> {
    if (entry.ctx) return entry.ctx;
    if (!entry.ctxPromise) {
      entry.ctxPromise = entry.iso.createContext()
        .then(async (ctx) => {
          this.installBridges(entry, ctx);
          await ctx.eval(this.buildStaticSandboxCode());
          // Only cache the context after the static sandbox is fully installed;
          // a failed eval must not leave a half-initialized context that future
          // requests would pick up (it would poison the entry forever).
          entry.ctx = ctx;
          return ctx;
        })
        .catch((e) => {
          entry.ctxPromise = undefined;
          entry.ctx = undefined;
          entry.bundleScripts.clear();
          for (const [, t] of entry.timers) clearTimeout(t);
          entry.timers.clear();
          entry.timerOwner.clear();
          try { entry.iso.dispose(); } catch {}
          entry.iso = new ivm.Isolate({ memoryLimit: this.opts.memoryLimitMb });
          throw e;
        });
    }
    return entry.ctxPromise;
  }

  // Replace the isolate of an entry that served a timed-out request. The
  // timeout promise keeps abandoned timers/ws/promises alive inside the old
  // context, so we tear the whole thing down once nothing is running on it
  // and build a fresh context lazily on the next request. This bounds leaked
  // resources to the pool size and re-installs the bridges automatically.
  private recycleEntry(entry: IsolateEntry) {
    entry.dirty = false;
    for (const [, t] of entry.timers) clearTimeout(t);
    entry.timers.clear();
    entry.timerOwner.clear();
    for (const [, ws] of entry.wsConns) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    entry.wsConns.clear();
    entry.wsOwner.clear();
    for (const [, ac] of entry.fetchAbort) { try { ac.abort(); } catch {} }
    entry.fetchAbort.clear();
    entry.fetchOwner.clear();
    entry.logsByReq.clear();
    entry.bundleScripts.clear();
    entry.ctx = undefined;
    entry.ctxPromise = undefined;
    try {
      entry.iso.dispose();
    } catch {
      /* already disposed */
    }
    entry.iso = new ivm.Isolate({ memoryLimit: this.opts.memoryLimitMb });
    console.log(`[IsolatedVM] Recycled stale isolate #${entry.index}`);
  }

  // Max requests that may be interleaved on a single isolate. Async routes
  // (fetch/timers/ws) yield their isolate while awaiting, so several can share
  // one entry; sync routes serialize on it, which the pool sizing absorbs.
  private maxConcurrentPerEntry(): number {
    return this.opts.maxConcurrentPerEntry ?? 8;
  }

  // Reserve a pool entry for a request, synchronously incrementing its active
  // count before returning so concurrent pickers never oversubscribe an entry.
  private async pick(): Promise<IsolateEntry> {
    const cap = this.maxConcurrentPerEntry();
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[(this.rr + i) % this.pool.length];
      if (e.active < cap) {
        this.rr = (this.rr + i + 1) % this.pool.length;
        e.active++;
        e.lastUsed = Date.now();
        return e;
      }
    }
    // All entries at their concurrency cap: grow the pool up to maxPoolSize
    // before queueing.
    if (this.pool.length < this.maxPoolSize()) {
      const e = this.createEntry(this.pool.length);
      this.pool.push(e);
      this.rr = (this.rr + 1) % this.pool.length;
      e.active++;
      console.log(`[IsolatedVM] Pool grown to ${this.pool.length} (load)`);
      return e;
    }
    const start = Date.now();
    while (Date.now() - start < this.opts.timeoutMs) {
      await new Promise(r => setTimeout(r, 5));
      const e = this.pool.find(x => x.active < cap);
      if (e) { e.active++; return e; }
    }
    throw new Error('all isolated-vm sandboxes at capacity (pool exhausted)');
  }

  private async getBundle(route: Route): Promise<{ bundle: string; hash: string }> {
    const resolvedCode = route.code; // note: URL template resolution is done by server.ts before engine sees routes
    const hash = crypto.createHash('sha1').update(resolvedCode).digest('hex').slice(0, 12);
    const key = `${route.id}:${hash}`;
    let b = this.bundleCache.get(key);
    if (!b) {
      // Concurrent first touches share the same in-flight build so npm install +
      // esbuild run once per (route,hash) instead of once per racing request.
      let inflight = this.bundleInFlight.get(key);
      if (!inflight) {
        inflight = (async () => {
          await ensureBareImportsInstalled(route.code, this.installCtx);
          const bundled = await bundleRoute(route.code, this.opts.scriptsDir);
          this.bundleCache.set(key, bundled);
          if (this.bundleCache.size > 200) {
            // simple FIFO eviction
            const first = this.bundleCache.keys().next().value;
            if (first !== undefined) this.bundleCache.delete(first);
          }
          return bundled;
        })().finally(() => {
          // Drop the in-flight slot whether the build succeeded or failed; a
          // later request retries after a failure.
          if (this.bundleInFlight.get(key) === inflight) this.bundleInFlight.delete(key);
        });
        this.bundleInFlight.set(key, inflight);
      }
      b = await inflight;
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
      (reqId: number, url: string, initJson: string, id: number) => {
        void this.runHostFetch(entry, reqId, id, url, initJson);
        return 0;
      }
    ));
    // console bridge (reqId routes the line to the right request's logs)
    ctx.global.setSync('__hostLog', new ivm.Callback(
      (reqId: number, tag: string, line: string) => {
        const buf = entry.logsByReq.get(reqId);
        if (buf) buf.push(`[${tag.toUpperCase()}] ${line}`.slice(0, 2000));
        return 0;
      }
    ));
    // node builtin shim bridge
    ctx.global.setSync('__hostBuiltin', new ivm.Callback(
      (id: string, argsJson: string) => this.runBuiltin(id, argsJson)
    ));
    // timer bridge (reqId lets the host attribute timers for per-request cleanup)
    ctx.global.setSync('__hostTimerStart', new ivm.Callback(
      (reqId: number, mode: string, ms: number) => {
        const id = this.nextTimerId++;
        const timer = mode === 'interval' ? setInterval(() => {
          try {
            const fire = ctx.global.getSync('__timerFireInterval', { reference: true });
            fire.applySync(undefined, [id], { arguments: { copy: true } });
          } catch {}
        }, Math.max(0, ms)) : setTimeout(() => {
          entry.timers.delete(id);
          entry.timerOwner.delete(id);
          try {
            const fire = ctx.global.getSync('__timerFire', { reference: true });
            fire.applySync(undefined, [id], { arguments: { copy: true } });
          } catch {}
        }, Math.max(0, ms));
        entry.timers.set(id, timer);
        entry.timerOwner.set(id, reqId);
        return id;
      }
    ));
    ctx.global.setSync('__hostTimerClear', new ivm.Callback(
      (id: number) => {
        const t = entry.timers.get(id);
        if (t) { clearTimeout(t); clearInterval(t); entry.timers.delete(id); entry.timerOwner.delete(id); }
        return 0;
      }
    ));
    // websocket bridge (same sync-start + host-push pattern as fetch)
    entry.wsConns = entry.wsConns || new Map<number, import('ws').WebSocket>();
    ctx.global.setSync('__hostWsStart', new ivm.Callback(
      (reqId: number, url: string, insecure: boolean, sandboxId: number) => {
        entry.wsOwner.set(sandboxId, reqId);
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

  // Clear host timers. With reqId set, only timers owned by that request are
  // cleared (safe under interleaving); without reqId, all are cleared (dispose).
  // The matching sandbox __timerCbs entries are removed too so interval callbacks
  // left behind by a finished request do not accumulate inside the context.
  private clearTimers(entry: IsolateEntry, reqId?: number) {
    const removeSandbox = (id: number) => {
      const ctx = entry.ctx;
      if (!ctx) return;
      try {
        const fn = ctx.global.getSync('__timerRemove', { reference: true });
        fn.applySync(undefined, [id], { arguments: { copy: true } });
      } catch {
        /* context may be disposed */
      }
    };
    if (reqId === undefined) {
      for (const id of Array.from(entry.timers.keys())) {
        const t = entry.timers.get(id);
        if (t) { clearTimeout(t); clearInterval(t); }
        removeSandbox(id);
      }
      entry.timers.clear();
      entry.timerOwner.clear();
      return;
    }
    for (const [id, owner] of entry.timerOwner) {
      if (owner === reqId) {
        const t = entry.timers.get(id);
        if (t) { clearTimeout(t); clearInterval(t); }
        removeSandbox(id);
        entry.timers.delete(id);
        entry.timerOwner.delete(id);
      }
    }
  }

  // Clear host ws connections. With reqId set, only connections owned by that
  // request are closed; without reqId, all are closed (dispose). The matching
  // sandbox __wsMap entries are removed too to avoid residue inside the context.
  private clearWs(entry: IsolateEntry, reqId?: number) {
    const removeSandbox = (sandboxId: number) => {
      const ctx = entry.ctx;
      if (!ctx) return;
      try {
        const fn = ctx.global.getSync('__wsRemove', { reference: true });
        fn.applySync(undefined, [sandboxId], { arguments: { copy: true } });
      } catch {
        /* context may be disposed */
      }
    };
    const close = (sandboxId: number) => {
      const ws = entry.wsConns.get(sandboxId);
      if (ws) { try { if (ws.readyState === 1 || ws.readyState === 0) ws.close(); } catch {} }
      entry.wsConns.delete(sandboxId);
      removeSandbox(sandboxId);
    };
    if (reqId === undefined) {
      for (const sandboxId of Array.from(entry.wsConns.keys())) close(sandboxId);
      entry.wsOwner.clear();
      return;
    }
    for (const [sandboxId, owner] of entry.wsOwner) {
      if (owner === reqId) {
        close(sandboxId);
        entry.wsOwner.delete(sandboxId);
      }
    }
  }

  private async runHostFetch(entry: IsolateEntry, reqId: number, id: number, url: string, initJson: string): Promise<void> {
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
    // AbortController tracks every in-flight fetch so the host can cancel it
    // when its owning request finishes (fire-and-forget fetches would otherwise
    // leak undici sockets + sandbox __fetchPending entries forever). AbortSignal
    // cannot cross the isolate boundary, so a route-level numeric timeoutMs is
    // materialized here as an abort.
    const ac = new AbortController();
    opts.signal = ac.signal;
    entry.fetchAbort.set(id, ac);
    entry.fetchOwner.set(id, reqId);
    if (Number.isFinite(init.timeoutMs) && init.timeoutMs > 0) {
      setTimeout(() => ac.abort(new Error(`fetch timeout after ${init.timeoutMs}ms`)), init.timeoutMs);
    }
    try {
      const res = await f(url, opts);
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v: string, k: string) => { headers[k] = v; });
      const result = JSON.stringify({ status: res.status, ok: res.ok, statusText: res.statusText, headers, body: text });
      this.pushFetchResult(entry, id, result, null);
    } catch (e: any) {
      this.pushFetchResult(entry, id, null, e.message || 'FETCH_ERR');
    } finally {
      entry.fetchAbort.delete(id);
      entry.fetchOwner.delete(id);
    }
  }

  // Cancel in-flight host fetches. With reqId set, only fetches owned by that
  // request are aborted; without reqId, all are aborted (dispose).
  private clearFetch(entry: IsolateEntry, reqId?: number) {
    if (reqId === undefined) {
      for (const [, ac] of entry.fetchAbort) { try { ac.abort(); } catch {} }
      entry.fetchAbort.clear();
      entry.fetchOwner.clear();
      return;
    }
    for (const [id, owner] of entry.fetchOwner) {
      if (owner === reqId) {
        const ac = entry.fetchAbort.get(id);
        if (ac) { try { ac.abort(); } catch {} }
        entry.fetchAbort.delete(id);
        entry.fetchOwner.delete(id);
      }
    }
  }

  private pushFetchResult(entry: IsolateEntry, id: number, resultJson: string | null, errMsg: string | null): void {
    const ctx = entry.ctx;
    if (!ctx) return;
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
    const reqId = this.nextReqId++;
    entry.lastUsed = Date.now();
    entry.logsByReq.set(reqId, logs);
    try {
      const ctx = await this.ensureContext(entry);

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
      // Sync run + immediate dispatch: reading __slotFn happens inside __invoke
      // synchronously (before its first await), and we dispatch directly after
      // runSync with no await in between — so a concurrently-interleaved request
      // can never observe or clobber our captured route fn.
      bundleScript.runSync(ctx);
      const invoke = ctx.global.getSync('__invoke', { reference: true });

      const execPromise = invoke.apply(undefined, [JSON.stringify(reqInfo), reqId], {
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
      ]) as { __sandboxError?: Error; state?: any; result?: any };

      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (timedOut) {
        // The abandoned execPromise keeps the request forever pending inside the
        // context; mark the entry for recycling once it is idle.
        entry.dirty = true;
        throw new Error(`route execution timeout after ${this.opts.timeoutMs}ms`);
      }
      if (result && result.__sandboxError) {
        throw result.__sandboxError;
      }

      // __invoke returns JSON { state, result }; state is per-request, no shared
      // global __state to read anymore (interleaving forbids it).
      const out = typeof result === 'string' ? JSON.parse(result) : (result as any);
      const state = (out && out.state) || { status: 200, headers: {}, body: null, sent: false };
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
      // Out-of-memory and "isolate disposed" errors mean the sandbox internals
      // may be in an unreliable state (v8 heap exhausted, context torn down).
      // Recycle the entry once idle rather than reusing a possibly-corrupt
      // isolate for later requests.
      const msg = String(err && err.message);
      if (/memory|out of memory|isolate|disposed|terminated/i.test(msg)) {
        entry.dirty = true;
      }
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
      this.clearTimers(entry, reqId);
      this.clearWs(entry, reqId);
      this.clearFetch(entry, reqId);
      entry.logsByReq.delete(reqId);
      entry.active--;
      if (entry.active === 0 && entry.dirty) {
        this.recycleEntry(entry);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.shrinkTimer) { clearInterval(this.shrinkTimer); this.shrinkTimer = null; }
    for (const e of this.pool) {
      this.clearTimers(e);
      this.clearWs(e);
      this.clearFetch(e);
      e.bundleScripts.clear();
      try { e.ctx?.release(); } catch {}
      try { e.iso.dispose(); } catch {}
    }
    this.pool = [];
  }
}