/**
 * Wind Map - Master Client GIS Engine
 * High-performance 60 FPS Canvas vector field & fluid particle engine,
 * true global coverage, O(1) bilinear vector interpolation, Along-Route
 * Geodesic Line Telemetry Interpolation, and zero-lag date scrubbing.
 */

// Global State
let map;
let vectorDarkLayer, vectorLightLayer, satelliteLayer;
let currentBaseMode = 'vector'; // 'vector' or 'satellite'
let currentTheme = 'dark'; // 'dark' or 'light'
let polyline = null;
let routeHitPolyline = null;
let routeHoverBeacon = null;
const drawnItems = new L.FeatureGroup();
let canvasOverlay = null;
let particleOverlay = null;
let currentDisplayStyle = 'arrows'; // 'arrows' or 'particles'

let forecastVectorsByDate = {}; // { 'YYYY-MM-DD': Float32Array([lat, lon, speed, dir, ...]) }
let forecastGridMeta = {
  latMin: -75,
  latMax: 77.5,
  latStep: 2.5,
  lonMin: -180,
  lonMax: 177.5,
  lonStep: 2.5,
  rows: 62,
  cols: 144
};
let forecastGeneratedAt = null;
let availableDates = [];
let currentDateIndex = 0;
let currentDisplayVectors = null; // Float32Array

let waypoints = []; // [{ index, lat, lng, speed, dir, gusts, pressure, temp, distToPrev, cumDist }]
let routeInterpolatedPoints = []; // [{ lat, lng, distFromStart, legIndex, heading, speed, dir, twa, tailwind, crosswind, sail }]
let lastInspectedWeather = null;
let inspectRequestSeq = 0;
let routeClearEpoch = 0;

let currentUnit = 'knots'; // 'knots', 'mph', 'kmh', 'ms', 'bft'
let currentDirConvention = localStorage.getItem('windmap_dir_convention') || 'from'; // 'from' or 'to'
let isPlaying = false;
let playTimer = null;
let playbackSpeed = 800; // ms per frame
const speedMultipliers = [1, 2, 4];
let speedIndex = 0;

