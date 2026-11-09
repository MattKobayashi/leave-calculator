"""Run with: uv run python -m unittest discover -s tests -v."""

import logging
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from calculator import LeaveCalculator, LeavePeriod, parse_date
from main import app
from public_holidays import REGIONS, get_public_holidays

logging.getLogger("httpx2").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)


def period(start, end=None, **extra):
    return {"start_date": start, "end_date": end or start, **extra}


class CalculationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def calculate(self, periods=(), **options):
        body = {
            "start_date": "2026-01-01",
            "end_date": "2026-12-31",
            "annual_entitlement": 20,
            "leave_periods": list(periods),
            **options,
        }
        response = self.client.post("/calculate", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["success"])
        return response.json()["data"]

    def test_empty_plan(self):
        data = self.calculate()
        self.assertEqual(data["balance"], 20)
        self.assertEqual(data["balance_hours"], 152)
        self.assertEqual(data["days_in_period"], 365)
        self.assertEqual(data["excluded_weekdays"], [5, 6])
        self.assertEqual(data["leave_period_breakdowns"], [])

    def test_weekends_are_excluded_by_default(self):
        data = self.calculate([period("2026-01-23", "2026-01-26")])
        self.assertEqual(data["total_leave_taken"], 2)
        self.assertEqual(data["excluded_weekday_days"], 2)
        self.assertEqual(data["total_calendar_leave_days"], 4)

    def test_any_weekday_can_be_excluded(self):
        data = self.calculate(
            [period("2026-01-23", "2026-01-26")], excluded_weekdays=[4, 5]
        )
        self.assertEqual(data["total_leave_taken"], 2)  # Sunday and Monday.
        self.assertEqual(data["excluded_weekday_days"], 2)

    def test_calendar_day_counting(self):
        data = self.calculate(
            [period("2026-01-23", "2026-01-26")], excluded_weekdays=[]
        )
        self.assertEqual(data["total_leave_taken"], 4)
        self.assertEqual(data["total_excluded_days"], 0)

    def test_all_weekdays_can_be_excluded_without_changing_accrual(self):
        data = self.calculate(
            [period("2026-01-01", "2026-12-31")], excluded_weekdays=list(range(7))
        )
        self.assertEqual(data["total_leave_taken"], 0)
        self.assertEqual(data["total_excluded_days"], 365)
        self.assertEqual(data["entitled_leave_for_period"], 20)

    def test_national_holiday_is_optional(self):
        leaves = [period("2026-01-23", "2026-01-26")]
        disabled = self.calculate(leaves)
        enabled = self.calculate(leaves, exclude_public_holidays=True)
        self.assertEqual(disabled["total_leave_taken"], 2)
        self.assertEqual(enabled["total_leave_taken"], 1)
        self.assertEqual(enabled["excluded_public_holiday_days"], 1)
        self.assertEqual(enabled["holiday_source"]["name"], "python-holidays")

    def test_observed_state_holidays(self):
        data = self.calculate(
            [period("2026-12-24", "2026-12-31")],
            exclude_public_holidays=True,
            holiday_region="NSW",
        )
        self.assertEqual(data["total_leave_taken"], 4)
        self.assertEqual(data["total_excluded_days"], 4)
        self.assertEqual(data["excluded_weekday_days"], 2)
        self.assertEqual(data["excluded_public_holiday_days"], 2)
        self.assertIn("2026-12-28", data["public_holiday_dates"])

    def test_holiday_deselection(self):
        data = self.calculate(
            [period("2026-12-24", "2026-12-31")],
            exclude_public_holidays=True,
            holiday_region="NSW",
            holiday_overrides={"2026-12-25": False},
        )
        self.assertEqual(data["total_leave_taken"], 5)
        self.assertNotIn("2026-12-25", data["public_holiday_dates"])

    def test_overrides_cannot_invent_holidays(self):
        data = self.calculate(
            [period("2026-07-16")],
            exclude_public_holidays=True,
            holiday_overrides={"2026-07-16": True},
        )
        self.assertEqual(data["total_leave_taken"], 1)

    def test_custom_dates_work_with_public_holidays_disabled(self):
        data = self.calculate(
            [period("2026-07-16", "2026-07-17")],
            additional_excluded_dates=["2026-07-16", "2026-07-16"],
        )
        self.assertEqual(data["total_leave_taken"], 1)
        self.assertEqual(data["excluded_custom_days"], 1)

    def test_weekend_holiday_and_custom_date_are_not_excluded_three_times(self):
        data = self.calculate(
            [period("2026-12-26")],
            exclude_public_holidays=True,
            holiday_region="NSW",
            additional_excluded_dates=["2026-12-26"],
        )
        self.assertEqual(data["total_excluded_days"], 1)
        self.assertEqual(data["excluded_weekday_days"], 1)
        self.assertEqual(data["excluded_public_holiday_days"], 0)
        self.assertEqual(data["excluded_custom_days"], 0)

    def test_custom_date_and_workday_holiday_are_not_excluded_twice(self):
        data = self.calculate(
            [period("2026-12-25")],
            exclude_public_holidays=True,
            additional_excluded_dates=["2026-12-25"],
        )
        self.assertEqual(data["total_excluded_days"], 1)
        self.assertEqual(data["excluded_public_holiday_days"], 1)
        self.assertEqual(data["excluded_custom_days"], 0)

    def test_brisbane_show_day_requires_opt_in(self):
        body = {
            "exclude_public_holidays": True,
            "holiday_region": "QLD",
        }
        leaves = [period("2026-08-12")]
        self.assertEqual(self.calculate(leaves, **body)["total_leave_taken"], 1)
        self.assertEqual(
            self.calculate(leaves, **body, holiday_overrides={"2026-08-12": True})[
                "total_leave_taken"
            ],
            0,
        )

    def test_overlapping_entries_only_deduct_each_date_once(self):
        data = self.calculate(
            [period("2026-06-01", "2026-06-05"), period("2026-06-03", "2026-06-08")]
        )
        self.assertEqual(data["total_leave_taken"], 6)
        self.assertEqual(data["total_calendar_leave_days"], 8)
        self.assertEqual(data["overlap_days"], 3)
        self.assertEqual(data["total_excluded_days"], 2)
        first, second = data["leave_period_breakdowns"]
        self.assertEqual(first["leave_days"], 5)
        self.assertEqual(second["leave_days"], 1)
        self.assertEqual(second["overlap_days"], 3)

    def test_duplicate_entries_do_not_change_totals(self):
        data = self.calculate([period("2026-06-01", "2026-06-07")] * 3)
        self.assertEqual(data["total_leave_taken"], 5)
        self.assertEqual(data["total_excluded_days"], 2)
        self.assertEqual(data["overlap_days"], 14)

    def test_partial_and_whole_periods_outside_window(self):
        data = self.calculate(
            [period("2026-05-01", "2026-05-10"), period("2026-04-01", "2026-04-02")],
            start_date="2026-05-04",
            end_date="2026-05-08",
        )
        self.assertEqual(data["total_leave_taken"], 5)
        self.assertEqual(data["outside_period_days"], 7)
        self.assertEqual(data["leave_period_breakdowns"][1]["leave_days"], 0)

    def test_breakdown_counts_reconcile(self):
        data = self.calculate(
            [period("2025-12-25", "2026-01-05"), period("2026-01-01", "2026-01-12")],
            exclude_public_holidays=True,
            holiday_region="NSW",
            additional_excluded_dates=["2026-01-05"],
        )
        for item in data["leave_period_breakdowns"]:
            self.assertEqual(
                item["calendar_days"],
                item["leave_days"]
                + item["excluded_days"]
                + item["overlap_days"]
                + item["outside_period_days"],
            )
        self.assertEqual(
            sum(item["leave_days"] for item in data["leave_period_breakdowns"]),
            data["total_leave_taken"],
        )
        self.assertEqual(
            data["total_calendar_leave_days"],
            data["total_leave_taken"] + data["total_excluded_days"],
        )

    def test_daylight_saving_has_no_effect(self):
        data = self.calculate(
            [period("2026-10-02", "2026-10-05")],
            exclude_public_holidays=True,
            holiday_region="NSW",
        )
        self.assertEqual(data["total_leave_taken"], 1)
        self.assertEqual(data["total_excluded_days"], 3)

    def test_leap_year_keeps_original_365_day_accrual_convention(self):
        data = self.calculate(start_date="2024-01-01", end_date="2024-12-31")
        self.assertEqual(data["days_in_period"], 366)
        self.assertEqual(data["entitled_leave_for_period"], 20.05)

    def test_date_range_flag_is_metadata_not_a_second_counting_rule(self):
        data = self.calculate([period("2026-07-13", "2026-07-15", is_range=False)])
        self.assertEqual(data["total_leave_taken"], 3)

    def test_small_and_negative_balances(self):
        self.assertEqual(LeaveCalculator.format_result(0.5)["formatted"], "3.8 hours")
        self.assertEqual(LeaveCalculator.format_result(-0.5)["formatted"], "-3.8 hours")
        self.assertEqual(
            LeaveCalculator.format_result(-2)["secondary_formatted"], "-15.2 hours"
        )
        self.assertEqual(LeaveCalculator.format_result(1)["unit"], "day")

    def test_thousand_entry_plan(self):
        start = date(2025, 1, 1)
        leaves = [
            period((start + timedelta(days=index)).isoformat()) for index in range(1000)
        ]
        data = self.calculate(leaves, start_date="2025-01-01", end_date="2027-12-31")
        expected = sum(
            (start + timedelta(days=index)).weekday() < 5 for index in range(1000)
        )
        self.assertEqual(data["total_leave_taken"], expected)
        self.assertEqual(len(data["leave_period_breakdowns"]), 1000)

    def test_convenience_helper(self):
        leaves = [LeavePeriod(**period("2026-01-23", "2026-01-26"))]
        self.assertEqual(LeaveCalculator.calculate_total_leave_days(leaves), 2)
        self.assertEqual(LeaveCalculator.calculate_total_leave_days(leaves, []), 4)
        self.assertEqual(LeaveCalculator.calculate_total_leave_days([]), 0)


