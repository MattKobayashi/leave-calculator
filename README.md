# Annual Leave Calculator

A small, self-hosted annual leave planner built with FastAPI and vanilla JavaScript. A searchable leave ledger keeps larger plans manageable, while flexible working weeks and Australian holiday calendars make deductions more useful than a simple calendar-day count.

## Features

- **A redesigned workspace:** an at-a-glance balance, accrued leave, deductions and excluded days, with calculation settings separate from the leave ledger.
- **A ledger that scales:** named single-day and date-range entries, editing, name/date search, year filtering, sorting, 10/20/50-entry pages, bulk removal and undo.
- **Your working week:** exclude any combination of weekdays. New plans start with Saturday and Sunday excluded; “Count every day” restores calendar-day counting.
- **Australian public holidays:** national-only or any of the eight states and territories, including jurisdiction-specific observed dates. Review and individually select holidays, or add missing local dates.
- **Correct date deductions:** inclusive, date-only calculations, no duplicate deductions for overlaps, and no deduction for leave outside the calculation period.
- **Portable plans:** automatic browser-local saving and JSON import/export, including calculation rules. Older exports are supported.
- **No frontend build or third-party runtime requests:** styles, icons and fonts are served by the application. Holiday data is generated on the server without a live external API.

## Run locally

The project uses Python **3.15** and [uv](https://docs.astral.sh/uv/).

```sh
uv sync --locked
uv run python main.py
```

Open <http://localhost:8000>. For development with automatic reload:

```sh
uv run uvicorn main:app --reload
```

Asset paths are relative to the application files, so running locally does not require an `/app` directory. The existing Dockerfile also runs the application on port 8000.

## Using the planner

1. Set the calculation start/end dates and annual entitlement under **The essentials**. A new plan runs from 1 January to today, with a 20-day annual entitlement.
2. Under **Your working week**, select the weekdays you **do not work**. All seven days can be configured, including non-standard weekends.
3. Optionally turn on **Public holidays**, select where you are based for work, and open **Review holidays & local dates**. Checked dates are excluded. Changing jurisdiction resets holiday selections to that jurisdiction’s defaults; manually added dates are retained.
4. Use **Add leave** to record a single day or date range. Names are optional. The balance updates automatically; **Recalculate balance** also retries a failed calculation.
5. Search, filter or paginate to find entries. Select a page or all matching entries for bulk removal. The overview always includes the entire plan, not just the current filtered page.
6. **Export** backs up all entries and rules, not just the visible page. **Import** validates the whole file before asking to replace the current plan.

### Saving and privacy

Plans are saved in this browser’s local storage, not in a server-side database. Calculation requests are sent to your application server, but the application does not persist them. Other users of the same browser profile can access a saved plan. Clearing browser storage removes it, and another device/browser will not have it. Keep a JSON export as a backup.

If local storage is unavailable, the planner still works and can export data. If a saved plan is malformed, it is not silently overwritten. Use **Start a fresh calculation** to explicitly replace a saved plan.

Old JSON exports without weekday/holiday settings retain **calendar-day counting** on import, rather than silently changing their deductions. Their balances can still change if they contained overlapping or out-of-period entries, which are now handled correctly.

## Australian holiday data

Calendars come from the maintained, MIT-licensed [python-holidays](https://github.com/vacanza/holidays) package, whose [Australian implementation](https://holidays.readthedocs.io/en/latest/auto_gen_docs/australia/) references state/territory legislation and published government calendars. The UI shows the installed data version and links to the [Fair Work Ombudsman](https://www.fairwork.gov.au/employment-conditions/public-holidays) for verification.

This is a **local rules-based dataset, not a live government feed**. No API key, external service uptime or network connection to a holiday provider is required during calculation. Update the pinned `holidays` dependency and `uv.lock` as new government declarations are incorporated upstream.

### Coverage and limitations

- **National holidays only** contains the common national dates. It deliberately does not include state-specific substitutes or the King’s Birthday, whose date varies by jurisdiction. Select a state/territory for those dates.
- **ACT, NSW, NT, QLD, SA, TAS, VIC and WA** include national and jurisdiction-specific full-day public holidays, with observed/substitute dates supported by the dataset.
- **Bank, school and part-day holidays are not treated as full days off.** For example, Christmas Eve evening holidays do not exclude the whole date.
- Queensland’s **Royal Queensland Show** date is labelled Brisbane-only and is **not selected by default**. Opt in only if it applies to you.
- Melbourne Cup and WA’s King’s Birthday are flagged where local alternatives can apply. The dataset is **not a complete local/regional holiday register**: use individual deselection and custom dates for local show days, regional substitutions and other missing full-day holidays.
- Custom dates apply independently of the public-holiday switch. A deselected holiday can still be excluded because it falls on a selected non-working weekday or a custom date.
- Calendars support **1801–2100**, but historical accuracy and future declarations should always be checked with the relevant authority. Provisional future event dates can change. Calculation periods are limited to 36,600 days (approximately 100 years).

## Calculation method

```text
Calendar days in period = end date − start date + 1
Leave accrued           = annual entitlement × calendar days in period ÷ 365
Leave deducted          = unique leave dates inside the period
                          − selected non-working weekdays
                          − selected public holidays
                          − additional excluded dates
Available balance       = leave accrued − leave deducted
```

Exclusions affect **leave deducted, not accrual**. A date with multiple exclusion reasons is removed only once. Overlapping dates are allocated to the first saved entry, independent of how the table is sorted; row deductions therefore sum to the overview deduction. Dates outside the calculation window are not deducted and are identified in the ledger.

The original calculator’s fixed **365-day accrual convention** is retained, so a complete leap year accrues slightly more than the annual entitlement (20 days becomes 20.05). Displayed balances are rounded, but calculation uses unrounded accrued leave. The main result uses days when the absolute balance is at least one day, otherwise hours. Hours use **7.6 hours/day**.

This is a planning estimate, not payroll or legal advice. Opening/carry-over balances, unpaid leave, changing entitlements and part-day leave are not modelled. Confirm the official balance with your employer.

## API

Interactive documentation is available at `/docs`.

### `POST /calculate`

Send **JSON**, not form data. Dates must be real `YYYY-MM-DD` dates and both range endpoints are inclusive.

```json
{
  "start_date": "2026-01-01",
  "end_date": "2026-12-31",
  "annual_entitlement": 20,
  "leave_periods": [
    {
      "start_date": "2026-12-24",
      "end_date": "2026-12-31",
      "is_range": true,
      "label": "Summer break"
    }
  ],
  "excluded_weekdays": [5, 6],
  "exclude_public_holidays": true,
  "holiday_region": "NSW",
  "holiday_overrides": {},
  "additional_excluded_dates": []
}
```

Optional fields/defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `leave_periods` | `[]` | Up to 1,000 entries; optional names up to 100 characters. |
| `excluded_weekdays` | `[5, 6]` | Monday = `0`, Sunday = `6`. Use `[]` to count every weekday. |
| `exclude_public_holidays` | `false` | Apply selected full-day public holidays. |
| `holiday_region` | `null` | National-only, or `ACT`, `NSW`, `NT`, `QLD`, `SA`, `TAS`, `VIC`, `WA`. |
| `holiday_overrides` | `{}` | Map ISO holiday dates to `true` (exclude) / `false` (count). Defaults come from the holiday endpoint. Unknown holiday dates do not create exclusions. |
| `additional_excluded_dates` | `[]` | Up to 1,000 custom dates, independent of the holiday switch. |

**Compatibility:** requests that omit `excluded_weekdays` now default to weekends off. Existing API clients that need the previous calendar-day behaviour should explicitly send `[]`. `is_range` is retained as metadata for older exports; actual start/end dates determine the range.

The example deducts **4 days**: Saturday/Sunday and Christmas/observed Boxing Day are excluded. The response includes:

```json
{
  "success": true,
  "data": {
    "days_in_period": 365,
    "entitled_leave_for_period": 20.0,
    "total_leave_taken": 4,
    "total_excluded_days": 4,
    "excluded_weekday_days": 2,
    "excluded_public_holiday_days": 2,
    "excluded_custom_days": 0,
    "overlap_days": 0,
    "outside_period_days": 0,
    "balance": 16.0,
    "balance_hours": 121.6,
    "leave_period_breakdowns": [
      {
        "index": 0,
        "start_date": "2026-12-24",
        "end_date": "2026-12-31",
        "label": "Summer break",
        "calendar_days": 8,
        "leave_days": 4,
        "excluded_days": 4,
        "excluded_weekday_days": 2,
        "excluded_public_holiday_days": 2,
        "excluded_custom_days": 0,
        "overlap_days": 0,
        "outside_period_days": 0
      }
    ]
  }
}
```

Additional response fields include the period, annual entitlement, selected holiday dates, source/version and the formatted `result` object. Invalid field formats return HTTP 422; invalid ranges/unsupported holiday coverage return HTTP 400. Errors use `{"success": false, "error": "An explanation"}`.

### `GET /holidays`

```text
/holidays?start_date=2026-01-01&end_date=2026-12-31&region=NSW
```

Omit `region` for national-only dates. Returns `success` and `data` containing date-sorted `holidays` (`date`, `name`, `default_excluded`, `note`), the requested region/period, source/version, verification links and coverage notes. The same dataset is used for calculation and the UI preview.

### Other endpoints

- `GET /`: the planner.
- `GET /health`: health status and an ISO timestamp.

## Tests

Backend and API tests use the standard library’s `unittest` and FastAPI’s included test client:

```sh
uv run python -m unittest discover -s tests -v
```

Frontend helper tests need **Node.js 22.7 or newer**, with no npm dependencies or build step:

```sh
node --test tests/frontend.test.mjs
```

Tests cover non-standard weekends, holiday selection and observed dates, every Australian jurisdiction, local-date overrides, overlap deduplication, clipping, leap years, DST-safe dates, large plans, validation, legacy imports, JSON round trips, search and pagination. The image CI runs the backend/API suite; a separate CI job runs the JavaScript tests.

## Project structure

```text
main.py                   FastAPI routes and portable asset paths
calculator.py             Validated request models and leave calculations
public_holidays.py        Cached Australian calendars and source metadata
templates/index.html      Responsive workspace and accessible native dialogs
static/css/style.css      Custom design, responsive and reduced-motion styles
static/js/app.js          Ledger, rules, import/export and local persistence
static/js/utils.js        Pure date, validation, filtering and preview helpers
static/fonts/             Self-hosted fonts and their SIL Open Font License
tests/                    Backend/API and frontend helper tests
```
