"""
All arithmetic, no meaning.

Pure functions: values in, values out. No I/O, no environment, no provenance,
no colours. Every threshold this module needs is asked of `bio_policy`, so a
number that means something is defined once.

The recurring rule: an absent measurement stays `None` all the way to the page,
which renders it as `--`. Nothing here invents a plausible value.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import bio_policy as policy


# --------------------------------------------------------------------------
# Small numeric helpers
# --------------------------------------------------------------------------
def clamp(value, low=0.0, high=1.0):
    if value is None:
        return None
    return max(low, min(high, value))


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def median(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    return (values[mid - 1] + values[mid]) / 2


def pct_change(current, reference):
    if current is None or reference in (None, 0):
        return None
    return round((current - reference) / reference * 100, 1)


def latest(records, key="date"):
    """The record with the greatest `key` — never `list[-1]`.

    Endpoints do not promise ordering, and a positional assumption once made a
    "last 7 nights" window average the oldest week of the fetch.
    """
    valid = [r for r in records if r.get(key)]
    return max(valid, key=lambda r: r[key]) if valid else None


def window(records, key, days, end=None):
    """The last `days` records ending at `end`, sorted ascending by `key`."""
    if not records:
        return []
    ordered = sorted((r for r in records if r.get(key)), key=lambda r: r[key])
    if end is not None:
        ordered = [r for r in ordered if r[key] <= end]
    return ordered[-days:] if days else ordered


def _parse_date(value):
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def minutes_after_midnight(iso_timestamp, utc_offset_seconds=0):
    """Local clock minutes for an RFC3339 timestamp plus its recorded offset.

    The API ships `startUtcOffset` (e.g. "28800s" for UTC+8) beside the UTC
    timestamp. The *recorded* offset is used, never the machine's own timezone,
    so a sync running in CI produces the athlete's clock rather than UTC's.
    """
    if not iso_timestamp:
        return None
    try:
        moment = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    offset = timedelta(seconds=utc_offset_seconds or 0)
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    local = moment + offset
    return local.hour * 60 + local.minute


# --------------------------------------------------------------------------
# Sleep
# --------------------------------------------------------------------------
def summarise_night(record):
    """Normalise one API sleep session into the shape the rest of the code reads.

    All durations are minutes. `stages` holds the four stage names Fitbit
    reports; a night without stages keeps `None` there rather than zeros,
    because "no stage data" and "zero deep sleep" are different claims.
    """
    if not record:
        return None
    asleep = record.get("minutes_asleep")
    in_bed = record.get("minutes_in_period")
    if asleep is None and in_bed is None:
        return None

    # Stage names arrive uppercase from the API and lowercase from the demo
    # generator; normalise the keys rather than silently returning empty stages.
    raw_stages = record.get("stages") or {}
    stages_summary = {str(k).upper(): v for k, v in raw_stages.items()}
    if stages_summary:
        stages = {
            "deep": stages_summary.get("DEEP"),
            "light": stages_summary.get("LIGHT"),
            "rem": stages_summary.get("REM"),
            "awake": stages_summary.get("AWAKE"),
        }
    else:
        stages = {"deep": None, "light": None, "rem": None, "awake": None}

    efficiency = None
    if asleep is not None and in_bed:
        efficiency = round(100 * asleep / in_bed, 1)

    onset = record.get("onset_minutes")
    wake = record.get("wake_minutes")

    return {
        "date": record.get("date"),
        "bed_minutes": onset,
        "wake_minutes": wake,
        "minutes_in_period": in_bed,
        "minutes_asleep": asleep,
        "minutes_awake": record.get("minutes_awake"),
        "efficiency": efficiency,
        "stages": stages,
        "is_main": record.get("is_main", True),
        "device": record.get("device"),
    }


def sleep_score(night, need_minutes=None):
    """0-100: 55% duration against need, 30% efficiency, 15% stage balance.

    Monotone in both duration and efficiency by construction, which is the
    property the tests pin: more sleep can never lower the score.
    """
    if not night or night.get("minutes_asleep") is None:
        return None
    need = need_minutes or policy.SLEEP_NEED_BASE_MINUTES

    duration_ratio = clamp((night["minutes_asleep"] / need) / 1.1)
    duration_points = duration_ratio * 55

    # A component that was not measured is dropped and its weight redistributed,
    # never replaced by a midpoint that would read as a measurement.
    parts = [(duration_points, 55)]

    efficiency_points = None
    if night.get("efficiency") is not None:
        efficiency_points = clamp((night["efficiency"] - 70) / 25) * 30
        parts.append((efficiency_points, 30))

    stages = night.get("stages") or {}
    deep, rem = stages.get("deep"), stages.get("rem")
    if night["minutes_asleep"] and deep is not None and rem is not None:
        deep_ratio = deep / night["minutes_asleep"]
        rem_ratio = rem / night["minutes_asleep"]
        deep_fit = 1 - min(abs(deep_ratio - 0.17) / 0.17, 1)
        rem_fit = 1 - min(abs(rem_ratio - 0.22) / 0.22, 1)
        parts.append(((deep_fit * 0.6 + rem_fit * 0.4) * 15, 15))

    earned = sum(p for p, _ in parts)
    available = sum(w for _, w in parts)
    return round(clamp(earned / available, 0, 1) * 100)


def sleep_need(history):
    """Tonight's ask: the adult floor plus a quarter of the recent debt."""
    nights = [n for n in history if n.get("minutes_asleep") is not None]
    recent = nights[-policy.SLEEP_DEBT_WINDOW_DAYS:]
    if not recent:
        return {"minutes": policy.SLEEP_NEED_BASE_MINUTES, "debt_minutes": 0, "source": "floor"}
    base = policy.SLEEP_NEED_BASE_MINUTES
    deficits = [max(0, base - n["minutes_asleep"]) for n in recent]
    debt = round(sum(deficits))
    # The paydown is capped: chasing a large accumulated debt by sleeping an
    # extra two hours a night is not a plan anyone follows, and the ask stops
    # being credible long before it stops growing.
    paydown = min(debt * policy.SLEEP_DEBT_PAYDOWN_SHARE, policy.SLEEP_NEED_MAX_EXTRA_MINUTES)
    need = round(base + paydown)
    return {"minutes": need, "debt_minutes": debt, "source": "measured"}


