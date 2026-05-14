// Get elements
const workDurationInput = document.getElementById('work-duration');
const breakDurationInput = document.getElementById('break-duration');
const startTimerButton = document.getElementById('start-timer');
const stopTimerButton = document.getElementById('stop-timer');
const timerTitle = document.getElementById('timer-title');
const lockdownModeToggle = document.getElementById('lockdown-mode-toggle');

// Initialize variables
let workDuration = parseInt(workDurationInput.value) * 60;
let breakDuration = parseInt(breakDurationInput.value) * 60;
let timerInterval;
let isWorkSession = true;
let isLockdownMode = false;

// Add event listeners
startTimerButton.addEventListener('click', startTimer);
stopTimerButton.addEventListener('click', stopTimer);
lockdownModeToggle.addEventListener('click', toggleLockdownMode);
workDurationInput.addEventListener('input', updateWorkDuration);
breakDurationInput.addEventListener('input', updateBreakDuration);

// Start timer
function startTimer() {
    timerInterval = setInterval(updateTimer, 1000);
    isWorkSession = true;
    workDuration = parseInt(workDurationInput.value) * 60;
    timerTitle.textContent = 'Work Session';
}

// Stop timer
function stopTimer() {
    clearInterval(timerInterval);
}

// Update timer
function updateTimer() {
    if (isWorkSession) {
        workDuration--;
        if (workDuration <= 0) {
            isWorkSession = false;
            breakDuration = parseInt(breakDurationInput.value) * 60;
            timerTitle.textContent = 'Break Session';
        }
    } else {
        breakDuration--;
        if (breakDuration <= 0) {
            isWorkSession = true;
            workDuration = parseInt(workDurationInput.value) * 60;
            timerTitle.textContent = 'Work Session';
        }
    }
    const minutes = Math.floor((isWorkSession ? workDuration : breakDuration) / 60);
    const seconds = (isWorkSession ? workDuration : breakDuration) % 60;
    timerTitle.textContent += ` (${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')})`;
}

// Update work duration
function updateWorkDuration() {
    workDuration = parseInt(workDurationInput.value) * 60;
}

// Update break duration
function updateBreakDuration() {
    breakDuration = parseInt(breakDurationInput.value) * 60;
}

// Toggle lockdown mode
function toggleLockdownMode() {
    isLockdownMode = !isLockdownMode;
    if (isLockdownMode) {
        lockdownModeToggle.textContent = 'Lockdown Mode: ON';
        // Restrict access to distracting websites and applications
        // This can be implemented using a browser extension or a custom solution
    } else {
        lockdownModeToggle.textContent = 'Lockdown Mode: OFF';
    }
}