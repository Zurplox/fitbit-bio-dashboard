"""
Verdicts and the words that carry them.

The rule engine is the only author of the scores. There is no model in this
pipeline and no key to configure: the same measurements must always produce the
same verdict, on every run, for every reader. Each paragraph ships twice — the
clinical sentence, then a plain-English one written by the same rule — so the
takeaway survives regardless of the reader's vocabulary.
"""

from __future__ import annotations

import bio_policy as policy


def _h(minutes):
    if minutes is None:
        return "--"
    return f"{minutes // 60}h {minutes % 60:02d}m"


def _signed(value, unit, digits=0):
    if value is None:
        return "--"
    return f"{value:+.{digits}f} {unit}"


def illness_signal(signals):
    """A count of independent early-illness drivers, never a diagnosis.

    Each driver is a measured deviation from the athlete's own baseline. Two or
    more together is what raises the flag; one alone is what a hard session
    looks like too.
    """
    drivers = []
    if signals.get("rhr_delta_bpm") is not None and signals["rhr_delta_bpm"] >= 5:
        drivers.append("resting rate up 5 bpm or more")
    if signals.get("resp_delta") is not None and signals["resp_delta"] >= 2:
        drivers.append("overnight breathing up 2 brpm or more")
    if signals.get("hrv_delta_pct") is not None and signals["hrv_delta_pct"] <= -20:
        drivers.append("HRV down 20% or more")
    if signals.get("spo2") is not None and signals["spo2"] < 94:
        drivers.append("blood oxygen below 94%")

    count = len(drivers)
    if count == 0:
        level, tone = "none", "good"
    elif count == 1:
        level, tone = "watch", "warn"
    else:
        level, tone = "elevated", "bad"

    return {
        "level": level,
        "tone": tone,
        "drivers": drivers,
        "headline": {
            "none": "No early-illness pattern in today's readings",
            "watch": "One signal is off — worth watching, not acting on",
            "elevated": "Several signals moved together",
        }[level],
    }


def assess(signals, load, trend, today_summary):
    """Assemble the verdict block from measured signals.

    `signals` keys: hrv, hrv_baseline, hrv_delta_pct, rhr, rhr_baseline,
    rhr_delta_bpm, sleep_minutes, sleep_score, sleep_efficiency, resp,
    resp_baseline, resp_delta, spo2, steps, step_goal, active_minutes.
    """
    recovery = signals.get("recovery") or {}
    recovery_score = recovery.get("score")
    readiness_score = signals.get("readiness")
    acwr = load.get("acwr") if load else None

    recovery_band = policy.recovery_band(recovery_score)
    readiness_band = policy.readiness_band(readiness_score)
    acwr_band = policy.acwr_band(acwr) if acwr is not None else None
    illness = illness_signal(signals)

    headline = _headline(recovery_score, recovery_band, readiness_band, illness)

    return {
        "score_source": "deterministic",
        "narrative_source": "rules",
        "recovery_score": recovery_score,
        "recovery_band": recovery_band,
        "readiness_score": readiness_score,
        "readiness_band": readiness_band,
        "acwr_band": acwr_band,
        "illness": illness,
        "headline": headline,
        "paragraphs": [
            {
                "id": "overnight",
                "title": "Overnight",
                "clinical": _overnight_clinical(signals),
                "plain": _overnight_plain(signals),
            },
            {
                "id": "load",
                "title": "Load",
                "clinical": _load_clinical(load, trend),
                "plain": _load_plain(load),
            },
            {
                "id": "outlook",
                "title": "Outlook",
                "clinical": _outlook_clinical(recovery_band, readiness_band, illness, acwr_band),
                "plain": _outlook_plain(recovery_band, illness),
            },
        ],
    }


def _headline(recovery_score, recovery_band, readiness_band, illness):
    if recovery_score is None:
        return "No recovery reading today — the pipeline did not get the measurements it needs."
    if illness["level"] == "elevated":
        return (
            f"Recovery {recovery_score}%, but several early-illness signals moved together. "
            "Ease off and watch tomorrow."
        )
    return f"Recovery {recovery_score}% — {recovery_band['label'].lower()}. {readiness_band['plain']}"


def _overnight_clinical(s):
    bits = []
    if s.get("sleep_minutes") is not None:
        text = f"Slept {_h(s['sleep_minutes'])}"
        if s.get("sleep_efficiency") is not None:
            text += f" at {s['sleep_efficiency']:.0f}% efficiency"
        bits.append(text)
    if s.get("deep_minutes") is not None and s.get("rem_minutes") is not None:
        bits.append(f"deep {s['deep_minutes']}m / REM {s['rem_minutes']}m")
    if s.get("hrv") is not None:
        bits.append(f"overnight HRV {s['hrv']:.0f} ms ({_signed(s.get('hrv_delta_pct'), '%')})")
    if s.get("rhr") is not None:
        bits.append(f"resting rate {s['rhr']:.0f} bpm ({_signed(s.get('rhr_delta_bpm'), 'bpm')})")
    if not bits:
        return "No overnight measurement reached the pipeline."
    return "; ".join(bits) + "."


def _overnight_plain(s):
    score = s.get("sleep_score")
    if score is None:
        return "There is no sleep reading for last night, so this paragraph has nothing to stand on."
    band = policy.sleep_band(score)
    # No article: "a adequate night" is exactly the kind of sentence that makes a
    # reader trust the rest of the page less.
    pieces = [f"Your own history calls that {band['label'].lower()}.", band["plain"]]
    if s.get("hrv_delta_pct") is not None and s["hrv_delta_pct"] < -8:
        pieces.append("Your variability came in under your normal range, which usually means the night did not fully repair you.")
    elif s.get("hrv_delta_pct") is not None and s["hrv_delta_pct"] > 8:
        pieces.append("Your variability came in above your normal range, which is what a night that repaired you looks like.")
    return " ".join(pieces)


def _load_clinical(load, trend):
    if not load or load.get("acwr") is None:
        steps = trend.get("mean") if trend else None
        if steps:
            return f"No exercise sessions in the last 28 days; movement is {steps:.0f} steps a day on average."
        return "No training load could be computed: no sessions and no movement history."
    band = policy.acwr_band(load["acwr"])
    return (
        f"Acute load {load['acute_minutes']} min against a chronic {load['chronic_minutes']} min/week, "
        f"a ratio of {load['acwr']:.2f} ({band['label'].lower()}), from {load['sessions_28d']} sessions in 28 days."
    )


def _load_plain(load):
    if not load or load.get("acwr") is None:
        return "There is not enough logged training here to say whether your load is climbing or settling."
    band = policy.acwr_band(load["acwr"])
    return band["plain"]


def _outlook_clinical(recovery_band, readiness_band, illness, acwr_band):
    parts = [f"Readiness: {readiness_band['label'].lower()}."]
    if acwr_band:
        parts.append(f"Load ratio band: {acwr_band['label'].lower()}.")
    if illness["level"] != "none":
        parts.append("Illness watch: " + ", ".join(illness["drivers"]) + ".")
    parts.append(f"Recovery band: {recovery_band['label'].lower()}.")
    return " ".join(parts)


def _outlook_plain(recovery_band, illness):
    text = recovery_band["plain"]
    if illness["level"] == "elevated":
        text += " Several of your own baselines moved at once, so the honest move is an easy day and a look at tomorrow's numbers."
    elif illness["level"] == "watch":
        text += " One reading is off. Train if you feel well, but do not chase a personal best on it."
    return text
