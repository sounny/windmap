/**
 * Map Winds Pro - Master Client GIS Engine
 * High-performance ocean wind visualization, multi-tier weather telemetry & maritime route planner.
 */

// Global State
let map;
let baseLayers = {};
let currentBaseLayer;
let polyline = null;
const drawnItems = new L.FeatureGroup();

let forecastFeatures = [];
let dateFeatureMap = {};
let availableDates = [];
let currentDateIndex = 0;
let dateRangeData = {};
let currentDisplayData = [];
let bgWarmGeneration = 0;

let waypoints = []; // [{ lat, lng, speed, dir, gusts, pressure, temp, distToPrev, cumDist }]
let currentUnit = 'knots'; // 'knots', 'mph', 'kmh', 'ms', 'bft'
let isPlaying = false;
let playTimer = null;
let playbackSpeed = 800; // ms per frame
const speedMultipliers = [1, 2, 4];
let speedIndex = 0;

// API Configurations
const OWM_API_KEY = '2910d3209cc493d029029a8de276ce7e';

// DOM Elements
const loadingIndicator = document.getElementById('loadingIndicator');
const dateSlider = document.getElementById('dateslider');
const selectedDateLabel = document.getElementById('selectedDate');
const playBtn = document.getElementById('playBtn');
const prevDayBtn = document.getElementById('prevDayBtn');
const nextDayBtn = document.getElementById('nextDayBtn');
const speedMultiplierBtn = document.getElementById('speedMultiplierBtn');
const unitSelect = document.getElementById('unitSelect');
const basemapSelect = document.getElementById('basemapSelect');
const utcTimeDisplay = document.getElementById('utcTimeDisplay');
const sidebarToggle = document.getElementById('sidebarToggle');
const telemetryDrawer = document.getElementById('telemetryDrawer');
const closeDrawerBtn = document.getElementById('closeDrawerBtn');
const locationSearch = document.getElementById('locationSearch');
const searchBtn = document.getElementById('searchBtn');
const resetRouteBtn = document.getElementById('resetRoute');
const exportGpxBtn = document.getElementById('exportGpx');
const exportGeoJsonBtn = document.getElementById('exportGeoJson');
const waypointTableBody = document.getElementById('waypointTableBody');
const waypointCountBadge = document.getElementById('waypointCountBadge');
const totalDistanceVal = document.getElementById('totalDistanceVal');
const compassNeedle = document.getElementById('compassNeedle');
const bearingDegLabel = document.getElementById('bearingDeg');
const cardinalTextLabel = document.getElementById('cardinalText');
const windSpeedVal = document.getElementById('windSpeedVal');
const windSpeedUnit = document.getElementById('windSpeedUnit');
const beaufortChip = document.getElementById('beaufortChip');
const gustSpeedVal = document.getElementById('gustSpeedVal');
const pressureVal = document.getElementById('pressureVal');
const tempVal = document.getElementById('tempVal');
const coordDMS = document.getElementById('coordDMS');
const coordDD = document.getElementById('coordDD');
const telemetrySource = document.getElementById('telemetrySource');
const legendUnitBadge = document.getElementById('legendUnitBadge');

// ============================================================================
// 1. Leaflet Initialization & Tile Layers
// ============================================================================
function initMap() {
  map = L.map('map', {
    preferCanvas: true,
    zoomControl: true,
    minZoom: 3,
    maxZoom: 12
  }).setView([32.5, -64.8], 5);

  // Custom Panes
  map.createPane('windArrows');
  map.getPane('windArrows').style.zIndex = 450;
  map.getPane('windArrows').style.pointerEvents = 'none';

  map.createPane('routePane');
  map.getPane('routePane').style.zIndex = 550;

  // Base Layers
  baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap',
    subdomains: 'abcd',
    maxZoom: 19
  });

  baseLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{x}/{y}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 18
  });

  baseLayers.voyager = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO &copy; OpenStreetMap',
    subdomains: 'abcd',
    maxZoom: 19
  });

  currentBaseLayer = baseLayers.dark.addTo(map);
  map.addLayer(drawnItems);

  // Map Click Event for Waypoint Navigation
  map.on('click', handleMapClick);

  // Zoom & Move End Re-render
  let viewChangeTimeout;
  map.on('zoomend', () => {
    clearTimeout(viewChangeTimeout);
    viewChangeTimeout = setTimeout(refreshCurrentView, 200);
  });

  map.on('moveend', () => {
    if (currentDisplayData.length > 0) {
      renderWindArrows(currentDisplayData);
    }
    if (map.getZoom() > 6) {
      clearTimeout(viewChangeTimeout);
      viewChangeTimeout = setTimeout(refreshCurrentView, 300);
    }
  });
}

