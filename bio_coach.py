"""
Prescriptions: what to do about the numbers.

Pure rules over readings that were already measured. Every card carries the
reading, one concrete action, how it progresses, the condition that cancels it,
and the study it came from with what that study does *not* settle.

A domain with no measured history publishes no prescription. Telling someone to
"start with 8,000 steps" when the account has never logged a step is a guess
wearing a lab coat.
"""

from __future__ import annotations

import bio_policy as policy


def _card(key, title, reading, action, progress, back_off, evidence, tone, measured=True):
    return {
        "key": key,
        "title": title,
        "reading": reading,
        "action": action,
        "progress": progress,
        "back_off": back_off,
        "evidence": evidence,
        "tone": tone,
        "measured": measured,
    }


def _not_measured(key, title, what):
    return _card(
        key,
        title,
        f"NOT MEASURED — no {what} in the account yet.",
        f"Wear the device for a few days and the first {what} becomes the starting point.",
        "Nothing to progress until a baseline exists.",
        "n/a",
        policy.EVIDENCE.get(key, policy.EVIDENCE["steps"]),
        "neutral",
        measured=False,
    )


def build_coaching(signals, load, movement, sleep_score, acwr):
    cards = []

    # -- recovery and load ---------------------------------------------------
    if acwr is None:
        cards.append(_not_measured("load", "Recovery & load", "logged training session"))
    else:
        band = policy.acwr_band(acwr)
        if acwr > 1.3:
            action = (
                f"Cut next week to about {load['chronic_minutes']} minutes — your chronic weekly "
                "average — and keep the hard sessions out of it."
            )
            progress = "Hold that volume for two weeks; the ratio comes back under 1.3 on its own."
            back_off = "Any session that leaves you sore for more than 48 hours cancels the plan."
            tone = "warn"
        elif acwr < 0.8:
            action = (
                f"Add about {max(20, round((load['chronic_minutes'] or 0) * 0.2))} minutes next week, "
                "spread over two or three easy sessions."
            )
            progress = "Climb by no more than 10% a week until the ratio sits between 0.8 and 1.3."
            back_off = "Stop climbing when resting rate is up more than 5 bpm for two mornings."
            tone = "neutral"
        else:
            action = "Keep the week where it is — your load is climbing at a rate you already tolerate."
            progress = "Repeat this week; the ratio should stay inside 0.8-1.3 as the chronic line catches up."
            back_off = "Two consecutive mornings with HRV 20% under baseline is the signal to deload."
            tone = "good"
        cards.append(
            _card(
                "load",
                "Recovery & load",
                f"Acute {load['acute_minutes']} min vs chronic {load['chronic_minutes']} min/week — "
                f"ratio {acwr:.2f} ({band['label'].lower()}).",
                action,
                progress,
                back_off,
                policy.EVIDENCE["load"],
                tone,
            )
        )

    # -- sleep ---------------------------------------------------------------
    if sleep_score is None:
        cards.append(_not_measured("sleep", "Sleep", "night of sleep data"))
    else:
        band = policy.sleep_band(sleep_score)
        if sleep_score < 70:
            action = "Move bedtime 30 minutes earlier for the next five nights — not wake-up time."
            progress = "A 70+ night should arrive within a week at the same wake time."
            back_off = "If you are lying awake for 30 minutes, keep the old bedtime for a night."
            tone = "warn"
        else:
            action = "Protect the current bedtime; it is producing the night your body is asking for."
            progress = "Keep the wake time fixed, including weekends — regularity carries more than length."
            back_off = "A night under 6h30m resets the plan: take the earlier bedtime again."
            tone = "good"
        cards.append(
            _card(
                "sleep",
                "Sleep",
                f"Last night scores {sleep_score}/100 ({band['label'].lower()}).",
                action,
                progress,
                back_off,
                policy.EVIDENCE["sleep"] if sleep_score < 70 else policy.EVIDENCE["regularity"],
                tone,
            )
        )

    # -- daily movement ------------------------------------------------------
    steps_mean = movement.get("steps_mean")
    week = movement.get("week") or {}
    if steps_mean is None and week.get("minutes") is None:
        cards.append(_not_measured("steps", "Daily movement", "step count"))
    else:
        below_floor = (week.get("minutes") or 0) < policy.WEEKLY_ACTIVE_MINUTES_TARGET
        week_phrase = "."
        if week.get("minutes") is not None:
            recorded = week.get("days")
            partial = (
                f" across {recorded} recorded days" if recorded and recorded < 7 else ""
            )
            week_phrase = (
                f", {week.get('minutes')} of {policy.WEEKLY_ACTIVE_MINUTES_TARGET} active minutes"
                f" this week{partial}."
            )
        cards.append(
            _card(
                "steps",
                "Daily movement",
                f"{steps_mean:.0f} steps a day on average{week_phrase}",
                (
                    f"Add a 15-minute walk on the days you are under {int(steps_mean or 0):,} steps."
                    if below_floor
                    else "Hold the weekly active minutes where they are; you are above the floor."
                ),
                (
                    "Add 500 steps a day per week until the weekly active minutes clear 150."
                    if below_floor
                    else "Hold the weekly total above 150 minutes and keep the step floor steady."
                ),
                "Stop adding when a day's steps start costing you the next night's sleep.",
                policy.EVIDENCE["steps"],
                "warn" if below_floor else "good",
            )
        )

    # -- cardio fitness ------------------------------------------------------
    capacity = movement.get("vo2max")
    if capacity is None:
        cards.append(_not_measured("strength", "Cardio fitness", "VO2 max estimate"))
    else:
        cards.append(
            _card(
                "strength",
                "Cardio fitness",
                f"VO2 max {capacity:.0f} ml/kg/min from the device's own estimate.",
                "Two easy aerobic sessions a week is the cheapest way to move this number.",
                "It moves over months, not days — check it monthly, not nightly.",
                "Do not chase it while recovery is below 55; the adaptation is made in rest.",
                policy.EVIDENCE["strength"],
                "good",
            )
        )

    return {"cards": cards}


COACH_PRIORITY = ("load", "sleep", "steps", "strength")


def today_focus(cards):
    """The one card to read first, by a stated tie-break rather than by order."""
    by_key = {card["key"]: card for card in cards}
    for key in COACH_PRIORITY:
        card = by_key.get(key)
        if card and card.get("tone") in ("bad", "warn"):
            return card["key"]
    for key in COACH_PRIORITY:
        card = by_key.get(key)
        if card:
            return card["key"]
    return None
