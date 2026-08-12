import { stripImportVersions } from './modules';

// Turn route code into a real ESM module. `import` statements are hoisted to the
// top (static imports must live at module scope); the rest becomes the body of an
// exported async function that receives the per-request sandbox.
export function transformRouteToModule(code: string): string {
  const importBlocks: string[] = [];
  const bodyLines: string[] = [];
  let inImport = false;
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (!inImport) {
      if (/^import\s/.test(t)) {
        importBlocks.push(line);
        inImport = !/["'][^"']*["']\s*;?(\s*\/\/.*)?$/.test(t);
      } else if (/^export\s/.test(t)) {
        bodyLines.push(line.replace(/^export\s+/, ''));
      } else {
        bodyLines.push(line);
      }
    } else {
      importBlocks.push(line);
      if (/["'][^"']*["']\s*;?(\s*\/\/.*)?$/.test(line)) inImport = false;
    }
  }
  const imports = stripImportVersions(importBlocks.join('\n'));
  const body = bodyLines.join('\n');
  return `${imports}\n\nexport default async function run({ request, response, fetch, console, fs }) {\n${body}\n}\n`;
}

export function routeModuleFileName(routeId: string, hash: string): string {
  const safe = String(routeId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `__route_${safe}_${hash}.mjs`;
}