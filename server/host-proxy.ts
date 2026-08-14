import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { Request, Response, NextFunction } from 'express';
import { Socket } from 'net';
import { Server as HttpServer } from 'http';

// Domain-based reverse proxy with full HTTP + WebSocket passthrough.
// Mapping lives in data/host-proxy.json (gitignored):
//   { "1212.sss.com": "http://127.0.0.1:1212", "8080-dsds.sss.com": "http://127.0.0.1:8080" }
// The host header is passed through untouched so upstreams can keep routing
// on it; only the destination port/address changes.
//
// This file ONLY handles the static mapping fallback + a reusable tunnel
// helper. Dynamic route-based bridging (marketing: "ws goes through the route")
// lives in upgrade-proxy.ts, which matches a Route and lets its code decide the
// upstream via host.proxy(...).

const HOST_PROXY_CONFIG_PATH = path.join(process.cwd(), 'data', 'host-proxy.json');

let hostProxyMap: Record<string, string> = {};

export function loadHostProxyConfig(): void {
  try {
    if (fs.existsSync(HOST_PROXY_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HOST_PROXY_CONFIG_PATH, 'utf-8'));
      const next: Record<string, string> = {};
      for (const [host, target] of Object.entries(raw || {})) {
        if (typeof host === 'string' && typeof target === 'string' && /^https?:\/\//i.test(target)) {
          next[host.toLowerCase()] = target;
        }
      }
      hostProxyMap = next;
      console.log(`[Host Proxy] Loaded ${Object.keys(next).length} domain mapping(s) from ${HOST_PROXY_CONFIG_PATH}`);
    } else {
      hostProxyMap = {};
      console.log('[Host Proxy] No domain mapping file found; host proxying disabled.');
    }
  } catch (err: any) {
    hostProxyMap = {};
    console.error('[Host Proxy] Failed to load host-proxy config:', err?.message || err);
  }
}

function getTarget(host?: string): string | null {
  const h = (host || '').split(':')[0].toLowerCase();
  return hostProxyMap[h] || null;
}

export interface TunnelOptions {
  // Full upstream URL to request (target + rewritten path). Defaults to
  // target + req.url when omitted.
  url?: string;
  // Extra/overridden request headers to send upstream. Merged over the
  // inbound request's headers.
  headers?: Record<string, string>;
}

function createProxyReq(url: string, req: IncomingMessage, headers: Record<string, string> | undefined) {
  // Normalize ws/wss to http/https so http(s).request can speak the upgrade.
  const normalized = url
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:');
  const mod = normalized.startsWith('https:') ? https : http;
  return mod.request(normalized, {
    method: req.method,
    headers: headers ? { ...req.headers, ...headers } : { ...req.headers }
  });
}

export function hostProxyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const target = getTarget(req.headers.host);
  if (!target) {
    next();
    return;
  }
  const proxyReq = createProxyReq(target + req.url, req, undefined);
  proxyReq.on('response', (upRes: IncomingMessage) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res as unknown as ServerResponse);
  });
  proxyReq.on('error', (err: Error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Bad Gateway', message: err.message });
    } else {
      res.end();
    }
  });
  (req as unknown as IncomingMessage).pipe(proxyReq);
}

// Establish a bidirectional byte tunnel from the incoming upgrade (or raw)
// connection to `target`. Returns a close() that tears both ends down.
// Used by the static mapping fallback and by route-based bridging alike.
export function openTunnel(target: string, req: IncomingMessage, socket: Socket, head: Buffer, opts?: TunnelOptions): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.destroy(); } catch { /* ignore */ }
    try { proxyReq.destroy(); } catch { /* ignore */ }
  };
  const upstreamUrl = (opts && opts.url) || target + req.url;
  const proxyReq = createProxyReq(upstreamUrl, req, opts && opts.headers);
  proxyReq.on('upgrade', (upRes: IncomingMessage, upSocket: Socket, upHead: Buffer) => {
    if (closed) { try { upSocket.destroy(); } catch {} return; }
    const lines: string[] = [`HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage || ''}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    socket.on('error', () => upSocket.destroy());
    upSocket.on('error', () => socket.destroy());
    socket.on('close', () => { if (!closed) { closed = true; try { upSocket.destroy(); } catch {} } });
    upSocket.on('close', () => { if (!closed) { closed = true; try { socket.destroy(); } catch {} } });
  });
  proxyReq.on('response', (upRes: IncomingMessage) => {
    if (closed) return;
    const lines: string[] = [`HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage || ''}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    upRes.pipe(socket);
    upRes.on('end', () => { if (!closed) { closed = true; try { socket.destroy(); } catch {} } });
  });
  proxyReq.on('error', (err: Error) => {
    if (closed) return;
    socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${err.message || 'Bad Gateway'}`);
    socket.destroy();
    closed = true;
  });
  proxyReq.end(head && head.length ? head : undefined);
  return close;
}

// Static mapping fallback: if the Host is in host-proxy.json, tunnel bytes.
// Returns true when handled (so the caller can skip further handling).
export function staticUpgradeProxy(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
  const target = getTarget(req.headers.host);
  if (!target) {
    return false;
  }
  openTunnel(target, req, socket, head);
  return true;
}

export function attachHostProxyUpgrade(server: HttpServer): void {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (staticUpgradeProxy(req, socket, head)) return;
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
}