const WIND_COLOR_BUCKETS = ['#10b981', '#38bdf8', '#facc15', '#fb923c', '#ef4444', '#c084fc'];
const UNIT_LABELS = {
  knots: 'kts',
  mph: 'mph',
  kmh: 'km/h',
  ms: 'm/s',
  bft: 'Bft'
};

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
const primaryDirLabel = document.getElementById('primaryDirLabel');
const secondaryDirLabel = document.getElementById('secondaryDirLabel');
const bearingDegLabel = document.getElementById('bearingDeg');
const cardinalTextLabel = document.getElementById('cardinalText');
const flowDegElem = document.getElementById('flowDegText');
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
// 0. Security & Non-Blocking UI Helpers
// ============================================================================
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info', durationMs = 3800) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast-message toast-${type}`;
  const iconClass = type === 'error'
    ? 'fa-circle-exclamation'
    : type === 'warn'
      ? 'fa-triangle-exclamation'
      : 'fa-circle-info';
  toast.innerHTML = `<i class="fa-solid ${iconClass}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    setTimeout(() => toast.remove(), 260);
  }, durationMs);
}

// ============================================================================
// 1. High-Performance HTML5 Canvas Vector Field Engine (Arrows)
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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const { rows, cols } = forecastGridMeta;

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!this.vectors || this.vectors.length < rows * cols * 4) {
      this.ctx.restore();
      return;
    }

    const bounds = this.map.getBounds().pad(0.1);
    const zoom = this.map.getZoom();
    const ctx = this.ctx;
    const toRad = Math.PI / 180;
    const vectors = this.vectors;

    // Uniform 2D row/col subsampling prevents vertical crowding or diagonal banding
    const step = zoom <= 2 ? 3 : zoom <= 3 ? 2 : 1;

    const minWorld = Math.floor((bounds.getWest() + 180) / 360);
    const maxWorld = Math.floor((bounds.getEast() + 180) / 360);
    const buckets = [[], [], [], [], [], []];

    for (let w = minWorld; w <= maxWorld; w++) {
      const lonOffset = w * 360;

      for (let r = 0; r < rows; r += step) {
        for (let c = 0; c < cols; c += step) {
          const idx = (r * cols + c) * 4;
          const lat = vectors[idx];
          const lon = vectors[idx + 1] + lonOffset;

          const layerPt = this.map.latLngToContainerPoint([lat, lon]);
          const x = layerPt.x;
          const y = layerPt.y;

          if (x < -40 || y < -40 || x > size.x + 40 || y > size.y + 40) continue;

          const speed = vectors[idx + 2];
          const dir = vectors[idx + 3];
          const bucketIdx = getWindColorBucketIndex(speed);

          const len = Math.min(Math.max(5 + speed * 0.85, 6), 40);
          const headLen = Math.min(Math.max(2.5 + speed * 0.12, 2.8), 6.5);

          // Meteorological FROM direction -> downwind flow angle in canvas coords
          const angle = ((dir + 90) % 360) * toRad;
          const halfLen = len * 0.5;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);

          const startX = x - halfLen * cosA;
          const startY = y - halfLen * sinA;
          const endX = x + halfLen * cosA;
          const endY = y + halfLen * sinA;

          const barbAngle1 = angle + Math.PI * 0.80;
          const barbAngle2 = angle - Math.PI * 0.80;

          buckets[bucketIdx].push(
            startX,
            startY,
            endX,
            endY,
            endX + headLen * Math.cos(barbAngle1),
            endY + headLen * Math.sin(barbAngle1),
            endX + headLen * Math.cos(barbAngle2),
            endY + headLen * Math.sin(barbAngle2)
          );
        }
      }
    }

    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let b = 0; b < 6; b++) {
      const segs = buckets[b];
      if (segs.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = WIND_COLOR_BUCKETS[b];
      for (let k = 0; k < segs.length; k += 8) {
        const sx = segs[k];
        const sy = segs[k + 1];
        const ex = segs[k + 2];
        const ey = segs[k + 3];
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.lineTo(segs[k + 4], segs[k + 5]);
        ctx.moveTo(ex, ey);
        ctx.lineTo(segs[k + 6], segs[k + 7]);
      }
      ctx.stroke();
    }

    this.ctx.restore();
  }
}

// ============================================================================
// 1B. High-Performance 60 FPS Animated Fluid Particle Engine
// ============================================================================
class WindParticleOverlay {
  constructor(leafletMap) {
    this.map = leafletMap;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wind-particle-layer';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '450';
    this.ctx = this.canvas.getContext('2d', { alpha: true });

    this.map.getPanes().overlayPane.appendChild(this.canvas);
    this.vectors = null;
    this.particles = [];
    this.maxParticles = 2200;
    this.animId = null;
    this.isActive = false;
    this.isInteracting = false;

    this.resize();
    this.reposition();

    this.map.on('movestart zoomstart', () => {
      this.isInteracting = true;
      this.clearCanvas();
    });
    this.map.on('move', () => this.reposition());
    this.map.on('moveend', () => {
      this.isInteracting = false;
      this.reposition();
      this.resetParticles();
    });
    this.map.on('zoomend', () => {
      this.isInteracting = false;
      this.resize();
      this.reposition();
      this.resetParticles();
    });
    this.map.on('resize', () => {
      this.resize();
      this.reposition();
      this.resetParticles();
    });

    document.addEventListener('visibilitychange', () => {
      if (!this.isActive) return;
      if (document.hidden) {
        if (this.animId) {
          cancelAnimationFrame(this.animId);
          this.animId = null;
        }
      } else if (!this.animId) {
        this.animate();
      }
    });
  }

  resize() {
    const size = this.map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
  }

  reposition() {
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
  }

  clearCanvas() {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  setVectors(vectors) {
    this.vectors = vectors;
    this.resetParticles();
  }

  respawnParticle(p, size) {
    p.x = Math.random() * size.x;
    p.y = Math.random() * size.y;
    p.prevX = p.x;
    p.prevY = p.y;
    p.age = 0;
    p.maxAge = 40 + Math.floor(Math.random() * 60);
  }

  resetParticles() {
    const size = this.map.getSize();
    this.particles = [];
    for (let i = 0; i < this.maxParticles; i++) {
      const x = Math.random() * size.x;
      const y = Math.random() * size.y;
      this.particles.push({
        x,
        y,
        prevX: x,
        prevY: y,
        age: Math.floor(Math.random() * 80),
        maxAge: 40 + Math.floor(Math.random() * 60),
        speed: 0
      });
    }
  }

  start() {
    this.isActive = true;
    this.isInteracting = false;
    this.canvas.style.display = 'block';
    this.clearCanvas();
    this.resetParticles();
    if (!this.animId && !document.hidden) {
      this.animate();
    }
  }

  stop() {
    this.isActive = false;
    this.canvas.style.display = 'none';
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    this.clearCanvas();
  }

  animate() {
    if (!this.isActive || document.hidden) {
      this.animId = null;
      return;
    }
    if (!this.isInteracting) {
      this.drawFrame();
    }
    this.animId = requestAnimationFrame(() => this.animate());
  }

  drawFrame() {
    if (!this.map || !this.ctx || !this.vectors || this.vectors.length === 0) return;
    const size = this.map.getSize();
    const ctx = this.ctx;
    const dpr = this.dpr || 1;

    // Motion-blur fade on previous trails
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const speedScale = 0.55;
    const toRad = Math.PI / 180;
    const buckets = [[], [], [], [], [], []];

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.prevX = p.x;
      p.prevY = p.y;

      const latlng = this.map.containerPointToLatLng([p.x, p.y]);
      const wind = interpolateVectorField(latlng.lat, latlng.lng);

      if (!wind) {
        this.respawnParticle(p, size);
        continue;
      }

      p.speed = wind.speed;
      const angle = ((wind.dir + 90) % 360) * toRad;
      const step = Math.min(Math.max(wind.speed * speedScale, 1.2), 8.5);
      p.x += step * Math.cos(angle);
      p.y += step * Math.sin(angle);
      p.age++;

      buckets[getWindColorBucketIndex(wind.speed)].push(p.prevX, p.prevY, p.x, p.y);

      if (p.age > p.maxAge || p.x < 0 || p.x > size.x || p.y < 0 || p.y > size.y) {
        this.respawnParticle(p, size);
      }
    }

    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    for (let b = 0; b < 6; b++) {
      const segs = buckets[b];
      if (segs.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = WIND_COLOR_BUCKETS[b];
      for (let k = 0; k < segs.length; k += 4) {
        ctx.moveTo(segs[k], segs[k + 1]);
        ctx.lineTo(segs[k + 2], segs[k + 3]);
      }
      ctx.stroke();
    }

    ctx.restore();
  }
}

// ============================================================================
// 2. Map Initialization & Basemap Management
// ============================================================================
function initMap() {
  map = L.map('map', {
    preferCanvas: true,
    zoomControl: true,
    minZoom: 2,
    maxZoom: 12
  }).setView([25.0, -40.0], 4);

  map.createPane('routePane');
  map.getPane('routePane').style.zIndex = 550;

  // 100% Keyless Esri Basemap Layers
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

  canvasOverlay = new WindCanvasOverlay(map);
  particleOverlay = new WindParticleOverlay(map);
  particleOverlay.stop();

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
    target.eachLayer(l => {
      if (l.bringToBack) l.bringToBack();
    });
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
function getUnitLabel(unit = currentUnit) {
  return UNIT_LABELS[unit] || 'kts';
}

function convertWindSpeed(speedKnots, targetUnit = currentUnit) {
  if (speedKnots === null || speedKnots === undefined || Number.isNaN(Number(speedKnots))) return '--';
  const k = Number(speedKnots);
  switch (targetUnit) {
    case 'mph': return (k * 1.15078).toFixed(1);
    case 'kmh': return (k * 1.852).toFixed(1);
    case 'ms': return (k * 0.514444).toFixed(1);
    case 'bft': return getBeaufortScale(k).force;
    case 'knots':
    default: return k.toFixed(1);
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

function getWindColorBucketIndex(speedKnots) {
  const k = parseFloat(speedKnots);
  if (k < 7) return 0;
  if (k < 16) return 1;
  if (k < 25) return 2;
  if (k < 34) return 3;
  if (k < 48) return 4;
  return 5;
}

function getWindColor(speedKnots) {
  return WIND_COLOR_BUCKETS[getWindColorBucketIndex(speedKnots)];
}

function updateLegendUnits(unit = currentUnit) {
  if (legendUnitBadge) {
    legendUnitBadge.textContent = getUnitLabel(unit);
  }
  const labelEls = document.querySelectorAll('.scale-label[data-tier]');
  if (labelEls.length === 0) return;

  let labels;
  if (unit === 'bft') {
    labels = [
      'Force 0-2 (Light Air)',
      'Force 3-4 (Moderate)',
      'Force 5-6 (Fresh)',
      'Force 7 (Near Gale)',
      'Force 8-9 (Gale Force)',
      'Force 10-12 (Storm/Hurricane)'
    ];
  } else {
    const fmt = k => {
      const v = Number(convertWindSpeed(k, unit));
      return unit === 'ms' ? v.toFixed(1) : Math.round(v);
    };
    const u = getUnitLabel(unit);
    labels = [
      `< ${fmt(7)} ${u} (Light Air)`,
      `${fmt(7)} - ${fmt(15)} ${u} (Moderate)`,
      `${fmt(16)} - ${fmt(24)} ${u} (Fresh)`,
      `${fmt(25)} - ${fmt(33)} ${u} (Near Gale)`,
      `${fmt(34)} - ${fmt(47)} ${u} (Gale Force)`,
      `\u2265 ${fmt(48)} ${u} (Storm/Hurricane)`
    ];
  }

  labelEls.forEach(el => {
    const tier = Number(el.dataset.tier);
    if (labels[tier]) {
      el.textContent = labels[tier];
    }
  });
}

function formatWindDirection(fromDeg) {
  const normalizedFrom = ((fromDeg % 360) + 360) % 360;
  if (currentDirConvention === 'to') {
    const toDeg = (normalizedFrom + 180) % 360;
    return {
      deg: Math.round(toDeg) % 360,
      cardinal: degToCardinal(toDeg),
      mode: 'TO',
      fullText: `${Math.round(toDeg) % 360}° (${degToCardinal(toDeg)}) [TO]`
    };
  }
  return {
    deg: Math.round(normalizedFrom) % 360,
    cardinal: degToCardinal(normalizedFrom),
    mode: 'FROM',
    fullText: `${Math.round(normalizedFrom) % 360}° (${degToCardinal(normalizedFrom)}) [FROM]`
  };
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
    let sec = Math.round((minFloat - min) * 60);
    let adjMin = min;
    let adjDeg = deg;
    if (sec === 60) {
      sec = 0;
      adjMin += 1;
      if (adjMin === 60) {
        adjMin = 0;
        adjDeg += 1;
      }
    }
    const dir = val >= 0 ? posChar : negChar;
    return `${adjDeg}° ${String(adjMin).padStart(2, '0')}' ${String(sec).padStart(2, '0')}" ${dir}`;
  };
  return `${formatCoord(lat, 'N', 'S')} / ${formatCoord(lng, 'E', 'W')}`;
}

