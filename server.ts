import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { generate as generateSelfSignedCert } from 'selfsigned';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { Server as HttpServer } from 'http';
import { createServer as createNetServer, createConnection as netCreateConnection, isIP as netIsIP, Server as NetServer, Socket as NetSocket } from 'net';
import { AppConfig, ServerConfig, Route, ExecutionLog, ValidationIssue, ValidationResult, TestRequestPayload, TestResponsePayload } from './src/types';
import { INITIAL_PRESET_APPS, INITIAL_PRESET_ROUTES } from './src/data/defaultData';
import { SYSTEM_APP, SYSTEM_APP_ID, SYSTEM_ROUTES, DEFAULT_SERVER_CONFIG } from './src/constants';

const app = express();

// System server config: the listen address/port this program binds to at startup.
// Persisted separately in the config file; editable through the web page but not deletable.
let serverConfig: ServerConfig = { ...DEFAULT_SERVER_CONFIG };

// Currently bound HTTP listener (hot-swapped when the system server config changes).
let httpServer: HttpServer | null = null;

// Preconfigured HTTPS agent that skips TLS certificate validation. Used ONLY
// when a route opts in via its `ignoreTls` flag (never injected globally).
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// In-Memory Storage & Configuration Persistence
const CONFIG_FILE_PATH = path.join(process.cwd(), 'data', 'relay-config.json');
const LOG_FILE_PATH = path.join(process.cwd(), 'data', 'relay-logs.json');

// Self-signed TLS material for HTTPS app listeners lives in a `crt` directory
// next to the config file (data/crt). It is auto-generated on first use when
// missing, and reused across restarts.
const CRT_DIR = path.join(process.cwd(), 'data', 'crt');
const CRT_KEY_PATH = path.join(CRT_DIR, 'key.pem');
const CRT_CERT_PATH = path.join(CRT_DIR, 'cert.pem');

// Auto-installed npm modules for route scripts live in data/route-modules
// (persisted + writable). Scripts are executed as real .mjs files under
// data/route-modules/scripts/, so their bare `import "pkg"` specifiers resolve
// against the auto-installed node_modules (and Node/Bun builtins).
const ROUTE_MODULES_DIR = path.join(process.cwd(), 'data', 'route-modules');
const ROUTE_SCRIPTS_DIR = path.join(ROUTE_MODULES_DIR, 'scripts');

const execFileAsync = promisify(execFile);

// Auto-install missing npm packages by default; set RELAY_AUTO_INSTALL=false
// to disable runtime installs and surface resolution errors instead.
const AUTO_INSTALL_ENABLED = process.env.RELAY_AUTO_INSTALL !== 'false';

// Opt-in global skip of TLS certificate verification for outbound HTTPS made by
// route scripts (fetch, https, axios). Bun cannot restore this setting after it
// is flipped at runtime, so it is only applied at startup, and only when the
// operator explicitly sets RELAY_TLS_INSECURE=true (default: verification on).
if (process.env.RELAY_TLS_INSECURE === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[TLS] RELAY_TLS_INSECURE=true — outbound HTTPS certificate verification is DISABLED for route scripts.');
}

// Log retention & paging: keep at most MAX_LOG_ENTRIES records (newest-first)
// in memory and on disk, and serve pages of at most DEFAULT_LOGS_LIMIT at a time
// so large histories never slow the UI.
const MAX_LOG_ENTRIES = 2000;
const DEFAULT_LOGS_LIMIT = 200;

let appsStore: AppConfig[] = [];
let routesStore: Route[] = [];
let executionLogs: ExecutionLog[] = [];

let logPersistTimer: NodeJS.Timeout | null = null;

// Persist the execution log history to disk (newest-first, capped).
function persistLogsToDisk() {
  try {
    const dir = path.dirname(LOG_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LOG_FILE_PATH, JSON.stringify(executionLogs, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Log Persistence] Error saving log history:', err);
  }
}

// Debounce disk writes so bursts of requests don't thrash the filesystem.
function scheduleLogPersist() {
  if (logPersistTimer) clearTimeout(logPersistTimer);
  logPersistTimer = setTimeout(() => {
    logPersistTimer = null;
    persistLogsToDisk();
  }, 1000);
}

// Load persisted log history at startup (newest-first, capped).
function loadLogsFromDisk() {
  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LOG_FILE_PATH, 'utf-8'));
      executionLogs = Array.isArray(parsed) ? parsed.slice(0, MAX_LOG_ENTRIES) : [];
    }
  } catch (err) {
    console.error('[Log Persistence] Error loading log history, starting fresh:', err);
    executionLogs = [];
  }
}

// Record a new execution log entry (newest-first) and trim to the cap.
function pushExecutionLog(entry: ExecutionLog) {
  executionLogs.unshift(entry);
  if (executionLogs.length > MAX_LOG_ENTRIES) executionLogs.pop();
  scheduleLogPersist();
}

// Helper: Load preset user apps/routes (system items are constants, added by ensureDefaultAppAndRoutes)
function presetUserApps(): AppConfig[] {
  return JSON.parse(JSON.stringify(INITIAL_PRESET_APPS.filter(a => a.id !== SYSTEM_APP_ID && !a.isDefault)));
}

// One-time migration: strip a leading /relay prefix from legacy route patterns.
function normalizeRoutePattern(pattern: string): string {
  if (pattern === '/relay') return '/';
  if (pattern.startsWith('/relay/')) return pattern.slice('/relay'.length);
  return pattern;
}

function presetUserRoutes(): Route[] {
  const presets = JSON.parse(JSON.stringify(INITIAL_PRESET_ROUTES.filter(r => r.appId !== SYSTEM_APP_ID && !r.isDefault)));
  return presets.map((r: Route) => ({ ...r, pathPattern: normalizeRoutePattern(r.pathPattern) }));
}

