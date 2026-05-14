const historyList = document.getElementById('history-list');
const outputContainer = document.getElementById('output-container');
const runButton = document.getElementById('run-button');
const clearButton = document.getElementById('clear-button');
const undoButton = document.getElementById('undo-button');
const downloadButton = document.getElementById('download-button');
const inputField = document.getElementById('input-field');
const history = JSON.parse(localStorage.getItem('history')) || [];

inputField.addEventListener('input', debounce(() => {
  const output = inputField.value;
  outputContainer.innerText = output;
  history.push(output);
  localStorage.setItem('history', JSON.stringify(history));
  renderHistory();
}, 150));

runButton.addEventListener('click', () => {
  const output = inputField.value;
  console.log(output);
});

clearButton.addEventListener('click', () => {
  inputField.value = '';
  outputContainer.innerText = '';
  history.length = 0;
  localStorage.setItem('history', JSON.stringify(history));
  renderHistory();
});

undoButton.addEventListener('click', () => {
  if (history.length > 0) {
    history.pop();
    localStorage.setItem('history', JSON.stringify(history));
    renderHistory();
  }
});

downloadButton.addEventListener('click', () => {
  const blob = new Blob([inputField.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output.txt';
  a.click();
  URL.revokeObjectURL(url);
});

function renderHistory() {
  historyList.innerHTML = '';
  history.forEach((item, index) => {
    const li = document.createElement('li');
    li.textContent = item;
    li.style.padding = '8px';
    li.style.borderBottom = '1px solid #ccc';
    if (index === history.length - 1) {
      li.style.borderBottom = 'none';
    }
    historyList.appendChild(li);
  });
}

function debounce(func, wait) {
  let timeout;
  return function() {
    const context = this;
    const args = arguments;
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      func.apply(context, args);
    }, wait);
  };
}

window.addEventListener('hashchange', () => {
  const hash = window.location.hash;
  if (hash === '#history') {
    historyList.scrollIntoView();
  } else if (hash === '#output') {
    outputContainer.scrollIntoView();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runButton.click();
  } else if (e.key === 'Escape') {
    clearButton.click();
  } else if (e.key === 'z' && e.ctrlKey) {
    undoButton.click();
  }
});