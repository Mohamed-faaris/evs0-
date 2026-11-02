import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Clock3, ExternalLink, Filter, MapPin, RefreshCw, Search } from "lucide-react";

type Station = {
  id: string; name: string; source: string;
  lat: number | null; lon: number | null; aqi: number | null;
  updatedAt: string | null; pollutants: Record<string, number>;
};
type FeedState = "loading" | "online" | "offline";
type MapLibreMap = {
  addControl: (control: unknown, position?: string) => void;
  on: (event: string, callback: () => void) => void;
  easeTo: (options: Record<string, unknown>) => void;
  remove: () => void;
};
type MapLibreMarker = { remove: () => void };
type MapLibreRuntime = {
  Map: new (options: Record<string, unknown>) => MapLibreMap;
  NavigationControl: new (options: Record<string, unknown>) => unknown;
  Marker: new (options: Record<string, unknown>) => {
    setLngLat: (coordinates: [number, number]) => {
      addTo: (map: MapLibreMap) => MapLibreMarker;
    };
  };
};
declare global {
  interface Window { maplibregl?: MapLibreRuntime }
}
const CITY_CENTER: [number, number] = [80.2667, 13.0833];
const POLLUTANTS = [
  { id: "aqi", label: "AQI" }, { id: "pm25", label: "PM2.5" },
  { id: "pm10", label: "PM10" }, { id: "no2", label: "NO₂" },
  { id: "so2", label: "SO₂" }, { id: "o3", label: "O₃" },
  { id: "co", label: "CO" }, { id: "nh3", label: "NH₃" }, { id: "tvoc", label: "TVOC" }
];

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && value.trim() !== "-") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && "v" in value) return num((value as {v?: unknown}).v);
  if (value && typeof value === "object" && "value" in value) return num((value as {value?: unknown}).value);
  return null;
}

function rowsFrom(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  for (const key of ["stations", "data", "results", "items", "records"]) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = rowsFrom(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalize(payload: unknown): Station[] {
  const pollutantKeys = POLLUTANTS.filter((item) => item.id !== "aqi").map((item) => item.id);
  return rowsFrom(payload).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const geo = raw.geo && typeof raw.geo === "object" ? raw.geo as Record<string, unknown> : {};
    const coords = Array.isArray(raw.coordinates) ? raw.coordinates : null;
    const lat = num(raw.lat ?? raw.latitude ?? geo.lat ?? (coords ? coords[1] : null));
    const lon = num(raw.lon ?? raw.lng ?? raw.longitude ?? geo.lon ?? geo.lng ?? (coords ? coords[0] : null));
    const aqi = num(raw.aqi ?? raw.AQI ?? raw.current_aqi ?? raw.index);
    const values = (raw.pollutants ?? raw.measurements ?? raw.iaqi ?? raw.metrics ?? {}) as Record<string, unknown>;
    const pollutants: Record<string, number> = {};
    for (const key of pollutantKeys) {
      const value = num(values[key] ?? raw[key] ?? raw[key.toUpperCase()]);
      if (value !== null) pollutants[key] = value;
    }
    const updated = raw.timestamp ?? raw.updated_at ?? raw.last_updated ?? raw.time;
    return [{
      id: String(raw.uid ?? raw.id ?? raw.station_id ?? raw.code ?? "station-" + index),
      name: String(raw.name ?? raw.station_name ?? raw.location ?? raw.title ?? "Unnamed station"),
      source: String(raw.source ?? raw.provider ?? raw.network ?? raw.source_name ?? "Source not reported"),
      lat: lat !== null && lat > 12.5 && lat < 13.8 ? lat : null,
      lon: lon !== null && lon > 79.5 && lon < 81 ? lon : null,
      aqi,
      updatedAt: typeof updated === "string" || typeof updated === "number" ? String(updated) : null,
      pollutants
    }];
  });
}

