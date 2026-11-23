"""Offline tests: no network, no credentials, no published vault required."""

from __future__ import annotations

import base64
import json
import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bio_analytics as analytics
import bio_correlate
import bio_policy as policy
import clinical_engine
import demo_data
import encrypt_data
import sync
from provenance import DataQuality


def night(minutes=450, efficiency=92.0, deep=75, rem=100, day="2026-11-01"):
    return {
        "date": day,
        "minutes_asleep": minutes,
        "minutes_in_period": round(minutes / (efficiency / 100)) if efficiency else None,
        "efficiency": efficiency,
        "stages": {"deep": deep, "light": minutes - deep - rem, "rem": rem, "awake": 20},
        "bed_minutes": 23 * 60 + 15,
        "wake_minutes": 7 * 60,
        "is_main": True,
    }


class ClockTests(unittest.TestCase):
    def test_twelve_hour_clock(self):
        self.assertEqual(policy.format_clock(0), "12:00 AM")
        self.assertEqual(policy.format_clock(13 * 60 + 5), "1:05 PM")
        self.assertEqual(policy.format_clock(23 * 60 + 30), "11:30 PM")
        self.assertEqual(policy.format_clock(12 * 60), "12:00 PM")

    def test_bedtime_target_wraps(self):
        # 07:00 wake with a 7h30m need means 23:30 the night before.
        self.assertEqual(policy.bed_time_target(450, 7 * 60), 23 * 60 + 30)

    def test_local_minutes_uses_recorded_offset(self):
        # 22:00Z at +8h is 06:00 local, whatever the machine's own timezone is.
        self.assertEqual(analytics.minutes_after_midnight("2026-11-01T22:00:00Z", 8 * 3600), 6 * 60)


class BandTests(unittest.TestCase):
    def test_recovery_bands_are_ordered(self):
        self.assertEqual(policy.recovery_band(90)["key"], "primed")
        self.assertEqual(policy.recovery_band(72)["key"], "ready")
        self.assertEqual(policy.recovery_band(30)["key"], "depleted")

    def test_unmeasured_is_its_own_band(self):
        band = policy.recovery_band(None)
        self.assertEqual(band["key"], policy.UNMEASURED)
        self.assertEqual(band["tone"], "neutral")

    def test_every_band_has_a_sentence_and_a_known_tone(self):
        ladders = [
            policy.RECOVERY_BANDS,
            policy.SLEEP_BANDS,
            policy.SLEEP_EFFICIENCY_BANDS,
            policy.HRV_DELTA_BANDS,
            policy.RHR_DELTA_BANDS,
            policy.SPO2_BANDS,
            policy.RESP_DELTA_BANDS,
            policy.ACWR_BANDS,
            policy.LOAD_BANDS,
            policy.READINESS_BANDS,
        ]
        for ladder in ladders:
            for _, band in ladder:
                self.assertIn(band["tone"], policy.TONE_NAMES)
                self.assertTrue(band["plain"])
                self.assertTrue(band["label"])

    def test_hrv_delta_bands(self):
        self.assertEqual(policy.hrv_band(12)["key"], "above")
        self.assertEqual(policy.hrv_band(0)["key"], "at")
        self.assertEqual(policy.hrv_band(-12)["key"], "below")
        self.assertEqual(policy.hrv_band(-30)["key"], "well_below")

    def test_acwr_sweet_spot_is_inside_optimal(self):
        low, high = policy.ACWR_SWEET_SPOT
        self.assertEqual(policy.acwr_band(1.0)["key"], "optimal")
        self.assertEqual(policy.acwr_band(1.6)["key"], "high")
        self.assertEqual(policy.acwr_band(0.5)["key"], "detraining")
        self.assertTrue(low < 1.0 < high)


