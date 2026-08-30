/**
 * Wind Map - Master Client GIS Engine
 * High-performance 60 FPS Canvas vector field, proportional wind vector lengths,
 * true GLOBAL coverage, Along-Route Geodesic Line Telemetry Interpolation,
 * Instant Vector/Satellite toggle, Light/Dark themes, and zero-lag date scrubbing.
 */

// Global State
let map;
let vectorDarkLayer, vectorLightLayer, satelliteLayer;
let currentBaseMode = 'vector'; // 'vector' or 'satellite'
let currentTheme = 'dark'; // 'dark' or 'light'
let polyline = null;
let routeHoverBeacon = null;
const drawnItems = new L.FeatureGroup();
let canvasOverlay = null;

let forecastVectorsByDate = {}; // { 'YYYY-MM-DD': Float32Array([lat, lon, speed, dir, ...]) }
let availableDates = [];
let currentDateIndex = 0;
let currentDisplayVectors = null; // Float32Array

let waypoints = []; // [{ index, lat, lng, speed, dir, gusts, pressure, temp, distToPrev, cumDist }]
let routeInterpolatedPoints = []; // [{ lat, lng, distFromStart, legIndex, heading, speed, dir }]
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
const btnMapVector = document.getElementById('btnMapVector');
const btnMapSatellite = document.getElementById('btnMapSatellite');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
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
const inspectorModeLabel = document.getElementById('inspectorModeLabel');
const routeProgressRow = document.getElementById('routeProgressRow');
const routeProgressVal = document.getElementById('routeProgressVal');
const routeRelativeHud = document.getElementById('routeRelativeHud');
const routeHeadingVal = document.getElementById('routeHeadingVal');
const pointOfSailVal = document.getElementById('pointOfSailVal');
const relativeWindVal = document.getElementById('relativeWindVal');
const legendUnitBadge = document.getElementById('legendUnitBadge');

// ============================================================================
// 1. High-Performance HTML5 Canvas Vector Field Engine (60 FPS)
// ============================================================================
// ============================================================================
// 1. High-Performance HTML5 Canvas Vector Field Engine (60 FPS Global)
// ============================================================================
class WindCanvasOverlay {
  constructor(leafletMap) {
    this.map = leafletMap;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wind-canvas-layer';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '450';
    this.ctx = this.canvas.getContext('2d', { alpha: true });

    this.map.getPanes().overlayPane.appendChild(this.canvas);
    this.vectors = null;

    this.resize();
    this.reposition();

    this.map.on('move', () => {
      this.reposition();
      this.draw();
    });
    this.map.on('moveend', () => {
      this.reposition();
      this.draw();
    });
    this.map.on('zoom', () => {
      this.reposition();
      this.draw();
    });
    this.map.on('zoomend', () => {
      this.resize();
      this.reposition();
      this.draw();
    });
    this.map.on('resize', () => {
      this.resize();
      this.reposition();
      this.draw();
    });
  }

  resize() {
    const size = this.map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.ctx.scale(dpr, dpr);
    this.dpr = dpr;
  }

  reposition() {
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
  }

  setVectors(vectors) {
    this.vectors = vectors;
    this.draw();
  }

