# Power Map of India integration

EVS0 includes the public Power Map of India by [Reclaim Chennai](https://github.com/reclaimchennai/power-map-india) as the **Power Map** dashboard tab.

## Integration shape

The integration deliberately reuses the upstream map frontend and published data rather than reimplementing the map renderer or copying its datasets:

```text
Browser
  └── EVS0 React tab
       └── iframe: /api/power-map/
            └── Hono read-only proxy
                 └── https://power.reclaimchennai.city/
                      ├── index.html, JS, CSS, icons
                      ├── data/*.json and data/grid/*.geojson
                      └── other published map resources
```

The upstream frontend requests its own assets and data using relative paths (for example, `data/plants.json`, `data/live/now.json`, and `data/grid/index.json`). Serving the page under `/api/power-map/` keeps those requests on the EVS0 origin and avoids browser CORS requests to the Reclaim Chennai host.

The upstream repository also contains a FastAPI service with routes under `/api/` and `/geo/`. The proxy forwards matching paths when they are available in the configured deployment, e.g. `/api/power-map/api/coal/latest` maps to upstream `/api/coal/latest`. The public map's main renderer primarily consumes the published static JSON/GeoJSON files.

## Configuration

In the repository-root `.env`:

```dotenv
POWER_MAP_UPSTREAM=https://power.reclaimchennai.city
```

The same default is used when the variable is omitted. The proxy requires HTTPS and uses a fixed server-side destination; clients cannot pass an arbitrary target host.

## Proxy behaviour

- Only `GET` and `HEAD` requests are allowed.
- The Hono server forwards the request path and query string to the configured upstream.
- It preserves content type, cache-control, ETag, last-modified, and expiry headers.
- Upstream failures return HTTP 502 with a small JSON error.
- The React iframe points to `/api/power-map/`; the Vite development server already proxies `/api/*` to the Hono API on port 3002.

The upstream map loads some third-party resources directly: MapLibre/three.js from CDNs, vector tiles and glyphs, weather data, fonts, and satellite/terrain tiles. Those providers must continue to support browser CORS. EVS0's proxy removes the cross-origin dependency on the Reclaim Chennai origin; it does not proxy every unrelated third-party provider.

## Run locally

```bash
cp .env.example .env  # only if .env does not already exist
# Keep your existing MQTT values in .env; add POWER_MAP_UPSTREAM if needed.
pnpm install
pnpm dev
```

Open the EVS0 dashboard at `http://localhost:5173` and select **Power Map**. The Hono API must be running; `pnpm dev` starts it with the dashboard.

To inspect the proxy independently:

```bash
curl -I http://localhost:3002/api/power-map/
curl -I http://localhost:3002/api/power-map/data/plants.json
```

## Attribution and data notes

- Map interface and data pipeline: [Power Map of India — Reclaim Chennai](https://github.com/reclaimchennai/power-map-india), [live map](https://power.reclaimchennai.city/).
- The upstream project describes its code as MIT. Its datasets have their own source-specific terms; see its [data licences](https://github.com/reclaimchennai/power-map-india/blob/main/data/LICENSES.md) and the **Sources** section inside the embedded map.
- Do not treat every value as instantaneous. The upstream guide states that station-level generation is generally shown as yesterday's average; Tamil Nadu's state-level SLDC figures are more current. Each dataset has its own freshness interval and limitations.
- EVS0 does not claim ownership of the upstream map or source data. The original map retains its own attribution and source links inside the iframe.