// Helper: Save config to JSON disk file.
// System server config is stored as a separate `server` section.
// System app & routes are constants and are NOT persisted.
function saveConfigToDisk() {
  try {
    const dir = path.dirname(CONFIG_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
      format: 'json',
      updatedAt: new Date().toISOString(),
      server: serverConfig,
      apps: appsStore.filter(a => a.id !== SYSTEM_APP_ID && !a.isDefault),
      routes: routesStore.filter(r => !r.isDefault)
    };
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[Config Persistence] Saved configuration to ${CONFIG_FILE_PATH}`);
  } catch (err) {
    console.error('[Config Persistence] Error saving config file:', err);
  }
}

// Env-based defaults for the system listener, used when no config file exists
// (e.g. fresh containers): RELAY_PORT (or PORT) overrides the listen port,
// LISTEN_HOST overrides the bind address. A persisted config file still wins.
function envServerConfigDefaults(): Partial<ServerConfig> {
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

// Helper: Load config from JSON disk file
function loadConfigFromDisk() {
  serverConfig = { ...DEFAULT_SERVER_CONFIG, ...envServerConfigDefaults() };
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);

      // 1. System server config (name, basePath, listen address/port read at startup)
      if (parsed.server && typeof parsed.server === 'object') {
        if (typeof parsed.server.name === 'string' && parsed.server.name.trim()) {
          serverConfig.name = parsed.server.name.trim();
        }
        if (typeof parsed.server.basePath === 'string' && parsed.server.basePath.trim().startsWith('/')) {
          serverConfig.basePath = parsed.server.basePath.trim();
        }
        if (typeof parsed.server.listenHost === 'string' && parsed.server.listenHost.trim()) {
          serverConfig.listenHost = parsed.server.listenHost.trim();
        }
        const port = Number(parsed.server.listenPort);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          serverConfig.listenPort = port;
        }
      }

      // 2. User-defined apps & routes (system items are constants)
      appsStore = Array.isArray(parsed.apps)
        ? parsed.apps.filter((a: AppConfig) => a.id !== SYSTEM_APP_ID && !a.isDefault)
        : presetUserApps();
      routesStore = Array.isArray(parsed.routes)
        ? parsed.routes
            .filter((r: Route) => !r.isDefault)
            .map((r: Route) => ({ ...r, pathPattern: normalizeRoutePattern(r.pathPattern) }))
        : presetUserRoutes();

      console.log(`[Config Persistence] Successfully loaded configuration from ${CONFIG_FILE_PATH}`);
    } else {
      appsStore = presetUserApps();
      routesStore = presetUserRoutes();
    }
  } catch (err) {
    console.error('[Config Persistence] Error loading configuration file, using preset fallback:', err);
    appsStore = presetUserApps();
    routesStore = presetUserRoutes();
  }
}

// Helper: Effective system app reflecting the persisted server config
function getSystemApp(): AppConfig {
  return {
    ...SYSTEM_APP,
    name: serverConfig.name,
    basePath: serverConfig.basePath,
    listenHost: serverConfig.listenHost,
    listenPort: serverConfig.listenPort
  };
}

// Check whether a host:port can be bound (used to detect port conflicts before swapping).
function checkPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const tester = createNetServer();
    tester.once('error', () => done(false));
    tester.once('listening', () => tester.close(() => done(true)));
    tester.listen(port, host);
    // Guard against slow DNS resolution for invalid hostnames.
    setTimeout(() => {
      try { tester.close(); } catch { /* noop */ }
      done(false);
    }, 2500);
  });
}

// Bind a new listener for the given address and (if one is already active) gracefully
// close the previous listener after the new one is up.
function tryBindOnce(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const newServer = app.listen(port, host, () => {
      if (httpServer && httpServer !== newServer) {
        // Graceful close: finish in-flight requests (including the current save response).
        httpServer.close(() => {
          console.log('[Relay Server] Previous listener closed.');
        });
      }
      httpServer = newServer;
      console.log(`Relay Server & Web Hub listening on http://${host}:${port}`);
      done(true);
    });
    newServer.once('error', (err) => {
      console.error(`[Relay Server] Failed to bind ${host}:${port}:`, err.message);
      try { newServer.close(); } catch { /* noop */ }
      done(false);
    });
    // Guard against slow DNS resolution for invalid hostnames.
    setTimeout(() => {
      if (!settled) {
        console.error(`[Relay Server] Bind to ${host}:${port} timed out.`);
        try { newServer.close(); } catch { /* noop */ }
        done(false);
      }
    }, 2500);
  });
}

async function bindNewListener(host: string, port: number, retries = 3): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (await tryBindOnce(host, port)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 60));
  }
  return false;
}

// Hot-swap the bound listener after the system server config changes.
//
// - Port changed: the old listener does NOT block the new address, so we probe the
//   target first and only swap when it is free (zero-downtime).
// - Host changed but port unchanged: the old listener currently OWNS the port, so a
//   probe would falsely report a conflict. We close the old listener (fire-and-forget;
//   the port is freed immediately while in-flight requests drain), bind the new host on
//   the same port, and restore the previous host:port if the new bind fails.
//
// On failure the caller reverts serverConfig and the API returns a conflict error.
async function reListenServer(prevConfig: ServerConfig): Promise<boolean> {
  const host = serverConfig.listenHost;
  const port = serverConfig.listenPort;
  const samePort = prevConfig.listenPort === port;

  if (!samePort) {
    // Reject immediately if the target address is already taken by another process.
    const available = await checkPortAvailable(host, port);
    if (!available) {
      console.error(`[Relay Server] Port conflict: ${host}:${port} already in use.`);
      return false;
    }
    return bindNewListener(host, port);
  }

  // Same port, host changed: close the old listener (frees the port right away) and
  // bind the new host. Do NOT await the close — it only fires after the in-flight
  // save request finishes, which would deadlock this handler.
  if (httpServer) {
    httpServer.close(() => {
      console.log('[Relay Server] Previous listener closed.');
    });
  }
  httpServer = null;

  if (await bindNewListener(host, port)) {
    return true;
  }

  // Restore the previous host on the same port.
  const restored = await bindNewListener(prevConfig.listenHost, prevConfig.listenPort);
  if (!restored) {
    console.error('[Relay Server] CRITICAL: failed to restore listener after host change. No listener is active.');
  }
  return false;
}

// ----------------------------------------------------
// PER-APP PORT LISTENERS
// Each enabled user App binds a real HTTP listener on its own
// listenHost:listenPort. Requests hitting that port are routed
// ONLY to that App's routes using the direct path (the port
// identifies the App, so no /relay prefix is required).
// ----------------------------------------------------
const appListeners = new Map<string, NetServer>();

