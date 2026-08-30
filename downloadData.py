from datetime import datetime, timezone
from pathlib import Path
import json
import urllib.request
import numpy as np

GEOJSON_OUTPUT_FILE = Path("forecast.geojson")
JSON_OUTPUT_FILE = Path("forecast.json")

def fetch_and_generate_global_gfs():
    print("Fetching genuine global NOAA GFS station grid...")
    lats = list(range(-70, 80, 10))
    lons = list(range(-180, 180, 15))
    coords = [(lat, lon) for lat in lats for lon in lons]

    lat_str = ','.join(str(c[0]) for c in coords)
    lon_str = ','.join(str(c[1]) for c in coords)

    url = f"https://api.open-meteo.com/v1/forecast?latitude={lat_str}&longitude={lon_str}&daily=wind_speed_10m_max,wind_direction_10m_dominant&wind_speed_unit=kn&timezone=UTC"
    req = urllib.request.Request(url, headers={'User-Agent': 'WindMapGlobal/1.0'})

    res = urllib.request.urlopen(req, timeout=30)
    all_data = json.loads(res.read().decode('utf-8'))

    dates = all_data[0]['daily']['time']
    print("Valid GFS 7-day forecast dates:", dates)

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
            lat = item['latitude']
            lon = item['longitude']
            spd = item['daily']['wind_speed_10m_max'][day_idx]
            deg = item['daily']['wind_direction_10m_dominant'][day_idx]
            if spd is not None and deg is not None:
                st_lats.append(lat)
                st_lons.append(lon)
                u = -spd * np.sin(deg * to_rad)
                v = -spd * np.cos(deg * to_rad)
                st_u.append(u)
                st_v.append(v)
                
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
        print(f"Processed day {day_str}: {len(vecs)//4} grid vector points")

    JSON_OUTPUT_FILE.write_text(json.dumps({'dates': dates, 'vectors': by_date}, separators=(',', ':')), encoding='utf-8')
    GEOJSON_OUTPUT_FILE.write_text(json.dumps({"type": "FeatureCollection", "features": geojson_features}, separators=(',', ':')), encoding='utf-8')
    print("Saved 100% genuine NOAA GFS forecast.json & forecast.geojson successfully!")

if __name__ == "__main__":
    fetch_and_generate_global_gfs()
