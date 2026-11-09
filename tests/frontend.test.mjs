// No npm install or build step required: node --test tests/frontend.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    dateNumber, dateString, daysLabel, escapeHtml, filterEntries, formatRange,
    initialData, isHolidaySelected, normaliseData, paginate, previewPeriod,
} from '../static/js/utils.js';

const base = () => ({ ...initialData('2026-12-31'), start_date: '2026-01-01' });
const entry = (start, end = start, label = '', id = start) => ({ start_date: start, end_date: end, label, id });
const calendar = (holidays, region = 'NSW') => ({
    start_date: '2026-01-01', end_date: '2026-12-31', region,
    holidays: holidays.map(([date, default_excluded = true]) => ({ date, default_excluded })),
});

test('dates are exact ISO calendar dates, including leap days', () => {
    assert.notEqual(dateNumber('2024-02-29'), null);
    assert.notEqual(dateNumber('0001-01-01'), null);
    for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '20260101', '1/1/2026', '2026-01-01T00:00:00Z', '0000-01-01', undefined, 123]) {
        assert.equal(dateNumber(value), null, String(value));
    }
    assert.equal(dateString(dateNumber('2026-10-04') + 1), '2026-10-05');
    assert.equal(dateNumber('2026-10-05') - dateNumber('2026-10-02'), 3);
});

test('range and number presentation', () => {
    assert.equal(formatRange('2026-01-01', '2026-01-01'), '1 Jan 2026');
    assert.equal(formatRange('2026-12-24', '2026-12-31'), '24 Dec – 31 Dec 2026');
    assert.equal(formatRange('2025-12-24', '2026-01-02'), '24 Dec 2025 – 2 Jan 2026');
    assert.equal(daysLabel(1), '1 day');
    assert.equal(daysLabel(2), '2 days');
});

test('new plans default to weekends off, without assuming a holiday jurisdiction', () => {
    assert.deepEqual(initialData('2026-11-09'), {
        start_date: '2026-01-01', end_date: '2026-11-09', annual_entitlement: 20,
        leave_periods: [], excluded_weekdays: [5, 6], exclude_public_holidays: false,
        holiday_region: null, holiday_overrides: {}, additional_excluded_dates: [],
    });
});

test('legacy exports keep their calendar-day counting', () => {
    const result = normaliseData({
        start_date: '2026-01-01', end_date: '2026-12-31', annual_entitlement: 20,
        leave_periods: [{ start_date: '2026-06-01', end_date: '2026-06-07', is_range: true }],
    });
    assert.deepEqual(result.excluded_weekdays, []);
    assert.equal(result.exclude_public_holidays, false);
    assert.equal(result.leave_periods[0].label, '');
});

test('all calculation rules and labels survive a JSON round trip, IDs do not', () => {
    const data = {
        ...base(), leave_periods: [entry('2026-06-01', '2026-06-05', '  Winter break  ', 'private-ui-id')],
        excluded_weekdays: [6, 5, 5], exclude_public_holidays: true, holiday_region: 'QLD',
        holiday_overrides: { '2026-08-12': true, '2026-12-25': false },
        additional_excluded_dates: ['2026-07-17', '2026-07-16', '2026-07-16'],
    };
    const once = normaliseData(data), twice = normaliseData(JSON.parse(JSON.stringify(once)));
    assert.deepEqual(once, twice);
    assert.deepEqual(once.excluded_weekdays, [5, 6]);
    assert.deepEqual(once.additional_excluded_dates, ['2026-07-16', '2026-07-17']);
    assert.equal(once.leave_periods[0].label, 'Winter break');
    assert.equal(once.leave_periods[0].id, undefined);
});

test('bad imports are rejected rather than partially loaded', () => {
    for (const changes of [
        { start_date: '2026-02-30' }, { end_date: '2025-12-31' }, { annual_entitlement: 0 },
        { annual_entitlement: Infinity }, { annual_entitlement: '20' }, { annual_entitlement: 367 },
        { excluded_weekdays: [7] }, { excluded_weekdays: [true] }, { excluded_weekdays: ['5'] },
        { leave_periods: 'oops' }, { leave_periods: [entry('2026-01-03', '2026-01-01')] },
        { leave_periods: [entry('2026-01-01', '2026-01-01', 'x'.repeat(101))] },
        { leave_periods: Array(1001).fill(entry('2026-01-01')) },
        { exclude_public_holidays: 'false' }, { holiday_region: 'XYZ' }, { holiday_region: false },
        { holiday_overrides: { '2026-01-01': 'false' } }, { holiday_overrides: { '2026-02-30': false } },
        { additional_excluded_dates: ['not a date'] }, { holiday_overrides: [] },
        { exclude_public_holidays: true, end_date: '2101-01-01', start_date: '2100-01-01' },
    ]) assert.throws(() => normaliseData({ ...base(), ...changes }), JSON.stringify(changes).slice(0, 150));
    assert.throws(() => normaliseData(null));
    assert.throws(() => normaliseData([]));
});

