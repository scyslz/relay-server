import { Request, Response } from 'express';
import { AppConfig, Route, ExecutionLog } from '../shared/types';
import { state } from './state';
import { getSystemApp } from './config';
import { pushExecutionLog } from './logs';
import { checkRouteMatch, executeRouteScript } from './execution';

export function matchAppRoute(
  app: AppConfig,
  reqPath: string,
  reqHost: string,
  reqMethod: string
): { route: Route; params: Record<string, string> } | null {
  const candidates: string[] = [reqPath];

  const basePath = (app.basePath || '/').trim();
  if (basePath !== '/' && reqPath.startsWith(basePath)) {
    const stripped = reqPath.slice(basePath.length) || '/';
    candidates.push(stripped.startsWith('/') ? stripped : '/' + stripped);
  }

  const candidateRoutes = state.routesStore
    .filter(r => r.appId === app.id && r.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const route of candidateRoutes) {
    for (const candidate of candidates) {
      const m = checkRouteMatch(route, candidate, reqHost, reqMethod);
      if (m.matched) return { route, params: m.params };
    }
  }
  return null;
}

export async function handleAppRequest(
  targetApp: AppConfig,
  pathToMatch: string,
  displayUrl: string,
  req: Request,
  res: Response,
  startMs: number
): Promise<void> {
  const reqHost = req.hostname || req.headers.host || 'localhost';
  const reqMethod = req.method;

  const matched = matchAppRoute(targetApp, pathToMatch, reqHost, reqMethod);

  if (!matched) {
    const duration = Date.now() - startMs;
    const noRouteLog: ExecutionLog = {
      id: 'log-' + Date.now(),
      timestamp: new Date().toISOString(),
      appId: targetApp.id,
      appName: targetApp.name,
      method: reqMethod,
      url: displayUrl,
      path: pathToMatch,
      statusCode: 404,
      durationMs: duration,
      status: 'no_route',
      logs: [`[WARN] Unmatched request to path "${pathToMatch}" in App "${targetApp.name}"`]
    };
    pushExecutionLog(noRouteLog);

    res.status(404).json({
      error: 'Route Not Found',
      app: targetApp.name,
      subPath: pathToMatch,
      method: reqMethod,
      hint: 'No route matched this request strategy'
    });
    return;
  }

  await respondWithMatchedRoute(targetApp, matched, pathToMatch, displayUrl, req, res, startMs);
}

export async function respondWithMatchedRoute(
  targetApp: AppConfig,
  matched: { route: Route; params: Record<string, string> },
  pathToMatch: string,
  displayUrl: string,
  req: Request,
  res: Response,
  startMs: number
): Promise<void> {
  const reqHost = req.hostname || req.headers.host || 'localhost';
  const reqMethod = req.method;

  const result = await executeRouteScript(matched.route, {
    method: reqMethod,
    url: displayUrl,
    path: pathToMatch,
    query: req.query,
    headers: req.headers as Record<string, string>,
    body: req.body,
    host: reqHost,
    ip: req.ip || '127.0.0.1',
    params: matched.params
  });

  const duration = Date.now() - startMs;

  const logItem: ExecutionLog = {
    id: 'log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5),
    timestamp: new Date().toISOString(),
    appId: targetApp.id,
    appName: targetApp.name,
    routeId: matched.route.id,
    routeName: matched.route.name,
    method: reqMethod,
    url: displayUrl,
    path: pathToMatch,
    statusCode: result.statusCode,
    durationMs: duration,
    status: result.statusCode >= 200 && result.statusCode < 400 ? 'success' : 'error',
    logs: result.logs,
    errorMessage: result.error,
    errorStack: result.stack
  };
  pushExecutionLog(logItem);

  Object.entries(result.headers).forEach(([k, v]) => {
    res.setHeader(k, v);
  });

  res.status(result.statusCode).send(result.body);
}

export async function dispatchGateway(req: Request, res: Response, next: () => void) {
  try {
    const startMs = Date.now();
    const reqPath = (req.originalUrl || '/').split('?')[0] || '/';
    const reqHost = req.hostname || req.headers.host || 'localhost';
    const reqMethod = req.method;

    const orderedApps = [...state.appsStore.filter(a => !a.isDefault && a.id !== 'app-default-system')];

    for (const targetApp of orderedApps) {
      if (!targetApp.enabled) continue;
      const matched = matchAppRoute(targetApp, reqPath, reqHost, reqMethod);
      if (matched) {
        await handleAppRequest(targetApp, reqPath, reqPath, req, res, startMs);
        return;
      }
    }

    const sysApp = getSystemApp();
    const sysMatched = matchAppRoute(sysApp, reqPath, reqHost, reqMethod);
    if (sysMatched) {
      await handleAppRequest(sysApp, reqPath, reqPath, req, res, startMs);
      return;
    }

    if (reqPath.startsWith('/internal/') || reqPath === '/internal') {
      const noRouteLog: ExecutionLog = {
        id: 'log-' + Date.now(),
        timestamp: new Date().toISOString(),
        appId: 'app-default-system',
        appName: 'System',
        method: reqMethod,
        url: reqPath,
        path: reqPath,
        statusCode: 404,
        durationMs: Date.now() - startMs,
        status: 'no_route',
        logs: [`[WARN] Unmatched system request to "${reqPath}"`]
      };
      pushExecutionLog(noRouteLog);
      res.status(404).json({ error: 'Route Not Found', app: 'System', path: reqPath, method: reqMethod });
      return;
    }

    next();
  } catch (err) {
    console.error('[Gateway] Dispatch error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Gateway Error' });
    } else {
      res.end();
    }
  }
}
