"""
The run: fetch -> analyse -> gate -> publish.

This file owns the run and nothing else. Every threshold lives in `bio_policy`,
every sum in `bio_analytics`, every verdict in `clinical_engine`, and every
request to Google in `googlehealth_source`. If a rule about what a number
*means* is about to be written here, it belongs in policy instead.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import bio_analytics as analytics
import bio_coach
import bio_correlate
import bio_policy as policy
import clinical_engine
import googlehealth_source as source
from provenance import DataQuality

DATA_DIR = Path("data")
FETCH_DAYS = policy.SLEEP_HISTORY_DAYS


def utc_now_iso():
    """Timezone-aware. A naive timestamp is read as local time by every browser."""
    return datetime.now(timezone.utc).isoformat()


def _attempt(dq, key, label, fetcher, default, unit):
    """Run one optional fetcher so its failure cannot take the whole run down.

    An unsupported data type returns 400/404 and would otherwise abort a sync
    that has every other measurement in hand. Core groups still fail the run at
    the publish gate, which is where that decision belongs.
    """
    try:
        return fetcher()
    except Exception as error:  # noqa: BLE001 - recorded, then published as missing
        print(f"   {label} unavailable: {error}")
        dq.record(key, False, f"fetch failed ({type(error).__name__})", label)
        return default


def collect(client, dq):
    today = source.local_today()
    print(f"fetching {FETCH_DAYS} days ending {today.isoformat()} ...")

    identity = source.fetch_identity(client, dq)
    profile = _attempt(
        dq, "profile", "Body metrics", lambda: source.fetch_profile(client, dq),
        {"height_cm": None, "weight_kg": None, "age": None}, "profile",
    )

    sleep = _attempt(dq, "sleep", "Sleep", lambda: source.fetch_sleep(client, days=FETCH_DAYS, dq=dq), [], "sleep")
    rhr = _attempt(dq, "rhr", "Resting heart rate", lambda: source.fetch_daily_rhr(client, days=FETCH_DAYS, dq=dq), [], "rhr")
    hrv = _attempt(dq, "hrv", "Overnight HRV", lambda: source.fetch_daily_hrv(client, days=FETCH_DAYS, dq=dq), [], "hrv")
    spo2 = _attempt(dq, "spo2", "Blood oxygen", lambda: source.fetch_daily_spo2(client, days=FETCH_DAYS, dq=dq), [], "spo2")
    resp = _attempt(dq, "resp", "Breathing rate", lambda: source.fetch_daily_resp(client, days=FETCH_DAYS, dq=dq), [], "resp")
    vo2max = _attempt(dq, "vo2max", "Cardio fitness", lambda: source.fetch_daily_vo2max(client, days=FETCH_DAYS, dq=dq), [], "vo2max")
    skin_temp = _attempt(dq, "skin_temp", "Skin temperature", lambda: source.fetch_daily_skin_temp(client, days=FETCH_DAYS, dq=dq), [], "skin temperature")
    steps = _attempt(dq, "steps", "Steps", lambda: source.fetch_daily_steps(client, days=FETCH_DAYS, dq=dq), [], "steps")
    calories = _attempt(dq, "calories", "Calories", lambda: source.fetch_daily_calories(client, days=FETCH_DAYS, dq=dq), [], "calories")
    active = _attempt(dq, "active_minutes", "Active minutes", lambda: source.fetch_daily_active_minutes(client, days=FETCH_DAYS, dq=dq), [], "active minutes")
    exercise = _attempt(dq, "exercise", "Workouts", lambda: source.fetch_exercise(client, days=FETCH_DAYS, dq=dq), [], "workouts")
    hr_intraday = _attempt(dq, "heart_rate", "Heart rate", lambda: source.fetch_intraday_hr(client, hours=24, dq=dq), [], "heart rate")

    # Attribution is a footnote, so it is attempted outside the data-quality
    # gate: losing it must not mark a metric missing, and the page copes with an
    # empty block by simply saying nothing.
    try:
        sources = source.fetch_sources(client, days=FETCH_DAYS)
    except Exception as error:  # noqa: BLE001 - see above
        print(f"   source attribution unavailable: {error}")
        sources = {"metrics": {}, "devices": []}

    return {
        "today": today.isoformat(),
        "identity": identity,
        "profile": profile,
        "sleep": sleep,
        "rhr": rhr,
        "hrv": hrv,
        "spo2": spo2,
        "resp": resp,
        "vo2max": vo2max,
        "skin_temp": skin_temp,
        "steps": steps,
        "calories": calories,
        "active_minutes": active,
        "exercise": exercise,
        "hr_intraday": hr_intraday,
        "sources": sources,
    }


def _value_series(records):
    return [{"date": r["date"], "value": r["value"]} for r in records if r.get("value") is not None]


def _mean(values):
    clean = [v for v in values if v is not None]
    return round(sum(clean) / len(clean), 1) if clean else None


def build_payload(fetched, dq, demo=False):
    today = fetched["today"]
    need = analytics.sleep_need(
        [analytics.summarise_night(n) for n in fetched["sleep"] if n]
    )

    nights = []
    for raw in fetched["sleep"]:
        night = analytics.summarise_night(raw)
        if not night:
            continue
        night["score"] = analytics.sleep_score(night, need["minutes"])
        night["stages"] = night["stages"] or {}
        nights.append(night)
    nights.sort(key=lambda n: n["date"])

    latest_night = analytics.latest(nights)
    hrv_series = _value_series(fetched["hrv"])
    rhr_series = _value_series(fetched["rhr"])
    resp_series = _value_series(fetched["resp"])
    spo2_series = _value_series(fetched["spo2"])
    steps_series = _value_series(fetched["steps"])
    calories_series = _value_series(fetched["calories"])
    active_series = _value_series(fetched["active_minutes"])
    vo2_series = _value_series(fetched["vo2max"])
    # .get: payloads assembled before skin temperature existed have no key.
    skin_series = _value_series(fetched.get("skin_temp") or [])
    skin_latest = skin_series[-1] if skin_series else None

    # Baselines: the athlete's own recent median, on the windows policy owns.
    hrv_baseline = analytics.median(
        [r["value"] for r in hrv_series[-policy.HRV_BASELINE_NIGHTS:]]
    )
    rhr_baseline = analytics.median(
        [r["value"] for r in rhr_series[-policy.RHR_BASELINE_DAYS:]]
    )
    resp_baseline = analytics.median(
        [r["value"] for r in resp_series[-policy.RESP_BASELINE_NIGHTS:]]
    )

    hrv_latest = hrv_series[-1] if hrv_series else None
    rhr_latest = rhr_series[-1] if rhr_series else None
    resp_latest = resp_series[-1] if resp_series else None
    spo2_latest = spo2_series[-1] if spo2_series else None

    hrv_delta = analytics.pct_change(
        hrv_latest["value"] if hrv_latest else None, hrv_baseline
    )
    rhr_delta = (
        round(rhr_latest["value"] - rhr_baseline, 1)
        if rhr_latest and rhr_baseline is not None
        else None
    )
    resp_delta = (
        round(resp_latest["value"] - resp_baseline, 2)
        if resp_latest and resp_baseline is not None
        else None
    )

    load = analytics.training_load(
        [
            {"date": s.get("date"), "duration_minutes": s.get("minutes")}
            for s in fetched["exercise"]
        ],
        today=date.fromisoformat(today),
    )

    daily_rows = [
        {
            "date": row["date"],
            "steps": row["value"],
            "active_minutes": None,
            "calories": None,
        }
        for row in steps_series
    ]
    by_day = {row["date"]: row for row in daily_rows}
    for row in active_series:
        by_day.setdefault(row["date"], {"date": row["date"], "steps": None, "active_minutes": None, "calories": None})
        by_day[row["date"]]["active_minutes"] = row["value"]
    for row in calories_series:
        by_day.setdefault(row["date"], {"date": row["date"], "steps": None, "active_minutes": None, "calories": None})
        by_day[row["date"]]["calories"] = row["value"]

    exercise_by_day = {}
    for session in fetched["exercise"]:
        if session.get("date") and session.get("minutes"):
            exercise_by_day[session["date"]] = exercise_by_day.get(session["date"], 0) + session["minutes"]
    for day, minutes in exercise_by_day.items():
        by_day.setdefault(day, {"date": day, "steps": None, "active_minutes": None, "calories": None})
        by_day[day]["exercise_minutes"] = minutes

    daily = [by_day[d] for d in sorted(by_day)]
    channels = analytics.channel_rows(
        [dict(n, is_main=True) for n in nights],
        [{"date": r["date"], "ms": r["value"]} for r in hrv_series],
        [{"date": r["date"], "bpm": r["value"]} for r in rhr_series],
        daily,
        spo2=[{"date": r["date"], "average_pct": r["value"]} for r in spo2_series],
        resp=[{"date": r["date"], "breaths_per_minute": r["value"]} for r in resp_series],
    )

    sleep_score = latest_night.get("score") if latest_night else None
    signals = {
        "hrv": hrv_latest["value"] if hrv_latest else None,
        "hrv_baseline": round(hrv_baseline, 1) if hrv_baseline is not None else None,
        "hrv_delta_pct": hrv_delta,
        "rhr": rhr_latest["value"] if rhr_latest else None,
        "rhr_baseline": round(rhr_baseline, 1) if rhr_baseline is not None else None,
        "rhr_delta_bpm": rhr_delta,
        "sleep_minutes": latest_night.get("minutes_asleep") if latest_night else None,
        "sleep_score": sleep_score,
        "sleep_efficiency": latest_night.get("efficiency") if latest_night else None,
        "deep_minutes": (latest_night.get("stages") or {}).get("deep") if latest_night else None,
        "rem_minutes": (latest_night.get("stages") or {}).get("rem") if latest_night else None,
        "resp": resp_latest["value"] if resp_latest else None,
        "resp_baseline": round(resp_baseline, 2) if resp_baseline is not None else None,
        "resp_delta": resp_delta,
        "spo2": spo2_latest["value"] if spo2_latest else None,
        "vo2max": vo2_series[-1]["value"] if vo2_series else None,
    }

    recovery = analytics.recovery(signals)
    signals["recovery"] = recovery
    signals["readiness"] = analytics.readiness(recovery["score"], load.get("acwr"))

    try:
        step_goal = int(os.environ.get("STEP_GOAL") or policy.DEFAULT_STEP_GOAL)
    except ValueError:
        step_goal = policy.DEFAULT_STEP_GOAL
    today_steps = next((r for r in steps_series if r["date"] == today), None)
    today_active = next((r for r in active_series if r["date"] == today), None)
    today_calories = next((r for r in calories_series if r["date"] == today), None)

    week = analytics.weekly_active_minutes(
        [{"date": r["date"], "active_minutes": r["value"]} for r in active_series],
        today=date.fromisoformat(today),
    )
    movement = {
        "steps_today": today_steps["value"] if today_steps else None,
        "steps_mean": _mean([r["value"] for r in steps_series[-7:]]),
        "steps_mean_28": _mean([r["value"] for r in steps_series[-28:]]),
        "step_goal": step_goal,
        "goal_source": "configured",
        "week": week,
        "vo2max": signals["vo2max"],
    }

    clinical = clinical_engine.assess(signals, load, {"mean": movement["steps_mean"]}, {})
    coaching = bio_coach.build_coaching(
        signals, load, movement, sleep_score, load.get("acwr")
    )
    coaching["focus"] = bio_coach.today_focus(coaching["cards"])

    circadian = analytics.circadian([dict(n, is_main=True) for n in nights])
    dq.record(
        "circadian",
        bool(circadian.get("available")),
        f"{circadian.get('nights_used', 0)} nights, spread {circadian.get('spread_minutes')} min"
        if circadian.get("available")
        else "not enough sleep onsets",
        "Circadian timing",
    )

    correlations = bio_correlate.build_correlations(channels)
    markers = build_markers(
        fetched, nights, hrv_series, rhr_series, steps_series, vo2_series, today
    )

    quality = dq.as_dict()
    if not dq.publishable():
        print("\n" + "!" * 68)
        print("ABORTING RUN: core biometric sources were not measured:")
        for label in quality["core_degraded"]:
            print(f"   - {label}")
        print("Publishing a dashboard assembled from missing data would present")
        print("absence as physiology. The previous vault is left untouched.")
        print("!" * 68)
        sys.exit(1)

    def band_of(band):
        return band

    today_block = {
        "date": today,
        "sleep": {
            "minutes": signals["sleep_minutes"],
            "efficiency": signals["sleep_efficiency"],
            "score": sleep_score,
            "band": band_of(policy.sleep_band(sleep_score)),
            "efficiency_band": band_of(
                policy.sleep_efficiency_band(signals["sleep_efficiency"])
            ),
            "stages": (latest_night.get("stages") if latest_night else {}) or {},
            "bed_minutes": latest_night.get("bed_minutes") if latest_night else None,
            "wake_minutes": latest_night.get("wake_minutes") if latest_night else None,
            "bed": policy.format_clock(latest_night.get("bed_minutes")) if latest_night else None,
            "wake": policy.format_clock(latest_night.get("wake_minutes")) if latest_night else None,
            "need_minutes": need["minutes"],
            "debt_minutes": need["debt_minutes"],
            "need_source": need["source"],
        },
        "hrv": {
            "ms": signals["hrv"],
            "baseline": signals["hrv_baseline"],
            "delta_pct": hrv_delta,
            "band": band_of(policy.hrv_band(hrv_delta)),
            "date": hrv_latest["date"] if hrv_latest else None,
        },
        "rhr": {
            "bpm": signals["rhr"],
            "baseline": signals["rhr_baseline"],
            "delta": rhr_delta,
            "band": band_of(policy.rhr_band(rhr_delta)),
            "date": rhr_latest["date"] if rhr_latest else None,
        },
        "spo2": {
            "pct": signals["spo2"],
            "band": band_of(policy.spo2_band(signals["spo2"])),
            "nights_recorded": len(spo2_series),
            "window_days": FETCH_DAYS,
            "date": spo2_latest["date"] if spo2_latest else None,
        },
        "resp": {
            "brpm": signals["resp"],
            "baseline": signals["resp_baseline"],
            "delta": resp_delta,
            "band": band_of(policy.resp_band(resp_delta)),
            "date": resp_latest["date"] if resp_latest else None,
        },
        "steps": {
            "count": movement["steps_today"],
            "goal": step_goal,
            "pct": round(100 * movement["steps_today"] / step_goal)
            if movement["steps_today"] is not None
            else None,
            "mean_7d": movement["steps_mean"],
            "mean_28d": movement["steps_mean_28"],
        },
        "active_minutes": {
            "today": today_active["value"] if today_active else None,
            "week": week,
        },
        "calories": {
            "today": today_calories["value"] if today_calories else None,
            "mean_7d": _mean([r["value"] for r in calories_series[-7:]]),
        },
        "load": {
            "score": analytics.day_load(
                movement["steps_today"],
                today_active["value"] if today_active else None,
                exercise_by_day.get(today),
            ),
            "band": band_of(
                policy.load_band(
                    analytics.day_load(
                        movement["steps_today"],
                        today_active["value"] if today_active else None,
                        exercise_by_day.get(today),
                    )
                )
            ),
        },
        "vo2max": {"value": signals["vo2max"]},
        "skin_temp": {
            "delta_c": skin_latest["value"] if skin_latest else None,
            "date": skin_latest["date"] if skin_latest else None,
        },
        "recovery": {
            "score": recovery["score"],
            "band": band_of(policy.recovery_band(recovery["score"])),
            "factors": recovery["factors"],
            "measured": recovery["measured"],
        },
        "readiness": {
            "score": signals["readiness"],
            "band": band_of(policy.readiness_band(signals["readiness"])),
        },
    }

    return {
        "schema": 2,
        "generated_at": utc_now_iso(),
        "demo": demo,
        "timezone": os.environ.get("DASHBOARD_TZ") or "Asia/Singapore",
        "device": {
            "name": _device_name(fetched["sleep"]) or "Fitbit",
            "platform": "FITBIT",
            "api": "Google Health API v4",
            "sources": [
                entry["label"]
                for entry in (fetched.get("sources") or {}).get("devices", [])
                # A point with no device, app or platform name is not a source a
                # reader can act on, so it stays out of the device line.
                if entry["label"] and entry["label"] != "Unknown source"
            ],
        },
        "athlete": {
            # `or` and not a default argument: an unset GitHub secret arrives as an
            # empty string, which would otherwise put a blank name on the page.
            "name": os.environ.get("ATHLETE_NAME") or "Athlete",
            "height_cm": fetched["profile"].get("height_cm"),
            "weight_kg": fetched["profile"].get("weight_kg"),
        },
        "today": today_block,
        "sources": fetched.get("sources") or {"metrics": {}, "devices": []},
        "baselines": {
            "hrv_ms": signals["hrv_baseline"],
            "hrv_nights": min(len(hrv_series), policy.HRV_BASELINE_NIGHTS),
            "rhr_bpm": signals["rhr_baseline"],
            "rhr_days": min(len(rhr_series), policy.RHR_BASELINE_DAYS),
            "resp_brpm": signals["resp_baseline"],
            "sleep_minutes_30d": _mean([n["minutes_asleep"] for n in nights[-30:]]),
        },
        "history": {
            "sleep": [
                {
                    "date": n["date"],
                    "minutes": n["minutes_asleep"],
                    "efficiency": n["efficiency"],
                    "score": n.get("score"),
                    "deep": (n.get("stages") or {}).get("deep"),
                    "light": (n.get("stages") or {}).get("light"),
                    "rem": (n.get("stages") or {}).get("rem"),
                    "awake": (n.get("stages") or {}).get("awake"),
                    "bed_minutes": n.get("bed_minutes"),
                    "wake_minutes": n.get("wake_minutes"),
                    "bed": policy.format_clock(n.get("bed_minutes")),
                    "wake": policy.format_clock(n.get("wake_minutes")),
                }
                for n in nights
            ],
            "hrv": [
                {"date": r["date"], "ms": r["value"]} for r in hrv_series
            ],
            "rhr": [
                {"date": r["date"], "bpm": r["value"]} for r in rhr_series
            ],
            "steps": [{"date": r["date"], "count": r["value"]} for r in steps_series],
            "active_minutes": [
                {"date": r["date"], "minutes": r["value"]} for r in active_series
            ],
            "calories": [{"date": r["date"], "kcal": r["value"]} for r in calories_series],
            "spo2": [{"date": r["date"], "pct": r["value"]} for r in spo2_series],
            "resp": [{"date": r["date"], "brpm": r["value"]} for r in resp_series],
            "vo2max": [{"date": r["date"], "value": r["value"]} for r in vo2_series],
            "skin_temp": [{"date": r["date"], "delta_c": r["value"]} for r in skin_series],
            "hr_intraday": fetched["hr_intraday"],
            "exercise": fetched["exercise"],
        },
        "load": {
            "acute_minutes": load["acute_minutes"],
            "chronic_minutes": load["chronic_minutes"],
            "acwr": load["acwr"],
            "acwr_band": band_of(policy.acwr_band(load["acwr"])) if load["acwr"] is not None else None,
            "sessions_28d": load["sessions_28d"],
            "daily": load["daily"],
        },
        "circadian": circadian,
        "correlations": correlations,
        "markers": markers,
        "coaching": coaching,
        "clinical": clinical,
        "data_quality": quality,
        "policy": policy.policy_snapshot(),
    }


def build_markers(fetched, nights, hrv_series, rhr_series, steps_series, vo2_series, today):
    """Derived markers with the study behind each. Absent inputs give absent
    markers; the page leaves those off rather than estimating them."""
    profile = fetched.get("profile") or {}
    age = profile.get("age")
    age_source = "profile" if age else None
    if not age:
        # Like STEP_GOAL: a configured value, labelled as configured.
        try:
            age = int(os.environ.get("ATHLETE_AGE") or 0) or None
        except ValueError:
            age = None
        age_source = "configured" if age else None
    evidence = policy.EVIDENCE

    vo2 = None
    if not vo2_series and age and len(rhr_series) >= 7:
        # The device sent no VO2 max: estimate it from resting heart rate and
        # age (Uth 2004), weekly from a 7-day mean so one odd morning cannot
        # move it, and say plainly that it is an estimate.
        estimates = []
        for end in range(len(rhr_series), 6, -7):
            week = [r["value"] for r in rhr_series[end - 7:end]]
            estimates.append({"date": rhr_series[end - 1]["date"], "value": analytics.vo2_uth(sum(week) / 7, age)})
        estimates.reverse()
        vo2_series = estimates
    if vo2_series:
        first, last = vo2_series[0], vo2_series[-1]
        vo2 = {
            "value": last["value"],
            "mets": round(last["value"] / 3.5, 1),
            "change_mets": round((last["value"] - first["value"]) / 3.5, 2) if len(vo2_series) > 1 else None,
            "since": first["date"],
            "estimated": not fetched["vo2max"],
            "series": vo2_series,
            "evidence": evidence["vo2max"],
            "method": evidence["vo2_estimate"] if not fetched["vo2max"] else None,
        }

    rhr = None
    recent, prior = rhr_series[-30:], rhr_series[-60:-30]
    if len(recent) >= 20 and len(prior) >= 20:
        now_mean = _mean([r["value"] for r in recent])
        then_mean = _mean([r["value"] for r in prior])
        rhr = {
            "mean_30d": now_mean,
            "prior_30d": then_mean,
            "change": round(now_mean - then_mean, 1),
            "evidence": evidence["rhr"],
        }

    steps = None
    if len(steps_series) >= 14:
        group = "60_plus" if age and age >= 60 else "under_60"
        steps = {
            "mean_28d": _mean([r["value"] for r in steps_series[-28:]]),
            # Without an age both ranges are true statements; the page shows
            # the one for the configured age group or both.
            "plateau": policy.STEP_PLATEAU[group] if age else None,
            "plateaus": policy.STEP_PLATEAU,
            "evidence": evidence["steps"],
        }

    height, weight = profile.get("height_cm"), profile.get("weight_kg")
    bmi = round(weight / (height / 100) ** 2, 1) if height and weight else None

    hrv_status = analytics.hrv_status(hrv_series)
    hrv_status["evidence"] = evidence["hrv_status"]
    intensity = analytics.intensity_mix(fetched["exercise"], today=today)
    intensity["evidence"] = evidence["intensity"]
    jetlag = analytics.social_jetlag(nights)
    jetlag["evidence"] = evidence["jetlag"]
    effect = analytics.training_effect(fetched["exercise"], today=today)
    effect["evidence"] = evidence["training_effect"]

    return {
        "age": age,
        "age_source": age_source,
        "training_effect": effect,
        "bmi": bmi,
        "vo2max": vo2,
        "rhr_trend": rhr,
        "steps": steps,
        "hrv_status": hrv_status,
        "intensity": intensity,
        "social_jetlag": jetlag,
        "metabolic_evidence": evidence["metabolic"],
    }


def _device_name(sleep_records):
    for record in reversed(sleep_records or []):
        if record.get("device"):
            return record["device"]
    return None


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dq = DataQuality()

    try:
        client = source.authenticated_client()
        fetched = collect(client, dq)
    except source.AuthError as error:
        print(f"\nauthentication failed: {error}\n")
        sys.exit(2)

    payload = build_payload(fetched, dq)

    out_file = DATA_DIR / "biometrics.json"
    # allow_nan=False: a NaN that slips past the parsers fails the run here,
    # leaving yesterday's readable vault, instead of publishing one the
    # browser cannot parse.
    out_file.write_text(json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")

    quality = payload["data_quality"]
    today = payload["today"]
    print("\n" + "=" * 68)
    print(f"payload written: {out_file}")
    print(f"  sleep        : {len(payload['history']['sleep'])} nights")
    print(f"  hrv          : {len(payload['history']['hrv'])} nights")
    print(f"  resting rate : {len(payload['history']['rhr'])} days")
    print(f"  steps        : {len(payload['history']['steps'])} days")
    print(f"  workouts     : {len(payload['history']['exercise'])} sessions")
    print(
        f"  recovery     : {today['recovery']['score']}% ({today['recovery']['band']['label']})"
        f" | readiness {today['readiness']['score']}"
    )
    print(
        f"  load ratio   : {payload['load']['acwr']} "
        f"({(payload['load']['acwr_band'] or {}).get('label')})"
    )
    print(
        f"  provenance   : {quality['live_count']}/{quality['total_count']} groups live "
        f"({quality['live_pct']}%)"
    )
    for metric in quality["metrics"].values():
        if metric["source"] != "live":
            print(f"      missing: {metric['label']} — {metric['note']}")
    print("=" * 68)


if __name__ == "__main__":
    main()
