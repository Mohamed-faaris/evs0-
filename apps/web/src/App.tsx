import { useEffect, useMemo, useState } from "react";
import { Activity, BrainCircuit, Wind, Radio, Gauge, RefreshCw, Wifi, WifiOff, Zap, Map } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Readings = {
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
type Reading = {
  device_id: string;
  device_type?: "sensor" | "power_meter";
  sensor?: string;
  meter_model?: string;
  timestamp?: string | null;
  received_at: string;
  uptime_seconds?: number;
  sequence?: number;
  valid?: boolean;
  readings?: Readings;
};
type Device = {
  device_id: string;
  state?: { state?: string; device_type?: string } | null;
  availability?: { status: string; received_at: string } | null;
  latest?: Reading | null;
};

const API = import.meta.env.VITE_API_BASE || "";
const POWER_METER_DEVICE_ID = import.meta.env.VITE_POWER_METER_DEVICE_ID || "power-meter-001";
const fmt = (n?: number, digits = 2) => n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);

export default function App() {
  const [tab, setTab] = useState<"live" | "power-map" | "predictions">("live");
  const [reading, setReading] = useState<Reading | null>(null);
  const [history, setHistory] = useState<Reading[]>([]);
  const [powerMeterReading, setPowerMeterReading] = useState<Reading | null>(null);
  const [powerMeterHistory, setPowerMeterHistory] = useState<Reading[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [apiOnline, setApiOnline] = useState(false);
  const [updated, setUpdated] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const responses = await Promise.all([
        fetch(API + "/api/readings/latest"),
        fetch(API + "/api/readings/history?limit=100"),
        fetch(API + "/api/devices"),
        fetch(API + "/api/power-meter/latest"),
        fetch(API + "/api/power-meter/history?limit=100")
      ]);
      if (!responses.every((response) => response.ok)) throw new Error("API request failed");
      const [latest, hist, dev, powerLatest, powerHistory] = await Promise.all(responses.map((response) => response.json()));
      setReading(latest.data || null);
      setHistory(hist.data || []);
      setDevices(dev || []);
      setPowerMeterReading(powerLatest.data || null);
      setPowerMeterHistory(powerHistory.data || []);
      setApiOnline(true);
      setUpdated(new Date().toLocaleTimeString());
    } catch {
      setApiOnline(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, []);

  const chartData = useMemo(() => history.map((r) => ({
    time: r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : new Date(r.received_at).toLocaleTimeString(),
    adc: r.readings?.raw_adc ?? null
  })), [history]);

  const powerChartData = useMemo(() => powerMeterHistory.map((r) => ({
    time: r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : new Date(r.received_at).toLocaleTimeString(),
    activePower: r.readings?.active_power_w ?? null
  })), [powerMeterHistory]);

  const sensorOnline = devices.some((d) => d.device_id !== POWER_METER_DEVICE_ID && d.availability?.status === "online");
  const powerMeterNode = devices.find((d) => d.device_id === POWER_METER_DEVICE_ID);
  const powerMeterOnline = powerMeterNode?.availability?.status === "online";
  const sensor = reading?.readings;
  const power = powerMeterReading?.readings;

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><div className="brandmark"><Wind size={22}/></div><div><strong>EVS<span>0</span></strong><small>ENVIRONMENTAL MONITORING</small></div></div>
      <div className="topright">
        <span className={apiOnline ? "status good" : "status bad"}><i/>{apiOnline ? "API CONNECTED" : "API OFFLINE"}</span>
        <button className="iconbtn" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={17} className={loading ? "spin" : ""}/></button>
      </div>
    </header>

    <section className="intro">
      <div><div className="eyebrow">ENVIRONMENTAL INTELLIGENCE / TRICHY</div><h1>Air Quality <em>Dashboard</em></h1><p>Live environmental telemetry and simulated electrical metering.</p></div>
      <div className="updated">LAST SYNC <strong>{updated || "Waiting for data"}</strong></div>
    </section>

    <nav className="tabs">
      <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}><Activity size={16}/> Live Monitoring</button>
      <button className={tab === "power-map" ? "active" : ""} onClick={() => setTab("power-map")}><Map size={16}/> Power Map</button>
      <button className={tab === "predictions" ? "active" : ""} onClick={() => setTab("predictions")}><BrainCircuit size={16}/> AI Predictions</button>
    </nav>

    {tab === "live" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">LIVE TELEMETRY</div><h2>Sensor overview</h2></div><span className="livepill"><i/> AUTO REFRESH · 3 SEC</span></div>
      <div className="notice"><strong>AQI NOT AVAILABLE</strong><span>MQ-135 provides a broad gas-response signal. It cannot independently produce official CPCB AQI or PM2.5/PM10 values.</span></div>

      <div className="metrics">
        <article className="metric heroMetric"><div className="metriclabel"><Gauge size={16}/> OFFICIAL AQI</div><div className="metricvalue">—</div><div className="metricfoot">Requires calibrated pollutant sensors</div><div className="metricbar"><span/></div></article>
        <article className="metric"><div className="metriclabel">MQ-135 RAW ADC</div><div className="metricvalue">{sensor?.raw_adc ?? "—"}</div><div className="metricfoot">12-bit ADC · 0–4095</div></article>
        <article className="metric"><div className="metriclabel">ADC VOLTAGE</div><div className="metricvalue">{fmt(sensor?.adc_pin_voltage_v, 3)}<small> V</small></div><div className="metricfoot">Measured at ESP32 pin</div></article>
        <article className="metric"><div className="metriclabel">SENSOR AO EST.</div><div className="metricvalue">{fmt(sensor?.sensor_ao_voltage_v, 3)}<small> V</small></div><div className="metricfoot">Calculated from divider ratio</div></article>
      </div>

      <div className="grid2">
        <article className="panel">
          <div className="panelhead"><div><div className="eyebrow">SENSOR SIGNAL</div><h3>ADC history</h3></div><span className="unit">RAW COUNTS</span></div>
          {chartData.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}>
            <defs><linearGradient id="fillAdc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d49a16" stopOpacity={.3}/><stop offset="95%" stopColor="#d49a16" stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/><XAxis dataKey="time" tick={{fontSize:10}} minTickGap={28}/><YAxis tick={{fontSize:10}} width={42}/><Tooltip/>
            <Area type="monotone" dataKey="adc" stroke="#a56e00" fill="url(#fillAdc)" strokeWidth={2} connectNulls/>
          </AreaChart></ResponsiveContainer></div> : <div className="empty">Waiting for MQ-135 MQTT telemetry…</div>}
        </article>

        <article className="panel">
          <div className="panelhead"><div><div className="eyebrow">DEVICE STATUS</div><h3>Connected nodes</h3></div><Radio size={18}/></div>
          {devices.length ? devices.map((d) => {
            const isPowerMeter = d.device_id === POWER_METER_DEVICE_ID;
            const label = isPowerMeter ? "MOCK POWER METER" : (d.latest?.sensor || "ENVIRONMENT SENSOR");
            const detail = isPowerMeter
              ? (d.latest?.valid ? "Electrical telemetry valid" : "No valid meter reading")
              : (d.latest?.valid ? "Sensor valid" : "No valid reading");
            return <div className="device" key={d.device_id}>
              <div className="deviceicon">{isPowerMeter ? <Zap size={18}/> : <Radio size={18}/>}</div>
              <div className="deviceinfo"><strong>{d.device_id}</strong><small>{label} · {detail}</small></div>
              <span className={d.availability?.status === "online" ? "status good" : "status muted"}><i/>{d.availability?.status || "UNKNOWN"}</span>
            </div>;
          }) : <div className="empty">No devices have published telemetry yet.</div>}
          <div className="devicefoot"><span>{sensorOnline ? <Wifi size={14}/> : <WifiOff size={14}/>} Sensor broker presence</span><strong>{sensorOnline ? "ONLINE" : "NOT REPORTED"}</strong></div>
        </article>
      </div>

      <section className="power-meter-block">
        <div className="sectionhead power-sectionhead">
          <div><div className="eyebrow">ELECTRICAL TELEMETRY · MQTT MOCK DEVICE</div><h2>Power meter</h2></div>
          <span className={powerMeterOnline ? "status good" : "status muted"}><i/>{powerMeterOnline ? "METER ONLINE" : "WAITING FOR METER"}</span>
        </div>
        <div className="power-sim-notice">SIMULATED SINGLE-PHASE VALUES · NOT A PHYSICAL METER</div>
        {power ? <>
          <div className="metrics power-metrics">
            <article className="metric"><div className="metriclabel">VOLTAGE</div><div className="metricvalue">{fmt(power.voltage_v, 1)}<small> V</small></div><div className="metricfoot">RMS voltage</div></article>
            <article className="metric"><div className="metriclabel">CURRENT</div><div className="metricvalue">{fmt(power.current_a, 2)}<small> A</small></div><div className="metricfoot">Simulated load current</div></article>
            <article className="metric"><div className="metriclabel">ACTIVE POWER</div><div className="metricvalue">{fmt(power.active_power_w, 1)}<small> W</small></div><div className="metricfoot">Real power</div></article>
            <article className="metric"><div className="metriclabel">POWER FACTOR</div><div className="metricvalue">{fmt(power.power_factor, 3)}</div><div className="metricfoot">0–1 ratio</div></article>
            <article className="metric"><div className="metriclabel">FREQUENCY</div><div className="metricvalue">{fmt(power.frequency_hz, 2)}<small> Hz</small></div><div className="metricfoot">Nominal 50 Hz</div></article>
            <article className="metric"><div className="metriclabel">ENERGY</div><div className="metricvalue">{fmt(power.energy_kwh, 3)}<small> kWh</small></div><div className="metricfoot">Since mock process start</div></article>
          </div>
          <div className="grid2 power-grid">
            <article className="panel">
              <div className="panelhead"><div><div className="eyebrow">LOAD PROFILE</div><h3>Active power history</h3></div><span className="unit">WATTS</span></div>
              {powerChartData.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={powerChartData}>
                <defs><linearGradient id="fillPower" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#287e83" stopOpacity={.3}/><stop offset="95%" stopColor="#287e83" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/><XAxis dataKey="time" tick={{fontSize:10}} minTickGap={28}/><YAxis tick={{fontSize:10}} width={48}/><Tooltip/>
                <Area type="monotone" dataKey="activePower" name="Active power (W)" stroke="#287e83" fill="url(#fillPower)" strokeWidth={2} connectNulls/>
              </AreaChart></ResponsiveContainer></div> : <div className="empty">Waiting for power-meter MQTT telemetry…</div>}
            </article>
            <article className="panel power-details">
              <div className="panelhead"><div><div className="eyebrow">ELECTRICAL DETAILS</div><h3>Live meter values</h3></div><Zap size={18}/></div>
              <dl>
                <div><dt>Apparent power</dt><dd>{fmt(power.apparent_power_va, 1)} VA</dd></div>
                <div><dt>Reactive power</dt><dd>{fmt(power.reactive_power_var, 1)} var</dd></div>
                <div><dt>Meter identity</dt><dd>{powerMeterReading?.device_id || POWER_METER_DEVICE_ID}</dd></div>
                <div><dt>Last received</dt><dd>{powerMeterReading ? new Date(powerMeterReading.received_at).toLocaleTimeString() : "—"}</dd></div>
              </dl>
            </article>
          </div>
        </> : <div className="empty power-empty">Waiting for the mock power meter to publish through MQTT. Check the mock server logs and broker ACLs.</div>}
      </section>

      <div className="sourcefoot">MQ-135 SOURCE: MQTT · {reading?.device_id || "NO SENSOR DEVICE"} · {reading ? "RECEIVED " + new Date(reading.received_at).toLocaleString() : "NO READINGS RECEIVED"}<br/>POWER SOURCE: MQTT · {powerMeterReading?.device_id || POWER_METER_DEVICE_ID} · {powerMeterReading ? "RECEIVED " + new Date(powerMeterReading.received_at).toLocaleString() : "NO METER READINGS RECEIVED"}</div>
    </section> : tab === "power-map" ? <section className="content power-map-content">
      <div className="sectionhead">
        <div><div className="eyebrow">INDIA ELECTRICITY INFRASTRUCTURE</div><h2>Power Map of India</h2></div>
        <a className="power-map-open" href={API + "/api/power-map/"} target="_blank" rel="noreferrer">Open full map <Map size={14}/></a>
      </div>
      <div className="power-map-attribution">
        <span>POWER MAP OF INDIA · RECLAIM CHENNAI</span>
        <span>Live map and published data are served through the EVS0 same-origin proxy.</span>
      </div>
      <iframe className="power-map-frame" src={API + "/api/power-map/"} title="Power Map of India by Reclaim Chennai" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-forms allow-popups" />
    </section> : <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">FORECAST ENGINE</div><h2>AI predictions</h2></div><span className="status muted"><i/> MODEL NOT CONFIGURED</span></div>
      <article className="prediction"><div className="predictionicon"><BrainCircuit size={26}/></div><div><h3>Forecasting is not available yet</h3><p>The dashboard will show 1-hour, 6-hour, and 24-hour forecasts after sufficient historical pollutant data has been collected and a model has been trained and validated.</p><div className="requirements"><span>01 / HISTORICAL DATA</span><span>02 / CALIBRATED PM SENSORS</span><span>03 / VALIDATED MODEL</span></div></div></article>
      <div className="metrics forecastmetrics"><article className="metric"><div className="metriclabel">1 HOUR FORECAST</div><div className="metricvalue">—</div><div className="metricfoot">Not configured</div></article><article className="metric"><div className="metriclabel">6 HOUR FORECAST</div><div className="metricvalue">—</div><div className="metricfoot">Not configured</div></article><article className="metric"><div className="metriclabel">24 HOUR FORECAST</div><div className="metricvalue">—</div><div className="metricfoot">Not configured</div></article></div>
    </section>}
    <footer><span>EVS0 / AIR QUALITY MONITORING</span><span>NO AUTHENTICATION · DASHBOARD MODE</span></footer>
  </main>;
}
