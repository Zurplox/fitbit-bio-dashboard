"""
The single source of meaning for this project.

Every threshold, band, tone and human-readable label lives here. Neither the
analytics nor the browser may compare a measurement against a number of its own:
the payload ships resolved bands, so the gauge, the badge and the coaching card
cannot disagree about what a 62 means.

`TONE_NAMES` is the entire colour vocabulary. A tone never names a colour —
the page owns the palette — it names a *meaning* the page then paints.
"""

from __future__ import annotations

# The whole colour vocabulary. `neutral` is for "measured, no verdict".
TONE_NAMES = ("good", "warn", "bad", "neutral")

UNMEASURED = "unmeasured"

# A band is a dict: key (stable), label (short), plain (a sentence), tone.
def _band(key, label, plain, tone):
    return {"key": key, "label": label, "plain": plain, "tone": tone}


# --------------------------------------------------------------------------
# Recovery — a 0-100 composite, higher is better. Computed in bio_analytics.
# --------------------------------------------------------------------------
RECOVERY_BANDS = [
    (85, _band("primed", "Primed", "Your body is ready for a hard session today.", "good")),
    (70, _band("ready", "Ready", "You can train normally. Nothing is asking you to hold back.", "good")),
    (55, _band("steady", "Steady", "Train, but keep the hard work short and stop while it still feels easy.", "warn")),
    (40, _band("strained", "Strained", "Your recovery signals are depressed. Treat today as maintenance, not progress.", "warn")),
    (0, _band("depleted", "Depleted", "Rest is the training today. Hard work now buys nothing you will keep.", "bad")),
]

# --------------------------------------------------------------------------
# Sleep — a 0-100 composite of duration, efficiency and stage balance.
# --------------------------------------------------------------------------
SLEEP_BANDS = [
    (85, _band("restorative", "Restorative", "A night that did its job.", "good")),
    (70, _band("adequate", "Adequate", "Enough to function, short of what repairs you.", "good")),
    (55, _band("short", "Short", "You slept less than your body asked for.", "warn")),
    (0, _band("poor", "Poor", "This night cost you recovery you will feel today.", "bad")),
]

# Sleep efficiency = minutes asleep / minutes in bed.
SLEEP_EFFICIENCY_BANDS = [
    (90, _band("excellent", "Excellent", "You were asleep almost the whole time you were in bed.", "good")),
    (85, _band("good", "Good", "A settled night with little time awake.", "good")),
    (75, _band("fair", "Fair", "You lost a noticeable slice of the night to wakefulness.", "warn")),
    (0, _band("poor", "Poor", "A large share of your time in bed was not sleep.", "bad")),
]

# Sleep need: person-independent floor plus the debt the week accumulated.
SLEEP_NEED_BASE_MINUTES = 450  # 7h30m — the adult floor used when no personal data exists
SLEEP_DEBT_WINDOW_DAYS = 14
SLEEP_DEBT_PAYDOWN_SHARE = 0.25  # a quarter of the debt is added to tonight's ask
SLEEP_NEED_MAX_EXTRA_MINUTES = 90  # recovery is a slope, not an overnight debt repayment

# --------------------------------------------------------------------------
# Heart rate variability — measured as RMSSD in ms, judged against the
# athlete's own 30-night median (never a population table).
# --------------------------------------------------------------------------
HRV_DELTA_BANDS = [
    (8, _band("above", "Above baseline", "Your nervous system is more recovered than usual.", "good")),
    (-8, _band("at", "At baseline", "Within your normal night-to-night range.", "good")),
    (-20, _band("below", "Below baseline", "Your variability is lower than your own normal.", "warn")),
    (-1000, _band("well_below", "Well below", "A clear suppression against your own baseline.", "bad")),
]
HRV_BASELINE_NIGHTS = 30
HRV_MIN_NIGHTS = 5

# --------------------------------------------------------------------------
# Resting heart rate — judged against the athlete's own 30-day median.
# --------------------------------------------------------------------------
RHR_DELTA_BANDS = [
    (3, _band("elevated", "Elevated", "Your resting rate is up. That often precedes illness or a hard load.", "bad")),
    (1, _band("slightly_up", "Slightly up", "A small rise against your own baseline.", "warn")),
    (-2, _band("stable", "Stable", "Sitting where your body usually sits.", "good")),
    (-100, _band("low", "Low", "Below your usual resting rate.", "good")),
]
RHR_BASELINE_DAYS = 30

