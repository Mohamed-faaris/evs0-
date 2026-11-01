import { useEffect, useMemo, useState } from "react";
import { Activity, BrainCircuit, Wind, Radio, Gauge, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Reading = { device_id: string; sensor?: string; timestamp?: string | null; received_at: string; uptime_seconds?: number; valid?: boolean; readings?: { raw_adc?: number; adc_pin_voltage_v?: number; sensor_ao_voltage_v?: number; ppm?: number | null } };
type Device = { device_id: string; availability?: { status: string; received_at: string } | null; latest?: Reading | null };
const API = import.meta.env.VITE_API_BASE || "";
const fmt = (n?: number, digits = 2) => n == null ? "—" : n.toFixed(digits);
export default function App() {
  const [tab, setTab] = useState<"live" | "predictions">("live");
  const [reading, setReading] = useState<Reading | null>(null);
  const [history, setHistory] = useState<Reading[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [apiOnline, setApiOnline] = useState(false);
  const [updated, setUpdated] = useState("");
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true);
    try {
      const [latestRes, historyRes, devicesRes] = await Promise.all([
        fetch(API + "/api/readings/latest"), fetch(API + "/api/readings/history?limit=100"), fetch(API + "/api/devices")
      ]);
      if (!latestRes.ok || !historyRes.ok || !devicesRes.ok) throw new Error("API request failed");
      const latest = await latestRes.json(), hist = await historyRes.json(), dev = await devicesRes.json();
      setReading(latest.data); setHistory(hist.data || []); setDevices(dev || []); setApiOnline(true); setUpdated(new Date().toLocaleTimeString());
    } catch { setApiOnline(false); } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);
  const chartData = useMemo(() => history.map((r, i) => ({
    time: r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : new Date(r.received_at).toLocaleTimeString(),
    adc: r.readings?.raw_adc ?? null, voltage: r.readings?.adc_pin_voltage_v ?? null, index: i
  })), [history]);
  const online = devices.some(d => d.availability?.status === "online");
  const sensor = reading?.readings;
  return <main className="shell">
    <header className="topbar"><div className="brand"><div className="brandmark"><Wind size={22}/></div><div><strong>EVS<span>0</span></strong><small>ENVIRONMENTAL MONITORING</small></div></div><div className="topright"><span className={apiOnline ? "status good" : "status bad"}><i/>{apiOnline ? "API CONNECTED" : "API OFFLINE"}</span><button className="iconbtn" onClick={refresh} aria-label="Refresh"><RefreshCw size={17} className={loading ? "spin" : ""}/></button></div></header>
    <section className="intro"><div><div className="eyebrow">ENVIRONMENTAL INTELLIGENCE / TRICHY</div><h1>Air Quality <em>Dashboard</em></h1><p>Live sensor telemetry and predictive environmental insights.</p></div><div className="updated">LAST SYNC <strong>{updated || "Waiting for data"}</strong></div></section>
    <nav className="tabs"><button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}><Activity size={16}/> Live Monitoring</button><button className={tab === "predictions" ? "active" : ""} onClick={() => setTab("predictions")}><BrainCircuit size={16}/> AI Predictions</button></nav>
    {tab === "live" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">LIVE TELEMETRY</div><h2>Sensor overview</h2></div><span className="livepill"><i/> AUTO REFRESH · 3 SEC</span></div>
      <div className="notice"><strong>AQI NOT AVAILABLE</strong><span>MQ-135 provides a broad gas-response signal. It cannot independently produce official CPCB AQI or PM2.5/PM10 values.</span></div>
      <div className="metrics">
        <article className="metric heroMetric"><div className="metriclabel"><Gauge size={16}/> OFFICIAL AQI</div><div className="metricvalue">—</div><div className="metricfoot">Requires calibrated pollutant sensors</div><div className="metricbar"><span/></div></article>
        <article className="metric"><div className="metriclabel">MQ-135 RAW ADC</div><div className="metricvalue">{sensor?.raw_adc ?? "—"}</div><div className="metricfoot">12-bit ADC · 0–4095</div></article>
        <article className="metric"><div className="metriclabel">ADC VOLTAGE</div><div className="metricvalue">{fmt(sensor?.adc_pin_voltage_v, 3)}<small> V</small></div><div className="metricfoot">Measured at ESP32 pin</div></article>
        <article className="metric"><div className="metriclabel">SENSOR AO EST.</div><div className="metricvalue">{fmt(sensor?.sensor_ao_voltage_v, 3)}<small> V</small></div><div className="metricfoot">Calculated from divider ratio</div></article>
      </div>
      <div className="grid2"><article className="panel"><div className="panelhead"><div><div className="eyebrow">SENSOR SIGNAL</div><h3>ADC history</h3></div><span className="unit">RAW COUNTS</span></div>{chartData.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><defs><linearGradient id="fillAdc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d49a16" stopOpacity={.3}/><stop offset="95%" stopColor="#d49a16" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/><XAxis dataKey="time" tick={{fontSize:10}} minTickGap={28}/><YAxis tick={{fontSize:10}} width={42}/><Tooltip/><Area type="monotone" dataKey="adc" stroke="#a56e00" fill="url(#fillAdc)" strokeWidth={2} connectNulls/></AreaChart></ResponsiveContainer></div> : <div className="empty">Waiting for MQTT telemetry…</div>}</article>
      <article className="panel"><div className="panelhead"><div><div className="eyebrow">DEVICE STATUS</div><h3>Connected nodes</h3></div><Radio size={18}/></div>{devices.length ? devices.map(d=><div className="device" key={d.device_id}><div className="deviceicon"><Radio size={18}/></div><div className="deviceinfo"><strong>{d.device_id}</strong><small>MQ-135 · {d.latest?.valid ? "Sensor valid" : "No valid reading"}</small></div><span className={d.availability?.status === "online" ? "status good" : "status muted"}><i/>{d.availability?.status || "UNKNOWN"}</span></div>) : <div className="empty">No devices have published telemetry yet.</div>}<div className="devicefoot"><span>{online ? <Wifi size={14}/> : <WifiOff size={14}/>} Broker presence</span><strong>{online ? "ONLINE" : "NOT REPORTED"}</strong></div></article></div>
      <div className="sourcefoot">DATA SOURCE: MQTT TELEMETRY · {reading?.device_id || "NO DEVICE"} · {reading ? "RECEIVED " + new Date(reading.received_at).toLocaleString() : "NO READINGS RECEIVED"}</div>
    </section> : <section className="content"><div className="sectionhead"><div><div className="eyebrow">FORECAST ENGINE</div><h2>AI predictions</h2></div><span className="status muted"><i/> MODEL NOT CONFIGURED</span></div><article className="prediction"><div className="predictionicon"><BrainCircuit size={26}/></div><div><h3>Forecasting is not available yet</h3><p>The dashboard will show 1-hour, 6-hour, and 24-hour forecasts after sufficient historical pollutant data has been collected and a model has been trained and validated.</p><div className="requirements"><span>01 / HISTORICAL DATA</span><span>02 / CALIBRATED PM SENSORS</span><span>03 / VALIDATED MODEL</span></div></div></article><div className="metrics forecastmetrics"><article className="metric"><div className="metriclabel">1 HOUR FORECAST</div><div className="metricvalue">—</div><div className="metricfoot">Not configured</div></article><article className="metric"><div className="metriclabel">6 HOUR FORECAST</div><div className="metricvalue">—</div><div className="metricfoot">Not configured</div></article><article className="metric"><div className="metriclabel">24 HOUR FORECAST</div><div className="metricvalue">—</div><div className="metricfoot">Not configured</div></article></div></section>}
    <footer><span>EVS0 / AIR QUALITY MONITORING</span><span>NO AUTHENTICATION · DASHBOARD MODE</span></footer>
  </main>;
}