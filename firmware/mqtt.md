# CuspNode MQTT Topic and Payload Specification

This document defines the MQTT topic names and JSON payload structures for the EVS MQ-135 device. Firmware v1.1.0 implements MQTT 3.1.1 over verified TLS, authentication using ESP32 NVS credentials, automatic reconnect, Last Will availability, retained state, and periodic telemetry publishing.

## Broker

| Setting | Value |
|---|---|
| Hostname | Configured in ESP32 NVS (current test deployment: `c1a1d217.ala.us-east-1.emqxsl.com`) |
| Device ID | `device-001` (current firmware default; make unique per physical device) |
| Topic root | `evs/v1/devices/{device_id}` |
| Payload format | JSON, UTF-8 |
| Transport | MQTT over TLS (`mqtts`) |

The current test deployment uses TLS TCP port `8883`. EMQX Serverless supports MQTT over TLS on port 8883; WebSocket TLS on 8084 is not implemented in this firmware. Credentials are provisioned to ESP32 NVS and must not be committed to this repository.

## Topic layout

Replace `{device_id}` with the unique device identifier, for example `device-001`.

| Topic | Direction | Retain | Purpose |
|---|---|---:|---|
| `evs/v1/devices/{device_id}/telemetry` | Device → broker | No | Periodic MQ-135 measurements |
| `evs/v1/devices/{device_id}/state` | Device → broker | Yes | Current device/network/sensor state |
| `evs/v1/devices/{device_id}/availability` | Device → broker | Yes | Online/offline presence (Last Will) |
| `evs/v1/devices/{device_id}/command` | Broker → device | No | Future device commands |
| `evs/v1/devices/{device_id}/command/ack` | Device → broker | No | Result of a received command |

### Telemetry

Publish to:

```text
evs/v1/devices/device-001/telemetry
```

Example payload:

```json
{
  "schema_version": 1,
  "device_id": "device-001",
  "sensor": "MQ-135",
  "timestamp": null,
  "uptime_seconds": 120,
  "sequence": 42,
  "readings": {
    "raw_adc": 1850,
    "adc_pin_voltage_v": 1.49,
    "sensor_ao_voltage_v": 2.235,
    "ppm": null
  },
  "valid": true
}
```

Field definitions:

| Field | Type | Description |
|---|---|---|
| `schema_version` | integer | Payload schema version |
| `device_id` | string | Stable unique device identifier |
| `sensor` | string | Sensor model, currently `MQ-135` |
| `timestamp` | string/null | UTC ISO-8601 timestamp when time is available; otherwise `null` |
| `uptime_seconds` | integer | Seconds since device boot |
| `sequence` | integer | Incrementing telemetry counter; resets on reboot |
| `readings.raw_adc` | integer | ESP32 ADC reading (12-bit range, nominally 0–4095) |
| `readings.adc_pin_voltage_v` | number | Voltage measured at the ESP32 ADC pin |
| `readings.sensor_ao_voltage_v` | number | Estimated MQ-135 module AO voltage; only valid when the configured divider ratio is correct |
| `readings.ppm` | number/null | Calibrated concentration only; keep `null` until gas-specific calibration is implemented |
| `valid` | boolean | Basic reading validity flag; not a calibration or sensor-health certification |

The voltage example assumes the divider documented in `README.md`. Values are illustrative, not calibration references. Do not label raw ADC values as ppm or AQI.

### Device state

Publish to:

```text
evs/v1/devices/device-001/state
```

Example payload:

```json
{
  "schema_version": 1,
  "device_id": "device-001",
  "state": "WIFI_CONNECTED",
  "uptime_seconds": 120,
  "network": {
    "wifi_connected": true,
    "wifi_ssid": "HomeWiFi",
    "hotspot_active": true
  },
  "sensor": {
    "model": "MQ-135",
    "valid": true
  },
  "mqtt": {
    "connected": true
  }
}
```

Recommended state values:

- `BOOTING`
- `WIFI_SCANNING`
- `WIFI_CONNECTING`
- `WIFI_CONNECTED`
- `NO_WIFI`
- `SENSOR_ERROR`

Publish state when a meaningful state or relevant status field changes. The firmware publishes state when the device state changes and after each successful MQTT reconnect.

### Availability / Last Will

Topic:

```text
evs/v1/devices/device-001/availability
```

Online payload:

```json
{
  "device_id": "device-001",
  "status": "online"
}
```

Offline Last Will payload:

```json
{
  "device_id": "device-001",
  "status": "offline"
}
```

Configure the MQTT Last Will and Testament (LWT) to publish the offline payload to the availability topic with retain enabled. After a successful connection, publish the online payload with retain enabled. This allows subscribers to learn the most recently known presence state.

