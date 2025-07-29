// Annual Leave Calculator JavaScript

// Global variables for leave period management
let leavePeriods = [];
let periodIdCounter = 0;

document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('leave-calculator-form');
    const calculateBtn = document.getElementById('calculate-btn');
    const btnText = document.getElementById('btn-text');
    const btnSpinner = document.getElementById('btn-spinner');
    const resultsSection = document.querySelector('[data-results-section]');
    const alertContainer = document.getElementById('alert-container');

    // Set default end date to today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('end_date').value = today;

    // Set default start date to one year ago
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    document.getElementById('start_date').value = oneYearAgo.toISOString().split('T')[0];

    // Set default annual entitlement
    document.getElementById('annual_entitlement').value = '20';

    // Initialize leave period management
    initializeLeavePeriods();

    // Initialize export/import functionality
    initializeExportImport();

    // Form submission handler
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        // Clear previous alerts
        clearAlerts();
        
        // Validate form
        if (!validateForm()) {
            return;
        }

        // Show loading state
        setLoadingState(true);

        try {
            // Prepare form data with leave periods
            const formData = prepareFormData();
            
            // Submit to API
            const response = await fetch('/calculate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });

            const result = await response.json();

            if (result.success) {
                displayResults(result.data);
            } else {
                showAlert('danger', result.error || 'An error occurred during calculation');
            }
        } catch (error) {
            console.error('Error:', error);
            showAlert('danger', 'Network error. Please check your connection and try again.');
        } finally {
            setLoadingState(false);
        }
    });

    // Date input validation
    document.getElementById('start_date').addEventListener('change', validateDates);
    document.getElementById('end_date').addEventListener('change', validateDates);
});

// Initialize leave period management
function initializeLeavePeriods() {
    const addBtn = document.getElementById('add-leave-period');
    addBtn.addEventListener('click', addLeavePeriod);
    updateLeavePeriodDisplay();
}

// Add a new leave period
function addLeavePeriod() {
    const periodId = ++periodIdCounter;
    const period = {
        id: periodId,
        startDate: '',
        endDate: '',
        isRange: false
    };
    
    leavePeriods.push(period);
    renderLeavePeriod(period);
    updateLeavePeriodDisplay();
}

// Render a leave period in the UI
function renderLeavePeriod(period) {
    const container = document.getElementById('leave-periods-list');
    const periodElement = document.createElement('div');
    periodElement.className = 'leave-period-item border rounded p-3 mb-2 bg-white';
    periodElement.dataset.periodId = period.id;
    
    periodElement.innerHTML = `
        <div class="row g-2 align-items-center">
            <div class="col-md-3">
                <label class="form-label small mb-1">Period Type</label>
                <select class="form-select form-select-sm period-type" data-period-id="${period.id}">
                    <option value="single">Single Day</option>
                    <option value="range">Date Range</option>
                </select>
            </div>
            <div class="col-md-3">
                <label class="form-label small mb-1">Start Date</label>
                <input type="date" class="form-control form-control-sm period-start-date"
                       data-period-id="${period.id}" required>
            </div>
            <div class="col-md-3">
                <label class="form-label small mb-1">End Date</label>
                <input type="date" class="form-control form-control-sm period-end-date"
                       data-period-id="${period.id}" disabled>
            </div>
            <div class="col-md-2">
                <label class="form-label small mb-1">Days</label>
                <input type="text" class="form-control form-control-sm period-days-display"
                       data-period-id="${period.id}" readonly placeholder="0">
            </div>
            <div class="col-md-1">
                <label class="form-label small mb-1">&nbsp;</label>
                <button type="button" class="btn btn-sm btn-outline-danger d-block remove-period"
                        data-period-id="${period.id}">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        </div>
    `;
    
    container.appendChild(periodElement);
    
    // Add event listeners for this period
    addPeriodEventListeners(period.id);
}

// Add event listeners for a specific period
function addPeriodEventListeners(periodId) {
    const periodElement = document.querySelector(`[data-period-id="${periodId}"]`);
    
    // Period type change
    const typeSelect = periodElement.querySelector('.period-type');
    typeSelect.addEventListener('change', function() {
        togglePeriodType(periodId, this.value);
    });
    
    // Date changes
    const startDateInput = periodElement.querySelector('.period-start-date');
    const endDateInput = periodElement.querySelector('.period-end-date');
    
    startDateInput.addEventListener('change', function() {
        updatePeriodData(periodId);
        calculatePeriodDays(periodId);
    });
    
    endDateInput.addEventListener('change', function() {
        updatePeriodData(periodId);
        calculatePeriodDays(periodId);
    });
    
    // Remove button
    const removeBtn = periodElement.querySelector('.remove-period');
    removeBtn.addEventListener('click', function() {
        removeLeavePeriod(periodId);
    });
}

