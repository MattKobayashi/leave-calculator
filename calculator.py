"""Validated inputs and date-only leave calculations, independent of the web UI."""

import math
import re
from datetime import date, datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, Field, StrictBool

from errors import InputValidationError
from public_holidays import HolidayRegion, get_public_holidays, validate_period

HOURS_PER_DAY = 7.6
MAX_LEAVE_PERIODS = 1000


def parse_date(value: object) -> date:
    """Accept actual dates or unambiguous ISO dates, never timestamps or fuzzy dates."""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise InputValidationError("Use a valid date in YYYY-MM-DD format.")


ISODate = Annotated[date, BeforeValidator(parse_date)]
Weekday = Annotated[int, Field(strict=True, ge=0, le=6)]


class LeavePeriod(BaseModel):
    """Dates are inclusive; is_range is retained for older export files."""

    start_date: ISODate
    end_date: ISODate
    is_range: bool = False
    label: str = Field(default="", max_length=100)


class LeaveCalculationRequest(BaseModel):
    start_date: ISODate
    end_date: ISODate
    annual_entitlement: float = Field(gt=0, le=366, allow_inf_nan=False)
    leave_periods: list[LeavePeriod] = Field(
        default_factory=list, max_length=MAX_LEAVE_PERIODS
    )
    excluded_weekdays: list[Weekday] = Field(
        default_factory=lambda: [5, 6],
        max_length=7,
        description="Non-working days: Monday=0 through Sunday=6.",
    )
    exclude_public_holidays: StrictBool = False
    holiday_region: HolidayRegion | None = None
    holiday_overrides: dict[ISODate, StrictBool] = Field(
        default_factory=dict,
        max_length=5000,
        description="Override a holiday's default: true excludes it, false counts it.",
    )
    additional_excluded_dates: list[ISODate] = Field(
        default_factory=list, max_length=1000
    )


def validate_dates(start_date: date | str, end_date: date | str) -> tuple[date, date]:
    start, end = parse_date(start_date), parse_date(end_date)
    validate_period(start, end)
    return start, end


def validate_leave_periods(leave_periods: list[LeavePeriod]) -> None:
    for index, period in enumerate(leave_periods, start=1):
        if period.start_date > period.end_date:
            raise InputValidationError(
                f"Leave entry {index}: start date must be on or before end date."
            )


