# EVS0

EVS0 device firmware and monitoring dashboard workspace, orchestrated with **pnpm + Turborepo**.

## Workspace

| Package | Path | Purpose |
|---|---|---|
| `@evs0/api` | `apps/api` | Hono API and MQTT subscriber |
| `@evs0/web` | `apps/web` | React + TypeScript + Vite dashboard |
| `cuspnode-mock-server` | `mock-server` | Node.js mock HTTP server |

Turborepo runs tasks across the workspace from the repository root. The root `dev` command starts all three development servers in parallel.

## First-time setup

Node.js 20+ and pnpm 10+ are recommended.

```bash
corepack enable
pnpm install
cp .env.example .env
```

Fill in the MQTT broker connection details in `.env`. Do not guess the broker port or WebSocket path; use the values configured by the broker administrator.

## Run everything

```bash
pnpm dev
```

This starts:
- Dashboard: http://localhost:5173
- Hono API: http://localhost:3002
- Mock HTTP server: http://localhost:3001

Stop all development processes with `Ctrl+C`.

## Run individual services

```bash
pnpm dev:dashboard  # React dashboard + Hono API
pnpm dev:api        # Hono API only
pnpm dev:web        # Vite frontend only
pnpm dev:mock       # Mock HTTP server only
```

Production/build commands:

```bash
pnpm build
pnpm typecheck
pnpm start:api
pnpm start:mock
```

## Dashboard stack

- Frontend: React, TypeScript, Vite
- Backend: Hono on Node.js
- Messaging: MQTT.js subscriber
- Orchestration: pnpm workspaces + Turborepo
- Authentication: none; dashboard APIs are read-only

The API subscribes to the telemetry, state, and availability topics documented in [firmware/mqtt.md](firmware/mqtt.md). It does not subscribe to command topics or publish device commands.

## Dashboard pages

1. **Live Monitoring** — device presence, MQ-135 ADC/voltage telemetry, and history chart.
2. **AI Predictions** — model readiness and forecast status.

MQ-135 alone does not provide PM2.5, PM10, or official CPCB AQI. The UI intentionally does not fabricate these values. Prediction outputs remain unavailable until historical training data and a validated model are available.

## Current limitations

- MQTT data is held in API memory; no database persistence yet.
- No AI model is wired yet.
- Broker connection details must be verified against the deployed MQTT service.
- No authentication is configured; keep the dashboard read-only.


## Provision MQTT settings to an ESP32

The firmware stores the MQTT broker endpoint, protocol, username, password, and enabled flag in ESP32 Preferences (NVS). Use the TypeScript provisioning utility to load the repository-root `.env` and send those settings over USB serial. This avoids editing firmware constants for credential changes.

1. Add the USB serial device path to the root `.env`, for example `ESP32_PORT=/dev/ttyUSB0`.
2. Set `MQTT_HOST`, `MQTT_PROTOCOL`, `MQTT_PORT`, `MQTT_USERNAME`, and `MQTT_PASSWORD` in the same file. Use the exact broker port supplied by the broker administrator.
3. Close Arduino IDE Serial Monitor (only one process can own the serial port).
4. Run from the repository root:

```bash
pnpm install
pnpm device:provision:mqtt
# or specify the serial port directly:
pnpm device:provision:mqtt -- --port /dev/ttyUSB0
```

The script sends the configuration to the connected ESP32 at 115200 baud. The firmware CLI also supports `mqtt status`, `mqtt set-server`, `mqtt set-protocol`, `mqtt set-auth`, `mqtt clear-auth`, `mqtt enable`, and `mqtt disable`.

**Current scope:** this adds persistent MQTT configuration/provisioning only. MQTT transport, TLS certificate validation, telemetry publishing, and broker reconnect handling are not implemented in the ESP32 firmware yet. The dashboard API's MQTT subscriber is separate.