// Match a request path against an App's enabled routes.
// Candidate path forms: the raw path plus the basePath-stripped path.
// checkRouteMatch internally also tries the /relay-prefixed variant.
function matchAppRoute(
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

  const candidateRoutes = routesStore
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

// Shared dispatcher: match the request to one of the app's routes, execute the
// sandboxed script, log the execution and respond. Used by both the main
// route gateway and the per-app port listeners.
async function handleAppRequest(
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

// Execute a matched route through the application-level machinery
// (sandboxed script + execution log + response headers). Shared by the
// gateway, the per-app port listeners and the code-defined system routes.
async function respondWithMatchedRoute(
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

function createAppSubApp(appId: string) {
  const sub = express();
  sub.use(express.json({ limit: '10mb' }));
  sub.use(express.urlencoded({ extended: true, limit: '10mb' }));
  sub.use(async (req: Request, res: Response) => {
    const startMs = Date.now();
    const targetApp = appsStore.find(a => a.id === appId);
    if (!targetApp) {
      res.status(503).json({ error: 'App Not Found' });
      return;
    }
    const reqPath = (req.originalUrl || '/').split('?')[0] || '/';
    await handleAppRequest(targetApp, reqPath, reqPath, req, res, startMs);
  });
  return sub;
}

// Per-app listener bind status, surfaced in the UI so "active but port failed"
// states are visually distinguishable from truly-listening apps.
const appListenStatus = new Map<string, { bound: boolean; address?: string; scheme?: string; error?: string; reason?: string }>();

// Load (and generate on first use) the self-signed TLS key/cert pair used by
// HTTPS app listeners. Generated once into data/crt next to the config file;
// regenerated automatically only if the files are missing.
function ensureSelfSignedCerts(): { key: string; cert: string } {
  fs.mkdirSync(CRT_DIR, { recursive: true });
  if (fs.existsSync(CRT_KEY_PATH) && fs.existsSync(CRT_CERT_PATH)) {
    return { key: fs.readFileSync(CRT_KEY_PATH, 'utf-8'), cert: fs.readFileSync(CRT_CERT_PATH, 'utf-8') };
  }
  console.log('[TLS] Generating self-signed certificate for HTTPS listeners...');
  const pems = generateSelfSignedCert(
    [
      { name: 'commonName', value: 'relay.local' },
      { name: 'organizationName', value: 'Relay Server' },
      { name: 'organizationalUnitName', value: 'Self-Signed' }
    ],
    {
      keySize: 2048,
      algorithm: 'sha256',
      days: 3650,
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ] }
      ]
    }
  );
  fs.writeFileSync(CRT_KEY_PATH, pems.private, { mode: 0o600 });
  fs.writeFileSync(CRT_CERT_PATH, pems.cert, 'utf-8');
  console.log(`[TLS] Generated self-signed certificate at ${CRT_DIR}`);
  return { key: pems.private, cert: pems.cert };
}