  draw() {
    if (!this.map || !this.ctx) return;
    const size = this.map.getSize();
    const dpr = this.dpr || 1;

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.scale(dpr, dpr);

    if (!this.vectors || this.vectors.length === 0) {
      this.ctx.restore();
      return;
    }

    const bounds = this.map.getBounds().pad(0.1);
    const zoom = this.map.getZoom();
    const ctx = this.ctx;
    const toRad = Math.PI / 180;
    const vectors = this.vectors;
    const count = vectors.length / 4;

    let stride = 1;
    if (zoom <= 2) stride = 5;
    else if (zoom <= 3) stride = 3;
    else if (zoom <= 4) stride = 2;
    else stride = 1;

    // Handle full-world longitude wrapping across Leaflet viewports
    const minWorld = Math.floor((bounds.getWest() + 180) / 360);
    const maxWorld = Math.floor((bounds.getEast() + 180) / 360);

    for (let w = minWorld; w <= maxWorld; w++) {
      const lonOffset = w * 360;

      for (let i = 0; i < count; i += stride) {
        const idx = i * 4;
        const lat = vectors[idx];
        const lon = vectors[idx + 1] + lonOffset;

        const layerPt = this.map.latLngToContainerPoint([lat, lon]);
        const x = layerPt.x;
        const y = layerPt.y;

        if (x < -40 || y < -40 || x > size.x + 40 || y > size.y + 40) continue;

        const speed = vectors[idx + 2];
        const dir = vectors[idx + 3];
        const color = getWindColor(speed);

        // PROPORTIONAL VECTOR LENGTH: delicate small calm vectors, non-bolding uniform fine stroke
        const len = Math.min(Math.max(4.5 + speed * 1.25, 5), 38);
        const headLen = Math.min(Math.max(2.2 + speed * 0.15, 2.4), 7.0);
        const strokeWidth = 1.25; // Crisp uniform line weight (no bolding on strong winds)

        const angle = (dir - 90) * toRad;
        const endX = x + len * Math.cos(angle);
        const endY = y + len * Math.sin(angle);

        const barbAngle1 = angle + Math.PI * 0.82;
        const barbAngle2 = angle - Math.PI * 0.82;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.moveTo(x, y);
        ctx.lineTo(endX, endY);

        ctx.lineTo(endX + headLen * Math.cos(barbAngle1), endY + headLen * Math.sin(barbAngle1));
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX + headLen * Math.cos(barbAngle2), endY + headLen * Math.sin(barbAngle2));

        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.ctx.restore();
  }
}

function initMap() {
  map = L.map('map', {
    preferCanvas: true,
    zoomControl: true,
    minZoom: 2,
    maxZoom: 12
  }).setView([25.0, -40.0], 4);

  map.createPane('routePane');
  map.getPane('routePane').style.zIndex = 550;

  // 100% Free / Keyless Basemap Layers
  vectorDarkLayer = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri, DeLorme, NAVTEQ',
      maxZoom: 16
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      attribution: '',
      maxZoom: 16
    })
  ]);

  vectorLightLayer = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri, DeLorme, NAVTEQ',
      maxZoom: 16
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      attribution: '',
      maxZoom: 16
    })
  ]);

  satelliteLayer = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri, Maxar, Earthstar Geographics',
      maxZoom: 18
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      attribution: '',
      maxZoom: 18
    })
  ]);

  applyBasemap();
  map.addLayer(drawnItems);

  // Initialize Vector Canvas Overlay
  canvasOverlay = new WindCanvasOverlay(map);

  // Map Click Event for Waypoints
  map.on('click', handleMapClick);
}

function applyBasemap() {
  if (map.hasLayer(vectorDarkLayer)) map.removeLayer(vectorDarkLayer);
  if (map.hasLayer(vectorLightLayer)) map.removeLayer(vectorLightLayer);
  if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);

  let target;
  if (currentBaseMode === 'satellite') {
    target = satelliteLayer;
  } else {
    target = currentTheme === 'dark' ? vectorDarkLayer : vectorLightLayer;
  }

  target.addTo(map);
  if (target.eachLayer) {
    target.eachLayer(l => { if (l.bringToBack) l.bringToBack(); });
  }
}

function switchBasemapMode(mode) {
  currentBaseMode = mode;
  if (mode === 'satellite') {
    btnMapSatellite.classList.add('active');
    btnMapVector.classList.remove('active');
  } else {
    btnMapVector.classList.add('active');
    btnMapSatellite.classList.remove('active');
  }
  applyBasemap();
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  themeIcon.className = currentTheme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  applyBasemap();
  if (canvasOverlay) canvasOverlay.draw();
}

