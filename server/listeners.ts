import express, { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { generate as generateSelfSignedCert } from 'selfsigned';
import { Server as HttpServer } from 'http';
import { createServer as createNetServer, createConnection as netCreateConnection, Server as NetServer, Socket as NetSocket } from 'net';
import { AppConfig, ServerConfig } from '../src/types';
import { SYSTEM_APP_ID } from '../src/constants';
import { app, state, CRT_DIR, CRT_KEY_PATH, CRT_CERT_PATH } from './state';
import { handleAppRequest } from './gateway';

function checkPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const tester = createNetServer();
    tester.once('error', () => done(false));
    tester.once('listening', () => tester.close(() => done(true)));
    tester.listen(port, host);
    setTimeout(() => {
      try { tester.close(); } catch { /* noop */ }
      done(false);
    }, 2500);
  });
}

function tryBindOnce(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const newServer = app.listen(port, host, () => {
      if (state.httpServer && state.httpServer !== newServer) {
        state.httpServer.close(() => {
          console.log('[Relay Server] Previous listener closed.');
        });
      }
      state.httpServer = newServer;
      console.log(`Relay Server & Web Hub listening on http://${host}:${port}`);
      done(true);
    });
    newServer.once('error', (err: any) => {
      console.error(`[Relay Server] Failed to bind ${host}:${port}:`, err.message);
      try { newServer.close(); } catch { /* noop */ }
      done(false);
    });
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

export async function reListenServer(prevConfig: ServerConfig): Promise<boolean> {
  const host = state.serverConfig.listenHost;
  const port = state.serverConfig.listenPort;
  const samePort = prevConfig.listenPort === port;

  if (!samePort) {
    const available = await checkPortAvailable(host, port);
    if (!available) {
      console.error(`[Relay Server] Port conflict: ${host}:${port} already in use.`);
      return false;
    }
    return bindNewListener(host, port);
  }

  if (state.httpServer) {
    state.httpServer.close(() => {
      console.log('[Relay Server] Previous listener closed.');
    });
  }
  state.httpServer = null;

  if (await bindNewListener(host, port)) {
    return true;
  }

  const restored = await bindNewListener(prevConfig.listenHost, prevConfig.listenPort);
  if (!restored) {
    console.error('[Relay Server] CRITICAL: failed to restore listener after host change. No listener is active.');
  }
  return false;
}

function createAppSubApp(appId: string) {
  const sub = express();
  sub.use(express.json({ limit: '10mb' }));
  sub.use(express.urlencoded({ extended: true, limit: '10mb' }));
  sub.use(async (req: Request, res: Response) => {
    const startMs = Date.now();
    const targetApp = state.appsStore.find(a => a.id === appId);
    if (!targetApp) {
      res.status(503).json({ error: 'App Not Found' });
      return;
    }
    const reqPath = (req.originalUrl || '/').split('?')[0] || '/';
    await handleAppRequest(targetApp, reqPath, reqPath, req, res, startMs);
  });
  return sub;
}

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
    state.appListenStatus.set(appConfig.id, { bound: false, reason: isSystem ? 'system' : 'disabled' });
    return;
  }

  const host = appConfig.listenHost || '0.0.0.0';
  const port = Number(appConfig.listenPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    state.appListenStatus.set(appConfig.id, { bound: false, error: `Invalid listen port "${appConfig.listenPort}"` });
    return;
  }

  if (host === state.serverConfig.listenHost && port === state.serverConfig.listenPort) {
    console.warn(`[App Listener] "${appConfig.name}" skipped: address ${host}:${port} is the system server address.`);
    state.appListenStatus.set(appConfig.id, { bound: false, reason: 'same-as-system', address: `${host}:${port}` });
    return;
  }

  const { server, scheme } = await buildAppListener(appConfig, createAppSubApp(appConfig.id));
  server.listen(port, host, () => {
    state.appListenStatus.set(appConfig.id, { bound: true, address: `${host}:${port}`, scheme });
    console.log(`[App Listener] "${appConfig.name}" listening on ${scheme}://${host}:${port}`);
  });
  server.once('error', (err: any) => {
    state.appListenStatus.set(appConfig.id, { bound: false, error: err.message, address: `${host}:${port}`, scheme });
    console.error(`[App Listener] "${appConfig.name}" failed to bind ${host}:${port}: ${err.message}`);
  });
  state.appListeners.set(appConfig.id, server);
}

function unbindAppListener(appId: string) {
  const existing = state.appListeners.get(appId);
  if (existing) {
    existing.close();
    state.appListeners.delete(appId);
  }
  state.appListenStatus.set(appId, { bound: false, reason: 'disabled' });
}

export async function rebindAllAppListeners() {
  for (const appId of Array.from(state.appListeners.keys())) {
    unbindAppListener(appId);
  }
  await Promise.all(state.appsStore.map(appConfig => bindAppListener(appConfig).catch(err => {
    console.error(`[App Listener] "${appConfig.name}" setup failed: ${err?.message || err}`);
  })));
}

export function getAppListenStatus(app: AppConfig) {
  if (app.isDefault || app.id === SYSTEM_APP_ID) {
    return { state: 'system', bound: true, address: `${state.serverConfig.listenHost}:${state.serverConfig.listenPort}` };
  }
  if (!app.enabled) {
    return { state: 'disabled', bound: false };
  }
  const s = state.appListenStatus.get(app.id);
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
