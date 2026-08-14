export interface CodeTemplate {
  title: string;
  description: string;
  universal: boolean;
  dependency?: string;
  code: string;
}

const COMMON_TEMPLATES: CodeTemplate[] = [
  {
    title: 'Dynamic Path Params',
    description: 'Extract URL path parameters like /users/:id from request.params',
    universal: true,
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
    universal: true,
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
    title: 'CORS & Header Modifier',
    description: 'Set custom response headers and handle CORS preflight',
    universal: true,
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
    universal: true,
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
  }
];

const EXTERNAL_DEPENDENT_TEMPLATES: CodeTemplate[] = [
  {
    title: 'Nginx Path Proxy Pass',
    description: 'Nginx-style reverse proxy pass forwarding dynamic path /nginx/* to upstream',
    universal: false,
    dependency: 'external network / jsonplaceholder.typicode.com',
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
    title: 'HTTP Proxy Forwarder',
    description: 'Forward incoming request to upstream target using fetch',
    universal: false,
    dependency: 'external network / httpbin.org',
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
  }
];

const FS_DEPENDENT_TEMPLATES: CodeTemplate[] = [
  {
    title: 'File Writer / File Logger',
    description: 'Read, write or append incoming request payload to a log file using fs',
    universal: false,
    dependency: 'filesystem path ./relay_records.json (requires fs access enabled)',
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

const PROCESS_ONLY_TEMPLATES: CodeTemplate[] = [
  {
    title: 'File Writer / File Logger',
    description: 'fs access is only available on the node22 (process) runtime',
    universal: false,
    dependency: 'node22 runtime + filesystem path ./relay_records.json',
    code: `// File Writer & Data Storage Handler (process runtime only)
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

export function listCodeTemplates(engine?: string): CodeTemplate[] {
  const templates = [...COMMON_TEMPLATES, ...EXTERNAL_DEPENDENT_TEMPLATES];
  if (engine === 'process') {
    templates.push(...PROCESS_ONLY_TEMPLATES);
  } else {
    templates.push(...FS_DEPENDENT_TEMPLATES);
  }
  return templates;
}
