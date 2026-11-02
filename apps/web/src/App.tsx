import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, BrainCircuit, Wind, Radio, Gauge, RefreshCw, Wifi, WifiOff,
  Zap, Map as MapIcon, Leaf, TrendingUp, Clock
} from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChennaiAqiDashboard from "./ChennaiAqiDashboard";

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
  available?: boolean;
  reason?: string | null;
  data?: {
    device_id: string;
    energy_kwh: number | null;
    emission_factor_kg_co2_per_kwh: number;
    estimated_co2_kg: number | null;
    factor_fiscal_year: string;
    factor_source: string;
    factor_scope: string;
    last_received_at?: string | null;
    session_id?: string | null;
  };
};

type ForecastModel = { name: string; version?: string; alpha: number; samples: number };
type SensorResponseForecast = {
  available: boolean;
  reason?: string;
  target?: string;
  model: ForecastModel;
  data?: { latest_raw_adc: number; smoothed_raw_adc: number; next_reading_estimate_adc: number };
  note?: string;
};
type EnergyProjection = { energy_kwh: number; estimated_co2_kg: number };
type EnergyModelResult = {
  id: string;
  name: string;
  forecast_active_power_w: number;
  mae_w: number | null;
  rmse_w: number | null;
  validation_samples: number;
  projections: {
    next_24_hours: EnergyProjection;
    next_7_days: EnergyProjection;
    next_30_days: EnergyProjection;
  };
};
type EnergyForecast = {
  available: boolean;
  reason?: string;
  model: ForecastModel;
  selected_model?: string;
  best_backtest_model?: string;
  validation?: { method: string; samples: number; interpretation: string };
  models?: EnergyModelResult[];
  data?: {
    latest_active_power_w?: number;
    smoothed_active_power_w: number;
    forecast_active_power_w?: number;
    projections: {
      next_24_hours: EnergyProjection;
      next_7_days: EnergyProjection;
      next_30_days: EnergyProjection;
    };
  };
  note?: string;
};
type Tab = "air-quality" | "aqi-predictions" | "energy" | "energy-predictions" | "city-aqi" | "power-map";

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
  const [sensorForecast, setSensorForecast] = useState<SensorResponseForecast | null>(null);
  const [energyForecast, setEnergyForecast] = useState<EnergyForecast | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [apiOnline, setApiOnline] = useState(false);
  const [updated, setUpdated] = useState("");
  const [loading, setLoading] = useState(false);
  const refreshRunId = useRef(0);

  async function refresh() {
    const runId = ++refreshRunId.current;
    setLoading(true);
    const fetchOptional = async <T,>(url: string): Promise<T | null> => {
      try {
        const response = await fetch(API + url);
        return response.ok ? await response.json() as T : null;
      } catch {
        return null;
      }
    };

    try {
      // Core telemetry controls the API status. Carbon and model endpoints are
      // optional so staggered deployments cannot suppress ordinary monitoring.
      const coreResponses = await Promise.all([
        fetch(API + "/api/readings/latest"),
        fetch(API + "/api/readings/history?limit=100"),
        fetch(API + "/api/devices"),
        fetch(API + "/api/power-meter/latest"),
        fetch(API + "/api/power-meter/history?limit=100")
      ]);
      if (!coreResponses.every((response) => response.ok)) throw new Error("Core API request failed");

      const [latest, hist, dev, powerLatest, powerHistory] =
        await Promise.all(coreResponses.map((response) => response.json()));

      const [carbon, sensorModel, energyModel] = await Promise.all([
        fetchOptional<CarbonSummary>("/api/power-meter/carbon"),
        fetchOptional<SensorResponseForecast>("/api/aqi/response-forecast"),
        fetchOptional<EnergyForecast>("/api/power-meter/forecast")
      ]);

      // Ignore older poll results if a newer manual or scheduled refresh started.
      if (runId !== refreshRunId.current) return;

      setReading(latest.data || null);
      setHistory(hist.data || []);
      setDevices(dev || []);
      setPowerMeterReading(powerLatest.data || null);
      setPowerMeterHistory(powerHistory.data || []);
      setCarbonSummary(carbon);
      setSensorForecast(sensorModel);
      setEnergyForecast(energyModel);
      setApiOnline(true);
      setUpdated(new Date().toLocaleTimeString());
    } catch {
      if (runId === refreshRunId.current) setApiOnline(false);
    } finally {
      if (runId === refreshRunId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(id);
      refreshRunId.current += 1;
    };
  }, []);

  const chartData = useMemo(() => {
    const unique = new Map<string, Reading>();
    for (const sample of history) {
      const rawAdc = sample.readings?.raw_adc;
      if (
        sample.valid === false ||
        typeof rawAdc !== "number" ||
        !Number.isFinite(rawAdc) ||
        rawAdc < 0 ||
        rawAdc > 4095
      ) continue;

      const sampleKey = sample.timestamp || sample.received_at;
      unique.set(sampleKey, sample);
    }

    return [...unique.values()]
      .sort((left, right) =>
        Date.parse(left.timestamp || left.received_at) -
        Date.parse(right.timestamp || right.received_at)
      )
      .map((sample) => ({
        time: sample.timestamp
          ? new Date(sample.timestamp).toLocaleTimeString()
          : new Date(sample.received_at).toLocaleTimeString(),
        adc: sample.readings!.raw_adc!
      }));
  }, [history]);

  const powerChartData = useMemo(() => powerMeterHistory.map((r) => ({
    time: r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : new Date(r.received_at).toLocaleTimeString(),
    activePower: r.readings?.active_power_w ?? null
  })), [powerMeterHistory]);


  const sensorDevices = devices.filter((device) => device.device_id !== POWER_METER_DEVICE_ID);
  const sensorOnline = sensorDevices.some((device) => device.availability?.status === "online");
  const powerMeterNode = devices.find((device) => device.device_id === POWER_METER_DEVICE_ID);
  const powerMeterOnline = powerMeterNode?.availability?.status === "online";
  const sensor = reading?.readings;
  const power = powerMeterReading?.readings;
  const emissionFactor = carbonSummary?.data?.emission_factor_kg_co2_per_kwh ?? 0.675;
  const sessionEnergyKwh = carbonSummary?.available ? carbonSummary.data?.energy_kwh ?? null : null;
  const sessionCarbonKg = carbonSummary?.available ? carbonSummary.data?.estimated_co2_kg ?? null : null;
  const energyModels: EnergyModelResult[] = energyForecast?.models?.length
    ? energyForecast.models
    : energyForecast?.available && energyForecast.data
      ? [{
          id: "ses",
          name: "Simple exponential smoothing (legacy API)",
          forecast_active_power_w: energyForecast.data.forecast_active_power_w ?? energyForecast.data.smoothed_active_power_w,
          mae_w: null,
          rmse_w: null,
          validation_samples: 0,
          projections: energyForecast.data.projections
        }]
      : [];
  const energyModelChartData = energyModels.map((model) => ({
    model: model.name,
    forecast: model.forecast_active_power_w,
    mae: model.mae_w
  }));
  const energyHorizonChartData = [
    {
      horizon: "24 hours",
      ...Object.fromEntries(energyModels.map((model) => [model.id, model.projections.next_24_hours.energy_kwh]))
    },
    {
      horizon: "7 days",
      ...Object.fromEntries(energyModels.map((model) => [model.id, model.projections.next_7_days.energy_kwh]))
    },
    {
      horizon: "30 days",
      ...Object.fromEntries(energyModels.map((model) => [model.id, model.projections.next_30_days.energy_kwh]))
    }
  ];

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
      <button className={tab === "city-aqi" ? "active" : ""} onClick={() => setTab("city-aqi")}><MapIcon size={16}/> Chennai AQI Map</button>
      <button className={tab === "aqi-predictions" ? "active" : ""} onClick={() => setTab("aqi-predictions")}><BrainCircuit size={16}/> AQI Predictions</button>
      <button className={tab === "energy" ? "active" : ""} onClick={() => setTab("energy")}><Zap size={16}/> Energy & Carbon</button>
      <button className={tab === "energy-predictions" ? "active" : ""} onClick={() => setTab("energy-predictions")}><TrendingUp size={16}/> Energy Forecast</button>
      <button className={tab === "power-map" ? "active" : ""} onClick={() => setTab("power-map")}><MapIcon size={16}/> Power Map</button>
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
            <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/><XAxis dataKey="time" tick={{fontSize:10}} minTickGap={28}/><YAxis tick={{fontSize:10}} width={48} domain={["dataMin - 50", "dataMax + 50"]}/><Tooltip/>
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
      <div className="sectionhead"><div><div className="eyebrow">AIR QUALITY FORECASTING</div><h2>AQI predictions</h2></div><span className="status muted"><i/> AQI MODEL BLOCKED · SENSOR INPUTS</span></div>
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
      <article className="prediction model-prediction">
        <div className="predictionicon"><Activity size={26}/></div>
        <div className="model-copy">
          <div className="eyebrow">LIGHTWEIGHT SENSOR MODEL · NOT AQI</div>
          <h3>MQ-135 response baseline</h3>
          <p>A simple exponential smoothing (SES) model estimates the next raw ADC response from recent MQTT samples. This is useful for monitoring sensor drift, but it does not predict AQI or pollutant concentration.</p>
          {sensorForecast?.available && sensorForecast.data ? <>
            <div className="metrics model-metrics">
              <article className="metric"><div className="metriclabel">LATEST RAW ADC</div><div className="metricvalue">{sensorForecast.data.latest_raw_adc}</div></article>
              <article className="metric"><div className="metriclabel">SMOOTHED BASELINE</div><div className="metricvalue">{fmt(sensorForecast.data.smoothed_raw_adc, 1)}</div></article>
              <article className="metric"><div className="metriclabel">NEXT READING ESTIMATE</div><div className="metricvalue">{fmt(sensorForecast.data.next_reading_estimate_adc, 1)}</div></article>
            </div>
            <div className="model-meta">MODEL: SES v{sensorForecast.model.version || "1.0"} · α {fmt(sensorForecast.model.alpha, 2)} · {sensorForecast.model.samples} SAMPLES</div>
          </> : <div className="model-wait">{sensorForecast?.reason || "Waiting for enough valid MQ-135 samples to initialize the sensor-response model."}</div>}
        </div>
      </article>
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
            <div><span>Factor period</span><strong>{carbonSummary?.data?.factor_fiscal_year || "—"}</strong></div>
            <div><span>Factor source</span><strong>{carbonSummary?.data?.factor_source || "Not available"}</strong></div>
            <div><span>Calculation</span><strong>kWh × grid factor</strong></div>
          </article>
        </div>
        <p className="carbon-note">This is an estimate of emissions associated with grid electricity use. It is not a carbon-offset claim, avoided-emissions claim, or verified carbon credit. The mock meter's energy counter resets when its process restarts.</p>
        <p className="carbon-source">Factor source: {carbonSummary?.data?.factor_source || "Not available"} · {carbonSummary?.data?.factor_scope || "Scope not supplied"}.</p>
        {carbonSummary?.data?.factor_source?.startsWith("Central Electricity Authority") ? <p className="carbon-source"><a href="https://cea.nic.in/cdm-co2-baseline-database/?lang=en" target="_blank" rel="noreferrer">CEA CO₂ Baseline Database</a></p> : null}
        {!carbonSummary?.available ? <p className="carbon-note">{carbonSummary?.reason || "Waiting for current, valid power-meter data. Carbon estimates are hidden until the meter is online and its current session has published a valid reading."}</p> : null}
      </section>
      <div className="sourcefoot">POWER SOURCE: MQTT · {powerMeterReading?.device_id || POWER_METER_DEVICE_ID} · {powerMeterReading ? "RECEIVED " + new Date(powerMeterReading.received_at).toLocaleString() : "NO METER READINGS RECEIVED"}</div>
    </section> : tab === "energy-predictions" ? <section className="content">
      <div className="sectionhead"><div><div className="eyebrow">ENERGY USE OUTLOOK</div><h2>Energy & emissions forecast</h2></div><span className={energyForecast?.available ? "status good" : "status muted"}><i/>{energyForecast?.available ? (energyForecast.models?.length ? "MODEL SUITE READY" : "SES COMPATIBILITY") : "WAITING FOR DATA"}</span></div>
      <article className="prediction energy-prediction">
        <div className="predictionicon"><TrendingUp size={26}/></div>
        <div>
          <div className="eyebrow">STATISTICAL MODEL BENCHMARK</div>
          <h3>Multi-model energy forecast</h3>
          <p>Compares SES, moving average, weighted moving average, Holt damped trend and linear trend. A walk-forward validation benchmark scores each model, then an inverse-error weighted ensemble combines their next-step estimates. These are statistical models, not trained AI/ML models.</p>
          <div className="requirements"><span>INPUT / MQTT ACTIVE POWER</span><span>MODELS / 5 + ENSEMBLE</span><span>VALIDATION / WALK-FORWARD MAE + RMSE</span><span>FACTOR / {fmt(emissionFactor, 3)} KG CO₂/KWH</span></div>
        </div>
      </article>
      {energyForecast?.available && energyForecast.data ? <>
        <div className="forecast-assumption"><Clock size={16}/> Ensemble load estimate: <strong>{fmt(energyForecast.data.forecast_active_power_w ?? energyForecast.data.smoothed_active_power_w, 1)} W</strong> · SES baseline {fmt(energyForecast.data.smoothed_active_power_w, 1)} W · {energyForecast.model.samples} samples</div>
        <div className="metrics energy-forecast-metrics">
          <article className="metric"><div className="metriclabel">NEXT 24 HOURS</div><div className="metricvalue">{fmt(energyForecast.data.projections.next_24_hours.energy_kwh, 2)}<small> kWh</small></div><div className="metricfoot">{fmt(energyForecast.data.projections.next_24_hours.estimated_co2_kg, 3)} kg CO₂ estimated</div></article>
          <article className="metric"><div className="metriclabel">NEXT 7 DAYS</div><div className="metricvalue">{fmt(energyForecast.data.projections.next_7_days.energy_kwh, 2)}<small> kWh</small></div><div className="metricfoot">{fmt(energyForecast.data.projections.next_7_days.estimated_co2_kg, 3)} kg CO₂ estimated</div></article>
          <article className="metric"><div className="metriclabel">NEXT 30 DAYS</div><div className="metricvalue">{fmt(energyForecast.data.projections.next_30_days.energy_kwh, 2)}<small> kWh</small></div><div className="metricfoot">{fmt(energyForecast.data.projections.next_30_days.estimated_co2_kg, 3)} kg CO₂ estimated</div></article>
        </div>
        <div className="forecast-chart-grid">
          <article className="panel forecast-panel">
            <div className="panelhead"><div><div className="eyebrow">NEXT-SAMPLE MODEL OUTPUT</div><h3>Predicted active power</h3></div><span className="unit">WATTS</span></div>
            <div className="forecast-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={energyModelChartData} margin={{top:10,right:12,left:0,bottom:34}}>
              <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/>
              <XAxis dataKey="model" angle={-18} textAnchor="end" interval={0} height={68} tick={{fontSize:9}}/>
              <YAxis tick={{fontSize:10}} width={44}/>
              <Tooltip formatter={(value) => [`${fmt(Number(value), 1)} W`, "Forecast"]}/>
              <Bar dataKey="forecast" name="Forecast power" fill="#287e83" radius={[3,3,0,0]}/>
            </BarChart></ResponsiveContainer></div>
          </article>
          <article className="panel forecast-panel">
            <div className="panelhead"><div><div className="eyebrow">ROLLING HOLDOUT</div><h3>Model error comparison</h3></div><span className="unit">LOWER IS BETTER</span></div>
            <div className="forecast-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={energyModelChartData} margin={{top:10,right:12,left:0,bottom:34}}>
              <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/>
              <XAxis dataKey="model" angle={-18} textAnchor="end" interval={0} height={68} tick={{fontSize:9}}/>
              <YAxis tick={{fontSize:10}} width={44}/>
              <Tooltip formatter={(value) => [`${fmt(Number(value), 2)} W MAE`, "Validation error"]}/>
              <Bar dataKey="mae" name="Mean absolute error" fill="#b47a12" radius={[3,3,0,0]}/>
            </BarChart></ResponsiveContainer></div>
          </article>
        </div>
        <article className="panel forecast-horizon-panel">
          <div className="panelhead"><div><div className="eyebrow">CROSS-HORIZON SCENARIOS</div><h3>Projected energy by model</h3></div><span className="unit">KWH · FLAT-LOAD ASSUMPTION</span></div>
          <div className="forecast-chart horizon-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={energyHorizonChartData} margin={{top:12,right:20,left:4,bottom:0}}>
            <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e5e0d5"/>
            <XAxis dataKey="horizon" tick={{fontSize:10}}/>
            <YAxis tick={{fontSize:10}} width={48}/>
            <Tooltip formatter={(value) => [`${fmt(Number(value), 2)} kWh`, "Scenario"]}/>
            <Legend wrapperStyle={{fontSize:10}}/>
            <Line type="monotone" dataKey="ses" name="SES" stroke="#a56e00" strokeWidth={2} dot={{r:3}}/>
            <Line type="monotone" dataKey="moving_average" name="Moving average" stroke="#287e83" strokeWidth={2} dot={{r:3}}/>
            <Line type="monotone" dataKey="weighted_moving_average" name="Weighted moving average" stroke="#4c6fa8" strokeWidth={2} dot={{r:3}}/>
            <Line type="monotone" dataKey="holt_damped" name="Holt damped" stroke="#9a5a9e" strokeWidth={2} dot={{r:3}}/>
            <Line type="monotone" dataKey="linear_trend" name="Linear trend" stroke="#c05c45" strokeWidth={2} dot={{r:3}}/>
            <Line type="monotone" dataKey="weighted_ensemble" name="Weighted ensemble" stroke="#1f2229" strokeWidth={3} dot={{r:4}}/>
          </LineChart></ResponsiveContainer></div>
        </article>
        <article className="panel model-score-panel">
          <div className="panelhead"><div><div className="eyebrow">MODEL SELECTION</div><h3>Backtest summary</h3></div><span className="unit">ONE-STEP ERROR</span></div>
          <div className="model-score-table">
            {energyModels.map((model) => <div className="model-score-row" key={model.id}>
              <div><strong>{model.name}</strong><small>{model.validation_samples} validation points</small></div>
              <span>{fmt(model.forecast_active_power_w, 1)} W forecast</span>
              <span>MAE {fmt(model.mae_w, 2)} W</span>
              <span>RMSE {fmt(model.rmse_w, 2)} W</span>
            </div>)}
          </div>
          <div className="model-meta">{energyForecast.models?.length ? `BEST INDIVIDUAL BACKTEST: ${energyForecast.best_backtest_model || "Not available"} · SELECTED PROJECTION: INVERSE-ERROR WEIGHTED ENSEMBLE` : "LEGACY API RESPONSE · SES ONLY · MODEL COMPARISON NOT AVAILABLE"} · α {fmt(energyForecast.model.alpha, 2)}</div>
        </article>
      </> : <div className="model-wait">{energyForecast?.reason || "Waiting for enough valid MQTT power readings to initialize the energy models."}</div>}
      <p className="carbon-note">The MAE/RMSE chart is a rolling one-step-ahead backtest over the current in-memory session. Long horizons still assume the selected load level remains constant; daily/weekly seasonality needs several days of persisted readings. The forecast history resets when the API restarts.</p>
      <p className="carbon-note">Camera-based appliance recognition is not included in these meter-only models. It requires an explicitly configured camera feed and an appliance-detection dataset before individual appliance power can be estimated.</p>
    </section> : tab === "city-aqi" ? <ChennaiAqiDashboard apiBase={API} /> : <section className="content power-map-content">
      <div className="sectionhead">
        <div><div className="eyebrow">INDIA ELECTRICITY INFRASTRUCTURE</div><h2>Power Map of India</h2></div>
        <a className="power-map-open" href={API + "/api/power-map/open"} target="_blank" rel="noreferrer noopener">Open full map <MapIcon size={14}/></a>
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
