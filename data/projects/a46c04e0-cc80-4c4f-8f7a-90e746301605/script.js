let workDuration = 25;
let breakDuration = 5;
let timerInterval;
let isRunning = false;
let isBreak = false;
let history = [];

document.getElementById('start-button').addEventListener('click', startTimer);
document.getElementById('pause-button').addEventListener('click', pauseTimer);
document.getElementById('reset-button').addEventListener('click', resetTimer);
document.getElementById('save-settings').addEventListener('click', saveSettings);
document.addEventListener('keydown', handleKeyboardShortcuts);

function startTimer() {
    isRunning = true;
    document.getElementById('start-button').disabled = true;
    document.getElementById('pause-button').disabled = false;
    timerInterval = setInterval(updateTimer, 1000);
}

function pauseTimer() {
    isRunning = false;
    document.getElementById('start-button').disabled = false;
    document.getElementById('pause-button').disabled = true;
    clearInterval(timerInterval);
}

function resetTimer() {
    isRunning = false;
    isBreak = false;
    document.getElementById('start-button').disabled = false;
    document.getElementById('pause-button').disabled = true;
    clearInterval(timerInterval);
    document.getElementById('minutes').textContent = workDuration;
    document.getElementById('seconds').textContent = '00';
}

function updateTimer() {
    let minutes = parseInt(document.getElementById('minutes').textContent);
    let seconds = parseInt(document.getElementById('seconds').textContent);
    if (seconds > 0) {
        seconds--;
    } else {
        minutes--;
        seconds = 59;
    }
    if (minutes < 0) {
        if (isBreak) {
            isBreak = false;
            minutes = workDuration;
        } else {
            isBreak = true;
            minutes = breakDuration;
        }
    }
    document.getElementById('minutes').textContent = minutes.toString().padStart(2, '0');
    document.getElementById('seconds').textContent = seconds.toString().padStart(2, '0');
    if (minutes === 0 && seconds === 0) {
        if (isBreak) {
            alert('Break is over!');
        } else {
            alert('Work session is over!');
            history.push('Work session completed');
            updateHistoryList();
        }
    }
}

function saveSettings() {
    workDuration = parseInt(document.getElementById('work-duration').value);
    breakDuration = parseInt(document.getElementById('break-duration').value);
    localStorage.setItem('workDuration', workDuration);
    localStorage.setItem('breakDuration', breakDuration);
}

function updateHistoryList() {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';
    history.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        historyList.appendChild(li);
    });
}

function handleKeyboardShortcuts(event) {
    if (event.key === ' ') {
        if (isRunning) {
            pauseTimer();
        } else {
            startTimer();
        }
    } else if (event.key === 'r') {
        resetTimer();
    }
}

// Load settings from local storage
if (localStorage.getItem('workDuration')) {
    workDuration = parseInt(localStorage.getItem('workDuration'));
    document.getElementById('work-duration').value = workDuration;
}
if (localStorage.getItem('breakDuration')) {
    breakDuration = parseInt(localStorage.getItem('breakDuration'));
    document.getElementById('break-duration').value = breakDuration;
}