function calculateGreatCircleDistanceNM(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 3440.065;
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
// 4. Live Weather Telemetry & O(1) Regular-Grid Bilinear Interpolation
// ============================================================================
async function fetchWeatherTelemetry(lat, lon) {
  const parseNum = v => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

  // Tier 1: Open-Meteo Global Live Current Observation
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&wind_speed_unit=kn`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.current) {
        const speed = parseNum(data.current.wind_speed_10m);
        const direction = parseNum(data.current.wind_direction_10m);
        if (speed !== null && direction !== null) {
          return {
            speed,
            direction,
            gusts: parseNum(data.current.wind_gusts_10m),
            pressure: parseNum(data.current.pressure_msl),
            temp: parseNum(data.current.temperature_2m),
            source: 'Open-Meteo Global Live'
          };
        }
      }
    }
  } catch (err) {
    console.warn('Open-Meteo fallback:', err);
  }

  // Tier 2: Interpolated NOAA GFS Forecast Grid
  const localVec = interpolateVectorField(lat, lon);
  if (localVec) {
    return {
      speed: localVec.speed,
      direction: localVec.dir,
      gusts: null,
      pressure: null,
      temp: null,
      source: 'NOAA GFS Forecast Field'
    };
  }

  return {
    speed: null,
    direction: null,
    gusts: null,
    pressure: null,
    temp: null,
    source: 'Telemetry Unavailable'
  };
}

function interpolateVectorField(lat, lon) {
  const vecs = currentDisplayVectors;
  const { latMin, latMax, latStep, lonMin, lonStep, rows, cols } = forecastGridMeta;
  if (!vecs || vecs.length < rows * cols * 4) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -82 || lat > 82) return null;

  const clampedLat = Math.max(latMin, Math.min(latMax, lat));
  const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;

  const r = (clampedLat - latMin) / latStep;
  const r0 = Math.min(Math.max(Math.floor(r), 0), rows - 1);
  const r1 = Math.min(r0 + 1, rows - 1);
  const fr = r - r0;

  const c = (normLon - lonMin) / lonStep;
  const cFloor = Math.floor(c);
  const c0 = ((cFloor % cols) + cols) % cols;
  const c1 = (c0 + 1) % cols;
  const fc = c - cFloor;

  const toRad = Math.PI / 180;
  const readUV = (ri, ci) => {
    const idx = (ri * cols + ci) * 4;
    const spd = vecs[idx + 2];
    const dirRad = vecs[idx + 3] * toRad;
    return {
      u: -spd * Math.sin(dirRad),
      v: -spd * Math.cos(dirRad)
    };
  };

  const c00 = readUV(r0, c0);
  const c10 = readUV(r0, c1);
  const c01 = readUV(r1, c0);
  const c11 = readUV(r1, c1);

  const u0 = c00.u + (c10.u - c00.u) * fc;
  const v0 = c00.v + (c10.v - c00.v) * fc;
  const u1 = c01.u + (c11.u - c01.u) * fc;
  const v1 = c01.v + (c11.v - c01.v) * fc;

  const u = u0 + (u1 - u0) * fr;
  const v = v0 + (v1 - v0) * fr;

  const speed = Math.hypot(u, v);
  const dir = speed > 1e-6 ? (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 : 0;
  return { speed, dir };
}

// ============================================================================
// 5. Great-Circle (Geodesic) Spherical Arc Generator & Line Profiler
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
    const wind = interpolateVectorField(lat1, lon1);
    return [{
      lat: lat1,
      lng: lon1,
      distFromStart: startCumDist,
      legIndex,
      heading: 0,
      speed: wind ? wind.speed : null,
      dir: wind ? wind.dir : null,
      twa: null,
      tailwind: null,
      crosswind: null,
      sail: null
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

    let speed = null;
    let dir = null;
    let twa = null;
    let tailwind = null;
    let crosswind = null;
    let sail = null;

    if (wind) {
      speed = wind.speed;
      dir = wind.dir;
      // Positive cos(twa) is wind blowing FROM ahead (headwind), so tailwind = -speed * cos(twa)
      twa = ((((dir - heading + 180) % 360) + 360) % 360) - 180;
      tailwind = -speed * Math.cos(twa * Math.PI / 180);
      crosswind = speed * Math.sin(twa * Math.PI / 180);
      sail = getPointOfSail(twa);
    }

    points.push({
      lat,
      lng: lon,
      distFromStart,
      legIndex,
      heading,
      speed,
      dir,
      twa,
      tailwind,
      crosswind,
      sail
    });
  }

  return points;
}

// ============================================================================
// 6. Route Polyline & Interactive Along-Line Inspector
// ============================================================================
function updateRoutePolyline() {
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  if (routeHitPolyline) {
    map.removeLayer(routeHitPolyline);
    routeHitPolyline = null;
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
      weight: 4,
      opacity: 0.9,
      dashArray: '6, 6',
      interactive: false
    }).addTo(map);

    routeHitPolyline = L.polyline(latlngs, {
      pane: 'routePane',
      color: '#38bdf8',
      weight: 22,
      opacity: 0.01,
      interactive: true
    }).addTo(map);

    routeHitPolyline.on('mousemove', handleRouteLineHover);
    routeHitPolyline.on('mouseout', handleRouteLineOut);
    routeHitPolyline.on('click', handleRouteLineClick);
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

  inspectRequestSeq++;

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
      fillOpacity: 1,
      interactive: false
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
    gusts: null,
    pressure: null,
    temp: null
  });

  routeRelativeHud.style.display = 'flex';
  routeHeadingVal.textContent = `${Math.round(pt.heading)}° (${degToCardinal(pt.heading)})`;
  pointOfSailVal.textContent = pt.sail ? pt.sail.name : '--';

  if (pt.tailwind !== null && pt.tailwind !== undefined) {
    const isTailwind = pt.tailwind >= 0;
    const twSign = isTailwind ? '+' : '-';
    const twDesc = isTailwind ? 'Tailwind' : 'Headwind';
    const compUnit = currentUnit === 'bft' ? 'knots' : currentUnit;
    relativeWindVal.textContent = `${twSign}${convertWindSpeed(Math.abs(pt.tailwind), compUnit)} ${getUnitLabel(compUnit)} ${twDesc}`;
    relativeWindVal.style.color = isTailwind ? 'var(--accent-emerald)' : 'var(--accent-rose)';
  } else {
    relativeWindVal.textContent = '--';
    relativeWindVal.style.color = 'var(--text-primary)';
  }
}

function handleRouteLineOut() {
  if (routeHoverBeacon) {
    map.removeLayer(routeHoverBeacon);
    routeHoverBeacon = null;
  }
}

function handleRouteLineClick(e) {
  if (e && e.originalEvent) {
    L.DomEvent.stopPropagation(e.originalEvent);
  }
  handleRouteLineHover(e);
}

// ============================================================================
// 7. Map Click & Waypoint Handling
// ============================================================================
async function handleMapClick(e) {
  const { lat, lng } = e.latlng;
  const reqId = ++inspectRequestSeq;
  const clearEpochAtStart = routeClearEpoch;

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
  if (clearEpochAtStart !== routeClearEpoch) return;

  if (reqId === inspectRequestSeq) {
    telemetrySource.textContent = weather.source;
    updateCompassGauge(weather);
  }

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
    cumDist
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

  const windPopupStr = weather.speed !== null && weather.direction !== null
    ? `${escapeHtml(convertWindSpeed(weather.speed))} ${escapeHtml(getUnitLabel())} @ ${formatWindDirection(weather.direction).deg}° (${escapeHtml(formatWindDirection(weather.direction).cardinal)})`
    : 'Telemetry unavailable';

  marker.bindPopup(`
    <div class="wind-popup">
      <strong class="wind-popup-title">Waypoint #${newWp.index}</strong>
      <div class="wind-popup-meta">${escapeHtml(toDMS(lat, lng))}</div>
      <div class="wind-popup-meta">Wind: <strong>${windPopupStr}</strong></div>
      <div class="wind-popup-meta">Leg: <strong>${legDist.toFixed(1)} NM</strong> | Total: <strong>${cumDist.toFixed(1)} NM</strong></div>
    </div>
  `);

  updateRoutePolyline();
  renderWaypointTable();
}

function updateCompassGauge(weather) {
  const unitLabel = getUnitLabel(currentUnit);
  const isTo = currentDirConvention === 'to';

  if (primaryDirLabel) primaryDirLabel.textContent = isTo ? 'BLOWS TO' : 'FROM';
  if (secondaryDirLabel) secondaryDirLabel.textContent = isTo ? 'FROM' : 'BLOWS TO';

  const hasValidWind = weather && weather.speed !== null && weather.speed !== undefined && !Number.isNaN(Number(weather.speed));
  if (!hasValidWind) {
    lastInspectedWeather = null;
    if (compassNeedle) compassNeedle.style.transform = 'rotate(0deg)';
    if (bearingDegLabel) bearingDegLabel.textContent = '--°';
    if (cardinalTextLabel) cardinalTextLabel.textContent = '--';
    if (flowDegElem) flowDegElem.textContent = '--°';
    if (windSpeedVal) windSpeedVal.textContent = '--';
    if (windSpeedUnit) windSpeedUnit.textContent = unitLabel;
    if (beaufortChip) {
      beaufortChip.textContent = 'Force --';
      beaufortChip.style.color = 'var(--text-muted)';
    }
    if (gustSpeedVal) gustSpeedVal.textContent = '--';
    if (pressureVal) pressureVal.textContent = '--';
    if (tempVal) tempVal.textContent = '--';
    return;
  }

  const rawDir = weather.direction !== undefined && weather.direction !== null ? weather.direction : weather.dir;
  const hasDir = rawDir !== null && rawDir !== undefined && !Number.isNaN(Number(rawDir));
  const fromDeg = hasDir ? ((Number(rawDir) % 360) + 360) % 360 : 0;
  const toDeg = (fromDeg + 180) % 360;

  lastInspectedWeather = { ...weather, direction: hasDir ? fromDeg : null };

  // Cyan vane head always points downwind (toDeg) matching map vectors; red tail marks origin
  if (compassNeedle) {
    compassNeedle.style.transform = hasDir ? `rotate(${toDeg}deg)` : 'rotate(0deg)';
  }

  if (hasDir) {
    const dirData = formatWindDirection(fromDeg);
    if (bearingDegLabel) bearingDegLabel.textContent = `${dirData.deg}°`;
    if (cardinalTextLabel) cardinalTextLabel.textContent = dirData.cardinal;
    if (flowDegElem) {
      const secondaryDeg = isTo ? Math.round(fromDeg) % 360 : Math.round(toDeg) % 360;
      const secondaryCard = degToCardinal(secondaryDeg);
      flowDegElem.textContent = `${secondaryDeg}° (${secondaryCard})`;
    }
  } else {
    if (bearingDegLabel) bearingDegLabel.textContent = '--°';
    if (cardinalTextLabel) cardinalTextLabel.textContent = '--';
    if (flowDegElem) flowDegElem.textContent = '--°';
  }

  if (windSpeedVal) windSpeedVal.textContent = convertWindSpeed(weather.speed);
  if (windSpeedUnit) windSpeedUnit.textContent = unitLabel;

  const bft = getBeaufortScale(weather.speed);
  if (beaufortChip) {
    beaufortChip.textContent = `Force ${bft.force} (${bft.desc})`;
    beaufortChip.style.color = getWindColor(weather.speed);
  }

  if (gustSpeedVal) {
    gustSpeedVal.textContent = weather.gusts !== null && weather.gusts !== undefined
      ? `${convertWindSpeed(weather.gusts)} ${unitLabel}`
      : '--';
  }
  if (pressureVal) {
    pressureVal.textContent = weather.pressure !== null && weather.pressure !== undefined
      ? `${Math.round(weather.pressure)} hPa`
      : '--';
  }
  if (tempVal) {
    tempVal.textContent = weather.temp !== null && weather.temp !== undefined
      ? `${Math.round(weather.temp)} °C`
      : '--';
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
    const hasWind = wp.speed !== null && wp.speed !== undefined;
    const speedCell = hasWind
      ? `<span style="color:${getWindColor(wp.speed)};font-weight:700;">${escapeHtml(convertWindSpeed(wp.speed))}</span>`
      : '--';
    const dirCell = wp.dir !== null && wp.dir !== undefined
      ? `@ ${formatWindDirection(wp.dir).deg}° (${escapeHtml(formatWindDirection(wp.dir).cardinal)})`
      : '';
    html += `
      <tr>
        <td><strong>WP${wp.index}</strong></td>
        <td>${wp.lat.toFixed(2)}°, ${wp.lng.toFixed(2)}°</td>
        <td>${speedCell} ${dirCell}</td>
        <td>${wp.distToPrev.toFixed(1)}</td>
      </tr>
    `;
  }
  waypointTableBody.innerHTML = html;
}

function clearRoute() {
  routeClearEpoch++;
  inspectRequestSeq++;
  waypoints = [];
  routeInterpolatedPoints = [];
  drawnItems.clearLayers();
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  if (routeHitPolyline) {
    map.removeLayer(routeHitPolyline);
    routeHitPolyline = null;
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
  telemetrySource.textContent = 'Click Map or Hover Route';
  updateCompassGauge(null);
}

// ============================================================================
// 8. Route Exporters (GPX & GeoJSON)
// ============================================================================
function exportRouteGpx() {
  if (waypoints.length === 0) {
    showToast('Please plot at least one waypoint before exporting GPX.', 'warn');
    return;
  }

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  gpx += `<gpx version="1.1" creator="Wind Map - https://github.com/sounny/windmap" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  gpx += `  <metadata><name>Map Winds Planned Route</name><time>${new Date().toISOString()}</time></metadata>\n`;
  gpx += `  <rte>\n    <name>Marine Navigation Route</name>\n`;

  for (const wp of waypoints) {
    const desc = wp.speed !== null && wp.dir !== null
      ? `Wind: ${convertWindSpeed(wp.speed)} ${getUnitLabel()} @ ${Math.round(wp.dir)} deg`
      : 'Wind telemetry unavailable';
    gpx += `    <rtept lat="${wp.lat}" lon="${wp.lng}">\n`;
    gpx += `      <name>WP${wp.index}</name>\n`;
    gpx += `      <desc>${desc}</desc>\n`;
    gpx += `    </rtept>\n`;
  }

  gpx += `  </rte>\n</gpx>`;

  downloadFile(gpx, 'windmap_route.gpx', 'application/gpx+xml');
}

function exportRouteGeoJson() {
  if (waypoints.length === 0) {
    showToast('Please plot at least one waypoint before exporting GeoJSON.', 'warn');
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
// 9. Timeline Playback & Scrubber Controls
// ============================================================================
function togglePlay() {
  if (availableDates.length === 0) return;
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
  if (availableDates.length === 0) return;
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
    } else if (searchDropdown) {
      searchDropdown.style.display = 'none';
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
              name: String(r.display_name || '').split(',').slice(0, 3).join(','),
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
    const iconSafe = /^fa-[a-z0-9-]+$/.test(s.icon) ? s.icon : 'fa-map-pin';
    html += `
      <button class="suggestion-item" data-index="${idx}">
        <i class="fa-solid ${iconSafe} suggestion-icon"></i>
        <div class="suggestion-info">
          <span class="suggestion-name">${escapeHtml(s.name)}</span>
          <span class="suggestion-coords">${escapeHtml(s.coordsStr)}</span>
        </div>
      </button>
    `;
  });

  searchSuggestionsList.innerHTML = html;
  searchDropdown.style.display = 'flex';

  searchSuggestionsList.querySelectorAll('.suggestion-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = suggestions[Number(btn.dataset.index)];
      if (!item) return;
      locationSearch.value = item.name;
      if (searchClearBtn) searchClearBtn.style.display = 'block';
      searchDropdown.style.display = 'none';
      flyToLocation(item.lat, item.lon, 7, item.name);
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

  showToast(`Location "${query}" not found. Try entering lat, lon (e.g. 32.5, -64.8).`, 'warn');
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
  const reqId = ++inspectRequestSeq;
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
    <div class="wind-popup">
      <strong class="wind-popup-title">${escapeHtml(title || 'Searched Location')}</strong>
      <div class="wind-popup-meta">${escapeHtml(toDMS(lat, lon))}</div>
    </div>
  `).openPopup();

  if (telemetryDrawer.classList.contains('closed')) {
    telemetryDrawer.classList.remove('closed');
  }

  inspectorModeLabel.textContent = 'SEARCHED LOCATION';
  routeProgressRow.style.display = 'none';
  routeRelativeHud.style.display = 'none';

  coordDMS.textContent = toDMS(lat, lngSafe(lon));
  coordDD.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  telemetrySource.textContent = 'Querying Live Telemetry...';

  const weather = await fetchWeatherTelemetry(lat, lon);
  if (reqId !== inspectRequestSeq) return;
  telemetrySource.textContent = weather.source;
  updateCompassGauge(weather);
}

function lngSafe(lon) {
  return Number.isFinite(lon) ? lon : 0;
}

// ============================================================================
// 11. GFS Forecast Data Preloading & Timeline Sync
// ============================================================================
async function preloadGfsData() {
  loadingIndicator.style.display = 'flex';
  try {
    let loaded = false;
    try {
      const res = await fetch('forecast.json', { cache: 'no-cache' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.vectors) {
          if (json.grid && json.grid.rows && json.grid.cols) {
            forecastGridMeta = { ...forecastGridMeta, ...json.grid };
          }
          forecastGeneratedAt = json.generated_at || null;
          availableDates = json.dates || Object.keys(json.vectors).sort();
          for (const d of availableDates) {
            const raw = json.vectors[d] || [];
            forecastVectorsByDate[d] = new Float32Array(raw);
          }
          loaded = availableDates.length > 0;
        }
      }
    } catch (e) {
      console.warn('forecast.json load error:', e);
    }

    if (!loaded) {
      showToast('Forecast dataset could not be loaded. Showing live point queries only.', 'warn', 5000);
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

    const todayUtc = new Date().toISOString().split('T')[0];
    const todayIndex = availableDates.indexOf(todayUtc);
    currentDateIndex = todayIndex !== -1 ? todayIndex : 0;
    dateSlider.value = currentDateIndex;

    updateSelectedDateLabel(availableDates[currentDateIndex]);
    updateWindDisplay(availableDates[currentDateIndex]);
    console.log(`[Wind Map] Telemetry aligned to ${availableDates[currentDateIndex]} (Today UTC: ${todayUtc})`);
  } catch (err) {
    console.error('Error preloading GFS data:', err);
    showToast('Unable to initialize forecast timeline.', 'error');
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
  if (particleOverlay) {
    particleOverlay.setVectors(vectors);
  }
  if (waypoints.length > 1) {
    updateRoutePolyline();
  }
}

function updateSelectedDateLabel(dateStr) {
  const todayUtc = new Date().toISOString().split('T')[0];
  const isToday = dateStr === todayUtc;
  if (isToday) {
    selectedDateLabel.innerHTML = `${escapeHtml(dateStr)} <span class="live-dot-pulse">● LIVE NOW</span>`;
  } else {
    selectedDateLabel.textContent = `${dateStr} (Daily Max)`;
  }
  selectedDateLabel.title = forecastGeneratedAt ? `Model updated: ${forecastGeneratedAt}` : '';
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
      currentDateIndex = parseInt(dateSlider.value, 10);
      const date = availableDates[currentDateIndex];
      updateWindDisplay(date);
    });
  }

  const btnDirFrom = document.getElementById('btnDirFrom');
  const btnDirTo = document.getElementById('btnDirTo');

  function setDirConvention(mode) {
    currentDirConvention = mode;
    localStorage.setItem('windmap_dir_convention', mode);
    if (mode === 'to') {
      if (btnDirTo) btnDirTo.classList.add('active');
      if (btnDirFrom) btnDirFrom.classList.remove('active');
    } else {
      if (btnDirFrom) btnDirFrom.classList.add('active');
      if (btnDirTo) btnDirTo.classList.remove('active');
    }
    renderWaypointTable();
    updateCompassGauge(lastInspectedWeather);
  }

  if (btnDirFrom) btnDirFrom.addEventListener('click', () => setDirConvention('from'));
  if (btnDirTo) btnDirTo.addEventListener('click', () => setDirConvention('to'));

  setDirConvention(currentDirConvention);
  updateLegendUnits(currentUnit);

  if (btnMapVector) btnMapVector.addEventListener('click', () => switchBasemapMode('vector'));
  if (btnMapSatellite) btnMapSatellite.addEventListener('click', () => switchBasemapMode('satellite'));
  if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

  if (unitSelect) {
    unitSelect.addEventListener('change', e => {
      currentUnit = e.target.value;
      updateLegendUnits(currentUnit);
      renderWaypointTable();
      updateCompassGauge(lastInspectedWeather);
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

  const btnStyleArrows = document.getElementById('btnStyleArrows');
  const btnStyleParticles = document.getElementById('btnStyleParticles');

  function setDisplayStyle(style) {
    currentDisplayStyle = style;
    if (style === 'particles') {
      if (btnStyleParticles) btnStyleParticles.classList.add('active');
      if (btnStyleArrows) btnStyleArrows.classList.remove('active');
      if (canvasOverlay) canvasOverlay.canvas.style.display = 'none';
      if (particleOverlay) {
        if (currentDisplayVectors) particleOverlay.setVectors(currentDisplayVectors);
        particleOverlay.start();
      }
    } else {
      if (btnStyleArrows) btnStyleArrows.classList.add('active');
      if (btnStyleParticles) btnStyleParticles.classList.remove('active');
      if (particleOverlay) particleOverlay.stop();
      if (canvasOverlay) {
        canvasOverlay.canvas.style.display = 'block';
        canvasOverlay.draw();
      }
    }
  }

  if (btnStyleArrows) btnStyleArrows.addEventListener('click', () => setDisplayStyle('arrows'));
  if (btnStyleParticles) btnStyleParticles.addEventListener('click', () => setDisplayStyle('particles'));

  const locateMeBtn = document.getElementById('locateMeBtn');
  if (locateMeBtn) {
    locateMeBtn.addEventListener('click', () => {
      if ('geolocation' in navigator) {
        locateMeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        navigator.geolocation.getCurrentPosition(
          pos => {
            locateMeBtn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
            const { latitude, longitude } = pos.coords;
            flyToLocation(latitude, longitude, 8, 'My Live GPS Location');
          },
          err => {
            locateMeBtn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
            showToast('Geolocation access denied or unavailable: ' + err.message, 'error');
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      } else {
        showToast('Geolocation is not supported by your browser.', 'warn');
      }
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