// ============================================================================
// 2. Unit Conversions & Meteorological Utilities
// ============================================================================
function convertWindSpeed(speedKnots, targetUnit = currentUnit) {
  if (isNaN(speedKnots) || speedKnots === null) return '--';
  switch (targetUnit) {
    case 'mph': return (speedKnots * 1.15078).toFixed(1);
    case 'kmh': return (speedKnots * 1.852).toFixed(1);
    case 'ms': return (speedKnots * 0.514444).toFixed(1);
    case 'bft': return getBeaufortScale(speedKnots).force;
    case 'knots':
    default: return Number(speedKnots).toFixed(1);
  }
}

function getBeaufortScale(knots) {
  const k = parseFloat(knots);
  if (k < 1) return { force: 0, desc: 'Calm' };
  if (k <= 3) return { force: 1, desc: 'Light Air' };
  if (k <= 6) return { force: 2, desc: 'Light Breeze' };
  if (k <= 10) return { force: 3, desc: 'Gentle Breeze' };
  if (k <= 16) return { force: 4, desc: 'Moderate Breeze' };
  if (k <= 21) return { force: 5, desc: 'Fresh Breeze' };
  if (k <= 27) return { force: 6, desc: 'Strong Breeze' };
  if (k <= 33) return { force: 7, desc: 'Near Gale' };
  if (k <= 40) return { force: 8, desc: 'Gale' };
  if (k <= 47) return { force: 9, desc: 'Severe Gale' };
  if (k <= 55) return { force: 10, desc: 'Storm' };
  if (k <= 63) return { force: 11, desc: 'Violent Storm' };
  return { force: 12, desc: 'Hurricane Force' };
}

function getWindColor(speedKnots) {
  const k = parseFloat(speedKnots);
  if (k < 5) return '#10b981';   // Calm / Light (Emerald)
  if (k < 10) return '#38bdf8';  // Light-Moderate (Cyan)
  if (k < 15) return '#facc15';  // Moderate (Amber)
  if (k < 20) return '#fb923c';  // Fresh (Orange)
  return '#ef4444';              // Gale / Storm (Ruby Red)
}

function degToCardinal(deg) {
  const d = ((deg % 360) + 360) % 360;
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(d / 22.5) % 16;
  return directions[index];
}

function toDMS(lat, lng) {
  const formatCoord = (val, posChar, negChar) => {
    const abs = Math.abs(val);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = Math.round((minFloat - min) * 60);
    const dir = val >= 0 ? posChar : negChar;
    return `${deg}° ${String(min).padStart(2, '0')}' ${String(sec).padStart(2, '0')}" ${dir}`;
  };
  return `${formatCoord(lat, 'N', 'S')} / ${formatCoord(lng, 'E', 'W')}`;
}

function calculateGreatCircleDistanceNM(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 3440.065; // Earth radius in Nautical Miles (NM)
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// 3. Multi-Tier Weather Telemetry Provider
// ============================================================================
async function fetchWeatherTelemetry(lat, lon) {
  // Tier 1: Open-Meteo Marine / Weather API (Zero API Key, Instant, High Accuracy)
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&wind_speed_unit=kn`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.current) {
        return {
          speed: parseFloat(data.current.wind_speed_10m),
          direction: parseFloat(data.current.wind_direction_10m),
          gusts: parseFloat(data.current.wind_gusts_10m) || null,
          pressure: parseFloat(data.current.pressure_msl) || null,
          temp: parseFloat(data.current.temperature_2m) || null,
          source: 'Open-Meteo Live'
        };
      }
    }
  } catch (err) {
    console.warn('Open-Meteo failed, trying secondary tier...', err);
  }

  // Tier 2: OpenWeatherMap API
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&appid=${OWM_API_KEY}&units=metric`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.wind) {
        const speedKnots = data.wind.speed * 1.94384;
        const gustsKnots = data.wind.gust ? data.wind.gust * 1.94384 : null;
        return {
          speed: speedKnots,
          direction: data.wind.deg,
          gusts: gustsKnots,
          pressure: data.main ? data.main.pressure : null,
          temp: data.main ? data.main.temp : null,
          source: 'OpenWeatherMap'
        };
      }
    }
  } catch (err) {
    console.warn('OpenWeatherMap tier fallback:', err);
  }

  // Tier 3: In-Memory NOAA GFS Nearest Neighbor Interpolation
  const gfsPoint = interpolateGfsGrid(lat, lon);
  if (gfsPoint) {
    return {
      speed: gfsPoint.speed,
      direction: gfsPoint.dir,
      gusts: null,
      pressure: null,
      temp: null,
      source: 'NOAA GFS Model'
    };
  }

  return { speed: 0, direction: 0, gusts: null, pressure: null, temp: null, source: 'Offline' };
}

