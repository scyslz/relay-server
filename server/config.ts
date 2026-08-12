import fs from 'fs';
import path from 'path';
import { AppConfig, Route, ServerConfig } from '../src/types';
import { INITIAL_PRESET_APPS, INITIAL_PRESET_ROUTES } from '../src/data/defaultData';
import { SYSTEM_APP, SYSTEM_APP_ID, SYSTEM_ROUTES, DEFAULT_SERVER_CONFIG } from '../src/constants';
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

      state.appsStore = Array.isArray(parsed.apps)
        ? parsed.apps.filter((a: AppConfig) => a.id !== SYSTEM_APP_ID && !a.isDefault)
        : presetUserApps();
      state.routesStore = Array.isArray(parsed.routes)
        ? parsed.routes
            .filter((r: Route) => !r.isDefault)
            .map((r: Route) => ({
              ...r,
              pathPattern: normalizeRoutePattern(r.pathPattern),
              engine: (r.engine === 'process' || r.engine === 'isolatedvm') ? r.engine : 'isolatedvm'
            }))
        : presetUserRoutes();

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
