# CuspNode MQ-135 Firmware

Single-file Arduino firmware for ESP32 DevKit + MQ-135.

## Features

- Simultaneous Wi-Fi AP + Station mode.
- Local setup hotspot stays active while the ESP32 connects to a router.
- Up to 10 saved Wi-Fi networks stored in ESP32 NVS flash.
- First boot seeds SSID `Faaris` with a **blank password placeholder**.
- Automatic selection of the strongest visible saved SSID.
- HTTP health, sensor, Wi-Fi list, scan, add and remove endpoints.
- Non-blocking LED patterns and state-change-only Serial logging.
- BOOT button prints the current status snapshot.
- Raw ADC and voltage telemetry only; no unsupported ppm/AQI estimate.

## Files

- `cuspnode_mq135.ino` — complete firmware.

## Default configuration

| Setting | Value |
|---|---|
| Device ID | `device-001` |
| Default Wi-Fi SSID | `Faaris` |
| Default Wi-Fi password | **Blank placeholder; configure locally** |
| Hotspot SSID | `cuspnode-mq135` |
| Hotspot password | `31053105` |
| Hotspot IP | `192.168.4.1` |
| HTTP port | `80` |
| Maximum saved Wi-Fi entries | 10 |

The hotspot password is intentionally a constant at the top of the sketch.
Change `HOTSPOT_PASSWORD` there before using it in an untrusted environment.

The personal Wi-Fi password is not stored in source code or this repository.
On first boot, the SSID `Faaris` is added with an empty password. Add/update
its real password through the portal or Serial command. Credentials are saved
in ESP32 NVS and survive power loss.

## Hardware wiring

| MQ-135 module | ESP32 |
|---|---|
| VCC | Stable 5 V supply |
| GND | GND |
| AO | GPIO34 through voltage divider |
| DO | Not used |

**ADC safety:** Do not connect a 5 V analog output directly to ESP32 GPIO34.
For the assumed divider, connect module AO through 10 kΩ to GPIO34, then 20 kΩ
from GPIO34 to GND. This scales 5 V to about 3.33 V. Verify the module's actual
AO voltage with a multimeter. Share ground. GPIO34 is ADC1 and input-only.

The MQ-135 heater needs a stable 5 V supply with sufficient current. Allow
preheating and calibration before interpreting gas readings. This firmware
reports raw ADC and voltage only; it does not calculate calibrated ppm or AQI.

## Install and upload

1. Install Arduino IDE 2.x.
2. Install Espressif ESP32 board support.
3. Install **ArduinoJson** (v6 API compatible).
4. Open `cuspnode_mq135.ino`.
5. Select your ESP32 DevKit board and serial port.
6. Upload and open Serial Monitor at **115200 baud**, line ending **Newline**.

## AP + STA behaviour

The firmware runs `WIFI_AP_STA`:

- **STA:** joins one of the saved router networks for internet access.
- **AP:** exposes a local configuration hotspot at the same time.
- If the router is unavailable, the hotspot remains active.
- AP and STA share the ESP32's single 2.4 GHz radio and generally share a
  channel. A router channel change may briefly disconnect hotspot clients.

Connect to:

- SSID: `cuspnode-mq135`
- Password: `31053105`
- Portal: http://192.168.4.1/

## LED status

| State | LED pattern | Meaning |
|---|---|---|
| BOOTING | ON for 1 second, then off | Startup |
| WIFI_SCANNING | Two fast flashes | Search for saved SSIDs |
| WIFI_CONNECTING | Two short flashes | Joining router |
| WIFI_CONNECTED | Three short flashes | Station joined to Wi-Fi |
| NO_WIFI | Continuous fast blink | No saved network visible / disconnected |
| SENSOR_ERROR | One long + one short flash | ADC reading at/near rail |

The LED is updated without delay-based blink loops. State changes are logged
once to Serial; there is no repeated state log flooding.

GPIO2 and active-high LED are common but not universal. Verify your DevKit
revision. Change `LED_PIN` or `LED_ACTIVE_LOW` at the top if required.

## Button

The BOOT button is commonly GPIO0 and active LOW. Press once to print the
full status report to Serial. GPIO0 is also a boot-strapping pin: do not hold
it during reset/power-on unless you intend to enter the ROM download mode.

## Serial CLI

Serial Monitor: 115200 baud, Newline line ending.

| Command | Action |
|---|---|
| `help` | List commands |
| `status` | Print complete device health snapshot |
| `device info` | Chip, cores, flash and free heap |
| `wifi list` | List saved SSIDs; never prints passwords |
| `wifi scan` | Scan nearby access points |
| `wifi add <SSID> <PASSWORD>` | Add/update saved entry |
| `wifi remove <SSID>` | Remove saved entry |
| `wifi reconnect` | Retry saved networks |
| `sensor` / `sensor read` | Read sensor immediately |
| `ap status` | Show hotspot IP and client count |

Example:

```text
wifi add HomeRouter my-password
wifi list
wifi remove HomeRouter
wifi reconnect
status
```

Serial add/remove commands expect SSIDs without spaces. The HTTP JSON API
supports SSIDs containing spaces.

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/` | Minimal status/configuration page |
| GET | `/api/health` | Device, Wi-Fi, hotspot and sensor status |
| GET | `/api/mq135` | Latest MQ-135 readings |
| GET | `/api/wifi` | Saved SSIDs; passwords omitted |
| GET | `/api/wifi/scan` | Nearby SSIDs and RSSI |
| POST | `/api/wifi/add` | Add/update Wi-Fi credential |
| POST | `/api/wifi/remove` | Remove saved Wi-Fi entry |

Add network:

```bash
curl -X POST http://192.168.4.1/api/wifi/add \
  -H 'Content-Type: application/json' \
  -d '{"ssid":"HomeRouter","password":"replace-me"}'
```

Remove network:

```bash
curl -X POST http://192.168.4.1/api/wifi/remove \
  -H 'Content-Type: application/json' \
  -d '{"ssid":"HomeRouter"}'
```

The add/remove endpoints are restricted to clients whose remote IP belongs
to the ESP32 AP subnet (192.168.4.0/24). Do not expose them to the public
internet. The local AP uses a shared WPA2 key; use a unique key in deployments
and only connect trusted devices.

## API example

`GET /api/mq135`:

```json
{
  "status": "ok",
  "device_id": "device-001",
  "sensor": "MQ-135",
  "raw_adc": 1850,
  "adc_pin_voltage_v": 1.49,
  "estimated_sensor_ao_voltage_v": 2.235,
  "ppm": null,
  "uptime_seconds": 120
}
```

Values are illustrative. Estimated AO voltage assumes the 10 kΩ / 20 kΩ
divider described above.

## Current scope

Implemented:
- AP+STA Wi-Fi operation and persistent Wi-Fi list management.
- HTTP portal and JSON APIs.
- Serial CLI and button-triggered status reporting.
- LED status and transition-only logs.
- MQ-135 raw ADC/voltage reading.

Not implemented yet:
- MQTT / Cloudflare WSS publishing.
- Internet reachability probe (Wi-Fi association does not guarantee internet).
- Calibrated gas concentration/AQI.
- Authentication for the local portal/API.

This is an initial local firmware milestone, not a secured internet-facing device.
