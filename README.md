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

[`config.json`](config.json) preloads the example apps/routes on first start;
it is mounted into `/app/data/relay-config.json` and written back on every
change made in the UI. Execution logs persist in the `relay_logs` volume.
Remove the config mount to start empty and configure everything from the UI.

Build the image yourself:

```bash
docker build -t relay-server:local .
docker compose up -d   # or: docker run -p 3000:3000 -p 8081:8081 relay-server:local
```

Adjust the ports in `docker-compose.yml` to match the `listenPort` values in
[`config.json`](config.json) for the system server and each app.

> **Note:** the container runs as a non-root user, so it can only write changes
> back to a host-mounted `config.json` if that file is writable by the
> container's UID. If the UI stops persisting edits, make it writable:
> `chmod 666 config.json` (or `chown` it to the container's `relay` UID).

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
