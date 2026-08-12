import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// True for a specifier that must be resolved by node_modules (not builtin,
// relative/absolute path, or remote/data URL).
export function isBareSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('node:')) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')
    || specifier.startsWith('http:') || specifier.startsWith('https:') || specifier.startsWith('data:')) {
    return false;
  }
  return true;
}

// Map an import specifier to its npm package name.
export function barePackageName(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

export function splitImportSpec(spec: string): { name: string; version?: string } {
  if (!isBareSpecifier(spec)) return { name: spec };
  const at = spec.lastIndexOf('@');
  if (at > 0) {
    const candidate = spec.slice(at + 1);
    if (/^(?:[~^><=]*\d|latest|next|\*)/.test(candidate)) {
      return { name: spec.slice(0, at), version: candidate };
    }
  }
  return { name: spec };
}

// Collect every static bare import specifier (import x from 'pkg', import 'pkg',
// dynamic import("pkg")), keeping pinned @version.
export function extractBareImports(code: string): { name: string; version?: string }[] {
  const out = new Map<string, { name: string; version?: string }>();
  const re = /\bimport\b[^;\n]*?\bfrom\s*["']([^"']+)["']|(?:^|\s)\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !isBareSpecifier(spec)) continue;
    const { name, version } = splitImportSpec(spec);
    const key = `${name}${version ? '@' + version : ''}`;
    if (!out.has(key)) out.set(key, { name, version });
  }
  return Array.from(out.values());
}

// Strip the pinned @version from import specifiers ("from 'undici@7.29.0'" -> "from 'undici'").
export function stripImportVersions(imports: string): string {
  const re = /(\b(?:from|import)\b\s*["'])([^"']+)(["'])/g;
  return imports.replace(re, (full, pre, spec, post) => {
    if (!isBareSpecifier(spec)) return full;
    const { name, version } = splitImportSpec(spec);
    if (!version) return full;
    return `${pre}${name}${post}`;
  });
}

// Try to read the missing package name out of an ESM resolution error.
export function missingPackageFromError(err: any): string | null {
  const msg = String((err && err.message) || '');
  const m = msg.match(/Cannot find (?:package|module)\s*['"]?([^'",\s/]+(?:[/][^'",\s]*)?)/i);
  if (!m) return null;
  const spec = m[1].replace(/^node:/, '');
  if (!isBareSpecifier(spec)) return null;
  return barePackageName(spec);
}

let cachedPkgManager: string | null = null;

// Prefer bun (the container runtime) for fast installs; fall back to npm.
export function detectPackageManager(): string {
  if (cachedPkgManager) return cachedPkgManager;
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    cachedPkgManager = 'bun';
  } catch {
    cachedPkgManager = 'npm';
  }
  return cachedPkgManager;
}

export async function installPackage(pkg: string, modulesDir: string): Promise<void> {
  fs.mkdirSync(modulesDir, { recursive: true });
  const mgr = detectPackageManager();
  const args = mgr === 'bun'
    ? ['add', pkg, '--silent']
    : ['install', pkg, '--no-audit', '--no-fund', '--loglevel=error'];
  try {
    await execFileAsync(mgr, args, { cwd: modulesDir, timeout: 120000, maxBuffer: 1024 * 1024 });
  } catch (err: any) {
    throw new Error(`Failed to auto-install "${pkg}" (${mgr}): ${(err.stderr || err.message || '').toString().slice(0, 500)}`);
  }
}

// Find an already-installed copy of `spec` by walking up from a base dir,
// WITHOUT consulting the runtime resolver (Bun caches negative hits). The walk
// mirrors bare-specifier ESM resolution.
export function resolveBundledImport(spec: string, fromDir: string): string | null {
  const rel = path.join('node_modules', ...spec.split('/'));
  let dir = fromDir;
  for (;;) {
    const pkg = path.join(dir, rel);
    if (fs.existsSync(path.join(pkg, 'package.json'))) return pkg;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readInstalledVersion(pkgDir: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version || '';
  } catch {
    return '';
  }
}

export interface InstallContext {
  modulesDir: string;
  scriptsDir: string;
  autoInstall: boolean;
}

// Ensure every top-level bare import is installed before the first import runs,
// so the runtime resolver never records a negative hit.
export async function ensureBareImportsInstalled(code: string, ctx: InstallContext): Promise<void> {
  if (!ctx.autoInstall) return;
  const specs = extractBareImports(code);
  for (const { name, version } of specs) {
    const pkgDir = path.join(ctx.modulesDir, 'node_modules', ...name.split('/'));
    const haveLocal = fs.existsSync(path.join(pkgDir, 'package.json'));
    const bundled = resolveBundledImport(name, ctx.scriptsDir);

    if (version) {
      let needInstall = !haveLocal;
      if (haveLocal && /^[0-9][0-9.]*$/.test(version) && readInstalledVersion(pkgDir) !== version) {
        needInstall = true;
      }
      if (needInstall) await installPackage(`${name}@${version}`, ctx.modulesDir);
      continue;
    }

    if (haveLocal) {
      if (bundled) fs.rmSync(pkgDir, { recursive: true, force: true });
      continue;
    }
    if (bundled) continue;
    await installPackage(name, ctx.modulesDir);
  }
}