function interpolateGfsGrid(lat, lon) {
  const activeDate = availableDates[currentDateIndex] || availableDates[0];
  const features = dateFeatureMap[activeDate] || [];
  if (features.length === 0) return null;

  let bestDist = Infinity;
  let nearest = null;

  for (let i = 0; i < features.length; i++) {
    const coords = features[i]?.geometry?.coordinates;
    if (!coords) continue;
    const dLat = coords[1] - lat;
    const dLon = coords[0] - lon;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < bestDist) {
      bestDist = distSq;
      nearest = features[i];
      if (distSq < 0.05) break; // Close enough for 0.25 deg grid
    }
  }

  if (nearest) {
    return {
      speed: parseFloat(nearest.properties.WS),
      dir: parseFloat(nearest.properties.WD)
    };
  }
  return null;
}

// ============================================================================
// 4. Data Preloading & Spatial Downsampling
// ============================================================================
async function preloadGfsData() {
  loadingIndicator.style.display = 'flex';
  try {
    const geojson = await fetch('forecast.geojson').then(r => r.json());
    forecastFeatures = Array.isArray(geojson.features) ? geojson.features : [];
    dateFeatureMap = {};

    const datesSet = new Set();
    for (let i = 0; i < forecastFeatures.length; i++) {
      const props = forecastFeatures[i]?.properties || {};
      const dateOnly = props.date || (props.time ? String(props.time).split(' ')[0] : null);
      if (dateOnly) {
        datesSet.add(dateOnly);
        if (!dateFeatureMap[dateOnly]) dateFeatureMap[dateOnly] = [];
        dateFeatureMap[dateOnly].push(forecastFeatures[i]);
      }
    }
    availableDates = Array.from(datesSet).sort();

    if (availableDates.length > 0) {
      dateSlider.min = 0;
      dateSlider.max = availableDates.length - 1;
      dateSlider.value = 0;
      currentDateIndex = 0;
      updateSelectedDateLabel(availableDates[0]);
      await updateWindDisplay(availableDates[0]);
    }
  } catch (err) {
    console.error('Error loading forecast.geojson:', err);
    selectedDateLabel.textContent = 'Error Loading GFS Data';
  } finally {
    loadingIndicator.style.display = 'none';
  }
}

async function buildFeatureData(date) {
  const featuresForDate = dateFeatureMap[date] || [];
  const zoom = map.getZoom();
  
  let sampleMod = 1;
  if (zoom <= 3) sampleMod = 16;
  else if (zoom <= 4) sampleMod = 8;
  else if (zoom <= 5) sampleMod = 4;
  else if (zoom <= 6) sampleMod = 2;
  else sampleMod = 1;

  const useBoundsCulling = zoom > 5;
  const bounds = useBoundsCulling ? map.getBounds() : null;

  const data = [];
  for (let i = 0; i < featuresForDate.length; i++) {
    const feature = featuresForDate[i];
    const coords = feature?.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;

    const lon = parseFloat(coords[0]);
    const lat = parseFloat(coords[1]);
    const props = feature.properties || {};
    const speed = parseFloat(props.WS);
    const dir = parseFloat(props.WD);

    if (isNaN(lat) || isNaN(lon) || isNaN(speed) || isNaN(dir)) continue;

    if (sampleMod > 1) {
      const latKey = Math.round((lat + 90) * 100);
      const lonKey = Math.round((lon + 180) * 100);
      const hash = Math.abs((latKey * 73856093) ^ (lonKey * 19349663));
      if (hash % sampleMod !== 0) continue;
    }

    if (useBoundsCulling && !bounds.contains([lat, lon])) continue;

    data.push({ lat, lon, dir, speed });
  }
  return data;
}