// Toggle between single day and date range
function togglePeriodType(periodId, type) {
    const periodElement = document.querySelector(`[data-period-id="${periodId}"]`);
    const endDateInput = periodElement.querySelector('.period-end-date');
    const startDateInput = periodElement.querySelector('.period-start-date');
    
    const period = leavePeriods.find(p => p.id === periodId);
    if (period) {
        period.isRange = type === 'range';
        
        if (type === 'range') {
            endDateInput.disabled = false;
            endDateInput.required = true;
        } else {
            endDateInput.disabled = true;
            endDateInput.required = false;
            endDateInput.value = startDateInput.value;
            period.endDate = startDateInput.value;
        }
        
        calculatePeriodDays(periodId);
        updateLeavePeriodDisplay();
    }
}

// Update period data from inputs
function updatePeriodData(periodId) {
    const periodElement = document.querySelector(`[data-period-id="${periodId}"]`);
    const startDate = periodElement.querySelector('.period-start-date').value;
    const endDate = periodElement.querySelector('.period-end-date').value;
    const isRange = periodElement.querySelector('.period-type').value === 'range';
    
    const period = leavePeriods.find(p => p.id === periodId);
    if (period) {
        period.startDate = startDate;
        period.endDate = isRange ? endDate : startDate;
        period.isRange = isRange;
        updateLeavePeriodDisplay();
    }
}

// Calculate and display days for a specific period
function calculatePeriodDays(periodId) {
    const period = leavePeriods.find(p => p.id === periodId);
    if (!period || !period.startDate) return;
    
    const startDate = new Date(period.startDate);
    const endDate = new Date(period.endDate || period.startDate);
    
    if (startDate && endDate && startDate <= endDate) {
        const days = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
        
        const periodElement = document.querySelector(`[data-period-id="${periodId}"]`);
        const daysDisplay = periodElement.querySelector('.period-days-display');
        daysDisplay.value = days;
        
        updateLeavePeriodDisplay();
    }
}

// Remove a leave period
function removeLeavePeriod(periodId) {
    leavePeriods = leavePeriods.filter(p => p.id !== periodId);
    const periodElement = document.querySelector(`[data-period-id="${periodId}"]`);
    if (periodElement) {
        periodElement.remove();
    }
    updateLeavePeriodDisplay();
}

// Update the leave period display and totals
function updateLeavePeriodDisplay() {
    const container = document.getElementById('leave-periods-list');
    const noPeriodsMessage = document.getElementById('no-periods-message');
    const totalBadge = document.getElementById('total-leave-days');
    
    if (leavePeriods.length === 0) {
        noPeriodsMessage.style.display = 'block';
        container.style.display = 'none';
    } else {
        noPeriodsMessage.style.display = 'none';
        container.style.display = 'block';
    }
    
    // Calculate total days
    const totalDays = calculateTotalLeaveDays();
    totalBadge.textContent = `Total: ${totalDays} days`;
}

// Calculate total leave days from all periods
function calculateTotalLeaveDays() {
    return leavePeriods.reduce((total, period) => {
        if (period.startDate) {
            const startDate = new Date(period.startDate);
            const endDate = new Date(period.endDate || period.startDate);
            
            if (startDate && endDate && startDate <= endDate) {
                const days = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
                return total + days;
            }
        }
        return total;
    }, 0);
}

// Prepare form data for submission
function prepareFormData() {
    return {
        start_date: document.getElementById('start_date').value,
        end_date: document.getElementById('end_date').value,
        annual_entitlement: parseFloat(document.getElementById('annual_entitlement').value),
        leave_periods: leavePeriods.map(period => ({
            start_date: period.startDate,
            end_date: period.endDate || period.startDate,
            is_range: period.isRange
        })).filter(period => period.start_date) // Only include periods with start dates
    };
}

function validateForm() {
    const startDate = document.getElementById('start_date').value;
    const endDate = document.getElementById('end_date').value;
    const annualEntitlement = parseFloat(document.getElementById('annual_entitlement').value);

    // Check required fields
    if (!startDate || !endDate || isNaN(annualEntitlement)) {
        showAlert('warning', 'Please fill in all required fields');
        return false;
    }

    // Validate dates
    if (new Date(startDate) > new Date(endDate)) {
        showAlert('warning', 'Start date must be before or equal to end date');
        return false;
    }

    // Validate numeric inputs
    if (annualEntitlement <= 0) {
        showAlert('warning', 'Annual entitlement must be positive');
        return false;
    }

    // Validate leave periods
    if (!validateLeavePeriods()) {
        return false;
    }

    return true;
}

