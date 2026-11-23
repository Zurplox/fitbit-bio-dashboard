"""
The only module that talks to the health API.

Fitbit's own Web API was switched off on 2 November 2026 and now answers
`410 Gone`; every Fitbit account is reached through the Google Health API
(`health.googleapis.com/v4`) with Google OAuth 2.0. This module owns that
conversation: token refresh, pagination, chunked aggregation, and parsing into
plain records. It records live-vs-missing provenance as it goes and never
substitutes a value it did not receive.

Two constraints from the API shape everything here:

* `list` pages are capped at 25 points, so daily series are paged and long
  ranges are fetched by date filter rather than by walking every day.
* rollup ranges are capped (14 days for heart rate, calories and active
  minutes; 90 days for the rest), so aggregation is chunked and stitched.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

BASE_URL = "https://health.googleapis.com/v4"
TOKEN_URL = "https://oauth2.googleapis.com/token"

SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.profile.readonly",
]

# Rollup range ceilings, from the aggregate-data guide.
ROLLUP_MAX_DAYS = {
    "heart-rate": 14,
    "total-calories": 14,
    "active-minutes": 14,
}
ROLLUP_MAX_DAYS_DEFAULT = 90

LIST_PAGE_SIZE = 25  # the API's documented maximum

# `dataPoints.list` has no documented sort direction, so a daily series is
# read to the end and then windowed by date. 60 pages is 1,500 points — over
# four years of a once-a-day type before this binds.
LIST_PAGE_CEILING = 60


class AuthError(RuntimeError):
    """Configuration or token problems. Always fatal: nothing can be fetched."""


def local_today():
    tz = ZoneInfo(os.environ.get("DASHBOARD_TZ", "Asia/Singapore"))
    return datetime.now(tz).date()


def _civil(obj):
    """{'date': {'year':..}} -> 'YYYY-MM-DD'. Tolerates a bare string."""
    if not obj:
        return None
    if isinstance(obj, str):
        return obj[:10]
    if "year" in obj:
        return f"{int(obj['year']):04d}-{int(obj['month']):02d}-{int(obj['day']):02d}"
    inner = obj.get("date")
    if inner:
        return _civil(inner)
    return None


def _civil_from_iso(iso_timestamp, offset_seconds=0):
    """The local calendar date of a timestamp, using its recorded offset."""
    if not iso_timestamp:
        return None
    try:
        moment = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    local = moment + timedelta(seconds=offset_seconds or 0)
    return local.date().isoformat()


def _seconds(duration):
    """'28800s' -> 28800. Accepts numbers and None."""
    if duration is None:
        return 0
    if isinstance(duration, (int, float)):
        return int(duration)
    text = str(duration).strip().rstrip("s")
    try:
        return int(float(text))
    except ValueError:
        return 0


def _num(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _chronological(records, key="date"):
    return sorted((r for r in records if r.get(key)), key=lambda r: r[key])


def _chunks(start, end, max_days):
    """Closed date ranges of at most `max_days`, oldest first."""
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=max_days - 1), end)
        yield cursor, chunk_end
        cursor = chunk_end + timedelta(days=1)


class GoogleHealthClient:
    def __init__(self, client_id=None, client_secret=None, refresh_token=None, timeout=45):
        self.client_id = client_id or os.environ.get("GOOGLE_HEALTH_CLIENT_ID")
        self.client_secret = client_secret or os.environ.get("GOOGLE_HEALTH_CLIENT_SECRET")
        self.refresh_token = refresh_token or os.environ.get("GOOGLE_HEALTH_REFRESH_TOKEN")
        self.timeout = timeout
        self._access_token = None
        self._expires_at = 0.0

    # -- auth ---------------------------------------------------------------
    def _require_credentials(self):
        missing = [
            name
            for name, value in (
                ("GOOGLE_HEALTH_CLIENT_ID", self.client_id),
                ("GOOGLE_HEALTH_CLIENT_SECRET", self.client_secret),
                ("GOOGLE_HEALTH_REFRESH_TOKEN", self.refresh_token),
            )
            if not value
        ]
        if missing:
            raise AuthError(
                "Missing credential(s): "
                + ", ".join(missing)
                + ". Run `python scripts/authorize.py` once to create a refresh token, "
                "then set the three variables."
            )

    def access_token(self, force=False):
        self._require_credentials()
        if not force and self._access_token and time.time() < self._expires_at - 60:
            return self._access_token

        body = urllib.parse.urlencode(
            {
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": self.refresh_token,
                "grant_type": "refresh_token",
            }
        ).encode()
        request = urllib.request.Request(
            TOKEN_URL,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            hint = ""
            if "invalid_grant" in detail:
                hint = (
                    "\nThe refresh token was rejected. While the OAuth consent screen is in "
                    "Testing mode Google expires refresh tokens after 7 days — re-run "
                    "`python scripts/authorize.py` (or publish the app) and update the secret."
                )
            raise AuthError(f"Token refresh failed ({error.code}): {detail}{hint}") from error
        except urllib.error.URLError as error:
            raise AuthError(f"Could not reach Google's token endpoint: {error.reason}") from error

        self._access_token = payload.get("access_token")
        if not self._access_token:
            raise AuthError(f"Token endpoint returned no access_token: {payload}")
        self._expires_at = time.time() + float(payload.get("expires_in", 3600))
        return self._access_token

    # -- transport ----------------------------------------------------------
    def request(self, method, path, params=None, body=None):
        url = f"{BASE_URL}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None

        last_error = None
        for attempt in range(4):
            headers = {
                "Authorization": f"Bearer {self.access_token(force=attempt > 0 and last_error == 401)}",
                "Accept": "application/json",
            }
            if data is not None:
                headers["Content-Type"] = "application/json"
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")
                last_error = error.code
                if error.code == 401 and attempt == 0:
                    continue
                if error.code == 429 or 500 <= error.code < 600:
                    time.sleep(1.5 ** attempt)
                    continue
                if error.code == 403 and "scope" in detail.lower():
                    raise AuthError(
                        "The token is missing a scope this dashboard needs. Required:\n  "
                        + "\n  ".join(SCOPES)
                        + f"\nAPI said: {detail}"
                    ) from error
                if error.code == 400 and "ACCOUNT_NOT_LINKED" in detail:
                    raise AuthError(
                        "This Google account is not linked to Google Health. Open the Google "
                        "Health app on your phone, sign in with the same account and complete "
                        "the Fitbit migration, then re-run."
                    ) from error
                raise RuntimeError(f"{method} {path} failed ({error.code}): {detail}") from error
            except urllib.error.URLError as error:
                last_error = error.reason
                time.sleep(1.5 ** attempt)
        raise RuntimeError(f"{method} {path} failed after retries: {last_error}")

    # -- endpoints ----------------------------------------------------------
    def identity(self):
        return self.request("GET", "/users/me/identity")

    def profile(self):
        return self.request("GET", "/users/me/profile")

    def list_points(self, data_type, filter_expr=None, max_pages=12, page_size=LIST_PAGE_SIZE):
        """Page through `dataPoints`. Pages are capped at 25 by the API."""
        points = []
        token = None
        for _ in range(max_pages):
            params = {"page_size": page_size}
            if filter_expr:
                params["filter"] = filter_expr
            if token:
                params["page_token"] = token
            payload = self.request("GET", f"/users/me/dataTypes/{data_type}/dataPoints", params)
            points.extend(payload.get("dataPoints") or [])
            token = payload.get("nextPageToken")
            if not token:
                break
            time.sleep(0.1)
        return points

    def rollup(self, data_type, start_iso, end_iso, window):
        """Aggregate over physical time. Both bounds are full RFC3339 stamps."""
        return self.request(
            "POST",
            f"/users/me/dataTypes/{data_type}/dataPoints:rollUp",
            body={
                "range": {"startTime": start_iso, "endTime": end_iso},
                "windowSize": window,
            },
        )

    def daily_rollup(self, data_type, start, end):
        return self.request(
            "POST",
            f"/users/me/dataTypes/{data_type}/dataPoints:dailyRollUp",
            body={
                "range": {
                    "start": {"date": _date_obj(start), "time": {}},
                    "end": {
                        "date": _date_obj(end),
                        "time": {"hours": 23, "minutes": 59, "seconds": 59},
                    },
                },
                "windowSizeDays": 1,
            },
        )


def _date_obj(day):
    return {"year": day.year, "month": day.month, "day": day.day}


def _rollup_value(point, data_type):
    """Pull the summed number out of a rollup point.

    The API nests the value under the data type's own field (`steps.countSum`,
    `totalCalories.caloriesKcalSum`, ...). Rather than hard-code a field name per
    type, this reads any additive key inside that field, and only falls back to
    scanning the whole point when the field is absent.
    """
    field = data_type.replace("-", " ").title().replace(" ", "").lower()
    candidates = []
    for key, value in point.items():
        if key in ("startTime", "endTime", "civilStartTime", "civilEndTime"):
            continue
        if key.lower() == field or key.lower().startswith(field[:6]):
            candidates.append(value)
    if not candidates:
        candidates = [
            v
            for k, v in point.items()
            if k not in ("startTime", "endTime", "civilStartTime", "civilEndTime")
        ]

    for value in candidates:
        number = _find_number(value)
        if number is not None:
            return number
    return None


def _find_number(value):
    """Depth-first search for the first additive number in a rollup value.

    Rollups nest differently per data type — `{"countSum": "8430"}`,
    `{"activeMinutesByActivityLevel": [{"activeMinutes": "31"}]}` — so the
    shape is walked rather than guessed, with sum/average keys preferred.
    """
    if isinstance(value, dict):
        for key, inner in value.items():
            if key.lower().endswith(("sum", "avg", "average", "count")):
                number = _num(inner)
                if number is not None:
                    return number
        for inner in value.values():
            number = _find_number(inner)
            if number is not None:
                return number
        return None
    if isinstance(value, list):
        for item in value:
            number = _find_number(item)
            if number is not None:
                return number
        return None
    return _num(value)


def _point_date(point):
    return (
        _civil(point.get("civilStartTime"))
        or _civil(point.get("civilEndTime"))
        or _civil_from_iso(point.get("startTime"))
        or _civil_from_iso(point.get("endTime"))
    )


# --------------------------------------------------------------------------
# Fetchers. Each records provenance; none of them invents a value.
# --------------------------------------------------------------------------
def fetch_identity(client, dq=None):
    payload = client.identity()
    user_id = payload.get("healthUserId") or payload.get("health_user_id") or payload.get("name")
    if dq:
        dq.record("identity", bool(user_id), f"health user {user_id}" if user_id else "no identity", "Account")
    return {"health_user_id": user_id}


def fetch_profile(client, dq=None):
    """Height and weight, when the account has them. Absent stays absent."""
    profile = {"height_cm": None, "weight_kg": None, "age": None}

    try:
        # Age only: it picks the step range Paluch 2022 reported for the age
        # group. The API exposes no sex, so nothing sex-specific is derived.
        age = _num(((client.profile() or {}).get("age")))
        profile["age"] = int(age) if age else None
    except Exception as error:  # noqa: BLE001 - optional
        print(f"   profile age unavailable: {error}")

    try:
        heights = client.list_points("height", max_pages=2)
        for point in heights:
            value = (point.get("height") or {}).get("heightMeters")
            if value is not None:
                profile["height_cm"] = round(float(value) * 100, 1)
    except Exception as error:  # noqa: BLE001 - a missing height is not fatal
        print(f"   height unavailable: {error}")

    try:
        weights = client.list_points("weight", max_pages=3)
        dated = []
        for point in weights:
            body = point.get("weight") or {}
            grams = _num(body.get("weightGrams"))
            sample = body.get("sampleTime") or {}
            stamp = sample.get("physicalTime") or _civil(sample.get("civilTime")) or ""
            if grams:
                dated.append((stamp, grams))
        if dated:
            # Ordering is not promised by the API; take the newest by timestamp.
            dated.sort(key=lambda item: item[0])
            profile["weight_kg"] = round(dated[-1][1] / 1000, 1)
    except Exception as error:  # noqa: BLE001
        print(f"   weight unavailable: {error}")

    if dq:
        dq.record(
            "profile",
            profile["height_cm"] is not None or profile["weight_kg"] is not None,
            "height/weight from profile" if profile["height_cm"] else "no body metrics in profile",
            "Body metrics",
        )
    return profile


def fetch_sleep(client, days=90, dq=None):
    """Main sleep sessions, newest last, with stages and local clock times."""
    today = local_today()
    since = today - timedelta(days=days)
    points = client.list_points(
        "sleep",
        filter_expr=f'sleep.interval.civil_end_time >= "{since.isoformat()}"',
        max_pages=max(4, days // 20),
    )

    nights = []
    for point in points:
        sleep = point.get("sleep") or {}
        interval = sleep.get("interval") or {}
        summary = sleep.get("summary") or {}
        metadata = sleep.get("metadata") or {}

        in_period = _num(summary.get("minutesInSleepPeriod"))
        asleep = _num(summary.get("minutesAsleep"))
        if asleep is None and in_period is None:
            continue

        stage_minutes = {}
        for stage in summary.get("stagesSummary") or []:
            key = str(stage.get("type") or "").upper()
            minutes = _num(stage.get("minutes"))
            if key and minutes is not None:
                stage_minutes[key] = minutes

        start_offset = _seconds(interval.get("startUtcOffset"))
        end_offset = _seconds(interval.get("endUtcOffset"))
        day = (
            _civil((interval.get("civilEndTime") or {}))
            or _civil_from_iso(interval.get("endTime"), end_offset)
        )
        if not day:
            continue

        nights.append(
            {
                "date": day,
                "minutes_asleep": round(asleep) if asleep is not None else None,
                "minutes_in_period": round(in_period) if in_period is not None else None,
                "minutes_awake": round(_num(summary.get("minutesAwake")))
                if summary.get("minutesAwake") is not None
                else None,
                "minutes_to_fall_asleep": round(_num(summary.get("minutesToFallAsleep")))
                if summary.get("minutesToFallAsleep") is not None
                else None,
                "stages": {k.lower(): round(v) for k, v in stage_minutes.items()} or None,
                "onset_minutes": _local_minutes(interval.get("startTime"), start_offset),
                "wake_minutes": _local_minutes(interval.get("endTime"), end_offset),
                "is_main": bool(metadata.get("mainSleep", True)),
                "nap": bool(metadata.get("nap", False)),
                "device": ((point.get("dataSource") or {}).get("device") or {}).get("displayName"),
            }
        )

    # One record per night: keep the main sleep of each date, longest if the
    # device marked none as main.
    by_date = {}
    for night in nights:
        existing = by_date.get(night["date"])
        if existing is None:
            by_date[night["date"]] = night
        elif night["is_main"] and not existing["is_main"]:
            by_date[night["date"]] = night
        elif (night.get("minutes_asleep") or 0) > (existing.get("minutes_asleep") or 0) and not existing["is_main"]:
            by_date[night["date"]] = night

    ordered = _chronological(list(by_date.values()))
    if dq:
        dq.record(
            "sleep",
            bool(ordered),
            f"{len(ordered)} nights" if ordered else "no sleep sessions returned",
            "Sleep",
        )
    return ordered


def _local_minutes(iso_timestamp, offset_seconds):
    if not iso_timestamp:
        return None
    try:
        moment = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    local = moment + timedelta(seconds=offset_seconds or 0)
    return local.hour * 60 + local.minute


def _key_paths(obj, prefix="", depth=0):
    """Field names only, never values: enough to see where a payload diverges."""
    if depth > 2:
        return []
    if isinstance(obj, dict):
        paths = []
        for key, value in obj.items():
            here = f"{prefix}.{key}" if prefix else key
            if isinstance(value, (dict, list)):
                paths.extend(_key_paths(value, here, depth + 1))
            else:
                paths.append(here)
        return paths
    if isinstance(obj, list) and obj:
        return _key_paths(obj[0], f"{prefix}[]", depth + 1)
    return []


def _daily_series(client, data_type, field, days, extractor, dq, label, note_unit):
    points = client.list_points(data_type, max_pages=LIST_PAGE_CEILING)
    records = []
    for point in points:
        # The civil date travels inside the type's own body
        # (`dailyRestingHeartRate.date`), not beside it.
        body = point.get(field) or {}
        day = _civil(body.get("date"))
        if not day:
            continue
        value = extractor(body)
        if value is None:
            continue
        records.append({"date": day, "value": value})
    # Sorted by date, then windowed: an unfiltered read would otherwise hand the
    # dashboard the oldest N readings and label the last one "today", whichever
    # order the pages happen to arrive in.
    ordered = _chronological(records)[-days:]

    # Zero rows out of a 200 is the one failure mode that looks like a quiet
    # account. Name the fields the API did send, so the shape is diagnosable
    # from the log without printing a measurement.
    if not ordered:
        fields = ", ".join(_key_paths(points[0])) if points else "no data points"
        print(f"   {data_type}: 0 usable of {len(points)} - fields: {fields[:400]}")

    if dq:
        dq.record(label[0], bool(ordered), f"{len(ordered)} {note_unit}" if ordered else "none returned", label[1])
    return ordered


def fetch_daily_rhr(client, days=90, dq=None):
    return _daily_series(
        client,
        "daily-resting-heart-rate",
        "dailyRestingHeartRate",
        days,
        lambda body: _num(body.get("beatsPerMinute")),
        dq,
        ("rhr", "Resting heart rate"),
        "daily readings",
    )


def fetch_daily_hrv(client, days=90, dq=None):
    return _daily_series(
        client,
        "daily-heart-rate-variability",
        "dailyHeartRateVariability",
        days,
        lambda body: _num(body.get("averageHeartRateVariabilityMilliseconds")),
        dq,
        ("hrv", "Overnight HRV"),
        "nightly summaries",
    )


def fetch_daily_spo2(client, days=90, dq=None):
    return _daily_series(
        client,
        "daily-oxygen-saturation",
        "dailyOxygenSaturation",
        days,
        lambda body: _num(body.get("averagePercentage")),
        dq,
        ("spo2", "Blood oxygen"),
        "nights recorded",
    )


def fetch_daily_resp(client, days=90, dq=None):
    return _daily_series(
        client,
        "daily-respiratory-rate",
        "dailyRespiratoryRate",
        days,
        lambda body: _num(body.get("breathsPerMinute")),
        dq,
        ("resp", "Breathing rate"),
        "nights recorded",
    )


def fetch_daily_vo2max(client, days=90, dq=None):
    return _daily_series(
        client,
        "daily-vo2-max",
        "dailyVo2Max",
        days,
        lambda body: _num(body.get("vo2Max")),
        dq,
        ("vo2max", "Cardio fitness"),
        "readings",
    )


def _zone_minutes(durations):
    """Minutes per heart-rate zone from an exercise summary, or None if absent."""
    if not durations:
        return None
    zones = {
        zone: round(_seconds(durations.get(f"{zone}Time")) / 60, 1)
        for zone in ("light", "moderate", "vigorous", "peak")
    }
    return zones if any(zones.values()) else None


def _skin_temp_delta(body):
    # Only a deviation against the device's own 30-night baseline is published;
    # an absolute skin temperature means little and a missing baseline means
    # there is nothing honest to compare against.
    nightly = _num(body.get("nightlyTemperatureCelsius"))
    baseline = _num(body.get("baselineTemperatureCelsius"))
    if nightly is None or baseline is None:
        return None
    return round(nightly - baseline, 2)


def fetch_daily_skin_temp(client, days=90, dq=None):
    return _daily_series(
        client,
        "daily-sleep-temperature-derivations",
        "dailySleepTemperatureDerivations",
        days,
        _skin_temp_delta,
        dq,
        ("skin_temp", "Skin temperature"),
        "nights recorded",
    )


def _rollup_series(client, data_type, days, dq, label, note_unit, today=None):
    today = today or local_today()
    start = today - timedelta(days=days - 1)
    max_days = ROLLUP_MAX_DAYS.get(data_type, ROLLUP_MAX_DAYS_DEFAULT)

    collected = {}
    for chunk_start, chunk_end in _chunks(start, today, max_days):
        payload = client.daily_rollup(data_type, chunk_start, chunk_end)
        for point in payload.get("rollupDataPoints") or []:
            day = _point_date(point)
            value = _rollup_value(point, data_type)
            if day and value is not None:
                collected[day] = round(value, 1)
        time.sleep(0.2)

    series = [{"date": d, "value": collected[d]} for d in sorted(collected)]
    if dq:
        dq.record(label[0], bool(series), f"{len(series)} days" if series else "none returned", label[1])
    return series


def fetch_daily_steps(client, days=90, dq=None):
    return _rollup_series(client, "steps", days, dq, ("steps", "Steps"), "days")


def fetch_daily_calories(client, days=90, dq=None):
    return _rollup_series(client, "total-calories", days, dq, ("calories", "Calories"), "days")


def fetch_daily_active_minutes(client, days=90, dq=None):
    return _rollup_series(
        client, "active-minutes", days, dq, ("active_minutes", "Active minutes"), "days"
    )


def fetch_exercise(client, days=90, dq=None):
    today = local_today()
    since = today - timedelta(days=days)
    # Filter on civil time: the physical `start_time` member is rejected by the
    # API for this data type, and only the civil members are documented as
    # filterable on interval types.
    points = client.list_points(
        "exercise",
        filter_expr=f'exercise.interval.civil_start_time >= "{since.isoformat()}"',
        max_pages=max(4, days // 15),
    )

    sessions = []
    for point in points:
        exercise = point.get("exercise") or {}
        interval = exercise.get("interval") or {}
        metrics = exercise.get("metricsSummary") or {}
        start = interval.get("startTime")
        end = interval.get("endTime")
        minutes = None
        if start and end:
            try:
                started = datetime.fromisoformat(start.replace("Z", "+00:00"))
                finished = datetime.fromisoformat(end.replace("Z", "+00:00"))
                minutes = round((finished - started).total_seconds() / 60)
            except ValueError:
                minutes = None
        if minutes is None:
            minutes = round(_seconds(exercise.get("activeDuration")) / 60) or None

        sessions.append(
            {
                "date": _civil(interval.get("civilStartTime"))
                or _civil_from_iso(start, _seconds(interval.get("startUtcOffset"))),
                "start": start,
                "minutes": minutes,
                "type": str(exercise.get("exerciseType") or "OTHER").lower(),
                "name": exercise.get("displayName") or str(exercise.get("exerciseType") or "Session").title(),
                "calories": _num(metrics.get("caloriesKcal")),
                "avg_hr": _num(metrics.get("averageHeartRateBeatsPerMinute")),
                "steps": _num(metrics.get("steps")),
                "distance_m": round(_num(metrics.get("distanceMillimeters")) / 1000)
                if metrics.get("distanceMillimeters") is not None
                else None,
                "active_zone_minutes": _num(metrics.get("activeZoneMinutes")),
                "zones": _zone_minutes(metrics.get("heartRateZoneDurations")),
                "elevation_m": round(_num(metrics.get("elevationGainMillimeters")) / 1000)
                if metrics.get("elevationGainMillimeters") is not None
                else None,
                "run_vo2max": _num(metrics.get("runVo2Max")),
            }
        )

    ordered = _chronological(sessions)
    if dq:
        dq.record(
            "exercise",
            bool(ordered),
            f"{len(ordered)} sessions" if ordered else "no sessions logged",
            "Workouts",
        )
    return ordered


def fetch_intraday_hr(client, hours=24, dq=None):
    """Hourly heart rate for the last day, from the aggregation endpoint."""
    now = datetime.now(timezone.utc)
    start = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:00:00Z")
    end = now.strftime("%Y-%m-%dT%H:59:59Z")
    payload = client.rollup("heart-rate", start, end, "3600s")

    series = []
    for point in payload.get("rollupDataPoints") or []:
        stamp = point.get("startTime")
        value = _rollup_value(point, "heart-rate")
        if stamp and value is not None:
            series.append({"t": stamp, "bpm": round(value)})
    series.sort(key=lambda r: r["t"])

    if dq:
        dq.record(
            "heart_rate",
            bool(series),
            f"{len(series)} hourly averages" if series else "no intraday samples",
            "Heart rate",
        )
    return series


def authenticated_client():
    """A client with a verified token, or a clear failure."""
    client = GoogleHealthClient()
    client.access_token()  # raises AuthError with instructions when misconfigured
    return client


# ---------------------------------------------------------------- attribution --
# Every data point carries the app and device that produced it. Fitbit writes
# under platform FITBIT; anything Health Connect relays — Garmin, Google Fit, the
# phone's own step counter — arrives under HEALTH_CONNECT. The dashboard reads
# those points as one series, so without this a Garmin night and a Fitbit night
# are the same night.
SOURCE_APPS = {
    "com.garmin.android.apps.connectmobile": "Garmin Connect",
    "com.google.android.apps.fitness": "Google Fit",
    "com.android.healthconnect.phone": "Android phone",
    "com.fitbit.FitbitMobile": "Fitbit app",
}

SOURCE_METRICS = [
    ("sleep", "sleep", "Sleep"),
    ("steps", "steps", "Steps"),
    ("daily-resting-heart-rate", "rhr", "Resting heart rate"),
    ("daily-heart-rate-variability", "hrv", "Overnight HRV"),
    ("daily-oxygen-saturation", "spo2", "Blood oxygen"),
    ("daily-respiratory-rate", "resp", "Breathing rate"),
    ("active-minutes", "active_minutes", "Active minutes"),
    ("exercise", "exercise", "Workouts"),
    ("heart-rate", "heart_rate", "Heart rate"),
    ("daily-vo2-max", "vo2max", "Cardio fitness"),
]


def source_of(point):
    """(label, platform) for one data point."""
    data_source = point.get("dataSource") or {}
    device = data_source.get("device") or {}
    application = data_source.get("application") or {}
    platform = data_source.get("platform") or "UNKNOWN"

    name = device.get("displayName")
    if name:
        return name, platform

    package = (application.get("packageName") or "").strip()
    if package in SOURCE_APPS:
        return SOURCE_APPS[package], platform

    maker = device.get("manufacturer")
    form = (device.get("formFactor") or "").replace("_", " ").lower()
    if maker:
        return " ".join(part for part in (maker, form) if part).strip(), platform
    if package:
        return package.rsplit(".", 1)[-1].replace("_", " ").title(), platform
    return "Unknown source", platform


def steps_sources(entries):
    """Step attribution after removing foreign pedometers.

    Steps are read from Google Health's own daily rollup, which merges the Air
    with the phone's counter into one deduplicated total. A Garmin step count
    is a different device measuring the same walk, so it is never credited
    here even if it is later ingested through Health Connect.
    """
    return [entry for entry in entries if "garmin" not in entry["label"].lower()]


def fetch_sources(client, days=90, sample_pages=3):
    """Which app or device produced each metric.

    The counts are a sample of the most recent points, not the full window, so
    they are published as `sampled` rather than dressed up as a census. A data
    type that refuses the list call simply has no attribution, and the page
    then says nothing rather than guessing.
    """
    metrics = {}
    devices = {}

    for data_type, key, label in SOURCE_METRICS:
        try:
            points = client.list_points(data_type, max_pages=sample_pages)
        except Exception:  # noqa: BLE001 - a footnote must not fail a sync
            continue

        counts = {}
        for point in points:
            counts[source_of(point)] = counts.get(source_of(point), 0) + 1
        if not counts:
            continue

        ordered = sorted(counts.items(), key=lambda item: -item[1])
        total = sum(counts.values())
        entries = [
            {"label": name, "platform": platform, "points": count}
            for (name, platform), count in ordered
        ]
        if key == "steps":
            entries = steps_sources(entries)
            if not entries:
                continue
        metrics[key] = {
            "label": label,
            "dominant": entries[0]["label"],
            "share": round(entries[0]["points"] / total, 2),
            "sources": entries,
            "sampled": total,
        }
        for entry in entries:
            # A source with no name is not something a reader can act on, so it
            # stays out of the device list while remaining in the tooltip.
            if entry["label"] == "Unknown source":
                continue
            bucket = devices.setdefault(
                entry["label"],
                {
                    "label": entry["label"],
                    "platform": entry["platform"],
                    "points": 0,
                    "metrics": [],
                },
            )
            bucket["points"] += entry["points"]
            if label not in bucket["metrics"]:
                bucket["metrics"].append(label)

    return {
        "metrics": metrics,
        "devices": sorted(devices.values(), key=lambda d: -d["points"]),
    }
