import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertCircle, Clock3, ExternalLink, Filter, MapPin, RefreshCw, Search } from "lucide-react";

type Station = {
  id: string; name: string; source: string; city: string;
  lat: number | null; lon: number | null; aqi: number | null;
  updatedAt: string | null; scrapedAt: string | null; pollutants: Record<string, number>;
};
type FeedState = "loading" | "online" | "offline";
const CITY_CENTER: [number, number] = [80.2667, 13.0833];
const POLLUTANTS = [
  { id: "aqi", label: "AQI" }, { id: "pm25", label: "PM2.5" },
  { id: "pm10", label: "PM10" }, { id: "no2", label: "NO₂" },
  { id: "so2", label: "SO₂" }, { id: "o3", label: "O₃" },
  { id: "co", label: "CO" }, { id: "nh3", label: "NH₃" }, { id: "tvoc", label: "TVOC" },
  { id: "noise", label: "NOISE" }, { id: "temp_c", label: "TEMP" },
  { id: "wind_kph", label: "WIND" }, { id: "rain_accum_mm", label: "RAIN" }
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
  const pollutantSources: Record<string, string[]> = {
    pm25: ["pm25"],
    pm10: ["pm10"],
    no2: ["no2"],
    so2: ["so2"],
    o3: ["ozone", "o3"],
    co: ["co"],
    nh3: ["nh3"],
    tvoc: ["tvoc"],
    noise: ["noise"],
    temp_c: ["temp_c"],
    wind_kph: ["wind_kph"],
    rain_accum_mm: ["rain_accum_mm", "precip_mm"]
  };

  return rowsFrom(payload).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const lat = num(raw.latitude ?? raw.lat);
    const lon = num(raw.longitude ?? raw.lon ?? raw.lng);
    // Reclaim Chennai's selected dashboard metric is aqi_in, not the
    // generic aqi field. Keep aqi as fallback for stations without aqi_in.
    const aqi = num(raw.aqi_in ?? raw.aqi ?? raw.AQI ?? raw.current_aqi ?? raw.index);
    const pollutants: Record<string, number> = {};
    for (const [metric, keys] of Object.entries(pollutantSources)) {
      const value = keys.map((key) => num(raw[key])).find((item) => item !== null) ?? null;
      if (value !== null) pollutants[metric] = value;
    }
    const updated = raw.station_updated_at ?? raw.source_updated_at ?? raw.updated_at ?? raw.timestamp ?? raw.time;
    const scraped = raw.scraped_at;
    const name = String(raw.display_name ?? raw.location_name ?? raw.name ?? raw.station_name ?? raw.location ?? raw.title ?? "Unnamed station");
    const source = String(raw.source ?? raw.provider ?? raw.network ?? raw.source_name ?? "Source not reported");
    const city = String(raw.city ?? "Unknown area");
    const providedId = raw.uid ?? raw.id ?? raw.station_id ?? raw.code;
    const fallbackId = [name, source, lat ?? "", lon ?? ""].map((part) => encodeURIComponent(String(part))).join("|");

    return [{
      id: providedId === undefined || providedId === null || String(providedId).trim() === ""
        ? "derived:" + fallbackId
        : String(providedId),
      name,
      source,
      city,
      lat: lat !== null && lat > 12.3 && lat < 14 && lon !== null && lon > 79.4 && lon < 81.2 ? lat : null,
      lon: lon !== null && lon > 79.4 && lon < 81.2 && lat !== null && lat > 12.3 && lat < 14 ? lon : null,
      aqi,
      updatedAt: typeof updated === "string" || typeof updated === "number" ? String(updated) : null,
      scrapedAt: typeof scraped === "string" || typeof scraped === "number" ? String(scraped) : null,
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

function toWorld(lon: number, lat: number, zoom: number): [number, number] {
  const scale = 256 * Math.pow(2, zoom);
  const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin(safeLat * Math.PI / 180);
  return [
    (lon + 180) / 360 * scale,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  ];
}

function fromWorld(x: number, y: number, zoom: number): [number, number] {
  const scale = 256 * Math.pow(2, zoom);
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  const lat = 180 / Math.PI * Math.atan(Math.sinh(n));
  return [lon, lat];
}

function ChennaiTileMap({
  stations, metric, selected, metricLabel, onSelect
}: {
  stations: Station[];
  metric: string;
  selected: string | null;
  metricLabel: string;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 900, height: 570 });
  const [center, setCenter] = useState<[number, number]>(CITY_CENTER);
  const [zoom, setZoom] = useState(10);
  const [tileError, setTileError] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const centerWorld = toWorld(center[0], center[1], zoom);
  const viewLeft = centerWorld[0] - size.width / 2;
  const viewTop = centerWorld[1] - size.height / 2;
  const tileCount = Math.pow(2, zoom);
  const firstTileX = Math.floor(viewLeft / 256);
  const firstTileY = Math.floor(viewTop / 256);
  const columns = Math.ceil(size.width / 256) + 1;
  const rows = Math.ceil(size.height / 256) + 1;

  const tiles: Array<{ key: string; url: string; left: number; top: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = firstTileX + column;
      const y = firstTileY + row;
      if (y < 0 || y >= tileCount) continue;
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: zoom + "/" + x + "/" + y,
        url: "https://tile.openstreetmap.org/" + zoom + "/" + wrappedX + "/" + y + ".png",
        left: x * 256 - viewLeft,
        top: y * 256 - viewTop
      });
    }
  }

  const visibleStations = stations.flatMap((station) => {
    if (station.lat === null || station.lon === null) return [];
    const [x, y] = toWorld(station.lon, station.lat, zoom);
    if (x < viewLeft - 30 || x > viewLeft + size.width + 30 ||
        y < viewTop - 30 || y > viewTop + size.height + 30) return [];
    return [{ station, left: x - viewLeft, top: y - viewTop, value: valueFor(station, metric) }];
  });

  useEffect(() => {
    const station = stations.find((item) => item.id === selected);
    if (station?.lat !== null && station?.lon !== null && station?.lat !== undefined && station?.lon !== undefined) {
      setCenter([station.lon, station.lat]);
    }
  }, [stations, selected]);

  const moveBy = (dx: number, dy: number) => {
    const world = toWorld(center[0], center[1], zoom);
    setCenter(fromWorld(world[0] - dx, world[1] - dy, zoom));
  };

  return <div
    className="chennai-map"
    ref={containerRef}
    onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      dragRef.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!dragRef.current) return;
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      dragRef.current = { x: event.clientX, y: event.clientY };
      moveBy(dx, dy);
    }}
    onPointerUp={() => { dragRef.current = null; }}
    onPointerCancel={() => { dragRef.current = null; }}
  >
    <div className="chennai-tile-layer">
      {tiles.map((tile) => <img
        key={tile.key}
        src={tile.url}
        alt=""
        draggable={false}
        onError={() => setTileError(true)}
        style={{ left: tile.left, top: tile.top }}
      />)}
    </div>
    {visibleStations.map(({ station, left, top, value }) => <button
      key={station.id}
      type="button"
      className={"chennai-map-marker" + (station.id === selected ? " selected" : "")}
      style={{ left, top, "--marker-color": metric === "aqi" ? aqiColor(station.aqi) : "#4d91c7" } as CSSProperties & { "--marker-color": string }}
      title={station.name + " · " + (value === null ? "No " + metricLabel + " reading" : metricLabel + " " + value)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onSelect(station.id)}
    >{value === null ? "·" : String(Math.round(value))}</button>)}
    <div className="chennai-map-controls" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(16, value + 1))}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(7, value - 1))}>−</button>
      <button type="button" aria-label="Reset map view" onClick={() => { setCenter(CITY_CENTER); setZoom(10); }}>⌂</button>
    </div>
    {tileError ? <div className="chennai-map-tile-error">Some OpenStreetMap tiles could not be loaded.</div> : null}
    <span className="chennai-map-zoom-label">ZOOM {zoom} · DRAG TO PAN</span>
  </div>;
}

