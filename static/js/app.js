import {
    MAX_ENTRIES, dateNumber, dateString, daysLabel, escapeHtml, filterEntries,
    formatDate, formatNumber, formatRange, initialData, isHolidaySelected,
    localToday, normaliseData, paginate, previewPeriod,
} from './utils.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STORAGE_KEY = 'leave-calculator:plan:v2';
// IDs are only UI keys, not secrets. A counter also works on HTTP LAN installs,
// where secure-context-only APIs such as crypto.randomUUID are unavailable.
let nextEntryId = 0;
const newEntryId = () => `entry-${++nextEntryId}`;
const state = {
    data: initialData(),
    result: null,
    breakdowns: new Map(),
    selected: new Set(),
    query: '', year: 'all', sort: 'newest', page: 1, pageSize: 10,
    matches: [], visible: [], editingId: null,
    revision: 0, calculationController: null, calculationTimer: null,
    holidayKey: null, holidayData: null, holidayError: null,
    holidayController: null, holidayCache: new Map(), holidayLoading: false,
    toastTimer: null, undo: null, storageBlocked: false,
};

function payload() {
    return {
        ...state.data,
        leave_periods: state.data.leave_periods.map(({ id: _id, ...period }) => period),
    };
}

function applyData(data) {
    state.data = { ...data, leave_periods: data.leave_periods.map(period => ({ ...period, id: newEntryId() })) };
    state.selected.clear();
    state.query = '';
    state.year = 'all';
    state.page = 1;
    $('entry-search').value = '';
    $('start_date').value = data.start_date;
    $('end_date').value = data.end_date;
    $('annual_entitlement').value = data.annual_entitlement;
    $('holiday-region').value = data.holiday_region || '';
    $('exclude-public-holidays').checked = data.exclude_public_holidays;
    $('dialog-enable-holidays').checked = data.exclude_public_holidays;
    document.querySelectorAll('[name="excluded_weekday"]').forEach(input => {
        input.checked = data.excluded_weekdays.includes(Number(input.value));
    });
    readSettings();
    rebuildYearOptions();
    syncRuleSummary();
    renderCustomDates();
}

function readSettings() {
    state.data.start_date = $('start_date').value;
    state.data.end_date = $('end_date').value;
    state.data.annual_entitlement = Number($('annual_entitlement').value);
    state.data.excluded_weekdays = [...document.querySelectorAll('[name="excluded_weekday"]:checked')].map(input => Number(input.value));
    state.data.exclude_public_holidays = $('exclude-public-holidays').checked;
    state.data.holiday_region = $('holiday-region').value || null;
    const reversed = state.data.start_date && state.data.end_date && state.data.start_date > state.data.end_date;
    $('end_date').setCustomValidity(reversed ? 'Calculation ends must be on or after calculation starts.' : '');
    $('annual_entitlement').setCustomValidity(
        $('annual_entitlement').value && state.data.annual_entitlement <= 0 ? 'Annual entitlement must be greater than 0.' : '',
    );
}

function showAlert(message) {
    $('alert-message').textContent = message;
    $('alert-container').hidden = false;
}

function clearAlert() {
    $('alert-container').hidden = true;
    $('alert-message').textContent = '';
}

function showToast(message, undo = null) {
    clearTimeout(state.toastTimer);
    state.undo = undo;
    $('toast-message').textContent = message;
    $('undo-action').hidden = !undo;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(hideToast, undo ? 15000 : 6000);
}

function hideToast() {
    clearTimeout(state.toastTimer);
    $('toast').hidden = true;
    state.undo = null;
}

function confirmAction(title, description, action, destructive = true) {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = description;
    $('confirm-action').textContent = action;
    $('confirm-action').className = `button ${destructive ? 'button-danger' : 'button-primary'}`;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
    });
}

function saveDraft() {
    if (state.storageBlocked) return;
    try {
        const data = normaliseData(payload());
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ metadata: { version: '2.0.0' }, formData: data }));
        $('save-status').innerHTML = '<span class="status-dot"></span> Saved in this browser';
    } catch (error) {
        $('save-status').textContent = error instanceof DOMException
            ? 'Not saved — export to keep a copy' : 'Unsaved changes — check your settings';
    }
}

