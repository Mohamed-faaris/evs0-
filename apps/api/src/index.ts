import dotenv from "dotenv";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import mqtt, { type MqttClient } from "mqtt";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

type Telemetry = {
  schema_version?: number;
  device_id: string;
  sensor?: string;
  device_type?: "sensor" | "power_meter";
  meter_model?: string;
  timestamp?: string | null;
  uptime_seconds?: number;
  sequence?: number;
  readings?: {
    raw_adc?: number;
    adc_pin_voltage_v?: number;
    sensor_ao_voltage_v?: number;
    ppm?: number | null;
    voltage_v?: number;
    current_a?: number;
    active_power_w?: number;
    apparent_power_va?: number;
    reactive_power_var?: number;
    power_factor?: number;
    frequency_hz?: number;
    energy_kwh?: number;
  };
  valid?: boolean;
  received_at: string;
};

type DeviceState = {
  schema_version?: number;
  device_id: string;
  state?: string;
  uptime_seconds?: number;
  network?: { wifi_connected?: boolean; wifi_ssid?: string; hotspot_active?: boolean };
  sensor?: { model?: string; valid?: boolean };
  mqtt?: { connected?: boolean };
};
type Availability = { device_id: string; status: "online" | "offline"; received_at: string };
type TopicKind = "telemetry" | "state" | "availability";

const readings: Telemetry[] = [];
const states = new Map<string, DeviceState>();
const availability = new Map<string, Availability>();
const MAX_READINGS = 5000;
function resolveBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const FORECAST_MIN_SAMPLES = resolveBoundedInteger(process.env.FORECAST_MIN_SAMPLES, 10, 5, 500);
const FORECAST_WINDOW_SAMPLES = Math.max(
  FORECAST_MIN_SAMPLES,
  resolveBoundedInteger(process.env.FORECAST_WINDOW_SAMPLES, 120, 10, 1000)
);

function resolveAlpha(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

const SENSOR_FORECAST_ALPHA = resolveAlpha(process.env.SENSOR_FORECAST_ALPHA, 0.25);
const ENERGY_FORECAST_ALPHA = resolveAlpha(process.env.ENERGY_FORECAST_ALPHA, 0.25);

function exponentialSmoothing(values: number[], alpha: number): number | null {
  const samples = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (samples.length < FORECAST_MIN_SAMPLES) return null;
  let level = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    level = alpha * samples[index] + (1 - alpha) * level;
  }
  return level;
}

function projectEnergyAndCarbon(activePowerW: number, hours: number) {
  const energyKwh = activePowerW * hours / 1000;
  return {
    energy_kwh: Number(energyKwh.toFixed(4)),
    estimated_co2_kg: Number((energyKwh * GRID_EMISSION_FACTOR_KG_CO2_PER_KWH).toFixed(4))
  };
}
const POWER_METER_DEVICE_ID = process.env.POWER_METER_DEVICE_ID || "power-meter-001";
let mqttConnected = false;

function parseJson(payload: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resolveMqttUrl(): string | undefined {
  const override = process.env.MQTT_URL?.trim();
  if (override) return override;

  const protocol = (process.env.MQTT_PROTOCOL || "mqtts").trim();
  const host = (process.env.MQTT_HOST || "evs.mqtt.cusptech.dev").trim();
  const port = process.env.MQTT_PORT?.trim();
  const path = process.env.MQTT_PATH?.trim();
  if (!["mqtts", "wss"].includes(protocol)) {
    throw new Error("MQTT_PROTOCOL must be mqtts or wss.");
  }
  if (!host) throw new Error("MQTT_HOST is required when MQTT_URL is not set.");
  const url = new URL(protocol + "://" + host);
  if (port) url.port = port;
  if (protocol === "wss" && path) url.pathname = path.startsWith("/") ? path : "/" + path;
  return url.toString();
}

function parseTopic(topic: string, topicRoot: string): { deviceId: string; kind: TopicKind } | null {
  const prefix = topicRoot.replace(/^\/+|\/+$/g, "");
  const parts = topic.split("/");
  const rootParts = prefix.split("/");
  if (parts.length !== rootParts.length + 2) return null;
  if (!rootParts.every((part, index) => parts[index] === part)) return null;
  const deviceId = parts[rootParts.length];
  const kind = parts[rootParts.length + 1] as TopicKind;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId)) return null;
  if (!["telemetry", "state", "availability"].includes(kind)) return null;
  return { deviceId, kind };
}

