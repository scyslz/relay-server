import express from 'express';
import path from 'path';
import { Server as HttpServer } from 'http';
import { Server as NetServer } from 'net';
import { AppConfig, ServerConfig, Route, ExecutionLog } from '../src/types';
import { DEFAULT_SERVER_CONFIG } from '../src/constants';

export const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

export const CONFIG_FILE_PATH = path.join(process.cwd(), 'data', 'relay-config.json');
export const LOG_FILE_PATH = path.join(process.cwd(), 'data', 'relay-logs.json');
export const CRT_DIR = path.join(process.cwd(), 'data', 'crt');
export const CRT_KEY_PATH = path.join(CRT_DIR, 'key.pem');
export const CRT_CERT_PATH = path.join(CRT_DIR, 'cert.pem');
export const ROUTE_MODULES_DIR = path.join(process.cwd(), 'data', 'route-modules');
export const ROUTE_SCRIPTS_DIR = path.join(ROUTE_MODULES_DIR, 'scripts');

export const AUTO_INSTALL_ENABLED = process.env.RELAY_AUTO_INSTALL !== 'false';

export const MAX_LOG_ENTRIES = 2000;
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOGS_LIMIT = 200;
export const ROUTE_MODULE_CLEAN_INTERVAL_MS = 60 * 1000;

export const state = {
  serverConfig: { ...DEFAULT_SERVER_CONFIG } as ServerConfig,
  httpServer: null as HttpServer | null,
  appsStore: [] as AppConfig[],
  routesStore: [] as Route[],
  executionLogs: [] as ExecutionLog[],
  retainedLogBytes: 0,
  logPersistTimer: null as NodeJS.Timeout | null,
  activeEngine: null as ReturnType<typeof import('./engine').createEngine> | null,
  residentEngineKind: 'isolatedvm' as 'process' | 'isolatedvm',
  secondaryEngine: null as ReturnType<typeof import('./engine').createEngine> | null,
  secondaryEngineKind: null as ('process' | 'isolatedvm') | null,
  secondaryEngineLastUsed: 0,
  secondaryEngineIdleTimer: null as NodeJS.Timeout | null,
  appListeners: new Map<string, NetServer>(),
  appListenStatus: new Map<string, { bound: boolean; address?: string; scheme?: string; error?: string; reason?: string }>(),
};

if (process.env.RELAY_TLS_INSECURE === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[TLS] RELAY_TLS_INSECURE=true — outbound HTTPS certificate verification is DISABLED for route scripts.');
}
