import os from 'os';
import { Route } from '../src/types';
import { createEngine, EngineKind, RouteEngine } from './engine';
import { state, ROUTE_MODULES_DIR, ROUTE_SCRIPTS_DIR, AUTO_INSTALL_ENABLED } from './state';

// Idle grace period before the lazily-started secondary engine is disposed
// and its worker processes / isolates are reclaimed.
const SECONDARY_IDLE_MS = 5 * 60 * 1000;

// The secondary engine keeps a smaller pool than the resident one because it
// only serves the handful of routes that explicitly opt into it.
const SECONDARY_POOL_SIZE = Math.max(1, Math.min(os.cpus().length, 2));

export function resolveEngineKind(route: Route): EngineKind {
  const wanted = (route.engine === 'process' || route.engine === 'isolatedvm')
    ? route.engine
    : state.residentEngineKind;
  return wanted;
}

// Returns the engine that should run this route, starting the secondary
// engine lazily when the route prefers the non-resident runtime.
export async function getEngineForRoute(route: Route): Promise<RouteEngine | null> {
  const wanted = resolveEngineKind(route);
  if (wanted === state.residentEngineKind) {
    return state.activeEngine;
  }
  return ensureSecondary(wanted);
}

async function ensureSecondary(kind: EngineKind): Promise<RouteEngine> {
  if (state.secondaryEngine && state.secondaryEngineKind === kind) {
    state.secondaryEngineLastUsed = Date.now();
    return state.secondaryEngine;
  }

  if (state.secondaryEngine && state.secondaryEngineKind !== kind) {
    await disposeSecondary();
  }

  const engine = createEngine(kind, {
    modulesDir: ROUTE_MODULES_DIR,
    scriptsDir: ROUTE_SCRIPTS_DIR,
    allowFs: false,
    timeoutMs: 30000,
    poolSize: SECONDARY_POOL_SIZE,
    autoInstall: AUTO_INSTALL_ENABLED
  });
  state.secondaryEngine = engine;
  state.secondaryEngineKind = kind;
  state.secondaryEngineLastUsed = Date.now();
  console.log(`[Engine] Lazy-started secondary "${kind}" engine (pool ${SECONDARY_POOL_SIZE})`);
  scheduleSecondaryReclamation();
  return engine;
}

function scheduleSecondaryReclamation(): void {
  if (state.secondaryEngineIdleTimer) {
    clearTimeout(state.secondaryEngineIdleTimer);
  }
  const timer = setTimeout(async () => {
    state.secondaryEngineIdleTimer = null;
    if (!state.secondaryEngine) return;
    const idle = Date.now() - state.secondaryEngineLastUsed;
    if (idle >= SECONDARY_IDLE_MS) {
      console.log(`[Engine] Reclaiming idle secondary "${state.secondaryEngineKind}" engine (idle ${Math.round(idle / 1000)}s)`);
      await disposeSecondary();
    } else {
      scheduleSecondaryReclamation();
    }
  }, SECONDARY_IDLE_MS);
  state.secondaryEngineIdleTimer = timer;
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

export async function disposeSecondary(): Promise<void> {
  if (state.secondaryEngineIdleTimer) {
    clearTimeout(state.secondaryEngineIdleTimer);
    state.secondaryEngineIdleTimer = null;
  }
  if (state.secondaryEngine) {
    try {
      await state.secondaryEngine.dispose();
    } catch (err: any) {
      console.error(`[Engine] Error disposing secondary "${state.secondaryEngineKind}": ${err.message}`);
    }
    state.secondaryEngine = null;
    state.secondaryEngineKind = null;
  }
}