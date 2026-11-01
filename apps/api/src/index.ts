import { serve } from "@hono/node-server";
import { Hono } from "hono";
import mqtt from "mqtt";

type Telemetry = {
  schema_version?: number;
  device_id: string;
  sensor?: string;
  timestamp?: string | null;
  uptime_seconds?: number;
  sequence?: number;
  readings?: {
    raw_adc?: number;
    adc_pin_voltage_v?: number;
    sensor_ao_voltage_v?: number;
    ppm?: number | null;
  };
  valid?: boolean;
  received_at: string;
};

type DeviceState = Record<string, unknown> & { device_id: string };
const readings: Telemetry[] = [];
const states = new Map<string, DeviceState>();
const availability = new Map<string, { status: string; received_at: string }>();
const MAX_READINGS = 5000;

function parseJson<T>(payload: Buffer): T | null {
  try { return JSON.parse(payload.toString("utf8")) as T; } catch { return null; }
}

const mqttUrl = process.env.MQTT_URL;
if (mqttUrl) {
  const client = mqtt.connect(mqttUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: process.env.MQTT_CLIENT_ID || "evs0-dashboard-api",
    reconnectPeriod: 3000,
    clean: true
  });
  client.on("connect", () => {
    console.log("[MQTT] Connected");
    client.subscribe("evs/v1/devices/+/telemetry");
    client.subscribe("evs/v1/devices/+/state");
    client.subscribe("evs/v1/devices/+/availability");
  });
  client.on("message", (topic, payload) => {
    const parts = topic.split("/");
    const deviceId = parts[3];
    if (!deviceId) return;
    const data = parseJson<Record<string, unknown>>(payload);
    if (!data) return;
    const received_at = new Date().toISOString();
    if (parts[4] === "telemetry") {
      const item = { ...data, device_id: String(data.device_id || deviceId), received_at } as Telemetry;
      readings.push(item);
      if (readings.length > MAX_READINGS) readings.shift();
    } else if (parts[4] === "state") {
      states.set(deviceId, { ...data, device_id: deviceId });
    } else if (parts[4] === "availability") {
      availability.set(deviceId, { status: String(data.status || "unknown"), received_at });
    }
  });
  client.on("error", (error) => console.error("[MQTT]", error.message));
} else {
  console.warn("[MQTT] MQTT_URL is not configured; API is running without broker data.");
}

const app = new Hono();
app.get("/api/health", (c) => c.json({ status: "ok", mqtt_configured: Boolean(mqttUrl), devices_seen: new Set(readings.map(r => r.device_id)).size }));
app.get("/api/devices", (c) => {
  const ids = new Set([...readings.map(r => r.device_id), ...states.keys(), ...availability.keys()]);
  return c.json([...ids].map(device_id => ({
    device_id,
    state: states.get(device_id) || null,
    availability: availability.get(device_id) || null,
    latest: [...readings].reverse().find(r => r.device_id === device_id) || null
  })));
});
app.get("/api/readings/latest", (c) => {
  const deviceId = c.req.query("device_id");
  const latest = [...readings].reverse().find(r => !deviceId || r.device_id === deviceId) || null;
  return c.json({ data: latest });
});
app.get("/api/readings/history", (c) => {
  const deviceId = c.req.query("device_id");
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 100), 1), 1000);
  const data = readings.filter(r => !deviceId || r.device_id === deviceId).slice(-limit);
  return c.json({ data });
});
app.get("/api/aqi/current", (c) => c.json({
  available: false,
  reason: "MQ-135 raw response is not sufficient to calculate CPCB AQI. Add calibrated particulate and pollutant sensors."
}));
app.get("/api/aqi/predictions", (c) => c.json({
  available: false,
  reason: "No validated prediction model is configured yet. Predictions will be enabled after collecting and validating historical data."
}));
app.get("/", (c) => c.json({ name: "EVS0 Dashboard API", docs: ["/api/health", "/api/devices", "/api/readings/latest", "/api/readings/history", "/api/aqi/current", "/api/aqi/predictions"] }));

const port = Number(process.env.PORT || 3002);
serve({ fetch: app.fetch, port, hostname: process.env.HOST || "0.0.0.0" }, info => {
  console.log(`[API] Hono listening on http://localhost:${info.port}`);
});