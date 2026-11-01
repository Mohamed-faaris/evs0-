# EVS0 Hono API

Hono subscribes to device telemetry from MQTT and exposes read-only dashboard endpoints.

## Environment
Copy the repository-root `.env.example` to `.env`. Set the MQTT URL, port, and broker credentials to the values configured on the broker. The example TLS port is a placeholder; verify it with the broker administrator.

## Topics
- `evs/v1/devices/+/telemetry`
- `evs/v1/devices/+/state`
- `evs/v1/devices/+/availability`

## Routes
- `GET /api/health`
- `GET /api/devices`
- `GET /api/readings/latest`
- `GET /api/readings/history?limit=100&device_id=device-001`
- `GET /api/aqi/current` — explicitly unavailable until suitable calibrated pollutant measurements exist.
- `GET /api/aqi/predictions` — explicitly unavailable until a validated model is configured.

Readings are currently held in memory and are lost when the API restarts. No authentication is implemented, as this is a public read-only dashboard API. Do not add write/control routes without a separate security review.
