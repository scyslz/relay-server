import fs from 'fs';
import path from 'path';
import { AppConfig, Route, ServerConfig } from '../shared/types';
import { INITIAL_PRESET_APPS, INITIAL_PRESET_ROUTES } from '../shared/data';
import { SYSTEM_APP, SYSTEM_APP_ID, SYSTEM_ROUTES, DEFAULT_SERVER_CONFIG } from '../shared/constants';
import { state, CONFIG_FILE_PATH } from './state';

export function presetUserApps(): AppConfig[] {
  return JSON.parse(JSON.stringify(INITIAL_PRESET_APPS.filter(a => a.id !== SYSTEM_APP_ID && !a.isDefault)));
}

export function normalizeRoutePattern(pattern: string): string {
  if (pattern === '/relay') return '/';
  if (pattern.startsWith('/relay/')) return pattern.slice('/relay'.length);
  return pattern;
}

export function presetUserRoutes(): Route[] {
  const presets = JSON.parse(JSON.stringify(INITIAL_PRESET_ROUTES.filter(r => r.appId !== SYSTEM_APP_ID && !r.isDefault)));
  return presets.map((r: Route) => ({ ...r, pathPattern: normalizeRoutePattern(r.pathPattern) }));
}

export function saveConfigToDisk() {
  try {
    const dir = path.dirname(CONFIG_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
      format: 'json',
      updatedAt: new Date().toISOString(),
      server: state.serverConfig,
      apps: state.appsStore.filter(a => a.id !== SYSTEM_APP_ID && !a.isDefault),
      routes: state.routesStore.filter(r => !r.isDefault)
    };
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[Config Persistence] Saved configuration to ${CONFIG_FILE_PATH}`);
  } catch (err) {
    console.error('[Config Persistence] Error saving config file:', err);
  }
}

export function envServerConfigDefaults(): Partial<ServerConfig> {
  const overrides: Partial<ServerConfig> = {};
  const port = Number(process.env.RELAY_PORT ?? process.env.PORT);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    overrides.listenPort = port;
  }
  if (typeof process.env.LISTEN_HOST === 'string' && process.env.LISTEN_HOST.trim()) {
    overrides.listenHost = process.env.LISTEN_HOST.trim();
  }
  return overrides;
}

export function loadConfigFromDisk() {
  state.serverConfig = { ...DEFAULT_SERVER_CONFIG, ...envServerConfigDefaults() };
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === 'object') {
        if (parsed.server && typeof parsed.server === 'object') {
          if (typeof parsed.server.name === 'string' && parsed.server.name.trim()) {
            state.serverConfig.name = parsed.server.name.trim();
          }
          if (typeof parsed.server.basePath === 'string' && parsed.server.basePath.trim().startsWith('/')) {
            state.serverConfig.basePath = parsed.server.basePath.trim();
          }
          if (typeof parsed.server.listenHost === 'string' && parsed.server.listenHost.trim()) {
            state.serverConfig.listenHost = parsed.server.listenHost.trim();
          }
          const port = Number(parsed.server.listenPort);
          if (Number.isInteger(port) && port > 0 && port <= 65535) {
            state.serverConfig.listenPort = port;
          }
        }

        // Compat: old/broken config files must never prevent boot. Every
        // entry is sanitized with defaults; malformed entries are skipped
        // with a warning instead of throwing later in gateway/listeners.
        state.appsStore = Array.isArray(parsed.apps)
          ? parsed.apps
            .filter((a: any) => a && typeof a === 'object' && a.id !== SYSTEM_APP_ID && !a.isDefault)
            .map((a: any) => sanitizeAppConfig(a))
            .filter((a: AppConfig | null): a is AppConfig => a !== null)
          : presetUserApps();
        state.routesStore = Array.isArray(parsed.routes)
          ? parsed.routes
            .filter((r: any) => r && typeof r === 'object' && !r.isDefault)
            .map((r: any) => sanitizeRouteConfig(r))
            .filter((r: Route | null): r is Route => r !== null)
          : presetUserRoutes();
      } else {
        state.appsStore = presetUserApps();
        state.routesStore = presetUserRoutes();
      }

      console.log(`[Config Persistence] Successfully loaded configuration from ${CONFIG_FILE_PATH}`);
    } else {
      state.appsStore = presetUserApps();
      state.routesStore = presetUserRoutes();
    }
  } catch (err) {
    console.error('[Config Persistence] Error loading configuration file, using preset fallback:', err);
    state.appsStore = presetUserApps();
    state.routesStore = presetUserRoutes();
  }
}

// Fill missing fields with safe defaults so configs written by older
// versions (or hand-edited) keep working. Returns null when the entry is
// beyond repair and should be skipped.
function sanitizeAppConfig(a: any): AppConfig | null {
  try {
    if (!a.id || typeof a.id !== 'string') return null;
    if (!a.name || typeof a.name !== 'string' || !a.name.trim()) return null;
    const port = Number(a.listenPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`[Config Persistence] Skipping app "${a.name}" (${a.id}): invalid listenPort "${a.listenPort}"`);
      return null;
    }
    const protocols = Array.isArray(a.protocols)
      ? a.protocols.filter((p: any) => p === 'http' || p === 'https')
      : ['http'];
    return {
      id: a.id,
      name: a.name.trim(),
      description: typeof a.description === 'string' ? a.description : '',
      listenHost: typeof a.listenHost === 'string' && a.listenHost.trim() ? a.listenHost.trim() : '0.0.0.0',
      listenPort: port,
      basePath: typeof a.basePath === 'string' && a.basePath.startsWith('/') ? a.basePath : '/',
      protocols: protocols.length ? protocols : ['http'],
      enabled: a.enabled !== false,
      isDefault: false,
      createdAt: typeof a.createdAt === 'string' ? a.createdAt : new Date().toISOString(),
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : new Date().toISOString()
    };
  } catch (err: any) {
    console.error(`[Config Persistence] Skipping malformed app entry: ${err?.message || err}`);
    return null;
  }
}

function sanitizeRouteConfig(r: any): Route | null {
  try {
    if (!r.id || typeof r.id !== 'string') return null;
    if (!r.name || typeof r.name !== 'string' || !r.name.trim()) return null;
    if (!r.appId || typeof r.appId !== 'string') return null;
    if (typeof r.pathPattern !== 'string' || !r.pathPattern.trim()) {
      console.error(`[Config Persistence] Skipping route "${r.name}" (${r.id}): missing pathPattern`);
      return null;
    }
    if (typeof r.code !== 'string' || !r.code.trim()) {
      console.error(`[Config Persistence] Skipping route "${r.name}" (${r.id}): missing code block`);
      return null;
    }
    const validStrategies = ['prefix', 'contains', 'equal', 'regex'];
    const validTargets = ['path', 'host', 'both'];
    // Unknown http methods from newer versions are dropped, never crash.
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL'];
    const httpMethods = Array.isArray(r.httpMethods)
      ? r.httpMethods.filter((m: any) => validMethods.includes(m))
      : [];
    return {
      id: r.id,
      appId: r.appId,
      name: r.name.trim(),
      description: typeof r.description === 'string' ? r.description : '',
      matchTarget: validTargets.includes(r.matchTarget) ? r.matchTarget : 'path',
      matchStrategy: validStrategies.includes(r.matchStrategy) ? r.matchStrategy : 'prefix',
      pathPattern: normalizeRoutePattern(r.pathPattern.trim()),
      hostPattern: typeof r.hostPattern === 'string' ? r.hostPattern : '*',
      // Unknown future fields (e.g. ignoreTls) are preserved so a downgrade
      // never silently drops user settings.
      ...(r.proxyTarget !== undefined ? { proxyTarget: r.proxyTarget } : {}),
      ...(r.ignoreTls !== undefined ? { ignoreTls: r.ignoreTls } : {}),
      httpMethods: httpMethods.length ? httpMethods : ['GET'],
      code: r.code,
      enabled: r.enabled !== false,
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 10,
      engine: (r.engine === 'process' || r.engine === 'isolatedvm') ? r.engine : 'isolatedvm',
      isDefault: false,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString()
    } as Route;
  } catch (err: any) {
    console.error(`[Config Persistence] Skipping malformed route entry: ${err?.message || err}`);
    return null;
  }
}

export function getSystemApp(): AppConfig {
  return {
    ...SYSTEM_APP,
    name: state.serverConfig.name,
    basePath: state.serverConfig.basePath,
    listenHost: state.serverConfig.listenHost,
    listenPort: state.serverConfig.listenPort
  };
}

export function ensureDefaultAppAndRoutes() {
  const sysAppIdx = state.appsStore.findIndex(a => a.id === SYSTEM_APP_ID || a.isDefault);
  if (sysAppIdx === -1) {
    state.appsStore.unshift(getSystemApp());
  } else {
    state.appsStore[sysAppIdx] = {
      ...state.appsStore[sysAppIdx],
      id: SYSTEM_APP_ID,
      name: state.serverConfig.name,
      description: SYSTEM_APP.description,
      basePath: state.serverConfig.basePath,
      listenPort: state.serverConfig.listenPort,
      listenHost: state.serverConfig.listenHost,
      protocols: ['http'],
      isDefault: true,
      enabled: true
    };
  }
  state.routesStore = state.routesStore.filter(r => !r.isDefault);
}

export function findAppById(id: string): AppConfig | null {
  if (id === SYSTEM_APP_ID) return getSystemApp();
  return state.appsStore.find(a => a.id === id) || null;
}

export function findAppByName(name: string): AppConfig | null {
  const found = state.appsStore.find(a => a.name === name);
  if (found) return found;
  const sys = getSystemApp();
  return sys.name === name ? sys : null;
}

export function findRouteByName(app: AppConfig, routeName: string): Route | null {
  const userRoute = state.routesStore.find(r => r.appId === app.id && r.name === routeName);
  if (userRoute) return userRoute;
  return SYSTEM_ROUTES.find(r => r.appId === app.id && r.name === routeName) || null;
}
