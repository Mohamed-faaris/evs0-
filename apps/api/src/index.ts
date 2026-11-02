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
  session_id?: string;
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
  session_id?: string;
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
    latest: device_id === POWER_METER_DEVICE_ID
      ? getLatestPowerMeterReading()
      : [...readings].reverse().find((reading) => reading.device_id === device_id) || null
  })));
});
app.get("/api/readings/latest", (c) => {
  const deviceId = c.req.query("device_id");
  const latest = [...readings].reverse().find((reading) => reading.device_type !== "power_meter" && (!deviceId || reading.device_id === deviceId)) || null;
  return c.json({ data: latest });
});
app.get("/api/power-meter/latest", (c) => {
  const latest = getLatestPowerMeterReading();
  return c.json({ data: latest });
});

const DEFAULT_GRID_EMISSION_FACTOR_KG_CO2_PER_KWH = 0.675;
const rawGridEmissionFactor = process.env.GRID_EMISSION_FACTOR_KG_CO2_PER_KWH?.trim();
const configuredGridEmissionFactor = rawGridEmissionFactor ? Number(rawGridEmissionFactor) : DEFAULT_GRID_EMISSION_FACTOR_KG_CO2_PER_KWH;
if (!Number.isFinite(configuredGridEmissionFactor) || configuredGridEmissionFactor <= 0) {
  throw new Error("GRID_EMISSION_FACTOR_KG_CO2_PER_KWH must be a finite number greater than zero.");
}
const GRID_EMISSION_FACTOR_KG_CO2_PER_KWH = configuredGridEmissionFactor;
const isDefaultGridEmissionFactor = GRID_EMISSION_FACTOR_KG_CO2_PER_KWH === DEFAULT_GRID_EMISSION_FACTOR_KG_CO2_PER_KWH;
const GRID_EMISSION_FACTOR_SOURCE = process.env.GRID_EMISSION_FACTOR_SOURCE?.trim() ||
  (isDefaultGridEmissionFactor ? "Central Electricity Authority (CEA), CO2 Baseline Database v22.0" : "Custom configured emission factor");
const GRID_EMISSION_FACTOR_FISCAL_YEAR = process.env.GRID_EMISSION_FACTOR_FISCAL_YEAR?.trim() ||
  (isDefaultGridEmissionFactor ? "FY2025-26" : "CUSTOM");
const GRID_EMISSION_FACTOR_SCOPE = process.env.GRID_EMISSION_FACTOR_SCOPE?.trim() ||
  (isDefaultGridEmissionFactor
    ? "India national-grid weighted-average electricity factor; CO2 estimate only"
    : "Operator-defined factor; source and accounting boundary require verification");

const POWER_METER_MAX_AGE_MS = resolveBoundedInteger(
  process.env.POWER_METER_MAX_AGE_SECONDS,
  20,
  5,
  3600
) * 1000;

function matchesCurrentPowerMeterSession(reading: Telemetry): boolean {
  if (
    reading.device_id !== POWER_METER_DEVICE_ID ||
    reading.device_type !== "power_meter" ||
    reading.valid === false
  ) return false;

  const currentSessionId = states.get(POWER_METER_DEVICE_ID)?.session_id;
  if (typeof currentSessionId === "string" && currentSessionId.length > 0) {
    return reading.session_id === currentSessionId;
  }
  // Session-tagged telemetry is not current until its matching retained state arrives.
  return !(typeof reading.session_id === "string" && reading.session_id.length > 0);
}

function getLegacyPowerMeterSessionStartMs(): number | null {
  let previousUptime: number | undefined;
  let latestSessionStartMs: number | null = null;

  // MQTT messages are appended in receive order. For legacy meters without a
  // session UUID, an uptime rollback identifies a reboot boundary.
  for (const reading of readings) {
    if (
      reading.device_id !== POWER_METER_DEVICE_ID ||
      reading.device_type !== "power_meter" ||
      (typeof reading.session_id === "string" && reading.session_id.length > 0) ||
      typeof reading.uptime_seconds !== "number" ||
      !Number.isFinite(reading.uptime_seconds)
    ) continue;

    if (previousUptime !== undefined && reading.uptime_seconds < previousUptime) {
      const receivedAt = Date.parse(reading.received_at);
      if (Number.isFinite(receivedAt)) latestSessionStartMs = receivedAt;
    }
    previousUptime = reading.uptime_seconds;
  }

  return latestSessionStartMs;
}

