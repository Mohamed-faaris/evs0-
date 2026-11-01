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

The script sends the configuration to the connected ESP32 at 115200 baud. Firmware v1.1.0 supports verified MQTT-over-TLS connections using the saved broker credentials, automatic reconnect, retained state/availability messages, a retained Last Will, and MQ-135 telemetry publishing every 5 seconds. Serial commands include `mqtt status`, `mqtt diagnose`, and `mqtt reconnect`, plus `mqtt set-server`, `mqtt set-protocol`, `mqtt set-auth`, `mqtt clear-auth`, `mqtt enable`, and `mqtt disable`.

### Arduino IDE firmware dependency

In Arduino IDE, open **Sketch → Include Library → Manage Libraries** and install **MQTT** by Joel Gaehwiler (256dpi), version **2.5.3**. The sketch also uses ArduinoJson, which must be installed through Library Manager. ESP32's `WiFiClientSecure` and `time.h` are supplied by the ESP32 board package.

The firmware synchronizes UTC time using NTP before opening TLS, then verifies the broker certificate against the CA in `emqx_ca.h`. Do not replace certificate verification with `setInsecure()`.

## Firmware version and build timestamp

The firmware version is defined by `FIRMWARE_VERSION` in `firmware/cuspnode_mq135/cuspnode_mq135.ino`. Increment it when publishing a new firmware release. The compiler fills `FIRMWARE_BUILD_DATE` and `FIRMWARE_BUILD_TIME` using Arduino/C++ `__DATE__` and `__TIME__` macros.

The version and build timestamp are printed at boot and in the Serial `status` output. They are also returned by `GET /api/health` under the `firmware` object.

**Timestamp meaning:** this is the local date/time of compilation on the computer that built the sketch. It is not an exact firmware upload/flash timestamp. Arduino firmware cannot determine when it was uploaded unless an upload-time value is explicitly supplied or a trusted clock and persistent first-boot timestamp mechanism are added.

## ESP32 MQTT TLS CA certificate

The ESP32 firmware includes the public CA certificate used to validate the broker's TLS certificate. The PEM file is stored separately from the firmware source and converted into a C++ header before compiling.

Repository files:

```text
firmware/
├── certs/
│   └── emqxsl-ca.crt
├── generate-ca-header.sh
└── cuspnode_mq135/           # Arduino IDE sketch folder
    ├── cuspnode_mq135.ino
    └── emqx_ca.h             # generated; included by the sketch
```

The committed `firmware/certs/emqxsl-ca.crt` is now DigiCert Global Root CA (not G2), matching EMQX's Serverless ESP32 connection example. It expires on 2031-11-10. EMQX Serverless requires the CA supplied on the deployment Overview page; if your console's downloaded CA differs, use that deployment-specific file as the source of truth and regenerate the header.

Generate or refresh the header from the repository root:

```bash
chmod +x firmware/generate-ca-header.sh
./firmware/generate-ca-header.sh
```

The generated header defines `EMQX_ROOT_CA` in flash (`PROGMEM`) and is included by `firmware/cuspnode_mq135/cuspnode_mq135.ino`. Open that `.ino` file directly in Arduino IDE; the sketch folder and `.ino` filename intentionally match. Re-run the generator whenever the PEM file changes, then compile and flash the firmware again.

**Security:** It is safe to commit this CA certificate and generated header. Never commit `.env`, MQTT passwords, Wi-Fi passwords, client private keys, or other credentials. The CA certificate is not a credential and does not replace MQTT username/password authentication.

**Firmware status:** Firmware v1.1.0 includes the MQTT client implementation. It synchronizes time over NTP, validates the broker certificate using the embedded CA, authenticates with credentials stored in NVS, publishes telemetry/state/availability, and retries after connection loss. A successful build and live broker connection still need to be confirmed on the physical ESP32.

## MQTT protocol

See [firmware/mqtt.md](firmware/mqtt.md) for topics, payload schemas, QoS/retain recommendations, and implementation status.
