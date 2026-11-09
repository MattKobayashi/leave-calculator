// Date-only helpers shared by the interface and the dependency-free Node tests.
export const DAY_MS = 86400000;
export const MAX_PERIOD_DAYS = 36600;
export const MAX_ENTRIES = 1000;
export const REGIONS = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];
const dateFormatters = new Map();

export function dateNumber(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
    return timestamp / DAY_MS;
}

export function dateString(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function localToday() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

export function formatDate(value, options = {}) {
    const day = dateNumber(value);
    if (day === null) return '—';
    const key = JSON.stringify(Object.entries(options));
    if (!dateFormatters.has(key)) {
        if (dateFormatters.size >= 16) dateFormatters.clear();
        dateFormatters.set(key, new Intl.DateTimeFormat('en-AU', {
            day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...options,
        }));
    }
    return dateFormatters.get(key).format(new Date(day * DAY_MS));
}

export function formatRange(start, end) {
    if (start === end) return formatDate(start);
    const first = start.slice(0, 4) === end.slice(0, 4)
        ? formatDate(start, { year: undefined }) : formatDate(start);
    return `${first} – ${formatDate(end)}`;
}

export function formatNumber(value, decimals = 2) {
    return new Intl.NumberFormat('en-AU', { maximumFractionDigits: decimals }).format(value);
}

export function daysLabel(value) {
    return `${formatNumber(value)} ${value === 1 ? 'day' : 'days'}`;
}

export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
}

export function initialData(today = localToday()) {
    return {
        start_date: `${today.slice(0, 4)}-01-01`,
        end_date: today,
        annual_entitlement: 20,
        leave_periods: [],
        excluded_weekdays: [5, 6],
        exclude_public_holidays: false,
        holiday_region: null,
        holiday_overrides: {},
        additional_excluded_dates: [],
    };
}

function requireDate(value, label) {
    if (dateNumber(value) === null) throw new Error(`${label} must be a real date in YYYY-MM-DD format.`);
    return value;
}

function requireDateList(value, label, maxLength) {
    if (!Array.isArray(value) || value.length > maxLength) {
        throw new Error(`${label} must be a list with no more than ${maxLength} dates.`);
    }
    return [...new Set(value.map(day => requireDate(day, label)))].sort();
}

export function normaliseData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('This file does not contain a leave plan.');
    const start = requireDate(data.start_date, 'Calculation start');
    const end = requireDate(data.end_date, 'Calculation end');
    if (start > end) throw new Error('Calculation starts must be on or before calculation ends.');
    if (dateNumber(end) - dateNumber(start) + 1 > MAX_PERIOD_DAYS) throw new Error('Choose a calculation period of no more than 100 years.');
    if (typeof data.annual_entitlement !== 'number' || !Number.isFinite(data.annual_entitlement)
        || data.annual_entitlement <= 0 || data.annual_entitlement > 366) {
        throw new Error('Annual entitlement must be greater than 0 and no more than 366 days.');
    }
    const periods = data.leave_periods ?? [];
    if (!Array.isArray(periods) || periods.length > MAX_ENTRIES) throw new Error(`A plan can have up to ${MAX_ENTRIES} leave entries.`);
    const leavePeriods = periods.map((period, index) => {
        if (!period || typeof period !== 'object') throw new Error(`Leave entry ${index + 1} is invalid.`);
        const first = requireDate(period.start_date, `Leave entry ${index + 1} start`);
        const last = requireDate(period.end_date ?? first, `Leave entry ${index + 1} end`);
        if (first > last) throw new Error(`Leave entry ${index + 1} ends before it starts.`);
        if (period.is_range !== undefined && typeof period.is_range !== 'boolean') throw new Error(`Leave entry ${index + 1} has an invalid period type.`);
        const label = period.label ?? '';
        if (typeof label !== 'string' || label.length > 100) throw new Error(`Leave entry ${index + 1} names must be no more than 100 characters.`);
        return { start_date: first, end_date: last, is_range: first !== last, label: label.trim() };
    });

    // Old exports counted calendar days. Preserve that behaviour instead of
    // silently changing the balance when a v1 file is opened in the new UI.
    const weekdays = data.excluded_weekdays ?? [];
    if (!Array.isArray(weekdays) || weekdays.length > 7 || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error('Excluded weekdays must be numbers from 0 (Monday) to 6 (Sunday).');
    }
    const excludeHolidays = data.exclude_public_holidays ?? false;
    if (typeof excludeHolidays !== 'boolean') throw new Error('The public holiday setting must be true or false.');
    const region = data.holiday_region === '' ? null : (data.holiday_region ?? null);
    if (region !== null && !REGIONS.includes(region)) throw new Error('Choose a valid Australian state or territory.');
    if (excludeHolidays && (Number(start.slice(0, 4)) < 1801 || Number(end.slice(0, 4)) > 2100)) {
        throw new Error('Australian holiday calendars support 1801–2100. Change the dates or turn off public-holiday exclusions.');
    }
    const overrides = data.holiday_overrides ?? {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 5000) {
        throw new Error('Holiday selections must be a date-to-boolean object with up to 5000 dates.');
    }
    const checkedOverrides = {};
    for (const [day, excluded] of Object.entries(overrides)) {
        requireDate(day, 'Holiday override');
        if (typeof excluded !== 'boolean') throw new Error('Holiday selections must be true or false.');
        checkedOverrides[day] = excluded;
    }
    return {
        start_date: start,
        end_date: end,
        annual_entitlement: data.annual_entitlement,
        leave_periods: leavePeriods,
        excluded_weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
        exclude_public_holidays: excludeHolidays,
        holiday_region: region,
        holiday_overrides: checkedOverrides,
        additional_excluded_dates: requireDateList(data.additional_excluded_dates ?? [], 'Additional excluded dates', 1000),
    };
}