function valueFor(station: Station, metric: string): number | null {
  return metric === "aqi" ? station.aqi : station.pollutants[metric] ?? null;
}
function aqiCategory(value: number | null): string {
  if (value === null) return "No reading";
  if (value <= 50) return "Good";
  if (value <= 100) return "Satisfactory";
  if (value <= 200) return "Moderate";
  if (value <= 300) return "Poor";
  if (value <= 400) return "Very Poor";
  return "Severe";
}
function aqiColor(value: number | null): string {
  if (value === null) return "#8b929e";
  if (value <= 50) return "#31a354";
  if (value <= 100) return "#a3c920";
  if (value <= 200) return "#e8b323";
  if (value <= 300) return "#e87926";
  if (value <= 400) return "#cb3d3d";
  return "#8e2c62";
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const middle = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
function age(value: string | null): string {
  if (!value) return "Timestamp not supplied";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const minutes = Math.max(0, Math.floor((Date.now()-time)/60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  if (minutes < 1440) return Math.floor(minutes/60) + " h ago";
  return Math.floor(minutes/1440) + " d ago";
}

function PixelCity({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = 480; canvas.height = 220; ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0b1322"; ctx.fillRect(0,0,480,220);
    for (let i=0;i<34;i++) {
      ctx.fillStyle = i%4===0 ? "#e8edf4" : "#657187";
      ctx.fillRect((i*83+17)%480,(i*37+13)%116,4,4);
    }
    const buildings = [[0,150,52,70],[40,122,28,98],[88,142,32,78],[126,111,35,109],[166,158,45,62],[219,135,38,85],[268,96,52,124],[326,119,35,101],[365,150,42,70],[415,126,65,94]];
    for (const [x,y,w,h] of buildings) {
      ctx.fillStyle="#171f30";ctx.fillRect(x,y,w,h);
      ctx.fillStyle="#101828";ctx.fillRect(x+5,y+7,Math.max(0,w-10),Math.max(0,h-7));
      for(let wx=x+7;wx<x+w-5;wx+=13) for(let wy=y+12;wy<214;wy+=17) if(((wx*3+wy*5)%7)<3){ctx.fillStyle="#f4d56f";ctx.fillRect(wx,wy,4,5);}
    }
    ctx.fillStyle="#111a2a";ctx.fillRect(0,194,480,26);
  },[]);
  return <div className="chennai-pixel-scene"><canvas ref={ref} role="img" aria-label="Pixel art Chennai skyline"/><span>CHENNAI · AIR QUALITY</span><strong>{value}</strong></div>;
}

export default function ChennaiAqiDashboard({ apiBase = "" }: { apiBase?: string }) {
  const [stations,setStations]=useState<Station[]>([]);
  const [state,setState]=useState<FeedState>("loading");
  const [error,setError]=useState("");
  const [updated,setUpdated]=useState<string|null>(null);
  const [metric,setMetric]=useState("aqi");
  const [source,setSource]=useState("all");
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<string|null>(null);
  const [retry,setRetry]=useState(0);
  const mapEl=useRef<HTMLDivElement|null>(null);
  const mapRef=useRef<MapLibreMap|null>(null);
  const mapReady=useRef(false);
  const markers=useRef<MapLibreMarker[]>([]);

  useEffect(()=>{
    let active=true;
    const load=async()=>{
      setState("loading");setError("");
      try{
        const response=await fetch(apiBase+"/api/chennai-aqi/stations",{headers:{Accept:"application/json"},cache:"no-store"});
        const payload=await response.json().catch(()=>null);
        if(!response.ok){
          const message=payload&&typeof payload==="object"&&"message" in payload?String((payload as {message:unknown}).message):"Station feed returned HTTP "+response.status;
          throw new Error(message);
        }
        const list=normalize(payload);
        if(!list.length) throw new Error("The upstream responded, but station records could not be identified. No example readings are substituted.");
        if(!active)return;
        setStations(list);setState("online");setUpdated(new Date().toISOString());
        setSelected(current=>current&&list.some(st=>st.id===current)?current:(list.find(st=>st.aqi!==null)?.id??list[0].id));
      }catch(err){
        if(!active)return;
        setStations([]);setState("offline");setError(err instanceof Error?err.message:"Station feed is unavailable.");
      }
    };
    void load();
    const timer=window.setInterval(()=>void load(),5*60*1000);
    return()=>{active=false;window.clearInterval(timer);};
  },[apiBase,retry]);

  useEffect(()=>{
    let cancelled=false;
    let script:HTMLScriptElement|null=null;
    if(!mapEl.current||mapRef.current)return;
    const initMap=()=>{
      if(cancelled||!mapEl.current||!window.maplibregl)return;
      const lib=window.maplibregl;
      const map=new lib.Map({
        container:mapEl.current,center:CITY_CENTER,zoom:10.5,minZoom:8,maxZoom:17,
        attributionControl:true,
        style:{version:8,sources:{osm:{type:"raster",tiles:["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],tileSize:256,attribution:"© OpenStreetMap contributors"}},layers:[{id:"osm-base",type:"raster",source:"osm"}]}
      });
      map.addControl(new lib.NavigationControl({showCompass:false}),"top-right");
      mapRef.current=map;
      map.on("load",()=>{mapReady.current=true;});
    };
    if(window.maplibregl) initMap();
    else {
      script=document.createElement("script");
      script.src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js";
      script.async=true;
      script.onload=initMap;
      script.onerror=()=>{if(!cancelled)setError("The map renderer could not be loaded from its CDN.");};
      const css=document.createElement("link");
      css.rel="stylesheet";
      css.href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css";
      if(!document.querySelector('link[data-chennai-maplibre="true"]')) {
        css.dataset.chennaiMaplibre="true";
        document.head.appendChild(css);
      }
      document.head.appendChild(script);
    }
    return()=>{cancelled=true;markers.current.forEach(marker=>marker.remove());markers.current=[];mapRef.current?.remove();mapRef.current=null;mapReady.current=false;if(script)script.remove();};
  },[]);

  const sourceOptions=useMemo(()=>["all",...new Set(stations.map(st=>st.source).filter(Boolean))],[stations]);
  const filtered=useMemo(()=>stations.filter(st=>{
    const sourceMatch=source==="all"||st.source===source;
    const q=query.trim().toLowerCase();
    return sourceMatch&&(!q||st.name.toLowerCase().includes(q)||st.source.toLowerCase().includes(q)||st.id.toLowerCase().includes(q));
  }),[stations,source,query]);
  const ranked=useMemo(()=>[...filtered].filter(st=>valueFor(st,metric)!==null).sort((a,b)=>(valueFor(b,metric)??-Infinity)-(valueFor(a,metric)??-Infinity)),[filtered,metric]);
  const selectedStation=stations.find(st=>st.id===selected)||null;
  const aqiValues=stations.map(st=>st.aqi).filter((v):v is number=>v!==null);
  const cityMedian=median(aqiValues);
  const worst=[...stations].filter(st=>st.aqi!==null).sort((a,b)=>(b.aqi??0)-(a.aqi??0))[0]||null;
  const networkCount=new Set(stations.map(st=>st.source)).size;
  const metricLabel=POLLUTANTS.find(x=>x.id===metric)?.label??"AQI";

  useEffect(()=>{
    const map=mapRef.current;if(!map||!mapReady.current)return;
    markers.current.forEach(marker=>marker.remove());markers.current=[];
    for(const station of filtered){
      if(station.lat===null||station.lon===null)continue;
      const value=valueFor(station,metric);
      const element=document.createElement("button");
      element.type="button";element.className="chennai-map-marker"+(station.id===selected?" selected":"");
      element.style.setProperty("--marker-color",metric==="aqi"?aqiColor(station.aqi):"#4d91c7");
      element.textContent=value===null?"·":String(Math.round(value));
      element.title=station.name+" · "+(value===null?"No "+metricLabel+" reading":metricLabel+" "+value);
      element.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();setSelected(station.id);});
      markers.current.push(new window.maplibregl!.Marker({element,anchor:"center"}).setLngLat([station.lon,station.lat]).addTo(map));
    }
    if(selectedStation?.lat!==null&&selectedStation?.lon!==null&&selectedStation?.lat!==undefined&&selectedStation?.lon!==undefined)
      map.easeTo({center:[selectedStation.lon,selectedStation.lat],duration:400});
  },[filtered,metric,selected,selectedStation,metricLabel]);

  return <section className="content chennai-aqi-content">
    <div className="sectionhead chennai-aqi-head">
      <div><div className="eyebrow">RECLAIM CHENNAI · PUBLIC STATION FEED</div><h2>Chennai air quality, live</h2><p className="chennai-aqi-subtitle">Station-level AQI and pollutant readings across the city.</p></div>
      <div className="chennai-feed-actions"><span className={"chennai-feed-status "+state}><i/>{state==="online"?"LIVE SOURCE":state==="loading"?"CONNECTING":"SOURCE UNAVAILABLE"}</span><button className="chennai-refresh" onClick={()=>setRetry(v=>v+1)} disabled={state==="loading"}><RefreshCw size={14}/> Refresh</button></div>
    </div>

    <div className="chennai-hero"><PixelCity value={cityMedian===null?"—":String(Math.round(cityMedian))}/><div className="chennai-hero-copy"><div className="chennai-hero-label">MEDIAN STATION AQI · CPCB SCALE</div><div className="chennai-hero-number">{cityMedian===null?"—":Math.round(cityMedian)}</div><span className="chennai-aqi-category" style={{backgroundColor:aqiColor(cityMedian)}}>{aqiCategory(cityMedian)}</span><p>Median of the station AQI readings returned by the public source. This is not a separately calculated regulatory city-wide AQI.</p><small>{stations.length?aqiValues.length+" stations with AQI · "+age(updated):state==="loading"?"Loading public station records…":"No live station readings received"}</small></div></div>

    <div className="chennai-metrics">
      <article><div>STATIONS REPORTING</div><strong>{stations.length||"—"}</strong><small>Records returned by source</small></article>
      <article><div>STATION NETWORKS</div><strong>{networkCount||"—"}</strong><small>Distinct source labels</small></article>
      <article><div>STATIONS ABOVE 200</div><strong>{stations.length?stations.filter(st=>(st.aqi??0)>200).length:"—"}</strong><small>Poor or worse · station AQI</small></article>
      <article><div>HIGHEST STATION AQI</div><strong>{worst?.aqi===null||!worst?"—":Math.round(worst.aqi)}</strong><small>{worst?.name||"No AQI data"}</small></article>
    </div>

    {state==="offline"?<div className="chennai-feed-error"><AlertCircle size={20}/><div><strong>Live station data is unavailable</strong><p>{error} The reference screenshot and example values are not used as fallback data.</p></div><a href="https://pol.reclaimchennai.city/#m=aqi_in&h=24" target="_blank" rel="noreferrer">Open source dashboard <ExternalLink size={13}/></a></div>:null}

    <div className="chennai-map-layout">
      <article className="chennai-map-card">
        <div className="chennai-map-toolbar"><div className="chennai-metric-switch" aria-label="Pollutant layer">{POLLUTANTS.map(item=><button key={item.id} className={metric===item.id?"active":""} onClick={()=>setMetric(item.id)}>{item.label}</button>)}</div><label className="chennai-source-filter"><Filter size={14}/><select value={source} onChange={e=>setSource(e.target.value)}><option value="all">All sources</option>{sourceOptions.filter(x=>x!=="all").sort().map(x=><option key={x} value={x}>{x}</option>)}</select></label></div>
        <div className="chennai-map-wrap"><div className="chennai-map" ref={mapEl}/>{!stations.length?<div className="chennai-map-overlay"><div><MapPin size={20}/><strong>{state==="loading"?"Loading Chennai station map":"Station markers will appear here"}</strong><span>{state==="loading"?"Connecting to the public station feed.":"Map tiles load independently; AQI markers require real station coordinates and readings."}</span></div></div>:null}<div className="chennai-map-legend"><span><i style={{background:"#31a354"}}/> 0–50</span><span><i style={{background:"#a3c920"}}/> 51–100</span><span><i style={{background:"#e8b323"}}/> 101–200</span><span><i style={{background:"#e87926"}}/> 201–300</span><span><i style={{background:"#cb3d3d"}}/> 301+</span></div></div>
        <div className="chennai-map-footer"><span>MAP: © OPENSTREETMAP CONTRIBUTORS · CHENNAI</span><span>{filtered.filter(st=>st.lat!==null&&st.lon!==null).length} MAPPED STATIONS</span></div>
      </article>
      <aside className="chennai-ranking">
        <div className="chennai-ranking-head"><div><div className="eyebrow">LATEST AVAILABLE READING</div><h3>Station ranking</h3></div><span>{ranked.length} stations</span></div>
        <label className="chennai-search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search station or source…"/></label>
        <div className="chennai-ranking-list">{ranked.slice(0,14).map((station,index)=>{const value=valueFor(station,metric);return <button key={station.id} className={"chennai-ranking-row"+(station.id===selected?" selected":"")} onClick={()=>setSelected(station.id)}><span className="chennai-rank-index">{String(index+1).padStart(2,"0")}</span><span className="chennai-ranking-name"><strong>{station.name}</strong><small>{station.source} · {aqiCategory(station.aqi)}</small></span><strong className="chennai-ranking-value" style={{color:metric==="aqi"?aqiColor(station.aqi):"#1c2736"}}>{value===null?"—":Number(value.toFixed(1))}</strong></button>;})}{!ranked.length?<div className="chennai-ranking-empty">{state==="loading"?"Loading station records…":"No matching station readings in the current feed."}</div>:null}</div>
        {selectedStation?<div className="chennai-selected-station"><div className="eyebrow">SELECTED STATION</div><strong>{selectedStation.name}</strong><span>{selectedStation.source} · ID {selectedStation.id}</span><span>{selectedStation.aqi===null?"AQI not supplied":"AQI "+selectedStation.aqi+" · "+aqiCategory(selectedStation.aqi)}</span><small>{age(selectedStation.updatedAt)}</small></div>:null}
      </aside>
    </div>

    <div className="chennai-history-placeholder"><div><Clock3 size={16}/><strong>Historical replay</strong></div><span>6h · 24h · 3d · 7d · 30d · 1y</span><small>Historical controls are not active until a public station-history endpoint is verified. This page uses the latest station snapshot only.</small></div>
    <div className="chennai-source-note"><div><strong>DATA & ATTRIBUTION</strong><p>Station source endpoint: api.airquality.info · Chennai. Dashboard reference: Reclaim Chennai. AQI categories use the CPCB scale. Values are shown as received; missing readings are not interpolated.</p></div><a href="https://pol.reclaimchennai.city/#m=aqi_in&h=24" target="_blank" rel="noreferrer">Visit Reclaim Chennai AQI <ExternalLink size={13}/></a></div>
  </section>;
}
