import { Route, ExecutionLog } from '../../shared/types';

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

// Inbound connection bridge. A WS upgrade (or streamable HTTP) request runs
// through the route; the route decides the upstream target (host.proxy), the
// engine then establishes the real connection and tunnels bytes both ways.
// Lifecycle: connections are registered under the owning route id and are torn
// down when the route is updated/deleted/disabled (disconnectRoutes) or when
// the engine reclaims its resources (dispose / entry recycle).
export interface BridgeRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, any>;
  headers: Record<string, string>;
  host: string;
  ip: string;
  params: Record<string, string>;
}

export interface BridgeDecision {
  // Route called host.proxy(target): hand the connection to the engine.
  proxied: boolean;
  // Upstream to tunnel to (scheme://host:port), unchanged from host.proxy.
  target?: string;
  // Full upstream URL to request (target + rewritten path). When set, the
  // tunnel uses this instead of target + original path.
  url?: string;
  // Request headers to send upstream (host.proxy headers, merged over the
  // inbound request's headers).
  requestHeaders?: Record<string, string>;
  // When the route did not proxy, it produced a normal response instead.
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  body?: any;
}

export interface RouteEngine {
  readonly name: 'process' | 'isolatedvm';
  // Execute one route against one request.
  execute(route: Route, reqInfo: ExecutionRequest): Promise<ExecutionResult>;
  // Run an inbound WS/HTTP upgrade through the route code. The engine decides
  // whether to tunnel (host.proxy) or respond normally. Optional: engines that
  // cannot bridge (process) leave it undefined; the caller falls back to a 404.
  executeBridge?(route: Route, reqInfo: BridgeRequest): Promise<BridgeDecision>;
  // Register an established bridge tunnel under its owning route id so it can
  // be closed on route lifecycle changes. Returns a connection id used by
  // unregisterBridge when the tunnel closes naturally.
  registerBridge?(routeId: string, close: () => void): number;
  unregisterBridge?(bridgeId: number): void;
  // Tear down every bridge connection owned by the given route ids. Called
  // when routes are updated, disabled or deleted.
  disconnectRoutes?(routeIds: Set<string>): void;
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
  // Max requests that may be interleaved on a single worker/isolate at once.
  // Async routes (fetch/timers/ws) yield their isolate while awaiting, so
  // several can share one entry; sync routes serialize on it. Default 8.
  maxConcurrentPerEntry?: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  memoryLimitMb: 64,
  timeoutMs: 10000,
  autoInstall: true,
  allowFs: false
};