# --------------------------------------------------------------------------
# Blood oxygen (SpO2), from nightly or on-demand readings. Sparse by nature.
# --------------------------------------------------------------------------
SPO2_BANDS = [
    (95, _band("normal", "Normal", "Within the range a wrist sensor reports as normal.", "good")),
    (90, _band("watch", "Watch", "Below the usual nightly range. Repeat measurements before reading anything into one night.", "warn")),
    (0, _band("low", "Low", "A low reading. If it repeats, this is a conversation for a clinician, not a dashboard.", "bad")),
]

# --------------------------------------------------------------------------
# Breathing rate during sleep — judged against the athlete's own baseline.
# --------------------------------------------------------------------------
RESP_DELTA_BANDS = [
    (2.0, _band("elevated", "Elevated", "Breathing faster than your own normal at night is an early illness signal.", "warn")),
    (-2.0, _band("stable", "In range", "Your overnight breathing is where it usually is.", "good")),
    (-100, _band("low", "Below range", "Slower than your own normal.", "neutral")),
]
RESP_BASELINE_NIGHTS = 30

# --------------------------------------------------------------------------
# Training load — acute (7 day) against chronic (28 day) minutes.
# Gabbett 2016: the ratio, not the volume, is what correlates with injury.
# --------------------------------------------------------------------------
ACWR_BANDS = [
    (1.5, _band("high", "Spiking", "A jump this large is where injury risk concentrates.", "bad")),
    (1.3, _band("caution", "Caution", "Climbing faster than the last month prepared you for.", "warn")),
    (0.8, _band("optimal", "Optimal", "Loading at a rate your recent training supports.", "good")),
    (0, _band("detraining", "Detraining", "Well under your recent load. Fine for a deload, less fine for a month.", "neutral")),
]
ACWR_SWEET_SPOT = (0.8, 1.3)

# --------------------------------------------------------------------------
# Day load — a 0-100 reading of how much work the day contained.
# --------------------------------------------------------------------------
LOAD_BANDS = [
    (80, _band("heavy", "Heavy", "A big day. It has to be paid for with rest.", "warn")),
    (50, _band("moderate", "Moderate", "Real work, comfortably inside what you normally do.", "good")),
    (20, _band("light", "Light", "Movement without much strain.", "good")),
    (0, _band("rest", "Rest", "Almost no load recorded.", "neutral")),
]

# --------------------------------------------------------------------------
# Readiness — recovery tempered by how fast load is climbing.
# --------------------------------------------------------------------------
READINESS_BANDS = [
    (80, _band("green", "Green light", "Recovery and load both support training hard.", "good")),
    (60, _band("amber", "Amber", "Train, but keep intensity honest.", "warn")),
    (40, _band("red", "Red", "Back off. The numbers are not asking for more.", "warn")),
    (0, _band("hold", "Hold", "Recovery first. Training can wait a day.", "bad")),
]

# --------------------------------------------------------------------------
# Targets and windows.
# --------------------------------------------------------------------------
DEFAULT_STEP_GOAL = 10_000
WEEKLY_ACTIVE_MINUTES_TARGET = 150  # WHO floor for moderate-equivalent minutes
SLEEP_HISTORY_DAYS = 90
CORRELATION_WINDOW_DAYS = 90
CORRELATION_MIN_PAIRED_DAYS = 14
CORRELATION_MIN_R = 0.35
FRESHNESS_STALE_HOURS = 30

