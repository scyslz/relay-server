# Relay Hub — Multi-App Relay Router & Sandbox

Dynamic relay server and management console with JavaScript scriptable routes,
validation, and per-request isolation. Route incoming HTTP requests to any
registered App and run custom handler scripts.

## Features

- **Multi-App Relay Router** — register multiple Apps, each with its own listen
  address, port, and base path, plus scriptable Routes with prefix / exact /
  contains / RegExp matching.
- **JavaScript Route Handlers** — write `async (request, response)` scripts with
  built-in helpers, syntax validation, and live test simulator.
- **Sandboxed Isolation** — each request runs in its own isolated context; errors
  are caught and logged without crashing the server.
- **Execution Logs** — real-time traces, console output, and latency metrics.
- **In-Container URL Templates** — route scripts can reference other Apps/routes
  by name (`${app::route}`) without hardcoding host:port; resolved at save/load.
- **Themes** — Dark Slate / Light Crisp / Midnight Cyber.
- **Persistence** — apps, routes, and logs are persisted to disk and survive restarts.

## Prerequisites

- Node.js (v18+)

## Run Locally

1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`

The admin console is served at `http://localhost:3000`.

## Run with Docker

A prebuilt multi-arch image (amd64 + arm64) is published to
`ghcr.io/scyslz/relay-server` by CI. Run it with Docker Compose:

```bash
docker compose up -d
```

- Admin console / system server: `http://localhost:3000`
- Example app: `http://localhost:8081`
  (both are `$RELAY_PORT`-configurable, default `3000`)

The compose file mounts the `./data` **directory** (not a single file). On
first start the server auto-creates `data/relay-config.json` and
`data/relay-logs.json` and keeps writing them back on every change made in the
UI, so your configuration survives container recreation and repo updates.
`config.json.example` shows the config schema if you want to preload one.

Change the system server port on a fresh setup via an env var (used when no
config file exists yet; once `data/relay-config.json` exists, its
`server.listenPort` wins):

```bash
RELAY_PORT=5000 docker compose up -d
```

> **Permissions:** the entrypoint takes ownership of `/app/data` (the container
> runs the server as the non-root `relay` user, uid 100) so config/logs can be
> written automatically. If you also run the server directly on the host
> against the same `./data` dir, adjust ownership with
> `sudo chown -R $(id -u):$(id -g) data`.

Build the image yourself:

```bash
docker build -t relay-server:local .
docker run -p 3000:3000 -p 8081:8081 relay-server:local
```

## Scripts

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `npm run dev`    | Start the dev server (tsx)                             |
| `npm run build`  | Build the frontend bundle and the Node server          |
| `npm run start`  | Start the production server from `dist/`               |
| `npm run lint`   | Type-check the project (`tsc --noEmit`)                |

## Configuration

Apps, routes, and server settings are stored in `data/relay-config.json`;
execution logs in `data/relay-logs.json`. The system server listens on the
address/port defined by `DEFAULT_SERVER_CONFIG` and is editable via the UI.

HTTP JSON body limit is `10mb` (both the system server and per-App sub-servers).

## In-Container URL Templates

Route scripts run inside the same process/container, so instead of hardcoding
`http://127.0.0.1:8081/auth/token` you can reference Apps and routes by name with
`${app::route}` templates. The server recognizes them itself and resolves them to
concrete URLs when the route is **saved** and **loaded** (never at request time),
so a broken reference fails fast instead of silently hitting a dead URL.

| Template      | Meaning                          | Resolves to                              |
| ------------- | -------------------------------- | ---------------------------------------- |
| `${::a}`      | current App, route `a`           | `<origin>/<route path>`                  |
| `${a}`        | current App, route `a` (alias)   | `<origin>/<route path>`                  |
| `${b::}`      | App `b` base URL                 | `scheme://host:port/basePath`            |
| `${c::d}`     | App `c`, route `d`               | `<origin of c>/<route d path>`           |

- The scheme **prefers http** and falls back to https only when the target App
  exposes https alone.
- `${b::}` looks the App up by **name**; the current-App self-reference
  (`${::a}` / `${a}`) is resolved from the route's own App by id.
- If a `${::...}` template cannot be resolved (unknown App or route), saving is
  rejected and load-time errors are reported in the server log.
- Bare `${a}` tokens are substituted only when `a` matches a route of the current
  App; otherwise they are left untouched so genuine JS template literals
  (`${request.url}`) keep working.

Example — relay a request to the `auth` App's `token` route:

```js
const res = await fetch('${auth::token}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'secret' })
});
const data = await res.json();
response.status(res.status).json(data);
```
