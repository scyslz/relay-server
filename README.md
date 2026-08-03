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
2. Configure environment variables (see [.env.example](.env.example)):
   `cp .env.example .env.local`
3. Run the app:
   `npm run dev`

The admin console is served at `http://localhost:3000`.

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