class SleepTests(unittest.TestCase):
    def test_summary_computes_efficiency_and_stages(self):
        summary = analytics.summarise_night(
            {
                "date": "2026-11-01",
                "minutes_asleep": 420,
                "minutes_in_period": 480,
                "stages": {"deep": 80, "light": 240, "rem": 100, "awake": 60},
                "onset_minutes": 1380,
                "wake_minutes": 420,
            }
        )
        self.assertEqual(summary["efficiency"], 87.5)
        self.assertEqual(summary["stages"]["deep"], 80)

    def test_summary_without_stages_keeps_none(self):
        summary = analytics.summarise_night(
            {"date": "2026-11-01", "minutes_asleep": 400, "minutes_in_period": 430}
        )
        self.assertIsNone(summary["stages"]["deep"])

    def test_score_is_monotone_in_duration(self):
        need = 480
        scores = [
            analytics.sleep_score(night(minutes=minutes), need)
            for minutes in (300, 360, 420, 480, 540)
        ]
        self.assertEqual(scores, sorted(scores))

    def test_score_is_monotone_in_efficiency(self):
        low = analytics.sleep_score(night(minutes=420, efficiency=70), 450)
        high = analytics.sleep_score(night(minutes=420, efficiency=96), 450)
        self.assertGreater(high, low)

    def test_score_is_bounded(self):
        self.assertLessEqual(analytics.sleep_score(night(minutes=2000), 400), 100)
        self.assertGreaterEqual(analytics.sleep_score(night(minutes=10), 480), 0)

    def test_score_without_efficiency_renormalises(self):
        partial = analytics.summarise_night({"date": "2026-11-01", "minutes_asleep": 450})
        score = analytics.sleep_score(partial, 450)
        self.assertIsNotNone(score)
        self.assertLessEqual(score, 100)

    def test_need_never_exceeds_the_cap(self):
        history = [night(minutes=240, day=f"2026-10-{d:02d}") for d in range(1, 15)]
        need = analytics.sleep_need(history)
        self.assertLessEqual(
            need["minutes"],
            policy.SLEEP_NEED_BASE_MINUTES + policy.SLEEP_NEED_MAX_EXTRA_MINUTES,
        )
        self.assertGreater(need["debt_minutes"], 0)

    def test_need_with_no_history_is_the_floor(self):
        need = analytics.sleep_need([])
        self.assertEqual(need["minutes"], policy.SLEEP_NEED_BASE_MINUTES)
        self.assertEqual(need["debt_minutes"], 0)

    def test_onset_after_midnight_is_late_not_early(self):
        history = [
            dict(night(minutes=420, day=f"2026-10-{d:02d}"), bed_minutes=40, wake_minutes=7 * 60)
            for d in range(1, 15)
        ]
        result = analytics.circadian(history)
        self.assertTrue(result["available"])
        self.assertEqual(result["median_onset"], "12:40 AM")


class LoadTests(unittest.TestCase):
    def test_acwr_math(self):
        today = date(2026, 11, 13)
        sessions = []
        # Seven 28-minute sessions, every fourth day: 56 min acute, 196 min over
        # 28 days -> a 49 min/week chronic line, so the ratio is 1.14.
        for offset in range(0, 28, 4):
            sessions.append({"date": (today - timedelta(days=offset)).isoformat(), "duration_minutes": 28})
        load = analytics.training_load(sessions, today=today)
        self.assertEqual(load["acute_minutes"], 56)
        self.assertEqual(load["chronic_minutes"], 49)
        self.assertAlmostEqual(load["acwr"], 1.14, places=2)

    def test_acwr_is_none_without_sessions(self):
        load = analytics.training_load([], today=date(2026, 11, 13))
        self.assertIsNone(load["acwr"])

    def test_day_load_is_bounded(self):
        self.assertEqual(analytics.day_load(0, 0, 0), 0)
        self.assertLessEqual(analytics.day_load(50_000, 300, 300), 100)

    def test_day_load_unmeasured(self):
        self.assertIsNone(analytics.day_load(None, None, None))


