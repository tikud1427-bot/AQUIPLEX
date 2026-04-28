"use strict";

const display  = document.getElementById("result");
const exprEl   = document.getElementById("expr");
const historyEl = document.getElementById("history");

let state = {
  current:   "0",
  prev:      null,
  operator:  null,
  justCalc:  false,
  history: []
};

function fmt(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  // Limit to 10 significant digits for display
  const s = parseFloat(n.toPrecision(10)).toString();
  return s;
}

function updateDisplay() {
  const text = fmt(state.current);
  // Shrink font if too long
  display.style.fontSize = text.length > 12 ? "1.6rem" : text.length > 9 ? "2rem" : "";
  display.textContent = text;
}

function pressNum(val) {
  if (state.justCalc) {
    state.current  = val;
    state.justCalc = false;
    exprEl.textContent = "";
  } else {
    state.current = state.current === "0" ? val : (state.current + val);
  }
  updateDisplay();
}

function pressDot() {
  if (state.justCalc) { state.current = "0."; state.justCalc = false; }
  if (!state.current.includes(".")) state.current += ".";
  updateDisplay();
}

function pressOp(op) {
  // Clear active highlight from all op keys
  document.querySelectorAll(".key-op").forEach(k => k.classList.remove("active-op"));
  document.querySelector(`[data-val="${op}"]`)?.classList.add("active-op");

  if (state.operator && !state.justCalc) {
    calculate(true);
  }

  state.prev     = state.current;
  state.operator = op;
  state.justCalc = true;

  const opSym = { "+": "+", "-": "−", "*": "×", "/": "÷" };
  exprEl.textContent = `${fmt(state.prev)} ${opSym[op] || op}`;
}

function calculate(intermediate = false) {
  if (!state.operator || state.prev === null) return;

  const a = parseFloat(state.prev);
  const b = parseFloat(state.current);
  let result;

  switch (state.operator) {
    case "+": result = a + b; break;
    case "-": result = a - b; break;
    case "*": result = a * b; break;
    case "/": result = b !== 0 ? a / b : "Error"; break;
    default:  result = b;
  }

  if (!intermediate) {
    const opSym = { "+": "+", "-": "−", "*": "×", "/": "÷" };
    exprEl.textContent = `${fmt(state.prev)} ${opSym[state.operator] || state.operator} ${fmt(state.current)} =`;
    historyEl.textContent += `${fmt(state.prev)} ${opSym[state.operator] || state.operator} ${fmt(state.current)} = ${fmt(result)}\n`;
  }

  state.current  = result === "Error" ? "Error" : fmt(result);
  state.prev     = null;
  state.operator = null;
  state.justCalc = !intermediate;

  document.querySelectorAll(".key-op").forEach(k => k.classList.remove("active-op"));
  updateDisplay();
}

function pressSign() {
  if (state.current === "0" || state.current === "Error") return;
  state.current = state.current.startsWith("-")
    ? state.current.slice(1)
    : "-" + state.current;
  updateDisplay();
}

function pressPercent() {
  const n = parseFloat(state.current);
  if (isNaN(n)) return;
  state.current = fmt(n / 100);
  updateDisplay();
}

function pressClear() {
  state = { current: "0", prev: null, operator: null, justCalc: false, history: [] };
  exprEl.textContent = "";
  historyEl.textContent = "";
  document.querySelectorAll(".key-op").forEach(k => k.classList.remove("active-op"));
  updateDisplay();
}

// ── Event delegation ──────────────────────────────────────────────────────────
document.querySelector(".calc-keys").addEventListener("click", e => {
  const key = e.target.closest(".key");
  if (!key) return;

  const action = key.dataset.action;
  const val    = key.dataset.val;

  switch (action) {
    case "num":     pressNum(val);    break;
    case "dot":     pressDot();       break;
    case "op":      pressOp(val);     break;
    case "equals":  calculate();      break;
    case "sign":    pressSign();      break;
    case "percent": pressPercent();   break;
    case "clear":   pressClear();     break;
  }
});

// ── Keyboard support ──────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key >= "0" && e.key <= "9") pressNum(e.key);
  else if (e.key === ".")   pressDot();
  else if (e.key === "+")   pressOp("+");
  else if (e.key === "-")   pressOp("-");
  else if (e.key === "*")   pressOp("*");
  else if (e.key === "/") { e.preventDefault(); pressOp("/"); }
  else if (e.key === "Enter" || e.key === "=") calculate();
  else if (e.key === "Escape" || e.key === "c" || e.key === "C") pressClear();
  else if (e.key === "%")   pressPercent();
});

updateDisplay();