function collectPowerMeterReadings(requireLive: boolean): Telemetry[] {
  const deduplicated = new Map<string, Telemetry>();
  const legacySessionStartMs = getLegacyPowerMeterSessionStartMs();

  for (const reading of readings) {
    if (!matchesCurrentPowerMeterSession(reading)) continue;

    if (!reading.session_id && legacySessionStartMs !== null) {
      const receivedAt = Date.parse(reading.received_at);
      if (!Number.isFinite(receivedAt) || receivedAt < legacySessionStartMs) continue;
    }

    const session = reading.session_id || "legacy";
    const sampleKey = typeof reading.sequence === "number" && Number.isFinite(reading.sequence)
      ? session + ":seq:" + reading.sequence
      : typeof reading.timestamp === "string" && reading.timestamp
        ? session + ":timestamp:" + reading.timestamp
        : session + ":received:" + reading.received_at;
    deduplicated.set(sampleKey, reading);
  }

  const ordered = [...deduplicated.values()].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || left.received_at);
    const rightTime = Date.parse(right.timestamp || right.received_at);
    return leftTime - rightTime;
  });

  // Freshness is a device-liveness check, not a per-sample history filter.
  // Keep older samples from the active session for forecasting while ensuring
  // the newest received sample is fresh and contains usable active power.
  if (requireLive && resolvePowerMeterLiveness() !== "online") return [];
  return ordered;
}

function getCurrentPowerMeterReadings(): Telemetry[] {
  return collectPowerMeterReadings(true);
}
function getPowerMeterSessionHistory(): Telemetry[] {
  return collectPowerMeterReadings(false);
}

type PowerMeterLiveness = "online" | "offline" | "stale" | "empty" | "invalid";

function getLatestReceivedReading(samples: Telemetry[]): Telemetry | null {
  return [...samples].sort((left, right) =>
    Date.parse(left.received_at) - Date.parse(right.received_at)
  ).at(-1) || null;
}

// Freshness is checked against the most recently received telemetry, not the
// device timestamp. An invalid newest power value must also pause forecasts;
// otherwise older valid samples could keep producing a stale prediction.
function resolvePowerMeterLiveness(): PowerMeterLiveness {
  if (availability.get(POWER_METER_DEVICE_ID)?.status !== "online") return "offline";
  const latest = getLatestReceivedReading(getPowerMeterSessionHistory());
  if (!latest) return "empty";

  const receivedAt = Date.parse(latest.received_at);
  const ageMs = Date.now() - receivedAt;
  if (!Number.isFinite(receivedAt) || ageMs < 0 || ageMs > POWER_METER_MAX_AGE_MS) return "stale";

  const activePower = latest.readings?.active_power_w;
  if (typeof activePower !== "number" || !Number.isFinite(activePower) || activePower < 0) {
    return "invalid";
  }
  return "online";
}

function getLatestPowerMeterReading(): Telemetry | null {
  return getLatestReceivedReading(getCurrentPowerMeterReadings());
}
app.get("/api/power-meter/carbon", (c) => {
  const latest = getLatestPowerMeterReading();
  const rawEnergyKwh = latest?.readings?.energy_kwh;
  const energyKwh = typeof rawEnergyKwh === "number" && Number.isFinite(rawEnergyKwh) && rawEnergyKwh >= 0
    ? rawEnergyKwh
    : null;

  return c.json({
    available: energyKwh !== null,
    reason: energyKwh === null ? "Waiting for a fresh, valid power-meter reading from the current meter session." : null,
    data: {
      device_id: POWER_METER_DEVICE_ID,
      session_id: latest?.session_id || null,
      last_received_at: latest?.received_at || null,
      energy_kwh: energyKwh,
      emission_factor_kg_co2_per_kwh: GRID_EMISSION_FACTOR_KG_CO2_PER_KWH,
      estimated_co2_kg: energyKwh === null ? null : energyKwh * GRID_EMISSION_FACTOR_KG_CO2_PER_KWH,
      factor_fiscal_year: GRID_EMISSION_FACTOR_FISCAL_YEAR,
      factor_source: GRID_EMISSION_FACTOR_SOURCE,
      factor_scope: GRID_EMISSION_FACTOR_SCOPE
    }
  });
});