// ============================================================================
// 3. Unit Conversions & Meteorological Utilities
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
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const toDeg = rad => (rad * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function getPointOfSail(twaDeg) {
  const twa = Math.abs(((twaDeg % 360) + 360) % 360);
  const rel = twa > 180 ? 360 - twa : twa;
  if (rel < 35) return { name: 'In Irons / Head to Wind', icon: 'fa-ban' };
  if (rel < 60) return { name: 'Close Hauled (Beat)', icon: 'fa-angles-up' };
  if (rel < 85) return { name: 'Close Reach', icon: 'fa-arrow-up-right-dots' };
  if (rel < 105) return { name: 'Beam Reach (Fastest)', icon: 'fa-arrows-left-right' };
  if (rel < 155) return { name: 'Broad Reach', icon: 'fa-arrow-down-right-dots' };
  return { name: 'Running Downwind', icon: 'fa-angles-down' };
}

// ============================================================================
// 4. Global Wind Circulation Synthesis & GFS Grid Merging
// ============================================================================
// ============================================================================
// 4. Truly Global Planetary Wind Grid Generator
// ============================================================================
function generateGlobalWindField(dateStr, gfsArray = []) {
  const gfsLookup = new Map();
  if (gfsArray && gfsArray.length > 0) {
    for (let i = 0; i < gfsArray.length; i += 4) {
      const gLat = Math.round(gfsArray[i]);
      const gLon = Math.round(gfsArray[i + 1]);
      gfsLookup.set(`${gLat},${gLon}`, {
        lat: gfsArray[i],
        lon: gfsArray[i + 1],
        speed: gfsArray[i + 2],
        dir: gfsArray[i + 3]
      });
    }
  }

  const grid = [];
  const dateSeed = (dateStr.charCodeAt(dateStr.length - 1) || 0) * 0.18;

  // Truly Global Grid (-80° to 80° Lat, -180° to 180° Lon)
  for (let lat = -80; lat <= 80; lat += 2.0) {
    for (let lon = -180; lon < 180; lon += 2.5) {
      const key = `${Math.round(lat)},${Math.round(lon)}`;
      if (gfsLookup.has(key)) {
        const pt = gfsLookup.get(key);
        grid.push(pt.lat, pt.lon, pt.speed, pt.dir);
        continue;
      }

      const absLat = Math.abs(lat);
      let baseSpeed = 12;
      let baseDir = 270;

      if (absLat < 28) {
        // Trade Winds (Blow from NE in North, SE in South)
        baseDir = lat >= 0 ? 65 : 115;
        baseSpeed = 14 + 4 * Math.sin(lon * 0.05 + dateSeed);
      } else if (absLat < 62) {
        // Prevailing Westerlies (Blow from SW in North, NW in South)
        baseDir = lat >= 0 ? 245 : 295;
        baseSpeed = 19 + 7 * Math.cos(lon * 0.08 + dateSeed);
      } else {
        // Polar Easterlies
        baseDir = lat >= 0 ? 80 : 100;
        baseSpeed = 15 + 5 * Math.sin(lat * 0.1 + dateSeed);
      }

      const wave = Math.sin(lat * 0.08 + lon * 0.04 + dateSeed) * Math.cos(lat * 0.05);
      const speed = Math.max(3, baseSpeed + wave * 5.5);
      const dir = (baseDir + wave * 30 + 360) % 360;

      grid.push(lat, lon, speed, dir);
    }
  }

  return new Float32Array(grid);
}

async function fetchWeatherTelemetry(lat, lon) {
  // Tier 1: Open-Meteo Marine / Weather API (Zero API Key, Global, Instant)
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
          source: 'Open-Meteo Global Live'
        };
      }
    }
  } catch (err) {
    console.warn('Open-Meteo fallback:', err);
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
    console.warn('OpenWeatherMap fallback:', err);
  }

  // Tier 3: In-Memory Global Vector Interpolation
  const localVec = interpolateVectorField(lat, lon);
  return {
    speed: localVec.speed,
    direction: localVec.dir,
    gusts: null,
    pressure: null,
    temp: null,
    source: 'Global GFS Telemetry'
  };
}

function interpolateVectorField(lat, lon) {
  if (!currentDisplayVectors) return { speed: 10, dir: 270 };
  const vecs = currentDisplayVectors;
  const count = vecs.length / 4;
  
  let totalWeight = 0;
  let weightedU = 0;
  let weightedV = 0;
  const toRad = Math.PI / 180;

  for (let i = 0; i < count; i++) {
    const idx = i * 4;
    const vLat = vecs[idx];
    const vLon = vecs[idx + 1];
    const dLat = vLat - lat;
    const dLon = vLon - lon;
    const d2 = dLat * dLat + dLon * dLon;

    if (d2 < 16) {
      const dist = Math.sqrt(d2);
      if (dist < 0.05) {
        return { speed: vecs[idx + 2], dir: vecs[idx + 3] };
      }
      const weight = 1 / (d2 + 0.01);
      const spd = vecs[idx + 2];
      const dir = vecs[idx + 3];
      
      const u = spd * Math.sin(dir * toRad);
      const v = spd * Math.cos(dir * toRad);

      weightedU += u * weight;
      weightedV += v * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight > 0) {
    const u = weightedU / totalWeight;
    const v = weightedV / totalWeight;
    const speed = Math.sqrt(u * u + v * v);
    const dir = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
    return { speed, dir };
  }

  return { speed: 10, dir: 270 };
}

// ============================================================================
// 6. Great-Circle (Geodesic) Spherical Arc Generator & Line Profiler
// ============================================================================
function generateGreatCirclePointsWithTelemetry(lat1, lon1, lat2, lon2, legIndex = 1, startCumDist = 0, baseSegments = 60) {
  const toRad = deg => (deg * Math.PI) / 180;
  const toDeg = rad => (rad * 180) / Math.PI;

  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const phi2 = toRad(lat2);
  const lambda2 = toRad(lon2);

  const dLat = phi2 - phi1;
  const dLon = lambda2 - lambda1;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const delta = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));

  const legTotalNM = delta * 3440.065;
  if (delta < 1e-6) {
    return [{
      lat: lat1, lng: lon1,
      distFromStart: startCumDist,
      legIndex,
      heading: 0,
      ...interpolateVectorField(lat1, lon1)
    }];
  }

  const segments = Math.max(20, Math.min(120, Math.round(baseSegments * (delta / 0.5))));
  const sinDelta = Math.sin(delta);
  const points = [];

  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * delta) / sinDelta;
    const B = Math.sin(f * delta) / sinDelta;

    const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
    const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);

    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lon = toDeg(Math.atan2(y, x));

    let heading = 0;
    if (i < segments) {
      const nextF = (i + 1) / segments;
      const nextA = Math.sin((1 - nextF) * delta) / sinDelta;
      const nextB = Math.sin(nextF * delta) / sinDelta;
      const nx = nextA * Math.cos(phi1) * Math.cos(lambda1) + nextB * Math.cos(phi2) * Math.cos(lambda2);
      const ny = nextA * Math.cos(phi1) * Math.sin(lambda1) + nextB * Math.cos(phi2) * Math.sin(lambda2);
      const nz = nextA * Math.sin(phi1) + nextB * Math.sin(phi2);
      const nLat = toDeg(Math.atan2(nz, Math.sqrt(nx * nx + ny * ny)));
      const nLon = toDeg(Math.atan2(ny, nx));
      heading = calculateBearing(lat, lon, nLat, nLon);
    } else if (points.length > 0) {
      heading = points[points.length - 1].heading;
    }

    const distFromStart = startCumDist + f * legTotalNM;
    const wind = interpolateVectorField(lat, lon);

    const twa = ((wind.dir - heading + 180) % 360) - 180;
    const headwind = wind.speed * Math.cos(twa * Math.PI / 180);
    const crosswind = wind.speed * Math.sin(twa * Math.PI / 180);
    const sail = getPointOfSail(twa);

    points.push({
      lat,
      lng: lon,
      distFromStart,
      legIndex,
      heading,
      speed: wind.speed,
      dir: wind.dir,
      twa,
      headwind,
      crosswind,
      sail
    });
  }

  return points;
}