// Validate all leave periods
function validateLeavePeriods() {
    for (const period of leavePeriods) {
        if (!period.startDate) {
            showAlert('warning', 'All leave periods must have a start date');
            return false;
        }
        
        if (period.isRange && !period.endDate) {
            showAlert('warning', 'Date ranges must have both start and end dates');
            return false;
        }
        
        if (period.endDate && new Date(period.startDate) > new Date(period.endDate)) {
            showAlert('warning', 'Leave period start date must be before or equal to end date');
            return false;
        }
    }
    return true;
}

function validateDates() {
    const startDate = document.getElementById('start_date').value;
    const endDate = document.getElementById('end_date').value;
    
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
        document.getElementById('end_date').setCustomValidity('End date must be after start date');
    } else {
        document.getElementById('end_date').setCustomValidity('');
    }
}

function setLoadingState(loading) {
    const calculateBtn = document.getElementById('calculate-btn');
    const btnText = document.getElementById('btn-text');
    const btnSpinner = document.getElementById('btn-spinner');

    if (loading) {
        calculateBtn.disabled = true;
        btnText.classList.add('d-none');
        btnSpinner.classList.remove('d-none');
    } else {
        calculateBtn.disabled = false;
        btnText.classList.remove('d-none');
        btnSpinner.classList.add('d-none');
    }
}

function displayResults(data) {
    // Show results section
    const resultsSection = document.querySelector('[data-results-section]');
    resultsSection.style.display = 'block';
    
    // Populate main result with optional secondary value
    const mainResultElement = document.getElementById('main-result');
    if (data.result.display_secondary) {
        // Display both days and hours
        mainResultElement.innerHTML = `
            <div>${data.result.formatted}</div>
            <div class="text-muted" style="font-size: 0.6em; margin-top: 0.25rem;">
                (${data.result.secondary_formatted})
            </div>
        `;
    } else {
        // Display only the primary value
        mainResultElement.textContent = data.result.formatted;
    }
    
    // Populate calculation details
    document.getElementById('period-duration').textContent = `${data.days_in_period} days`;
    document.getElementById('entitled-leave').textContent = `${data.entitled_leave_for_period} days`;
    document.getElementById('leave-taken-display').textContent = `${data.total_leave_taken} days`;
    document.getElementById('annual-entitlement-display').textContent = `${data.annual_entitlement} days`;
    
    // Scroll to results
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Show success message
    showAlert('success', 'Leave balance calculated successfully!');
}

function showAlert(type, message) {
    const alertContainer = document.getElementById('alert-container');
    
    const alertHtml = `
        <div class="alert alert-${type} alert-dismissible fade show" role="alert">
            <i class="bi bi-${getAlertIcon(type)} me-2"></i>
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        </div>
    `;
    
    alertContainer.innerHTML = alertHtml;
    
    // Auto-dismiss success alerts
    if (type === 'success') {
        setTimeout(() => {
            const alert = alertContainer.querySelector('.alert');
            if (alert) {
                const bsAlert = new bootstrap.Alert(alert);
                bsAlert.close();
            }
        }, 3000);
    }
}

function getAlertIcon(type) {
    switch (type) {
        case 'success': return 'check-circle';
        case 'danger': return 'exclamation-triangle';
        case 'warning': return 'exclamation-triangle';
        case 'info': return 'info-circle';
        default: return 'info-circle';
    }
}

function clearAlerts() {
    const alertContainer = document.getElementById('alert-container');
    alertContainer.innerHTML = '';
}

function resetCalculator() {
    // Hide results section
    const resultsSection = document.querySelector('[data-results-section]');
    resultsSection.style.display = 'none';
    
    // Clear alerts
    clearAlerts();
    
    // Scroll back to form
    document.getElementById('leave-calculator-form').scrollIntoView({ 
        behavior: 'smooth', 
        block: 'start' 
    });
    
    // Focus on first input
    document.getElementById('start_date').focus();
}

// Initialize export/import functionality
function initializeExportImport() {
    const exportBtn = document.getElementById('export-data-btn');
    const importBtn = document.getElementById('import-data-btn');
    const fileInput = document.getElementById('import-file-input');

    exportBtn.addEventListener('click', exportFormData);
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileImport);
}

// Export form data as JSON
function exportFormData() {
    try {
        const formData = prepareFormData();
        
        // Add metadata to the export
        const exportData = {
            metadata: {
                exportDate: new Date().toISOString(),
                version: '1.0.0',
                application: 'Annual Leave Calculator'
            },
            formData: formData
        };

        // Create downloadable file
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        // Create download link
        const downloadUrl = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        link.download = `leave-calculator-data-${timestamp}.json`;
        
        // Trigger download
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up
        URL.revokeObjectURL(downloadUrl);
        
        showAlert('success', 'Form data exported successfully!');
    } catch (error) {
        console.error('Export error:', error);
        showAlert('danger', 'Failed to export form data. Please try again.');
    }
}