const topicRoot = (process.env.MQTT_TOPIC_ROOT || "evs/v1/devices").replace(/^\/+|\/+$/g, "");
const mqttUrl = resolveMqttUrl();
let mqttClient: MqttClient | undefined;

if (mqttUrl) {
  mqttClient = mqtt.connect(mqttUrl, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || "evs0-dashboard-api",
    reconnectPeriod: Number(process.env.MQTT_RECONNECT_PERIOD_MS || 3000),
    keepalive: Number(process.env.MQTT_KEEPALIVE_SECONDS || 60),
    clean: (process.env.MQTT_CLEAN_SESSION || "true").toLowerCase() === "true",
    rejectUnauthorized: true
  });

  mqttClient.on("connect", () => {
    mqttConnected = true;
    console.log("[MQTT] Connected to " + mqttUrl);
    const subscriptions = [
      topicRoot + "/+/telemetry",
      topicRoot + "/+/state",
      topicRoot + "/+/availability"
    ];
    mqttClient?.subscribe(subscriptions, { qos: 1 }, (error) => {
      if (error) console.error("[MQTT] Subscription failed:", error.message);
      else console.log("[MQTT] Subscribed:", subscriptions.join(", "));
    });
  });

  mqttClient.on("reconnect", () => { mqttConnected = false; console.log("[MQTT] Reconnecting..."); });
  mqttClient.on("offline", () => { mqttConnected = false; console.warn("[MQTT] Offline"); });
  mqttClient.on("close", () => { mqttConnected = false; });
  mqttClient.on("error", (error) => console.error("[MQTT]", error.message));

  mqttClient.on("message", (topic, payload) => {
    const parsedTopic = parseTopic(topic, topicRoot);
    if (!parsedTopic) return;
    const { deviceId, kind } = parsedTopic;
    const received_at = new Date().toISOString();

    // Empty retained messages delete the broker's retained value.
    if (payload.length === 0) {
      if (kind === "state") states.delete(deviceId);
      if (kind === "availability") availability.delete(deviceId);
      return;
    }

    const data = parseJson(payload);
    if (!data) { console.warn("[MQTT] Ignoring invalid JSON on", topic); return; }
    if (typeof data.device_id !== "string" || data.device_id !== deviceId) {
      console.warn("[MQTT] Ignoring device_id mismatch on", topic);
      return;
    }

    if (kind === "telemetry") {
      if (data.schema_version !== 1 || !data.readings || typeof data.readings !== "object") {
        console.warn("[MQTT] Ignoring telemetry with unsupported schema on", topic);
        return;
      }
      const item = { ...data, received_at } as unknown as Telemetry;
      readings.push(item);
      if (readings.length > MAX_READINGS) readings.shift();
    } else if (kind === "state") {
      states.set(deviceId, data as unknown as DeviceState);
    } else if (kind === "availability") {
      if (data.status !== "online" && data.status !== "offline") {
        console.warn("[MQTT] Ignoring invalid availability status on", topic);
        return;
      }
      availability.set(deviceId, { device_id: deviceId, status: data.status, received_at });
    }
  });
} else {
  console.warn("[MQTT] Not configured. Set MQTT_HOST/MQTT_PROTOCOL/MQTT_PORT or MQTT_URL in the repository-root .env.");
}

