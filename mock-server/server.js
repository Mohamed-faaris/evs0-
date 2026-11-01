
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const dotenv = require("dotenv");

// Always load the repository-root .env, regardless of the current working directory.
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);
const DEVICE_ID = "device-001";
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

const uptimeSeconds = () => Math.floor((Date.now() - startedAt) / 1000);

function readSensor() {
  sensorSequence += 1;
  const rawADC = 1750 + Math.round(Math.sin(sensorSequence / 5) * 110);
  const adcVoltage = Number((rawADC / 4095 * 3.3).toFixed(3));
  return {
    valid: true,
    raw_adc: rawADC,
    adc_voltage_v: adcVoltage,
    estimated_sensor_ao_voltage_v: Number((adcVoltage * 1.5).toFixed(3)),
  };
}

function health() {
  const sensor = readSensor();
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
    mqtt: { configured: false, connected: false },
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
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CuspNode Mock Server</title>
<style>
body{font:15px system-ui;background:#0b1220;color:#e5e7eb;margin:0;padding:28px}
main{max-width:850px;margin:auto}section{background:#151f30;border:1px solid #334155;border-radius:12px;padding:18px;margin:14px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#bae6fd}a{color:#7dd3fc}
input,button{padding:10px;margin:5px 4px 5px 0;border-radius:7px;border:1px solid #475569}
button{background:#0284c7;color:white;border:0;cursor:pointer}
</style></head><body><main>
<h1>CuspNode MQ-135 — Mock Device</h1>
<p>Simulated data only. No physical ESP32 or MQ-135 is connected.</p>
<section><h2>Health</h2><pre id="health">Loading...</pre></section>
<section><h2>MQ-135</h2><pre id="sensor">Loading...</pre></section>
<section><h2>Saved Wi-Fi</h2><pre id="wifi">Loading...</pre>
<form id="add"><input id="ssid" placeholder="SSID" maxlength="32" required>
<input id="password" placeholder="Password" type="password" maxlength="63">
<button>Save network</button></form>
<form id="remove"><input id="removeSsid" placeholder="SSID to remove" required>
<button>Remove network</button></form></section>
<section><h2>API</h2>
<p><a href="/api/health">/api/health</a> · <a href="/api/mq135">/api/mq135</a></p>
<p><a href="/api/wifi">/api/wifi</a> · <a href="/api/wifi/scan">/api/wifi/scan</a></p></section>
</main><script>
async function refresh(){
 const [h,s,w]=await Promise.all(["/api/health","/api/mq135","/api/wifi"].map(p=>fetch(p).then(r=>r.json())));
 document.querySelector("#health").textContent=JSON.stringify(h,null,2);
 document.querySelector("#sensor").textContent=JSON.stringify(s,null,2);
 document.querySelector("#wifi").textContent=JSON.stringify(w,null,2);
}
document.querySelector("#add").addEventListener("submit",async e=>{
 e.preventDefault();
 const r=await fetch("/api/wifi/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ssid:document.querySelector("#ssid").value,password:document.querySelector("#password").value})});
 alert(r.ok?"Network saved":"Could not save network");document.querySelector("#password").value="";refresh();
});
document.querySelector("#remove").addEventListener("submit",async e=>{
 e.preventDefault();
 const r=await fetch("/api/wifi/remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ssid:document.querySelector("#removeSsid").value})});
 alert(r.ok?"Network removed":"Could not remove network");refresh();
});
refresh();setInterval(refresh,3000);
</script></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
      }
      return sendJson(res, 200, { status: "removed" });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  return sendError(res, 404, "Route not found.");
});

server.listen(PORT, HOST, () => {
  console.log("[MOCK] CuspNode mock server listening at http://" + HOST + ":" + PORT);
  console.log("[MOCK] Endpoints: /api/health /api/mq135 /api/wifi /api/wifi/scan");
  console.log("[MOCK] Wi-Fi changes are in-memory; sensor values are simulated.");
});