function PixelCity({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    });
    let visible = true;
    let animationFrame = 0;
    let lastFrame = 0;
    canvas.width = 480;
    canvas.height = 220;
    ctx.imageSmoothingEnabled = false;

    const buildings = [
      [0,150,52,70],[40,122,28,98],[88,142,32,78],[126,111,35,109],
      [166,158,45,62],[219,135,38,85],[268,96,52,124],[326,119,35,101],
      [365,150,42,70],[415,126,65,94]
    ];
    const stars = Array.from({length:38},(_,i)=>({
      x:(i*83+17)%480,y:(i*37+13)%116,phase:i*0.73,bright:i%4===0
    }));

    const draw = (time:number) => {
      ctx.fillStyle="#0b1322";ctx.fillRect(0,0,480,220);
      // Band-shaded night sky and gently twinkling pixel stars.
      for(let band=0;band<7;band++){
        ctx.fillStyle=["#0b1322","#0d1628","#101a2e","#121d32","#162138","#19243a","#1b2940"][band];
        ctx.fillRect(0,band*17,480,17);
      }
      for(const star of stars){
        const blink=0.2+0.8*Math.abs(Math.sin(time*1.2+star.phase));
        ctx.globalAlpha=reducedMotion.matches?0.8:blink;
        ctx.fillStyle=star.bright?"#e8edf4":"#7e8a9e";
        ctx.fillRect(star.x,star.y,star.bright?4:3,star.bright?4:3);
      }
      ctx.globalAlpha=1;

      // Pixel skyline. Window lights switch in stepped groups.
      for(let b=0;b<buildings.length;b++){
        const [x,y,w,h]=buildings[b];
        ctx.fillStyle="#171f30";ctx.fillRect(x,y,w,h);
        ctx.fillStyle="#101828";ctx.fillRect(x+5,y+7,Math.max(0,w-10),Math.max(0,h-7));
        for(let wx=x+7;wx<x+w-5;wx+=13){
          for(let wy=y+12;wy<214;wy+=17){
            const seed=Math.floor((wx*3+wy*5+b*11)%7);
            if(seed<3){
              const on=reducedMotion.matches||Math.sin(time*0.9+wx*0.11+wy*0.07)>-0.55;
              ctx.fillStyle=on?"#f4d56f":"#6b6044";
              ctx.fillRect(wx,wy,4,5);
            }
          }
        }
      }

      // A low pixel scan beam sweeps across the skyline.
      const beamX=(time*26)%520-20;
      ctx.fillStyle="rgba(245,207,105,.22)";
      ctx.fillRect(Math.floor(beamX/4)*4,102,4,116);
      ctx.fillStyle="#111a2a";ctx.fillRect(0,194,480,26);
      // Three stepped traffic lights move along the foreground.
      for(let i=0;i<5;i++){
        const lightX=(time*18+i*103)%510-15;
        ctx.fillStyle=i%2?"#d6b05b":"#e3d9b4";
        ctx.fillRect(Math.floor(lightX/3)*3,204+(i%2)*5,5,3);
      }
    };

    observer.observe(canvas);
    draw(0);
    const tick=(now:number)=>{
      animationFrame=window.requestAnimationFrame(tick);
      if(!visible||document.hidden||reducedMotion.matches||now-lastFrame<1000/12)return;
      lastFrame=now;
      draw(now/1000);
    };
    if(!reducedMotion.matches) animationFrame=window.requestAnimationFrame(tick);
    return()=>{
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  },[]);
  return <div className="chennai-pixel-scene">
    <canvas ref={ref} role="img" aria-label="Animated pixel art Chennai skyline"/>
    <span>CHENNAI · AIR QUALITY</span>
    <strong>{value}</strong>
    <small className="chennai-scene-motion-label">PIXEL SCENE · 12 FPS</small>
  </div>;
}

