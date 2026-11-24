# Wind Map

Global interactive marine and aviation wind forecast cockpit, published live at **[sounny.github.io/windmap](https://sounny.github.io/windmap/)**.

## Overview

Wind Map visualizes a 7-day global surface (10 m) wind forecast alongside live point weather observations and great-circle route planning. Users can inspect wind speed, gusts, pressure, temperature, and flow direction anywhere on Earth, switch between precision vector arrows and 60 FPS fluid particles, and export planned voyages.

## Features

- **Global Wind Field (Arrows & Particles)**: High-DPI HTML5 Canvas arrow vector field and 60 FPS animated fluid particle streamlines built over a regular 2.5-degree global grid (`-75°` to `77.5°` latitude, full `-180°` to `180°` wrap), using WMO/NOAA marine velocity color tiers.
- **7-Day Timeline Scrubber**: Navigate daily maximum NOAA GFS (`gfs_seamless`) forecasts with auto-play (`1x`, `2x`, `4x`) and keyboard/step controls, automatically aligned to today's UTC date on load.
- **Great-Circle Route Planner**: Click the map to drop waypoints, compute geodesic leg and cumulative distances in nautical miles (`NM`), hover anywhere along the route line for interpolated wind, point of sail, and headwind/tailwind components, and export routes as **GPX** or **GeoJSON**.
- **Live Point Telemetry & Geocoding**: Point clicks and location searches query live 10 m wind speed, gusts, direction, MSL pressure, and temperature from Open-Meteo, falling back seamlessly to bilinear interpolation on the NOAA GFS grid.
- **Keyless Basemaps & Controls**: Toggle between Esri Dark/Light Vector nautical charts and Satellite imagery, `FROM` (meteorological) vs `TO` (flow) direction conventions, and `kts`, `mph`, `km/h`, `m/s`, or Beaufort units.

## Architecture

- [`index.html`](index.html): Cockpit layout, glassmorphic HUD, legend, telemetry drawer, and timeline dock.
- [`style.css`](style.css): Dark/light theme tokens, Leaflet popup overrides, responsive styling, and glassmorphic UI components.
- [`NewScript.js`](NewScript.js): Canvas vector/particle renderers, O(1) bilinear field interpolation, spherical great-circle routing, search autocomplete, and GPX/GeoJSON exporters.
- [`downloadData.py`](downloadData.py): Fetches NOAA GFS (`gfs_seamless`) daily wind telemetry across 360 global grid stations from Open-Meteo, interpolates onto a 2.5-degree grid (`8,928` points/day) using latitude-corrected IDW, and atomically writes `forecast.json`.

## Local Development

1. Clone the repository:

   ```bash
   git clone https://github.com/sounny/windmap.git
   cd windmap
   ```

2. (Optional) Refresh the local `forecast.json` dataset:

   ```bash
   pip install -r requirements.txt
   python downloadData.py
   ```

3. Serve the static files locally (required so `fetch('forecast.json')` works):

   ```bash
   python -m http.server 8000
   ```

   Then open `http://localhost:8000` in your browser.

## Deployment & Automation

- **GitHub Pages (`deploy-pages.yml`)**: Deploys static assets and builds a fresh `_site/forecast.json` via `downloadData.py` on every push to `main` and every 6 hours on schedule (`15 */6 * * *`), eliminating large automated data commits on `main`.
- **Hourly Health Check (`hourly-health-check.yml`)**: Validates JavaScript/Python syntax, verifies the live GitHub Pages deployment and `forecast.json` schema/freshness, and probes upstream Esri and Open-Meteo endpoints every hour.

## Data Sources

- **Global 7-Day Wind Forecast & Live Point Weather / Geocoding**: [Open-Meteo](https://open-meteo.com/) (NOAA GFS `gfs_seamless`)
- **Basemap Tiles**: Esri ArcGIS World Dark Gray / Light Gray Canvas & World Imagery
- **Mapping Engine**: [Leaflet](https://leafletjs.com/)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
