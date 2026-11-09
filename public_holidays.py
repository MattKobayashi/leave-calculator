"""Australian holiday calendars, generated locally from the python-holidays dataset."""

from datetime import date
from functools import lru_cache
from typing import Literal

import holidays
from holidays.constants import PUBLIC

from errors import InputValidationError

HolidayRegion = Literal["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]
REGIONS = {
    "ACT": "Australian Capital Territory",
    "NSW": "New South Wales",
    "NT": "Northern Territory",
    "QLD": "Queensland",
    "SA": "South Australia",
    "TAS": "Tasmania",
    "VIC": "Victoria",
    "WA": "Western Australia",
}
MIN_HOLIDAY_YEAR = 1801
MAX_HOLIDAY_YEAR = 2100
MAX_PERIOD_DAYS = 36600
SOURCE = {
    "name": "python-holidays",
    "version": holidays.__version__,
    "url": "https://holidays.readthedocs.io/en/latest/auto_gen_docs/australia/",
    "official_url": "https://www.fairwork.gov.au/employment-conditions/public-holidays",
}
NOTES = [
    "Full-day public holidays only; bank, school and part-day holidays are not excluded.",
    "Observed and substitute dates follow the selected state or territory. National-only dates do not include state-specific substitutes or the King's Birthday.",
    "Local show days and regional substitutions are not a complete calendar. Check Fair Work or your state authority, deselect dates that do not apply and add local dates manually.",
    "Future dates can change when governments make new declarations. Keep the holidays dependency up to date.",
]


def validate_period(start_date: date, end_date: date) -> None:
    """Bound calendar work and provide useful errors for reversed dates."""
    if start_date > end_date:
        raise InputValidationError("Start date must be on or before end date.")
    if (end_date - start_date).days + 1 > MAX_PERIOD_DAYS:
        raise InputValidationError(
            "Choose a calculation period of no more than 100 years."
        )


@lru_cache(maxsize=256)
def _holiday_year(year: int, region: HolidayRegion | None) -> tuple:
    """Cache immutable results, not the library's mutable, auto-expanding calendars."""
    calendar = holidays.country_holidays(
        "AU",
        subdiv=region,
        years=year,
        observed=True,
        categories=PUBLIC,
        language="en_AU",
        expand=False,
    )
    return tuple(sorted(calendar.items()))


def get_public_holidays(
    start_date: date, end_date: date, region: HolidayRegion | None = None
) -> dict:
    """Return full-day holidays and the provenance needed to review them."""
    validate_period(start_date, end_date)
    if region is not None and region not in REGIONS:
        raise InputValidationError("Choose a valid Australian state or territory.")
    if start_date.year < MIN_HOLIDAY_YEAR or end_date.year > MAX_HOLIDAY_YEAR:
        raise InputValidationError(
            f"Australian holiday calendars support {MIN_HOLIDAY_YEAR}–{MAX_HOLIDAY_YEAR}. "
            "Change the dates or turn off public-holiday exclusions."
        )

    records = []
    for year in range(start_date.year, end_date.year + 1):
        for holiday_date, name in _holiday_year(year, region):
            if not start_date <= holiday_date <= end_date:
                continue
            note = ""
            default_excluded = True
            if region == "QLD" and "Royal Queensland Show" in name:
                note = "Brisbane area only — opt in if this applies to you."
                default_excluded = False
            elif region == "VIC" and "Melbourne Cup" in name:
                note = "Some local areas observe an alternative date."
            elif region == "WA" and (
                "King's Birthday" in name or "Queen's Birthday" in name
            ):
                note = "Some regional areas observe a different date."
            records.append(
                {
                    "date": holiday_date.isoformat(),
                    "name": name,
                    "default_excluded": default_excluded,
                    "note": note,
                }
            )

    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "region": region,
        "region_name": REGIONS.get(region, "National holidays only"),
        "holidays": sorted(records, key=lambda item: item["date"]),
        "source": SOURCE.copy(),
        "notes": NOTES.copy(),
    }