// Handle file import
function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Check file type
    if (!file.name.toLowerCase().endsWith('.json')) {
        showAlert('warning', 'Please select a JSON file.');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            
            // Validate imported data structure
            if (validateImportedData(importedData)) {
                loadFormData(importedData.formData);
                showAlert('success', 'Form data imported successfully!');
            } else {
                showAlert('danger', 'Invalid file format. Please select a valid leave calculator data file.');
            }
        } catch (error) {
            console.error('Import error:', error);
            showAlert('danger', 'Failed to read file. Please check the file format and try again.');
        }
    };
    
    reader.readAsText(file);
    
    // Reset file input
    event.target.value = '';
}

// Validate imported data structure
function validateImportedData(data) {
    try {
        // Check if it has the expected structure
        if (!data || typeof data !== 'object') {
            return false;
        }

        // Check for formData property
        if (!data.formData || typeof data.formData !== 'object') {
            return false;
        }

        const formData = data.formData;

        // Validate required fields
        if (!formData.start_date || !formData.end_date || typeof formData.annual_entitlement !== 'number') {
            return false;
        }

        // Validate date formats
        if (!isValidDateString(formData.start_date) || !isValidDateString(formData.end_date)) {
            return false;
        }

        // Validate annual entitlement
        if (formData.annual_entitlement <= 0) {
            return false;
        }

        // Validate leave periods if present
        if (formData.leave_periods) {
            if (!Array.isArray(formData.leave_periods)) {
                return false;
            }

            for (const period of formData.leave_periods) {
                if (!period.start_date || !isValidDateString(period.start_date)) {
                    return false;
                }
                if (period.end_date && !isValidDateString(period.end_date)) {
                    return false;
                }
                if (typeof period.is_range !== 'boolean') {
                    return false;
                }
            }
        }

        return true;
    } catch (error) {
        console.error('Validation error:', error);
        return false;
    }
}

// Check if string is a valid date
function isValidDateString(dateString) {
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime()) && dateString.match(/^\d{4}-\d{2}-\d{2}$/);
}

// Load form data from imported data
function loadFormData(formData) {
    try {
        // Clear existing alerts
        clearAlerts();

        // Load basic form fields
        document.getElementById('start_date').value = formData.start_date;
        document.getElementById('end_date').value = formData.end_date;
        document.getElementById('annual_entitlement').value = formData.annual_entitlement;

        // Clear existing leave periods
        leavePeriods = [];
        periodIdCounter = 0;
        const container = document.getElementById('leave-periods-list');
        container.innerHTML = '';

        // Load leave periods
        if (formData.leave_periods && formData.leave_periods.length > 0) {
            formData.leave_periods.forEach(periodData => {
                const periodId = ++periodIdCounter;
                const period = {
                    id: periodId,
                    startDate: periodData.start_date,
                    endDate: periodData.end_date,
                    isRange: periodData.is_range
                };
                
                leavePeriods.push(period);
                renderLeavePeriod(period);
                
                // Set the values in the rendered elements
                setTimeout(() => {
                    const periodElement = document.querySelector(`[data-period-id="${periodId}"]`);
                    if (periodElement) {
                        periodElement.querySelector('.period-type').value = period.isRange ? 'range' : 'single';
                        periodElement.querySelector('.period-start-date').value = period.startDate;
                        
                        const endDateInput = periodElement.querySelector('.period-end-date');
                        if (period.isRange) {
                            endDateInput.disabled = false;
                            endDateInput.required = true;
                            endDateInput.value = period.endDate;
                        } else {
                            endDateInput.disabled = true;
                            endDateInput.required = false;
                            endDateInput.value = period.startDate;
                        }
                        
                        calculatePeriodDays(periodId);
                    }
                }, 50);
            });
        }

        // Update display
        updateLeavePeriodDisplay();
        
        // Validate dates
        validateDates();

        // Hide results if visible
        const resultsSection = document.querySelector('[data-results-section]');
        if (resultsSection) {
            resultsSection.style.display = 'none';
        }

    } catch (error) {
        console.error('Load data error:', error);
        showAlert('danger', 'Error loading form data. Some fields may not have been restored.');
    }
}

// Utility function to format dates
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-AU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// Add input formatting for better UX
document.addEventListener('DOMContentLoaded', function() {
    // Format number inputs
    const numberInputs = document.querySelectorAll('input[type="number"]');
    numberInputs.forEach(input => {
        input.addEventListener('input', function() {
            // Ensure positive values
            if (parseFloat(this.value) < 0) {
                this.value = '0';
            }
        });
    });
});