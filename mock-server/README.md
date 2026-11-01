# CuspNode Node.js Mock Server

Standalone Node.js mock of the ESP32 CuspNode MQ-135 HTTP API. Use it to develop and test a frontend without the physical ESP32 or MQ-135.

## Requirements

- Node.js 18 or newer
- No npm dependencies

## Run

From this directory:

```bash
npm run dev
```

Or use `npm start`.

Default URL: http://127.0.0.1:3001

Override host and port:

```bash
HOST=0.0.0.0 PORT=3001 npm start
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Mock device status page |
| GET | `/api/health` | Device, Wi-Fi, hotspot, sensor and MQTT status |
| GET | `/api/mq135` | Simulated MQ-135 reading |
| GET | `/api/wifi` | Saved Wi-Fi SSIDs |
| GET | `/api/wifi/scan` | Simulated nearby Wi-Fi networks |
| POST | `/api/wifi/add` | Add/update a saved network |
| POST | `/api/wifi/remove` | Remove a saved network |

POST bodies match the firmware API:

```bash
curl -X POST http://127.0.0.1:3001/api/wifi/add \
  -H 'Content-Type: application/json' \
  -d '{"ssid":"TestNetwork","password":"test-password"}'
```

```bash
curl -X POST http://127.0.0.1:3001/api/wifi/remove \
  -H 'Content-Type: application/json' \
  -d '{"ssid":"TestNetwork"}'
```

## Frontend integration

Set your frontend API base URL to `http://127.0.0.1:3001`.

If the frontend runs on another device, start with `HOST=0.0.0.0` and use the development machine's LAN IP instead of 127.0.0.1.

## Mock limitations

- Sensor values are generated demo data, not actual measurements. PPM and AQI are not calculated.
- Wi-Fi scan results are fixed examples.
- Wi-Fi additions/removals are in memory and reset when the server restarts.
- Wi-Fi connectivity is simulated; this server does not connect to a router or ESP32.
- CORS is open for local frontend development. Do not expose this mock server to untrusted networks.
- The firmware's ESP32-hotspot-client restriction is not enforced, so local frontend testing can call add/remove.
