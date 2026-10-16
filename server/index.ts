import path from 'path';
import fs from 'fs';
import os from 'os';
import express, { Request, Response } from 'express';
import { SYSTEM_ROUTES } from '../shared/constants';
import { createEngine } from './engine';
import { app, state, ROUTE_MODULES_DIR, ROUTE_SCRIPTS_DIR, AUTO_INSTALL_ENABLED, ROUTE_MODULE_CLEAN_INTERVAL_MS } from './state';
import { loadConfigFromDisk, ensureDefaultAppAndRoutes, saveConfigToDisk, findAppById, getSystemApp } from './config';
import { loadLogsFromDisk } from './logs';
import { validateUrlTemplatesInCode, resolveUrlTemplatesInCode } from './url-templates';
import { cleanUnusedRouteModules } from './modules';
import { dispatchGateway } from './gateway';
import { rebindAllAppListeners } from './listeners';
import { registerAdminRoutes } from './admin-api';
import { registerSystemRoutes } from './system-routes';
import { disposeSecondary, resolveEngineKind } from './engine-manager';
import { attachUpgradeBridge } from './upgrade-proxy';

async function warmRouteModules(): Promise<void> {
  const routes = state.routesStore.filter((r) => r.enabled && r.code);
  let ok = 0;
  let skippedSecondary = 0;
  for (const route of routes) {
    // Only warm routes handled by the resident engine; routes preferring the
    // other runtime are warmed lazily on first execution (their secondary
    // engine is not started at boot to keep idle memory low).
    if (resolveEngineKind(route) !== state.residentEngineKind) {
      skippedSecondary++;
      continue;
    }
    try {
      if (state.activeEngine) {
        const resolvedRoute = { ...route };
        try {
          const currentApp = findAppById(route.appId) || getSystemApp();
          resolvedRoute.code = resolveUrlTemplatesInCode(route.code, currentApp);
        } catch (templateErr: any) {
          console.error(`[Startup] Route "${route.name}" (${route.id}) template error: ${templateErr.message}`);
          continue;
        }
        await state.activeEngine.warmUp(resolvedRoute);
      }
      ok++;
    } catch (err: any) {
      console.error(`[Startup] Route "${route.name}" (${route.id}) failed to warm: ${err.message}`);
    }
  }
  console.log(`[Startup] Warmed ${ok}/${routes.length} route(s) via ${state.activeEngine?.name || 'no engine'}${skippedSecondary ? ` (skipped ${skippedSecondary} for lazy secondary)` : ''}`);
}

async function startServer() {
  const isDev = process.env.NODE_ENV === 'development' && fs.existsSync('vite.config.ts');
  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.warn('[Mode] Vite dev middleware enabled (NODE_ENV=development)');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    console.log(`[Mode] Production static serving from ${distPath} (NODE_ENV=${process.env.NODE_ENV || '(unset)'})`);

    app.use((req: Request, res: Response) => {
      const wantsHtml = (req.headers.accept || '').includes('text/html');
      if (req.method === 'GET' && wantsHtml) {
        res.sendFile(path.join(distPath, 'index.html'));
      } else {
        res.status(404).json({
          error: 'Route Not Found',
          path: (req.originalUrl || '/').split('?')[0],
          method: req.method,
          hint: 'No route matched this request'
        });
      }
    });
  }

  app.use((err: any, _req: Request, res: Response, _next: () => void) => {
    console.error('[Unhandled Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: err && err.message ? String(err.message) : String(err) });
    } else {
      res.end();
    }
  });

  state.httpServer = app.listen(state.serverConfig.listenPort, state.serverConfig.listenHost, () => {
    console.log(`Relay Server & Web Hub listening on http://${state.serverConfig.listenHost}:${state.serverConfig.listenPort}`);
  });
  state.httpServer.on('error', (err: any) => {
    // Port conflict / permission errors must not kill the process: keep
    // running so the admin API stays reachable and the user can fix it.
    console.error(`[Relay Server] Listener error on ${state.serverConfig.listenHost}:${state.serverConfig.listenPort}: ${err?.message || err}`);
  });
  attachUpgradeBridge(state.httpServer);

  try {
    let engineKind = (process.env.RELAY_ENGINE === 'process' ? 'process' : 'isolatedvm');
    // A broken isolated-vm native build SIGSEGVs (exit 139) instead of
    // throwing — no try/catch can intercept it. Probe in a child process
    // first and fall back to process BEFORE touching it in-process.
    if (engineKind === 'isolatedvm') {
      const { isIsolatedVmUsable } = await import('./engine/isolatedvm-probe');
      if (!isIsolatedVmUsable()) {
        console.error('[Engine] isolated-vm unusable on this machine, using process engine instead.');
        engineKind = 'process';
      }
    }
    state.residentEngineKind = engineKind;
    try {
      state.activeEngine = createEngine(engineKind, {
        modulesDir: ROUTE_MODULES_DIR,
        scriptsDir: ROUTE_SCRIPTS_DIR,
        allowFs: false,
        timeoutMs: 30000,
        poolSize: Math.max(1, Math.min(os.cpus().length, 4)),
        autoInstall: AUTO_INSTALL_ENABLED
      });
      console.log(`[Engine] Resident engine initialized: ${state.activeEngine.name}`);
    } catch (inner: any) {
      // Fall back to the other engine so a broken native dep never blocks boot.
      const fallback = engineKind === 'process' ? 'isolatedvm' : 'process';
      console.error(`[Engine] Resident engine "${engineKind}" failed (${inner?.message || inner}), trying "${fallback}"...`);
      state.residentEngineKind = fallback as any;
      state.activeEngine = createEngine(fallback as any, {
        modulesDir: ROUTE_MODULES_DIR,
        scriptsDir: ROUTE_SCRIPTS_DIR,
        allowFs: false,
        timeoutMs: 30000,
        poolSize: Math.max(1, Math.min(os.cpus().length, 4)),
        autoInstall: AUTO_INSTALL_ENABLED
      });
      console.log(`[Engine] Resident engine initialized (fallback): ${state.activeEngine.name}`);
    }
  } catch (err: any) {
    console.error(`[Engine] Failed to initialize any engine: ${err?.message || err} — routes will return 500, server keeps running.`);
  }

  setInterval(() => {
    try { cleanUnusedRouteModules(); } catch (err) { console.error('[Route Modules] Cleanup error:', err); }
  }, ROUTE_MODULE_CLEAN_INTERVAL_MS);

  warmRouteModules()
    .finally(() => {
      try { cleanUnusedRouteModules(); } catch (err) { console.error('[Route Modules] Cleanup error:', err); }
    })
    .catch((err) => console.error('[Startup] Warm-up failed:', err));

  rebindAllAppListeners();
}

loadConfigFromDisk();
ensureDefaultAppAndRoutes();
saveConfigToDisk();
loadLogsFromDisk();

for (const route of state.routesStore) {
  const currentApp = findAppById(route.appId);
  for (const msg of validateUrlTemplatesInCode(route.code || '', currentApp)) {
    console.error(`[Config Persistence] Route "${route.name}" (${route.id}): ${msg}`);
  }
}

registerAdminRoutes();
registerSystemRoutes();
app.use(dispatchGateway);

process.on('SIGINT', async () => {
  await disposeSecondary();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await disposeSecondary();
  process.exit(0);
});

startServer();