class LeaveCalculator:
    """Accrue by calendar day; deduct only unique, non-excluded leave dates."""

    @staticmethod
    def calculate_days_in_period(start_date: date, end_date: date) -> int:
        return (end_date - start_date).days + 1

    @staticmethod
    def calculate_entitled_leave(
        annual_entitlement: float, days_in_period: int
    ) -> float:
        # Retain the original calculator's fixed 365-day accrual convention.
        return annual_entitlement * days_in_period / 365

    @staticmethod
    def calculate_leave_balance(entitled_leave: float, leave_taken: float) -> float:
        return entitled_leave - leave_taken

    @staticmethod
    def calculate_leave_breakdown(
        leave_periods: list[LeavePeriod],
        start_date: date,
        end_date: date,
        excluded_weekdays: list[int],
        holiday_dates: set[date],
        additional_excluded_dates: list[date],
    ) -> dict:
        """Allocate overlapping dates to the first saved entry, counting each once.

        Ordinal sets keep this date-only (no DST issues), and bound memory to the
        calculation window even when an imported leave entry extends beyond it.
        Each date gets one exclusion reason, so weekend holidays aren't counted twice.
        """
        seen = set()
        weekdays = set(excluded_weekdays)
        holidays = {day.toordinal() for day in holiday_dates}
        custom_dates = {day.toordinal() for day in additional_excluded_dates}
        first, last = start_date.toordinal(), end_date.toordinal()
        breakdowns = []
        totals = {
            "total_leave_taken": 0,
            "total_excluded_days": 0,
            "excluded_weekday_days": 0,
            "excluded_public_holiday_days": 0,
            "excluded_custom_days": 0,
            "overlap_days": 0,
            "outside_period_days": 0,
        }

        for index, period in enumerate(leave_periods):
            calendar_days = (period.end_date - period.start_date).days + 1
            period_dates = set(
                range(
                    max(first, period.start_date.toordinal()),
                    min(last, period.end_date.toordinal()) + 1,
                )
            )
            unique_dates = period_dates - seen
            overlap_days = len(period_dates) - len(unique_dates)
            seen.update(period_dates)
            excluded_weekday_days = sum(
                (day - 1) % 7 in weekdays for day in unique_dates
            )
            working_dates = {
                day for day in unique_dates if (day - 1) % 7 not in weekdays
            }
            excluded_holidays = working_dates & holidays
            excluded_custom = (working_dates - excluded_holidays) & custom_dates
            excluded_days = (
                excluded_weekday_days + len(excluded_holidays) + len(excluded_custom)
            )
            leave_days = len(unique_dates) - excluded_days
            outside_days = calendar_days - len(period_dates)

            breakdowns.append(
                {
                    "index": index,
                    "start_date": period.start_date.isoformat(),
                    "end_date": period.end_date.isoformat(),
                    "label": period.label,
                    "calendar_days": calendar_days,
                    "leave_days": leave_days,
                    "excluded_days": excluded_days,
                    "excluded_weekday_days": excluded_weekday_days,
                    "excluded_public_holiday_days": len(excluded_holidays),
                    "excluded_custom_days": len(excluded_custom),
                    "overlap_days": overlap_days,
                    "outside_period_days": outside_days,
                }
            )
            totals["total_leave_taken"] += leave_days
            totals["total_excluded_days"] += excluded_days
            totals["excluded_weekday_days"] += excluded_weekday_days
            totals["excluded_public_holiday_days"] += len(excluded_holidays)
            totals["excluded_custom_days"] += len(excluded_custom)
            totals["overlap_days"] += overlap_days
            totals["outside_period_days"] += outside_days

        return {
            **totals,
            "total_calendar_leave_days": len(seen),
            "leave_period_breakdowns": breakdowns,
        }

    @classmethod
    def calculate_total_leave_days(
        cls,
        leave_periods: list[LeavePeriod],
        excluded_weekdays: list[int] | None = None,
        excluded_dates: set[date] | None = None,
    ) -> int:
        """Convenience helper for callers without a calculation window."""
        if not leave_periods:
            return 0
        validate_leave_periods(leave_periods)
        start_date = min(period.start_date for period in leave_periods)
        end_date = max(period.end_date for period in leave_periods)
        validate_period(start_date, end_date)
        return cls.calculate_leave_breakdown(
            leave_periods,
            start_date,
            end_date,
            [5, 6] if excluded_weekdays is None else excluded_weekdays,
            excluded_dates or set(),
            [],
        )["total_leave_taken"]

    @staticmethod
    def format_result(balance: float) -> dict:
        hours = balance * HOURS_PER_DAY
        if abs(balance) >= 1:
            unit = "day" if abs(round(balance, 1)) == 1 else "days"
            hour_unit = "hour" if abs(round(hours, 1)) == 1 else "hours"
            return {
                "value": round(balance, 1),
                "unit": unit,
                "formatted": f"{balance:.1f} {unit}",
                "secondary_value": round(hours, 1),
                "secondary_unit": hour_unit,
                "secondary_formatted": f"{hours:.1f} {hour_unit}",
                "display_secondary": True,
            }
        unit = "hour" if abs(round(hours, 1)) == 1 else "hours"
        return {
            "value": round(hours, 1),
            "unit": unit,
            "formatted": f"{hours:.1f} {unit}",
            "display_secondary": False,
        }

    @classmethod
    def calculate_full_balance(
        cls,
        start_date: date,
        end_date: date,
        leave_periods: list[LeavePeriod],
        annual_entitlement: float,
        excluded_weekdays: list[int] | None = None,
        exclude_public_holidays: bool = False,
        holiday_region: HolidayRegion | None = None,
        holiday_overrides: dict[date, bool] | None = None,
        additional_excluded_dates: list[date] | None = None,
    ) -> dict:
        validate_period(start_date, end_date)
        validate_leave_periods(leave_periods)
        if not math.isfinite(annual_entitlement) or not 0 < annual_entitlement <= 366:
            raise InputValidationError(
                "Annual entitlement must be between 0 and 366 days (exclusive of 0)."
            )
        weekdays = [5, 6] if excluded_weekdays is None else excluded_weekdays
        if any(type(day) is not int or not 0 <= day <= 6 for day in weekdays):
            raise InputValidationError(
                "Excluded weekdays must be numbers from 0 (Monday) to 6 (Sunday)."
            )

        holiday_calendar = None
        holiday_dates = set()
        overrides = holiday_overrides or {}
        if exclude_public_holidays:
            holiday_calendar = get_public_holidays(start_date, end_date, holiday_region)
            for holiday in holiday_calendar["holidays"]:
                holiday_date = date.fromisoformat(holiday["date"])
                if overrides.get(holiday_date, holiday["default_excluded"]):
                    holiday_dates.add(holiday_date)

        days_in_period = cls.calculate_days_in_period(start_date, end_date)
        entitled_leave = cls.calculate_entitled_leave(
            annual_entitlement, days_in_period
        )
        breakdown = cls.calculate_leave_breakdown(
            leave_periods,
            start_date,
            end_date,
            weekdays,
            holiday_dates,
            additional_excluded_dates or [],
        )
        balance = cls.calculate_leave_balance(
            entitled_leave, breakdown["total_leave_taken"]
        )
        return {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "days_in_period": days_in_period,
            "annual_entitlement": annual_entitlement,
            "entitled_leave_for_period": round(entitled_leave, 2),
            "leave_periods_count": len(leave_periods),
            "balance": round(balance, 2),
            "balance_hours": round(balance * HOURS_PER_DAY, 2),
            "hours_per_day": HOURS_PER_DAY,
            "excluded_weekdays": sorted(set(weekdays)),
            "exclude_public_holidays": exclude_public_holidays,
            "holiday_region": holiday_region,
            "public_holiday_dates": sorted(day.isoformat() for day in holiday_dates),
            "holiday_source": holiday_calendar["source"] if holiday_calendar else None,
            "result": cls.format_result(balance),
            **breakdown,
        }
