"""Annual Leave Calculator web application."""

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from calculator import ISODate, LeaveCalculationRequest, LeaveCalculator
from public_holidays import REGIONS, HolidayRegion, get_public_holidays

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(
    title="Annual Leave Calculator",
    description="Plan annual leave with flexible working weeks and Australian public holidays.",
    version="2.0.0",
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, exc: RequestValidationError):
    """Keep validation errors in the same envelope as calculation errors."""
    errors = []
    for error in exc.errors():
        field = ".".join(str(part) for part in error["loc"][1:])
        errors.append(f"{field}: {error['msg']}" if field else error["msg"])
    return JSONResponse(
        status_code=422,
        content={"success": False, "error": errors[0], "details": errors},
    )


@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse(
        request=request, name="index.html", context={"regions": REGIONS}
    )


@app.post("/calculate")
def calculate_leave(request: LeaveCalculationRequest):
    """Synchronous date work runs in FastAPI's thread pool, not the event loop."""
    try:
        result = LeaveCalculator.calculate_full_balance(
            leave_periods=request.leave_periods,
            **request.model_dump(exclude={"leave_periods"}),
        )
        return {"success": True, "data": result}
    except ValueError as exc:
        return JSONResponse(
            status_code=400, content={"success": False, "error": str(exc)}
        )
    except Exception:  # Keep internal failures out of the public response.
        logger.exception("Unexpected error calculating leave")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Unable to calculate your balance. Please try again.",
            },
        )


@app.get("/holidays")
def public_holidays(
    start_date: Annotated[ISODate, Query(description="Inclusive start date")],
    end_date: Annotated[ISODate, Query(description="Inclusive end date")],
    region: HolidayRegion | None = None,
):
    try:
        return {
            "success": True,
            "data": get_public_holidays(start_date, end_date, region),
        }
    except ValueError as exc:
        return JSONResponse(
            status_code=400, content={"success": False, "error": str(exc)}
        )
    except Exception:
        logger.exception("Unexpected error loading public holidays")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Unable to load public holidays. Please try again.",
            },
        )


@app.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.now(UTC).isoformat()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000)