class ScoreTests(unittest.TestCase):
    def test_recovery_renormalises_over_measured_parts(self):
        full = analytics.recovery(
            {"hrv_delta_pct": 0, "rhr_delta_bpm": 0, "sleep_score": 80, "resp_delta": 0}
        )
        partial = analytics.recovery({"hrv_delta_pct": 0, "rhr_delta_bpm": 0, "sleep_score": 80})
        self.assertTrue(full["measured"])
        self.assertTrue(partial["measured"])
        self.assertEqual(sum(f["weight"] for f in partial["factors"]), 100)
        self.assertLessEqual(abs(full["score"] - partial["score"]), 5)

    def test_recovery_with_nothing_measured(self):
        result = analytics.recovery({})
        self.assertFalse(result["measured"])
        self.assertIsNone(result["score"])

    def test_bad_signals_lower_recovery(self):
        good = analytics.recovery(
            {"hrv_delta_pct": 15, "rhr_delta_bpm": -3, "sleep_score": 92, "resp_delta": 0}
        )
        bad = analytics.recovery(
            {"hrv_delta_pct": -25, "rhr_delta_bpm": 6, "sleep_score": 45, "resp_delta": 2}
        )
        self.assertGreater(good["score"], bad["score"])

    def test_readiness_penalises_a_spike(self):
        calm = analytics.readiness(80, 1.0)
        spiked = analytics.readiness(80, 1.8)
        self.assertGreater(calm, spiked)
        self.assertLessEqual(calm, 100)


class TrendTests(unittest.TestCase):
    def test_latest_is_not_positional(self):
        rows = [{"date": "2026-11-01"}, {"date": "2026-11-03"}, {"date": "2026-11-02"}]
        self.assertEqual(analytics.latest(rows)["date"], "2026-11-03")

    def test_pct_change(self):
        self.assertEqual(analytics.pct_change(50, 40), 25.0)
        self.assertIsNone(analytics.pct_change(None, 40))
        self.assertIsNone(analytics.pct_change(50, 0))

    def test_weekly_active_minutes_ignores_other_weeks(self):
        today = date(2026, 11, 13)  # a Friday
        daily = [
            {"date": "2026-11-09", "active_minutes": 30},
            {"date": "2026-11-11", "active_minutes": 20},
            {"date": "2026-11-02", "active_minutes": 90},
        ]
        week = analytics.weekly_active_minutes(daily, today=today)
        self.assertEqual(week["minutes"], 50)


class CorrelationTests(unittest.TestCase):
    def test_pearson_perfect(self):
        self.assertAlmostEqual(bio_correlate.pearson([(1, 2), (2, 4), (3, 6)]), 1.0, places=6)
        self.assertAlmostEqual(bio_correlate.pearson([(1, 6), (2, 4), (3, 2)]), -1.0, places=6)

    def test_pearson_handles_flat_series(self):
        self.assertIsNone(bio_correlate.pearson([(1, 1), (1, 2), (1, 3)]))

    def test_weak_pair_is_refused(self):
        channels = [
            {"date": f"2026-09-{d:02d}", "sleep_minutes": 400 + d, "hrv": 40 + (d % 2) * 20}
            for d in range(1, 29)
        ]
        result = bio_correlate.build_correlations(channels)
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["tested_pairs"], len(bio_correlate.CURATED_PAIRS))

    def test_strong_pair_is_published_with_a_sentence(self):
        channels = [
            {"date": f"d{d}", "sleep_minutes": 300 + d * 10, "hrv": 30 + d * 1.5}
            for d in range(30)
        ]
        result = bio_correlate.build_correlations(channels)
        self.assertTrue(result["findings"])
        finding = result["findings"][0]
        self.assertGreaterEqual(finding["n"], policy.CORRELATION_MIN_PAIRED_DAYS)
        self.assertGreaterEqual(abs(finding["r"]), policy.CORRELATION_MIN_R)
        self.assertTrue(finding["plain"])
        self.assertIn(finding["direction"], ("up", "down"))


class ProvenanceTests(unittest.TestCase):
    def test_gate_blocks_missing_core(self):
        dq = DataQuality()
        dq.record("sleep", True, "10 nights", "Sleep")
        dq.record("rhr", False, "none", "Resting heart rate")
        dq.record("hrv", True, "10 nights", "Overnight HRV")
        self.assertFalse(dq.publishable())
        self.assertEqual(dq.as_dict()["core_degraded"], ["Resting heart rate"])

    def test_gate_allows_complete_core(self):
        dq = DataQuality()
        for key in ("sleep", "rhr", "hrv"):
            dq.record(key, True, "ok", key)
        dq.record("spo2", False, "sparse", "Blood oxygen")
        self.assertTrue(dq.publishable())
        self.assertEqual(dq.as_dict()["live_count"], 3)
        self.assertEqual(dq.as_dict()["total_count"], 4)


