const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { randomUUID } = require("node:crypto");
const dotenv = require("dotenv");
const { createMqttBridge } = require("./mqtt-client");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);
const DEVICE_ID = process.env.DEVICE_ID || "device-001";
const POWER_METER_DEVICE_ID = process.env.POWER_METER_DEVICE_ID || "power-meter-001";
const POWER_METER_SESSION_ID = randomUUID();
const HOTSPOT_SSID = "cuspnode-mq135";
const HOTSPOT_IP = "192.168.4.1";
const MAX_WIFI_NETWORKS = 10;
const startedAt = Date.now();

const savedNetworks = new Map([
  ["faaris", { password: "mock-password" }],
  ["Faaris", { password: "" }],
]);
const nearbyNetworks = [
  { ssid: "faaris", rssi: -48 },
  { ssid: "Faaris", rssi: -65 },
  { ssid: "Home-WiFi", rssi: -72 },
  { ssid: "Guest-WiFi", rssi: -83 },
];

let wifiConnected = true;
let connectedSSID = "faaris";
let sensorSequence = 0;
let powerMeterSequence = 0;
let powerEnergyKwh = 0;
let lastPowerSampleAt = startedAt;
const powerMeterStartedAt = Date.now();
const uptimeSeconds = () => Math.floor((Date.now() - startedAt) / 1000);

let latestSensorReading = {
  valid: true,
  raw_adc: 1750,
  adc_voltage_v: Number((1750 / 4095 * 3.3).toFixed(3)),
  estimated_sensor_ao_voltage_v: Number((1750 / 4095 * 3.3 * 1.5).toFixed(3)),
};

// Advance the mock sensor once per MQTT telemetry sample, not on HTTP reads.
// This keeps the graph independent of dashboard polling frequency.
function sampleSensor() {
  sensorSequence += 1;

  // Model a slowly drifting baseline with bounded, low-amplitude sensor noise.
  // Avoid a fast sine wave: it looks like a fault in the live chart.
  const baseline = 1750 + 35 * Math.sin(sensorSequence / 60);
  const previous = latestSensorReading.raw_adc;
  const meanReverted = previous + (baseline - previous) * 0.18;
  const noise = (Math.random() - 0.5) * 28;
  const rawADC = Math.max(100, Math.min(4000, Math.round(meanReverted + noise)));
  const adcVoltage = Number((rawADC / 4095 * 3.3).toFixed(3));

  latestSensorReading = {
    valid: true,
    raw_adc: rawADC,
    adc_voltage_v: adcVoltage,
    estimated_sensor_ao_voltage_v: Number((adcVoltage * 1.5).toFixed(3)),
  };
  return latestSensorReading;
}

function readSensor() {
  return latestSensorReading;
}

function buildTelemetry() {
  const sensor = sampleSensor();
  return {
    schema_version: 1,
    device_id: DEVICE_ID,
    sensor: "MQ-135",
    timestamp: new Date().toISOString(),
    uptime_seconds: uptimeSeconds(),
    sequence: sensorSequence,
    readings: {
      raw_adc: sensor.raw_adc,
      adc_pin_voltage_v: sensor.adc_voltage_v,
      sensor_ao_voltage_v: sensor.estimated_sensor_ao_voltage_v,
      ppm: null,
    },
    valid: sensor.valid,
  };
}

function buildDeviceState() {
  return {
    schema_version: 1,
    device_id: DEVICE_ID,
    state: wifiConnected ? "WIFI_CONNECTED" : "NO_WIFI",
    uptime_seconds: uptimeSeconds(),
    network: {
      wifi_connected: wifiConnected,
      wifi_ssid: wifiConnected ? connectedSSID : "",
      hotspot_active: true,
    },
    sensor: { model: "MQ-135", valid: true },
    mqtt: { connected: mqttBridge.getStatus().connected },
  };
}

