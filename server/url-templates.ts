import { AppConfig, Route } from '../shared/types';
import { findAppByName, findAppById, findRouteByName, getSystemApp } from './config';

const URL_TEMPLATE_RE = /\$\{([^{}]*)\}/g;

export function appOrigin(app: AppConfig): string {
  const protocols = (app.protocols && app.protocols.length) ? app.protocols : ['http'];
  const scheme = protocols.includes('http') ? 'http' : 'https';
  const host = app.listenHost || '0.0.0.0';
  const port = app.listenPort;
  return `${scheme}://${host}:${port}`;
}

export function appBaseUrl(app: AppConfig): string {
  const basePath = app.basePath && app.basePath !== '/' ? app.basePath : '';
  return appOrigin(app) + basePath;
}

export function parseUrlTemplateToken(token: string): { appName: string | null; routeName: string | null } {
  const inner = token.slice(2, -1).trim();
  const sep = inner.indexOf('::');
  if (sep === -1) return { appName: null, routeName: inner || null };
  return { appName: inner.slice(0, sep).trim() || null, routeName: inner.slice(sep + 2).trim() || null };
}

export function resolveUrlToken(token: string, currentApp: AppConfig): string | null {
  const { appName, routeName } = parseUrlTemplateToken(token);
  const app = appName ? findAppByName(appName) : currentApp;
  if (!app) return null;
  if (!routeName) return appBaseUrl(app);
  const route = findRouteByName(app, routeName);
  if (!route) return null;
  return appOrigin(app) + route.pathPattern;
}

export function resolveUrlTemplatesInCode(code: string, currentApp: AppConfig): string {
  return code.replace(URL_TEMPLATE_RE, (token) => {
    const url = resolveUrlToken(token, currentApp);
    if (url !== null) return url;
    if (token.includes('::')) {
      throw new Error(`[URL Template] Cannot resolve "${token}" in route code: no matching App or route.`);
    }
    return token;
  });
}

export function validateUrlTemplatesInCode(code: string, currentApp: AppConfig | null): string[] {
  if (!currentApp || !code) return [];
  const errors: string[] = [];
  let m: RegExpExecArray | null;
  URL_TEMPLATE_RE.lastIndex = 0;
  while ((m = URL_TEMPLATE_RE.exec(code)) !== null) {
    const token = m[0];
    if (!token.includes('::')) continue;
    if (resolveUrlToken(token, currentApp) !== null) continue;
    const { appName, routeName } = parseUrlTemplateToken(token);
    errors.push(appName
      ? `URL template "${token}" cannot be resolved: App "${appName}"${routeName ? ` or route "${routeName}"` : ''} not found.`
      : `URL template "${token}" cannot be resolved: route "${routeName}" not found in this App.`);
  }
  return errors;
}

export { findAppById, getSystemApp };