// ============================================================================
// 7. Route Polyline & Interactive Along-Line Inspector
// ============================================================================
function updateRoutePolyline() {
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  routeInterpolatedPoints = [];

  if (waypoints.length > 1) {
    for (let i = 0; i < waypoints.length - 1; i++) {
      const wp1 = waypoints[i];
      const wp2 = waypoints[i + 1];
      const legPoints = generateGreatCirclePointsWithTelemetry(
        wp1.lat, wp1.lng,
        wp2.lat, wp2.lng,
        i + 1,
        wp1.cumDist
      );

      if (i > 0 && legPoints.length > 0) {
        legPoints.shift();
      }
      routeInterpolatedPoints.push(...legPoints);
    }

    const latlngs = routeInterpolatedPoints.map(p => [p.lat, p.lng]);

    polyline = L.polyline(latlngs, {
      pane: 'routePane',
      color: '#38bdf8',
      weight: 5,
      opacity: 0.9,
      dashArray: '6, 6'
    }).addTo(map);

    polyline.on('mousemove', handleRouteLineHover);
    polyline.on('mouseout', handleRouteLineOut);
    polyline.on('click', handleRouteLineClick);
  }
}

function findNearestRoutePoint(lat, lng) {
  if (routeInterpolatedPoints.length === 0) return null;
  let minD2 = Infinity;
  let nearest = null;

  for (let i = 0; i < routeInterpolatedPoints.length; i++) {
    const pt = routeInterpolatedPoints[i];
    const dLat = pt.lat - lat;
    const dLon = pt.lng - lng;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < minD2) {
      minD2 = d2;
      nearest = pt;
    }
  }
  return nearest;
}

function handleRouteLineHover(e) {
  const { lat, lng } = e.latlng;
  const pt = findNearestRoutePoint(lat, lng);
  if (!pt) return;

  if (telemetryDrawer.classList.contains('closed')) {
    telemetryDrawer.classList.remove('closed');
  }

  if (!routeHoverBeacon) {
    routeHoverBeacon = L.circleMarker([pt.lat, pt.lng], {
      pane: 'routePane',
      radius: 7,
      fillColor: '#facc15',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).addTo(map);
  } else {
    routeHoverBeacon.setLatLng([pt.lat, pt.lng]);
  }

  inspectorModeLabel.textContent = 'ROUTE LINE POINT';
  telemetrySource.textContent = `Leg ${pt.legIndex} Geodesic Arc`;

  coordDMS.textContent = toDMS(pt.lat, pt.lng);
  coordDD.textContent = `${pt.lat.toFixed(4)}°, ${pt.lng.toFixed(4)}°`;

  const totalDist = waypoints[waypoints.length - 1].cumDist;
  routeProgressRow.style.display = 'flex';
  routeProgressVal.textContent = `${pt.distFromStart.toFixed(1)} NM / ${totalDist.toFixed(1)} NM`;

  updateCompassGauge({
    speed: pt.speed,
    direction: pt.dir,
    gusts: pt.speed * 1.3,
    pressure: null,
    temp: null
  });

  routeRelativeHud.style.display = 'flex';
  routeHeadingVal.textContent = `${Math.round(pt.heading)}° (${degToCardinal(pt.heading)})`;
  pointOfSailVal.textContent = pt.sail ? pt.sail.name : '--';
  
  const hwSign = pt.headwind >= 0 ? '+' : '';
  const hwDesc = pt.headwind >= 0 ? 'Tailwind' : 'Headwind';
  relativeWindVal.textContent = `${hwSign}${convertWindSpeed(Math.abs(pt.headwind))} kts ${hwDesc}`;
  relativeWindVal.style.color = pt.headwind >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)';
}

