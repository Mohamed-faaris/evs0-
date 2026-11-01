# EVS0 Hono API

Hono subscribes to the EVS0 MQTT device protocol documented in `firmware/mqtt.md` and exposes read-only dashboard endpoints.

## MQTT connection

Copy the repository-root `.env.example` to `.env`. Configure `MQTT_PROTOCOL` (`mqtts` or `wss`), `MQTT_HOST`, the broker's actual `MQTT_PORT`, and `MQTT_PATH` if using WSS. Alternatively set `MQTT_URL` as a complete URL; it takes precedence over the individual connection settings. The broker port, WebSocket path, and credentials are intentionally not guessed.

The API subscribes with QoS 1 to:
- `${MQTT_TOPIC_ROOT}/{device_id}/telemetry`
- `${MQTT_TOPIC_ROOT}/{device_id}/state`
- `${MQTT_TOPIC_ROOT}/{device_id}/availability`

The default topic root is `evs/v1/devices`, matching `firmware/mqtt.md`. Telemetry payloads must use schema version 1 and include the same `device_id` as the topic. State and availability payloads are retained by the device; the API consumes the broker's retained values on subscription. Availability accepts `online` and `offline`.

The API does not subscribe to the future `command` topic and does not publish commands. This is a read-only dashboard.

## Routes
- `GET /api/health` — API and MQTT connection status.
- `GET /api/devices` — device state, availability, and latest telemetry.
- `GET /api/readings/latest`
- `GET /api/readings/history?limit=100&device_id=device-001`
- `GET /api/aqi/current` — explicitly unavailable until suitable calibrated pollutant measurements exist.
- `GET /api/aqi/predictions` — explicitly unavailable until a validated model is configured.

Readings are currently held in memory and are lost when the API restarts. No authentication is implemented, as this is a public read-only dashboard API. Do not expose broker credentials in frontend environment variables.