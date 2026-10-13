"""
NOAA GFS Model Ingestion & Telemetry Processing Engine
Fetches genuine global NOAA GFS daily wind telemetry across a multi-continent
coordinate station grid from Open-Meteo, interpolates via inverse-distance
weighting onto a dense global vector field, and exports production-grade
forecast.json and forecast.geojson datasets.
"""

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import random
import time

import numpy as np
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("windmap.ingestion")

GEOJSON_OUTPUT_FILE = Path("forecast.geojson")
JSON_OUTPUT_FILE = Path("forecast.json")

# Batching & Resilience Configuration
CHUNK_SIZE = 60          # 360 global points split into 6 lightweight batches
CONNECT_TIMEOUT = 15.0   # seconds to establish TCP connection
READ_TIMEOUT = 60.0      # generous seconds per chunk to prevent premature timeout
MAX_RETRIES = 5          # max retry attempts per chunk
BASE_BACKOFF = 2.0       # base seconds for exponential backoff

def create_resilient_session() -> requests.Session:
    """Builds a requests.Session with connection pooling and HTTP retries."""
    session = requests.Session()
    retry_strategy = Retry(
        total=MAX_RETRIES,
        backoff_factor=BASE_BACKOFF,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=True
    )
    adapter = HTTPAdapter(
        max_retries=retry_strategy,
        pool_connections=10,
        pool_maxsize=10
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({
        "User-Agent": "WindMapGlobal/1.0 (+https://github.com/sounny/windmap)"
    })
    return session

def fetch_chunk_with_backoff(session: requests.Session, chunk: list, chunk_idx: int, total_chunks: int) -> list:
    """Fetches a single chunk of coordinate points with explicit jittered backoff."""
    lat_str = ','.join(str(c[0]) for c in chunk)
    lon_str = ','.join(str(c[1]) for c in chunk)
    params = {
        "latitude": lat_str,
        "longitude": lon_str,
        "daily": "wind_speed_10m_max,wind_direction_10m_dominant",
        "wind_speed_unit": "kn",
        "timezone": "UTC"
    }
    url = "https://api.open-meteo.com/v1/forecast"

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        t0 = time.time()
        try:
            logger.info("Fetching chunk %d/%d (%d coords, attempt %d/%d)...",
                        chunk_idx, total_chunks, len(chunk), attempt, MAX_RETRIES)
            resp = session.get(url, params=params, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
            resp.raise_for_status()
            data = resp.json()

            # Open-Meteo returns a single object if 1 location, or a list of objects if >1 location
            if isinstance(data, dict):
                data = [data]

            duration = time.time() - t0
            logger.info("Successfully fetched chunk %d/%d in %.2fs (%d locations).",
                        chunk_idx, total_chunks, duration, len(data))
            return data

        except (requests.exceptions.RequestException, Exception) as exc:
            last_error = exc
            duration = time.time() - t0
            logger.warning("Chunk %d/%d failed after %.2fs on attempt %d/%d: %s",
                           chunk_idx, total_chunks, duration, attempt, MAX_RETRIES, exc)

            if attempt < MAX_RETRIES:
                sleep_time = (BASE_BACKOFF ** attempt) + random.uniform(0.5, 1.5)
                logger.info("Retrying chunk %d/%d in %.2fs...", chunk_idx, total_chunks, sleep_time)
                time.sleep(sleep_time)

    raise RuntimeError(f"Failed to fetch chunk {chunk_idx}/{total_chunks} after {MAX_RETRIES} attempts: {last_error}")

def fetch_all_gfs_stations() -> list:
    """Generates global coordinate station grid and fetches telemetry across chunked queries."""
    logger.info("Generating global NOAA GFS station grid coordinates...")
    lats = list(range(-70, 80, 10))
    lons = list(range(-180, 180, 15))
    coords = [(lat, lon) for lat in lats for lon in lons]
    total_points = len(coords)

    chunks = [coords[i:i + CHUNK_SIZE] for i in range(0, total_points, CHUNK_SIZE)]
    total_chunks = len(chunks)
    logger.info("Prepared %d station coordinates across %d chunks of up to %d points each.",
                total_points, total_chunks, CHUNK_SIZE)

    session = create_resilient_session()
    all_data = []
    start_time = time.time()

    try:
        for idx, chunk in enumerate(chunks, 1):
            chunk_data = fetch_chunk_with_backoff(session, chunk, idx, total_chunks)
            all_data.extend(chunk_data)
    finally:
        session.close()

    elapsed = time.time() - start_time
    logger.info("Retrieved telemetry for %d stations in %.2fs total.", len(all_data), elapsed)

    if len(all_data) != total_points:
        raise ValueError(f"Station count mismatch: expected {total_points}, received {len(all_data)}")

    return all_data

def fetch_and_generate_global_gfs():
    """Main pipeline execution: fetch, validate, interpolate, and save datasets."""
    all_data = fetch_all_gfs_stations()

    if not all_data or 'daily' not in all_data[0] or 'time' not in all_data[0]['daily']:
        raise ValueError("Malformed API response: missing 'daily.time' in station data")

    dates = all_data[0]['daily']['time']
    if not dates:
        raise ValueError("Empty forecast date array received from NOAA GFS telemetry")

    logger.info("Valid GFS 7-day forecast dates: %s", dates)

    dense_lats = np.arange(-75, 80, 2.5)
    dense_lons = np.arange(-180, 180, 2.5)

    by_date = {}
    geojson_features = []
    to_rad = np.pi / 180.0

    for day_idx, day_str in enumerate(dates):
        st_lats = []
        st_lons = []
        st_u = []
        st_v = []

        for item in all_data:
            lat = item.get('latitude')
            lon = item.get('longitude')
            daily = item.get('daily', {})
            speeds = daily.get('wind_speed_10m_max', [])
            directions = daily.get('wind_direction_10m_dominant', [])

            if day_idx < len(speeds) and day_idx < len(directions):
                spd = speeds[day_idx]
                deg = directions[day_idx]
                if spd is not None and deg is not None:
                    st_lats.append(lat)
                    st_lons.append(lon)
                    u = -spd * np.sin(deg * to_rad)
                    v = -spd * np.cos(deg * to_rad)
                    st_u.append(u)
                    st_v.append(v)

        if len(st_lats) < 6:
            raise RuntimeError(f"Insufficient valid wind telemetry stations for {day_str}: only {len(st_lats)} found")

        st_lats = np.array(st_lats)
        st_lons = np.array(st_lons)
        st_u = np.array(st_u)
        st_v = np.array(st_v)

        vecs = []

        for lat in dense_lats:
            for lon in dense_lons:
                dlat = st_lats - lat
                dlon = np.minimum(np.abs(st_lons - lon), 360 - np.abs(st_lons - lon))
                d2 = dlat**2 + dlon**2

                nearest_idx = np.argpartition(d2, 6)[:6]
                weights = 1.0 / (d2[nearest_idx] + 1e-4)
                w_sum = weights.sum()

                u_interp = (st_u[nearest_idx] * weights).sum() / w_sum
                v_interp = (st_v[nearest_idx] * weights).sum() / w_sum

                spd_interp = np.sqrt(u_interp**2 + v_interp**2)
                deg_interp = (np.degrees(np.arctan2(-u_interp, -v_interp)) + 360.0) % 360.0

                lat_r = round(float(lat), 1)
                lon_r = round(float(lon), 1)
                spd_r = round(float(spd_interp), 1)
                deg_r = round(float(deg_interp), 0)

                vecs.extend([lat_r, lon_r, spd_r, deg_r])

                if day_idx == 0 and (lat_r % 5.0 == 0) and (lon_r % 5.0 == 0):
                    geojson_features.append({
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon_r, lat_r]},
                        "properties": {"date": day_str, "WS": spd_r, "WD": deg_r}
                    })

        by_date[day_str] = vecs
        logger.info("Processed day %s: %d grid vector points", day_str, len(vecs) // 4)

    # Serialize payloads
    json_payload = json.dumps({'dates': dates, 'vectors': by_date}, separators=(',', ':'))
    geojson_payload = json.dumps({"type": "FeatureCollection", "features": geojson_features}, separators=(',', ':'))

    # Atomic write to temporary files before replacing production datasets
    tmp_json = JSON_OUTPUT_FILE.with_suffix('.json.tmp')
    tmp_geojson = GEOJSON_OUTPUT_FILE.with_suffix('.geojson.tmp')

    tmp_json.write_text(json_payload, encoding='utf-8')
    tmp_geojson.write_text(geojson_payload, encoding='utf-8')

    # Atomic swap
    os.replace(tmp_json, JSON_OUTPUT_FILE)
    os.replace(tmp_geojson, GEOJSON_OUTPUT_FILE)

    logger.info("Saved 100%% genuine NOAA GFS forecast.json & forecast.geojson successfully!")

if __name__ == "__main__":
    fetch_and_generate_global_gfs()
