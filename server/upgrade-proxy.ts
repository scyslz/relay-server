import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { Server as HttpServer } from 'http';
import { Route } from '../shared/types';
import { state } from './state';
import { getSystemApp } from './config';
import { matchAppRoute } from './gateway';
import { getEngineForRoute } from './engine-manager';
import { openTunnel, staticUpgradeProxy } from './host-proxy';

// Dynamic inbound bridge. A WS/HTTP upgrade request is matched against the
// enabled routes (host/path/method), then the route CODE runs inside the
// sandbox and decides the upstream via host.proxy(target). The engine returns
// that decision and the host establishes the real tunnel. The tunnel is
// registered under the route id so route lifecycle changes (update/delete/
// disable) tear it down — "route closes ⇒ real network disconnects".
//
// Requests that match no route fall back to the static host-proxy mapping.

function matchUpgradeRoute(req: IncomingMessage): { route: Route; params: Record<string, string> } | null {
  const reqPath = (req.url || '/').split('?')[0] || '/';
  const rawHost = req.headers.host || req.headers['x-forwarded-host'] || 'localhost';
  const reqHost = Array.isArray(rawHost) ? rawHost[0] : String(rawHost);
  const method = 'GET';

  const apps = [
    ...state.appsStore.filter(a => a.enabled && !a.isDefault),
    getSystemApp()
  ];
  for (const targetApp of apps) {
    const matched = matchAppRoute(targetApp, reqPath, reqHost, method);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function writeHttpToSocket(socket: Socket, status: number, headers: Record<string, string> | undefined, body: any): void {
  const payload = body === null || body === undefined ? '' : String(body);
  const lines: string[] = [`HTTP/1.1 ${status} ${statusText(status)}`];
  const hdrs = headers || { 'Content-Type': 'text/plain' };
  for (const [k, v] of Object.entries(hdrs)) lines.push(`${k}: ${v}`);
  lines.push('Connection: close');
  lines.push(`Content-Length: ${Buffer.byteLength(payload)}`);
  lines.push('');
  lines.push(payload);
  socket.write(lines.join('\r\n'));
  socket.destroy();
}

function statusText(status: number): string {
  const map: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 504: 'Gateway Timeout' };
  return map[status] || 'Unknown';
}

export function attachUpgradeBridge(server: HttpServer): void {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const matched = matchUpgradeRoute(req);
    if (!matched) {
      // Static mapping fallback (from host-proxy.json), then 404.
      if (staticUpgradeProxy(req, socket, head)) return;
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const route = matched.route;
    void (async () => {
      const engine = await getEngineForRoute(route);
      if (!engine || !engine.executeBridge) {
        writeHttpToSocket(socket, 502, { 'Content-Type': 'text/plain' }, 'route engine cannot bridge this connection');
        return;
      }
      const reqInfo = {
        method: 'GET',
        url: req.url || '/',
        path: (req.url || '/').split('?')[0] || '/',
        query: {},
        headers: (req.headers as Record<string, string>) || {},
        host: req.headers.host || 'localhost',
        ip: '',
        params: matched.params
      };
      let decision;
      try {
        decision = await engine.executeBridge(route, reqInfo);
      } catch (err: any) {
        writeHttpToSocket(socket, 502, { 'Content-Type': 'text/plain' }, `bridge error: ${err.message}`);
        return;
      }

      if (decision.proxied && decision.target) {
        const close = openTunnel(decision.target, req, socket, head, {
          url: decision.url,
          headers: decision.requestHeaders
        });
        if (engine.registerBridge) {
          const bridgeId = engine.registerBridge(route.id, close);
          // When the tunnel ends on its own, drop the registration so stale
          // close hooks don't accumulate against the route.
          socket.on('close', () => { if (engine.unregisterBridge) engine.unregisterBridge(bridgeId); });
        }
        return;
      }
      writeHttpToSocket(socket, decision.statusCode || 502, decision.responseHeaders, decision.body);
    })().catch((err: any) => {
      writeHttpToSocket(socket, 502, { 'Content-Type': 'text/plain' }, `bridge dispatch error: ${err.message}`);
    });
  });
}