app.get("/api/power-meter/history", (c) => {
  const requestedLimit = Number(c.req.query("limit") || 100);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 1000) : 100;
  const data = getPowerMeterSessionHistory().slice(-limit);
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

type EnergyForecastMethodId =
  | "ses"
  | "moving_average"
  | "weighted_moving_average"
  | "holt_damped"
  | "linear_trend";

const ENERGY_FORECAST_METHODS: { id: EnergyForecastMethodId; name: string }[] = [
  { id: "ses", name: "Simple exponential smoothing" },
  { id: "moving_average", name: "Moving average" },
  { id: "weighted_moving_average", name: "Weighted moving average" },
  { id: "holt_damped", name: "Holt damped trend" },
  { id: "linear_trend", name: "Linear trend" }
];

function clampForecast(candidate: number, history: number[]): number {
  const recent = history.slice(-30);
  const maximum = Math.max(...recent);
  const minimum = Math.min(...recent);
  const lower = Math.max(0, minimum * 0.8);
  const upper = Math.max(maximum * 1.2, 1);
  return Math.min(upper, Math.max(lower, Number.isFinite(candidate) ? candidate : recent.at(-1) || 0));
}

function forecastCandidate(history: number[], method: EnergyForecastMethodId, alpha: number): number | null {
  const values = history.filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) return null;
  // SES can use the configured full window. Other light baselines use a bounded
  // recent window to avoid overreacting to very old load behavior.
  const recent = method === "ses" ? values : values.slice(-30);
  let prediction = recent.at(-1) || 0;

  if (method === "ses") {
    const smoothed = exponentialSmoothing(recent, alpha);
    if (smoothed === null) return null;
    prediction = smoothed;
  } else if (method === "moving_average") {
    const window = recent.slice(-12);
    prediction = window.reduce((sum, value) => sum + value, 0) / window.length;
  } else if (method === "weighted_moving_average") {
    const window = recent.slice(-12);
    const weightTotal = window.length * (window.length + 1) / 2;
    prediction = window.reduce((sum, value, index) => sum + value * (index + 1), 0) / weightTotal;
  } else if (method === "holt_damped") {
    const levelAlpha = 0.35;
    const trendBeta = 0.12;
    const damping = 0.85;
    let level = recent[0];
    let trend = recent.length > 1 ? recent[1] - recent[0] : 0;
    for (let index = 1; index < recent.length; index += 1) {
      const previousLevel = level;
      level = levelAlpha * recent[index] + (1 - levelAlpha) * (level + damping * trend);
      trend = trendBeta * (level - previousLevel) + (1 - trendBeta) * damping * trend;
    }
    prediction = level + damping * trend;
  } else if (method === "linear_trend") {
    const window = recent.slice(-20);
    const count = window.length;
    const meanX = (count - 1) / 2;
    const meanY = window.reduce((sum, value) => sum + value, 0) / count;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < count; index += 1) {
      numerator += (index - meanX) * (window[index] - meanY);
      denominator += (index - meanX) ** 2;
    }
    const slope = denominator > 0 ? numerator / denominator : 0;
    prediction = window[count - 1] + slope;
  }

  return clampForecast(prediction, recent);
}

type ForecastScore = { mae_w: number | null; rmse_w: number | null; samples: number };

function evaluateForecast(
  values: number[],
  predictor: (history: number[]) => number | null
): ForecastScore {
  const validationCount = Math.min(12, Math.max(4, Math.floor(values.length * 0.2)));
  // Every validation prefix must meet the configured sample threshold. If the
  // session is only just large enough to produce a forecast, report no score.
  const firstValidationIndex = Math.max(FORECAST_MIN_SAMPLES, values.length - validationCount);
  const errors: number[] = [];

  for (let index = firstValidationIndex; index < values.length; index += 1) {
    const prediction = predictor(values.slice(0, index));
    if (prediction !== null && Number.isFinite(prediction)) errors.push(values[index] - prediction);
  }

  if (errors.length === 0) return { mae_w: null, rmse_w: null, samples: 0 };
  const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
  return { mae_w: Number(mae.toFixed(2)), rmse_w: Number(rmse.toFixed(2)), samples: errors.length };
}

function projectModelEnergy(activePowerW: number) {
  return {
    next_24_hours: projectEnergyAndCarbon(activePowerW, 24),
    next_7_days: projectEnergyAndCarbon(activePowerW, 24 * 7),
    next_30_days: projectEnergyAndCarbon(activePowerW, 24 * 30)
  };
}