class HolidayTests(unittest.TestCase):
    def calendar(self, region=None, start="2026-01-01", end="2026-12-31"):
        return get_public_holidays(
            date.fromisoformat(start), date.fromisoformat(end), region
        )

    def test_national_calendar_is_not_a_union_of_state_holidays(self):
        dates = {item["date"] for item in self.calendar()["holidays"]}
        self.assertEqual(len(dates), 7)
        self.assertIn("2026-01-26", dates)
        self.assertNotIn("2026-06-08", dates)
        self.assertNotIn("2026-12-28", dates)

    def test_all_eight_states_and_territories(self):
        regional_dates = {
            "ACT": "2026-03-09",
            "NSW": "2026-10-05",
            "NT": "2026-08-03",
            "QLD": "2026-05-04",
            "SA": "2026-03-09",
            "TAS": "2026-03-09",
            "VIC": "2026-11-03",
            "WA": "2026-06-01",
        }
        self.assertEqual(set(REGIONS), set(regional_dates))
        for region, expected in regional_dates.items():
            with self.subTest(region=region):
                calendar = self.calendar(region)
                dates = {item["date"] for item in calendar["holidays"]}
                self.assertIn(expected, dates)
                self.assertIn("2026-12-25", dates)
                self.assertEqual(calendar["region_name"], REGIONS[region])

    def test_2026_anzac_observance_differs_by_state(self):
        for region in ("ACT", "NSW", "WA"):
            self.assertIn(
                "2026-04-27",
                {item["date"] for item in self.calendar(region)["holidays"]},
            )
        for region in ("NT", "QLD", "SA", "TAS", "VIC"):
            self.assertNotIn(
                "2026-04-27",
                {item["date"] for item in self.calendar(region)["holidays"]},
            )

    def test_bank_school_and_part_day_holidays_are_not_full_days(self):
        nsw = self.calendar("NSW")
        self.assertNotIn("2026-08-03", {item["date"] for item in nsw["holidays"]})
        for region in ("NT", "QLD", "SA"):
            dates = {item["date"] for item in self.calendar(region)["holidays"]}
            self.assertNotIn("2026-12-24", dates)
            self.assertNotIn("2026-12-31", dates)

    def test_restricted_holidays_are_identified(self):
        show_day = next(
            item
            for item in self.calendar("QLD")["holidays"]
            if item["date"] == "2026-08-12"
        )
        self.assertFalse(show_day["default_excluded"])
        self.assertIn("Brisbane", show_day["note"])
        cup_day = next(
            item
            for item in self.calendar("VIC")["holidays"]
            if item["date"] == "2026-11-03"
        )
        self.assertIn("alternative", cup_day["note"])

    def test_cross_year_calendar_is_sorted_and_complete(self):
        items = self.calendar("NSW", "2025-12-20", "2027-01-10")["holidays"]
        dates = [item["date"] for item in items]
        self.assertEqual(dates, sorted(set(dates)))
        for expected in ("2025-12-25", "2026-01-01", "2026-12-25", "2027-01-01"):
            self.assertIn(expected, dates)

    def test_calendar_is_clipped_to_requested_days(self):
        dates = [
            item["date"]
            for item in self.calendar("NSW", "2026-12-27", "2026-12-29")["holidays"]
        ]
        self.assertEqual(dates, ["2026-12-28"])

    def test_cached_data_cannot_be_mutated_by_a_caller(self):
        first = self.calendar("NSW")
        first["holidays"][0]["name"] = "Changed"
        first["notes"].clear()
        second = self.calendar("NSW")
        self.assertEqual(second["holidays"][0]["name"], "New Year's Day")
        self.assertTrue(second["notes"])


class ValidationAndWebTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.body = {
            "start_date": "2026-01-01",
            "end_date": "2026-12-31",
            "annual_entitlement": 20,
        }

    def assert_invalid(self, status, **changes):
        response = self.client.post("/calculate", json={**self.body, **changes})
        self.assertEqual(response.status_code, status, response.text)
        self.assertFalse(response.json()["success"])
        self.assertTrue(response.json()["error"])
        return response.json()

    def test_reversed_calculation_dates_have_a_useful_error(self):
        error = self.assert_invalid(400, start_date="2026-12-31", end_date="2026-01-01")
        self.assertIn("Start date", error["error"])

    def test_reversed_leave_dates_name_the_entry(self):
        error = self.assert_invalid(
            400, leave_periods=[period("2026-07-15", "2026-07-13")]
        )
        self.assertIn("Leave entry 1", error["error"])

    def test_bad_dates_are_not_guessed_or_rolled_over(self):
        for value in (
            "2026-02-30",
            "2026-13-01",
            "01/02/2026",
            "20260101",
            "2026-01-01T00:00:00Z",
            "0000-01-01",
            1767225600,
        ):
            with self.subTest(value=value):
                self.assert_invalid(422, start_date=value)
        self.assertEqual(parse_date("2024-02-29"), date(2024, 2, 29))

    def test_invalid_entitlements(self):
        for value in (0, -1, 367, "nan", "inf", None):
            with self.subTest(value=value):
                self.assert_invalid(422, annual_entitlement=value)

    def test_invalid_weekdays(self):
        for weekdays in ([-1], [7], [True], ["5"], list(range(8))):
            with self.subTest(weekdays=weekdays):
                self.assert_invalid(422, excluded_weekdays=weekdays)

    def test_invalid_holiday_settings(self):
        self.assert_invalid(422, holiday_region="XYZ")
        self.assert_invalid(422, exclude_public_holidays="false")
        self.assert_invalid(422, holiday_overrides={"2026-01-01": "false"})
        self.assert_invalid(422, holiday_overrides={"2026-02-30": True})
        self.assert_invalid(422, additional_excluded_dates=["not a date"])

    def test_oversized_inputs(self):
        self.assert_invalid(422, leave_periods=[period("2026-01-02")] * 1001)
        self.assert_invalid(422, leave_periods=[period("2026-01-02", label="x" * 101)])
        self.assert_invalid(400, start_date="1900-01-01", end_date="2100-12-31")

    def test_holiday_coverage_limit_is_not_silent(self):
        self.assert_invalid(
            400,
            start_date="2101-01-01",
            end_date="2101-12-31",
            exclude_public_holidays=True,
        )
        response = self.client.post(
            "/calculate",
            json={**self.body, "start_date": "2101-01-01", "end_date": "2101-12-31"},
        )
        self.assertEqual(response.status_code, 200)

    def test_holiday_query_validation(self):
        for query, status in (
            ({"start_date": "bad", "end_date": "2026-12-31"}, 422),
            ({"start_date": "2026-12-31", "end_date": "2026-01-01"}, 400),
            (
                {"start_date": "2026-01-01", "end_date": "2026-12-31", "region": "XYZ"},
                422,
            ),
            ({"start_date": "2101-01-01", "end_date": "2101-12-31"}, 400),
        ):
            with self.subTest(query=query):
                response = self.client.get("/holidays", params=query)
                self.assertEqual(response.status_code, status)
                self.assertFalse(response.json()["success"])

    def test_unexpected_failure_does_not_leak_internal_details(self):
        with (
            patch(
                "calculator.get_public_holidays",
                side_effect=RuntimeError("internal detail"),
            ),
            self.assertLogs("main", level="ERROR"),
        ):
            response = self.client.post(
                "/calculate", json={**self.body, "exclude_public_holidays": True}
            )
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("internal detail", response.text)

    def test_holiday_load_failure_is_reported_not_silently_ignored(self):
        with (
            patch(
                "main.get_public_holidays", side_effect=RuntimeError("internal detail")
            ),
            self.assertLogs("main", level="ERROR"),
        ):
            response = self.client.get(
                "/holidays",
                params={"start_date": "2026-01-01", "end_date": "2026-12-31"},
            )
        self.assertEqual(response.status_code, 500)
        self.assertFalse(response.json()["success"])
        self.assertNotIn("internal detail", response.text)

    def test_page_assets_and_health_work_outside_the_container_directory(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                response = self.client.get("/")
                self.assertEqual(response.status_code, 200)
                self.assertIn("<title>Annual Leave Calculator</title>", response.text)
                for path in (
                    "/static/js/app.js",
                    "/static/js/utils.js",
                    "/static/css/style.css",
                    "/static/fonts/dm-sans-variable.ttf",
                    "/static/favicon.svg",
                ):
                    self.assertEqual(self.client.get(path).status_code, 200, path)
                self.assertEqual(self.client.get("/health").json()["status"], "healthy")
                self.assertEqual(self.client.get("/docs").status_code, 200)
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