// Build a listener for an app based on its selected protocols. http and https
// may both be enabled; when both are selected a single shared port serves the
// two protocols by sniffing the first bytes of each connection (TLS ClientHello
// vs plaintext) and tunneling it to an internal loopback http/https listener.
// (Bun's http/https servers cannot receive sockets injected via 'connection'
// events, so a plain loopback tunnel is used to keep one public port.)
async function buildAppListener(appConfig: AppConfig, sub: any): Promise<{ server: NetServer; scheme: string }> {
  const protocols = (appConfig.protocols && appConfig.protocols.length)
    ? appConfig.protocols
    : ['http' as const];
  const useHttp = protocols.includes('http');
  const useHttps = protocols.includes('https');

  if (useHttp && useHttps) {
    const { key, cert } = ensureSelfSignedCerts();
    const httpSrv = http.createServer(sub);
    const httpsSrv = https.createServer({ key, cert }, sub);
    await new Promise<void>((resolve) => httpSrv.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => httpsSrv.listen(0, '127.0.0.1', () => resolve()));
    const httpPort = (httpSrv.address() as any).port as number;
    const httpsPort = (httpsSrv.address() as any).port as number;
    const server = createNetServer((socket: NetSocket) => {
      socket.once('data', (buffer: Buffer) => {
        socket.pause();
        const isTls = buffer.length >= 2 && buffer[0] === 0x16 && buffer[1] === 0x03;
        const upstream = netCreateConnection({ port: isTls ? httpsPort : httpPort, host: '127.0.0.1' });
        upstream.on('connect', () => {
          upstream.write(buffer);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
      });
    });
    return { server, scheme: 'http+https' };
  }

  if (useHttps) {
    const { key, cert } = ensureSelfSignedCerts();
    return { server: https.createServer({ key, cert }, sub), scheme: 'https' };
  }

  return { server: http.createServer(sub), scheme: 'http' };
}

async function bindAppListener(appConfig: AppConfig) {
  unbindAppListener(appConfig.id);

  const isSystem = appConfig.isDefault || appConfig.id === SYSTEM_APP_ID;
  if (isSystem || !appConfig.enabled) {
    appListenStatus.set(appConfig.id, { bound: false, reason: isSystem ? 'system' : 'disabled' });
    return;
  }

  const host = appConfig.listenHost || '0.0.0.0';
  const port = Number(appConfig.listenPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    appListenStatus.set(appConfig.id, { bound: false, error: `Invalid listen port "${appConfig.listenPort}"` });
    return;
  }

  // Never collide with the system listener address.
  if (host === serverConfig.listenHost && port === serverConfig.listenPort) {
    console.warn(`[App Listener] "${appConfig.name}" skipped: address ${host}:${port} is the system server address.`);
    appListenStatus.set(appConfig.id, { bound: false, reason: 'same-as-system', address: `${host}:${port}` });
    return;
  }

  const { server, scheme } = await buildAppListener(appConfig, createAppSubApp(appConfig.id));
  server.listen(port, host, () => {
    appListenStatus.set(appConfig.id, { bound: true, address: `${host}:${port}`, scheme });
    console.log(`[App Listener] "${appConfig.name}" listening on ${scheme}://${host}:${port}`);
  });
  server.once('error', (err: any) => {
    appListenStatus.set(appConfig.id, { bound: false, error: err.message, address: `${host}:${port}`, scheme });
    console.error(`[App Listener] "${appConfig.name}" failed to bind ${host}:${port}: ${err.message}`);
  });
  appListeners.set(appConfig.id, server);
}

function unbindAppListener(appId: string) {
  const existing = appListeners.get(appId);
  if (existing) {
    existing.close();
    appListeners.delete(appId);
  }
  appListenStatus.set(appId, { bound: false, reason: 'disabled' });
}

async function rebindAllAppListeners() {
  for (const appId of Array.from(appListeners.keys())) {
    unbindAppListener(appId);
  }
  await Promise.all(appsStore.map(appConfig => bindAppListener(appConfig).catch(err => {
    console.error(`[App Listener] "${appConfig.name}" setup failed: ${err?.message || err}`);
  })));
}

// Effective binding status of an app, as shown in the UI.
function getAppListenStatus(app: AppConfig) {
  if (app.isDefault || app.id === SYSTEM_APP_ID) {
    return { state: 'system', bound: true, address: `${serverConfig.listenHost}:${serverConfig.listenPort}` };
  }
  if (!app.enabled) {
    return { state: 'disabled', bound: false };
  }
  const s = appListenStatus.get(app.id);
  if (s?.bound) {
    return { state: 'bound', bound: true, address: s.address, scheme: s.scheme };
  }
  if (s?.reason === 'same-as-system') {
    return { state: 'same-as-system', bound: false, address: s.address, error: `Uses the system server address (${s.address})` };
  }
  if (s?.error) {
    return { state: 'failed', bound: false, address: s.address, error: s.error };
  }
  return { state: 'unknown', bound: false };
}

// Helper: Ensure system constants exist & are immutable.
// name/basePath/listenHost/listenPort are locked to the persisted server config.
function ensureDefaultAppAndRoutes() {
  // 1. Ensure System App exists & force immutable properties.
  const sysAppIdx = appsStore.findIndex(a => a.id === SYSTEM_APP_ID || a.isDefault);
  if (sysAppIdx === -1) {
    appsStore.unshift(getSystemApp());
  } else {
    appsStore[sysAppIdx] = {
      ...appsStore[sysAppIdx],
      id: SYSTEM_APP_ID,
      name: serverConfig.name,
      description: SYSTEM_APP.description,
      basePath: serverConfig.basePath,
      listenPort: serverConfig.listenPort, // Lock to persisted server config
      listenHost: serverConfig.listenHost,
      protocols: ['http'],
      isDefault: true,
      enabled: true
    };
  }

  // 2. System routes live in code (SYSTEM_ROUTES constants), never in the
  // user-editable store. Drop any that slipped in (e.g. from old configs),
  // but keep user-defined routes attached to the System App.
  routesStore = routesStore.filter(r => !r.isDefault);
}

// System-level routes are defined in code (SYSTEM_ROUTES constants) and are
// registered here as real HTTP handlers on the main server. They reuse the
// application-level execution/logging machinery, so their behavior, logs and
// response format stay identical to user-configured routes.
function registerSystemRoutes() {
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

// Initialize from persistence and enforce system constants
loadConfigFromDisk();
ensureDefaultAppAndRoutes();
saveConfigToDisk();
loadLogsFromDisk();

// Syntax Validation Engine
// Route scripts are executed as ESM modules (so `import https from "https"`
// etc. are valid), which `new AsyncFunction` can't parse. Strip ESM-only
// import/export declarations first, then validate the remaining body.
function validateJavaScriptSyntax(code: string): { valid: boolean; error?: string; line?: number } {
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

// Route & App Conflict Validation
function validateAppConfig(appData: Partial<AppConfig>, currentId?: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!appData.name || !appData.name.trim()) {
    errors.push({ field: 'name', message: 'App name cannot be empty', severity: 'error' });
  }

  if (appData.listenPort === undefined || appData.listenPort <= 0 || appData.listenPort > 65535) {
    errors.push({ field: 'listenPort', message: 'Valid listen port (1-65535) is required', severity: 'error' });
  }

  // Validate listen host format: must be a valid IP address or hostname.
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

  // Check port & base path collision
  const portConflict = appsStore.find(a => 
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

function validateRouteConfig(routeData: Partial<Route>, currentRouteId?: string): ValidationResult {
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

  // Validate JavaScript Code Syntax
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
  }

  // Check Route Overlap / Conflict within same App
  if (routeData.appId) {
    const appRoutes = routesStore.filter(r => r.appId === routeData.appId && r.id !== currentRouteId);
    
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

// Route Execution Sandboxing Helper
// --- Route script module helpers ---

// True for a specifier that must be resolved by node_modules (not builtin,
// relative/absolute path, or remote/data URL).
function isBareSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('node:')) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')
    || specifier.startsWith('http:') || specifier.startsWith('https:') || specifier.startsWith('data:')) {
    return false;
  }
  return true;
}

// Map an import specifier to its npm package name ("@scope/pkg/sub" -> "@scope/pkg",
// "axios/dist/x.js" -> "axios").
function barePackageName(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

// Split a bare specifier into its package name and optional pinned version, e.g.
// "undici@7.29.0" -> { name: "undici", version: "7.29.0" },
// "@scope/pkg@^1.2" -> { name: "@scope/pkg", version: "^1.2" },
// "axios/dist/x.js" -> { name: "axios/dist/x.js" }.
function splitImportSpec(spec: string): { name: string; version?: string } {
  if (!isBareSpecifier(spec)) return { name: spec };
  const at = spec.lastIndexOf('@');
  if (at > 0) {
    const candidate = spec.slice(at + 1);
    if (/^(?:[~^><=]*\d|latest|next|\*)/.test(candidate)) {
      return { name: spec.slice(0, at), version: candidate };
    }
  }
  return { name: spec };
}

// Collect every static bare import specifier in the script ("import x from 'pkg'",
// "import 'pkg'", and dynamic import("pkg")), keeping any pinned @version.
function extractBareImports(code: string): { name: string; version?: string }[] {
  const out = new Map<string, { name: string; version?: string }>();
  const re = /\bimport\b[^;\n]*?\bfrom\s*["']([^"']+)["']|(?:^|\s)\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !isBareSpecifier(spec)) continue;
    const { name, version } = splitImportSpec(spec);
    const key = `${name}${version ? '@' + version : ''}`;
    if (!out.has(key)) out.set(key, { name, version });
  }
  return Array.from(out.values());
}

// Strip the pinned @version from import specifiers ("from 'undici@7.29.0'" ->
// "from 'undici'"), so the version is only used by the installer and the real
// ESM resolver still sees a plain bare specifier.
function stripImportVersions(imports: string): string {
  const re = /(\b(?:from|import)\b\s*["'])([^"']+)(["'])/g;
  return imports.replace(re, (full, pre, spec, post) => {
    if (!isBareSpecifier(spec)) return full;
    const { name, version } = splitImportSpec(spec);
    if (!version) return full;
    return `${pre}${name}${post}`;
  });
}

// Try to read the missing package name out of an ESM resolution error.
function missingPackageFromError(err: any): string | null {
  const msg = String((err && err.message) || '');
  const m = msg.match(/Cannot find (?:package|module)\s*['"]?([^'",\s/]+(?:[/][^'",\s]*)?)/i);
  if (!m) return null;
  const spec = m[1].replace(/^node:/, '');
  if (!isBareSpecifier(spec)) return null;
  return barePackageName(spec);
}