app.get("/api/power-meter/forecast", (c) => {
  const currentMeterReadings = getCurrentPowerMeterReadings();
  const samples = currentMeterReadings
    .map((reading) => reading.readings?.active_power_w)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .slice(-FORECAST_WINDOW_SAMPLES);

  if (samples.length < FORECAST_MIN_SAMPLES) {
    return c.json({
      available: false,
      reason: currentMeterReadings.length === 0
        ? "No fresh, valid power-meter samples are available for the current online meter session."
        : `Need at least ${FORECAST_MIN_SAMPLES} valid power samples; currently have ${samples.length}.`,
      model: { name: "multi_model_energy_forecast", alpha: ENERGY_FORECAST_ALPHA, samples: samples.length }
    });
  }

  const methodScores = ENERGY_FORECAST_METHODS.map((method) => ({
    ...method,
    forecast: forecastCandidate(samples, method.id, ENERGY_FORECAST_ALPHA),
    validation: evaluateForecast(samples, (history) => forecastCandidate(history, method.id, ENERGY_FORECAST_ALPHA))
  }));

  const unavailableMethod = methodScores.find((method) => method.forecast === null);
  if (unavailableMethod) {
    return c.json({
      available: false,
      reason: `${unavailableMethod.name} does not yet have enough training samples.`,
      model: { name: "multi_model_energy_forecast", alpha: ENERGY_FORECAST_ALPHA, samples: samples.length }
    });
  }

  // Inverse-MAE weights emphasize models that performed better in walk-forward
  // validation. Models without enough validation prefixes receive a neutral
  // weight; they are not incorrectly assigned a zero-watt validation error.
  const makeEnsemble = (history: number[]): number | null => {
    const forecasts = ENERGY_FORECAST_METHODS.flatMap((method) => {
      const forecast = forecastCandidate(history, method.id, ENERGY_FORECAST_ALPHA);
      if (forecast === null) return [];
      const score = evaluateForecast(history, (training) => forecastCandidate(training, method.id, ENERGY_FORECAST_ALPHA));
      return [{
        forecast,
        weight: score.samples > 0 && score.mae_w !== null
          ? 1 / Math.max(score.mae_w, 1)
          : 1
      }];
    });
    if (forecasts.length === 0) return null;
    const totalWeight = forecasts.reduce((sum, item) => sum + item.weight, 0);
    return forecasts.reduce((sum, item) => sum + item.forecast * item.weight, 0) / totalWeight;
  };

  const ensembleCandidate = makeEnsemble(samples);
  if (ensembleCandidate === null) {
    return c.json({
      available: false,
      reason: "The ensemble does not have enough valid model predictions yet.",
      model: { name: "multi_model_energy_forecast", alpha: ENERGY_FORECAST_ALPHA, samples: samples.length }
    });
  }

  const ensembleForecast = clampForecast(ensembleCandidate, samples);
  const ensembleValidation = evaluateForecast(samples, makeEnsemble);
  const sesForecast = methodScores.find((item) => item.id === "ses")?.forecast ?? ensembleForecast;

  const allModels = [
    ...methodScores.map((method) => ({
      id: method.id,
      name: method.name,
      forecast_active_power_w: Number(method.forecast!.toFixed(2)),
      mae_w: method.validation.mae_w,
      rmse_w: method.validation.rmse_w,
      validation_samples: method.validation.samples,
      projections: projectModelEnergy(method.forecast!)
    })),
    {
      id: "weighted_ensemble",
      name: "Inverse-error weighted ensemble",
      forecast_active_power_w: Number(ensembleForecast.toFixed(2)),
      mae_w: ensembleValidation.mae_w,
      rmse_w: ensembleValidation.rmse_w,
      validation_samples: ensembleValidation.samples,
      projections: projectModelEnergy(ensembleForecast)
    }
  ];

  const bestBaseModel = [...methodScores]
    .filter((method) => method.validation.samples > 0 && method.validation.mae_w !== null)
    .sort((left, right) => left.validation.mae_w! - right.validation.mae_w!)[0];

  return c.json({
    available: true,
    model: {
      name: "walk_forward_model_comparison",
      version: "2.0",
      alpha: ENERGY_FORECAST_ALPHA,
      samples: samples.length
    },
    selected_model: "weighted_ensemble",
    best_backtest_model: bestBaseModel?.name || "Not enough validation history",
    validation: {
      method: "rolling one-step-ahead holdout",
      samples: ensembleValidation.samples,
      interpretation: "Lower MAE/RMSE indicates better short-step fit; these are not calibrated long-range confidence intervals."
    },
    models: allModels,
    data: {
      latest_active_power_w: samples.at(-1) || 0,
      smoothed_active_power_w: Number(sesForecast.toFixed(2)),
      forecast_active_power_w: Number(ensembleForecast.toFixed(2)),
      projections: projectModelEnergy(ensembleForecast)
    },
    note: "The ensemble compares SES, moving average, weighted moving average, Holt damped trend, and linear trend using walk-forward error. Each horizon converts its representative forecast load into a flat-load scenario. It does not learn daily or weekly seasonality; multi-day history and persistent storage are needed for that."
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
app.get("/", (c) => c.json({ name: "EVS0 Dashboard API", docs: ["/api/health", "/api/devices", "/api/chennai-aqi/source", "/api/chennai-aqi/stations", "/api/chennai-aqi/sky", "/api/chennai-aqi/trend", "/api/chennai-aqi/sky/image/:id", "/api/readings/latest", "/api/readings/history", "/api/power-meter/latest", "/api/power-meter/history", "/api/power-meter/carbon", "/api/power-meter/forecast", "/api/aqi/current", "/api/aqi/predictions", "/api/aqi/response-forecast"] }));

// Public Reclaim Chennai city-station source. Keep this fixed to the source
// declared by the AQI dashboard; browser clients call EVS0, not the upstream host.
const chennaiAqiSourceUrl = new URL("https://pol.reclaimchennai.city/api/stations");
const CHENNAI_AQI_SOURCE_URL = chennaiAqiSourceUrl.toString();

const CHENNAI_CITY_LABEL = "chennai";

// The published snapshot includes nearby metro records; retain Chennai-tagged
// records when the source provides city labels. If the source changes schema,
// pass through the payload rather than silently removing every station.
function scopeChennaiStations(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.stations)) return payload;
  const tagged = record.stations.filter(
    (station) => station !== null && typeof station === "object" && typeof (station as { city?: unknown }).city === "string"
  );
  if (tagged.length === 0) return payload;
  const chennai = tagged.filter(
    (station) => (station as { city: string }).city.trim().toLowerCase() === CHENNAI_CITY_LABEL
  );
  return chennai.length > 0 ? { ...record, stations: chennai } : payload;
}

type ChennaiAqiSnapshot = { payload: unknown; fetchedAt: string };
type ChennaiAqiProxyError = Error & { status?: number; code?: string; upstreamStatus?: number };

let chennaiAqiCache: { expiresAt: number; payload: unknown; fetchedAt: string } | null = null;
let chennaiAqiRefreshPromise: Promise<ChennaiAqiSnapshot> | null = null;
const CHENNAI_AQI_CACHE_MS = 60_000;
const CHENNAI_AQI_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function aqiProxyError(message: string, status: number, code: string): ChennaiAqiProxyError {
  return Object.assign(new Error(message), { status, code });
}

async function fetchChennaiAqiSnapshot(): Promise<ChennaiAqiSnapshot> {
  const upstream = await fetch(chennaiAqiSourceUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "EVS0-Chennai-AQI-Proxy/1.0",
      Referer: "https://pol.reclaimchennai.city/"
    },
    redirect: "error",
    signal: AbortSignal.timeout(12_000)
  });

  if (!upstream.ok) {
    const status = upstream.status;
    await upstream.body?.cancel().catch(() => {});
    const proxyError = aqiProxyError(
      "The Reclaim Chennai /api/stations endpoint returned HTTP " + status + ".",
      502,
      "chennai_aqi_upstream_http_error"
    );
    proxyError.upstreamStatus = status;
    throw proxyError;
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    await upstream.body?.cancel().catch(() => {});
    throw aqiProxyError(
      "The public Chennai station source did not return JSON.",
      502,
      "chennai_aqi_upstream_non_json"
    );
  }

  const contentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > CHENNAI_AQI_MAX_RESPONSE_BYTES) {
    await upstream.body?.cancel().catch(() => {});
    throw aqiProxyError(
      "The public Chennai station response exceeded the 5 MiB limit.",
      502,
      "chennai_aqi_upstream_response_too_large"
    );
  }

  if (!upstream.body) {
    throw aqiProxyError(
      "The public Chennai station source returned an empty response body.",
      502,
      "chennai_aqi_upstream_invalid_payload"
    );
  }

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > CHENNAI_AQI_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw aqiProxyError(
          "The public Chennai station response exceeded the 5 MiB limit.",
          502,
          "chennai_aqi_upstream_response_too_large"
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw aqiProxyError(
      "The public Chennai station source returned malformed JSON.",
      502,
      "chennai_aqi_upstream_invalid_payload"
    );
  }

  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { stations?: unknown }).stations)) {
    throw aqiProxyError(
      "The Reclaim Chennai /api/stations response did not contain a stations array.",
      502,
      "chennai_aqi_upstream_invalid_payload"
    );
  }

  return { payload: scopeChennaiStations(payload), fetchedAt: new Date().toISOString() };
}