type SkyCamera = {
  id: number;
  camera_id: string;
  captured_at: string;
  verdict: string | null;
  confidence: number | null;
  rain_truth: string | null;
  name: string | null;
  bearing: number | null;
  image: string;
};
type SkyDataset = {
  cameras: SkyCamera[];
  site?: { name?: string; credit?: string; url?: string };
  hours?: number;
  end?: string;
  totals?: { frames?: number; labelled?: number; wet?: number; agree?: number; judged?: number; since?: string };
  series?: Array<Record<string, unknown>>;
};

function SkyCameraCard({camera,apiBase}:{camera:SkyCamera;apiBase:string}) {
  const [imageFailed,setImageFailed]=useState(false);
  const imageMatch=camera.image.match(/^\/sky\/(\d{1,10})\.jpg$/);
  const imageUrl=imageMatch?apiBase+"/api/chennai-aqi/sky/image/"+imageMatch[1]:"";
  const rainLabel=camera.rain_truth&&camera.rain_truth!=="unknown"?camera.rain_truth:camera.verdict||"Unclassified";
  return <article className="chennai-sky-camera">
    <div className="chennai-sky-frame">
      {imageUrl&&!imageFailed?<img src={imageUrl} alt={(camera.name||camera.camera_id)+" source camera frame"} onError={()=>setImageFailed(true)}/>:<div className="chennai-sky-image-missing">CAMERA FRAME UNAVAILABLE</div>}
      <span className="chennai-sky-rec"><i/> SOURCE FRAME</span>
      <span className="chennai-sky-camera-id">{(camera.name||camera.camera_id).toUpperCase()}</span>
    </div>
    <div className="chennai-sky-camera-meta">
      <strong>{rainLabel}</strong>
      <span>{camera.confidence===null||camera.confidence===undefined?"—":Math.round(camera.confidence*100)+"%"}</span>
    </div>
    <small>{age(camera.captured_at)} · bearing {camera.bearing??"—"}°</small>
  </article>;
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
  const [skyData,setSkyData]=useState<SkyDataset|null>(null);
  const [skyState,setSkyState]=useState<FeedState>("loading");
  const [skyError,setSkyError]=useState("");
  const requestSequence=useRef(0);

  useEffect(()=>{
    let disposed=false;
    let timer: number | undefined;
    let controller: AbortController | null=null;

    const load=async()=>{
      const requestId=++requestSequence.current;
      controller?.abort();
      const currentController=new AbortController();
      controller=currentController;
      setState("loading");
      setError("");
      try{
        const response=await fetch(apiBase+"/api/chennai-aqi/stations",{
          headers:{Accept:"application/json"},cache:"no-store",signal:currentController.signal
        });
        const payload=await response.json().catch(()=>null);
        if(!response.ok){
          const message=payload&&typeof payload==="object"&&"message" in payload?String((payload as {message:unknown}).message):"Station feed returned HTTP "+response.status;
          throw new Error(message);
        }
        const list=normalize(payload);
        if(!list.length) throw new Error("The upstream responded, but station records could not be identified. No example readings are substituted.");
        if(disposed||requestId!==requestSequence.current)return;
        setStations(list);
        setState("online");
        setUpdated(response.headers.get("X-AQI-Updated-At"));
        setSelected(current=>current&&list.some(st=>st.id===current)?current:(list.find(st=>st.aqi!==null)?.id??list[0].id));
      }catch(err){
        if(disposed||requestId!==requestSequence.current||currentController.signal.aborted)return;
        setStations([]);
        setState("offline");
        setError(err instanceof Error?err.message:"Station feed is unavailable.");
      }finally{
        if(!disposed&&requestId===requestSequence.current){
          timer=window.setTimeout(()=>void load(),5*60*1000);
        }
      }
    };
    void load();
    return()=>{
      disposed=true;
      requestSequence.current+=1;
      controller?.abort();
      if(timer!==undefined)window.clearTimeout(timer);
    };
  },[apiBase,retry]);

  useEffect(()=>{
    let disposed=false;
    let timer:number|undefined;
    const controller=new AbortController();
    const load=async()=>{
      setSkyState("loading");
      setSkyError("");
      try{
        const response=await fetch(apiBase+"/api/chennai-aqi/sky",{
          headers:{Accept:"application/json"},cache:"no-store",signal:controller.signal
        });
        const payload=await response.json().catch(()=>null);
        if(!response.ok){
          const message=payload&&typeof payload==="object"&&"message" in payload
            ?String((payload as {message:unknown}).message)
            :"Sky camera feed returned HTTP "+response.status;
          throw new Error(message);
        }
        if(!payload||typeof payload!=="object"||!Array.isArray((payload as {cameras?:unknown}).cameras)){
          throw new Error("The source returned an unrecognized sky-camera dataset.");
        }
        if(disposed)return;
        setSkyData(payload as SkyDataset);
        setSkyState("online");
      }catch(err){
        if(disposed||controller.signal.aborted)return;
        setSkyData(null);
        setSkyState("offline");
        setSkyError(err instanceof Error?err.message:"Sky camera dataset is unavailable.");
      }finally{
        if(!disposed)timer=window.setTimeout(()=>void load(),15*60*1000);
      }
    };
    void load();
    return()=>{
      disposed=true;
      controller.abort();
      if(timer!==undefined)window.clearTimeout(timer);
    };
  },[apiBase,retry]);

  const sourceOptions=useMemo(()=>["all",...new Set(stations.map(st=>st.source).filter(Boolean))],[stations]);
  const filtered=useMemo(()=>stations.filter(st=>{
    const sourceMatch=source==="all"||st.source===source;
    const q=query.trim().toLowerCase();
    return sourceMatch&&(!q||st.name.toLowerCase().includes(q)||st.source.toLowerCase().includes(q)||st.id.toLowerCase().includes(q));
  }),[stations,source,query]);
  const ranked=useMemo(()=>[...filtered].filter(st=>valueFor(st,metric)!==null).sort((a,b)=>(valueFor(b,metric)??-Infinity)-(valueFor(a,metric)??-Infinity)),[filtered,metric]);
  const selectedStation=filtered.find(st=>st.id===selected)||null;
  const aqiValues=stations.map(st=>st.aqi).filter((v):v is number=>v!==null);
  const cityMedian=median(aqiValues);
  const worst=[...stations].filter(st=>st.aqi!==null).sort((a,b)=>(b.aqi??0)-(a.aqi??0))[0]||null;
  const networkCount=new Set(stations.map(st=>st.source)).size;
  const metricLabel=POLLUTANTS.find(x=>x.id===metric)?.label??"AQI";
  const latestMeasurement=stations.map(st=>st.updatedAt).filter((value):value is string=>Boolean(value)&&Number.isFinite(Date.parse(value as string))).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null;
  const stationsAbove200=aqiValues.length?aqiValues.filter(value=>value>200).length:null;

  return <section className="content chennai-aqi-content">
    <div className="sectionhead chennai-aqi-head">
      <div><div className="eyebrow">RECLAIM CHENNAI · PUBLIC STATION FEED</div><h2>Chennai air quality, live</h2><p className="chennai-aqi-subtitle">Station-level AQI and pollutant readings across the city.</p></div>
      <div className="chennai-feed-actions"><span className={"chennai-feed-status "+state}><i/>{state==="online"?"LIVE SOURCE":state==="loading"?"CONNECTING":"SOURCE UNAVAILABLE"}</span><button className="chennai-refresh" onClick={()=>setRetry(v=>v+1)} disabled={state==="loading"}><RefreshCw size={14}/> Refresh</button></div>
    </div>

    <div className="chennai-hero"><PixelCity value={cityMedian===null?"—":String(Math.round(cityMedian))}/><div className="chennai-hero-copy"><div className="chennai-hero-label">MEDIAN STATION AQI · CPCB SCALE</div><div className="chennai-hero-number">{cityMedian===null?"—":Math.round(cityMedian)}</div><span className="chennai-aqi-category" style={{backgroundColor:aqiColor(cityMedian)}}>{aqiCategory(cityMedian)}</span><p>Median of the station AQI readings returned by the public source. This is not a separately calculated regulatory city-wide AQI.</p><small>{stations.length?aqiValues.length+" stations with AQI · latest measurement "+age(latestMeasurement)+" · feed fetched "+age(updated):state==="loading"?"Loading public station records…":"No live station readings received"}</small></div></div>

    <div className="chennai-metrics">
      <article><div>STATIONS REPORTING</div><strong>{stations.length||"—"}</strong><small>Records returned by source</small></article>
      <article><div>STATION NETWORKS</div><strong>{networkCount||"—"}</strong><small>Distinct source labels</small></article>
      <article><div>STATIONS ABOVE 200</div><strong>{stationsAbove200===null?"—":stationsAbove200}</strong><small>Poor or worse · station AQI</small></article>
      <article><div>HIGHEST STATION AQI</div><strong>{worst?.aqi == null ? "—" : Math.round(worst.aqi)}</strong><small>{worst?.name||"No AQI data"}</small></article>
    </div>

    {state==="offline"?<div className="chennai-feed-error"><AlertCircle size={20}/><div><strong>Live station data is unavailable</strong><p>{error} The reference screenshot and example values are not used as fallback data.</p></div><a href="https://pol.reclaimchennai.city/#m=aqi_in&h=24" target="_blank" rel="noreferrer">Open source dashboard <ExternalLink size={13}/></a></div>:null}

    <section className="chennai-sky-section">
      <div className="chennai-sky-head">
        <div><div className="eyebrow">RECLAIM CHENNAI · PUBLIC CAMERA DATASET</div><h3>What the sky looks like</h3><p>Short replay of the latest published camera frames. The source camera frames and camera-derived rain labels are shown with their capture time.</p></div>
        <span className={"chennai-feed-status "+skyState}><i/>{skyState==="online"?"SOURCE CONNECTED":skyState==="loading"?"LOADING FRAMES":"CAMERA FEED UNAVAILABLE"}</span>
      </div>
      {skyData?.cameras?.length?<div className="chennai-sky-grid">
        {skyData.cameras.slice(0,4).map(camera=><SkyCameraCard key={camera.camera_id} camera={camera} apiBase={apiBase}/>)}
      </div>:<div className="chennai-sky-empty">{skyState==="loading"?"Loading source camera frames…":skyError||"No camera records available."}</div>}
      <div className="chennai-sky-foot">
        <span>{skyData?.cameras?.length??0} camera streams · Reclaim Chennai public dataset</span>
        <span>Latest capture: {age(skyData?.end??skyData?.cameras?.map(camera=>camera.captured_at).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null)}</span>
      </div>
      <small className="chennai-sky-disclaimer">These are source camera snapshots, not a live video stream. Rain labels and confidence values are source annotations, not independent EVS0 measurements.</small>
    </section>

    <div className="chennai-map-layout">
      <article className="chennai-map-card">
        <div className="chennai-map-toolbar"><div className="chennai-metric-switch" aria-label="Pollutant layer">{POLLUTANTS.map(item=><button key={item.id} className={metric===item.id?"active":""} onClick={()=>setMetric(item.id)}>{item.label}</button>)}</div><label className="chennai-source-filter"><Filter size={14}/><select value={source} onChange={e=>setSource(e.target.value)}><option value="all">All sources</option>{sourceOptions.filter(x=>x!=="all").sort().map(x=><option key={x} value={x}>{x}</option>)}</select></label></div>
        <div className="chennai-map-wrap"><ChennaiTileMap stations={filtered} metric={metric} selected={selected} metricLabel={metricLabel} onSelect={setSelected}/>{!stations.length?<div className="chennai-map-overlay"><div><MapPin size={20}/><strong>{state==="loading"?"Loading Chennai station map":"Station markers will appear here"}</strong><span>{state==="loading"?"Connecting to the public station feed.":"Map tiles load independently; AQI markers require real station coordinates and readings."}</span></div></div>:null}<div className="chennai-map-legend"><span><i style={{background:"#31a354"}}/> 0–50</span><span><i style={{background:"#a3c920"}}/> 51–100</span><span><i style={{background:"#e8b323"}}/> 101–200</span><span><i style={{background:"#e87926"}}/> 201–300</span><span><i style={{background:"#cb3d3d"}}/> 301–400</span><span><i style={{background:"#8e2c62"}}/> 401+</span></div></div>
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
    <div className="chennai-source-note"><div><strong>DATA & ATTRIBUTION</strong><p>Station feed: Reclaim Chennai public backend (availability depends on its station endpoint). Sky frames: Reclaim Chennai published dataset CSV. AQI categories use the CPCB scale. Values are shown as received; missing readings are not interpolated.</p></div><a href="https://pol.reclaimchennai.city/#m=aqi_in&h=24" target="_blank" rel="noreferrer">Visit Reclaim Chennai AQI <ExternalLink size={13}/></a></div>
  </section>;
}