function renderWindArrows(data) {
  const pane = map.getPane('windArrows');
  if (!data || data.length === 0) {
    pane.innerHTML = '';
    return;
  }
  const parts = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const { lat, lon, dir, speed } = data[i];
    const pt = map.latLngToLayerPoint([lat, lon]);
    const color = getWindColor(speed);
    parts[i] = `<div class="wind-arrow-icon" style="left:${pt.x}px;top:${pt.y}px;transform:translate(-50%,-50%) rotate(${dir}deg);color:${color};"><i class="fa-solid fa-arrow-up"></i></div>`;
  }
  pane.innerHTML = parts.join('');
}

async function updateWindDisplay(date) {
  if (!date) return;
  updateSelectedDateLabel(date);

  if (dateRangeData[date] && dateRangeData[date].length > 0) {
    currentDisplayData = dateRangeData[date];
    renderWindArrows(currentDisplayData);
    return;
  }

  loadingIndicator.style.display = 'flex';
  const data = await buildFeatureData(date);
  dateRangeData[date] = data;
  currentDisplayData = data;
  renderWindArrows(data);
  loadingIndicator.style.display = 'none';
}

function refreshCurrentView() {
  const activeDate = availableDates[currentDateIndex];
  if (!activeDate) return;
  delete dateRangeData[activeDate];
  updateWindDisplay(activeDate);
}

function updateSelectedDateLabel(dateStr) {
  selectedDateLabel.textContent = `${dateStr} 12:00 UTC`;
}

// ============================================================================
// 5. Waypoint Route Construction & Telemetry Inspection
// ============================================================================
async function handleMapClick(e) {
  const { lat, lng } = e.latlng;

  // Open Telemetry Drawer if closed
  if (telemetryDrawer.classList.contains('closed')) {
    telemetryDrawer.classList.remove('closed');
  }

  // Update Coordinates Display
  coordDMS.textContent = toDMS(lat, lng);
  coordDD.textContent = `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
  telemetrySource.textContent = 'Querying Telemetry...';

  // Fetch Live / Grid Weather
  const weather = await fetchWeatherTelemetry(lat, lng);
  telemetrySource.textContent = weather.source;

  // Update Compass Rose & Gauges
  updateCompassGauge(weather);

  // Calculate Distances
  let legDist = 0;
  let cumDist = 0;
  if (waypoints.length > 0) {
    const prevWp = waypoints[waypoints.length - 1];
    legDist = calculateGreatCircleDistanceNM(prevWp.lat, prevWp.lng, lat, lng);
    cumDist = prevWp.cumDist + legDist;
  }

  // Create Waypoint Object
  const newWp = {
    index: waypoints.length + 1,
    lat,
    lng,
    speed: weather.speed,
    dir: weather.direction,
    gusts: weather.gusts,
    pressure: weather.pressure,
    temp: weather.temp,
    distToPrev: legDist,
    cumDist: cumDist
  };

  waypoints.push(newWp);

  // Add Marker to Leaflet
  const marker = L.circleMarker([lat, lng], {
    pane: 'routePane',
    radius: 6,
    fillColor: '#38bdf8',
    color: '#ffffff',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.9
  }).addTo(drawnItems);

  marker.bindPopup(`
    <div style="font-family: var(--font-main); font-size: 12px; color: #fff;">
      <strong style="color: #38bdf8;">Waypoint #${newWp.index}</strong><br/>
      ${toDMS(lat, lng)}<br/>
      Wind: <strong>${convertWindSpeed(weather.speed)} ${currentUnit}</strong> @ ${weather.direction}° (${degToCardinal(weather.direction)})<br/>
      Leg: <strong>${legDist.toFixed(1)} NM</strong> | Total: <strong>${cumDist.toFixed(1)} NM</strong>
    </div>
  `);

  // Update Polyline
  updateRoutePolyline();

  // Render Waypoint Ledger Table
  renderWaypointTable();
}

function updateCompassGauge(weather) {
  const deg = weather.direction || 0;
  compassNeedle.style.transform = `rotate(${deg}deg)`;
  bearingDegLabel.textContent = `${Math.round(deg)}°`;
  cardinalTextLabel.textContent = degToCardinal(deg);

  windSpeedVal.textContent = convertWindSpeed(weather.speed);
  windSpeedUnit.textContent = currentUnit;

  const bft = getBeaufortScale(weather.speed);
  beaufortChip.textContent = `Force ${bft.force} (${bft.desc})`;
  beaufortChip.style.color = getWindColor(weather.speed);

  gustSpeedVal.textContent = weather.gusts ? `${convertWindSpeed(weather.gusts)} ${currentUnit}` : '--';
  pressureVal.textContent = weather.pressure ? `${Math.round(weather.pressure)} hPa` : '--';
  tempVal.textContent = weather.temp !== null ? `${Math.round(weather.temp)} °C` : '--';
}

function updateRoutePolyline() {
  if (polyline) {
    map.removeLayer(polyline);
  }
  if (waypoints.length > 1) {
    const latlngs = waypoints.map(wp => [wp.lat, wp.lng]);
    polyline = L.polyline(latlngs, {
      pane: 'routePane',
      color: '#38bdf8',
      weight: 3,
      opacity: 0.9,
      dashArray: '6, 6'
    }).addTo(map);
  }
}

function renderWaypointTable() {
  waypointCountBadge.textContent = `${waypoints.length} WP`;
  const total = waypoints.length > 0 ? waypoints[waypoints.length - 1].cumDist : 0;
  totalDistanceVal.textContent = `${total.toFixed(1)} NM`;

  if (waypoints.length === 0) {
    waypointTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">No waypoints plotted yet. Click map to begin.</td>
      </tr>
    `;
    return;
  }

  let html = '';
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    html += `
      <tr>
        <td><strong>WP${wp.index}</strong></td>
        <td>${wp.lat.toFixed(2)}°, ${wp.lng.toFixed(2)}°</td>
        <td><span style="color:${getWindColor(wp.speed)};font-weight:700;">${convertWindSpeed(wp.speed)}</span> @ ${Math.round(wp.dir)}°</td>
        <td>${wp.distToPrev.toFixed(1)}</td>
      </tr>
    `;
  }
  waypointTableBody.innerHTML = html;
}

