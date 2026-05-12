const todoInput = document.getElementById('todo-input');
const addBtn = document.getElementById('add-btn');
const todoList = document.getElementById('todo-list');
const downloadBtn = document.getElementById('download-btn');
const historyPanel = document.getElementById('history-panel');

let todos = [];
let history = [];

// Load sample data
todos = ['Buy groceries', 'Do laundry', 'Finish project'];
renderTodoList();

// Debounce input
let debounceTimeout;
todoInput.addEventListener('input', () => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    const newTodo = todoInput.value.trim();
    if (newTodo) {
      todos.push(newTodo);
      renderTodoList();
      history.push({ action: 'add', todo: newTodo });
      renderHistoryPanel();
      todoInput.value = '';
    }
  }, 150);
});

// Add todo on enter key press
todoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addBtn.click();
  }
});

// Add todo on button click
addBtn.addEventListener('click', () => {
  const newTodo = todoInput.value.trim();
  if (newTodo) {
    todos.push(newTodo);
    renderTodoList();
    history.push({ action: 'add', todo: newTodo });
    renderHistoryPanel();
    todoInput.value = '';
  }
});

// Download todos as file
downloadBtn.addEventListener('click', () => {
  const blob = new Blob([todos.join('\n')], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'todos.txt';
  link.click();
});

// Render todo list
function renderTodoList() {
  todoList.innerHTML = '';
  todos.forEach((todo, index) => {
    const li = document.createElement('li');
    li.textContent = todo;
    li.addEventListener('click', () => {
      navigator.clipboard.writeText(todo);
      const copied = document.createElement('span');
      copied.textContent = 'Copied!';
      copied.classList.add('copied');
      li.appendChild(copied);
      setTimeout(() => {
        copied.classList.remove('show');
        setTimeout(() => {
          copied.remove();
        }, 300);
      }, 1000);
    });
    todoList.appendChild(li);
  });
}

// Render history panel
function renderHistoryPanel() {
  historyPanel.innerHTML = '';
  history.slice(-10).forEach((item) => {
    const p = document.createElement('p');
    p.textContent = `${item.action} ${item.todo}`;
    historyPanel.appendChild(p);
  });
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    todoInput.value = '';
  } else if (e.key === 'z' && e.ctrlKey) {
    if (history.length) {
      const lastAction = history.pop();
      if (lastAction.action === 'add') {
        todos.pop();
        renderTodoList();
        renderHistoryPanel();
      }
    }
  }
});