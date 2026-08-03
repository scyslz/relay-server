export type MatchStrategy = 'prefix' | 'contains' | 'equal' | 'regex';
export type MatchTarget = 'path' | 'host' | 'both';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL';
export type ThemeMode = 'dark' | 'light' | 'midnight';

export interface Route {
  id: string;
  appId: string;
  name: string;
  description?: string;
  matchTarget: MatchTarget;
  matchStrategy: MatchStrategy;
  pathPattern: string;
  hostPattern?: string;
  httpMethods: HttpMethod[];
  code: string;
  enabled: boolean;
  priority: number; // Lower number = higher priority
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppConfig {
  id: string;
  name: string;
  description?: string;
  listenHost: string;
  listenPort: number;
  basePath: string;
  enabled: boolean;
  isDefault?: boolean; // Cannot be deleted
  createdAt: string;
  updatedAt: string;
  // Real listener state, computed by the server (not persisted).
  listenStatus?: {
    state: 'system' | 'bound' | 'failed' | 'disabled' | 'same-as-system' | 'unknown';
    bound: boolean;
    address?: string;
    error?: string;
  };
}

// System server configuration persisted separately in the config file.
// It is the actual listen address/port this program binds to at startup,
// plus the system app name/basePath, and cannot be modified through the web page.
export interface ServerConfig {
  name: string;
  basePath: string;
  listenHost: string;
  listenPort: number;
}

export interface ExecutionLog {
  id: string;
  timestamp: string;
  appId: string;
  appName: string;
  routeId?: string;
  routeName?: string;
  method: string;
  url: string;
  path: string;
  clientIp?: string;
  statusCode: number;
  durationMs: number;
  status: 'success' | 'error' | 'no_route';
  logs: string[];
  errorMessage?: string;
  errorStack?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  line?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface TestRequestPayload {
  appId: string;
  routeId?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  host?: string;
}

export interface TestResponsePayload {
  status: number;
  headers: Record<string, string>;
  body: string;
  logs: string[];
  durationMs: number;
  matchedRoute?: {
    id: string;
    name: string;
  };
  error?: string;
}
