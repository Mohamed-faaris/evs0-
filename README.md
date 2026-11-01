# EVS0

EVS0 device firmware and monitoring dashboard workspace.

## Dashboard stack
- Frontend: React, TypeScript, Vite, pnpm
- Backend: Hono on Node.js
- Messaging: MQTT.js subscriber
- Authentication: none; read-only dashboards only

## Run locally
```bash
cp .env.example .env
pnpm install
pnpm dev
```
- React dashboard: http://localhost:5173
- Hono API: http://localhost:3002

Configure `MQTT_URL`, `MQTT_USERNAME`, and `MQTT_PASSWORD` using the broker's actual connection details. The dashboard subscribes to the telemetry, state, and availability topics documented in [firmware/mqtt.md](firmware/mqtt.md).

## Dashboard pages
1. Live Monitoring — device presence, MQ-135 ADC/voltage telemetry, and history chart.
2. AI Predictions — model readiness and forecast status.

MQ-135 alone does not provide PM2.5, PM10, or official CPCB AQI. The UI intentionally does not fabricate these values. Prediction outputs remain unavailable until historical training data and a validated model are available.

## Current limitations
- MQTT data is held in API memory; no database persistence yet.
- No AI model is wired yet.
- Broker port and credentials must be verified against the deployed MQTT service.
- No authentication is configured; keep the dashboard read-only.