export function filterEntries(periods, query = '', year = 'all', sort = 'newest') {
    const search = query.trim().toLocaleLowerCase('en-AU');
    const matches = periods.filter(period => {
        if (year !== 'all' && (period.start_date > `${year}-12-31` || period.end_date < `${year}-01-01`)) return false;
        if (!search) return true;
        if (dateNumber(search) !== null && period.start_date <= search && period.end_date >= search) return true;
        const searchable = [period.label, period.start_date, period.end_date,
            formatRange(period.start_date, period.end_date),
            formatDate(period.start_date, { month: 'long' }), formatDate(period.end_date, { month: 'long' })];
        return searchable.join(' ').toLocaleLowerCase('en-AU').includes(search);
    });
    return matches.sort((a, b) => {
        if (sort === 'name') return (a.label || 'Annual leave').localeCompare(b.label || 'Annual leave', 'en-AU');
        return sort === 'oldest' ? a.start_date.localeCompare(b.start_date) : b.start_date.localeCompare(a.start_date);
    });
}

export function paginate(items, page, size) {
    const pageSize = [10, 20, 50].includes(size) ? size : 10;
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    const currentPage = Math.min(pages, Math.max(1, Math.floor(page) || 1));
    const start = (currentPage - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), page: currentPage, pages, start, total: items.length };
}

export function isHolidaySelected(holiday, overrides) {
    return Object.hasOwn(overrides, holiday.date) ? overrides[holiday.date] : holiday.default_excluded;
}

export function previewPeriod(start, end, settings, holidayCalendar) {
    const first = dateNumber(start), last = dateNumber(end);
    const windowFirst = dateNumber(settings.start_date), windowLast = dateNumber(settings.end_date);
    if ([first, last, windowFirst, windowLast].some(day => day === null) || first > last || windowFirst > windowLast) return null;
    if (windowLast - windowFirst + 1 > MAX_PERIOD_DAYS) return null;
    if (settings.exclude_public_holidays && (!holidayCalendar
        || holidayCalendar.start_date !== settings.start_date || holidayCalendar.end_date !== settings.end_date
        || holidayCalendar.region !== settings.holiday_region)) return { unavailable: true };
    const holidayDates = new Set(settings.exclude_public_holidays
        ? holidayCalendar.holidays.filter(holiday => isHolidaySelected(holiday, settings.holiday_overrides)).map(holiday => holiday.date) : []);
    const weekdays = new Set(settings.excluded_weekdays);
    const customDates = new Set(settings.additional_excluded_dates);
    let leaveDays = 0, excludedDays = 0, inPeriod = 0;
    for (let day = Math.max(first, windowFirst); day <= Math.min(last, windowLast); day++) {
        inPeriod++;
        const weekday = ((day + 3) % 7 + 7) % 7; // Unix day 0 was a Thursday; Monday is 0.
        const iso = dateString(day);
        if (weekdays.has(weekday) || holidayDates.has(iso) || customDates.has(iso)) excludedDays++;
        else leaveDays++;
    }
    return { leave_days: leaveDays, excluded_days: excludedDays, outside_period_days: last - first + 1 - inPeriod };
}