function buildPowerMeterTelemetry() {
  const now = Date.now();
  const elapsedHours = Math.max(0, now - lastPowerSampleAt) / 3600000;
  lastPowerSampleAt = now;

  // Synthetic single-phase mains values. These are demonstration values,
  // not measurements from a real CT clamp, energy IC, or utility meter.
  const voltage = 230 + 1.8 * Math.sin(now / 47000);
  const current = 1.35 + 0.38 * (0.5 + 0.5 * Math.sin(now / 16000)) +
    0.10 * Math.sin(now / 4100);
  const powerFactor = 0.92 + 0.025 * Math.sin(now / 29000);
  const apparentPower = voltage * current;
  const activePower = apparentPower * powerFactor;
  const reactivePower = Math.sqrt(Math.max(0, apparentPower ** 2 - activePower ** 2));

  powerEnergyKwh += activePower * elapsedHours / 1000;
  powerMeterSequence += 1;

  return {
    schema_version: 1,
    device_id: POWER_METER_DEVICE_ID,
    device_type: "power_meter",
    meter_model: "single_phase_ac_mock",
    session_id: POWER_METER_SESSION_ID,
    timestamp: new Date(now).toISOString(),
    uptime_seconds: Math.floor((now - powerMeterStartedAt) / 1000),
    sequence: powerMeterSequence,
    readings: {
      voltage_v: Number(voltage.toFixed(2)),
      current_a: Number(current.toFixed(3)),
      active_power_w: Number(activePower.toFixed(1)),
      apparent_power_va: Number(apparentPower.toFixed(1)),
      reactive_power_var: Number(reactivePower.toFixed(1)),
      power_factor: Number(powerFactor.toFixed(3)),
      frequency_hz: Number((50 + 0.025 * Math.sin(now / 53000)).toFixed(2)),
      energy_kwh: Number(powerEnergyKwh.toFixed(5))
    },
    valid: true
  };
}

function buildPowerMeterState() {
  return {
    schema_version: 1,
    device_id: POWER_METER_DEVICE_ID,
    device_type: "power_meter",
    session_id: POWER_METER_SESSION_ID,
    state: "SIMULATED_ONLINE",
    uptime_seconds: Math.floor((Date.now() - powerMeterStartedAt) / 1000),
    meter: { model: "single_phase_ac_mock", valid: true },
    mqtt: { connected: powerMeterBridge.getStatus().connected }
  };
}

const mqttBridge = createMqttBridge({
  deviceId: DEVICE_ID,
  getTelemetry: buildTelemetry,
  getState: buildDeviceState,
});

const powerMeterBridge = createMqttBridge({
  deviceId: POWER_METER_DEVICE_ID,
  clientId: process.env.MQTT_POWER_METER_CLIENT_ID || "cuspnode-mock-power-meter-001",
  publishIntervalMs: process.env.MQTT_POWER_METER_PUBLISH_INTERVAL_MS,
  getTelemetry: buildPowerMeterTelemetry,
  getState: buildPowerMeterState
});

function health() {
  const sensor = readSensor();
  const mqtt = mqttBridge.getStatus();
  const powerMqtt = powerMeterBridge.getStatus();
  return {
    status: "ok",
    device_id: DEVICE_ID,
    state: wifiConnected ? "WIFI_CONNECTED" : "NO_WIFI",
    uptime_seconds: uptimeSeconds(),
    wifi: {
      connected: wifiConnected,
      ssid: wifiConnected ? connectedSSID : "",
      ip: wifiConnected ? "192.168.29.186" : "",
    },
    hotspot: { active: true, ssid: HOTSPOT_SSID, ip: HOTSPOT_IP, clients: 1 },
    sensor: {
      valid: sensor.valid,
      raw_adc: sensor.raw_adc,
      adc_voltage_v: sensor.adc_voltage_v,
    },
    mqtt: {
      configured: mqtt.configured,
      connected: mqtt.connected,
      reconnecting: mqtt.reconnecting,
      protocol: mqtt.protocol,
      broker: mqtt.broker,
      client_id: mqtt.client_id,
      auth_configured: mqtt.auth_configured,
      last_connected_at: mqtt.last_connected_at,
      last_publish_at: mqtt.last_publish_at,
      last_error: mqtt.last_error,
      publish_interval_ms: mqtt.publish_interval_ms,
      power_meter: {
        device_id: POWER_METER_DEVICE_ID,
        configured: powerMqtt.configured,
        connected: powerMqtt.connected,
        reconnecting: powerMqtt.reconnecting,
        client_id: powerMqtt.client_id,
        last_publish_at: powerMqtt.last_publish_at,
        last_error: powerMqtt.last_error,
        publish_interval_ms: powerMqtt.publish_interval_ms
      }
    },
  };
}

function mq135() {
  const sensor = readSensor();
  return {
    status: sensor.valid ? "ok" : "invalid",
    device_id: DEVICE_ID,
    sensor: "MQ-135",
    raw_adc: sensor.raw_adc,
    adc_pin_voltage_v: sensor.adc_voltage_v,
    estimated_sensor_ao_voltage_v: sensor.estimated_sensor_ao_voltage_v,
    ppm: null,
    uptime_seconds: uptimeSeconds(),
  };
}

