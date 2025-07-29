# Annual Leave Calculator

A web-based application for calculating annual leave balances using FastAPI backend and Bootstrap frontend.

## Features

- **Pro-rated Leave Calculation**: Calculates entitled leave based on the proportion of the year worked
- **Smart Result Display**: Shows balance in days (≥1 day) or hours (<1 day, using 7.6 hours/day)
- **Responsive Design**: Bootstrap 5 interface that works on all devices
- **Calendar Date Pickers**: HTML5 date inputs for easy date selection
- **Input Validation**: Both client-side and server-side validation
- **Real-time Feedback**: Instant error messages and loading states

## Installation

1. **Clone or download the project files**

2. **Run the application**:
   ```bash
   uv run python3 main.py
   ```

3. **Open your browser** and navigate to:
   ```
   http://localhost:8000
   ```

## Usage

### Input Fields

1. **Start Date**: Employee start date or leave period start date
2. **End Date**: Current date or leave period end date  
3. **Leave Taken (Days)**: Number of leave days already taken
4. **Annual Entitlement (Days)**: Total annual leave entitlement in days

### Calculation Method

The application calculates leave balance using the following formula:

```
Days in Period = End Date - Start Date + 1
Proportion of Year = Days in Period ÷ 365
Entitled Leave for Period = Annual Entitlement × Proportion of Year
Leave Balance = Entitled Leave for Period - Leave Taken
```

### Result Display

- **≥1 day**: Results displayed in days (e.g., "5.3 days")
- **<1 day**: Results displayed in hours (e.g., "4.6 hours") using 7.6 hours per day

## Example Calculations

### Example 1: Full Year Employment
- Start Date: January 1, 2024
- End Date: December 31, 2024
- Annual Entitlement: 20 days
- Leave Taken: 12 days
- **Result**: 8.0 days remaining

### Example 2: Mid-Year Start
- Start Date: July 1, 2024  
- End Date: December 31, 2024
- Annual Entitlement: 20 days
- Leave Taken: 5 days
- **Result**: 5.0 days remaining (10 days entitled for 6 months - 5 days taken)

### Example 3: Small Balance
- Start Date: January 1, 2024
- End Date: March 31, 2024
- Annual Entitlement: 20 days  
- Leave Taken: 4.5 days
- **Result**: 2.7 hours remaining (5.0 days entitled for 3 months - 4.5 days taken = 0.5 days = 3.8 hours)

## API Endpoints

### GET /
Returns the main calculator HTML page.

### POST /calculate
Calculates leave balance.

**Request Body (Form Data)**:
```
start_date: string (YYYY-MM-DD format)
end_date: string (YYYY-MM-DD format) 
leave_taken: float
annual_entitlement: float
```

**Response**:
```json
{
  "success": true,
  "data": {
    "start_date": "2024-01-01",
    "end_date": "2024-12-31", 
    "days_in_period": 366,
    "annual_entitlement": 20,
    "entitled_leave_for_period": 20.05,
    "leave_taken": 12,
    "balance": 8.05,
    "result": {
      "value": 8.1,
      "unit": "days",
      "formatted": "8.1 days"
    }
  }
}
```

### GET /health
Health check endpoint.

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00.000000"
}
```

## Project Structure

```
leave-calculator/
├── main.py                 # FastAPI application
├── requirements.txt        # Python dependencies
├── README.md              # This file
├── architecture_plan.md   # Technical architecture documentation
├── templates/
│   └── index.html         # Main UI template
└── static/
    ├── css/
    │   └── style.css      # Custom styles
    └── js/
        └── app.js         # Frontend JavaScript
```

## Technology Stack

- **Backend**: FastAPI, Uvicorn, Jinja2
- **Frontend**: Bootstrap 5, HTML5, Vanilla JavaScript
- **Styling**: Custom CSS with Bootstrap components
- **Date Handling**: Python dateutil, HTML5 date inputs

## Validation Rules

### Date Validation
- Start date must be before or equal to end date
- Dates must be in valid format

### Numeric Validation  
- Leave taken cannot be negative
- Annual entitlement must be positive
- Leave taken cannot exceed annual entitlement by more than 2x (allows for carry-over)

## Browser Compatibility

- Modern browsers with HTML5 support
- Chrome, Firefox, Safari, Edge
- Mobile browsers (responsive design)

## Development

### Running in Development Mode
```bash
python main.py
```

The application will run with auto-reload enabled on `http://localhost:8000`.

### Production Deployment

For production deployment, consider using:

```bash
pip install gunicorn
gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is open source and available under the MIT License.