const CHENNAI_SKY_DATASET_URL = "https://pol.reclaimchennai.city/api/sky?hours=24";
let chennaiSkyCache: { expiresAt: number; payload: unknown; fetchedAt: string } | null = null;
let chennaiSkyRefresh: Promise<{ payload: unknown; fetchedAt: string }> | null = null;
const CHENNAI_SKY_CACHE_MS = 5 * 60_000;
const CHENNAI_SKY_MAX_BYTES = 5 * 1024 * 1024;

async function fetchChennaiSkySnapshot(): Promise<{ payload: unknown; fetchedAt: string }> {
  const response = await fetch(CHENNAI_SKY_DATASET_URL, {
    headers: {
      Accept: "application/json",
      Referer: "https://pol.reclaimchennai.city/",
      "User-Agent": "EVS0-Chennai-AQI-Proxy/1.0"
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    throw new Error("Reclaim Chennai sky API returned HTTP " + status + ".");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Reclaim Chennai sky API returned non-JSON content.");
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CHENNAI_SKY_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Reclaim Chennai sky API exceeded the 5 MiB response limit.");
  }

  if (!response.body) throw new Error("Reclaim Chennai sky API returned an empty body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > CHENNAI_SKY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Reclaim Chennai sky API exceeded the 5 MiB response limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Reclaim Chennai sky API returned malformed JSON.");
  }

  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { cameras?: unknown }).cameras)) {
    throw new Error("Reclaim Chennai sky API payload does not contain a cameras array.");
  }

  const source = payload as Record<string, unknown>;
  const cameras = source.cameras.flatMap((entry): Record<string, unknown>[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const camera = entry as Record<string, unknown>;
    const cameraId = typeof camera.camera_id === "string" ? camera.camera_id.trim() : "";
    const capturedAt = typeof camera.captured_at === "string" ? camera.captured_at : "";
    const image = typeof camera.image === "string" && /^\/sky\/\d{1,10}\.jpg$/.test(camera.image)
      ? camera.image
      : "";
    if (!cameraId || !Number.isFinite(Date.parse(capturedAt)) || !image) return [];

    const finiteNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const textOrNull = (value: unknown): string | null =>
      typeof value === "string" ? value : null;

    return [{
      id: finiteNumber(camera.id) ?? 0,
      camera_id: cameraId,
      captured_at: capturedAt,
      image,
      name: textOrNull(camera.name),
      verdict: textOrNull(camera.verdict),
      rain_truth: textOrNull(camera.rain_truth),
      confidence: finiteNumber(camera.confidence),
      bearing: finiteNumber(camera.bearing)
    }];
  });

  return {
    payload: {
      ...source,
      cameras,
      end: typeof source.end === "string" && Number.isFinite(Date.parse(source.end)) ? source.end : null
    },
    fetchedAt: new Date().toISOString()
  };
}