async function requestJSON(url, options, controller) {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || 'The server could not complete this request.');
        return body.data;
    } catch (error) {
        if (timedOut) throw new Error('The server took too long to respond. Please try again.');
        if (error.name === 'AbortError') throw error;
        if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('Could not reach the calculator. Your plan is still here; check your connection and try again.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function invalidateResults(status, busy) {
    state.result = null;
    state.breakdowns.clear();
    ['balance-value', 'accrued-value', 'taken-value', 'excluded-value'].forEach(id => { $(id).textContent = '—'; });
    $('balance-label').textContent = 'Available balance';
    $('balance-unit').textContent = 'days';
    $('balance-value').style.setProperty('--balance-character-width', '2');
    $('balance-secondary').textContent = busy ? 'A little maths in progress' : 'Check your calculation settings';
    $('calculation-status').textContent = status;
    $('balance-overview').setAttribute('aria-busy', String(busy));
    $('balance-value').closest('.balance-card').classList.remove('is-negative');
    $('calculate-btn').disabled = busy;
    $('calculation-note').hidden = true;
    renderEntries();
}

function scheduleCalculation({ immediate = false, report = false } = {}) {
    clearTimeout(state.calculationTimer);
    state.calculationController?.abort();
    const revision = ++state.revision;
    syncRuleSummary();
    saveDraft();
    loadHolidayCalendar();
    let data;
    try {
        data = normaliseData(payload());
    } catch (error) {
        invalidateResults('Check settings', false);
        if (report) showAlert(error.message);
        return;
    }
    clearAlert();
    invalidateResults('Updating…', true);
    const ids = state.data.leave_periods.map(period => period.id);
    state.calculationTimer = setTimeout(async () => {
        const controller = new AbortController();
        state.calculationController = controller;
        try {
            const result = await requestJSON('/calculate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
            }, controller);
            if (revision !== state.revision) return;
            state.result = result;
            state.breakdowns = new Map(result.leave_period_breakdowns.map((period, index) => [ids[index], period]));
            renderResults();
            renderEntries();
        } catch (error) {
            if (revision !== state.revision || error.name === 'AbortError') return;
            invalidateResults('Try again', false);
            showAlert(error.message);
        } finally {
            if (revision === state.revision) {
                $('calculate-btn').disabled = false;
                $('balance-overview').setAttribute('aria-busy', 'false');
            }
        }
    }, immediate ? 0 : 220);
}

function renderResults() {
    const data = state.result;
    const formattedBalance = formatNumber(data.result.value, 1);
    $('balance-value').textContent = formattedBalance;
    $('balance-value').style.setProperty('--balance-character-width', String(Math.max(1, formattedBalance.length * 0.52)));
    $('balance-unit').textContent = data.result.unit;
    $('balance-label').textContent = data.balance < 0 ? 'Balance overdrawn' : 'Available balance';
    $('balance-secondary').textContent = data.result.display_secondary
        ? `${formatNumber(data.balance_hours, 1)} hours · 7.6h / day` : `Equivalent to ${formatNumber(data.balance)} days`;
    $('balance-value').closest('.balance-card').classList.toggle('is-negative', data.balance < 0);
    $('calculation-status').textContent = 'Up to date';
    $('accrued-value').textContent = formatNumber(data.entitled_leave_for_period);
    $('accrual-detail').textContent = `Across ${formatNumber(data.days_in_period)} calendar days`;
    $('taken-value').textContent = formatNumber(data.total_leave_taken);
    $('taken-detail').textContent = `From ${data.leave_periods_count} ${data.leave_periods_count === 1 ? 'entry' : 'entries'}`;
    $('excluded-value').textContent = formatNumber(data.total_excluded_days);
    const notes = [];
    if (data.overlap_days) notes.push(`${daysLabel(data.overlap_days)} already covered by an earlier saved entry.`);
    if (data.outside_period_days) notes.push(`${daysLabel(data.outside_period_days)} outside your calculation period.`);
    $('calculation-note').hidden = !notes.length;
    $('calculation-note-text').textContent = `${notes.join(' ')} These dates are not deducted again.`;
}

function syncRuleSummary() {
    const days = 7 - state.data.excluded_weekdays.length;
    $('workweek-description').textContent = days === 0
        ? 'All weekdays excluded — no leave will be deducted.' : `${days} working ${days === 1 ? 'day' : 'days'} per week`;
    const start = state.data.start_date, end = state.data.end_date;
    $('heading-period').textContent = dateNumber(start) !== null && dateNumber(end) !== null
        ? formatRange(start, end) : 'Choose a calculation period';
    $('dialog-enable-holidays').checked = state.data.exclude_public_holidays;
    renderHolidaySummary();
    syncHolidaySelections();
    updateEntryPreview();
}