### Command topic (future use)

Subscribe to:

```text
evs/v1/devices/device-001/command
```

Example request:

```json
{
  "command_id": "cmd-0001",
  "action": "publish_interval",
  "value": 5000
}
```

Example acknowledgement:

```text
evs/v1/devices/device-001/command/ack
```

```json
{
  "command_id": "cmd-0001",
  "status": "rejected",
  "message": "Remote configuration is not implemented"
}
```

Commands are reserved for a later firmware milestone. Do not accept arbitrary commands or remote Wi-Fi credential changes until authentication, authorization, validation, and safe command handling are implemented.

## Suggested MQTT delivery behaviour

| Message | QoS | Retain |
|---|---:|---:|
| Telemetry | 0 or 1 | No |
| State | 1 | Yes |
| Availability | 1 | Yes |
| Command | 1 | No |
| Command acknowledgement | 1 | No |

Firmware v1.1.0 uses QoS 1 for telemetry, state, and online availability. QoS 1 can deliver duplicates, so consumers should tolerate repeated sequence numbers/message IDs. The offline Last Will is configured at QoS 1 with retain enabled.

## Security and operational notes

- Use TLS and validate the broker certificate.
- Store MQTT credentials in device provisioning/NVS, not in source code.
- Give each device its own identity and credentials.
- Apply broker ACLs so a device can publish only to its own telemetry/state/availability/ack topics and subscribe only to its own command topic.
- Never publish Wi-Fi passwords, hotspot passwords, access tokens, or other secrets.
- Avoid publishing the local hotspot password or other sensitive network configuration.
- Use a unique `device_id` for every physical node before deploying multiple devices.
- Synchronize time (for example, using NTP) before publishing UTC timestamps. Until time is available, send `timestamp: null` and retain `uptime_seconds`.

## Firmware library dependency

Install **MQTT** by Joel Gaehwiler (256dpi), version **2.5.3**, through Arduino IDE Library Manager. The ESP32 board package supplies `WiFiClientSecure` and the NTP/time functions. ArduinoJson is also required by the existing HTTP API and MQTT JSON payloads.

## Firmware metadata

The ESP32 firmware defines a manually maintained `FIRMWARE_VERSION` and compiler-generated `FIRMWARE_BUILD_DATE`/`FIRMWARE_BUILD_TIME` values. They are printed at startup and in Serial status output, and exposed by `GET /api/health` as `firmware.version`, `firmware.build_date`, and `firmware.build_time`. The build timestamp represents compile time, not the exact flash/upload time.

## TLS CA certificate

The public CA certificate is stored at `firmware/certs/emqxsl-ca.crt` and generated into `firmware/cuspnode_mq135/emqx_ca.h` by running `./firmware/generate-ca-header.sh` from the repository root. The firmware includes this header, which defines `EMQX_ROOT_CA` in program memory. The supplied certificate identifies as DigiCert Global Root G2 and expires on 2038-01-15. Confirm that the live EMQX broker certificate chain terminates at this root before enabling TLS. The certificate is public trust material; do not put MQTT passwords or private keys in the repository.

The firmware uses `WiFiClientSecure` with `setCACert(EMQX_ROOT_CA)`. It does not call `setInsecure()`. It synchronizes UTC time with NTP before connecting, because certificate validity dates must be checked against a valid device clock. If TLS validation fails, inspect the Serial TLS error and download the CA certificate from the EMQX deployment Overview page if the broker's certificate chain has changed.

## Implementation status

| Capability | Status |
|---|---|
| Topic and payload specification | Documented here |
| MQTT broker settings in ESP32 NVS | Implemented (Serial CLI + TypeScript provisioner) |
| CA certificate PEM and generated firmware header | Embedded; live TLS validation not yet exercised |
| MQTT connection to configured broker | Implemented: MQTT 3.1.1 over verified TLS |
| Telemetry publishing | Implemented: QoS 1 every 5 seconds |
| State publishing | Implemented: retained QoS 1 on state change/reconnect |
| Availability / LWT | Implemented: retained QoS 1 online + offline Last Will |
| Command subscription and acknowledgement | Reserved; not implemented |

The firmware exposes local HTTP data at `/api/mq135` and live MQTT status at `/api/health`. MQTT broker settings are stored in ESP32 Preferences/NVS and can be provisioned using the Serial CLI or `pnpm device:provision:mqtt`. The firmware retries MQTT connections every 5 seconds. Use Serial `mqtt status` to inspect the actual session, `mqtt diagnose` to inspect DNS/TCP/NTP/TLS/MQTT status, and `mqtt reconnect` to force a new connection attempt.
