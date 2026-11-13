"""
Relationships between the athlete's own daily channels.

Pure arithmetic over series that were already measured: Pearson's r on paired
days, with a floor on how many days must pair and how large the coefficient must
be. A pair below either floor is refused rather than published as a "pattern",
because an r of 0.2 over nine days is noise wearing a lab coat.

Every published finding states the direction it measured — including the
direction the research would not have predicted.
"""

from __future__ import annotations

import math

import bio_policy as policy

# Curated pairs only. Each entry names the two channels and the two sentences
# that describe a positive and a negative association.
CURATED_PAIRS = [
    {
        "a": "sleep_minutes",
        "b": "hrv",
        "a_label": "sleep (h)",
        "b_label": "overnight HRV (ms)",
        "pos": "Longer nights come with higher overnight HRV.",
        "neg": "Longer nights come with lower overnight HRV here.",
        "why": "Slow-wave sleep is when parasympathetic tone recovers, so a full night usually shows up as higher morning HRV.",
        "scale_a": 1 / 60.0,
    },
    {
        "a": "steps",
        "b": "rhr",
        "a_label": "steps",
        "b_label": "resting rate (bpm)",
        "pos": "More movement comes with a higher resting rate.",
        "neg": "More movement comes with a lower resting rate.",
        "why": "Regular aerobic movement usually lowers resting heart rate over weeks; a single big day can raise it overnight.",
    },
    {
        "a": "steps",
        "b": "sleep_minutes",
        "a_label": "steps",
        "b_label": "sleep (h)",
        "pos": "Bigger days come with longer nights.",
        "neg": "Bigger days come with shorter nights here.",
        "why": "Physical activity raises sleep pressure, which usually lengthens the following night.",
        "scale_b": 1 / 60.0,
    },
    {
        "a": "hrv",
        "b": "rhr",
        "a_label": "HRV (ms)",
        "b_label": "resting rate (bpm)",
        "pos": "Higher HRV comes with a higher resting rate.",
        "neg": "Higher HRV comes with a lower resting rate.",
        "why": "Both are autonomic readings: a well-recovered system usually shows high variability and a low resting rate together.",
    },
    {
        "a": "resp",
        "b": "hrv",
        "a_label": "breathing (brpm)",
        "b_label": "HRV (ms)",
        "pos": "Faster overnight breathing comes with higher HRV.",
        "neg": "Faster overnight breathing comes with lower HRV.",
        "why": "Breathing rate and variability both shift with autonomic state, and a rising breathing rate often accompanies strain.",
    },
    {
        "a": "spo2",
        "b": "resp",
        "a_label": "SpO2 (%)",
        "b_label": "breathing (brpm)",
        "pos": "Higher oxygen saturation comes with faster breathing.",
        "neg": "Higher oxygen saturation comes with slower breathing.",
        "why": "Oxygen saturation and breathing rate are coupled on a nightly basis, though a wrist sensor measures both loosely.",
    },
]


def pearson(pairs):
    """Pearson's r over [(x, y)]. Returns None when the series cannot support it."""
    n = len(pairs)
    if n < 3:
        return None
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    syy = sum((y - mean_y) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in pairs)
    return sxy / math.sqrt(sxx * syy)


def build_correlations(channels, window_days=None):
    """Publish only the pairs that clear both floors."""
    window_days = window_days or policy.CORRELATION_WINDOW_DAYS
    window = [c for c in channels if c][-window_days:]

    findings = []
    for pair in CURATED_PAIRS:
        a_key, b_key = pair["a"], pair["b"]
        pairs = [
            (row[a_key], row[b_key])
            for row in window
            if row.get(a_key) is not None and row.get(b_key) is not None
        ]
        r = pearson(pairs)
        if r is None:
            continue
        if len(pairs) < policy.CORRELATION_MIN_PAIRED_DAYS:
            continue
        if abs(r) < policy.CORRELATION_MIN_R:
            continue

        direction = "pos" if r > 0 else "neg"
        findings.append(
            {
                "a": a_key,
                "b": b_key,
                "a_label": pair["a_label"],
                "b_label": pair["b_label"],
                "r": round(r, 2),
                "n": len(pairs),
                "direction": "up" if r > 0 else "down",
                "plain": pair[direction],
                # The mechanism note is the *why*; the sentence above is the *what*.
                "why": pair["why"],
            }
        )

    findings.sort(key=lambda f: abs(f["r"]), reverse=True)
    return {
        "findings": findings,
        "tested_pairs": len(CURATED_PAIRS),
        "window_days": window_days,
        "min_paired_days": policy.CORRELATION_MIN_PAIRED_DAYS,
        "min_r": policy.CORRELATION_MIN_R,
    }