const app = new Hono();
app.get("/api/health", (c) => c.json({
  status: "ok",
  mqtt: { configured: Boolean(mqttUrl), connected: mqttConnected, topic_root: topicRoot },
  devices_seen: new Set(readings.map((reading) => reading.device_id)).size
}));
app.get("/api/devices", (c) => {
  const ids = new Set([...readings.map((reading) => reading.device_id), ...states.keys(), ...availability.keys()]);
  return c.json([...ids].map((device_id) => ({
    device_id,
    state: states.get(device_id) || null,
    availability: availability.get(device_id) || null,
    latest: [...readings].reverse().find((reading) => reading.device_id === device_id) || null
  })));
});
app.get("/api/readings/latest", (c) => {
  const deviceId = c.req.query("device_id");
  const latest = [...readings].reverse().find((reading) => reading.device_type !== "power_meter" && (!deviceId || reading.device_id === deviceId)) || null;
  return c.json({ data: latest });
});
app.get("/api/power-meter/latest", (c) => {
  const latest = [...readings].reverse().find((reading) =>
    reading.device_id === POWER_METER_DEVICE_ID && reading.device_type === "power_meter"
  ) || null;
  return c.json({ data: latest });
});

const configuredGridEmissionFactor = Number(process.env.GRID_EMISSION_FACTOR_KG_CO2_PER_KWH || "0.675");
const GRID_EMISSION_FACTOR_KG_CO2_PER_KWH =
  Number.isFinite(configuredGridEmissionFactor) && configuredGridEmissionFactor > 0
    ? configuredGridEmissionFactor
    : 0.675;

app.get("/api/power-meter/carbon", (c) => {
  const latest = [...readings].reverse().find((reading) =>
    reading.device_id === POWER_METER_DEVICE_ID && reading.device_type === "power_meter"
  ) || null;
  const energyKwh = latest?.readings?.energy_kwh;
  return c.json({
    data: {
      device_id: POWER_METER_DEVICE_ID,
      energy_kwh: typeof energyKwh === "number" && Number.isFinite(energyKwh) ? energyKwh : null,
      emission_factor_kg_co2_per_kwh: GRID_EMISSION_FACTOR_KG_CO2_PER_KWH,
      estimated_co2_kg: typeof energyKwh === "number" && Number.isFinite(energyKwh)
        ? energyKwh * GRID_EMISSION_FACTOR_KG_CO2_PER_KWH
        : null,
      factor_fiscal_year: "FY2025-26",
      factor_source: "Central Electricity Authority (CEA), CO2 Baseline Database v22.0",
      factor_scope: "India national-grid weighted-average electricity factor; CO2 estimate only"
    }
  });
});

app.get("/api/power-meter/history", (c) => {
  const requestedLimit = Number(c.req.query("limit") || 100);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 1000) : 100;
  const data = readings
    .filter((reading) => reading.device_id === POWER_METER_DEVICE_ID && reading.device_type === "power_meter")
    .slice(-limit);
  return c.json({ data });
});
app.get("/api/readings/history", (c) => {
  const deviceId = c.req.query("device_id");
  const requestedLimit = Number(c.req.query("limit") || 100);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 1000) : 100;
  const data = readings.filter((reading) => reading.device_type !== "power_meter" && (!deviceId || reading.device_id === deviceId)).slice(-limit);
  return c.json({ data });
});
app.get("/api/aqi/response-forecast", (c) => {
  const samples = readings
    .filter((reading) => reading.device_id !== POWER_METER_DEVICE_ID && reading.valid !== false)
    .map((reading) => reading.readings?.raw_adc)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4095)
    .slice(-FORECAST_WINDOW_SAMPLES);
  const estimate = exponentialSmoothing(samples, SENSOR_FORECAST_ALPHA);
  if (estimate === null) {
    return c.json({
      available: false,
      reason: `Need at least ${FORECAST_MIN_SAMPLES} valid MQ-135 raw ADC samples; currently have ${samples.length}.`,
      target: "mq135_raw_adc",
      model: { name: "simple_exponential_smoothing", alpha: SENSOR_FORECAST_ALPHA, samples: samples.length }
    });
  }
  return c.json({
    available: true,
    target: "mq135_raw_adc",
    model: { name: "simple_exponential_smoothing", version: "1.0", alpha: SENSOR_FORECAST_ALPHA, samples: samples.length },
    data: {
      latest_raw_adc: samples[samples.length - 1],
      smoothed_raw_adc: Number(estimate.toFixed(2)),
      next_reading_estimate_adc: Number(estimate.toFixed(2))
    },
    note: "This estimates the next MQ-135 raw response only. It is not AQI, PM2.5, PM10, or a calibrated pollutant concentration."
  });
});

