from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from datetime import datetime, date
from dateutil.parser import parse
from pydantic import BaseModel, Field
from typing import List
import logging


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Annual Leave Calculator",
    description="Calculate annual leave balances based on employment period and entitlements",
    version="1.0.0",
)

# Mount static files
app.mount("/static", StaticFiles(directory="/app/static"), name="static")

# Initialize templates
templates = Jinja2Templates(directory="/app/templates")


# Pydantic models for request data
class LeavePeriod(BaseModel):
    start_date: str = Field(..., description="Start date of the leave period")
    end_date: str = Field(..., description="End date of the leave period")
    is_range: bool = Field(
        default=False, description="Whether this is a date range or single day"
    )


class LeaveCalculationRequest(BaseModel):
    start_date: str = Field(
        ..., description="Employment start date or calculation period start"
    )
    end_date: str = Field(..., description="Current date or calculation period end")
    annual_entitlement: float = Field(
        ..., gt=0, description="Annual leave entitlement in days"
    )
    leave_periods: List[LeavePeriod] = Field(
        default=[], description="List of leave periods taken"
    )


class LeaveCalculator:
    """Handles all leave balance calculations"""

    @staticmethod
    def calculate_days_in_period(start_date: date, end_date: date) -> int:
        """Calculate the number of days in the given period"""
        return (end_date - start_date).days + 1

    @staticmethod
    def calculate_entitled_leave(
        annual_entitlement: float, days_in_period: int
    ) -> float:
        """Calculate entitled leave for the given period"""
        proportion = days_in_period / 365
        return annual_entitlement * proportion

    @staticmethod
    def calculate_leave_balance(entitled_leave: float, leave_taken: float) -> float:
        """Calculate the leave balance"""
        return entitled_leave - leave_taken

    @staticmethod
    def calculate_total_leave_days(leave_periods: List[LeavePeriod]) -> float:
        """Calculate total leave days from multiple periods"""
        total_days = 0

        for period in leave_periods:
            try:
                start_date = parse(period.start_date).date()
                end_date = parse(period.end_date).date()

                if start_date > end_date:
                    raise ValueError(
                        f"Invalid date range: {period.start_date} to {period.end_date}"
                    )

                days = (end_date - start_date).days + 1
                total_days += days

            except Exception as e:
                raise ValueError(
                    f"Error processing leave period {period.start_date} to {period.end_date}: {str(e)}"
                )

        return total_days

    @staticmethod
    def format_result(balance: float) -> dict:
        """Format the result based on balance amount"""
        if balance >= 1 or balance <= -1:
            # Display in days for values >= 1 day or <= -1 day (below -7.6 hours)
            hours = balance * 7.6
            primary_unit = "days" if abs(balance) != 1 else "day"
            secondary_unit = "hours" if abs(hours) != 1 else "hour"

            return {
                "value": round(balance, 1),
                "unit": primary_unit,
                "formatted": f"{balance:.1f} {primary_unit}",
                "secondary_value": round(hours, 1),
                "secondary_unit": secondary_unit,
                "secondary_formatted": f"{hours:.1f} {secondary_unit}",
                "display_secondary": True,
            }
        else:
            # Display in hours for values between -1 and 1 day (-7.6 to 7.6 hours)
            hours = balance * 7.6
            return {
                "value": round(hours, 1),
                "unit": "hours" if abs(hours) != 1 else "hour",
                "formatted": f"{hours:.1f} {'hours' if abs(hours) != 1 else 'hour'}",
                "display_secondary": False,
            }

    @classmethod
    def calculate_full_balance(
        cls,
        start_date: date,
        end_date: date,
        leave_periods: List[LeavePeriod],
        annual_entitlement: float,
    ) -> dict:
        """Perform complete leave balance calculation with multiple leave periods"""
        # Calculate period details
        days_in_period = cls.calculate_days_in_period(start_date, end_date)

        # Calculate entitled leave for the period
        entitled_leave = cls.calculate_entitled_leave(
            annual_entitlement, days_in_period
        )

        # Calculate total leave taken from all periods
        total_leave_taken = cls.calculate_total_leave_days(leave_periods)

        # Calculate final balance
        balance = cls.calculate_leave_balance(entitled_leave, total_leave_taken)

        # Format result
        formatted_result = cls.format_result(balance)

        return {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "days_in_period": days_in_period,
            "annual_entitlement": annual_entitlement,
            "entitled_leave_for_period": round(entitled_leave, 2),
            "total_leave_taken": total_leave_taken,
            "leave_periods_count": len(leave_periods),
            "balance": round(balance, 2),
            "result": formatted_result,
        }


def validate_dates(start_date_str: str, end_date_str: str) -> tuple[date, date]:
    """Validate and parse date inputs"""
    try:
        start_date = parse(start_date_str).date()
        end_date = parse(end_date_str).date()

        if start_date > end_date:
            raise ValueError("Start date must be before or equal to end date")

        return start_date, end_date
    except Exception as e:
        raise ValueError(f"Invalid date format: {str(e)}")


def validate_leave_periods(leave_periods: List[LeavePeriod]) -> None:
    """Validate leave periods"""
    for i, period in enumerate(leave_periods):
        try:
            start_date = parse(period.start_date).date()
            end_date = parse(period.end_date).date()

            if start_date > end_date:
                raise ValueError(
                    f"Leave period {i + 1}: Start date must be before or equal to end date"
                )

        except Exception as e:
            raise ValueError(f"Leave period {i + 1}: Invalid date format - {str(e)}")


@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    """Serve the main calculator page"""
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/calculate")
async def calculate_leave(request: LeaveCalculationRequest):
    """Calculate leave balance API endpoint"""
    try:
        # Validate main period dates
        start_dt, end_dt = validate_dates(request.start_date, request.end_date)

        # Validate annual entitlement
        if request.annual_entitlement <= 0:
            raise ValueError("Annual entitlement must be positive")

        # Validate leave periods
        validate_leave_periods(request.leave_periods)

        # Perform calculation
        result = LeaveCalculator.calculate_full_balance(
            start_dt, end_dt, request.leave_periods, request.annual_entitlement
        )

        logger.info(
            f"Leave calculation completed: {result['result']['formatted']} with {len(request.leave_periods)} leave periods"
        )

        return JSONResponse(content={"success": True, "data": result})

    except ValueError as e:
        logger.warning(f"Validation error: {str(e)}")
        return JSONResponse(
            status_code=400, content={"success": False, "error": "Invalid input data"}
        )
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "An unexpected error occurred during calculation",
            },
        )


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000)
