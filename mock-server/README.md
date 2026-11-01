# CuspNode Node.js Mock Server

A simulated ESP32 MQ-135 device with a real MQTT client. Use it to exercise the broker and dashboard data flow without a physical ESP32 or MQ-135.

## Requirements

- Node.js 18 or newer
- pnpm 10 (repository package manager)

## Configure environment

The server loads the root `.env` file regardless of the directory from which it is started.

From the repository root:

```bash
cp .env.example .env
```

Configure the MQTT variables in the root `.env`:

```dotenv
HOST=127.0.0.1
PORT=3001

MQTT_HOST=c1a1d217.ala.us-east-1.emqxsl.com
MQTT_PROTOCOL=mqtts
MQTT_PORT=8883
MQTT_USERNAME=your_emqx_username
MQTT_PASSWORD=your_emqx_password
MQTT_TOPIC_ROOT=evs/v1/devices
DEVICE_ID=device-001

MQTT_MOCK_CLIENT_ID=cuspnode-mock-device-001
MQTT_PUBLISH_INTERVAL_MS=5000
MQTT_RECONNECT_PERIOD_MS=3000
MQTT_KEEPALIVE_SECONDS=60
MQTT_CLEAN_SESSION=true
# Optional: only set this if you need a custom CA bundle.
# MQTT_CA_PATH=firmware/certs/emqxsl-ca.crt
```

Do not commit your real `.env` or broker credentials. TLS certificate verification is enabled; the client does not disable certificate validation.

## Install and run

From the repository root:

```bash
pnpm install
pnpm dev:mock
```

Or run the mock server directly:

```bash
pnpm --filter cuspnode-mock-server dev
```

Default URL: http://127.0.0.1:3001

Set `HOST=0.0.0.0` only when you need to access the HTTP mock page from another device on your LAN.

## MQTT behaviour

The mock server uses MQTT.js and connects to the configured broker over TLS when `MQTT_PROTOCOL=mqtts`.

For `device-001`, it uses these topics:

| Direction | Topic | QoS | Retained |
|---|---|---:|---:|
| Publish | `evs/v1/devices/device-001/telemetry` | 1 | No |
| Publish | `evs/v1/devices/device-001/state` | 1 | Yes |
| Publish / LWT | `evs/v1/devices/device-001/availability` | 1 | Yes |
| Subscribe | `evs/v1/devices/device-001/command` | 1 | No |
| Publish | `evs/v1/devices/device-001/command/ack` | 1 | No |

- Publishes a simulated telemetry packet immediately after connecting, then every 5 seconds by default.
- Publishes retained state and online availability on connect.
- Configures an offline Last Will with retain enabled.
- Subscribes to the command topic. Commands are deliberately rejected with an acknowledgement; the mock does not execute remote actions or change credentials.
- Reconnects automatically after transient broker/network failures.
- Uses a separate client ID (`cuspnode-mock-device-001` by default) so it does not collide with the physical ESP32 client ID.

Make sure the EMQX authorization rules allow the configured username to publish to its device's telemetry, state, availability and command acknowledgement topics, and subscribe to its command topic. Authentication alone does not grant topic permissions.

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Mock device portal |
| GET | `/api/health` | Simulated device status plus real MQTT connection status |
| GET | `/api/mq135` | Simulated MQ-135 reading |
| GET | `/api/mqtt` | MQTT configuration, connection and topic status |
| GET | `/api/wifi` | Saved mock Wi-Fi SSIDs |
| GET | `/api/wifi/scan` | Simulated nearby Wi-Fi networks |
| POST | `/api/wifi/add` | Add/update a mock saved network |
| POST | `/api/wifi/remove` | Remove a mock saved network |

Example:

```bash
curl http://127.0.0.1:3001/api/mqtt
```

## Mock limitations

- Sensor values are generated demo data, not physical measurements. PPM remains `null`; no gas concentration calibration is implemented.
- Wi-Fi, hotspot IP and client counts are simulated. The server does not connect to a router or an ESP32.
- Saved Wi-Fi entries are in memory and reset when the mock server restarts. Passwords are not returned by the HTTP API.
- MQTT is a real broker connection when configured. An MQTT connected status confirms the broker session, not the accuracy of the simulated sensor data.
- CORS is open for local frontend development. Do not expose this mock server to untrusted networks.
- Commands are acknowledged as rejected because the mock device has no actuation or remote configuration behaviour.
