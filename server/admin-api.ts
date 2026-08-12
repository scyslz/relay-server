import { Request, Response } from 'express';
import fs from 'fs';
import { AppConfig, Route, ServerConfig, ExecutionLog, TestRequestPayload, TestResponsePayload } from '../src/types';
import { SYSTEM_APP_ID, SYSTEM_ROUTES } from '../src/constants';
import { app, state, CONFIG_FILE_PATH, MAX_LOG_ENTRIES, DEFAULT_LOGS_LIMIT } from './state';
import { ensureDefaultAppAndRoutes, saveConfigToDisk, getSystemApp } from './config';
import { pushExecutionLog, persistLogsToDisk } from './logs';
import { validateAppConfig, validateRouteConfig } from './validation';
import { checkRouteMatch, executeRouteScript } from './execution';
import { rebindAllAppListeners, reListenServer, getAppListenStatus } from './listeners';

export function registerAdminRoutes() {
  app.get('/internal/apps', (_req: Request, res: Response) => {
    ensureDefaultAppAndRoutes();
    res.json({ apps: state.appsStore.map(a => ({ ...a, listenStatus: getAppListenStatus(a) })) });
  });

  app.post('/internal/apps', (req: Request, res: Response) => {
    const validation = validateAppConfig(req.body);
    if (!validation.valid) {
      res.status(400).json({ error: 'Validation failed', validation });
      return;
    }

    const newApp: AppConfig = {
      id: 'app-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      name: req.body.name.trim(),
      description: req.body.description || '',
      listenHost: req.body.listenHost || '0.0.0.0',
      listenPort: Number(req.body.listenPort) || 8080,
      basePath: req.body.basePath ? (req.body.basePath.startsWith('/') ? req.body.basePath : '/' + req.body.basePath) : '/',
      protocols: Array.isArray(req.body.protocols) && req.body.protocols.length
        ? req.body.protocols.filter((p: string) => p === 'http' || p === 'https')
        : ['http'],
      enabled: req.body.enabled !== false,
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    state.appsStore.push(newApp);
    ensureDefaultAppAndRoutes();
    saveConfigToDisk();
    rebindAllAppListeners();
    res.json({ app: newApp, validation });
  });

  app.put('/internal/apps/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const existingIndex = state.appsStore.findIndex(a => a.id === id);
    if (existingIndex === -1) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    const existingApp = state.appsStore[existingIndex];
    const validation = validateAppConfig(req.body, id);

    if (!validation.valid) {
      res.status(400).json({ error: 'Validation failed', validation });
      return;
    }

    const isSystemApp = existingApp.isDefault || existingApp.id === SYSTEM_APP_ID;

    if (isSystemApp) {
      const prevConfig = { ...state.serverConfig };
      const nextConfig: ServerConfig = {
        name: (req.body.name || state.serverConfig.name).trim(),
        basePath: req.body.basePath
          ? (req.body.basePath.trim().startsWith('/') ? req.body.basePath.trim() : '/' + req.body.basePath.trim())
          : state.serverConfig.basePath,
        listenHost: req.body.listenHost || state.serverConfig.listenHost,
        listenPort: Number(req.body.listenPort) || state.serverConfig.listenPort
      };

      const portChanged = nextConfig.listenHost !== state.serverConfig.listenHost || nextConfig.listenPort !== state.serverConfig.listenPort;

      state.serverConfig = nextConfig;

      if (portChanged) {
        const rebound = await reListenServer(prevConfig);
        if (!rebound) {
          state.serverConfig = prevConfig;
          res.status(409).json({
            error: 'Port conflict',
            message: `Cannot bind to ${nextConfig.listenHost}:${nextConfig.listenPort} (already in use or invalid). The server keeps running on ${prevConfig.listenHost}:${prevConfig.listenPort}.`
          });
          return;
        }
      }

      const updatedApp: AppConfig = {
        ...existingApp,
        id: SYSTEM_APP_ID,
        name: state.serverConfig.name,
        description: req.body.description ?? 'Built-in primary management & relay service. System root endpoint.',
        basePath: state.serverConfig.basePath,
        listenHost: state.serverConfig.listenHost,
        listenPort: state.serverConfig.listenPort,
        enabled: true,
        isDefault: true,
        updatedAt: new Date().toISOString()
      };

      state.appsStore[existingIndex] = updatedApp;
      ensureDefaultAppAndRoutes();
      saveConfigToDisk();
      rebindAllAppListeners();
      res.json({ app: updatedApp, validation });
      return;
    }

    const updatedApp: AppConfig = {
      ...existingApp,
      name: req.body.name.trim(),
      description: req.body.description,
      listenHost: req.body.listenHost || '0.0.0.0',
      listenPort: Number(req.body.listenPort),
      basePath: req.body.basePath ? (req.body.basePath.startsWith('/') ? req.body.basePath : '/' + req.body.basePath) : '/',
      protocols: Array.isArray(req.body.protocols) && req.body.protocols.length
        ? req.body.protocols.filter((p: string) => p === 'http' || p === 'https')
        : ['http'],
      enabled: req.body.enabled !== false,
      isDefault: existingApp.isDefault,
      updatedAt: new Date().toISOString()
    };

    state.appsStore[existingIndex] = updatedApp;
    ensureDefaultAppAndRoutes();
    saveConfigToDisk();
    rebindAllAppListeners();
    res.json({ app: updatedApp, validation });
  });

  app.delete('/internal/apps/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const targetApp = state.appsStore.find(a => a.id === id);

    if (!targetApp) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    if (targetApp.isDefault || targetApp.id === SYSTEM_APP_ID) {
      res.status(403).json({ error: 'System App (API Gateway Core) is protected and cannot be deleted.' });
      return;
    }

    state.appsStore = state.appsStore.filter(a => a.id !== id);
    state.routesStore = state.routesStore.filter(r => r.appId !== id);

    ensureDefaultAppAndRoutes();
    saveConfigToDisk();
    rebindAllAppListeners();
    res.json({ success: true, deletedId: id });
  });

  app.get('/internal/routes', (req: Request, res: Response) => {
    const { appId } = req.query;
    let filtered = state.routesStore;
    if (appId && typeof appId === 'string') {
      filtered = state.routesStore.filter(r => r.appId === appId);
    }
    res.json({ routes: filtered });
  });

  app.post('/internal/validate-route', (req: Request, res: Response) => {
    const routeData = req.body.route || {};
    const currentId = req.body.currentId;
    const validation = validateRouteConfig(routeData, currentId);
    res.json(validation);
  });

  app.post('/internal/routes', (req: Request, res: Response) => {
    const validation = validateRouteConfig(req.body);
    if (!validation.valid) {
      res.status(400).json({ error: 'Route validation failed', validation });
      return;
    }

    const newRoute: Route = {
      id: 'route-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      appId: req.body.appId,
      name: req.body.name.trim(),
      description: req.body.description || '',
      matchTarget: req.body.matchTarget || 'path',
      matchStrategy: req.body.matchStrategy || 'prefix',
      pathPattern: req.body.pathPattern.trim(),
      hostPattern: req.body.hostPattern || '*',
      httpMethods: req.body.httpMethods || ['GET', 'ALL'],
      code: req.body.code,
      enabled: req.body.enabled !== false,
      priority: Number(req.body.priority) || 10,
      engine: (req.body.engine === 'process' || req.body.engine === 'isolatedvm') ? req.body.engine : 'isolatedvm',
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    state.routesStore.push(newRoute);
    ensureDefaultAppAndRoutes();
    saveConfigToDisk();
    res.json({ route: newRoute, validation });
  });

  app.put('/internal/routes/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const existingIndex = state.routesStore.findIndex(r => r.id === id);

    if (existingIndex === -1) {
      res.status(404).json({ error: 'Route not found' });
      return;
    }

    const existingRoute = state.routesStore[existingIndex];

    if (existingRoute.isDefault || SYSTEM_ROUTES.some(sr => sr.id === id)) {
      res.status(403).json({ error: 'Built-in System Routes are hardcoded constants and cannot be modified.' });
      return;
    }

    const validation = validateRouteConfig(req.body, id);

    if (!validation.valid) {
      res.status(400).json({ error: 'Route validation failed', validation });
      return;
    }

    const updatedRoute: Route = {
      ...existingRoute,
      name: req.body.name.trim(),
      description: req.body.description,
      matchTarget: req.body.matchTarget || 'path',
      matchStrategy: req.body.matchStrategy || 'prefix',
      pathPattern: req.body.pathPattern.trim(),
      hostPattern: req.body.hostPattern || '*',
      httpMethods: req.body.httpMethods || ['ALL'],
      code: req.body.code,
      enabled: req.body.enabled !== false,
      priority: Number(req.body.priority) || 10,
      engine: (req.body.engine === 'process' || req.body.engine === 'isolatedvm') ? req.body.engine : 'isolatedvm',
      updatedAt: new Date().toISOString()
    };

    state.routesStore[existingIndex] = updatedRoute;
    ensureDefaultAppAndRoutes();
    saveConfigToDisk();
    res.json({ route: updatedRoute, validation });
  });

  app.delete('/internal/routes/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const targetRoute = state.routesStore.find(r => r.id === id);

    if (!targetRoute) {
      res.status(404).json({ error: 'Route not found' });
      return;
    }

    if (targetRoute.isDefault || SYSTEM_ROUTES.some(sr => sr.id === id)) {
      res.status(403).json({ error: 'The Built-in System Route is protected and cannot be deleted.' });
      return;
    }

    state.routesStore = state.routesStore.filter(r => r.id !== id);
    ensureDefaultAppAndRoutes();
    saveConfigToDisk();
    res.json({ success: true, deletedId: id });
  });

  app.post('/internal/execute-test', async (req: Request, res: Response) => {
    const payload: TestRequestPayload = req.body;
    const startMs = Date.now();

    const targetApp = state.appsStore.find(a => a.id === payload.appId);
    if (!targetApp) {
      res.status(404).json({ error: 'Target App not found' });
      return;
    }

    let matchedRoute: Route | undefined;
    let extractedParams: Record<string, string> = {};

    if (payload.routeId) {
      matchedRoute = state.routesStore.find(r => r.id === payload.routeId) || SYSTEM_ROUTES.find(r => r.id === payload.routeId);
      if (matchedRoute) {
        const matchRes = checkRouteMatch(matchedRoute, payload.url, payload.host || 'localhost', payload.method || 'GET');
        extractedParams = matchRes.params;
      }
    } else {
      const appRoutes = [
        ...state.routesStore.filter(r => r.appId === targetApp.id && r.enabled),
        ...(targetApp.isDefault || targetApp.id === SYSTEM_APP_ID ? SYSTEM_ROUTES.filter(r => r.enabled) : [])
      ].sort((a, b) => a.priority - b.priority);

      for (const route of appRoutes) {
        const matchRes = checkRouteMatch(route, payload.url, payload.host || 'localhost', payload.method || 'GET');
        if (matchRes.matched) {
          matchedRoute = route;
          extractedParams = matchRes.params;
          break;
        }
      }
    }

    if (!matchedRoute) {
      const duration = Date.now() - startMs;
      const noRouteLog: ExecutionLog = {
        id: 'log-' + Date.now(),
        timestamp: new Date().toISOString(),
        appId: targetApp.id,
        appName: targetApp.name,
        method: payload.method,
        url: payload.url,
        path: payload.url,
        statusCode: 404,
        durationMs: duration,
        status: 'no_route',
        logs: ['[WARN] No matching route found for this request pattern']
      };
      pushExecutionLog(noRouteLog);

      res.json({
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No matching route found in App', appId: targetApp.id, url: payload.url }, null, 2),
        logs: ['[WARN] No matching active route found'],
        durationMs: duration
      } as TestResponsePayload);
      return;
    }

    let parsedBody: any = payload.body;
    if (typeof payload.body === 'string' && payload.body.trim().startsWith('{')) {
      try {
        parsedBody = JSON.parse(payload.body);
      } catch {
        parsedBody = payload.body;
      }
    }

    const result = await executeRouteScript(matchedRoute, {
      method: payload.method || 'GET',
      url: payload.url,
      path: payload.url,
      query: {},
      headers: payload.headers || { 'user-agent': 'Relay-Server-Simulator' },
      body: parsedBody,
      host: payload.host || 'localhost',
      ip: '127.0.0.1',
      params: extractedParams
    });

    const duration = Date.now() - startMs;

    const logItem: ExecutionLog = {
      id: 'log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5),
      timestamp: new Date().toISOString(),
      appId: targetApp.id,
      appName: targetApp.name,
      routeId: matchedRoute.id,
      routeName: matchedRoute.name,
      method: payload.method || 'GET',
      url: payload.url,
      path: payload.url,
      statusCode: result.statusCode,
      durationMs: duration,
      status: result.statusCode >= 200 && result.statusCode < 400 ? 'success' : 'error',
      logs: result.logs,
      errorMessage: result.error,
      errorStack: result.stack
    };

    pushExecutionLog(logItem);

    res.json({
      status: result.statusCode,
      headers: result.headers,
      body: result.body,
      logs: result.logs,
      durationMs: duration,
      matchedRoute: {
        id: matchedRoute.id,
        name: matchedRoute.name
      },
      error: result.error
    } as TestResponsePayload);
  });

  app.get('/internal/logs', (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LOGS_LIMIT, 1), MAX_LOG_ENTRIES);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({
      logs: state.executionLogs.slice(offset, offset + limit),
      total: state.executionLogs.length,
      limit,
      offset
    });
  });

  app.post('/internal/logs/clear', (_req: Request, res: Response) => {
    state.executionLogs = [];
    persistLogsToDisk();
    res.json({ success: true });
  });

  app.get('/internal/config', (_req: Request, res: Response) => {
    res.json({
      format: 'json',
      filePath: CONFIG_FILE_PATH,
      fileExists: fs.existsSync(CONFIG_FILE_PATH),
      server: state.serverConfig,
      systemApp: getSystemApp(),
      systemRoutesCount: SYSTEM_ROUTES.length,
      appsCount: state.appsStore.length,
      routesCount: state.routesStore.length,
      apps: state.appsStore,
      routes: state.routesStore
    });
  });
}
