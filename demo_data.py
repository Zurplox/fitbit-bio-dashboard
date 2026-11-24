"""
Synthetic dataset, so the dashboard can be reviewed before the device has data.

This is generated through the *same* `build_payload` the live run uses, so the
demo exercises the real arithmetic rather than a hand-written fixture. It is
labelled `demo: true` all the way into the vault, and the page shows a permanent
DEMO chip — synthetic physiology must never be mistaken for a measurement.
"""

from __future__ import annotations

import json
import os
import random
from datetime import date, datetime, timedelta

from provenance import DataQuality

DEMO_DAYS = 90


def synthetic_fetch(days=DEMO_DAYS, seed=11):
    rng = random.Random(seed)
    today = date.today()
    start = today - timedelta(days=days - 1)

    sleep, rhr, hrv, spo2, resp = [], [], [], [], []
    steps, calories, active, vo2max = [], [], [], []
    exercise, skin_temp = [], []

    rhr_base = 54.0
    hrv_base = 44.0

    for offset in range(days):
        day = start + timedelta(days=offset)

        # A slow aerobic drift plus noise, and one deliberately rough patch so
        # the recovery bands are exercised in more than one direction.
        rough = 1 if 68 <= offset <= 72 else 0
        step_count = max(1200, rng.gauss(8600, 2600))
        night_minutes = max(240, rng.gauss(438, 52) - 45 * rough)
        deep = round(night_minutes * rng.uniform(0.15, 0.21))
        rem = round(night_minutes * rng.uniform(0.19, 0.25))
        light = max(0, round(night_minutes) - deep - rem)
        awake = round(rng.gauss(26, 9)) + 12 * rough

        bed = (23 * 60 + 10 + rng.gauss(0, 38)) % (24 * 60)
        wake = (bed + night_minutes + awake) % (24 * 60)

        sleep.append(
            {
                "date": day.isoformat(),
                "minutes_asleep": round(night_minutes),
                "minutes_in_period": round(night_minutes) + awake,
                "minutes_awake": awake,
                "minutes_to_fall_asleep": round(max(3, rng.gauss(11, 5))),
                "stages": {"deep": deep, "rem": rem, "light": light, "awake": awake},
                "onset_minutes": round(bed),
                "wake_minutes": round(wake),
                "is_main": True,
                "nap": False,
                "device": "Fitbit Air",
            }
        )

        resting = rhr_base - 0.02 * offset + rng.gauss(0, 1.4) + 4.5 * rough
        rhr.append({"date": day.isoformat(), "value": round(resting, 1)})

        variability = hrv_base + 0.03 * offset + (night_minutes - 438) * 0.06
        variability += rng.gauss(0, 3.1) - 12.0 * rough
        hrv.append({"date": day.isoformat(), "value": round(max(12, variability), 1)})

        if rng.random() < 0.8:
            spo2.append({"date": day.isoformat(), "value": round(rng.gauss(96.1, 0.9), 1)})
        resp.append({"date": day.isoformat(), "value": round(rng.gauss(14.3, 0.35) + 0.9 * rough, 2)})
        skin_temp.append({"date": day.isoformat(), "value": round(rng.gauss(0, 0.25) + 0.6 * rough, 2)})

        steps.append({"date": day.isoformat(), "value": round(step_count)})
        active.append({"date": day.isoformat(), "value": round(max(0, rng.gauss(29, 14)))})
        calories.append({"date": day.isoformat(), "value": round(max(1400, rng.gauss(2320, 210)))})
        if offset % 7 == 0:
            vo2max.append({"date": day.isoformat(), "value": round(46.2 + 0.012 * offset, 1)})

        if offset % 7 in (1, 3, 5):
            minutes = max(15, round(rng.gauss(44, 14)))
            distance = round(minutes * rng.uniform(120, 240)) if offset % 2 else None
            exercise.append(
                {
                    "date": day.isoformat(),
                    "start": f"{day.isoformat()}T18:10:00Z",
                    "start_local": "18:10",
                    "minutes": minutes,
                    "type": rng.choice(["running", "walking", "cycling", "strength"]),
                    "name": "Evening session",
                    "calories": round(minutes * rng.uniform(7, 11)),
                    "avg_hr": round(rng.gauss(132, 9)),
                    "steps": round(minutes * rng.uniform(90, 160)),
                    "distance_m": distance,
                    "active_zone_minutes": round(minutes * 0.6),
                    "zones": {
                        "light": round(minutes * 0.25, 1),
                        "moderate": round(minutes * 0.45, 1),
                        "vigorous": round(minutes * rng.uniform(0.15, 0.25), 1),
                        "peak": round(minutes * rng.uniform(0.0, 0.08), 1),
                    },
                    "pace_s_per_m": round(minutes * 60 / distance, 2) if distance else None,
                    "speed_kmh": round(distance / minutes * 0.06, 1) if distance else None,
                    "swim_lengths": None,
                    "mobility": None,
                }
            )

    intraday = []
    for hour in range(24):
        bpm = 58 + 18 * (1 if 6 <= hour <= 21 else 0) + rng.gauss(0, 4)
        intraday.append(
            {
                "t": f"{(today - timedelta(days=1)).isoformat()}T{hour:02d}:00:00Z",
                "bpm": round(bpm),
            }
        )

    # One-minute heart rate for the newest workout, with a warm-up and a
    # harder middle block so the zone colours are visible in the demo.
    workout_hr = []
    if exercise:
        last = exercise[-1]
        start = datetime.fromisoformat(last["start"].replace("Z", "+00:00"))
        for minute in range(last["minutes"] or 0):
            shape = 12 if minute < 5 or minute > (last["minutes"] - 5) else 42
            bpm = (last["avg_hr"] or 130) - 25 + shape + rng.gauss(0, 4)
            workout_hr.append({
                "t": (start + timedelta(minutes=minute)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "bpm": round(bpm),
            })

    return {
        "today": today.isoformat(),
        "identity": {"health_user_id": "demo-user"},
        "profile": {"height_cm": 174.0, "weight_kg": 68.4, "age": 34},
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
        "hr_intraday": intraday,
        "workout_hr": workout_hr,
        "hr_zones": {
            "light": [95, 125],
            "moderate": [126, 150],
            "vigorous": [151, 174],
            "peak": [175, 220],
        },
    }


def main():
    import sync

    os.environ.setdefault("ATHLETE_NAME", "Demo athlete")
    dq = DataQuality()
    fetched = synthetic_fetch()

    for key, label, note in (
        ("sleep", "Sleep", f"{len(fetched['sleep'])} synthetic nights"),
        ("rhr", "Resting heart rate", f"{len(fetched['rhr'])} synthetic days"),
        ("hrv", "Overnight HRV", f"{len(fetched['hrv'])} synthetic nights"),
        ("spo2", "Blood oxygen", f"{len(fetched['spo2'])} synthetic nights"),
        ("resp", "Breathing rate", f"{len(fetched['resp'])} synthetic nights"),
        ("steps", "Steps", f"{len(fetched['steps'])} synthetic days"),
        ("calories", "Calories", f"{len(fetched['calories'])} synthetic days"),
        ("active_minutes", "Active minutes", f"{len(fetched['active_minutes'])} synthetic days"),
        ("vo2max", "Cardio fitness", f"{len(fetched['vo2max'])} synthetic readings"),
        ("skin_temp", "Skin temperature", f"{len(fetched['skin_temp'])} synthetic nights"),
        ("exercise", "Workouts", f"{len(fetched['exercise'])} synthetic sessions"),
        ("heart_rate", "Heart rate", f"{len(fetched['hr_intraday'])} synthetic hours"),
        ("profile", "Body metrics", "synthetic profile"),
        ("identity", "Account", "synthetic account"),
    ):
        dq.record(key, True, note, label)

    payload = sync.build_payload(fetched, dq, demo=True)
    os.makedirs("data", exist_ok=True)
    with open("data/biometrics.json", "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
    print("demo payload written: data/biometrics.json")


if __name__ == "__main__":
    main()