# --------------------------------------------------------------------------
# Coaching evidence. One study per rule, published with what it does NOT settle.
# --------------------------------------------------------------------------
EVIDENCE = {
    "load": {
        "cite": "Gabbett 2016, Br J Sports Med",
        "found": "Large week-to-week changes in training load are associated with higher injury rates.",
        "not": "It is an association in team sport, not proof that one hard week injures one person.",
    },
    "sleep": {
        "cite": "Mah 2011, Sleep",
        "found": "Extending sleep in athletes improved sprint times, reaction time and mood.",
        "not": "It does not establish an optimal number of hours for you specifically.",
    },
    "hrv": {
        "cite": "Vesterinen 2016, Int J Sports Physiol Perform",
        "found": "Training guided by daily HRV produced better endurance adaptation than fixed plans.",
        "not": "It does not mean a single low morning reading should cancel a session.",
    },
    "steps": {
        "cite": "Paluch 2022, Lancet Public Health",
        "found": "Mortality risk falls steeply up to roughly 6,000-8,000 daily steps, then flattens.",
        "not": "Step counts are not a complete measure of activity, and causality is not established.",
    },
    "strength": {
        "cite": "Schoenfeld 2016, J Sports Sci",
        "found": "Training a muscle twice a week produced more growth than once a week at equal volume.",
        "not": "It says nothing about the best split for an individual sport.",
    },
    "regularity": {
        "cite": "Windred 2024, Sleep",
        "found": "Sleep regularity predicted mortality better than total sleep duration.",
        "not": "Observational: irregular sleep may mark other things that also affect health.",
    },
}


def _pick(ladder, value):
    """Return the first band whose floor the value clears. Ladders are descending."""
    if value is None:
        return _band(UNMEASURED, "Not measured", "No measurement to read.", "neutral")
    for floor, band in ladder:
        if value >= floor:
            return band
    return ladder[-1][1]


def recovery_band(score):
    return _pick(RECOVERY_BANDS, score)


def sleep_band(score):
    return _pick(SLEEP_BANDS, score)


def sleep_efficiency_band(pct):
    return _pick(SLEEP_EFFICIENCY_BANDS, pct)


def hrv_band(delta_pct):
    return _pick(HRV_DELTA_BANDS, delta_pct)


def rhr_band(delta_bpm):
    return _pick(RHR_DELTA_BANDS, delta_bpm)


def spo2_band(pct):
    return _pick(SPO2_BANDS, pct)


def resp_band(delta):
    return _pick(RESP_DELTA_BANDS, delta)


def acwr_band(ratio):
    return _pick(ACWR_BANDS, ratio)


def load_band(score):
    return _pick(LOAD_BANDS, score)


def readiness_band(score):
    return _pick(READINESS_BANDS, score)


def bed_time_target(sleep_need_minutes, wake_time_minutes):
    """The clock time to be asleep by, from the need and the wake time.

    Both arguments are minutes after midnight; the result wraps, so a 07:00
    wake with a 7h30m need gives 23:30 the previous evening.
    """
    if sleep_need_minutes is None or wake_time_minutes is None:
        return None
    return (wake_time_minutes - sleep_need_minutes) % (24 * 60)


def format_clock(minutes_after_midnight):
    """12-hour clock, e.g. 23:30 -> '11:30 PM'. Never '23:30 PM'."""
    if minutes_after_midnight is None:
        return None
    minutes = int(minutes_after_midnight) % (24 * 60)
    hour24, minute = divmod(minutes, 60)
    suffix = "AM" if hour24 < 12 else "PM"
    hour12 = hour24 % 12 or 12
    return f"{hour12}:{minute:02d} {suffix}"


def metric_labels():
    """Human names, so the page never invents its own vocabulary."""
    return {
        "sleep": "Sleep",
        "hrv": "Overnight HRV",
        "rhr": "Resting heart rate",
        "spo2": "Blood oxygen",
        "resp": "Breathing rate",
        "steps": "Steps",
        "active_minutes": "Active minutes",
        "calories": "Calories",
        "vo2max": "Cardio fitness (VO2 max)",
        "load": "Training load",
        "recovery": "Recovery",
        "readiness": "Readiness",
    }


def policy_snapshot():
    """The slice of policy the browser needs at render time.

    The page reads these to draw a gauge's scale and to know when data is stale.
    It never compares a measurement to a threshold of its own — every band it
    paints arrives already resolved.
    """
    return {
        "tones": list(TONE_NAMES),
        "recovery_max": 100,
        "sleep_max": 100,
        "load_max": 100,
        "readiness_max": 100,
        "acwr_sweet_spot": list(ACWR_SWEET_SPOT),
        "stale_after_hours": FRESHNESS_STALE_HOURS,
        "step_goal_default": DEFAULT_STEP_GOAL,
        "weekly_active_minutes_target": WEEKLY_ACTIVE_MINUTES_TARGET,
        "labels": metric_labels(),
    }
