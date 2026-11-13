"""
Live-vs-fallback bookkeeping, and the gate that decides whether a run may publish.

The rule this module enforces: a metric group that was not measured is recorded
as such, and a run whose *core* physiology is missing refuses to publish at all.
A dashboard that silently substitutes a plausible placeholder is worse than one
that is down, because the placeholder is indistinguishable from a measurement.
"""

from __future__ import annotations

# A run missing any of these is not a biometrics dashboard.
CORE_METRICS = ("sleep", "rhr", "hrv")


class DataQuality:
    def __init__(self):
        self._metrics = {}

    def record(self, key, live, note, label=None):
        """Record where a metric group came from. `live` is a bool."""
        self._metrics[key] = {
            "label": label or key,
            "source": "live" if live else "missing",
            "note": note,
        }
        return self._metrics[key]

    def live(self, key):
        return self._metrics.get(key, {}).get("source") == "live"

    def as_dict(self):
        metrics = dict(self._metrics)
        degraded = [k for k, m in metrics.items() if m["source"] != "live"]
        total = len(metrics)
        live_count = total - len(degraded)
        core_degraded = [
            metrics[k]["label"] for k in CORE_METRICS if k in metrics and metrics[k]["source"] != "live"
        ]
        return {
            "metrics": metrics,
            "degraded": degraded,
            "live_count": live_count,
            "total_count": total,
            "live_pct": round(100 * live_count / total) if total else 0,
            "core_degraded": core_degraded,
        }

    def publishable(self):
        """The gate. True only when every core metric was actually measured."""
        quality = self.as_dict()
        return not quality["core_degraded"]
