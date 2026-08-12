// Isolate-side prelude: installs the sandbox globals (response, fetch, console,
// timers, node-builtin shims) that route code relies on. Because no function can
// cross the isolate boundary, every capability is either defined here in pure
// JS or bridged to the host through a small set of callback hooks
// (__hostFetch, __hostLog, __hostBuiltin, __hostTimer*).
//
// The route body itself is bundled with esbuild (see ../bundler.ts) so that bare
// imports of npm packages work inside the isolate, then run as a plain script
// with the sandbox globals below visible to it.

export interface PreludeBuiltins {
  // Which node: builtins get a host-backed shim in the sandbox.
  crypto?: boolean;
  path?: boolean;
  util?: boolean;
  fs?: boolean;
}

export function buildPrelude(b: PreludeBuiltins = {}): string {
  const crypto = b.crypto
    ? `
globalThis.__crypto = {
  createHash: (algo) => {
    const h = { _d: '', update: (data) => { h._d = (h._d || '') + data; return h; }, digest: (enc) => {
      const r = __hostBuiltin('crypto.createHash', JSON.stringify([algo, h._d || '', enc || 'hex']));
      if (!r.ok) throw new Error(r.err || 'crypto error');
      return r.hex;
    } };
    return h;
  },
  createHmac: (algo, key) => {
    const h = { _d: '', update: (data) => { h._d = (h._d || '') + data; return h; }, digest: (enc) => {
      const r = __hostBuiltin('crypto.createHmac', JSON.stringify([algo, key, h._d || '', enc || 'hex']));
      if (!r.ok) throw new Error(r.err || 'crypto error');
      return r.hex;
    } };
    return h;
  },
  randomBytes: (n) => {
    const r = __hostBuiltin('crypto.randomBytes', JSON.stringify([n]));
    if (!r.ok) throw new Error(r.err || 'crypto error');
    return Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
  },
  randomUUID: () => {
    const r = __hostBuiltin('crypto.randomUUID', '[]');
    if (!r.ok) throw new Error(r.err || 'crypto error');
    return r.uuid;
  }
}
`
    : '';
  const path = b.path
    ? `
globalThis.__path = {
  join: (...p) => p.filter(Boolean).join('/'),
  resolve: (...p) => p.filter(Boolean).join('/'),
  basename: (p) => String(p).split('/').pop(),
  dirname: (p) => { const s = String(p).split('/'); s.pop(); return s.join('/') || '.'; },
  extname: (p) => { const b2 = String(p).split('/').pop() || ''; const i = b2.lastIndexOf('.'); return i > 0 ? b2.slice(i) : ''; },
  sep: '/',
  posix: { join: (...p) => p.filter(Boolean).join('/'), dirname: (p) => '.', basename: (p) => String(p).split('/').pop(), extname: (p) => '' },
  win32: { join: (...p) => p.filter(Boolean).join('/'), dirname: (p) => '.', basename: (p) => String(p).split('/').pop(), extname: (p) => '' }
}
`
    : '';
  const util = b.util
    ? `
globalThis.__util = {
  inspect: (x, o) => typeof x === 'object' ? JSON.stringify(x) : String(x),
  format: (...a) => a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '),
  isString: (x) => typeof x === 'string',
  isBuffer: (x) => ArrayBuffer.isView(x),
  types: { isDate: (x) => x instanceof Date, isRegExp: (x) => x instanceof RegExp }
}
`
    : '';
  const fs = b.fs
    ? `
globalThis.__fs = {
  readFileSync: (p) => { const r = __hostBuiltin('fs.readFileSync', JSON.stringify([String(p)])); if (!r.ok) { const e = new Error(r.err || 'fs error'); e.code = 'ENOENT'; throw e; } return r.data; },
  writeFileSync: (p, d) => { const r = __hostBuiltin('fs.writeFileSync', JSON.stringify([String(p), String(d)])); if (!r.ok) throw new Error(r.err || 'fs error'); },
  existsSync: (p) => { const r = __hostBuiltin('fs.existsSync', JSON.stringify([String(p)])); return !!r.ok && !!r.exists; },
  mkdirSync: (p) => { const r = __hostBuiltin('fs.mkdirSync', JSON.stringify([String(p)])); if (!r.ok && !/EEXIST/.test(r.err || '')) throw new Error(r.err || 'fs error'); },
  readdirSync: (p) => { const r = __hostBuiltin('fs.readdirSync', JSON.stringify([String(p)])); if (!r.ok) throw new Error(r.err || 'fs error'); return r.list; }
}
`
    : '';
  return `(function() {
${crypto}
${path}
${util}
${fs}
})()`;
}

// Bridge hooks the host installs as callbacks in the context global.
export const BRIDGE_HOOKS = {
  fetch: '__hostFetch',
  log: '__hostLog',
  builtin: '__hostBuiltin',
  timerStart: '__hostTimerStart',
  timerClear: '__hostTimerClear'
} as const;