function clearRoute() {
  waypoints = [];
  drawnItems.clearLayers();
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  renderWaypointTable();
  coordDMS.textContent = `--° --' --" N / --° --' --" W`;
  coordDD.textContent = `--.----, --.----`;
  telemetrySource.textContent = `Click Map to Inspect`;
  updateCompassGauge({ speed: 0, direction: 0, gusts: null, pressure: null, temp: null });
}

// ============================================================================
// 6. Route Exporters (GPX & GeoJSON)
// ============================================================================
function exportRouteGpx() {
  if (waypoints.length === 0) {
    alert('Please plot at least one waypoint before exporting GPX.');
    return;
  }

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  gpx += `<gpx version="1.1" creator="Map Winds Pro - https://github.com/sounny/windmap" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  gpx += `  <metadata><name>Map Winds Planned Route</name><time>${new Date().toISOString()}</time></metadata>\n`;
  gpx += `  <rte>\n    <name>Marine Navigation Route</name>\n`;

  for (const wp of waypoints) {
    gpx += `    <rtept lat="${wp.lat}" lon="${wp.lng}">\n`;
    gpx += `      <name>WP${wp.index}</name>\n`;
    gpx += `      <desc>Wind: ${convertWindSpeed(wp.speed)} ${currentUnit} @ ${wp.dir} deg</desc>\n`;
    gpx += `    </rtept>\n`;
  }

  gpx += `  </rte>\n</gpx>`;

  downloadFile(gpx, 'mapwinds_route.gpx', 'application/gpx+xml');
}

function exportRouteGeoJson() {
  if (waypoints.length === 0) {
    alert('Please plot at least one waypoint before exporting GeoJSON.');
    return;
  }

  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: waypoints.map(wp => [wp.lng, wp.lat])
        },
        properties: {
          name: 'Marine Route Path',
          totalDistanceNM: waypoints[waypoints.length - 1].cumDist,
          waypointCount: waypoints.length
        }
      },
      ...waypoints.map(wp => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [wp.lng, wp.lat]
        },
        properties: {
          name: `WP${wp.index}`,
          windSpeedKts: wp.speed,
          windDirDeg: wp.dir,
          legDistanceNM: wp.distToPrev
        }
      }))
    ]
  };

  downloadFile(JSON.stringify(geojson, null, 2), 'mapwinds_route.geojson', 'application/json');
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// 7. Timeline Playback & Scrubber Controls
// ============================================================================
function togglePlay() {
  isPlaying = !isPlaying;
  if (isPlaying) {
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    playBtn.style.background = '#facc15';
    startPlayback();
  } else {
    stopPlayback();
  }
}

function startPlayback() {
  if (playTimer) clearInterval(playTimer);
  playTimer = setInterval(() => {
    currentDateIndex = (currentDateIndex + 1) % availableDates.length;
    dateSlider.value = currentDateIndex;
    updateWindDisplay(availableDates[currentDateIndex]);
  }, playbackSpeed);
}

function stopPlayback() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
  playBtn.style.background = 'var(--accent-cyan)';
  isPlaying = false;
}

function stepTimeline(direction) {
  stopPlayback();
  currentDateIndex = (currentDateIndex + direction + availableDates.length) % availableDates.length;
  dateSlider.value = currentDateIndex;
  updateWindDisplay(availableDates[currentDateIndex]);
}

function toggleSpeed() {
  speedIndex = (speedIndex + 1) % speedMultipliers.length;
  const mult = speedMultipliers[speedIndex];
  speedMultiplierBtn.textContent = `${mult}x`;
  playbackSpeed = 800 / mult;
  if (isPlaying) {
    startPlayback();
  }
}

// ============================================================================
// 8. Search & Geocoding
// ============================================================================
async function handleLocationSearch() {
  const query = locationSearch.value.trim();
  if (!query) return;

  // Check if lat, lon coordinates entered
  const coordMatch = query.match(/^([-+]?\d*\.?\d+)[,\s]+([-+]?\d*\.?\d+)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      map.setView([lat, lon], 7);
      return;
    }
  }

  // Query Nominatim OSM Geocoding API
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
    const results = await res.json();
    if (results && results.length > 0) {
      const { lat, lon } = results[0];
      map.setView([parseFloat(lat), parseFloat(lon)], 7);
    } else {
      alert(`Location "${query}" not found.`);
    }
  } catch (err) {
    console.error('Search error:', err);
  }
}

// ============================================================================
// 9. UTC Clock & UI Event Handlers
// ============================================================================
function updateUtcClock() {
  const now = new Date();
  const utcStr = now.toISOString().slice(11, 19) + ' Z';
  if (utcTimeDisplay) utcTimeDisplay.textContent = utcStr;
}

// Event Listeners Setup
function initEventListeners() {
  // Playback Controls
  if (playBtn) playBtn.addEventListener('click', togglePlay);
  if (prevDayBtn) prevDayBtn.addEventListener('click', () => stepTimeline(-1));
  if (nextDayBtn) nextDayBtn.addEventListener('click', () => stepTimeline(1));
  if (speedMultiplierBtn) speedMultiplierBtn.addEventListener('click', toggleSpeed);

  // Slider Scrubber
  let sliderDebounce;
  if (dateSlider) {
    dateSlider.addEventListener('input', () => {
      stopPlayback();
      currentDateIndex = parseInt(dateSlider.value);
      const date = availableDates[currentDateIndex];
      updateSelectedDateLabel(date);
      clearTimeout(sliderDebounce);
      sliderDebounce = setTimeout(() => updateWindDisplay(date), 100);
    });
  }

  // Units Switcher
  if (unitSelect) {
    unitSelect.addEventListener('change', e => {
      currentUnit = e.target.value;
      legendUnitBadge.textContent = currentUnit;
      renderWaypointTable();
      if (waypoints.length > 0) {
        updateCompassGauge(waypoints[waypoints.length - 1]);
      }
    });
  }

  // Basemap Switcher
  if (basemapSelect) {
    basemapSelect.addEventListener('change', e => {
      const selected = e.target.value;
      if (baseLayers[selected]) {
        map.removeLayer(currentBaseLayer);
        currentBaseLayer = baseLayers[selected].addTo(map);
        currentBaseLayer.bringToBack();
      }
    });
  }

  // Sidebar Drawer Toggle
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      telemetryDrawer.classList.toggle('closed');
    });
  }
  if (closeDrawerBtn) {
    closeDrawerBtn.addEventListener('click', () => {
      telemetryDrawer.classList.add('closed');
    });
  }

  // Search Button & Enter Key
  if (searchBtn) searchBtn.addEventListener('click', handleLocationSearch);
  if (locationSearch) {
    locationSearch.addEventListener('keypress', e => {
      if (e.key === 'Enter') handleLocationSearch();
    });
  }

  // Route Actions
  if (resetRouteBtn) resetRouteBtn.addEventListener('click', clearRoute);
  if (exportGpxBtn) exportGpxBtn.addEventListener('click', exportRouteGpx);
  if (exportGeoJsonBtn) exportGeoJsonBtn.addEventListener('click', exportRouteGeoJson);

  // Clock Interval
  setInterval(updateUtcClock, 1000);
  updateUtcClock();
}

// ============================================================================
// 10. Bootstrap Application
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initEventListeners();
  preloadGfsData();
});
