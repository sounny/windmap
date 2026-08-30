from datetime import datetime, timedelta, timezone
from pathlib import Path
import json

import numpy as np
import pandas as pd
import requests
import xarray as xr


NOMADS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
GEOJSON_OUTPUT_FILE = Path("forecast.geojson")
WORK_DIR = Path("gfs_subsets")

NORTH = 50
SOUTH = 12
WEST = 278
EAST = 345

FORECAST_DAYS = 7
FORECAST_STEP_HOURS = 3
CYCLE_HOURS = [18, 12, 6, 0]


def build_request_params(run_date: datetime, cycle_hour: int, forecast_hour: int) -> dict[str, str]:
	return {
		"dir": f"/gfs.{run_date.strftime('%Y%m%d')}/{cycle_hour:02d}/atmos",
		"file": f"gfs.t{cycle_hour:02d}z.pgrb2.0p25.f{forecast_hour:03d}",
		"var_UGRD": "on",
		"var_VGRD": "on",
		"lev_10_m_above_ground": "on",
		"subregion": "",
		"toplat": str(NORTH),
		"leftlon": str(WEST),
		"rightlon": str(EAST),
		"bottomlat": str(SOUTH),
	}


def build_url(params: dict[str, str]) -> str:
	request = requests.Request("GET", NOMADS_FILTER_URL, params=params).prepare()
	return request.url


def response_is_grib(response: requests.Response) -> bool:
	content_type = response.headers.get("Content-Type", "")
	if "text/html" in content_type:
		return False
	if "text/plain" in content_type:
		return False
	return response.status_code == 200


def find_latest_available_cycle() -> tuple[datetime, int]:
	now = datetime.now(timezone.utc)
	for day_offset in range(0, 3):
		run_date = (now - timedelta(days=day_offset)).replace(hour=0, minute=0, second=0, microsecond=0)
		for cycle in CYCLE_HOURS:
			params = build_request_params(run_date, cycle, 0)
			with requests.get(NOMADS_FILTER_URL, params=params, stream=True, timeout=30) as response:
				if response_is_grib(response):
					return run_date, cycle
	raise RuntimeError("No recent GFS 0p25 cycle found on NOMADS. Try again in a few minutes.")


def download_forecast_files(run_date: datetime, cycle_hour: int) -> list[Path]:
	WORK_DIR.mkdir(exist_ok=True)
	forecast_hours = list(range(0, FORECAST_DAYS * 24 + 1, FORECAST_STEP_HOURS))
	downloaded_files: list[Path] = []

	for forecast_hour in forecast_hours:
		params = build_request_params(run_date, cycle_hour, forecast_hour)
		file_name = params["file"] + ".grib2"
		target = WORK_DIR / file_name

		with requests.get(NOMADS_FILTER_URL, params=params, stream=True, timeout=120) as response:
			if not response_is_grib(response):
				print(f"Skipping unavailable file: {params['file']}")
				continue
			with target.open("wb") as file_obj:
				for chunk in response.iter_content(chunk_size=1024 * 1024):
					if chunk:
						file_obj.write(chunk)
		downloaded_files.append(target)
		print(f"Downloaded: {target.name}")

	if not downloaded_files:
		raise RuntimeError("No forecast files were downloaded from NOMADS.")

	return downloaded_files


def get_var_name(dataset: xr.Dataset, candidates: list[str]) -> str:
	for candidate in candidates:
		if candidate in dataset.variables:
			return candidate
	raise RuntimeError(f"Expected one of {candidates} in GRIB data, found {list(dataset.variables)}")