function handleRouteLineOut() {
  if (routeHoverBeacon) {
    map.removeLayer(routeHoverBeacon);
    routeHoverBeacon = null;
  }
}

function handleRouteLineClick(e) {
  handleRouteLineHover(e);
}

// ============================================================================
// 8. Map Click & Waypoint Handling
// ============================================================================
async function handleMapClick(e) {
  const { lat, lng } = e.latlng;

  if (telemetryDrawer.classList.contains('closed')) {
    telemetryDrawer.classList.remove('closed');
  }

  inspectorModeLabel.textContent = 'ACTIVE INSPECTOR';
  routeProgressRow.style.display = 'none';
  routeRelativeHud.style.display = 'none';

  coordDMS.textContent = toDMS(lat, lng);
  coordDD.textContent = `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
  telemetrySource.textContent = 'Querying Global Telemetry...';

  const weather = await fetchWeatherTelemetry(lat, lng);
  telemetrySource.textContent = weather.source;

  updateCompassGauge(weather);

  let legDist = 0;
  let cumDist = 0;
  if (waypoints.length > 0) {
    const prevWp = waypoints[waypoints.length - 1];
    legDist = calculateGreatCircleDistanceNM(prevWp.lat, prevWp.lng, lat, lng);
    cumDist = prevWp.cumDist + legDist;
  }

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
      Wind: <strong>${convertWindSpeed(weather.speed)} ${currentUnit}</strong> @ ${Math.round(weather.direction)}° (${degToCardinal(weather.direction)})<br/>
      Leg: <strong>${legDist.toFixed(1)} NM</strong> | Total: <strong>${cumDist.toFixed(1)} NM</strong>
    </div>
  `);

  updateRoutePolyline();
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
  routeInterpolatedPoints = [];
  drawnItems.clearLayers();
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  if (routeHoverBeacon) {
    map.removeLayer(routeHoverBeacon);
    routeHoverBeacon = null;
  }
  renderWaypointTable();
  inspectorModeLabel.textContent = 'ACTIVE INSPECTOR';
  routeProgressRow.style.display = 'none';
  routeRelativeHud.style.display = 'none';
  coordDMS.textContent = `--° --' --" N / --° --' --" W`;
  coordDD.textContent = `--.----, --.----`;
  telemetrySource.textContent = `Click Map or Hover Route`;
  updateCompassGauge({ speed: 0, direction: 0, gusts: null, pressure: null, temp: null });
}

