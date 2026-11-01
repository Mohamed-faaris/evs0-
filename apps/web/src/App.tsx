import { useEffect, useMemo, useState } from "react";
import {
  Activity, BrainCircuit, Wind, Radio, Gauge, RefreshCw, Wifi, WifiOff,
  Zap, Map, Leaf, TrendingUp, Clock
} from "lucide-react";
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
type CarbonSummary = {
  data?: {
    device_id: string;
    energy_kwh: number | null;
    emission_factor_kg_co2_per_kwh: number;
    estimated_co2_kg: number | null;
    factor_fiscal_year: string;
    factor_source: string;
    factor_scope: string;
  };
};

type Tab = "air-quality" | "aqi-predictions" | "energy" | "energy-predictions" | "power-map";

const API = import.meta.env.VITE_API_BASE || "";
const POWER_METER_DEVICE_ID = import.meta.env.VITE_POWER_METER_DEVICE_ID || "power-meter-001";
const fmt = (n?: number | null, digits = 2) => n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);

export default function App() {
  const [tab, setTab] = useState<Tab>("air-quality");
  const [reading, setReading] = useState<Reading | null>(null);
  const [history, setHistory] = useState<Reading[]>([]);
  const [powerMeterReading, setPowerMeterReading] = useState<Reading | null>(null);
  const [powerMeterHistory, setPowerMeterHistory] = useState<Reading[]>([]);
  const [carbonSummary, setCarbonSummary] = useState<CarbonSummary | null>(null);
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
        fetch(API + "/api/power-meter/history?limit=100"),
        fetch(API + "/api/power-meter/carbon")
      ]);
      if (!responses.every((response) => response.ok)) throw new Error("API request failed");
      const [latest, hist, dev, powerLatest, powerHistory, carbon] =
        await Promise.all(responses.map((response) => response.json()));
      setReading(latest.data || null);
      setHistory(hist.data || []);
      setDevices(dev || []);
      setPowerMeterReading(powerLatest.data || null);
      setPowerMeterHistory(powerHistory.data || []);
      setCarbonSummary(carbon || null);
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

  const averageActivePowerW = useMemo(() => {
    const samples = powerMeterHistory
      .map((sample) => sample.readings?.active_power_w)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    return samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null;
  }, [powerMeterHistory]);

  const sensorDevices = devices.filter((device) => device.device_id !== POWER_METER_DEVICE_ID);
  const sensorOnline = sensorDevices.some((device) => device.availability?.status === "online");
  const powerMeterNode = devices.find((device) => device.device_id === POWER_METER_DEVICE_ID);
  const powerMeterOnline = powerMeterNode?.availability?.status === "online";
  const sensor = reading?.readings;
  const power = powerMeterReading?.readings;
  const emissionFactor = carbonSummary?.data?.emission_factor_kg_co2_per_kwh ?? 0.675;
  const sessionEnergyKwh = carbonSummary?.data?.energy_kwh ?? power?.energy_kwh ?? null;
  const sessionCarbonKg = carbonSummary?.data?.estimated_co2_kg ?? (
    sessionEnergyKwh == null ? null : sessionEnergyKwh * emissionFactor
  );
  const projectedDailyKwh = averageActivePowerW == null ? null : averageActivePowerW * 24 / 1000;
  const projectedDailyCarbonKg = projectedDailyKwh == null ? null : projectedDailyKwh * emissionFactor;
  const projectedWeeklyKwh = projectedDailyKwh == null ? null : projectedDailyKwh * 7;
  const projectedWeeklyCarbonKg = projectedDailyCarbonKg == null ? null : projectedDailyCarbonKg * 7;
  const projectedMonthlyKwh = projectedDailyKwh == null ? null : projectedDailyKwh * 30;
  const projectedMonthlyCarbonKg = projectedDailyCarbonKg == null ? null : projectedDailyCarbonKg * 30;

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><div className="brandmark"><Wind size={22}/></div><div><strong>EVS<span>0</span></strong><small>ENVIRONMENTAL MONITORING</small></div></div>
      <div className="topright">
        <span className={apiOnline ? "status good" : "status bad"}><i/>{apiOnline ? "API CONNECTED" : "API OFFLINE"}</span>
        <button className="iconbtn" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={17} className={loading ? "spin" : ""}/></button>
      </div>
    </header>

    <section className="intro">
      <div>
        <div className="eyebrow">ENVIRONMENTAL INTELLIGENCE / TRICHY</div>
        <h1>Environmental <em>Dashboard</em></h1>
        <p>Air-quality monitoring, electricity telemetry and estimated grid emissions.</p>
      </div>
      <div className="updated">LAST SYNC <strong>{updated || "Waiting for data"}</strong></div>
    </section>

    <nav className="tabs dashboard-tabs" aria-label="Dashboard sections">
      <button className={tab === "air-quality" ? "active" : ""} onClick={() => setTab("air-quality")}><Wind size={16}/> Air Quality</button>
      <button className={tab === "aqi-predictions" ? "active" : ""} onClick={() => setTab("aqi-predictions")}><BrainCircuit size={16}/> AQI Predictions</button>
      <button className={tab === "energy" ? "active" : ""} onClick={() => setTab("energy")}><Zap size={16}/> Energy & Carbon</button>
      <button className={tab === "energy-predictions" ? "active" : ""} onClick={() => setTab("energy-predictions")}><TrendingUp size={16}/> Energy Forecast</button>
      <button className={tab === "power-map" ? "active" : ""} onClick={() => setTab("power-map")}><Map size={16}/> Power Map</button>
    </nav>

    {tab === "air-quality" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">AIR QUALITY MONITORING</div><h2>Sensor overview</h2></div><span className="livepill"><i/> AUTO REFRESH · 3 SEC</span></div>
      <div className="notice"><strong>OFFICIAL AQI UNAVAILABLE</strong><span>MQ-135 provides a broad gas-response signal. It cannot independently calculate CPCB AQI or PM2.5/PM10 concentrations.</span></div>

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
          <div className="panelhead"><div><div className="eyebrow">ENVIRONMENT SENSORS</div><h3>Connected nodes</h3></div><Radio size={18}/></div>
          {sensorDevices.length ? sensorDevices.map((device) => (
            <div className="device" key={device.device_id}>
              <div className="deviceicon"><Radio size={18}/></div>
              <div className="deviceinfo"><strong>{device.device_id}</strong><small>{device.latest?.sensor || "ENVIRONMENT SENSOR"} · {device.latest?.valid ? "Sensor valid" : "No valid reading"}</small></div>
              <span className={device.availability?.status === "online" ? "status good" : "status muted"}><i/>{device.availability?.status || "UNKNOWN"}</span>
            </div>
          )) : <div className="empty">No environmental sensor has published telemetry yet.</div>}
          <div className="devicefoot"><span>{sensorOnline ? <Wifi size={14}/> : <WifiOff size={14}/>} Sensor broker presence</span><strong>{sensorOnline ? "ONLINE" : "NOT REPORTED"}</strong></div>
        </article>
      </div>
      <div className="sourcefoot">AIR QUALITY SOURCE: MQTT · {reading?.device_id || "NO SENSOR DEVICE"} · {reading ? "RECEIVED " + new Date(reading.received_at).toLocaleString() : "NO READINGS RECEIVED"}</div>
    </section> : tab === "aqi-predictions" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">AIR QUALITY FORECASTING</div><h2>AQI predictions</h2></div><span className="status muted"><i/> MODEL NOT CONFIGURED</span></div>
      <article className="prediction">
        <div className="predictionicon"><BrainCircuit size={26}/></div>
        <div>
          <h3>AQI prediction is not available yet</h3>
          <p>The current MQ-135 signal is not sufficient to train or validate an AQI forecasting model. A defensible prediction requires calibrated PM2.5/PM10 and relevant gas measurements, timestamped history, and a validated model.</p>
          <div className="requirements"><span>01 / CALIBRATED PM2.5 + PM10</span><span>02 / POLLUTANT HISTORY</span><span>03 / VALIDATED FORECAST MODEL</span></div>
        </div>
      </article>
      <div className="metrics forecastmetrics">
        <article className="metric"><div className="metriclabel">1 HOUR AQI</div><div className="metricvalue">—</div><div className="metricfoot">Not available</div></article>
        <article className="metric"><div className="metriclabel">6 HOUR AQI</div><div className="metricvalue">—</div><div className="metricfoot">Not available</div></article>
        <article className="metric"><div className="metriclabel">24 HOUR AQI</div><div className="metricvalue">—</div><div className="metricfoot">Not available</div></article>
      </div>
    </section> : tab === "energy" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">ELECTRICAL TELEMETRY · MQTT DEVICE</div><h2>Power meter</h2></div><span className={powerMeterOnline ? "status good" : "status muted"}><i/>{powerMeterOnline ? "METER ONLINE" : "WAITING FOR METER"}</span></div>
      <div className="power-sim-notice">SIMULATED SINGLE-PHASE VALUES · NOT A PHYSICAL METER</div>
      {power ? <>
        <div className="metrics power-metrics">
          <article className="metric"><div className="metriclabel">VOLTAGE</div><div className="metricvalue">{fmt(power.voltage_v, 1)}<small> V</small></div><div className="metricfoot">RMS voltage</div></article>
          <article className="metric"><div className="metriclabel">CURRENT</div><div className="metricvalue">{fmt(power.current_a, 2)}<small> A</small></div><div className="metricfoot">Load current</div></article>
          <article className="metric"><div className="metriclabel">ACTIVE POWER</div><div className="metricvalue">{fmt(power.active_power_w, 1)}<small> W</small></div><div className="metricfoot">Real power</div></article>
          <article className="metric"><div className="metriclabel">POWER FACTOR</div><div className="metricvalue">{fmt(power.power_factor, 3)}</div><div className="metricfoot">0–1 ratio</div></article>
          <article className="metric"><div className="metriclabel">FREQUENCY</div><div className="metricvalue">{fmt(power.frequency_hz, 2)}<small> Hz</small></div><div className="metricfoot">Nominal 50 Hz</div></article>
          <article className="metric"><div className="metriclabel">ENERGY</div><div className="metricvalue">{fmt(power.energy_kwh, 3)}<small> kWh</small></div><div className="metricfoot">Since meter process start</div></article>
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

      <section className="carbon-block">
        <div className="sectionhead"><div><div className="eyebrow">SCOPE 2 · LOCATION-BASED ESTIMATE</div><h2><Leaf size={20}/> Electricity carbon emissions</h2></div><span className="status muted"><i/> ESTIMATE · NOT AN OFFSET</span></div>
        <div className="carbon-grid">
          <article className="carbon-primary">
            <div className="metriclabel">ESTIMATED CO₂ FROM METERED ENERGY</div>
            <div className="carbon-value">{sessionCarbonKg == null ? "—" : fmt(sessionCarbonKg, 3)} <small>kg CO₂</small></div>
            <p>Calculated from the meter's cumulative kWh reading and the configured India grid factor.</p>
          </article>
          <article className="carbon-detail">
            <div><span>Meter energy</span><strong>{sessionEnergyKwh == null ? "—" : fmt(sessionEnergyKwh, 4) + " kWh"}</strong></div>
            <div><span>Grid factor</span><strong>{fmt(emissionFactor, 3)} kg CO₂/kWh</strong></div>
            <div><span>Factor period</span><strong>{carbonSummary?.data?.factor_fiscal_year || "FY2025-26"}</strong></div>
            <div><span>Calculation</span><strong>kWh × grid factor</strong></div>
          </article>
        </div>
        <p className="carbon-note">This is an estimate of emissions associated with grid electricity use. It is not a carbon-offset claim, avoided-emissions claim, or verified carbon credit. The mock meter's energy counter resets when its process restarts.</p>
        <p className="carbon-source">Factor source: Central Electricity Authority, CO₂ Baseline Database v22.0, FY2025-26 weighted-average India grid factor. <a href="https://cea.nic.in/cdm-co2-baseline-database/?lang=en" target="_blank" rel="noreferrer">CEA source</a>.</p>
      </section>
      <div className="sourcefoot">POWER SOURCE: MQTT · {powerMeterReading?.device_id || POWER_METER_DEVICE_ID} · {powerMeterReading ? "RECEIVED " + new Date(powerMeterReading.received_at).toLocaleString() : "NO METER READINGS RECEIVED"}</div>
    </section> : tab === "energy-predictions" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">ENERGY USE OUTLOOK</div><h2>Energy & emissions forecast</h2></div><span className="status muted"><i/> BASELINE PROJECTION</span></div>
      <article className="prediction energy-prediction">
        <div className="predictionicon"><TrendingUp size={26}/></div>
        <div>
          <h3>Usage-based projection, not an AI model</h3>
          <p>These projections extrapolate the average active power from the latest {powerMeterHistory.length} retained meter samples. They assume the recent load continues unchanged; they are not machine-learning predictions or a guarantee of future consumption.</p>
          <div className="requirements"><span>INPUT / RECENT MQTT POWER SAMPLES</span><span>METHOD / MEAN LOAD × TIME</span><span>FACTOR / {fmt(emissionFactor, 3)} KG CO₂/KWH</span></div>
        </div>
      </article>
      {averageActivePowerW == null ? <div className="empty forecast-empty">Waiting for power-meter history before generating a usage projection.</div> : <>
        <div className="forecast-assumption"><Clock size={16}/> Recent average active power: <strong>{fmt(averageActivePowerW, 1)} W</strong> · {powerMeterHistory.length} samples</div>
        <div className="metrics energy-forecast-metrics">
          <article className="metric"><div className="metriclabel">NEXT 24 HOURS</div><div className="metricvalue">{fmt(projectedDailyKwh, 2)}<small> kWh</small></div><div className="metricfoot">{fmt(projectedDailyCarbonKg, 3)} kg CO₂ estimated</div></article>
          <article className="metric"><div className="metriclabel">NEXT 7 DAYS</div><div className="metricvalue">{fmt(projectedWeeklyKwh, 2)}<small> kWh</small></div><div className="metricfoot">{fmt(projectedWeeklyCarbonKg, 3)} kg CO₂ estimated</div></article>
          <article className="metric"><div className="metriclabel">NEXT 30 DAYS</div><div className="metricvalue">{fmt(projectedMonthlyKwh, 2)}<small> kWh</small></div><div className="metricfoot">{fmt(projectedMonthlyCarbonKg, 3)} kg CO₂ estimated</div></article>
        </div>
      </>}
      <p className="carbon-note">Emissions projections use the same India national-grid factor as the Energy & Carbon page. They estimate grid-related CO₂ only and do not represent offsets or verified reductions.</p>
    </section> : <section className="content power-map-content">
      <div className="sectionhead">
        <div><div className="eyebrow">INDIA ELECTRICITY INFRASTRUCTURE</div><h2>Power Map of India</h2></div>
        <a className="power-map-open" href={API + "/api/power-map/open"} target="_blank" rel="noreferrer noopener">Open full map <Map size={14}/></a>
      </div>
      <div className="power-map-attribution">
        <span>POWER MAP OF INDIA</span>
        <span>Live map and published data are served through the EVS0 same-origin proxy.</span>
      </div>
      <iframe className="power-map-frame" src={API + "/api/power-map/"} title="Power Map of India" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-forms allow-popups" />
    </section>}
    <footer><span>EVS0 / AIR QUALITY & ENERGY MONITORING</span><span>NO AUTHENTICATION · DASHBOARD MODE</span></footer>
  </main>;
}