type SkyImageProxyError = Error & { status?: number; upstreamStatus?: number };
const skyImageCache = new Map<string, { bytes: Uint8Array; expiresAt: number }>();
const skyImageInflight = new Map<string, Promise<Uint8Array>>();
const SKY_IMAGE_CACHE_MS = 15 * 60_000;
const SKY_IMAGE_CACHE_MAX_ENTRIES = 48;
const SKY_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const SKY_IMAGE_MAX_CONCURRENT_UPSTREAM = 6;
let skyImageActiveUpstream = 0;

async function getChennaiSkyImage(id: string): Promise<Uint8Array> {
  const cached = skyImageCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.bytes;
  if (cached) skyImageCache.delete(id);

  const pending = skyImageInflight.get(id);
  if (pending) return pending;

  if (skyImageActiveUpstream >= SKY_IMAGE_MAX_CONCURRENT_UPSTREAM) {
    throw Object.assign(new Error("The sky image proxy is busy. Retry shortly."), { status: 429 });
  }

  skyImageActiveUpstream += 1;
  const request = (async () => {
    const upstream = await fetch("https://pol.reclaimchennai.city/sky/" + id + ".jpg", {
      headers: {
        Accept: "image/jpeg",
        Referer: "https://pol.reclaimchennai.city/",
        "User-Agent": "EVS0-Chennai-AQI-Proxy/1.0"
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });

    const contentType = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !contentType.toLowerCase().startsWith("image/jpeg") || !upstream.body) {
      const status = upstream.status;
      await upstream.body?.cancel().catch(() => {});
      throw Object.assign(new Error("The source camera frame returned HTTP " + status + " or an unexpected content type."), {
        status: 502,
        upstreamStatus: status
      });
    }

    const declaredLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > SKY_IMAGE_MAX_BYTES) {
      await upstream.body.cancel().catch(() => {});
      throw Object.assign(new Error("The source camera frame exceeded 2 MiB."), { status: 502 });
    }

    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > SKY_IMAGE_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          throw Object.assign(new Error("The source camera frame exceeded 2 MiB."), { status: 502 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    skyImageCache.set(id, { bytes, expiresAt: Date.now() + SKY_IMAGE_CACHE_MS });
    while (skyImageCache.size > SKY_IMAGE_CACHE_MAX_ENTRIES) {
      const oldest = skyImageCache.keys().next().value;
      if (oldest === undefined) break;
      skyImageCache.delete(oldest);
    }
    return bytes;
  })().finally(() => {
    skyImageActiveUpstream = Math.max(0, skyImageActiveUpstream - 1);
    skyImageInflight.delete(id);
  });

  skyImageInflight.set(id, request);
  return request;
}

app.get("/api/chennai-aqi/sky/image/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d{1,10}$/.test(id)) {
    return c.json({ error: "invalid_sky_image_id", message: "Image ID must contain 1–10 digits." }, 400);
  }

  try {
    const bytes = await getChennaiSkyImage(id);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=900, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    const proxyError = error as SkyImageProxyError;
    const status = proxyError.status === 429 ? 429 : 502;
    return c.json({
      error: status === 429 ? "sky_image_proxy_busy" : "sky_image_upstream_unavailable",
      message: error instanceof Error ? error.message : "The source camera frame could not be fetched.",
      upstream_status: proxyError.upstreamStatus ?? null
    }, status);
  }
});