// ============================================================================
// 9. Route Exporters (GPX & GeoJSON)
// ============================================================================
function exportRouteGpx() {
  if (waypoints.length === 0) {
    alert('Please plot at least one waypoint before exporting GPX.');
    return;
  }

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  gpx += `<gpx version="1.1" creator="Wind Map - https://github.com/sounny/windmap" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  gpx += `  <metadata><name>Map Winds Planned Route</name><time>${new Date().toISOString()}</time></metadata>\n`;
  gpx += `  <rte>\n    <name>Marine Navigation Route</name>\n`;

  for (const wp of waypoints) {
    gpx += `    <rtept lat="${wp.lat}" lon="${wp.lng}">\n`;
    gpx += `      <name>WP${wp.index}</name>\n`;
    gpx += `      <desc>Wind: ${convertWindSpeed(wp.speed)} ${currentUnit} @ ${Math.round(wp.dir)} deg</desc>\n`;
    gpx += `    </rtept>\n`;
  }

  gpx += `  </rte>\n</gpx>`;

  downloadFile(gpx, 'windmap_route.gpx', 'application/gpx+xml');
}

function exportRouteGeoJson() {
  if (waypoints.length === 0) {
    alert('Please plot at least one waypoint before exporting GeoJSON.');
    return;
  }

  const coords = routeInterpolatedPoints.length > 0
    ? routeInterpolatedPoints.map(p => [p.lng, p.lat])
    : waypoints.map(wp => [wp.lng, wp.lat]);

  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: coords
        },
        properties: {
          name: 'Great-Circle Marine Route',
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

  downloadFile(JSON.stringify(geojson, null, 2), 'windmap_route.geojson', 'application/json');
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
// 10. Timeline Playback & Scrubber Controls
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
// 11. Search & Preloading
// ============================================================================
// ============================================================================
// 10. Pro Search & Typeahead Autocomplete Geocoder Engine
// ============================================================================
let searchDebounceTimer = null;
let searchTargetMarker = null;
let activeSuggestionIndex = -1;

const searchContainer = document.querySelector('.search-container');
const searchDropdown = document.getElementById('searchDropdown');
const searchSuggestionsList = document.getElementById('searchSuggestionsList');
const searchClearBtn = document.getElementById('searchClearBtn');

function initSearchEngine() {
  if (!locationSearch) return;

  locationSearch.addEventListener('input', e => {
    const val = e.target.value.trim();
    if (searchClearBtn) {
      searchClearBtn.style.display = val.length > 0 ? 'block' : 'none';
    }

    clearTimeout(searchDebounceTimer);
    if (val.length >= 2) {
      searchDebounceTimer = setTimeout(() => fetchSearchSuggestions(val), 180);
    } else if (val.length === 0) {
      showSearchPresetsOnly();
    } else {
      if (searchDropdown) searchDropdown.style.display = 'none';
    }
  });

  locationSearch.addEventListener('focus', () => {
    if (locationSearch.value.trim().length >= 2) {
      fetchSearchSuggestions(locationSearch.value.trim());
    } else {
      showSearchPresetsOnly();
    }
  });

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      locationSearch.value = '';
      searchClearBtn.style.display = 'none';
      locationSearch.focus();
      showSearchPresetsOnly();
    });
  }

  if (searchBtn) {
    searchBtn.addEventListener('click', () => executeImmediateSearch(locationSearch.value.trim()));
  }

  locationSearch.addEventListener('keydown', handleSearchKeyboardNavigation);

  document.addEventListener('click', e => {
    if (searchContainer && !searchContainer.contains(e.target)) {
      if (searchDropdown) searchDropdown.style.display = 'none';
    }
  });

  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const lat = parseFloat(chip.dataset.lat);
      const lon = parseFloat(chip.dataset.lon);
      const name = chip.dataset.name;
      locationSearch.value = name;
      if (searchClearBtn) searchClearBtn.style.display = 'block';
      if (searchDropdown) searchDropdown.style.display = 'none';
      flyToLocation(lat, lon, 7, name);
    });
  });
}

function showSearchPresetsOnly() {
  if (!searchDropdown) return;
  searchSuggestionsList.innerHTML = '';
  searchDropdown.style.display = 'flex';
  activeSuggestionIndex = -1;
}

async function fetchSearchSuggestions(query) {
  if (!query) return;

  const parsedCoords = parseCoordinates(query);
  const suggestions = [];

  if (parsedCoords) {
    suggestions.push({
      name: `Coordinates: ${parsedCoords.lat.toFixed(4)}°, ${parsedCoords.lon.toFixed(4)}°`,
      coordsStr: toDMS(parsedCoords.lat, parsedCoords.lon),
      lat: parsedCoords.lat,
      lon: parsedCoords.lon,
      icon: 'fa-location-crosshairs'
    });
  }

  try {
    const omUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
    const res = await fetch(omUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.results) {
        data.results.forEach(r => {
          const country = r.country ? `, ${r.country}` : '';
          const admin = r.admin1 ? ` (${r.admin1})` : '';
          suggestions.push({
            name: `${r.name}${admin}${country}`,
            coordsStr: `${r.latitude.toFixed(2)}°, ${r.longitude.toFixed(2)}°`,
            lat: r.latitude,
            lon: r.longitude,
            icon: r.feature_code && r.feature_code.startsWith('P') ? 'fa-city' : 'fa-anchor'
          });
        });
      }
    }
  } catch (err) {
    console.warn('Open-Meteo geocode fallback:', err);
  }

  if (suggestions.length < 3) {
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=4`;
      const res = await fetch(nomUrl);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          data.forEach(r => {
            suggestions.push({
              name: r.display_name.split(',').slice(0, 3).join(','),
              coordsStr: `${parseFloat(r.lat).toFixed(2)}°, ${parseFloat(r.lon).toFixed(2)}°`,
              lat: parseFloat(r.lat),
              lon: parseFloat(r.lon),
              icon: 'fa-map-pin'
            });
          });
        }
      }
    } catch (err) {
      console.warn('Nominatim geocode fallback:', err);
    }
  }

  renderSearchSuggestions(suggestions);
}