function rebuildYearOptions() {
    const years = new Set();
    for (const period of state.data.leave_periods) {
        for (let year = Number(period.start_date.slice(0, 4)); year <= Number(period.end_date.slice(0, 4)); year++) years.add(String(year).padStart(4, '0'));
    }
    const sorted = [...years].sort().reverse();
    $('year-filter').innerHTML = '<option value="all">All years</option>'
        + sorted.map(year => `<option value="${year}">${year}</option>`).join('');
    if (!years.has(state.year)) state.year = 'all';
    $('year-filter').value = state.year;
}

function renderEntries() {
    const periods = state.data.leave_periods;
    state.matches = filterEntries(periods, state.query, state.year, state.sort);
    const page = paginate(state.matches, state.page, state.pageSize);
    state.page = page.page;
    state.visible = page.items;
    $('entry-count').textContent = formatNumber(periods.length);
    $('nav-entry-count').textContent = formatNumber(periods.length);
    $('nav-entries-link').setAttribute('aria-label', `Leave entries ${formatNumber(periods.length)}`);
    $('add-leave-period').disabled = periods.length >= MAX_ENTRIES;
    $('table-container').hidden = page.total === 0;
    $('empty-state').hidden = page.total !== 0;
    const emptyPlan = periods.length === 0;
    $('empty-heading').textContent = emptyPlan ? 'A blank page. A world of possibilities.' : 'No leave entries found.';
    $('empty-description').textContent = emptyPlan
        ? 'Add the days you’ve taken or the breaks you’re planning. We’ll take care of the counting.'
        : 'Try another name, date or year. Your other entries are still here.';
    $('empty-add').hidden = !emptyPlan;
    $('clear-filters').hidden = emptyPlan;
    const focused = document.activeElement;
    const focusedId = focused?.closest('tr[data-id]')?.dataset.id;
    const focusedAction = focused?.dataset.action;
    $('leave-periods-list').innerHTML = page.items.map(period => {
        const row = state.breakdowns.get(period.id);
        const label = escapeHtml(period.label || 'Annual leave');
        const dates = escapeHtml(formatRange(period.start_date, period.end_date));
        const meta = [];
        if (row?.excluded_days) meta.push(`${daysLabel(row.excluded_days)} excluded`);
        if (row?.overlap_days) meta.push(`${daysLabel(row.overlap_days)} already counted`);
        if (row?.outside_period_days) meta.push(`${daysLabel(row.outside_period_days)} outside period`);
        return `<tr data-id="${period.id}">
            <td class="selection-cell"><input type="checkbox" data-action="select" aria-label="Select ${label}, ${dates}"></td>
            <td><span class="entry-name">${label}</span><span class="entry-dates">${dates}</span>${meta.length ? `<span class="entry-meta">${escapeHtml(meta.join(' · '))}</span>` : ''}</td>
            <td class="type-cell"><span class="type-badge ${period.start_date === period.end_date ? 'single' : ''}">${period.start_date === period.end_date ? 'Single day' : 'Date range'}</span></td>
            <td class="numeric-cell excluded-cell">${row ? formatNumber(row.excluded_days) : '—'}</td>
            <td class="numeric-cell leave-days">${row ? formatNumber(row.leave_days) : '—'}</td>
            <td><div class="entry-actions"><button type="button" class="icon-button" data-action="edit" title="Edit entry" aria-label="Edit ${label}, ${dates}">${icon('edit')}</button><button type="button" class="icon-button delete-entry" data-action="delete" title="Delete entry" aria-label="Delete ${label}, ${dates}">${icon('trash')}</button></div></td>
        </tr>`;
    }).join('');
    $('entry-range').textContent = page.total
        ? `${page.start + 1}–${page.start + page.items.length} of ${page.total} ${page.total !== periods.length ? `matching (${periods.length} total)` : 'entries'}`
        : emptyPlan ? 'No entries yet' : `0 matching · ${periods.length} total`;
    $('page-indicator').textContent = `${page.page} / ${page.pages}`;
    $('previous-page').disabled = page.page <= 1;
    $('next-page').disabled = page.page >= page.pages;
    syncSelection();
    if (focusedId && focusedAction) {
        $(`leave-periods-list`).querySelector(`tr[data-id="${CSS.escape(focusedId)}"] [data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
    }
}

function syncSelection() {
    for (const row of $('leave-periods-list').querySelectorAll('tr')) {
        const checked = state.selected.has(row.dataset.id);
        row.classList.toggle('is-selected', checked);
        row.querySelector('[data-action="select"]').checked = checked;
    }
    const selectedOnPage = state.visible.filter(period => state.selected.has(period.id)).length;
    $('select-page').checked = state.visible.length > 0 && selectedOnPage === state.visible.length;
    $('select-page').indeterminate = selectedOnPage > 0 && selectedOnPage < state.visible.length;
    $('selected-count').textContent = `${state.selected.size} selected`;
    $('bulk-toolbar').hidden = state.selected.size === 0;
    $('select-all-matching').textContent = `Select all ${state.matches.length} matching`;
    $('select-all-matching').disabled = state.matches.every(period => state.selected.has(period.id));
}

function showEntryEditor(id = null) {
    const period = state.data.leave_periods.find(entry => entry.id === id);
    state.editingId = period?.id || null;
    let defaultDate = localToday();
    if (dateNumber(state.data.start_date) !== null && dateNumber(state.data.end_date) !== null && state.data.start_date <= state.data.end_date) {
        defaultDate = dateString(Math.min(dateNumber(state.data.end_date), Math.max(dateNumber(state.data.start_date), dateNumber(defaultDate))));
    }
    $('entry-label').value = period?.label || '';
    $('entry-start').value = period?.start_date || defaultDate;
    $('entry-end').value = period?.end_date || defaultDate;
    $('entry-single-day').checked = !period || period.start_date === period.end_date;
    $('entry-dialog-title').textContent = period ? 'Edit your time off.' : 'Add a little time off.';
    $('save-entry-text').textContent = period ? 'Save changes' : 'Add entry';
    $('entry-error').hidden = true;
    updateEntryDates();
    $('entry-dialog').showModal();
}

function updateEntryDates() {
    const single = $('entry-single-day').checked;
    $('entry-end').disabled = single;
    $('entry-end').required = !single;
    if (single) $('entry-end').value = $('entry-start').value;
    const reversed = $('entry-start').value && $('entry-end').value && $('entry-start').value > $('entry-end').value;
    $('entry-end').setCustomValidity(reversed ? 'The last day must be on or after the first day.' : '');
    updateEntryPreview();
}

function updateEntryPreview() {
    const preview = previewPeriod($('entry-start').value, $('entry-end').value, state.data, state.holidayData);
    if (!preview) {
        $('preview-days').textContent = 'Choose a valid date range';
        $('preview-detail').textContent = 'First and last days are both included.';
    } else if (preview.unavailable) {
        $('preview-days').textContent = state.holidayError ? 'Holiday preview unavailable' : 'Loading your holiday calendar…';
        $('preview-detail').textContent = 'Your final deduction is checked by the server when you save.';
    } else {
        $('preview-days').textContent = `${daysLabel(preview.leave_days)} of leave`;
        const detail = [];
        if (preview.excluded_days) detail.push(`${daysLabel(preview.excluded_days)} excluded`);
        if (preview.outside_period_days) detail.push(`${daysLabel(preview.outside_period_days)} outside your period`);
        $('preview-detail').textContent = detail.length ? `${detail.join(' · ')}. Before overlap checks.` : 'Before overlap checks. Your calendar settings apply.';
    }
}

function saveEntry(event) {
    event.preventDefault();
    const period = {
        id: state.editingId || newEntryId(),
        label: $('entry-label').value.trim(),
        start_date: $('entry-start').value,
        end_date: $('entry-single-day').checked ? $('entry-start').value : $('entry-end').value,
    };
    period.is_range = period.start_date !== period.end_date;
    const index = state.data.leave_periods.findIndex(entry => entry.id === state.editingId);
    const periods = [...state.data.leave_periods];
    if (index >= 0) periods[index] = period;
    else periods.push(period);
    try {
        normaliseData({ ...payload(), leave_periods: periods });
    } catch (error) {
        $('entry-error').textContent = error.message;
        $('entry-error').hidden = false;
        return;
    }
    state.data.leave_periods = periods;
    rebuildYearOptions();
    // Show the saved entry even when an old filter would otherwise hide it.
    if (!filterEntries(periods, state.query, state.year, state.sort).some(entry => entry.id === period.id)) {
        state.query = '';
        state.year = 'all';
        $('entry-search').value = '';
        $('year-filter').value = 'all';
    }
    const matches = filterEntries(periods, state.query, state.year, state.sort);
    state.page = Math.floor(matches.findIndex(entry => entry.id === period.id) / state.pageSize) + 1;
    $('entry-dialog').close();
    scheduleCalculation({ immediate: true, report: true });
    showToast(index >= 0 ? 'Leave entry updated.' : 'A little time off, added to your plan.');
}

async function deleteEntries(ids) {
    const count = ids.size;
    if (!count || !await confirmAction(
        count === 1 ? 'Remove this leave entry?' : `Remove ${count} leave entries?`,
        'These entries will be removed from your plan and your balance will be recalculated. You can undo this immediately afterwards.',
        count === 1 ? 'Remove entry' : `Remove ${count} entries`,
    )) return;
    const removed = state.data.leave_periods.map((period, index) => ({ period, index })).filter(item => ids.has(item.period.id));
    state.data.leave_periods = state.data.leave_periods.filter(period => !ids.has(period.id));
    ids.forEach(id => state.selected.delete(id));
    rebuildYearOptions();
    scheduleCalculation({ immediate: true });
    showToast(`${count} ${count === 1 ? 'entry' : 'entries'} removed.`, () => {
        if (state.data.leave_periods.length + removed.length > MAX_ENTRIES) {
            showAlert(`Restoring these entries would exceed the ${MAX_ENTRIES}-entry limit. Export your current plan first.`);
            return;
        }
        for (const item of removed) state.data.leave_periods.splice(Math.min(item.index, state.data.leave_periods.length), 0, item.period);
        rebuildYearOptions();
        scheduleCalculation({ immediate: true });
        showToast('Your leave entries have been restored.');
    });
}

async function loadHolidayCalendar(force = false) {
    const { start_date: start, end_date: end, holiday_region: region } = state.data;
    if (dateNumber(start) === null || dateNumber(end) === null || start > end) {
        state.holidayController?.abort();
        state.holidayKey = null;
        state.holidayData = null;
        state.holidayLoading = false;
        state.holidayError = 'Choose a valid calculation period to see public holidays.';
        renderHolidaySummary();
        if ($('holidays-dialog').open) renderHolidayDialog();
        return;
    }
    const key = `${start}|${end}|${region || 'AU'}`;
    if (key === state.holidayKey && !force) return;
    state.holidayController?.abort();
    state.holidayKey = key;
    state.holidayData = null;
    state.holidayError = null;
    if (state.holidayCache.has(key) && !force) {
        state.holidayData = state.holidayCache.get(key);
        state.holidayLoading = false;
        renderHolidaySummary();
        if ($('holidays-dialog').open) renderHolidayDialog();
        updateEntryPreview();
        return;
    }
    state.holidayLoading = true;
    const controller = new AbortController();
    state.holidayController = controller;
    renderHolidaySummary();
    if ($('holidays-dialog').open) renderHolidayDialog();
    const query = new URLSearchParams({ start_date: start, end_date: end });
    if (region) query.set('region', region);
    try {
        const data = await requestJSON(`/holidays?${query}`, {}, controller);
        if (state.holidayKey !== key || controller.signal.aborted) return;
        state.holidayData = data;
        if (state.holidayCache.size >= 12) state.holidayCache.delete(state.holidayCache.keys().next().value);
        state.holidayCache.set(key, data);
    } catch (error) {
        if (state.holidayKey !== key || error.name === 'AbortError') return;
        state.holidayError = error.message;
    } finally {
        if (state.holidayKey === key && state.holidayController === controller) {
            state.holidayLoading = false;
            renderHolidaySummary();
            if ($('holidays-dialog').open) renderHolidayDialog();
            updateEntryPreview();
        }
    }
}

function renderHolidaySummary() {
    const summary = $('holiday-summary');
    summary.classList.toggle('is-active', state.data.exclude_public_holidays);
    if (state.holidayLoading) summary.textContent = 'Finding your holiday calendar…';
    else if (state.holidayError) summary.textContent = 'Calendar unavailable. Open to review or retry.';
    else if (state.holidayData) {
        const selected = state.holidayData.holidays.filter(holiday => isHolidaySelected(holiday, state.data.holiday_overrides)).length;
        summary.textContent = state.data.exclude_public_holidays
            ? `${selected} full-day ${selected === 1 ? 'holiday' : 'holidays'} selected in your period.`
            : `${state.holidayData.holidays.length} ${state.holidayData.holidays.length === 1 ? 'holiday' : 'holidays'} available · exclusions switched off.`;
    }
    const customCount = state.data.additional_excluded_dates.length;
    if (customCount) summary.textContent += ` ${customCount} custom ${customCount === 1 ? 'date' : 'dates'} saved.`;
}

function showHolidayDialog() {
    loadHolidayCalendar();
    renderHolidayDialog();
    if (!$('holidays-dialog').open) $('holidays-dialog').showModal();
}

function renderHolidayDialog() {
    const data = state.holidayData;
    const regionName = $('holiday-region').selectedOptions[0]?.textContent || 'National holidays only';
    $('holiday-calendar-title').textContent = `${regionName} · ${formatRange(state.data.start_date, state.data.end_date)}`;
    $('holiday-list').setAttribute('aria-busy', String(state.holidayLoading));
    $('holiday-load-error').hidden = !state.holidayError;
    $('holiday-error-text').textContent = state.holidayError || '';
    if (!data) {
        $('holiday-list').innerHTML = `<p class="holiday-list-message">${state.holidayLoading ? 'Finding your public holidays…' : 'No holiday calendar loaded.'}</p>`;
    } else {
        let year = '';
        $('holiday-list').innerHTML = data.holidays.map(holiday => {
            let header = '';
            if (holiday.date.slice(0, 4) !== year) {
                year = holiday.date.slice(0, 4);
                header = `<div class="holiday-year">${escapeHtml(year)}</div>`;
            }
            return `${header}<label class="holiday-row"><input type="checkbox" data-holiday-date="${escapeHtml(holiday.date)}"><span><span class="holiday-row-name">${escapeHtml(holiday.name)}</span><span class="holiday-row-date">${escapeHtml(formatDate(holiday.date, { weekday: 'long' }))}</span>${holiday.note ? `<span class="holiday-row-note">${escapeHtml(holiday.note)}</span>` : ''}</span><span class="holiday-weekday-tag" aria-hidden="true">${escapeHtml(formatDate(holiday.date, { weekday: 'short', day: undefined, month: undefined, year: undefined }))}</span></label>`;
        }).join('') || '<p class="holiday-list-message">No full-day public holidays in this period. You can add local dates below.</p>';
        $('holiday-source-description').textContent = `Generated locally with ${data.source.name} ${data.source.version}. No API key or live connection needed.`;
        $('holiday-source-notes').innerHTML = data.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('');
    }
    syncHolidaySelections();
    renderCustomDates();
}

function syncHolidaySelections() {
    const enabled = state.data.exclude_public_holidays;
    $('dialog-enable-holidays').checked = enabled;
    const holidays = state.holidayData?.holidays || [];
    const byDate = new Map(holidays.map(holiday => [holiday.date, holiday]));
    for (const input of $('holiday-list').querySelectorAll('[data-holiday-date]')) {
        const holiday = byDate.get(input.dataset.holidayDate);
        input.checked = holiday ? isHolidaySelected(holiday, state.data.holiday_overrides) : false;
        input.disabled = !enabled;
        input.closest('label').classList.toggle('is-disabled', !enabled);
    }
    const selected = holidays.filter(holiday => isHolidaySelected(holiday, state.data.holiday_overrides)).length;
    $('holiday-selected-count').textContent = state.holidayLoading ? 'Loading holidays…'
        : `${selected} of ${holidays.length} selected${enabled ? '' : ' · exclusions off'}`;
    $('select-all-holidays').disabled = !enabled || !holidays.length;
    $('select-no-holidays').disabled = !enabled || !holidays.length;
}

function togglePublicHolidays(checked) {
    state.data.exclude_public_holidays = checked;
    $('exclude-public-holidays').checked = checked;
    scheduleCalculation({ report: true });
}

function setHolidaySelection(holiday, checked) {
    if (checked === holiday.default_excluded) delete state.data.holiday_overrides[holiday.date];
    else state.data.holiday_overrides[holiday.date] = checked;
}

function renderCustomDates() {
    $('custom-dates-list').innerHTML = state.data.additional_excluded_dates.map(day =>
        `<span class="custom-date-chip">${escapeHtml(formatDate(day))}<button type="button" class="icon-button" data-remove-date="${day}" aria-label="Remove exclusion for ${escapeHtml(formatDate(day))}">${icon('close')}</button></span>`).join('');
}

function exportData() {
    try {
        const data = normaliseData(payload());
        const file = {
            metadata: { application: 'Annual Leave Calculator', version: '2.0.0', exportDate: new Date().toISOString() },
            formData: data,
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `leave-calculator-data-${localToday()}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`All ${data.leave_periods.length} entries and your calculation rules exported.`);
    } catch (error) {
        showAlert(`Could not export your plan. ${error.message}`);
    }
}