app.get("/api/chennai-aqi/sky", async (c) => {
  if (chennaiSkyCache && chennaiSkyCache.expiresAt > Date.now()) {
    c.header("X-AQI-Sky-Cache", "HIT");
    c.header("X-AQI-Sky-Fetched-At", chennaiSkyCache.fetchedAt);
    return c.json(chennaiSkyCache.payload, 200, { "Cache-Control": "public, max-age=60" });
  }

  let request = chennaiSkyRefresh;
  if (!request) {
    request = fetchChennaiSkySnapshot();
    chennaiSkyRefresh = request;
  }

  try {
    const snapshot = await request;
    if (chennaiSkyRefresh === request) {
      chennaiSkyCache = {
        payload: snapshot.payload,
        fetchedAt: snapshot.fetchedAt,
        expiresAt: Date.now() + CHENNAI_SKY_CACHE_MS
      };
    }
    c.header("X-AQI-Sky-Cache", "MISS");
    c.header("X-AQI-Sky-Fetched-At", snapshot.fetchedAt);
    return c.json(snapshot.payload, 200, { "Cache-Control": "public, max-age=60" });
  } catch (error) {
    console.warn("[CHENNAI-AQI] Sky dataset unavailable:", error instanceof Error ? error.message : "Unknown error");
    return c.json({
      error: "chennai_sky_dataset_unavailable",
      message: "The public Reclaim Chennai sky-camera dataset could not be retrieved.",
      detail: error instanceof Error ? error.message : "Unknown upstream error"
    }, 502);
  } finally {
    if (chennaiSkyRefresh === request) chennaiSkyRefresh = null;
  }
});

app.get("/api/chennai-aqi/source", (c) => c.json({
  source: "Reclaim Chennai",
  station_feed_configured: true,
  station_endpoint: "https://pol.reclaimchennai.city/api/stations",
  sky_endpoint: "https://pol.reclaimchennai.city/api/sky?hours=24",
  endpoint: CHENNAI_AQI_SOURCE_URL,
  map_center: [13.0833, 80.2667],
  map_zoom: 11,
  status: chennaiAqiCache && chennaiAqiCache.expiresAt > Date.now() ? "cached" : "unknown",
  fetched_at: chennaiAqiCache?.fetchedAt || null,
  historical_endpoint_verified: false
}));

app.get("/api/chennai-aqi/stations", async (c) => {
  if (chennaiAqiCache && chennaiAqiCache.expiresAt > Date.now()) {
    c.header("X-AQI-Source", "Reclaim Chennai");
    c.header("X-AQI-Cache", "HIT");
    c.header("X-AQI-Updated-At", chennaiAqiCache.fetchedAt);
    return c.json(chennaiAqiCache.payload, 200, { "Cache-Control": "public, max-age=30" });
  }

  // All callers arriving during a cache miss share one upstream request. Only
  // the promise that still owns this slot may publish a new cache snapshot.
  let refreshPromise = chennaiAqiRefreshPromise;
  if (!refreshPromise) {
    refreshPromise = fetchChennaiAqiSnapshot();
    chennaiAqiRefreshPromise = refreshPromise;
  }

  try {
    const snapshot = await refreshPromise;
    if (chennaiAqiRefreshPromise === refreshPromise) {
      chennaiAqiCache = {
        payload: snapshot.payload,
        fetchedAt: snapshot.fetchedAt,
        expiresAt: Date.now() + CHENNAI_AQI_CACHE_MS
      };
    }

    c.header("X-AQI-Source", "Reclaim Chennai");
    c.header("X-AQI-Cache", "MISS");
    c.header("X-AQI-Updated-At", snapshot.fetchedAt);
    return c.json(snapshot.payload, 200, { "Cache-Control": "public, max-age=30" });
  } catch (error) {
    const proxyError = error as ChennaiAqiProxyError;
    const status = proxyError.status || 503;
    const code = proxyError.code || "chennai_aqi_upstream_unavailable";
    const message = proxyError.status
      ? proxyError.message
      : "The Reclaim Chennai /api/stations feed is unavailable. No sample AQI values are substituted.";
    if (!proxyError.status) {
      console.warn("[CHENNAI-AQI] Upstream unavailable:", error instanceof Error ? error.message : "Unknown error");
    }
    return c.json({
      error: code,
      message,
      upstream_status: proxyError.upstreamStatus ?? null,
      detail: proxyError.status ? undefined : error instanceof Error ? error.message : "Unknown upstream network error"
    }, status as 424 | 502 | 503);
  } finally {
    if (chennaiAqiRefreshPromise === refreshPromise) {
      chennaiAqiRefreshPromise = null;
    }
  }
});

const CHENNAI_TREND_METRICS = new Set([
  "aqi_in", "aqi", "pm25", "pm10", "no2", "so2", "ozone", "co", "nh3",
  "noise", "temp_c", "wind_kph", "precip_mm", "rain_accum_mm"
]);
const chennaiTrendCache = new Map<string, { expiresAt: number; payload: unknown; fetchedAt: string }>();
const chennaiTrendInflight = new Map<string, Promise<{ payload: unknown; fetchedAt: string }>>();
const CHENNAI_TREND_CACHE_MAX_ENTRIES = 256;
const CHENNAI_TREND_MAX_BYTES = 5 * 1024 * 1024;
const CHENNAI_TREND_MAX_CONCURRENT_UPSTREAM = 6;
let chennaiTrendActiveUpstream = 0;

