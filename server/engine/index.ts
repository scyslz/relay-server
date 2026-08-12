import { RouteEngine, EngineOptions } from './types';
import { ProcessEngine } from './process';
import { IsolatedVmEngine } from './isolatedvm';

export type EngineKind = 'process' | 'isolatedvm';

// Pick the active engine. Defaults to process isolation; set RELAY_ENGINE to
// "isolatedvm" to use the V8-sandbox engine instead. Both implement the same
// RouteEngine contract so the server treats them identically.
export function createEngine(kind: EngineKind | undefined, options: EngineOptions = {}): RouteEngine {
  if (kind === 'isolatedvm') return new IsolatedVmEngine(options);
  return new ProcessEngine(options);
}

export { ProcessEngine } from './process';
export { IsolatedVmEngine } from './isolatedvm';
export * from './types';