def grib_to_dataframe(grib_files: list[Path]) -> pd.DataFrame:
	try:
		import cfgrib  # noqa: F401
	except ImportError as exc:
		raise RuntimeError(
			"Missing dependency 'cfgrib'. Install with: pip install cfgrib eccodes"
		) from exc

	frames: list[pd.DataFrame] = []
	for grib_file in grib_files:
		ds = xr.open_dataset(
			grib_file,
			engine="cfgrib",
			backend_kwargs={"filter_by_keys": {"typeOfLevel": "heightAboveGround", "level": 10}},
		)
		u_name = get_var_name(ds, ["u10", "10u", "ugrd10m"])
		v_name = get_var_name(ds, ["v10", "10v", "vgrd10m"])

		if "valid_time" in ds:
			valid_time = pd.to_datetime(ds["valid_time"].values)
		elif "time" in ds:
			valid_time = pd.to_datetime(ds["time"].values)
		else:
			raise RuntimeError(f"No valid time coordinate found in {grib_file.name}")

		grid = xr.Dataset({"ugrd10m": ds[u_name], "vgrd10m": ds[v_name]})
		frame = grid.to_dataframe().reset_index()
		if "latitude" not in frame.columns or "longitude" not in frame.columns:
			raise RuntimeError(f"Missing latitude/longitude in {grib_file.name}")
		frame["time"] = valid_time
		frames.append(frame[["time", "latitude", "longitude", "ugrd10m", "vgrd10m"]])
		ds.close()

	if not frames:
		raise RuntimeError("No data frames created from downloaded GRIB files.")

	data = pd.concat(frames, ignore_index=True)
	data = data.dropna(subset=["ugrd10m", "vgrd10m", "latitude", "longitude"])
	data["longitude"] = ((data["longitude"] + 180) % 360) - 180
	data["WS"] = np.sqrt(data["ugrd10m"] ** 2 + data["vgrd10m"] ** 2).round(4)
	data["WD"] = np.degrees(np.arctan2(data["vgrd10m"], data["ugrd10m"])).round(2)
	data["time"] = pd.to_datetime(data["time"])
	data["date_only"] = data["time"].dt.date
	first_seven_dates = sorted(data["date_only"].dropna().unique())[:7]
	filtered = data[
		(data["time"].dt.strftime("%H:%M:%S") == "12:00:00")
		& (data["date_only"].isin(first_seven_dates))
	].copy()
	filtered["time"] = filtered["time"].dt.strftime("%Y-%m-%d %H:%M:%S")
	filtered["date"] = filtered["time"].str.split().str[0]
	filtered = filtered.drop(columns=["date_only"])
	return filtered.sort_values(["time", "latitude", "longitude"]).reset_index(drop=True)


def write_outputs(data: pd.DataFrame) -> None:
	# Downsample to 1.0 deg grid for lightning-fast web delivery (< 400 KB)
	filtered = data[(data["latitude"] % 1.0 == 0) & (data["longitude"] % 1.0 == 0)].copy()
	if filtered.empty:
		filtered = data

	features = []
	by_date = {}
	for row in filtered.itertuples(index=False):
		d = str(row.date)
		if d not in by_date:
			by_date[d] = []
		by_date[d].extend([round(float(row.latitude), 2), round(float(row.longitude), 2), round(float(row.WS), 1), round(float(row.WD), 1)])
		features.append(
			{
				"type": "Feature",
				"geometry": {
					"type": "Point",
					"coordinates": [round(float(row.longitude), 2), round(float(row.latitude), 2)],
				},
				"properties": {
					"date": d,
					"WS": round(float(row.WS), 1),
					"WD": round(float(row.WD), 1),
				},
			}
		)

	geojson = {"type": "FeatureCollection", "features": features}
	GEOJSON_OUTPUT_FILE.write_text(json.dumps(geojson, separators=(',', ':')))
	Path("forecast.json").write_text(json.dumps({"dates": sorted(by_date.keys()), "vectors": by_date}, separators=(',', ':')))


def main() -> None:
	run_date, cycle_hour = find_latest_available_cycle()
	print(f"Using GFS cycle: {run_date.strftime('%Y-%m-%d')} {cycle_hour:02d}Z")

	files = download_forecast_files(run_date, cycle_hour)
	data = grib_to_dataframe(files)
	write_outputs(data)
	print(f"Saved: {GEOJSON_OUTPUT_FILE.resolve()}")


if __name__ == "__main__":
	main()