class EncryptionTests(unittest.TestCase):
    def test_round_trip(self):
        envelope = encrypt_data.encrypt_payload('{"hello":"world"}', "passphrase", 1000)
        self.assertEqual(envelope["format"], "aes-256-gcm-pbkdf2")
        self.assertEqual(envelope["iterations"], 1000)
        self.assertEqual(
            encrypt_data.decrypt_payload(envelope, "passphrase"), '{"hello":"world"}'
        )

    def test_wrong_passphrase_fails(self):
        envelope = encrypt_data.encrypt_payload('{"hello":"world"}', "passphrase", 1000)
        with self.assertRaises(Exception):
            encrypt_data.decrypt_payload(envelope, "wrong")

    def test_tampered_ciphertext_fails(self):
        envelope = encrypt_data.encrypt_payload('{"hello":"world"}', "passphrase", 1000)
        raw = bytearray(base64.b64decode(envelope["data"]))
        raw[0] ^= 0x01
        envelope["data"] = base64.b64encode(bytes(raw)).decode()
        with self.assertRaises(Exception):
            encrypt_data.decrypt_payload(envelope, "passphrase")

    def test_no_default_passphrase_in_module(self):
        with open(encrypt_data.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn('DEFAULT_PASS = "', source)


class PayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dq = DataQuality()
        for key in (
            "sleep",
            "rhr",
            "hrv",
            "spo2",
            "resp",
            "steps",
            "calories",
            "active_minutes",
            "vo2max",
            "exercise",
            "heart_rate",
            "profile",
            "identity",
        ):
            dq.record(key, True, "synthetic", key)
        cls.payload = sync.build_payload(demo_data.synthetic_fetch(), dq, demo=True)

    def test_envelope(self):
        self.assertEqual(self.payload["schema"], 2)
        self.assertTrue(self.payload["demo"])
        self.assertIn("policy", self.payload)
        self.assertIn("data_quality", self.payload)

    def test_bands_are_resolved_not_thresholds(self):
        today = self.payload["today"]
        for key in ("sleep", "hrv", "rhr", "spo2", "resp", "recovery", "readiness"):
            self.assertIn("band", today[key])
            self.assertIn("tone", today[key]["band"])
            self.assertIn(today[key]["band"]["tone"], policy.TONE_NAMES)

    def test_scores_are_in_range(self):
        today = self.payload["today"]
        for key in ("recovery", "readiness"):
            score = today[key]["score"]
            self.assertGreaterEqual(score, 0)
            self.assertLessEqual(score, 100)

    def test_history_is_chronological(self):
        for key in ("sleep", "hrv", "rhr", "steps"):
            dates = [row["date"] for row in self.payload["history"][key]]
            self.assertEqual(dates, sorted(dates))

    def test_every_coaching_card_states_its_evidence(self):
        cards = self.payload["coaching"]["cards"]
        self.assertTrue(cards)
        for card in cards:
            for field in ("reading", "action", "progress", "back_off", "evidence"):
                self.assertTrue(card[field], f"{card['key']} is missing {field}")
            self.assertTrue(card["evidence"]["cite"])

    def test_clinical_narrative_is_two_voices(self):
        for paragraph in self.payload["clinical"]["paragraphs"]:
            self.assertTrue(paragraph["clinical"])
            self.assertTrue(paragraph["plain"])
        self.assertEqual(self.payload["clinical"]["score_source"], "deterministic")

    def test_json_serialisable(self):
        json.dumps(self.payload)


class MarkerTests(unittest.TestCase):
    def test_hrv_status_reads_week_against_baseline_band(self):
        start = date(2026, 1, 1)
        base = [{"date": (start + timedelta(days=i)).isoformat(), "value": 50.0 + (i % 2) * 4} for i in range(30)]
        low_week = [{"date": (start + timedelta(days=30 + i)).isoformat(), "value": 38.0} for i in range(7)]
        status = analytics.hrv_status(base + low_week)
        self.assertTrue(status["available"])
        self.assertEqual(status["band"]["key"], "low")
        self.assertEqual(status["week_ms"], 38.0)
        low, high = status["range_ms"]
        self.assertTrue(low < 52 < high)  # the band straddles the 50/54 baseline
        self.assertFalse(analytics.hrv_status(low_week)["available"])

    def test_intensity_mix_shares_hard_zone_minutes(self):
        sessions = [
            {"date": "2026-01-20", "zones": {"light": 20, "moderate": 40, "vigorous": 15, "peak": 5}},
            {"date": "2025-11-01", "zones": {"light": 0, "moderate": 0, "vigorous": 500, "peak": 0}},
        ]
        mix = analytics.intensity_mix(sessions, today="2026-01-28")
        self.assertEqual((mix["easy_minutes"], mix["hard_minutes"], mix["pct_hard"]), (60, 20, 25))
        self.assertEqual(mix["sessions"], 1)
        self.assertFalse(analytics.intensity_mix([], today="2026-01-28")["available"])

    def test_social_jetlag_compares_weekend_and_weekday_mid_sleep(self):
        nights = []
        for i in range(28):
            day = date(2026, 1, 5) + timedelta(days=i)  # 5 Jan 2026 is a Monday
            weekend = day.weekday() >= 5
            # Weekday 23:00-07:00 (mid 03:00); weekend 01:00-09:00 (mid 05:00).
            nights.append({"date": day.isoformat(), "bed_minutes": 60 if weekend else 1380, "wake_minutes": 540 if weekend else 420})
        jet = analytics.social_jetlag(nights)
        self.assertEqual(jet["minutes"], 120)
        self.assertTrue(jet["later_on_free_days"])
        self.assertEqual(jet["band"]["key"], "high")


class TrainingEffectTests(unittest.TestCase):
    def test_relative_scale_tops_out_at_your_hardest_sessions(self):
        sessions = [
            {"date": f"2026-01-{10 + i:02d}", "zones": {"light": 10, "moderate": 10 * (i + 1), "vigorous": 0, "peak": i}}
            for i in range(6)
        ]
        te = analytics.training_effect(sessions, today="2026-01-20")
        self.assertTrue(te["available"])
        hardest = te["sessions"][-1]
        self.assertEqual((hardest["aerobic"], hardest["anaerobic"]), (5.0, 5.0))
        # Session 1: aerobic load 2*20 = 40 against the top 2*60 = 120 (light counts 0).
        self.assertEqual(te["sessions"][1]["aerobic"], round(5 * 40 / 120, 1))
        self.assertEqual(te["sessions"][0]["anaerobic"], 0.0)
        self.assertFalse(analytics.training_effect(sessions[:3], today="2026-01-20")["available"])

    def test_a_light_zone_walk_scores_no_aerobic_effect(self):
        hard = [{"date": f"2026-01-{10 + i:02d}", "zones": {"light": 5, "moderate": 30, "vigorous": 10, "peak": 0}} for i in range(5)]
        walk = {"date": "2026-01-19", "zones": {"light": 32, "moderate": 0, "vigorous": 0, "peak": 0}}
        te = analytics.training_effect(hard + [walk], today="2026-01-20")
        self.assertEqual(te["easy_sessions"], 1)  # counted, not listed
        self.assertNotIn("2026-01-19", [s["date"] for s in te["sessions"]])

    def test_uth_vo2_estimate(self):
        # Age 30: max HR 208 - 21 = 187; 15.3 * 187 / 55 = 52.0
        self.assertEqual(analytics.vo2_uth(55, 30), 52.0)
        self.assertIsNone(analytics.vo2_uth(55, None))


class NarrativeTests(unittest.TestCase):
    def test_illness_needs_more_than_one_driver(self):
        one = clinical_engine.illness_signal({"rhr_delta_bpm": 7, "resp_delta": 0})
        two = clinical_engine.illness_signal({"rhr_delta_bpm": 7, "resp_delta": 2.4})
        self.assertEqual(one["level"], "watch")
        self.assertEqual(two["level"], "elevated")

    def test_illness_none_when_stable(self):
        self.assertEqual(clinical_engine.illness_signal({})["level"], "none")

    def test_missing_sleep_is_stated_not_invented(self):
        text = clinical_engine._overnight_plain({"sleep_score": None})
        self.assertIn("no sleep reading", text.lower())


if __name__ == "__main__":
    unittest.main()
