const fs = require("node:fs");
const path = require("node:path");
const mqtt = require("mqtt");

const REPO_ROOT = path.resolve(__dirname, "..");

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function resolveBroker(env) {
  const override = (env.MQTT_URL || "").trim();
  let url;

  if (override) {
    url = new URL(override);
  } else {
    const protocol = (env.MQTT_PROTOCOL || "mqtts").trim().toLowerCase();
    const host = (env.MQTT_HOST || "").trim();
    if (!host) return null;

    const defaults = { mqtts: 8883, mqtt: 1883, wss: 8084, ws: 8083 };
    if (!Object.hasOwn(defaults, protocol)) {
      throw new Error("MQTT_PROTOCOL must be mqtts, mqtt, wss, or ws.");
    }

    const port = asPositiveInteger(env.MQTT_PORT, defaults[protocol]);
    url = new URL(protocol + "://" + host + ":" + port);
    if ((protocol === "wss" || protocol === "ws") && env.MQTT_PATH) {
      const mqttPath = env.MQTT_PATH.trim();
      url.pathname = mqttPath.startsWith("/") ? mqttPath : "/" + mqttPath;
    }
  }

  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  if (!["mqtts", "mqtt", "wss", "ws"].includes(protocol)) {
    throw new Error("MQTT_URL must use mqtts://, mqtt://, wss://, or ws://.");
  }

  if (!url.hostname) throw new Error("MQTT broker hostname is missing.");

  return {
    url: url.toString(),
    protocol,
    host: url.hostname,
    port: Number(url.port || ({ mqtts: 8883, mqtt: 1883, wss: 8084, ws: 8083 })[protocol]),
  };
}