test('prototype keys and imported HTML cannot become executable markup', () => {
    const dangerous = JSON.parse('{"__proto__":true}');
    assert.throws(() => normaliseData({ ...base(), holiday_overrides: dangerous }));
    assert.equal(escapeHtml('<img src=x onerror="alert(1)"> & \'test\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;');
});

test('search matches names, ISO dates and readable months', () => {
    const entries = [entry('2026-12-24', '2026-12-31', 'Summer break'), entry('2026-06-01', '2026-06-05', 'Winter break')];
    assert.equal(filterEntries(entries, 'SUMMER').length, 1);
    assert.equal(filterEntries(entries, '2026-06').length, 1);
    assert.equal(filterEntries(entries, '2026-06-03').length, 1);
    assert.equal(filterEntries(entries, 'december').length, 1);
    assert.equal(filterEntries(entries, 'missing').length, 0);
    assert.equal(entries[0].label, 'Summer break'); // The source array is never sorted in place.
});

test('year filters include entries spanning year boundaries', () => {
    const entries = [entry('2025-12-24', '2027-01-05', 'Long break'), entry('2025-01-01')];
    assert.equal(filterEntries(entries, '', '2026').length, 1);
    assert.equal(filterEntries(entries, '', '2028').length, 0);
});

test('oldest, newest and name sorting are stable', () => {
    const entries = [entry('2026-06-01', undefined, 'Zoo'), entry('2026-01-01', undefined, 'Apple')];
    assert.equal(filterEntries(entries, '', 'all', 'newest')[0].label, 'Zoo');
    assert.equal(filterEntries(entries, '', 'all', 'oldest')[0].label, 'Apple');
    assert.equal(filterEntries(entries, '', 'all', 'name')[0].label, 'Apple');
});

test('pagination bounds the rendered list and clamps pages after deletions', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => index);
    assert.equal(paginate(entries, 1, 10).items.length, 10);
    assert.deepEqual(paginate(entries, 100, 10).items, entries.slice(990));
    assert.equal(paginate(entries.slice(0, 5), 100, 10).page, 1);
    assert.equal(paginate([], 0, 10).pages, 1);
    assert.equal(paginate(entries, 1, 20).items.length, 20);
    assert.equal(paginate(entries, 1, 999).items.length, 10);
});

test('weekday, holiday and custom exclusions share one date-only preview', () => {
    const settings = { ...base(), exclude_public_holidays: true, holiday_region: 'NSW' };
    const holidays = calendar([['2026-12-25'], ['2026-12-26'], ['2026-12-28']]);
    assert.deepEqual(previewPeriod('2026-12-24', '2026-12-31', settings, holidays), {
        leave_days: 4, excluded_days: 4, outside_period_days: 0,
    });
    settings.holiday_overrides['2026-12-25'] = false;
    assert.equal(previewPeriod('2026-12-24', '2026-12-31', settings, holidays).leave_days, 5);
    settings.additional_excluded_dates.push('2026-12-29');
    assert.equal(previewPeriod('2026-12-24', '2026-12-31', settings, holidays).leave_days, 4);
});

test('a weekend holiday is only excluded once', () => {
    const settings = { ...base(), exclude_public_holidays: true, holiday_region: 'NSW', additional_excluded_dates: ['2026-12-26'] };
    assert.deepEqual(previewPeriod('2026-12-26', '2026-12-26', settings, calendar([['2026-12-26']])), {
        leave_days: 0, excluded_days: 1, outside_period_days: 0,
    });
});

test('partial and entirely out-of-window entries are clipped', () => {
    const settings = { ...base(), start_date: '2026-05-04', end_date: '2026-05-08' };
    assert.deepEqual(previewPeriod('2026-05-01', '2026-05-10', settings, null), {
        leave_days: 5, excluded_days: 0, outside_period_days: 5,
    });
    assert.equal(previewPeriod('2026-04-01', '2026-04-02', settings, null).leave_days, 0);
});

test('stale or unavailable holiday calendars never produce misleading previews', () => {
    const settings = { ...base(), exclude_public_holidays: true, holiday_region: 'NSW' };
    assert.deepEqual(previewPeriod('2026-01-26', '2026-01-26', settings, null), { unavailable: true });
    assert.deepEqual(previewPeriod('2026-01-26', '2026-01-26', settings, calendar([['2026-01-26']], 'VIC')), { unavailable: true });
    assert.equal(previewPeriod('', '', settings, null), null);
    assert.equal(previewPeriod('2026-01-26', '2026-01-01', settings, null), null);
});

test('restricted regional holidays require explicit opt-in', () => {
    const holiday = { date: '2026-08-12', default_excluded: false };
    assert.equal(isHolidaySelected(holiday, {}), false);
    assert.equal(isHolidaySelected(holiday, { '2026-08-12': true }), true);
    const settings = { ...base(), exclude_public_holidays: true, holiday_region: 'QLD' };
    const holidays = calendar([['2026-08-12', false]], 'QLD');
    assert.equal(previewPeriod('2026-08-12', '2026-08-12', settings, holidays).leave_days, 1);
    settings.holiday_overrides['2026-08-12'] = true;
    assert.equal(previewPeriod('2026-08-12', '2026-08-12', settings, holidays).leave_days, 0);
});

test('pre-1970 weekdays and daylight-saving transitions are counted correctly', () => {
    const settings = { ...base(), start_date: '1960-01-01', end_date: '1960-12-31' };
    assert.equal(previewPeriod('1960-01-01', '1960-01-04', settings, null).leave_days, 2);
    assert.equal(previewPeriod('2026-10-02', '2026-10-05', base(), null).leave_days, 2);
});