let cachedPkgManager: string | null = null;

// Prefer bun (the container runtime) for fast installs; fall back to npm.
function detectPackageManager(): string {
  if (cachedPkgManager) return cachedPkgManager;
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    cachedPkgManager = 'bun';
  } catch {
    cachedPkgManager = 'npm';
  }
  return cachedPkgManager;
}

// `bun add <pkg>` / `npm install <pkg>` into data/route-modules.
async function installPackage(pkg: string): Promise<void> {
  fs.mkdirSync(ROUTE_MODULES_DIR, { recursive: true });
  const mgr = detectPackageManager();
  const args = mgr === 'bun'
    ? ['add', pkg, '--silent']
    : ['install', pkg, '--no-audit', '--no-fund', '--loglevel=error'];
  try {
    await execFileAsync(mgr, args, { cwd: ROUTE_MODULES_DIR, timeout: 120000, maxBuffer: 1024 * 1024 });
    console.log(`[Route Modules] Installed "${pkg}" via ${mgr}`);
  } catch (err: any) {
    throw new Error(`Failed to auto-install "${pkg}" (${mgr}): ${(err.stderr || err.message || '').toString().slice(0, 500)}`);
  }
}

// Find an already-installed copy of `spec` by walking up from the route scripts
// dir, WITHOUT consulting the runtime resolver (Bun caches negative hits). The
// walk mirrors bare-specifier ESM resolution but skips data/route-modules so we
// only match packages bundled in the server's own node_modules tree.
function resolveBundledImport(spec: string): string | null {
  const rel = path.join('node_modules', ...spec.split('/'));
  let dir = ROUTE_SCRIPTS_DIR;
  for (;;) {
    if (dir === ROUTE_MODULES_DIR) {
      dir = path.dirname(dir);
      continue;
    }
    const pkg = path.join(dir, rel);
    if (fs.existsSync(path.join(pkg, 'package.json'))) return pkg;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Bun caches failed module resolutions in-process, so installing a package only
// AFTER an import fails can never be re-resolved in the same process. Pre-check
// every top-level bare import and install anything missing BEFORE the first
// import runs, so the resolver cache never records a negative hit.
// Read the installed version of an auto-installed package ("" if not present).
function readInstalledVersion(pkgDir: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version || '';
  } catch {
    return '';
  }
}

async function ensureBareImportsInstalled(code: string): Promise<void> {
  if (!AUTO_INSTALL_ENABLED) return;
  const specs = extractBareImports(code);
  for (const { name, version } of specs) {
    const pkgDir = path.join(ROUTE_MODULES_DIR, 'node_modules', ...name.split('/'));
    const haveLocal = fs.existsSync(path.join(pkgDir, 'package.json'));
    const bundled = resolveBundledImport(name);

    if (version) {
      // Explicit @version pin — honor it even if the server bundles the package.
      // Reinstall only when we have no local copy or an exact pin is unsatisfied.
      let needInstall = !haveLocal;
      if (haveLocal && /^[0-9][0-9.]*$/.test(version) && readInstalledVersion(pkgDir) !== version) {
        needInstall = true;
      }
      if (needInstall) await installPackage(`${name}@${version}`);
      continue;
    }

    if (haveLocal) {
      // Already auto-installed, but if the server also bundles this package the
      // bundled copy wins resolution anyway — drop the auto-installed copy so a
      // newer (possibly broken, e.g. undici@8 under Bun) version never shadows it.
      if (bundled) fs.rmSync(pkgDir, { recursive: true, force: true });
      continue;
    }
    if (bundled) continue;
    await installPackage(name);
  }
}

// Route modules are cached by (routeId, codeHash): a module is only re-imported
// when the route's code changes, and only in-use entries (refs > 0) are pinned.
// Unused entries are evicted after an idle timeout or when the cache is over its
// cap, keeping memory bounded.
interface RouteModuleEntry {
  hash: string;
  file: string;
  module: any;
  refs: number;      // active executions currently using this module
  lastUsed: number;  // ms timestamp of last execution
  created: number;   // ms timestamp when the module was (re)imported
}
const routeModuleCache = new Map<string, RouteModuleEntry>();
const ROUTE_MODULE_CACHE_CAP = 60;
const ROUTE_MODULE_IDLE_MS = 5 * 60 * 1000;
const ROUTE_MODULE_CLEAN_INTERVAL_MS = 60 * 1000;

// Deterministic file name for a route version: changing the code changes the
// hash, which produces a new file URL (so bun re-imports it) while identical
// code reuses the already-imported module instance.
function routeModuleFileName(routeId: string, hash: string): string {
  const safe = String(routeId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `__route_${safe}_${hash}.mjs`;
}

function cleanupRouteModuleCache(now = Date.now()): void {
  // 1) Evict idle, unused entries (refs === 0 and untouched for a while).
  for (const [key, entry] of routeModuleCache) {
    if (entry.refs === 0 && now - entry.lastUsed > ROUTE_MODULE_IDLE_MS) {
      routeModuleCache.delete(key);
      fs.unlink(entry.file, () => {});
    }
  }
  // 2) If still over the cap, drop the least-recently-used free entries.
  if (routeModuleCache.size > ROUTE_MODULE_CACHE_CAP) {
    const idle = [...routeModuleCache.entries()]
      .filter(([, e]) => e.refs === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let excess = routeModuleCache.size - ROUTE_MODULE_CACHE_CAP;
    for (const [key, entry] of idle) {
      if (excess <= 0) break;
      routeModuleCache.delete(key);
      fs.unlink(entry.file, () => {});
      excess--;
    }
  }
}

// Turn route code into a real ESM module. `import` statements are hoisted to the
// top (static imports must live at module scope); the rest becomes the body of an
// exported async function that receives the per-request sandbox. Reusing the
// module instance across requests keeps transpile cost to a single import while
// the request/response stay scoped to each invocation.
function transformRouteToModule(code: string): string {
  const importBlocks: string[] = [];
  const bodyLines: string[] = [];
  let inImport = false;
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (!inImport) {
      if (/^import\s/.test(t)) {
        importBlocks.push(line);
        inImport = !/["'][^"']*["']\s*;?(\s*\/\/.*)?$/.test(t);
      } else if (/^export\s/.test(t)) {
        bodyLines.push(line.replace(/^export\s+/, ''));
      } else {
        bodyLines.push(line);
      }
    } else {
      importBlocks.push(line);
      if (/["'][^"']*["']\s*;?(\s*\/\/.*)?$/.test(line)) inImport = false;
    }
  }
  const imports = stripImportVersions(importBlocks.join('\n'));
  const body = bodyLines.join('\n');
  return `${imports}\n\nexport default async function run({ request, response, fetch, console, fs }) {\n${body}\n}\n`;
}

// Resolve (and import) the cached module for a route, re-importing only when the
// code changed. Each invocation increments refs so the sweeper never evicts a
// module that is still executing. Only the documented params are injected
// (request, response, fetch, console, fs); anything else (https, http, npm
// packages) must be imported explicitly by the script.
async function executeRouteModule(
  route: Route,
  sandbox: Record<string, any>
): Promise<void> {
  const hash = createHash('sha1').update(route.code).digest('hex').slice(0, 12);
  const cacheKey = `${route.id}:${hash}`;
  const file = path.join(ROUTE_SCRIPTS_DIR, routeModuleFileName(route.id, hash));

  let entry = routeModuleCache.get(cacheKey);
  if (!entry) {
    // Install any missing top-level npm packages BEFORE the first import so bun
    // never records a negative resolution (which would poison all later imports).
    await ensureBareImportsInstalled(route.code);
    fs.mkdirSync(ROUTE_SCRIPTS_DIR, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, transformRouteToModule(route.code), 'utf-8');
    }
    try {
      const module = await import(pathToFileURL(file).href);
      entry = { hash, file, module, refs: 0, lastUsed: Date.now(), created: Date.now() };
    } catch (scriptErr: any) {
      const missing = missingPackageFromError(scriptErr);
      if (missing && AUTO_INSTALL_ENABLED) {
        // Defensive fallback: pre-install above covers top-level imports, so this
        // only fires for transitive deps. Best effort — bun's in-process resolver
        // cache may keep a negative hit, but retrying is cheap.
        await installPackage(missing);
        const module = await import(pathToFileURL(file).href);
        entry = { hash, file, module, refs: 0, lastUsed: Date.now(), created: Date.now() };
      } else {
        throw scriptErr;
      }
    }
    routeModuleCache.set(cacheKey, entry);
    cleanupRouteModuleCache();
  }

  entry.refs++;
  entry.lastUsed = Date.now();
  try {
    const run = entry.module.default as (sb: Record<string, any>) => Promise<any>;
    await run(sandbox);
  } finally {
    entry.refs--;
    entry.lastUsed = Date.now();
  }
}

// Minimal fetch shim that skips TLS certificate validation. Only used for a
// route whose `ignoreTls` flag is enabled — per-route opt-in, never global.
function insecureFetch(url: string | URL, init: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch (err: any) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: init.method || 'GET',
      headers: init.headers || {},
      agent: parsed.protocol === 'https:' ? insecureAgent : undefined
    }, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          ok: !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
          statusText: res.statusMessage || '',
          headers: res.headers,
          text: async () => body.toString('utf-8'),
          json: async () => JSON.parse(body.toString('utf-8'))
        });
      });
    });
    req.on('error', reject);
    const body = init.body;
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function executeRouteScript(
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
  const capturedLogs: string[] = [];
  
  const customConsole = {
    log: (...args: any[]) => capturedLogs.push(`[LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
    warn: (...args: any[]) => capturedLogs.push(`[WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
    error: (...args: any[]) => capturedLogs.push(`[ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
    info: (...args: any[]) => capturedLogs.push(`[INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
  };

  let responseStatus = 200;
  let responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  let responseBody: any = null;
  let responseSent = false;

  const mockResponse = {
    status: (code: number) => {
      responseStatus = code;
      return mockResponse;
    },
    setHeader: (key: string, value: string) => {
      responseHeaders[key] = value;
      return mockResponse;
    },
    json: (data: any) => {
      responseHeaders['Content-Type'] = 'application/json';
      responseBody = JSON.stringify(data, null, 2);
      responseSent = true;
      return mockResponse;
    },
    send: (data: any) => {
      if (typeof data === 'object') {
        responseHeaders['Content-Type'] = 'application/json';
        responseBody = JSON.stringify(data, null, 2);
      } else {
        if (!responseHeaders['Content-Type']) {
          responseHeaders['Content-Type'] = 'text/plain; charset=utf-8';
        }
        responseBody = String(data);
      }
      responseSent = true;
      return mockResponse;
    },
    redirect: (url: string) => {
      responseStatus = 302;
      responseHeaders['Location'] = url;
      responseBody = `Redirecting to ${url}`;
      responseSent = true;
      return mockResponse;
    }
  };

  try {
    const safeReqInfo = {
      ...reqInfo,
      params: reqInfo.params || {}
    };

    // Run the script as a real ESM module (file-based) so bare `import "pkg"`
    // specifiers resolve against auto-installed node_modules. The module is
    // cached by (routeId, codeHash) and re-imported only when the code changes.
    const sandbox = {
      request: safeReqInfo,
      response: mockResponse,
      // Per-route opt-in: only this route's fetch skips TLS verification.
      fetch: route.ignoreTls ? insecureFetch : globalThis.fetch,
      console: customConsole,
      fs
    };

    await executeRouteModule(route, sandbox);

    if (!responseSent) {
      if (responseBody === null) {
        responseBody = JSON.stringify({ message: 'Route executed successfully (No response payload explicitly sent)' });
      }
    }

    return {
      statusCode: responseStatus,
      headers: responseHeaders,
      body: responseBody,
      logs: capturedLogs
    };
  } catch (scriptErr: any) {
    customConsole.error(`Route Script Exception caught: ${scriptErr.message}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Script Execution Exception Isolated',
        routeId: route.id,
        routeName: route.name,
        message: scriptErr.message,
        stack: scriptErr.stack
      }, null, 2),
      logs: capturedLogs,
      error: scriptErr.message,
      stack: scriptErr.stack
    };
  }
}

// Matcher Helper with Dynamic Path Params support (:param, *)
interface RouteMatchResult {
  matched: boolean;
  params: Record<string, string>;
}

function matchPathPattern(pattern: string, actualPath: string, strategy: string): RouteMatchResult {
  const normPattern = (pattern || '').trim();
  const normPath = (actualPath || '').trim();

  if (!normPattern || !normPath) {
    return { matched: false, params: {} };
  }

  // Check if pattern contains dynamic parameter placeholders (:param or *)
  const hasDynamicParams = normPattern.includes(':') || normPattern.includes('*');

  if (hasDynamicParams && strategy !== 'regex') {
    const patternSegments = normPattern.split('/');
    const paramNames: string[] = [];

    let regexPattern = '^';
    for (let i = 0; i < patternSegments.length; i++) {
      const seg = patternSegments[i];
      if (!seg && i === 0) continue; // Leading slash

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
    } else { // equal
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

  // Non-dynamic standard path matching
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

function checkRouteMatch(
  route: Route,
  reqPath: string,
  reqHost: string,
  reqMethod: string
): RouteMatchResult {
  if (!route.enabled) return { matched: false, params: {} };

  // Method check
  if (route.httpMethods && !route.httpMethods.includes('ALL') && !route.httpMethods.includes(reqMethod.toUpperCase() as any)) {
    return { matched: false, params: {} };
  }

  // Host check if matchTarget is 'host' or 'both'
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

  // Match the route pattern directly against the request path.
  // No /relay prefix is required anymore; only the system app's built-in
  // routes live under /internal.
  return matchPathPattern(route.pathPattern, reqPath, route.matchStrategy);
}

// ----------------------------------------------------
// Admin REST APIs
// ----------------------------------------------------

// GET /internal/apps
app.get('/internal/apps', (_req: Request, res: Response) => {
  ensureDefaultAppAndRoutes();
  res.json({ apps: appsStore.map(a => ({ ...a, listenStatus: getAppListenStatus(a) })) });
});

// POST /internal/apps - Add App with Conflict Check
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

  appsStore.push(newApp);
  ensureDefaultAppAndRoutes();
  saveConfigToDisk();
  rebindAllAppListeners();
  res.json({ app: newApp, validation });
});

// PUT /internal/apps/:id
app.put('/internal/apps/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const existingIndex = appsStore.findIndex(a => a.id === id);
  if (existingIndex === -1) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  const existingApp = appsStore[existingIndex];
  const validation = validateAppConfig(req.body, id);

  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', validation });
    return;
  }

  const isSystemApp = existingApp.isDefault || existingApp.id === SYSTEM_APP_ID;

  if (isSystemApp) {
    // System server app: everything (name/basePath/listenHost/listenPort) is editable,
    // except it cannot be deleted. On host/port change we hot-swap the bound listener.
    const prevConfig = { ...serverConfig };
    const nextConfig: ServerConfig = {
      name: (req.body.name || serverConfig.name).trim(),
      basePath: req.body.basePath
        ? (req.body.basePath.trim().startsWith('/') ? req.body.basePath.trim() : '/' + req.body.basePath.trim())
        : serverConfig.basePath,
      listenHost: req.body.listenHost || serverConfig.listenHost,
      listenPort: Number(req.body.listenPort) || serverConfig.listenPort
    };

    const portChanged = nextConfig.listenHost !== serverConfig.listenHost || nextConfig.listenPort !== serverConfig.listenPort;

    serverConfig = nextConfig;

    if (portChanged) {
      const rebound = await reListenServer(prevConfig);
      if (!rebound) {
        serverConfig = prevConfig;
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
      name: serverConfig.name,
      description: req.body.description ?? SYSTEM_APP.description,
      basePath: serverConfig.basePath,
      listenHost: serverConfig.listenHost,
      listenPort: serverConfig.listenPort,
      enabled: true,
      isDefault: true,
      updatedAt: new Date().toISOString()
    };

    appsStore[existingIndex] = updatedApp;
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

  appsStore[existingIndex] = updatedApp;
  ensureDefaultAppAndRoutes();
  saveConfigToDisk();
  rebindAllAppListeners();
  res.json({ app: updatedApp, validation });
});

// DELETE /internal/apps/:id - Prevent Deleting Default Server
app.delete('/internal/apps/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const targetApp = appsStore.find(a => a.id === id);

  if (!targetApp) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  if (targetApp.isDefault || targetApp.id === SYSTEM_APP_ID) {
    res.status(403).json({ error: 'System App (API Gateway Core) is protected and cannot be deleted.' });
    return;
  }

  appsStore = appsStore.filter(a => a.id !== id);
  // Remove associated routes
  routesStore = routesStore.filter(r => r.appId !== id);

  ensureDefaultAppAndRoutes();
  saveConfigToDisk();
  rebindAllAppListeners();
  res.json({ success: true, deletedId: id });
});

// GET /internal/routes
app.get('/internal/routes', (req: Request, res: Response) => {
  const { appId } = req.query;
  let filtered = routesStore;
  if (appId && typeof appId === 'string') {
    filtered = routesStore.filter(r => r.appId === appId);
  }
  res.json({ routes: filtered });
});

// POST /internal/validate-route
app.post('/internal/validate-route', (req: Request, res: Response) => {
  const routeData = req.body.route || {};
  const currentId = req.body.currentId;
  const validation = validateRouteConfig(routeData, currentId);
  res.json(validation);
});

// POST /internal/routes - Save Route with Backend Validation
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
    ignoreTls: req.body.ignoreTls === true,
    priority: Number(req.body.priority) || 10,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  routesStore.push(newRoute);
  ensureDefaultAppAndRoutes();
  saveConfigToDisk();
  res.json({ route: newRoute, validation });
});

// PUT /internal/routes/:id
app.put('/internal/routes/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const existingIndex = routesStore.findIndex(r => r.id === id);

  if (existingIndex === -1) {
    res.status(404).json({ error: 'Route not found' });
    return;
  }

  const existingRoute = routesStore[existingIndex];

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
    ignoreTls: req.body.ignoreTls === true,
    priority: Number(req.body.priority) || 10,
    updatedAt: new Date().toISOString()
  };

  routesStore[existingIndex] = updatedRoute;
  ensureDefaultAppAndRoutes();
  saveConfigToDisk();
  res.json({ route: updatedRoute, validation });
});

// DELETE /internal/routes/:id - Prevent Deleting Default System Route
app.delete('/internal/routes/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const targetRoute = routesStore.find(r => r.id === id);

  if (!targetRoute) {
    res.status(404).json({ error: 'Route not found' });
    return;
  }

  if (targetRoute.isDefault || SYSTEM_ROUTES.some(sr => sr.id === id)) {
    res.status(403).json({ error: 'The Built-in System Route is protected and cannot be deleted.' });
    return;
  }

  routesStore = routesStore.filter(r => r.id !== id);
  ensureDefaultAppAndRoutes();
  saveConfigToDisk();
  res.json({ success: true, deletedId: id });
});

// POST /internal/execute-test - Interactive Request Simulator
app.post('/internal/execute-test', async (req: Request, res: Response) => {
  const payload: TestRequestPayload = req.body;
  const startMs = Date.now();

  const targetApp = appsStore.find(a => a.id === payload.appId);
  if (!targetApp) {
    res.status(404).json({ error: 'Target App not found' });
    return;
  }

  let matchedRoute: Route | undefined;
  let extractedParams: Record<string, string> = {};
  
  if (payload.routeId) {
    // System routes are defined in code; look them up for simulation too.
    matchedRoute = routesStore.find(r => r.id === payload.routeId) || SYSTEM_ROUTES.find(r => r.id === payload.routeId);
    if (matchedRoute) {
      const matchRes = checkRouteMatch(matchedRoute, payload.url, payload.host || 'localhost', payload.method || 'GET');
      extractedParams = matchRes.params;
    }
  } else {
    // Find highest priority matching route in App (including code system routes)
    const appRoutes = [
      ...routesStore.filter(r => r.appId === targetApp.id && r.enabled),
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

  // Add to execution log history
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

// GET /internal/logs?limit=&offset= - Paginated execution logs (newest-first)
app.get('/internal/logs', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LOGS_LIMIT, 1), MAX_LOG_ENTRIES);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    logs: executionLogs.slice(offset, offset + limit),
    total: executionLogs.length,
    limit,
    offset
  });
});

// POST /internal/logs/clear
app.post('/internal/logs/clear', (_req: Request, res: Response) => {
  executionLogs = [];
  persistLogsToDisk();
  res.json({ success: true });
});

// GET /internal/config - Config Status & Export
app.get('/internal/config', (_req: Request, res: Response) => {
  res.json({
    format: 'json',
    filePath: CONFIG_FILE_PATH,
    fileExists: fs.existsSync(CONFIG_FILE_PATH),
    server: serverConfig,
    systemApp: getSystemApp(),
    systemRoutesCount: SYSTEM_ROUTES.length,
    appsCount: appsStore.length,
    routesCount: routesStore.length,
    apps: appsStore,
    routes: routesStore
  });
});

// System-level routes are code (see registerSystemRoutes below) and are
// registered here — before the gateway — so they keep the highest priority.
registerSystemRoutes();

// ----------------------------------------------------
// PREFIX-FREE ROUTE GATEWAY
// The /internal namespace is RESERVED for this program's own
// management API (highest priority): admin endpoints and the
// System App's built-in routes. Any other request on the main
// server is dispatched against user App routes by matching the
// raw path directly (no prefix required). Per-app port listeners
// are unaffected.
// ----------------------------------------------------
async function dispatchGateway(req: Request, res: Response, next: () => void) {
  try {
    const startMs = Date.now();
    const reqPath = (req.originalUrl || '/').split('?')[0] || '/';
    const reqHost = req.hostname || req.headers.host || 'localhost';
    const reqMethod = req.method;

    // User Apps only: the System App's routes are handled in code above.
    const orderedApps = [...appsStore.filter(a => !a.isDefault && a.id !== SYSTEM_APP_ID)];

    for (const targetApp of orderedApps) {
      if (!targetApp.enabled) continue;
      const matched = matchAppRoute(targetApp, reqPath, reqHost, reqMethod);
      if (matched) {
        await handleAppRequest(targetApp, reqPath, reqPath, req, res, startMs);
        return;
      }
    }

    // User-defined routes attached to the System App (its constants are
    // code-registered above and take priority).
    const sysApp = getSystemApp();
    const sysMatched = matchAppRoute(sysApp, reqPath, reqHost, reqMethod);
    if (sysMatched) {
      await handleAppRequest(sysApp, reqPath, reqPath, req, res, startMs);
      return;
    }

    // Unmatched /internal/* paths are a reserved system namespace: explicit 404.
    if (reqPath.startsWith('/internal/') || reqPath === '/internal') {
      const noRouteLog: ExecutionLog = {
        id: 'log-' + Date.now(),
        timestamp: new Date().toISOString(),
        appId: SYSTEM_APP_ID,
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

app.use(dispatchGateway);

// ----------------------------------------------------
// VITE & STATIC SERVING
// ----------------------------------------------------
// Startup sweep: remove legacy per-execution files (`__exec_*.mjs` from the old
// design) and any `__route_*.mjs` files not currently referenced by the cache
// (deleted routes / superseded code versions), so disk stays clean.
function cleanOrphanRouteScripts(): void {
  try {
    const files = fs.readdirSync(ROUTE_SCRIPTS_DIR);
    const referenced = new Set<string>();
    for (const entry of routeModuleCache.values()) referenced.add(entry.file);
    for (const f of files) {
      if (f.startsWith('__exec_') || (f.startsWith('__route_') && !referenced.has(path.join(ROUTE_SCRIPTS_DIR, f)))) {
        fs.unlink(path.join(ROUTE_SCRIPTS_DIR, f), () => {});
      }
    }
  } catch { /* dir may not exist yet */ }
}

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Lazy-import Vite (dev only) so the production image needs no Vite/esbuild.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));

    // Unified unmatched-request handler: browsers navigating get the SPA,
    // API clients get a JSON 404.
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

  // Global error handler: unified JSON 500 for any unhandled middleware error.
  app.use((err: any, _req: Request, res: Response, _next: () => void) => {
    console.error('[Unhandled Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: err && err.message ? String(err.message) : String(err) });
    } else {
      res.end();
    }
  });

  httpServer = app.listen(serverConfig.listenPort, serverConfig.listenHost, () => {
    console.log(`Relay Server & Web Hub listening on http://${serverConfig.listenHost}:${serverConfig.listenPort}`);
  });

  // Periodically evict idle/unused cached route modules and their on-disk files.
  setInterval(() => cleanupRouteModuleCache(), ROUTE_MODULE_CLEAN_INTERVAL_MS);
  cleanOrphanRouteScripts();

  rebindAllAppListeners();
}

startServer();