def circadian(history):
    """Sleep timing from the athlete's own onsets, never a fixed bedtime."""
    nights = [
        n for n in history if n.get("bed_minutes") is not None and n.get("is_main", True)
    ]
    nights = nights[-policy.SLEEP_HISTORY_DAYS:]
    if len(nights) < 7:
        return {"available": False, "nights_used": len(nights)}

    # Onsets after midnight belong to the previous evening's night; shift them
    # into a continuous evening-anchored scale so a 00:40 bedtime is "late",
    # not "very early".
    def evening_anchored(minutes):
        return minutes + 24 * 60 if minutes < 12 * 60 else minutes

    onsets = [evening_anchored(n["bed_minutes"]) for n in nights]
    med = median(onsets)
    spread = median([abs(o - med) for o in onsets])
    aligned = sum(1 for o in onsets if abs(o - med) <= 45)

    wake_times = [n["wake_minutes"] for n in nights if n.get("wake_minutes") is not None]
    typical_wake = median(wake_times)

    return {
        "available": True,
        "nights_used": len(nights),
        "median_onset": policy.format_clock(med % (24 * 60)),
        "median_onset_minutes": round(med % (24 * 60)),
        "spread_minutes": round(spread),
        "alignment_pct": round(100 * aligned / len(onsets)),
        "typical_wake": policy.format_clock(typical_wake),
        "bedtime_target": policy.format_clock(
            policy.bed_time_target(policy.SLEEP_NEED_BASE_MINUTES, typical_wake)
        ),
    }


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------
def day_load(steps, active_minutes, exercise_minutes):
    """0-100 reading of how much work a day contained.

    Deliberately not called "strain": strain is a device vendor's model, and
    this is ours. It is monotone in every input and bounded at both ends.
    """
    if steps is None and active_minutes is None and exercise_minutes is None:
        return None
    points = 0.0
    if steps is not None:
        points += clamp(steps / 12000) * 40
    if active_minutes is not None:
        points += clamp(active_minutes / 60) * 40
    if exercise_minutes is not None:
        points += clamp(exercise_minutes / 60) * 20
    return round(clamp(points / 100, 0, 1) * 100)


def training_load(exercise_records, today=None):
    """Acute (7 day) against chronic (28 day) minutes, and their ratio.

    Both windows are per-week equivalents so the ratio is comparable: the
    chronic side is the 28-day total divided by four.
    """
    today = today or date.today()
    durations = {}
    for session in exercise_records or []:
        day = _parse_date(session.get("date"))
        minutes = session.get("duration_minutes")
        if day is None or minutes is None:
            continue
        durations[day] = durations.get(day, 0) + minutes

    start = today - timedelta(days=27)
    within = {d: m for d, m in durations.items() if start <= d <= today}
    acute_days = 7
    acute = sum(m for d, m in within.items() if (today - d).days < acute_days)
    chronic_total = sum(within.values())
    chronic = chronic_total / 4 if within else None
    acwr = round(acute / chronic, 2) if chronic else None

    daily = [
        {
            "date": (today - timedelta(days=offset)).isoformat(),
            "minutes": durations.get(today - timedelta(days=offset), 0),
        }
        for offset in range(27, -1, -1)
    ]

    return {
        "acute_minutes": round(acute),
        "chronic_minutes": round(chronic) if chronic is not None else None,
        "acwr": acwr,
        "sessions_28d": len(within),
        "daily": daily,
    }


