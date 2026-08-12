import fs from 'fs';
import path from 'path';
import { Route } from '../src/types';
import { state, ROUTE_MODULES_DIR, ROUTE_SCRIPTS_DIR } from './state';

export function isBareSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('node:')) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')
    || specifier.startsWith('http:') || specifier.startsWith('https:') || specifier.startsWith('data:')) {
    return false;
  }
  return true;
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

export function resolveBundledImport(spec: string): string | null {
  const rel = path.join('node_modules', ...spec.split('/'));
  let dir = ROUTE_SCRIPTS_DIR;
  for (;;) {
    if (dir === ROUTE_MODULES_DIR) {
      dir = path.dirname(dir);
      continue;
    }
    const pkg = path.join(dir, rel);
    if (fs.existsSync(path.join(pkg, 'package.json'))) return pkg;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function collectRouteImportNames(): Set<string> {
  const names = new Set<string>();
  for (const route of state.routesStore) {
    if (!route.enabled) continue;
    if (!route.code) continue;
    for (const { name } of extractBareImports(route.code)) names.add(name);
  }
  return names;
}

export function readDependencyNames(name: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [
    path.join(ROUTE_MODULES_DIR, 'node_modules', ...name.split('/'), 'package.json'),
  ];
  const bundled = resolveBundledImport(name);
  if (bundled) candidates.push(path.join(bundled, 'package.json'));
  for (const f of candidates) {
    try {
      const deps = JSON.parse(fs.readFileSync(f, 'utf-8')).dependencies || {};
      for (const d of Object.keys(deps)) seen.add(d);
    } catch { /* not present here */ }
  }
  return Array.from(seen);
}

export function dependencyClosureOf(names: Iterable<string>): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [];
  for (const n of names) {
    if (!closure.has(n)) {
      closure.add(n);
      queue.push(n);
    }
  }
  while (queue.length) {
    const name = queue.shift() as string;
    for (const dep of readDependencyNames(name)) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }
  return closure;
}

export function cleanUnusedRouteModules(): void {
  const nmDir = path.join(ROUTE_MODULES_DIR, 'node_modules');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(nmDir);
  } catch { return; }
  const needed = dependencyClosureOf(collectRouteImportNames());
  let removed = 0;
  const isUnused = (full: string): boolean =>
    fs.existsSync(path.join(full, 'package.json')) && !needed.has(path.basename(full));
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(nmDir, entry);
    if (entry.startsWith('@')) {
      let scopeDirs: string[] = [];
      try { scopeDirs = fs.readdirSync(full); } catch { continue; }
      let empty = true;
      for (const sub of scopeDirs) {
        const subFull = path.join(full, sub);
        if (isUnused(subFull)) {
          fs.rmSync(subFull, { recursive: true, force: true });
          removed++;
        } else if (fs.existsSync(subFull)) {
          empty = false;
        }
      }
      if (empty) fs.rmSync(full, { recursive: true, force: true });
    } else if (isUnused(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    }
  }
  if (removed > 0) console.log(`[Route Modules] Cleaned ${removed} unused package(s)`);
}
