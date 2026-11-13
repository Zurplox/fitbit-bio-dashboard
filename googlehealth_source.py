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

    def rollup(self, data_type, start, end, window):
        return self.request(
            "POST",
            f"/users/me/dataTypes/{data_type}/dataPoints:rollUp",
            body={
                "range": {
                    "startTime": f"{start}T00:00:00Z",
                    "endTime": f"{end}T23:59:59Z",
                },
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
        if isinstance(value, dict):
            for inner_key, inner_value in value.items():
                lowered = inner_key.lower()
                if lowered.endswith(("sum", "avg", "average", "count")):
                    number = _num(inner_value)
                    if number is not None:
                        return number
            for inner_value in value.values():
                number = _num(inner_value)
                if number is not None:
                    return number
        else:
            number = _num(value)
            if number is not None:
                return number
    return None


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
    profile = {"height_cm": None, "weight_kg": None}

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
        values = [
            _num((p.get("weight") or {}).get("weightGrams"))
            for p in weights
            if (p.get("weight") or {}).get("weightGrams") is not None
        ]
        values = [v for v in values if v]
        if values:
            profile["weight_kg"] = round(values[0] / 1000, 1)  # newest first
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


def _daily_series(client, data_type, field, days, extractor, dq, label, note_unit):
    points = client.list_points(data_type, max_pages=max(3, days // 20))
    records = []
    for point in points:
        day = _civil(point.get("date"))
        if not day:
            continue
        value = extractor(point.get(field) or {})
        if value is None:
            continue
        records.append({"date": day, "value": value})
    ordered = _chronological(records)
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
    start = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:00:00")
    end = now.strftime("%Y-%m-%dT%H:59:59")
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