async function readChennaiTrendJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CHENNAI_TREND_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Reclaim Chennai trend API exceeded the 5 MiB response limit.");
  }
  if (!response.body) throw new Error("Reclaim Chennai trend API returned an empty body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > CHENNAI_TREND_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Reclaim Chennai trend API exceeded the 5 MiB response limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Reclaim Chennai trend API returned malformed JSON.");
  }
}

app.get("/api/chennai-aqi/trend", async (c) => {
  const metric = c.req.query("metric") || "aqi_in";
  const hours = Number(c.req.query("hours") || 24);
  const uid = c.req.query("uid") || "all";
  if (!CHENNAI_TREND_METRICS.has(metric)) {
    return c.json({ error: "invalid_metric", message: "Unsupported AQI trend metric." }, 400);
  }
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    return c.json({ error: "invalid_hours", message: "Trend hours must be an integer from 1 to 720." }, 400);
  }
  if (uid !== "all" && !/^[A-Za-z0-9_-]{1,64}$/.test(uid)) {
    return c.json({ error: "invalid_station_id", message: "Station ID contains unsupported characters." }, 400);
  }

  const cacheKey = metric + ":" + hours + ":" + uid;
  for (const [key, entry] of chennaiTrendCache) {
    if (entry.expiresAt <= Date.now()) chennaiTrendCache.delete(key);
  }
  const cached = chennaiTrendCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    c.header("X-AQI-Cache", "HIT");
    c.header("X-AQI-Updated-At", cached.fetchedAt);
    return c.json(cached.payload, 200, { "Cache-Control": "public, max-age=30" });
  }

  let request = chennaiTrendInflight.get(cacheKey);
  if (!request) {
    if (chennaiTrendActiveUpstream >= CHENNAI_TREND_MAX_CONCURRENT_UPSTREAM) {
      return c.json({
        error: "chennai_aqi_trend_busy",
        message: "The trend proxy is busy. Retry shortly."
      }, 429);
    }
    chennaiTrendActiveUpstream += 1;
    request = (async () => {
      const url = new URL("https://pol.reclaimchennai.city/api/trend");
      url.searchParams.set("metric", metric);
      url.searchParams.set("hours", String(hours));
      url.searchParams.set("uid", uid);
      const upstream = await fetch(url, {
        headers: {
          Accept: "application/json",
          Referer: "https://pol.reclaimchennai.city/",
          "User-Agent": "EVS0-Chennai-AQI-Proxy/1.0"
        },
        redirect: "error",
        signal: AbortSignal.timeout(12_000)
      });
      if (!upstream.ok) {
        const status = upstream.status;
        await upstream.body?.cancel().catch(() => {});
        throw new Error("Reclaim Chennai trend API returned HTTP " + status + ".");
      }
      const contentType = upstream.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("json")) {
        await upstream.body?.cancel().catch(() => {});
        throw new Error("Reclaim Chennai trend API returned non-JSON content.");
      }
      const payload: unknown = await readChennaiTrendJson(upstream);
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as { points?: unknown }).points)) {
        throw new Error("Reclaim Chennai trend API returned an invalid points payload.");
      }
      const source = payload as Record<string, unknown>;
      const points = (source.points as unknown[]).filter((point) =>
        point !== null &&
        typeof point === "object" &&
        typeof (point as { t?: unknown }).t === "string" &&
        Number.isFinite(Date.parse((point as { t: string }).t)) &&
        ((point as { med?: unknown }).med === null ||
          (typeof (point as { med?: unknown }).med === "number" && Number.isFinite((point as { med: number }).med)))
      );
      return {
        payload: { ...source, points },
        fetchedAt: new Date().toISOString()
      };
    })().finally(() => {
      chennaiTrendActiveUpstream = Math.max(0, chennaiTrendActiveUpstream - 1);
    });
    chennaiTrendInflight.set(cacheKey, request);
  }

  try {
    const snapshot = await request;
    if (chennaiTrendInflight.get(cacheKey) === request) {
      chennaiTrendCache.set(cacheKey, {
        payload: snapshot.payload,
        fetchedAt: snapshot.fetchedAt,
        expiresAt: Date.now() + 60_000
      });
      while (chennaiTrendCache.size > CHENNAI_TREND_CACHE_MAX_ENTRIES) {
        const oldest = chennaiTrendCache.keys().next().value;
        if (oldest === undefined) break;
        chennaiTrendCache.delete(oldest);
      }
    }
    c.header("X-AQI-Cache", "MISS");
    c.header("X-AQI-Updated-At", snapshot.fetchedAt);
    return c.json(snapshot.payload, 200, { "Cache-Control": "public, max-age=30" });
  } catch (error) {
    console.warn("[CHENNAI-AQI] Trend API unavailable:", error instanceof Error ? error.message : "Unknown error");
    return c.json({
      error: "chennai_aqi_trend_unavailable",
      message: error instanceof Error ? error.message : "Trend history is unavailable."
    }, 502);
  } finally {
    if (chennaiTrendInflight.get(cacheKey) === request) chennaiTrendInflight.delete(cacheKey);
  }
});

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
