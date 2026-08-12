import { Route } from '../src/types';
import { state } from './state';
import { findAppById, getSystemApp } from './config';
import { resolveUrlTemplatesInCode } from './url-templates';
import { getEngineForRoute } from './engine-manager';

export interface RouteMatchResult {
  matched: boolean;
  params: Record<string, string>;
}

export function matchPathPattern(pattern: string, actualPath: string, strategy: string): RouteMatchResult {
  const normPattern = (pattern || '').trim();
  const normPath = (actualPath || '').trim();

  if (!normPattern || !normPath) {
    return { matched: false, params: {} };
  }

  const hasDynamicParams = normPattern.includes(':') || normPattern.includes('*');

  if (hasDynamicParams && strategy !== 'regex') {
    const patternSegments = normPattern.split('/');
    const paramNames: string[] = [];

    let regexPattern = '^';
    for (let i = 0; i < patternSegments.length; i++) {
      const seg = patternSegments[i];
      if (!seg && i === 0) continue;

      regexPattern += '/';

      if (seg.startsWith(':')) {
        const paramName = seg.slice(1);
        paramNames.push(paramName);
        regexPattern += '([^/]+)';
      } else if (seg === '*') {
        paramNames.push('wildcard');
        regexPattern += '(.*)';
      } else {
        const escaped = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regexPattern += escaped;
      }
    }

    if (strategy === 'prefix') {
      regexPattern += '(?:/.*)?$';
    } else if (strategy === 'contains') {
      regexPattern = regexPattern.replace('^/', '') + '(?:/.*)?';
    } else {
      regexPattern += '/?$';
    }

    try {
      const reg = new RegExp(regexPattern, 'i');
      const match = normPath.match(reg);
      if (!match) {
        return { matched: false, params: {} };
      }

      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        if (match[i + 1] !== undefined) {
          try {
            params[paramNames[i]] = decodeURIComponent(match[i + 1]);
          } catch {
            params[paramNames[i]] = match[i + 1];
          }
        }
      }

      return { matched: true, params };
    } catch {
      return { matched: false, params: {} };
    }
  }

  const lowerPath = normPath.toLowerCase();
  const lowerPattern = normPattern.toLowerCase();
  let matches = false;

  switch (strategy) {
    case 'equal':
      matches = lowerPath === lowerPattern || lowerPath === lowerPattern + '/';
      break;
    case 'prefix':
      matches = lowerPath.startsWith(lowerPattern);
      break;
    case 'contains':
      matches = lowerPath.includes(lowerPattern);
      break;
    case 'regex':
      try {
        matches = new RegExp(normPattern, 'i').test(normPath);
      } catch {
        matches = false;
      }
      break;
  }

  return { matched: matches, params: {} };
}

export function checkRouteMatch(
  route: Route,
  reqPath: string,
  reqHost: string,
  reqMethod: string
): RouteMatchResult {
  if (!route.enabled) return { matched: false, params: {} };

  if (route.httpMethods && !route.httpMethods.includes('ALL') && !route.httpMethods.includes(reqMethod.toUpperCase() as any)) {
    return { matched: false, params: {} };
  }

  if (route.matchTarget === 'host' || route.matchTarget === 'both') {
    if (route.hostPattern && route.hostPattern !== '*') {
      const host = reqHost.toLowerCase();
      const hostPattern = route.hostPattern.toLowerCase();
      if (hostPattern.includes('*')) {
        const wildcard = hostPattern.replace(/\*/g, '.*');
        if (!new RegExp(`^${wildcard}$`).test(host)) return { matched: false, params: {} };
      } else if (host !== hostPattern) {
        return { matched: false, params: {} };
      }
    }
  }

  return matchPathPattern(route.pathPattern, reqPath, route.matchStrategy);
}

export async function executeRouteScript(
  route: Route,
  reqInfo: {
    method: string;
    url: string;
    path: string;
    query: Record<string, any>;
    headers: Record<string, string>;
    body: any;
    host: string;
    ip: string;
    params?: Record<string, string>;
  }
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  logs: string[];
  error?: string;
  stack?: string;
}> {
  if (!state.activeEngine) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Execution engine not initialized' }),
      logs: ['[ERROR] activeEngine is null at request time'],
      error: 'Execution engine not initialized'
    };
  }
  const resolvedRoute: Route = { ...route };
  try {
    const currentApp = findAppById(route.appId) || getSystemApp();
    resolvedRoute.code = resolveUrlTemplatesInCode(route.code, currentApp);
  } catch (templateErr: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Script Execution Exception', routeId: route.id, message: templateErr.message }, null, 2),
      logs: [`[ERROR] ${templateErr.message}`],
      error: templateErr.message,
      stack: templateErr.stack
    };
  }

  const engine = await getEngineForRoute(resolvedRoute);
  if (!engine) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Execution engine not initialized' }),
      logs: ['[ERROR] no engine available for this route'],
      error: 'Execution engine not initialized'
    };
  }
  const engineResult = await engine.execute(resolvedRoute, {
    method: reqInfo.method,
    url: reqInfo.url,
    path: reqInfo.path,
    query: reqInfo.query,
    headers: reqInfo.headers,
    body: reqInfo.body,
    host: reqInfo.host,
    ip: reqInfo.ip,
    params: reqInfo.params || {}
  });
  return {
    statusCode: engineResult.statusCode,
    headers: engineResult.headers,
    body: engineResult.body,
    logs: engineResult.logs,
    error: engineResult.error,
    stack: engineResult.stack
  };
}