# --------------------------------------------------------------------------
# Composite scores
# --------------------------------------------------------------------------
def recovery(signals):
    """0-100, from HRV, resting rate, sleep and breathing — each vs the athlete.

    Weights are renormalised over the components that were actually measured, so
    a missing breathing reading cannot silently cost ten points.
    """
    parts = []

    hrv_delta = signals.get("hrv_delta_pct")
    if hrv_delta is not None:
        parts.append(("hrv", clamp((hrv_delta + 30) / 60), 40))

    rhr_delta = signals.get("rhr_delta_bpm")
    if rhr_delta is not None:
        parts.append(("rhr", clamp((8 - rhr_delta) / 16), 25))

    sleep = signals.get("sleep_score")
    if sleep is not None:
        parts.append(("sleep", sleep / 100, 25))

    resp_delta = signals.get("resp_delta")
    if resp_delta is not None:
        parts.append(("resp", clamp(1 - max(0, resp_delta) / 3), 10))

    if not parts:
        return {"score": None, "factors": [], "measured": False}

    earned = sum(s * w for _, s, w in parts)
    available = sum(w for _, _, w in parts)
    score = round(clamp(earned / available) * 100)

    factors = [
        {
            "key": key,
            "weight": round(100 * w / available),
            "contribution": round(100 * s * w / available),
            "read": _factor_read(key, signals),
        }
        for key, s, w in parts
    ]
    return {"score": score, "factors": factors, "measured": True}


def _factor_read(key, signals):
    if key == "hrv":
        delta = signals.get("hrv_delta_pct")
        return f"{delta:+.0f}% vs your 30-night median" if delta is not None else "not measured"
    if key == "rhr":
        delta = signals.get("rhr_delta_bpm")
        return f"{delta:+.0f} bpm vs your 30-day median" if delta is not None else "not measured"
    if key == "sleep":
        minutes = signals.get("sleep_minutes")
        return f"{minutes // 60}h {minutes % 60:02d}m against your own need" if minutes else "not measured"
    if key == "resp":
        delta = signals.get("resp_delta")
        return f"{delta:+.1f} brpm vs baseline" if delta is not None else "not measured"
    return "not measured"


def readiness(recovery_score, acwr):
    """Recovery, tempered by how fast load is climbing.

    Eighty percent is recovery; a fifth answers "is this a good day to add to
    the pile". The load side is full marks inside the sweet spot and decays
    outside it, in either direction.
    """
    if recovery_score is None:
        return None
    load_fit = 1.0
    if acwr is not None:
        low, high = policy.ACWR_SWEET_SPOT
        if acwr > high:
            load_fit = clamp(1 - (acwr - high) / 1.2)
        elif acwr < low:
            load_fit = clamp(1 - (low - acwr) / 1.2, 0.4, 1.0)
    return round(clamp(0.8 * (recovery_score / 100) + 0.2 * load_fit) * 100)


# --------------------------------------------------------------------------
# Series assembly
# --------------------------------------------------------------------------
def channel_rows(sleep, hrv, rhr, daily, spo2=None, resp=None):
    """One row per calendar day, joined by date.

    This is the only place the channels are joined, so the correlation lab, the
    movement trend and the today card all read the same paired days.
    """
    by_date = {}

    def row(day):
        return by_date.setdefault(
            day,
            {
                "date": day,
                "sleep_minutes": None,
                "hrv": None,
                "rhr": None,
                "steps": None,
                "active_minutes": None,
                "calories": None,
                "spo2": None,
                "resp": None,
                "exercise_minutes": None,
            },
        )

    for night in sleep or []:
        if night.get("date") and night.get("is_main", True):
            row(night["date"])["sleep_minutes"] = night.get("minutes_asleep")
    for item in hrv or []:
        if item.get("date"):
            row(item["date"])["hrv"] = item.get("ms")
    for item in rhr or []:
        if item.get("date"):
            row(item["date"])["rhr"] = item.get("bpm")
    for item in daily or []:
        if item.get("date"):
            target = row(item["date"])
            for key in ("steps", "active_minutes", "calories", "exercise_minutes"):
                if item.get(key) is not None:
                    target[key] = item[key]
    for item in spo2 or []:
        if item.get("date"):
            row(item["date"])["spo2"] = item.get("average_pct")
    for item in resp or []:
        if item.get("date"):
            row(item["date"])["resp"] = item.get("breaths_per_minute")
    return [by_date[d] for d in sorted(by_date)]


def trend(series, key, days=7):
    """Latest reading, the window mean, and the change against the window before."""
    values = [r[key] for r in series if r.get(key) is not None]
    if not values:
        return None
    current = values[-1]
    recent = values[-days:]
    return {
        "latest": round(current, 1),
        "mean": round(mean(recent), 1),
        "n": len(recent),
        "previous_mean": round(mean(values[-days * 2 : -days]), 1)
        if len(values) > days
        else None,
    }


def weekly_active_minutes(daily, today=None):
    """Minutes in the current ISO week against the WHO floor."""
    today = today or date.today()
    week_start = today - timedelta(days=today.weekday())
    total = 0
    measured = False
    for row in daily or []:
        day = _parse_date(row.get("date"))
        if day is None or day < week_start or day > today:
            continue
        if row.get("active_minutes") is not None:
            measured = True
            total += row["active_minutes"]
    return {
        "minutes": round(total) if measured else None,
        "target": policy.WEEKLY_ACTIVE_MINUTES_TARGET,
        "pct": round(100 * total / policy.WEEKLY_ACTIVE_MINUTES_TARGET) if measured else None,
    }
