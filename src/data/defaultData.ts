import { AppConfig, Route } from '../types';
import { SYSTEM_APP, SYSTEM_ROUTES } from '../constants';

// System app & routes are single-source constants (see src/constants.ts).
export const DEFAULT_APP: AppConfig = SYSTEM_APP;

export const DEFAULT_ROUTES: Route[] = SYSTEM_ROUTES;

export const INITIAL_PRESET_APPS: AppConfig[] = [
  DEFAULT_APP,
  {
    id: 'app-api-gateway',
    name: 'E-Commerce API Gateway',
    description: 'Secondary proxy app routing microservice requests',
    listenHost: '0.0.0.0',
    listenPort: 8080,
    basePath: '/api/v1',
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'app-auth-service',
    name: 'Auth & SSO Mock Service',
    description: 'Authentication relay and token validation mock app',
    listenHost: '127.0.0.1',
    listenPort: 8081,
    basePath: '/auth',
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
];

export const INITIAL_PRESET_ROUTES: Route[] = [
  ...DEFAULT_ROUTES,
  {
    id: 'route-users-list',
    appId: 'app-api-gateway',
    name: 'User Directory Mock Route',
    description: 'Simulates paginated user list response with filter',
    matchTarget: 'path',
    matchStrategy: 'prefix',
    pathPattern: '/api/v1/users',
    hostPattern: '*',
    httpMethods: ['GET'],
    code: `// User Directory Mock Handler
// Params: request, response
const page = parseInt(request.query?.page || '1', 10);
const role = request.query?.role || 'all';

console.log(\`Fetching users page \${page}, role filter: \${role}\`);

const mockUsers = [
  { id: 101, name: 'Alice Chen', role: 'admin', status: 'active' },
  { id: 102, name: 'Bob Smith', role: 'developer', status: 'active' },
  { id: 103, name: 'Charlie Kim', role: 'guest', status: 'pending' }
];

response.setHeader('Cache-Control', 'no-cache');
response.status(200).json({
  success: true,
  page: page,
  total: 42,
  data: mockUsers
});`,
    enabled: true,
    priority: 10,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'route-user-detail',
    appId: 'app-api-gateway',
    name: 'User Profile Dynamic Route',
    description: 'Fetches user details using dynamic path parameter /users/:id',
    matchTarget: 'path',
    matchStrategy: 'equal',
    pathPattern: '/users/:id',
    hostPattern: '*',
    httpMethods: ['GET'],
    code: `// Dynamic Path Parameter Handler (/users/:id)
// Params: request, response
const userId = request.params?.id || request.query?.id || '101';
console.log('Fetching profile for dynamic user ID:', userId);

const mockUser = {
  id: userId,
  name: userId === '101' ? 'Alice Chen' : userId === '102' ? 'Bob Smith' : \`User_\${userId}\`,
  email: \`user_\${userId}@example.com\`,
  role: 'developer',
  createdAt: new Date().toISOString()
};

response.status(200).json({
  success: true,
  userId: userId,
  params: request.params || {},
  user: mockUser
});`,
    enabled: true,
    priority: 8,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'route-reverse-proxy',
    appId: 'app-api-gateway',
    name: 'External HTTP Relay Forwarder',
    description: 'Proxies request to external REST API and transforms payload',
    matchTarget: 'path',
    matchStrategy: 'contains',
    pathPattern: '/remote-data',
    hostPattern: '*',
    httpMethods: ['GET', 'POST'],
    code: `// Reverse Proxy & Forwarder Code
// Params: request, response
try {
  console.log('Forwarding request to JSONPlaceholder remote endpoint...');
  
  // Real fetch call in sandbox
  const res = await fetch('https://jsonplaceholder.typicode.com/todos/1');
  const data = await res.json();

  console.log('Successfully received remote payload:', data);

  response.status(200).json({
    relayedBy: 'Relay Server v1.0',
    originData: data,
    timestamp: new Date().toISOString()
  });
} catch (err) {
  console.error('Proxy forwarding failed:', err);
  response.status(502).json({
    error: 'Bad Gateway / Proxy Error',
    message: err.message
  });
}`,
    enabled: true,
    priority: 5,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'route-nginx-proxy',
    appId: 'app-api-gateway',
    name: 'Nginx Dynamic Path Reverse Proxy',
    description: 'Nginx-style reverse proxy forwarding with dynamic wildcard path support (/nginx/*)',
    matchTarget: 'path',
    matchStrategy: 'equal',
    pathPattern: '/nginx/*',
    hostPattern: '*',
    httpMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    code: `// Nginx Dynamic Path Reverse Proxy
// Params: request, response
const targetPath = request.params?.wildcard || 'todos/1';
const upstreamBase = 'https://jsonplaceholder.typicode.com/';
const fullUpstreamUrl = upstreamBase + targetPath.replace(/^\\//, '');

console.log(\`[Nginx Proxy] Forwarding \${request.method} request to upstream: \${fullUpstreamUrl}\`);

try {
  const upstreamRes = await fetch(fullUpstreamUrl, {
    method: request.method,
    headers: {
      'Accept': 'application/json',
      'X-Forwarded-For': request.ip,
      'X-Forwarded-Host': request.host,
      'X-Proxy-By': 'Nginx-Relay-Gateway'
    }
  });

  const contentType = upstreamRes.headers.get('content-type') || '';
  let payload;
  if (contentType.includes('application/json')) {
    payload = await upstreamRes.json();
  } else {
    payload = await upstreamRes.text();
  }

  response.status(upstreamRes.status).json({
    proxy: 'Nginx-Path-Reverse-Proxy',
    upstreamUrl: fullUpstreamUrl,
    params: request.params,
    data: payload
  });
} catch (err) {
  console.error('[Nginx Proxy] Upstream request error:', err.message);
  response.status(502).json({
    error: 'Bad Gateway',
    message: \`Failed to proxy pass to \${fullUpstreamUrl}: \${err.message}\`
  });
}`,
    enabled: true,
    priority: 6,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'route-auth-token',
    appId: 'app-auth-service',
    name: 'JWT Token Grant Mock',
    description: 'Generates mock Bearer authorization token',
    matchTarget: 'path',
    matchStrategy: 'equal',
    pathPattern: '/auth/token',
    hostPattern: '*',
    httpMethods: ['POST'],
    code: `// JWT Token Issue Route
// Params: request, response
const body = request.body || {};

if (!body.username || !body.password) {
  console.warn('Missing username or password in auth request');
  response.status(400).json({
    error: 'Invalid Credentials',
    message: 'Please provide both username and password'
  });
  return;
}

console.log(\`Issuing JWT token for user: \${body.username}\`);

response.status(200).json({
  access_token: 'mock_jwt_token_' + Date.now() + '_' + Math.random().toString(36).substring(7),
  token_type: 'Bearer',
  expires_in: 3600,
  user: {
    username: body.username,
    permissions: ['read', 'write', 'admin']
  }
});`,
    enabled: true,
    priority: 1,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
];

export const CODE_SNIPPETS = [
  {
    title: 'Nginx Path Proxy Pass',
    description: 'Nginx-style reverse proxy pass forwarding dynamic path /nginx/* to upstream',
    code: `// Nginx Reverse Proxy Pass
// Params: request, response
const subPath = request.params?.wildcard || '';
const upstream = 'https://jsonplaceholder.typicode.com/' + subPath;

console.log('[Nginx proxy_pass] Relaying request to upstream:', upstream);

try {
  const res = await fetch(upstream, {
    method: request.method,
    headers: { 'Accept': 'application/json' }
  });
  const data = await res.json();
  response.status(res.status).json({
    proxy: 'nginx_proxy_pass',
    upstream: upstream,
    data: data
  });
} catch (err) {
  response.status(502).json({ error: 'Nginx Proxy Error', message: err.message });
}`
  },
  {
    title: 'Dynamic Path Params',
    description: 'Extract URL path parameters like /users/:id from request.params',
    code: `// Dynamic Path Params Handler (/users/:id)
// Params: request, response
const userId = request.params?.id || request.query?.id || 'unknown';
console.log('Received request for dynamic user ID:', userId);

response.status(200).json({
  success: true,
  message: 'User payload retrieved using dynamic path parameters',
  userId: userId,
  params: request.params || {},
  path: request.path
});`
  },
  {
    title: 'JSON API Mock',
    description: 'Return custom JSON payload with query param handling',
    code: `// JSON Mock Handler
// Params: request, response
const id = request.query?.id || '1';

console.log('Processing mock query for ID:', id);

response.status(200).json({
  id: id,
  status: 'success',
  data: {
    title: 'Sample Record',
    created: new Date().toISOString()
  }
});`
  },
  {
    title: 'HTTP Proxy Forwarder',
    description: 'Forward incoming request to upstream target using fetch',
    code: `// Reverse Proxy Relay
// Params: request, response
try {
  const targetUrl = 'https://httpbin.org/get';
  console.log('Relaying request to:', targetUrl);

  const upstreamRes = await fetch(targetUrl, {
    method: request.method,
    headers: { 'Accept': 'application/json' }
  });

  const payload = await upstreamRes.json();
  
  response.status(upstreamRes.status).json({
    proxyStatus: 'success',
    upstream: payload
  });
} catch (error) {
  console.error('Relay error:', error);
  response.status(500).json({ error: 'Relay Proxy Exception', message: error.message });
}`
  },
  {
    title: 'CORS & Header Modifier',
    description: 'Set custom response headers and handle CORS preflight',
    code: `// CORS & Header Enforcer
// Params: request, response
response.setHeader('Access-Control-Allow-Origin', '*');
response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

if (request.method === 'OPTIONS') {
  response.status(204).send('');
  return;
}

response.status(200).json({
  message: 'CORS Headers applied',
  receivedHeaders: request.headers
});`
  },
  {
    title: 'Rate Limiter Simulation',
    description: 'Simulate rate limiting by IP or header',
    code: `// Rate Limiter
// Params: request, response
const clientIp = request.ip || '127.0.0.1';
console.log('Checking rate limit for IP:', clientIp);

if (request.headers['x-simulate-rate-limit'] === 'true') {
  response.status(429).json({
    error: 'Too Many Requests',
    retryAfterSeconds: 60
  });
  return;
}

response.status(200).json({
  status: 'allowed',
  clientIp: clientIp
});`
  },
  {
    title: 'File Writer / File Logger',
    description: 'Read, write or append incoming request payload to a log file using fs',
    code: `// File Writer & Data Storage Handler
// Params: request, response, fs
try {
  const logData = {
    timestamp: new Date().toISOString(),
    method: request.method,
    path: request.path,
    query: request.query || {},
    body: request.body || null
  };

  const filePath = './relay_records.json';
  
  // Read existing logs or initialize empty array
  let records = [];
  try {
    if (fs && fs.existsSync && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      records = JSON.parse(content || '[]');
    }
  } catch (readErr) {
    console.warn('Initializing new log storage file:', readErr.message);
  }

  records.push(logData);

  // Write updated JSON data back to file system
  if (fs && fs.writeFileSync) {
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
    console.log(\`Successfully logged request payload to \${filePath}\`);
  }

  response.status(200).json({
    success: true,
    message: 'Data successfully logged and saved to file',
    filePath: filePath,
    totalRecords: records.length,
    latestRecord: logData
  });
} catch (error) {
  console.error('File write exception:', error);
  response.status(500).json({
    error: 'File Operation Exception',
    message: error.message
  });
}`
  }
];