async function importData(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        if (!file.name.toLowerCase().endsWith('.json') || file.size > 5 * 1024 * 1024) throw new Error('Choose a JSON file no larger than 5 MB.');
        const imported = JSON.parse(await file.text());
        const raw = imported?.formData ?? imported;
        const data = normaliseData(raw);
        const legacy = !Object.hasOwn(raw, 'excluded_weekdays');
        if (!await confirmAction('Open this leave plan?', 'This replaces all current entries and calculation rules in this browser. Export your current plan first if you’d like to keep it.', 'Replace plan', false)) return;
        applyData(data);
        state.storageBlocked = false;
        scheduleCalculation({ immediate: true, report: true });
        showToast(legacy ? 'Plan imported. Original calendar-day counting preserved — adjust your working week to change it.' : `${data.leave_periods.length} leave entries and your calculation rules imported.`);
    } catch (error) {
        showAlert(`Your current plan has not been changed. ${error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message}`);
    }
}

async function startFresh() {
    if (!await confirmAction('A fresh start?', 'This clears the plan saved in this browser, including all entries and exclusions. Export a copy first if you want to keep it.', 'Start fresh')) return;
    applyData(initialData());
    state.storageBlocked = false;
    scheduleCalculation({ immediate: true });
    showToast('A fresh plan. Room for something good.');
}