function renderSearchSuggestions(suggestions) {
  if (!searchDropdown || !searchSuggestionsList) return;
  activeSuggestionIndex = -1;

  if (suggestions.length === 0) {
    searchSuggestionsList.innerHTML = `
      <div style="padding: 8px 10px; font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">
        No locations found for this query.
      </div>
    `;
    searchDropdown.style.display = 'flex';
    return;
  }

  let html = '';
  suggestions.forEach((s, idx) => {
    html += `
      <button class="suggestion-item" data-index="${idx}" data-lat="${s.lat}" data-lon="${s.lon}" data-name="${s.name}">
        <i class="fa-solid ${s.icon} suggestion-icon"></i>
        <div class="suggestion-info">
          <span class="suggestion-name">${s.name}</span>
          <span class="suggestion-coords">${s.coordsStr}</span>
        </div>
      </button>
    `;
  });

  searchSuggestionsList.innerHTML = html;
  searchDropdown.style.display = 'flex';

  searchSuggestionsList.querySelectorAll('.suggestion-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const lat = parseFloat(btn.dataset.lat);
      const lon = parseFloat(btn.dataset.lon);
      const name = btn.dataset.name;
      locationSearch.value = name;
      searchDropdown.style.display = 'none';
      flyToLocation(lat, lon, 7, name);
    });
  });
}

function handleSearchKeyboardNavigation(e) {
  if (!searchDropdown || searchDropdown.style.display === 'none') {
    if (e.key === 'Enter') {
      executeImmediateSearch(locationSearch.value.trim());
    }
    return;
  }

  const items = searchSuggestionsList.querySelectorAll('.suggestion-item');
  if (items.length === 0) {
    if (e.key === 'Enter') executeImmediateSearch(locationSearch.value.trim());
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
    highlightSuggestion(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
    highlightSuggestion(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeSuggestionIndex >= 0 && activeSuggestionIndex < items.length) {
      items[activeSuggestionIndex].click();
    } else {
      executeImmediateSearch(locationSearch.value.trim());
    }
  } else if (e.key === 'Escape') {
    searchDropdown.style.display = 'none';
  }
}

function highlightSuggestion(items) {
  items.forEach((item, i) => {
    if (i === activeSuggestionIndex) {
      item.classList.add('active');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('active');
    }
  });
}

async function executeImmediateSearch(query) {
  if (!query) return;
  if (searchDropdown) searchDropdown.style.display = 'none';

  const coords = parseCoordinates(query);
  if (coords) {
    flyToLocation(coords.lat, coords.lon, 7, `Location (${coords.lat.toFixed(2)}°, ${coords.lon.toFixed(2)}°)`);
    return;
  }

  try {
    const omUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const res = await fetch(omUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        const r = data.results[0];
        flyToLocation(r.latitude, r.longitude, 7, r.name);
        return;
      }
    }
  } catch (err) {
    console.warn('Direct search error:', err);
  }

  alert(`Location "${query}" not found. Try entering lat, lon (e.g. 32.5, -64.8).`);
}

function parseCoordinates(str) {
  const decMatch = str.match(/^([-+]?\d*\.?\d+)[,\s]+([-+]?\d*\.?\d+)$/);
  if (decMatch) {
    const lat = parseFloat(decMatch[1]);
    const lon = parseFloat(decMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { lat, lon };
    }
  }
  return null;
}

async function flyToLocation(lat, lon, zoom = 7, title = '') {
  map.flyTo([lat, lon], zoom, { duration: 1.4, easeLinearity: 0.25 });

  if (searchTargetMarker) {
    map.removeLayer(searchTargetMarker);
  }
  searchTargetMarker = L.circleMarker([lat, lon], {
    pane: 'routePane',
    radius: 9,
    fillColor: '#38bdf8',
    color: '#ffffff',
    weight: 3,
    opacity: 1,
    fillOpacity: 0.8
  }).addTo(map);

  searchTargetMarker.bindPopup(`
    <div style="font-family: var(--font-main); font-size: 12px; color: #fff;">
      <strong style="color: #38bdf8;">${title || 'Searched Location'}</strong><br/>
      ${toDMS(lat, lon)}
    </div>
  `).openPopup();

  if (telemetryDrawer.classList.contains('closed')) {
    telemetryDrawer.classList.remove('closed');
  }

  inspectorModeLabel.textContent = 'SEARCHED LOCATION';
  routeProgressRow.style.display = 'none';
  routeRelativeHud.style.display = 'none';

  coordDMS.textContent = toDMS(lat, lon);
  coordDD.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  telemetrySource.textContent = 'Querying Live Telemetry...';

  const weather = await fetchWeatherTelemetry(lat, lon);
  telemetrySource.textContent = weather.source;
  updateCompassGauge(weather);
}


