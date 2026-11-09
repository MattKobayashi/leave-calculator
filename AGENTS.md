# Repository guidance

## Commands

- Python **3.15.x** is required; install dependencies with `uv sync --locked`.
- Development server: `uv run --locked uvicorn main:app --reload` (port 8000).
- Backend/API suite: `uv run --locked python -m unittest discover -s tests -v` (stdlib `unittest`, not pytest).
- One backend test: `uv run --locked python -m unittest discover -s tests -k test_breakdown_counts_reconcile -v`.
- Frontend helpers: `node --test tests/frontend.test.mjs`. Focus one test with `node --test --test-name-pattern='legacy exports' tests/frontend.test.mjs`.
- Node **22.7+** is needed for the dependency-free ES-module tests; CI uses Node 24. There is no npm install or frontend build step.
- Use `--locked` on `uv run` to avoid incidental lockfile changes. If locked commands reject `uv.lock`, replace `--locked` with `--no-sync` only when using an already-provisioned `.venv`; this skips dependency synchronization/checking.
- Python tests use an in-process `TestClient`, so no running server or Docker is needed locally. Node tests cover pure helpers, not DOM interactions. CI additionally builds/smoke-tests the Docker image and runs Python tests inside it (`.github/workflows/test.yaml`).

## Wiring

- `main.py` serves Jinja templates and native JavaScript modules directly. Keep asset paths relative to `BASE_DIR`, not the working directory or `/app`. Calculation and holiday routes are intentionally synchronous so date work runs in FastAPI's thread pool.
- `calculator.py` owns API validation and authoritative calculations. `static/js/utils.js` mirrors validation/limits and provides entry previews; update both sides and run both suites when changing these rules.
- `public_holidays.py` supplies both `/holidays` and calculations from the pinned, local `holidays` package, not a live API. Holiday-data updates require updating `pyproject.toml` and `uv.lock` together.
- Plans persist only in browser local storage (`leave-calculator:plan:v2`); there is no server-side database. `normaliseData` is the import/export/storage validation boundary; exports wrap data in `formData`, and UI entry IDs must not be serialized. Preserve the guard against overwriting malformed saved plans.
- Docker copies `.venv` from builder to runtime; both stages must use the same Python image/interpreter path.

## Calculation and compatibility contracts

- Dates are strict, inclusive `YYYY-MM-DD` calendar dates. Use Python dates/ordinals and the existing UTC day-number helpers, not local-time arithmetic. Weekdays are Monday = 0 through Sunday = 6, unlike JavaScript's default numbering.
- Accrual deliberately uses a fixed **365-day divisor**, including leap years, and **7.6 hours/day**. Exclusions affect deductions, not accrual; calculate the balance before rounding for output.
- Clip leave to the calculation window and deduct each date once. Overlaps belong to the **first saved entry**; UI sorting/filtering must not reorder the underlying plan or change calculation/export scope. Response breakdowns map back to entries by request order.
- New plans/API requests default to `excluded_weekdays: [5, 6]`, but legacy imports missing that field deliberately normalize to `[]` (calendar-day counting). `is_range` is compatibility metadata; actual start/end dates determine the range.
- Holiday overrides only select/deselect dates in the returned calendar; use `additional_excluded_dates` for custom dates, even when public holidays are disabled. Exclusion-reason precedence is weekday, then public holiday, then custom date, with no double counting.
