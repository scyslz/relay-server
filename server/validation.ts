import { isIP as netIsIP } from 'net';
import { AppConfig, Route, ValidationIssue, ValidationResult } from '../shared/types';
import { state } from './state';
import { findAppById } from './config';
import { validateUrlTemplatesInCode } from './url-templates';
import { SYSTEM_APP_ID } from '../shared/constants';

export function validateJavaScriptSyntax(code: string): { valid: boolean; error?: string; line?: number } {
  try {
    const scrubbed = code
      .replace(/^import\s+[^'"]*['"][^'"]*['"]\s*;?$/gm, ';')
      .replace(/^import\s+['"][^'"]*['"]\s*;?$/gm, ';')
      .replace(/^export\s+/gm, ';');
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    new AsyncFunction('request', 'response', 'fetch', 'console', 'process', scrubbed);
    return { valid: true };
  } catch (err: any) {
    let line: number | undefined = undefined;
    const stack = err.stack || '';
    const lineMatch = stack.match(/<anonymous>:(\d+):(\d+)/) || err.message.match(/line (\d+)/i);
    if (lineMatch) {
      line = parseInt(lineMatch[1], 10);
    }
    return {
      valid: false,
      error: err.message || 'Syntax Error',
      line
    };
  }
}

export function validateAppConfig(appData: Partial<AppConfig>, currentId?: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!appData.name || !appData.name.trim()) {
    errors.push({ field: 'name', message: 'App name cannot be empty', severity: 'error' });
  }

  if (appData.listenPort === undefined || appData.listenPort <= 0 || appData.listenPort > 65535) {
    errors.push({ field: 'listenPort', message: 'Valid listen port (1-65535) is required', severity: 'error' });
  }

  const listenHost = (appData.listenHost || '').trim();
  if (listenHost) {
    const dottedIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(listenHost);
    if (dottedIpv4 && netIsIP(listenHost) !== 4) {
      errors.push({ field: 'listenHost', message: `Invalid IPv4 listen address: "${listenHost}"`, severity: 'error' });
    } else if (!dottedIpv4 && netIsIP(listenHost) === 0 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(listenHost)) {
      errors.push({ field: 'listenHost', message: `Invalid listen address or hostname: "${listenHost}"`, severity: 'error' });
    }
  }

  const basePath = (appData.basePath || '/').trim();
  if (!basePath.startsWith('/')) {
    errors.push({ field: 'basePath', message: 'Base path must start with "/"', severity: 'error' });
  }

  const portConflict = state.appsStore.find(a =>
    a.id !== currentId &&
    a.listenPort === appData.listenPort &&
    a.basePath.toLowerCase() === basePath.toLowerCase()
  );

  if (portConflict) {
    warnings.push({
      field: 'listenPort',
      message: `Listen port ${appData.listenPort} and base path "${basePath}" overlaps with App "${portConflict.name}".`,
      severity: 'warning'
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function validateRouteConfig(routeData: Partial<Route>, currentRouteId?: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!routeData.name || !routeData.name.trim()) {
    errors.push({ field: 'name', message: 'Route name is required', severity: 'error' });
  }

  if (!routeData.appId) {
    errors.push({ field: 'appId', message: 'Target App must be selected', severity: 'error' });
  }

  const pathPattern = (routeData.pathPattern || '').trim();
  if (!pathPattern) {
    errors.push({ field: 'pathPattern', message: 'Path pattern cannot be empty', severity: 'error' });
  } else if (!pathPattern.startsWith('/') && routeData.matchStrategy !== 'contains' && routeData.matchStrategy !== 'regex') {
    errors.push({ field: 'pathPattern', message: 'Path pattern should start with "/"', severity: 'error' });
  }

  if (routeData.appId === SYSTEM_APP_ID) {
    const normalized = pathPattern.toLowerCase();
    if (normalized === '/' || normalized === '/relay-server') {
      errors.push({
        field: 'pathPattern',
        message: `Path pattern "${pathPattern}" is reserved for the system console and cannot be used as a route in the System App.`,
        severity: 'error'
      });
    }
  }

  const code = routeData.code || '';
  if (!code.trim()) {
    errors.push({ field: 'code', message: 'Route JS code block cannot be empty', severity: 'error' });
  } else {
    const syntaxResult = validateJavaScriptSyntax(code);
    if (!syntaxResult.valid) {
      errors.push({
        field: 'code',
        message: `JavaScript Syntax Error: ${syntaxResult.error}`,
        severity: 'error',
        line: syntaxResult.line
      });
    }

    const currentApp = routeData.appId ? findAppById(routeData.appId) : null;
    for (const msg of validateUrlTemplatesInCode(code, currentApp)) {
      errors.push({ field: 'code', message: msg, severity: 'error' });
    }
  }

  const routeEngine = (routeData.engine === 'process' || routeData.engine === 'isolatedvm')
    ? routeData.engine
    : 'isolatedvm';
  if (routeEngine === 'process') {
    warnings.push({
      field: 'engine',
      message: 'This route uses the "process" engine, which is lazily started on first hit and runs each route in a forked process (extra memory). Prefer "isolatedvm" unless you need full Node API access.',
      severity: 'warning'
    });
  }

  if (routeData.appId) {
    const appRoutes = state.routesStore.filter(r => r.appId === routeData.appId && r.id !== currentRouteId);

    for (const existing of appRoutes) {
      const matchTargetEqual = existing.matchTarget === routeData.matchTarget;
      const strategyEqual = existing.matchStrategy === routeData.matchStrategy;
      const pathEqual = existing.pathPattern.toLowerCase() === pathPattern.toLowerCase();

      const methodsIntersect = (existing.httpMethods || []).some(m =>
        m === 'ALL' || (routeData.httpMethods || []).includes('ALL') || (routeData.httpMethods || []).includes(m)
      );

      if (matchTargetEqual && strategyEqual && pathEqual && methodsIntersect) {
        warnings.push({
          field: 'pathPattern',
          message: `Route pattern "${pathPattern}" with strategy "${routeData.matchStrategy}" conflicts with existing route "${existing.name}" in this App.`,
          severity: 'warning'
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