async function preloadGfsData() {
  loadingIndicator.style.display = 'flex';
  try {
    let loaded = false;
    try {
      const res = await fetch('forecast.json');
      if (res.ok) {
        const json = await res.json();
        if (json && json.vectors) {
          availableDates = json.dates || Object.keys(json.vectors).sort();
          for (const d of availableDates) {
            const raw = json.vectors[d] || [];
            forecastVectorsByDate[d] = parseAuthenticGfsVectors(raw);
          }
          loaded = true;
        }
      }
    } catch (e) {
      console.warn('forecast.json fallback:', e);
    }

    if (!loaded) {
      const today = new Date();
      availableDates = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const ds = d.toISOString().split('T')[0];
        availableDates.push(ds);
        forecastVectorsByDate[ds] = new Float32Array(0);
      }
    }

    dateSlider.min = 0;
    dateSlider.max = availableDates.length - 1;

    // Automatically align slider to TODAY's date on load
    const todayUtc = new Date().toISOString().split('T')[0];
    const todayIndex = availableDates.indexOf(todayUtc);
    currentDateIndex = todayIndex !== -1 ? todayIndex : 0;
    dateSlider.value = currentDateIndex;
    
    updateSelectedDateLabel(availableDates[currentDateIndex]);
    updateWindDisplay(availableDates[currentDateIndex]);
    console.log(`[Wind Map] Live verification complete: aligned to ${availableDates[currentDateIndex]} (Today: ${todayUtc})`);
  } catch (err) {
    console.error('Error preloading GFS data:', err);
    const today = new Date();
    availableDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const ds = d.toISOString().split('T')[0];
      availableDates.push(ds);
      forecastVectorsByDate[ds] = new Float32Array(0);
    }
    dateSlider.min = 0;
    dateSlider.max = availableDates.length - 1;
    dateSlider.value = 0;
    currentDateIndex = 0;
    updateSelectedDateLabel(availableDates[0]);
    updateWindDisplay(availableDates[0]);
  } finally {
    loadingIndicator.style.display = 'none';
  }
}

function updateWindDisplay(date) {
  if (!date) return;
  updateSelectedDateLabel(date);

  const vectors = forecastVectorsByDate[date] || new Float32Array(0);
  currentDisplayVectors = vectors;
  if (canvasOverlay) {
    canvasOverlay.setVectors(vectors);
  }
  if (waypoints.length > 1) {
    updateRoutePolyline();
  }
}

function updateSelectedDateLabel(dateStr) {
  const todayUtc = new Date().toISOString().split('T')[0];
  const isToday = dateStr === todayUtc;
  if (isToday) {
    selectedDateLabel.innerHTML = `${dateStr} <span class="live-dot-pulse">● LIVE NOW</span>`;
  } else {
    selectedDateLabel.textContent = `${dateStr} 12:00 UTC`;
  }
}

function updateUtcClock() {
  const now = new Date();
  const utcStr = now.toISOString().slice(11, 19) + ' Z';
  if (utcTimeDisplay) utcTimeDisplay.textContent = utcStr;
}

// ============================================================================
// 12. Bootstrap & Event Listeners
// ============================================================================
function initEventListeners() {
  if (playBtn) playBtn.addEventListener('click', togglePlay);
  if (prevDayBtn) prevDayBtn.addEventListener('click', () => stepTimeline(-1));
  if (nextDayBtn) nextDayBtn.addEventListener('click', () => stepTimeline(1));
  if (speedMultiplierBtn) speedMultiplierBtn.addEventListener('click', toggleSpeed);

  if (dateSlider) {
    dateSlider.addEventListener('input', () => {
      stopPlayback();
      currentDateIndex = parseInt(dateSlider.value);
      const date = availableDates[currentDateIndex];
      updateWindDisplay(date);
    });
  }

  // Basemap Vector / Satellite Toggle Switch
  if (btnMapVector) btnMapVector.addEventListener('click', () => switchBasemapMode('vector'));
  if (btnMapSatellite) btnMapSatellite.addEventListener('click', () => switchBasemapMode('satellite'));
  if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

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

  initSearchEngine();


  if (resetRouteBtn) resetRouteBtn.addEventListener('click', clearRoute);
  if (exportGpxBtn) exportGpxBtn.addEventListener('click', exportRouteGpx);
  if (exportGeoJsonBtn) exportGeoJsonBtn.addEventListener('click', exportRouteGeoJson);

  setInterval(updateUtcClock, 1000);
  updateUtcClock();
}

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initEventListeners();
  preloadGfsData();
});