function bindEvents() {
    $('leave-calculator-form').addEventListener('submit', event => { event.preventDefault(); readSettings(); scheduleCalculation({ immediate: true, report: true }); });
    for (const id of ['start_date', 'end_date', 'annual_entitlement']) {
        $(id).addEventListener('input', () => { readSettings(); scheduleCalculation(); });
        $(id).addEventListener('change', () => { readSettings(); scheduleCalculation({ report: true }); });
    }
    document.querySelectorAll('[name="excluded_weekday"]').forEach(input => input.addEventListener('change', () => { readSettings(); scheduleCalculation(); }));
    const setWeekdays = weekdays => {
        document.querySelectorAll('[name="excluded_weekday"]').forEach(input => { input.checked = weekdays.includes(Number(input.value)); });
        readSettings();
        scheduleCalculation();
    };
    $('weekend-preset').addEventListener('click', () => setWeekdays([5, 6]));
    $('all-days-preset').addEventListener('click', () => setWeekdays([]));
    $('exclude-public-holidays').addEventListener('change', event => togglePublicHolidays(event.target.checked));
    $('dialog-enable-holidays').addEventListener('change', event => togglePublicHolidays(event.target.checked));
    $('holiday-region').addEventListener('change', () => {
        state.data.holiday_overrides = {};
        readSettings();
        scheduleCalculation({ report: true });
        showToast('Holiday selections reset for this region. Your custom dates are unchanged.');
    });
    $('review-holidays').addEventListener('click', showHolidayDialog);
    $('nav-holidays').addEventListener('click', showHolidayDialog);
    $('retry-holidays').addEventListener('click', () => loadHolidayCalendar(true));
    $('holiday-list').addEventListener('change', event => {
        const holiday = state.holidayData?.holidays.find(item => item.date === event.target.dataset.holidayDate);
        if (!holiday) return;
        setHolidaySelection(holiday, event.target.checked);
        scheduleCalculation();
    });
    for (const [id, checked] of [['select-all-holidays', true], ['select-no-holidays', false]]) {
        $(id).addEventListener('click', () => {
            for (const holiday of state.holidayData?.holidays || []) setHolidaySelection(holiday, checked);
            scheduleCalculation();
        });
    }
    $('custom-date-form').addEventListener('submit', event => {
        event.preventDefault();
        const day = $('custom-exclusion-date').value;
        if (dateNumber(day) === null) return;
        if (state.data.additional_excluded_dates.includes(day)) { showToast('That date is already excluded.'); return; }
        if (state.data.additional_excluded_dates.length >= 1000) { showToast('You can add up to 1000 custom dates.'); return; }
        state.data.additional_excluded_dates.push(day);
        state.data.additional_excluded_dates.sort();
        $('custom-exclusion-date').value = '';
        renderCustomDates();
        scheduleCalculation();
    });
    $('custom-dates-list').addEventListener('click', event => {
        const button = event.target.closest('[data-remove-date]');
        if (!button) return;
        state.data.additional_excluded_dates = state.data.additional_excluded_dates.filter(day => day !== button.dataset.removeDate);
        renderCustomDates();
        $('custom-exclusion-date').focus();
        scheduleCalculation();
    });
    $('add-leave-period').addEventListener('click', () => showEntryEditor());
    $('empty-add').addEventListener('click', () => showEntryEditor());
    $('entry-form').addEventListener('submit', saveEntry);
    ['entry-start', 'entry-end', 'entry-single-day'].forEach(id => $(id).addEventListener('input', updateEntryDates));
    $('entry-search').addEventListener('input', event => { state.query = event.target.value; state.page = 1; renderEntries(); });
    $('year-filter').addEventListener('change', event => { state.year = event.target.value; state.page = 1; renderEntries(); });
    $('entry-sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; renderEntries(); });
    $('page-size').addEventListener('change', event => { state.pageSize = Number(event.target.value); state.page = 1; renderEntries(); });
    $('previous-page').addEventListener('click', () => { state.page--; renderEntries(); });
    $('next-page').addEventListener('click', () => { state.page++; renderEntries(); });
    $('clear-filters').addEventListener('click', () => {
        state.query = ''; state.year = 'all'; state.page = 1;
        $('entry-search').value = ''; $('year-filter').value = 'all'; renderEntries(); $('entry-search').focus();
    });
    $('leave-periods-list').addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const id = button.closest('tr').dataset.id;
        if (button.dataset.action === 'edit') showEntryEditor(id);
        if (button.dataset.action === 'delete') deleteEntries(new Set([id]));
    });
    $('leave-periods-list').addEventListener('change', event => {
        if (event.target.dataset.action !== 'select') return;
        const id = event.target.closest('tr').dataset.id;
        if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
        syncSelection();
    });
    $('select-page').addEventListener('change', event => {
        state.visible.forEach(period => { if (event.target.checked) state.selected.add(period.id); else state.selected.delete(period.id); });
        syncSelection();
    });
    $('select-all-matching').addEventListener('click', () => { state.matches.forEach(period => state.selected.add(period.id)); syncSelection(); });
    $('clear-selection').addEventListener('click', () => { state.selected.clear(); syncSelection(); });
    $('delete-selected').addEventListener('click', () => deleteEntries(new Set(state.selected)));
    $('export-data-btn').addEventListener('click', exportData);
    $('import-data-btn').addEventListener('click', () => $('import-file-input').click());
    $('import-file-input').addEventListener('change', importData);
    $('start-fresh').addEventListener('click', startFresh);
    $('start-fresh-inline').addEventListener('click', startFresh);
    $('dismiss-alert').addEventListener('click', clearAlert);
    $('dismiss-toast').addEventListener('click', hideToast);
    $('undo-action').addEventListener('click', () => { const undo = state.undo; hideToast(); undo?.(); });
    document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    for (const dialog of document.querySelectorAll('dialog')) {
        dialog.addEventListener('click', event => {
            const rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close('cancel');
        });
        dialog.addEventListener('close', () => { document.body.style.overflow = document.querySelector('dialog[open]') ? 'hidden' : ''; });
        new MutationObserver(() => { if (dialog.open) document.body.style.overflow = 'hidden'; }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
    }
    document.querySelectorAll('.navigation a').forEach(link => link.addEventListener('click', () => {
        document.querySelectorAll('.navigation a').forEach(item => { item.classList.remove('active'); item.removeAttribute('aria-current'); });
        link.classList.add('active'); link.setAttribute('aria-current', 'location');
    }));
}

function initialise() {
    let data = initialData();
    let restoreError = null;
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) data = normaliseData(JSON.parse(saved).formData);
    } catch (error) {
        if (!(error instanceof DOMException)) {
            state.storageBlocked = true;
            restoreError = 'Your saved plan could not be restored and has not been overwritten. Import a backup or start a fresh calculation.';
            $('save-status').textContent = 'Saved plan needs attention';
        }
    }
    applyData(data);
    bindEvents();
    scheduleCalculation({ immediate: true });
    if (restoreError) showAlert(restoreError);
}

initialise();