function wifiList() {
  const networks = [...savedNetworks.keys()].map((ssid) => ({
    ssid,
    connected: wifiConnected && ssid === connectedSSID,
  }));
  return { networks, count: networks.length, max: MAX_WIFI_NETWORKS };
}

function wifiScan() {
  return {
    networks: nearbyNetworks.map((network) => ({
      ...network,
      saved: savedNetworks.has(network.ssid),
    })),
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { status: "error", message });
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16384) throw new Error("Request body too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function sendPortal(res) {
  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>CuspNode — Mock Device</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Pixelify+Sans:wght@700&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme:light;
  --bg:#f4f1ea;--panel:#fff;--cell:#f3efe6;--cell-2:#d9d3c5;
  --edge:#1f2229;--text:#1b1d22;--text-2:#4a505c;--text-3:#5c6270;
  --accent:#8a5a00;--accent-bg:#ffd84a;--link:#1f5fae;--warn:#c42b2b;
  --warn-bg:#fdeaea;--ok:#2e7d32;--track:#e7e2d6;
  --stone:#5b6070;--stone-hi:#8a90a0;--stone-lo:#3a3e49;
  --stone-on:#3d6fc2;--stone-on-hi:#6f99e0;--stone-on-lo:#274c8c;
  --bevel:inset 2px 2px 0 var(--stone-hi),inset -2px -2px 0 var(--stone-lo);
  --shadow:3px 3px 0 rgba(31,34,41,.25);
}
html[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0b0d14;--panel:#141824;--cell:#1d2232;--cell-2:#282f44;
  --edge:#05060a;--text:#f5f1e6;--text-2:#b9c1d3;--text-3:#9aa3bb;
  --accent:#ffd84a;--accent-bg:#ffd84a;--link:#6cc8ff;--warn:#ff8f87;
  --warn-bg:#3a1717;--ok:#7ed98b;--track:#262c3e;
  --stone:#6d7079;--stone-hi:#9ca0a8;--stone-lo:#3d4047;
  --stone-on:#7e86c9;--stone-on-hi:#a5acdf;--stone-on-lo:#4f5693;
  --shadow:3px 3px 0 rgba(0,0,0,.45);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input{font:inherit}
a{color:var(--link);text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
button{min-height:44px;padding:9px 14px;color:var(--text);background:var(--stone);border:3px solid var(--edge);box-shadow:var(--bevel);font-weight:700;cursor:pointer}
button:hover{filter:brightness(1.08)}
button:active{box-shadow:inset 2px 2px 0 var(--stone-lo),inset -2px -2px 0 var(--stone-hi);transform:translate(1px,1px)}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--link);outline-offset:2px}
input{width:100%;min-width:0;min-height:44px;padding:10px 11px;color:var(--text);background:var(--panel);border:3px solid var(--edge);box-shadow:inset 2px 2px 0 var(--cell-2)}
input::placeholder{color:var(--text-3)}
.shell{max-width:1180px;margin:0 auto;padding:24px 20px 40px}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:18px 0 20px;border-bottom:3px solid var(--edge)}
.brand{display:flex;align-items:flex-start;gap:14px;min-width:0}
.brand-mark{display:grid;place-items:center;flex:0 0 42px;height:42px;background:var(--accent-bg);border:3px solid var(--edge);box-shadow:var(--shadow);color:#1b1d22;font-weight:800;font-size:20px}
h1{margin:0;font:700 28px/1.1 "Pixelify Sans",Inter,sans-serif;letter-spacing:.01em}
.subtitle{margin:7px 0 0;color:var(--text-2);font-size:13px}
.top-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.simulated{display:inline-flex;align-items:center;gap:7px;padding:6px 9px;background:var(--warn-bg);border:2px solid var(--warn);color:var(--warn);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.simulated::before{content:"";width:7px;height:7px;background:currentColor}
#themeToggle{white-space:nowrap}
.overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0}
.metric{min-width:0;background:var(--panel);border:2px solid var(--edge);box-shadow:inset 2px 2px 0 var(--cell-2);padding:13px 14px}
.metric-label{color:var(--text-3);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.metric-value{display:block;margin-top:5px;font-size:20px;font-weight:800;overflow-wrap:anywhere}
.metric-note{margin-top:2px;color:var(--text-2);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
section{min-width:0;padding:15px;background:var(--panel);border:2px solid var(--edge);box-shadow:var(--shadow)}
section.wide{grid-column:1/-1}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}
h2{margin:0;font-size:13px;line-height:1.3;font-weight:800;letter-spacing:.07em;text-transform:uppercase}
.section-tag{padding:3px 7px;background:var(--cell);border:1px solid var(--cell-2);color:var(--text-2);font-size:11px;font-weight:700}
pre{margin:0;max-height:340px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--cell);border:1px solid var(--cell-2);color:var(--text);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
.forms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
form{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
form input{flex:1 1 150px}
form button{flex:0 0 auto}
.api-links{display:flex;gap:12px;flex-wrap:wrap}
.api-links a{overflow-wrap:anywhere}
.footnote{margin:18px 0 0;color:var(--text-3);font-size:12px}
@media(max-width:820px){
  .shell{padding:16px 12px 28px}
  .topbar{align-items:flex-start}
  .grid{grid-template-columns:1fr}
  section.wide{grid-column:auto}
}
@media(max-width:560px){
  .topbar{flex-direction:column}
  .top-actions{width:100%;justify-content:space-between}
  .overview{grid-template-columns:1fr}
  .forms{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">C</div>
      <div>
        <h1>CuspNode / Mock Device</h1>
        <p class="subtitle">MQ-135 telemetry simulator · <span id="deviceId">device-001</span></p>
      </div>
    </div>
    <div class="top-actions">
      <span class="simulated">Simulated data</span>
      <button id="themeToggle" type="button" aria-label="Switch colour theme">Dark theme</button>
    </div>
  </header>

  <div class="overview" aria-label="Current device summary">
    <div class="metric"><span class="metric-label">Device state</span><strong class="metric-value" id="stateValue">Loading</strong><div class="metric-note">Simulated network state</div></div>
    <div class="metric"><span class="metric-label">MQTT session</span><strong class="metric-value" id="mqttValue">Loading</strong><div class="metric-note" id="mqttNote">Broker connection status</div></div>
    <div class="metric"><span class="metric-label">MQ-135 raw ADC</span><strong class="metric-value" id="adcValue">—</strong><div class="metric-note">12-bit simulated reading</div></div>
  </div>

  <div class="grid">
    <section>
      <div class="section-head"><h2>Device health</h2><span class="section-tag">HTTP API</span></div>
      <pre id="health">Loading...</pre>
    </section>
    <section>
      <div class="section-head"><h2>MQ-135 telemetry</h2><span class="section-tag">Simulated</span></div>
      <pre id="sensor">Loading...</pre>
    </section>
    <section>
      <div class="section-head"><h2>MQTT bridge</h2><span class="section-tag">EMQX / broker</span></div>
      <pre id="mqtt">Loading...</pre>
    </section>
    <section>
      <div class="section-head"><h2>Saved Wi-Fi networks</h2><span class="section-tag">In-memory mock</span></div>
      <pre id="wifi">Loading...</pre>
      <div class="forms">
        <form id="add">
          <input id="ssid" placeholder="Network SSID" maxlength="32" aria-label="Network SSID" required>
          <input id="password" placeholder="Password" type="password" maxlength="63" aria-label="Network password">
          <button type="submit">Save network</button>
        </form>
        <form id="remove">
          <input id="removeSsid" placeholder="SSID to remove" aria-label="SSID to remove" required>
          <button type="submit">Remove network</button>
        </form>
      </div>
    </section>
    <section class="wide">
      <div class="section-head"><h2>API endpoints</h2><span class="section-tag">Local development</span></div>
      <div class="api-links">
        <a href="/api/health">/api/health</a>
        <a href="/api/mq135">/api/mq135</a>
        <a href="/api/mqtt">/api/mqtt</a>
        <a href="/api/wifi">/api/wifi</a>
        <a href="/api/wifi/scan">/api/wifi/scan</a>
      </div>
    </section>
  </div>
  <p class="footnote">No physical ESP32 or MQ-135 is connected. Sensor, Wi-Fi and hotspot values are simulated; MQTT is a real broker connection when configured.</p>
</main>
<script>
const root=document.documentElement;
const themeButton=document.querySelector("#themeToggle");
function applyTheme(theme){
  root.dataset.theme=theme;
  themeButton.textContent=theme==="dark"?"Light theme":"Dark theme";
  themeButton.setAttribute("aria-label",theme==="dark"?"Switch to light theme":"Switch to dark theme");
}
const savedTheme=localStorage.getItem("cuspnode-theme");
applyTheme(savedTheme||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));
themeButton.addEventListener("click",()=>{
  const next=root.dataset.theme==="dark"?"light":"dark";
  localStorage.setItem("cuspnode-theme",next);
  applyTheme(next);
});
async function getJson(path){
  const response=await fetch(path,{cache:"no-store"});
  if(!response.ok) throw new Error(path+" returned HTTP "+response.status);
  return response.json();
}
async function refresh(){
  try{
    const [h,s,w,m]=await Promise.all([
      getJson("/api/health"),getJson("/api/mq135"),getJson("/api/wifi"),getJson("/api/mqtt")
    ]);
    document.querySelector("#health").textContent=JSON.stringify(h,null,2);
    document.querySelector("#sensor").textContent=JSON.stringify(s,null,2);
    document.querySelector("#wifi").textContent=JSON.stringify(w,null,2);
    document.querySelector("#mqtt").textContent=JSON.stringify(m,null,2);
    document.querySelector("#deviceId").textContent=h.device_id||"unknown";
    document.querySelector("#stateValue").textContent=h.state||"UNKNOWN";
    document.querySelector("#mqttValue").textContent=m.connected?"CONNECTED":(m.configured?"DISCONNECTED":"NOT CONFIGURED");
    document.querySelector("#mqttNote").textContent=m.broker||m.last_error||"Broker connection status";
    document.querySelector("#adcValue").textContent=String(s.raw_adc??"—");
  }catch(error){
    document.querySelector("#health").textContent="API unavailable: "+error.message;
  }
}
document.querySelector("#add").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=e.currentTarget;
  const response=await fetch("/api/wifi/add",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ssid:document.querySelector("#ssid").value,password:document.querySelector("#password").value})
  });
  const data=await response.json();
  alert(response.ok?"Network saved":"Could not save network: "+(data.message||"unknown error"));
  document.querySelector("#password").value="";
  if(response.ok) form.reset();
  refresh();
});
document.querySelector("#remove").addEventListener("submit",async e=>{
  e.preventDefault();
  const response=await fetch("/api/wifi/remove",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ssid:document.querySelector("#removeSsid").value})
  });
  const data=await response.json();
  alert(response.ok?"Network removed":"Could not remove network: "+(data.message||"unknown error"));
  if(response.ok) e.currentTarget.reset();
  refresh();
});
refresh();
setInterval(refresh,3000);
</script>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") return sendPortal(res);
  if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, health());
  if (req.method === "GET" && url.pathname === "/api/mq135") return sendJson(res, 200, mq135());
  if (req.method === "GET" && url.pathname === "/api/mqtt") return sendJson(res, 200, { mq135: mqttBridge.getStatus(), power_meter: powerMeterBridge.getStatus() });
  if (req.method === "GET" && url.pathname === "/api/wifi") return sendJson(res, 200, wifiList());
  if (req.method === "GET" && url.pathname === "/api/wifi/scan") return sendJson(res, 200, wifiScan());

  if (req.method === "POST" && url.pathname === "/api/wifi/add") {
    try {
      const { ssid = "", password = "" } = await readJson(req);
      if (typeof ssid !== "string" || typeof password !== "string" || !ssid.trim() || ssid.length > 32 || password.length > 63) {
        return sendError(res, 400, "Invalid network or storage full.");
      }
      if (!savedNetworks.has(ssid) && savedNetworks.size >= MAX_WIFI_NETWORKS) {
        return sendError(res, 400, "Invalid network or storage full.");
      }
      savedNetworks.set(ssid, { password });
      return sendJson(res, 200, { status: "saved", ssid });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/wifi/remove") {
    try {
      const { ssid = "" } = await readJson(req);
      if (typeof ssid !== "string" || !savedNetworks.has(ssid)) {
        return sendError(res, 404, "Saved network not found.");
      }
      savedNetworks.delete(ssid);
      if (connectedSSID === ssid) {
        wifiConnected = false;
        connectedSSID = "";
        await mqttBridge.publishState();
      }
      return sendJson(res, 200, { status: "removed" });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  return sendError(res, 404, "Route not found.");
});

mqttBridge.start();
powerMeterBridge.start();

server.listen(PORT, HOST, () => {
  console.log("[MOCK] CuspNode mock server listening at http://" + HOST + ":" + PORT);
  console.log("[MOCK] Endpoints: /api/health /api/mq135 /api/mqtt /api/wifi /api/wifi/scan");
  console.log("[MOCK] Power meter device: " + POWER_METER_DEVICE_ID + " -> " + (process.env.MQTT_TOPIC_ROOT || "evs/v1/devices") + "/" + POWER_METER_DEVICE_ID + "/telemetry");
  console.log("[MOCK] Sensor and Wi-Fi values are simulated; MQTT publishes to the configured broker.");
});

async function shutdown(signal) {
  console.log("[MOCK] " + signal + " received; shutting down.");
  server.close();
  await Promise.all([mqttBridge.stop(), powerMeterBridge.stop()]);
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