function createMqttBridge(options) {
  const env = process.env;
  const deviceId = options.deviceId;
  const topicRoot = (env.MQTT_TOPIC_ROOT || "evs/v1/devices").replace(/^\/+|\/+$/g, "");
  const deviceRoot = topicRoot + "/" + deviceId;
  const topics = {
    telemetry: deviceRoot + "/telemetry",
    state: deviceRoot + "/state",
    availability: deviceRoot + "/availability",
    command: deviceRoot + "/command",
    commandAck: deviceRoot + "/command/ack",
  };

  const status = {
    configured: false,
    connected: false,
    reconnecting: false,
    protocol: null,
    broker: null,
    client_id: env.MQTT_MOCK_CLIENT_ID || ("cuspnode-mock-" + deviceId),
    auth_configured: Boolean(env.MQTT_USERNAME || env.MQTT_PASSWORD),
    last_connected_at: null,
    last_publish_at: null,
    last_error: null,
    publish_interval_ms: asPositiveInteger(env.MQTT_PUBLISH_INTERVAL_MS, 5000),
    topics,
  };

  let broker;
  let client;
  let publishTimer;
  let stopped = false;

  function getStatus() {
    return { ...status, topics: { ...topics } };
  }

  function publish(topic, payload, publishOptions = {}) {
    if (!client || !client.connected) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      client.publish(topic, JSON.stringify(payload), {
        qos: publishOptions.qos ?? 1,
        retain: publishOptions.retain ?? false,
      }, (error) => {
        if (error) {
          status.last_error = error.message;
          console.error("[MQTT] Publish failed:", error.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  async function publishAvailability(value) {
    return publish(topics.availability, {
      device_id: deviceId,
      status: value,
    }, { qos: 1, retain: true });
  }

  async function publishState() {
    return publish(topics.state, options.getState(), { qos: 1, retain: true });
  }

  async function publishTelemetry() {
    const published = await publish(topics.telemetry, options.getTelemetry(), {
      qos: 1,
      retain: false,
    });
    if (published) status.last_publish_at = new Date().toISOString();
    return published;
  }

  async function acknowledgeCommand(payload, reason) {
    const commandId = payload && typeof payload.command_id === "string"
      ? payload.command_id.slice(0, 128)
      : null;

    await publish(topics.commandAck, {
      command_id: commandId,
      status: "rejected",
      message: reason,
      device_id: deviceId,
      timestamp: new Date().toISOString(),
    }, { qos: 1, retain: false });
  }

  async function handleCommand(topic, rawPayload) {
    if (topic !== topics.command) return;

    let payload;
    try {
      payload = JSON.parse(rawPayload.toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Command must be a JSON object.");
      }
    } catch {
      await acknowledgeCommand(null, "Invalid command JSON.");
      return;
    }

    // The mock device is telemetry-only. Do not let broker messages change
    // Wi-Fi credentials, firmware settings, or any physical device state.
    await acknowledgeCommand(payload, "Remote commands are disabled in mock-device mode.");
  }

  function start() {
    if (client) return getStatus();

    try {
      broker = resolveBroker(env);
      if (!broker) {
        status.last_error = "MQTT_HOST or MQTT_URL is not configured.";
        console.warn("[MQTT] Disabled: " + status.last_error);
        return getStatus();
      }

      const mqttUsername = (env.MQTT_USERNAME || "").trim();
      const mqttPassword = env.MQTT_PASSWORD || "";
      const clientOptions = {
        clientId: status.client_id,
        username: mqttUsername || undefined,
        password: mqttUsername ? mqttPassword : undefined,
        protocolVersion: 4,
        clean: asBoolean(env.MQTT_CLEAN_SESSION, true),
        keepalive: asPositiveInteger(env.MQTT_KEEPALIVE_SECONDS, 60),
        connectTimeout: 15000,
        reconnectPeriod: asPositiveInteger(env.MQTT_RECONNECT_PERIOD_MS, 3000),
        reconnectOnConnackError: true,
        rejectUnauthorized: true,
        will: {
          topic: topics.availability,
          payload: JSON.stringify({ device_id: deviceId, status: "offline" }),
          qos: 1,
          retain: true,
        },
      };

      const caPath = (env.MQTT_CA_PATH || "").trim();
      if (caPath) {
        const resolvedCaPath = path.isAbsolute(caPath)
          ? caPath
          : path.resolve(REPO_ROOT, caPath);
        if (!fs.existsSync(resolvedCaPath)) {
          throw new Error("MQTT_CA_PATH does not exist: " + resolvedCaPath);
        }
        clientOptions.ca = fs.readFileSync(resolvedCaPath);
      }

      status.configured = true;
      status.protocol = broker.protocol;
      status.broker = broker.host + ":" + broker.port;
      status.last_error = null;

      console.log("[MQTT] Connecting to " + broker.protocol + "://" + status.broker);
      console.log("[MQTT] Client ID: " + status.client_id);
      console.log("[MQTT] Telemetry topic: " + topics.telemetry);

      client = mqtt.connect(broker.url, clientOptions);

      client.on("connect", async () => {
        status.connected = true;
        status.reconnecting = false;
        status.last_connected_at = new Date().toISOString();
        status.last_error = null;
        console.log("[MQTT] Connected to broker.");

        client.subscribe(topics.command, { qos: 1 }, (error) => {
          if (error) {
            status.last_error = error.message;
            console.error("[MQTT] Command subscription failed:", error.message);
          } else {
            console.log("[MQTT] Subscribed to " + topics.command);
          }
        });

        await publishAvailability("online");
        await publishState();
        await publishTelemetry();
      });

      client.on("reconnect", () => {
        status.connected = false;
        status.reconnecting = true;
        console.log("[MQTT] Reconnecting...");
      });

      client.on("offline", () => {
        status.connected = false;
        status.reconnecting = true;
        console.warn("[MQTT] Broker connection is offline.");
      });

      client.on("close", () => {
        status.connected = false;
        status.reconnecting = !stopped;
      });

      client.on("error", (error) => {
        status.last_error = error.message;
        console.error("[MQTT] " + error.message);
      });

      client.on("message", (topic, payload) => {
        void handleCommand(topic, payload).catch((error) => {
          status.last_error = error.message;
          console.error("[MQTT] Command handling failed:", error.message);
        });
      });

      publishTimer = setInterval(() => {
        if (client && client.connected) void publishTelemetry();
      }, status.publish_interval_ms);
      publishTimer.unref?.();
    } catch (error) {
      status.configured = false;
      status.last_error = error.message;
      console.error("[MQTT] Configuration error:", error.message);
    }

    return getStatus();
  }

  async function stop() {
    stopped = true;
    if (publishTimer) clearInterval(publishTimer);

    if (!client) return;
    if (client.connected) {
      await publishAvailability("offline");
    }
    await new Promise((resolve) => client.end(false, {}, resolve));
    client = null;
    status.connected = false;
    status.reconnecting = false;
  }

  return { start, stop, getStatus, publishState, publishTelemetry };
}

module.exports = { createMqttBridge };