app.get("/api/power-meter/forecast", (c) => {
  const samples = readings
    .filter((reading) => reading.device_id === POWER_METER_DEVICE_ID && reading.device_type === "power_meter")
    .map((reading) => reading.readings?.active_power_w)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .slice(-FORECAST_WINDOW_SAMPLES);
  const smoothedPower = exponentialSmoothing(samples, ENERGY_FORECAST_ALPHA);
  if (smoothedPower === null) {
    return c.json({
      available: false,
      reason: `Need at least ${FORECAST_MIN_SAMPLES} valid power samples; currently have ${samples.length}.`,
      model: { name: "simple_exponential_smoothing", alpha: ENERGY_FORECAST_ALPHA, samples: samples.length }
    });
  }
  const activePowerW = Number(smoothedPower.toFixed(2));
  return c.json({
    available: true,
    model: { name: "simple_exponential_smoothing", version: "1.0", alpha: ENERGY_FORECAST_ALPHA, samples: samples.length },
    data: {
      smoothed_active_power_w: activePowerW,
      projections: {
        next_24_hours: projectEnergyAndCarbon(activePowerW, 24),
        next_7_days: projectEnergyAndCarbon(activePowerW, 24 * 7),
        next_30_days: projectEnergyAndCarbon(activePowerW, 24 * 30)
      }
    },
    note: "Flat-load projection from exponentially smoothed recent active power. It is a statistical baseline, not a trained AI/ML model."
  });
});

app.get("/api/aqi/current", (c) => c.json({
  available: false,
  reason: "MQ-135 raw response is not sufficient to calculate CPCB AQI. Add calibrated particulate and pollutant sensors."
}));
app.get("/api/aqi/predictions", (c) => c.json({
  available: false,
  reason: "No validated prediction model is configured yet. Predictions will be enabled after collecting and validating historical data."
}));
app.get("/", (c) => c.json({ name: "EVS0 Dashboard API", docs: ["/api/health", "/api/devices", "/api/readings/latest", "/api/readings/history", "/api/power-meter/latest", "/api/power-meter/history", "/api/power-meter/carbon", "/api/power-meter/forecast", "/api/aqi/current", "/api/aqi/predictions", "/api/aqi/response-forecast"] }));

