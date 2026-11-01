import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env") });

function required(name: string, value: string | undefined): string {
  const result = value?.trim();
  if (!result) throw new Error(`Missing ${name} in repository-root .env`);
  return result;
}

function parseBroker() {
  if (process.env.MQTT_URL?.trim()) {
    const url = new URL(process.env.MQTT_URL.trim());
    if (!["mqtt:", "mqtts:"].includes(url.protocol)) {
      throw new Error("MQTT_URL must use mqtt:// or mqtts:// for ESP32 provisioning.");
    }
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "mqtts:" ? 8883 : 1883)),
      protocol: url.protocol === "mqtts:" ? "mqtts" : "mqtt",
    };
  }

  const protocol = (process.env.MQTT_PROTOCOL || "mqtts").trim();
  if (protocol !== "mqtt" && protocol !== "mqtts") {
    throw new Error("ESP32 firmware supports MQTT_PROTOCOL=mqtt or mqtts.");
  }
  const host = required("MQTT_HOST", process.env.MQTT_HOST);
  const port = Number(process.env.MQTT_PORT || (protocol === "mqtts" ? 8883 : 1883));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MQTT_PORT must be an integer between 1 and 65535.");
  }
  return { host, port, protocol };
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const devicePath = getArg("--port") || process.env.ESP32_PORT;
  if (!devicePath) {
    const ports = await SerialPort.list();
    console.log("Available serial ports:");
    for (const port of ports) console.log(`  ${port.path}${port.manufacturer ? ` — ${port.manufacturer}` : ""}`);
    throw new Error("Pass --port /dev/ttyUSB0 or set ESP32_PORT in .env.");
  }

  const broker = parseBroker();
  const username = process.env.MQTT_USERNAME || "";
  const password = process.env.MQTT_PASSWORD || "";
  if (username.includes(" ") || username.includes("\n") || password.includes("\n") || password.includes("\r")) {
    throw new Error("MQTT username cannot contain spaces; password cannot contain newlines.");
  }
  if (password && !username) throw new Error("MQTT_USERNAME is required when MQTT_PASSWORD is set.");

  const port = new SerialPort({ path: devicePath, baudRate: 115200, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));

  const send = async (command: string, waitMs = 450) => {
    await new Promise<void>((resolve, reject) => port.write(command + "\n", error => {
      if (error) reject(error);
      else port.drain(drainError => drainError ? reject(drainError) : resolve());
    }));
    await new Promise(resolve => setTimeout(resolve, waitMs));
  };

  let output = "";
  port.on("data", chunk => {
    const line = chunk.toString("utf8");
    output += line;
    process.stdout.write(line);
  });

  try {
    console.log(`\nProvisioning ${devicePath} at 115200 baud`);
    console.log(`Broker: ${broker.protocol}://${broker.host}:${broker.port}`);
    await send("", 1200);
    await send(`mqtt set-server ${broker.host} ${broker.port}`);
    await send(`mqtt set-protocol ${broker.protocol}`);
    if (username) await send(`mqtt set-auth ${username} ${password}`);
    else await send("mqtt clear-auth");
    await send("mqtt enable");
    await send("mqtt status", 700);
    console.log("\nProvisioning commands sent. MQTT values are stored in ESP32 NVS.");
    console.log("This firmware build provisions settings only; it does not yet connect/publish MQTT.");
  } finally {
    await new Promise<void>(resolve => port.close(() => resolve()));
  }
}

main().catch(error => {
  console.error("[PROVISION]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
