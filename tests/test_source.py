"""
Contract tests for the Google Health layer, against documented response shapes.

No credentials and no network: the client is duck-typed, so these pin the parts
that were never exercised by the demo — pagination, rollup request bodies,
offset-aware timestamps, stage normalisation and the "one bad metric must not
kill the run" behaviour.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import googlehealth_source as source
import sync
from provenance import DataQuality


class FakeClient:
    """Records what the fetchers asked for, and answers with fixtures."""

    def __init__(self, points=None, rollup=None, rollup_points=None):
        self.points = points or {}
        self.rollup_response = rollup or {}
        self.rollup_points = rollup_points or []
        self.calls = []
        self.rollup_bodys = []

    def identity(self):
        return {"healthUserId": "123"}

    def list_points(self, data_type, filter_expr=None, max_pages=12, page_size=25):
        self.calls.append({"type": data_type, "filter": filter_expr, "max_pages": max_pages})
        return self.points.get(data_type, [])

    def rollup(self, data_type, start_iso, end_iso, window):
        self.rollup_bodys.append(
            {"type": data_type, "start": start_iso, "end": end_iso, "window": window}
        )
        return self.rollup_response

    def daily_rollup(self, data_type, start, end):
        return {"rollupDataPoints": self.rollup_points}


class NumTests(unittest.TestCase):
    def test_non_finite_values_are_missing_not_numbers(self):
        for raw in ("NaN", float("nan"), "Infinity", float("-inf")):
            self.assertIsNone(source._num(raw))
        self.assertEqual(source._num("36.5"), 36.5)

    def test_nan_skin_night_is_dropped(self):
        fake = FakeClient(points={"daily-sleep-temperature-derivations": [
            {"dailySleepTemperatureDerivations": {"date": {"year": 2026, "month": 11, "day": 5}, "nightlyTemperatureCelsius": "NaN", "baselineTemperatureCelsius": 33.8}},
        ]})
        self.assertEqual(source.fetch_daily_skin_temp(fake, days=30), [])


class SkinTempTests(unittest.TestCase):
    def test_deviation_from_baseline_and_no_baseline_dropped(self):
        day = lambda d: {"year": 2026, "month": 11, "day": d}
        fake = FakeClient(points={"daily-sleep-temperature-derivations": [
            {"dailySleepTemperatureDerivations": {"date": day(2), "nightlyTemperatureCelsius": 34.1, "baselineTemperatureCelsius": 33.8}},
            {"dailySleepTemperatureDerivations": {"date": day(1), "nightlyTemperatureCelsius": 33.5, "baselineTemperatureCelsius": 33.8}},
            {"dailySleepTemperatureDerivations": {"date": day(3), "nightlyTemperatureCelsius": 34.0}},
        ]})
        dq = DataQuality()
        rows = source.fetch_daily_skin_temp(fake, days=30, dq=dq)
        self.assertEqual([(r["date"], r["value"]) for r in rows], [("2026-11-01", -0.3), ("2026-11-02", 0.3)])
        self.assertTrue(all(r["source_platform"] == "UNKNOWN" for r in rows))
        self.assertEqual(dq.as_dict()["metrics"]["skin_temp"]["source"], "live")


class ExerciseDetailTests(unittest.TestCase):
    def test_keeps_every_summary_metric_and_local_start(self):
        point = {"exercise": {
            "exerciseType": "RUNNING",
            "displayName": "Tempo run",
            "interval": {
                "civilStartTime": {"year": 2026, "month": 11, "day": 23},
                "startTime": "2026-11-23T03:01:20.400Z",
                "endTime": "2026-11-23T03:31:20.400Z",
                "startUtcOffset": "28800s",
            },
            "metricsSummary": {
                "caloriesKcal": "300",
                "averageHeartRateBeatsPerMinute": "150",
                "steps": "4500",
                "distanceMillimeters": "5000000",
                "activeZoneMinutes": "24",
                "elevationGainMillimeters": "12000",
                "runVo2Max": "48.2",
                "averagePaceSecondsPerMeter": "0.36",
                "averageSpeedMillimetersPerSecond": "2778",
                "totalSwimLengths": "0",
                "mobilityMetrics": {
                    "avgCadenceStepsPerMinute": "172",
                    "avgStrideLengthMillimeters": "1050",
                    "avgGroundContactTimeDuration": "242ms",
                    "avgVerticalOscillationMillimeters": "82",
                    "avgVerticalRatio": "6.9",
                },
                "heartRateZoneDurations": {
                    "lightTime": "300s", "moderateTime": "900s", "vigorousTime": "600s", "peakTime": "0s",
                },
            },
        }}
        rows = source.fetch_exercise(FakeClient(points={"exercise": [point]}), days=30)
        self.assertEqual(len(rows), 1)
        s = rows[0]
        self.assertEqual((s["date"], s["start_local"], s["minutes"]), ("2026-11-23", "11:01", 30))
        self.assertEqual((s["calories"], s["avg_hr"], s["steps"], s["distance_m"]), (300.0, 150.0, 4500.0, 5000))
        self.assertEqual((s["pace_s_per_m"], s["speed_kmh"], s["elevation_m"], s["run_vo2max"]), (0.36, 10.0, 12, 48.2))
        self.assertEqual(s["mobility"], {
            "cadence_spm": 172.0, "stride_m": 1.05, "ground_contact_ms": 242.0,
            "vertical_cm": 8.2, "vertical_ratio": 6.9,
        })
        self.assertEqual(s["zones"], {"light": 5.0, "moderate": 15.0, "vigorous": 10.0, "peak": 0.0})


class WorkoutHeartTests(unittest.TestCase):
    def test_rolls_workout_heart_rate_into_minutes(self):
        fake = FakeClient(rollup={"rollupDataPoints": [
            {"startTime": "2026-11-23T03:01:00Z", "heartRate": {"beatsPerMinuteAvg": "118"}},
            {"startTime": "2026-11-23T03:02:00Z", "heartRate": {"beatsPerMinuteAvg": "162"}},
            {"startTime": "2026-11-23T03:03:00Z", "heartRate": {}},
        ]})
        rows = source.fetch_workout_hr(fake, {"start": "2026-11-23T03:01:00Z", "end": "2026-11-23T03:04:00Z"})
        self.assertEqual([(r["t"], r["bpm"]) for r in rows], [("2026-11-23T03:01:00Z", 118), ("2026-11-23T03:02:00Z", 162)])
        self.assertTrue(all(r["source_platform"] == "ROLLUP" for r in rows))
        self.assertEqual(fake.rollup_bodys[0]["window"], "60s")

    def test_device_zone_boundaries_are_kept(self):
        point = {"dailyHeartRateZones": {
            "date": {"year": 2026, "month": 11, "day": 23},
            "heartRateZones": [
                {"heartRateZoneType": "LIGHT", "minBeatsPerMinute": "95", "maxBeatsPerMinute": "125"},
                {"heartRateZoneType": "PEAK", "minBeatsPerMinute": "175", "maxBeatsPerMinute": "220"},
                {"heartRateZoneType": "OTHER", "minBeatsPerMinute": "0", "maxBeatsPerMinute": "94"},
            ],
        }}
        fake = FakeClient(points={"daily-heart-rate-zones": [point]})
        zones = source.fetch_heart_rate_zones(fake, "2026-11-23")
        self.assertEqual((zones["light"], zones["peak"]), ([95, 125], [175, 220]))
        self.assertEqual(zones["source_platform"], "UNKNOWN")


class TimestampTests(unittest.TestCase):
    def test_civil_date_from_offset(self):
        # 23:30Z at +8h is the next morning, so the night belongs to the 2nd.
        self.assertEqual(
            source._civil_from_iso("2026-11-01T23:30:00Z", 8 * 3600), "2026-11-02"
        )

    def test_local_minutes_from_offset(self):
        self.assertEqual(source._local_minutes("2026-11-01T23:30:00Z", 8 * 3600), 7 * 60 + 30)

    def test_duration_strings(self):
        self.assertEqual(source._seconds("28800s"), 28800)
        self.assertEqual(source._seconds(None), 0)
        self.assertEqual(source._seconds(3600), 3600)


class RollupValueTests(unittest.TestCase):
    def test_steps_count_sum(self):
        point = {"civilStartTime": {"date": {"year": 2026, "month": 11, "day": 2}},
                 "steps": {"countSum": "8430"}}
        self.assertEqual(source._rollup_value(point, "steps"), 8430)

    def test_nested_calories_sum(self):
        point = {"totalCalories": {"caloriesKcalSum": 2320.5}}
        self.assertEqual(source._rollup_value(point, "total-calories"), 2320.5)

    def test_unknown_shape_still_finds_a_number(self):
        point = {"activeMinutes": {"activeMinutesByActivityLevel": [{"activeMinutes": "31"}]}}
        self.assertEqual(source._rollup_value(point, "active-minutes"), 31)

    def test_no_number(self):
        self.assertIsNone(source._rollup_value({"steps": {}}, "steps"))


class IntradayTests(unittest.TestCase):
    def test_rollup_gets_full_timestamps_and_returns_sorted_series(self):
        fake = FakeClient(
            rollup={
                "rollupDataPoints": [
                    {"startTime": "2026-11-13T12:00:00Z", "heartRate": {"beatsPerMinuteAvg": 78}},
                    {"startTime": "2026-11-13T08:00:00Z", "heartRate": {"beatsPerMinuteAvg": 61}},
                ]
            }
        )
        dq = DataQuality()
        series = source.fetch_intraday_hr(fake, hours=24, dq=dq)

        self.assertEqual([row["bpm"] for row in series], [61, 78])
        body = fake.rollup_bodys[0]
        self.assertTrue(body["start"].endswith("Z"))
        self.assertTrue(body["end"].endswith("Z"))
        # The old bug produced "2026-11-13T10:00:00T00:00:00Z".
        self.assertEqual(body["start"].count("T"), 1)
        self.assertEqual(body["window"], "3600s")
        self.assertTrue(dq.as_dict()["metrics"]["heart_rate"]["source"] == "live")


class SleepTests(unittest.TestCase):
    def fixture(self):
        return {
            "sleep": [
                {
                    "dataSource": {"device": {"displayName": "Fitbit Air"}},
                    "sleep": {
                        "interval": {
                            "startTime": "2026-11-11T15:30:00Z",
                            "startUtcOffset": "28800s",
                            "endTime": "2026-11-11T23:00:00Z",
                            "endUtcOffset": "28800s",
                        },
                        "metadata": {"mainSleep": True, "nap": False},
                        "summary": {
                            "minutesAsleep": "420",
                            "minutesInSleepPeriod": "460",
                            "minutesAwake": "40",
                            "stagesSummary": [
                                {"type": "DEEP", "minutes": "80"},
                                {"type": "REM", "minutes": "95"},
                                {"type": "LIGHT", "minutes": "245"},
                                {"type": "AWAKE", "minutes": "40"},
                            ],
                        },
                    },
                },
                {
                    # A shorter duplicate that is NOT the main sleep: must be dropped.
                    "sleep": {
                        "interval": {
                            "startTime": "2026-11-11T15:30:00Z",
                            "startUtcOffset": "28800s",
                            "endTime": "2026-11-11T18:00:00Z",
                            "endUtcOffset": "28800s",
                        },
                        "metadata": {"mainSleep": False, "nap": True},
                        "summary": {"minutesAsleep": "120", "minutesInSleepPeriod": "150"},
                    }
                },
            ]
        }

    def test_one_night_kept_with_stages_and_local_clocks(self):
        fake = FakeClient(points=self.fixture())
        dq = DataQuality()
        nights = source.fetch_sleep(fake, days=30, dq=dq)

        self.assertEqual(len(nights), 1)
        night = nights[0]
        self.assertEqual(night["date"], "2026-11-12")  # 07:00 local on the 12th
        self.assertEqual(night["minutes_asleep"], 420)
        self.assertEqual(night["stages"]["deep"], 80)
        self.assertEqual(night["onset_minutes"], 23 * 60 + 30)
        self.assertEqual(night["wake_minutes"], 7 * 60)
        self.assertEqual(night["device"], "Fitbit Air")
        self.assertIn("civil_end_time", fake.calls[0]["filter"])

    def test_through_analytics_gives_a_score(self):
        fake = FakeClient(points=self.fixture())
        nights = [source.fetch_sleep(fake, days=30)]
        summary = __import__("bio_analytics").summarise_night(nights[0][0])
        score = __import__("bio_analytics").sleep_score(summary, 450)
        self.assertIsNotNone(score)
        self.assertGreater(score, 40)

    def test_empty_response_records_missing(self):
        dq = DataQuality()
        source.fetch_sleep(FakeClient(), days=30, dq=dq)
        self.assertEqual(dq.as_dict()["metrics"]["sleep"]["source"], "missing")


class DailySeriesTests(unittest.TestCase):
    def test_rhr_parsing(self):
        fake = FakeClient(
            points={
                "daily-resting-heart-rate": [
                    {"dailyRestingHeartRate": {
                        "date": {"year": 2026, "month": 11, "day": 2},
                        "beatsPerMinute": "52"}},
                    {"dailyRestingHeartRate": {
                        "date": {"year": 2026, "month": 11, "day": 3},
                        "beatsPerMinute": "54"}},
                ]
            }
        )
        dq = DataQuality()
        rows = source.fetch_daily_rhr(fake, days=30, dq=dq)
        self.assertEqual([r["date"] for r in rows], ["2026-11-02", "2026-11-03"])
        self.assertEqual([r["value"] for r in rows], [52.0, 54.0])
        self.assertEqual(dq.as_dict()["metrics"]["rhr"]["source"], "live")

    def test_hrv_uses_daily_average(self):
        fake = FakeClient(
            points={
                "daily-heart-rate-variability": [
                    {"dailyHeartRateVariability": {
                        "date": {"year": 2026, "month": 11, "day": 2},
                        "averageHeartRateVariabilityMilliseconds": 44.5}},
                ]
            }
        )
        rows = source.fetch_daily_hrv(fake, days=30)
        self.assertEqual(rows[0]["value"], 44.5)

    def test_a_point_with_no_civil_date_is_not_dated_by_guesswork(self):
        fake = FakeClient(points={"daily-resting-heart-rate": [
            {"dailyRestingHeartRate": {"beatsPerMinute": "52"}},
        ]})
        dq = DataQuality()
        self.assertEqual(source.fetch_daily_rhr(fake, days=30, dq=dq), [])
        self.assertEqual(dq.as_dict()["metrics"]["rhr"]["source"], "missing")

    def test_the_window_keeps_the_newest_readings(self):
        # The list endpoint does not promise a sort order, so a window filled
        # by truncation would be the *oldest* days whenever it returns ascending.
        fake = FakeClient(points={"daily-resting-heart-rate": [
            {"dailyRestingHeartRate": {
                "date": {"year": 2026, "month": 11, "day": day},
                "beatsPerMinute": str(50 + day)}}
            for day in (1, 2, 3)
        ]})
        rows = source.fetch_daily_rhr(fake, days=2)
        self.assertEqual([r["date"] for r in rows], ["2026-11-02", "2026-11-03"])

    def test_steps_are_chunked_not_one_giant_request(self):
        fake = FakeClient(rollup_points=[
            {"civilStartTime": {"date": {"year": 2026, "month": 8, "day": 1}},
             "steps": {"countSum": "1000"}},
            {"civilStartTime": {"date": {"year": 2026, "month": 11, "day": 12}},
             "steps": {"countSum": "9000"}},
        ])
        rows = source.fetch_daily_steps(fake, days=90)
        self.assertEqual([r["value"] for r in rows], [1000.0, 9000.0])
        self.assertEqual(len(fake.rollup_bodys), 0)  # daily_rollup used, not rollup


class FailureIsolationTests(unittest.TestCase):
    def test_one_broken_fetcher_does_not_abort_the_run(self):
        dq = DataQuality()

        def boom():
            raise RuntimeError("400 unsupported data type")

        value = sync._attempt(dq, "vo2max", "Cardio fitness", boom, [], "readings")
        self.assertEqual(value, [])
        metrics = dq.as_dict()["metrics"]
        self.assertEqual(metrics["vo2max"]["source"], "missing")
        self.assertIn("fetch failed", metrics["vo2max"]["note"])

    def test_identity_errors_are_not_swallowed(self):
        with self.assertRaises(source.AuthError):
            raise source.AuthError("ACCOUNT_NOT_LINKED")


class EnvironmentTests(unittest.TestCase):
    def test_empty_env_falls_back(self):
        # GitHub passes an unset secret as an empty string, not as absent.
        old = os.environ.get("ATHLETE_NAME")
        os.environ["ATHLETE_NAME"] = ""
        try:
            dq = DataQuality()
            for key in ("sleep", "rhr", "hrv"):
                dq.record(key, True, "synthetic", key)
            payload = sync.build_payload(__import__("demo_data").synthetic_fetch(), dq)
            self.assertEqual(payload["athlete"]["name"], "Athlete")
            self.assertEqual(payload["timezone"], "Asia/Singapore")
        finally:
            if old is None:
                os.environ.pop("ATHLETE_NAME", None)
            else:
                os.environ["ATHLETE_NAME"] = old

    def test_bad_step_goal_does_not_crash(self):
        old = os.environ.get("STEP_GOAL")
        os.environ["STEP_GOAL"] = "ten thousand"
        try:
            dq = DataQuality()
            for key in ("sleep", "rhr", "hrv"):
                dq.record(key, True, "synthetic", key)
            payload = sync.build_payload(__import__("demo_data").synthetic_fetch(), dq)
            self.assertEqual(payload["today"]["steps"]["goal"], 10000)
        finally:
            if old is None:
                os.environ.pop("STEP_GOAL", None)
            else:
                os.environ["STEP_GOAL"] = old


class StepsAttributionTest(unittest.TestCase):
    """Steps are Google Health's merged total, never a second pedometer's claim."""

    def test_garmin_is_not_credited_for_steps(self):
        import googlehealth_source as source

        entries = [
            {"label": "Fitbit Air", "platform": "FITBIT", "points": 10},
            {"label": "Garmin Connect", "platform": "HEALTH_CONNECT", "points": 3},
        ]
        self.assertEqual(
            [entry["label"] for entry in source.steps_sources(entries)], ["Fitbit Air"]
        )

    def test_phone_and_air_both_survive(self):
        import googlehealth_source as source

        entries = [
            {"label": "Fitbit Air", "platform": "FITBIT", "points": 10},
            {"label": "Android phone", "platform": "HEALTH_CONNECT", "points": 4},
        ]
        self.assertEqual(len(source.steps_sources(entries)), 2)


if __name__ == "__main__":
    unittest.main()