const POWER_MAP_UPSTREAM_VALUE = (process.env.POWER_MAP_UPSTREAM || "https://power.reclaimchennai.city").trim();
let POWER_MAP_UPSTREAM: URL | null = null;
try {
  const configuredUrl = new URL(POWER_MAP_UPSTREAM_VALUE);
  if (
    configuredUrl.protocol !== "https:" ||
    configuredUrl.username ||
    configuredUrl.password ||
    configuredUrl.pathname !== "/" ||
    configuredUrl.search ||
    configuredUrl.hash
  ) {
    throw new Error("POWER_MAP_UPSTREAM must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  POWER_MAP_UPSTREAM = new URL(configuredUrl.origin);
} catch (error) {
  const message = error instanceof Error ? error.message : "Invalid URL";
  console.error("[POWER-MAP] Proxy disabled by invalid POWER_MAP_UPSTREAM:", message);
}

// Read-only reverse proxy for the public Power Map site. The iframe and its relative
// JS/CSS/JSON/GeoJSON requests stay on the EVS0 origin. The iframe is sandboxed with
// an opaque origin, so the proxy explicitly allows anonymous cross-origin reads.
// External tile/CDN providers used by the map remain direct browser requests.
app.get("/api/power-map/open", (c) => {
  const configuredUpstream = POWER_MAP_UPSTREAM;
  if (!configuredUpstream) {
    return c.json({
      error: "power_map_proxy_misconfigured",
      message: "Power Map proxy configuration is invalid. Check POWER_MAP_UPSTREAM."
    }, 503);
  }
  // Open the upstream on its own origin rather than rendering it as a top-level
  // document on the EVS0/API origin.
  return c.redirect(configuredUpstream.origin + "/", 302);
});
app.get("/api/power-map", (c) => c.redirect("/api/power-map/"));
app.options("/api/power-map/*", (c) => new Response(null, {
  status: 204,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since, Range, If-Range",
    "Access-Control-Max-Age": "86400"
  }
}));
app.all("/api/power-map/*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.text("Power Map proxy is read-only.", 405, { Allow: "GET, HEAD, OPTIONS" });
  }
  if (!POWER_MAP_UPSTREAM) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({
      error: "power_map_proxy_misconfigured",
      message: "Power Map proxy configuration is invalid. Check POWER_MAP_UPSTREAM."
    }, 503);
  }

  const proxyPrefix = "/api/power-map";
  const upstreamPath = c.req.path.slice(proxyPrefix.length) || "/";
  const requestUrl = new URL(c.req.url);
  const upstreamUrl = new URL(POWER_MAP_UPSTREAM.origin);
  upstreamUrl.pathname = upstreamPath;
  upstreamUrl.search = requestUrl.search;

  try {
    const requestHeaders = new Headers({
      Accept: c.req.header("accept") || "*/*",
      "User-Agent": "EVS0-PowerMap-Proxy/1.0"
    });
    for (const name of ["if-none-match", "if-modified-since", "range", "if-range"]) {
      const value = c.req.header(name);
      if (value) requestHeaders.set(name, value);
    }

    // Follow only same-origin HTTPS redirects. Never let upstream redirects turn this
    // fixed-host proxy into a request path to internal or unrelated services.
    let currentUrl = upstreamUrl;
    let upstream: Response;
    for (let redirectCount = 0; ; redirectCount += 1) {
      upstream = await fetch(currentUrl, {
        method: c.req.method,
        headers: requestHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(45000)
      });

      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;

      const location = upstream.headers.get("location");
      if (!location) {
        await upstream.body?.cancel().catch(() => {});
        c.header("Access-Control-Allow-Origin", "*");
        return c.json({
          error: "power_map_upstream_redirect_invalid",
          message: "Power Map upstream returned an invalid redirect."
        }, 502);
      }

      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== "https:" || nextUrl.origin !== POWER_MAP_UPSTREAM.origin) {
        await upstream.body?.cancel().catch(() => {});
        c.header("Access-Control-Allow-Origin", "*");
        return c.json({
          error: "power_map_upstream_redirect_blocked",
          message: "Power Map upstream attempted to redirect outside its configured HTTPS origin."
        }, 502);
      }

      if (redirectCount >= 3) {
        await upstream.body?.cancel().catch(() => {});
        c.header("Access-Control-Allow-Origin", "*");
        return c.json({
          error: "power_map_upstream_redirect_limit",
          message: "Power Map upstream exceeded the redirect limit."
        }, 502);
      }

      await upstream.body?.cancel().catch(() => {});
      currentUrl = nextUrl;
    }

    if (upstream.status >= 500) {
      await upstream.body?.cancel().catch(() => {});
      c.header("Access-Control-Allow-Origin", "*");
      return c.json({
        error: "power_map_upstream_unavailable",
        message: "Power Map is temporarily unavailable. Retry in a moment."
      }, 502);
    }

    const headers = new Headers();
    for (const name of [
      "content-type",
      "cache-control",
      "etag",
      "last-modified",
      "expires",
      "vary",
      "content-range",
      "accept-ranges",
      "content-disposition"
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Power-Map-Proxy", "reclaimchennai/power-map-india");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");

    // Stream large GeoJSON and map assets instead of buffering whole files in API memory.
    const body = c.req.method === "HEAD" || upstream.status === 204 || upstream.status === 304
      ? null
      : upstream.body;
    return new Response(body, { status: upstream.status, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream request failed";
    console.error("[POWER-MAP] Proxy error:", message, upstreamUrl.toString());
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({
      error: "power_map_upstream_unavailable",
      message: "Power Map is temporarily unavailable. Retry in a moment."
    }, 502);
  }
});

const port = Number(process.env.API_PORT || 3002);
serve({ fetch: app.fetch, port, hostname: process.env.API_HOST || "0.0.0.0" }, (info) => {
  console.log("[API] Hono listening on http://localhost:" + info.port);
});
