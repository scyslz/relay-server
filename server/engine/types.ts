import { Route, ExecutionLog } from '../../src/types';

// Sandbox parameters injected into every route script, mirroring the
// documented route API: request / response / fetch / console / fs.
// Extra capabilities (fs) are removed in the refactor to harden isolation.
export interface RouteSandbox {
  request: Record<string, any>;
  response: any; // mock response object the script mutates
  fetch: typeof fetch;
  console: Pick<Console, 'log' | 'warn' | 'error' | 'info'>;
}

export interface ExecutionRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, any>;
  headers: Record<string, string>;
  body: any;
  host: string;
  ip: string;
  params: Record<string, string>;
}

export interface ExecutionResult {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  logs: string[];
  error?: string;
  stack?: string;
  durationMs: number;
}

export interface RouteEngine {
  readonly name: 'process' | 'isolatedvm';
  // Execute one route against one request.
  execute(route: Route, reqInfo: ExecutionRequest): Promise<ExecutionResult>;
  // Pre-import / validate a route at startup or save time (fail fast).
  warmUp?(route: Route): Promise<void>;
  // Release all resources (called on server shutdown / engine swap).
  dispose(): Promise<void>;
}

export interface EngineOptions {
  // Memory cap per route execution/process in MB.
  memoryLimitMb?: number;
  // Hard wall-clock timeout per route execution in ms.
  timeoutMs?: number;
  // Auto-install missing npm packages before import.
  autoInstall?: boolean;
  // Base directory for auto-installed modules + generated scripts.
  modulesDir?: string;
  scriptsDir?: string;
  // Whether route scripts may use the `fs` sandbox param (off by default).
  allowFs?: boolean;
  // Number of workers/isolates in the execution pool.
  poolSize?: number;
  // Minimum pool size kept alive at all times (defaults to poolSize or
  // min(cpu,2)); the pool never shrinks below this.
  minPoolSize?: number;
  // Maximum pool size the pool may grow to under load (defaults to max(min,
  // cpu*2)). Extra entries created on demand and reclaimed after idleMs.
  maxPoolSize?: number;
  // Milliseconds an extra (non-minimum) entry must be idle before it is
  // reclaimed by the auto-shrink timer (default 60s).
  idleMs?: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  memoryLimitMb: 64,
  timeoutMs: 10000,
  autoInstall: true,
  allowFs: false
};