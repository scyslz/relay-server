import { AppConfig, Route, ServerConfig } from './types';

export const SYSTEM_APP_ID = 'app-default-system';

// Defaults for the system server.
// At startup the persisted `server` section from the config file overrides these.
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  name: 'Current System Relay Server',
  basePath: '/',
  listenHost: '0.0.0.0',
  listenPort: 3000,
};

export const SYSTEM_APP: AppConfig = Object.freeze({
  id: SYSTEM_APP_ID,
  name: 'Current System Relay Server',
  description: 'Built-in primary management & relay service. System root endpoint.',
  listenHost: DEFAULT_SERVER_CONFIG.listenHost,
  listenPort: DEFAULT_SERVER_CONFIG.listenPort,
  basePath: '/',
  enabled: true,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

export const SYSTEM_ROUTES: Route[] = [
  {
    id: 'route-default-health',
    appId: SYSTEM_APP_ID,
    name: 'Health Check',
    description: 'Server uptime and status metric endpoint',
    matchTarget: 'path',
    matchStrategy: 'equal',
    pathPattern: '/internal/health',
    hostPattern: '*',
    httpMethods: ['GET', 'ALL'],
    code: `// Health Check Handler
// Params: request, response
try {
  const uptime = Math.floor(process.uptime ? process.uptime() : 120);
  console.log('Health check requested at ' + new Date().toISOString());
  
  response.status(200).json({
    status: 'ok',
    service: 'Relay Hub',
    timestamp: new Date().toISOString(),
    uptimeSeconds: uptime
  });
} catch (err) {
  console.error('Health check error:', err);
  response.status(500).json({ error: 'Health Check Exception', message: String(err) });
}`,
    enabled: true,
    priority: 1,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'route-default-fallback',
    appId: SYSTEM_APP_ID,
    name: 'Fallback Route',
    description: 'Ping endpoint for default request inspection',
    matchTarget: 'path',
    matchStrategy: 'prefix',
    pathPattern: '/internal/ping',
    hostPattern: '*',
    httpMethods: ['ALL'],
    code: `// Fallback Handler
// Params: request, response
console.log(\`[Fallback] \${request.method} \${request.url}\`);

response.setHeader('X-Relay-Server', 'AI-Studio-Relay-v1');
response.status(200).json({
  code: 0,
  msg: 'Relay Ping OK',
  requestInfo: {
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers
  }
});`,
    enabled: true,
    priority: 99,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
];
