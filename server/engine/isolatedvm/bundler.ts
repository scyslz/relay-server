import { transformRouteToModule } from '../transform';
import { isBareSpecifier } from '../modules';

// node: builtins that the sandbox shims (host-backed). Everything else that is a
// node builtin is intentionally NOT provided, so the in-isolate `require` shim
// throws a clear "not available in sandbox" error instead of silently working.
export const SHIMMED_BUILTINS = ['crypto', 'path', 'util', 'fs'] as const;

export const ALL_NODE_BUILTINS = [
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder',
  'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url',
  'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
];

// Bundle route code (as an ESM module with hoisted imports) into a single
// self-contained CJS script that runs inside the isolate. Bare npm imports are
// inlined by esbuild; node: builtins are left external so the sandbox's
// `require` shim decides what is available. Returns the CJS source.
//
// esbuild is loaded lazily (not a static import): if the runtime image was
// built without it, a static import would crash the whole server bundle with
// "Cannot find module 'esbuild'" before anything starts. Missing esbuild only
// breaks routes that use bare npm imports (clear per-route error), never boot.
export async function bundleRoute(code: string, resolveDir: string): Promise<string> {
  const moduleSource = transformRouteToModule(code);
  let build: typeof import('esbuild')['build'];
  try {
    // CJS bundle (dist/server.cjs) has a real `require`; ESM dev (tsx) does
    // not — `typeof` guard keeps this ReferenceError-free in both.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localRequire: any = (typeof require === 'function') ? require : null;
    if (!localRequire) throw new Error('no require available');
    ({ build } = localRequire('esbuild'));
  } catch {
    throw new Error(
      'route bundling needs the "esbuild" package, which is not installed in this image; ' +
      'rebuild the image with esbuild or switch the route to the process engine'
    );
  }
  const result = await build({
    stdin: {
      contents: moduleSource,
      resolveDir,
      sourcefile: 'route.mjs',
      loader: 'js'
    },
    bundle: true,
    format: 'cjs',
    write: false,
    platform: 'node',
    target: 'es2020',
    logLevel: 'silent',
    // Leave node builtins external: the isolate-side require shim gates them.
    external: ALL_NODE_BUILTINS.map(b => b) as string[]
  });
  return result.outputFiles[0].text;
}

// True if a route's imports are supported by the isolatedvm sandbox (only
// npm packages + the shimmed builtins). Used for fast fail in warmUp.
export function unsupportedImports(code: string): string[] {
  const re = /\bimport\b[^;\n]*?\bfrom\s*["']([^"']+)["']|(?:^|\s)\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !isBareSpecifier(spec)) continue;
    if (spec.startsWith('node:')) {
      const name = spec.slice(5);
      if (!(SHIMMED_BUILTINS as readonly string[]).includes(name)) found.add(spec);
    } else if (spec.startsWith('node_modules/')) {
      // not a bare specifier in ESM terms
    }
  }
  return Array.from(found);
}