import { Request, Response } from 'express';
import { SYSTEM_ROUTES } from '../shared/constants';
import { app } from './state';
import { getSystemApp } from './config';
import { checkRouteMatch } from './execution';
import { respondWithMatchedRoute } from './gateway';

export function registerSystemRoutes() {
  for (const sysRoute of SYSTEM_ROUTES) {
    app.all(sysRoute.pathPattern, async (req: Request, res: Response, next: (err?: any) => void) => {
      try {
        const targetApp = getSystemApp();
        const startMs = Date.now();
        const reqPath = (req.originalUrl || '/').split('?')[0] || '/';
        const reqHost = req.hostname || req.headers.host || 'localhost';
        const reqMethod = req.method;

        const matched = checkRouteMatch(sysRoute, reqPath, reqHost, reqMethod);
        if (!matched.matched) {
          res.status(404).json({
            error: 'Route Not Found',
            app: targetApp.name,
            path: reqPath,
            method: reqMethod
          });
          return;
        }

        await respondWithMatchedRoute(targetApp, { route: sysRoute, params: matched.params }, reqPath, reqPath, req, res, startMs);
      } catch (err) {
        next(err);
      }
    });
  }
}
