/**
 * templates/calculator.js — Aquiplex Site Builder Template
 *
 * Generates a fully working, responsive, offline-capable calculator.
 * No CDN. No external dependencies.
 */

"use strict";

function generateTemplate() {
  return {
    files: {
      "index.html": `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Calculator</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
  <div class="wrapper">
    <div class="calc">
      <div class="calc-display">
        <div class="calc-expr" id="expr"></div>
        <div class="calc-result" id="result">0</div>
      </div>
      <div class="calc-keys">
        <button class="key key-wide key-util" data-action="clear">AC</button>
        <button class="key key-util" data-action="sign">+/-</button>
        <button class="key key-util" data-action="percent">%</button>
        <button class="key key-op" data-action="op" data-val="/">÷</button>

        <button class="key" data-action="num" data-val="7">7</button>
        <button class="key" data-action="num" data-val="8">8</button>
        <button class="key" data-action="num" data-val="9">9</button>
        <button class="key key-op" data-action="op" data-val="*">×</button>

        <button class="key" data-action="num" data-val="4">4</button>
        <button class="key" data-action="num" data-val="5">5</button>
        <button class="key" data-action="num" data-val="6">6</button>
        <button class="key key-op" data-action="op" data-val="-">−</button>

        <button class="key" data-action="num" data-val="1">1</button>
        <button class="key" data-action="num" data-val="2">2</button>
        <button class="key" data-action="num" data-val="3">3</button>
        <button class="key key-op" data-action="op" data-val="+">+</button>

        <button class="key key-wide" data-action="num" data-val="0">0</button>
        <button class="key" data-action="dot">.</button>
        <button class="key key-eq" data-action="equals">=</button>
      </div>
    </div>
  </div>
  <script src="script.js"></script>
</body>
</html>`,

      "style.css": `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1a1a2e;
  background-image:
    radial-gradient(ellipse at 20% 50%, rgba(99,102,241,0.15) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 20%, rgba(236,72,153,0.10) 0%, transparent 50%);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.wrapper {
  padding: 20px;
}

.calc {
  background: #16213e;
  border-radius: 24px;
  box-shadow:
    0 32px 80px rgba(0,0,0,0.6),
    0 0 0 1px rgba(255,255,255,0.06);
  width: 320px;
  overflow: hidden;
}

/* Display */
.calc-display {
  padding: 28px 24px 20px;
  text-align: right;
  min-height: 110px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 4px;
  background: rgba(0,0,0,0.25);
}

.calc-expr {
  font-size: 0.85rem;
  color: rgba(255,255,255,0.35);
  min-height: 20px;
  font-weight: 400;
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.calc-result {
  font-size: 2.8rem;
  font-weight: 300;
  color: #f1f5f9;
  line-height: 1;
  letter-spacing: -0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: font-size 0.1s;
}

/* Keys grid */
.calc-keys {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: rgba(0,0,0,0.3);
  padding: 1px;
}

.key {
  background: #1e2d4e;
  border: none;
  color: #e2e8f0;
  font-size: 1.15rem;
  font-weight: 500;
  padding: 0;
  height: 72px;
  cursor: pointer;
  transition: background 0.12s, transform 0.08s;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.key:active {
  background: #2d3f6b;
  transform: scale(0.94);
}

.key-wide {
  grid-column: span 2;
}

.key-util {
  background: #1e3a5f;
  color: #7dd3fc;
  font-weight: 600;
}
.key-util:active { background: #1e4a7a; }

.key-op {
  background: #1e2d4e;
  color: #a78bfa;
  font-size: 1.3rem;
}
.key-op.active-op { background: #312e81; color: #c4b5fd; }
.key-op:active { background: #2a3668; }

.key-eq {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 1.3rem;
  font-weight: 600;
  box-shadow: 0 4px 20px rgba(99,102,241,0.4);
}
.key-eq:active { opacity: 0.85; transform: scale(0.94); }`,

      "script.js": `"use strict";

const display  = document.getElementById("result");
const exprEl   = document.getElementById("expr");

let state = {
  current:   "0",
  prev:      null,
  operator:  null,
  justCalc:  false,
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
  document.querySelector(\`[data-val="\${op}"]\`)?.classList.add("active-op");

  if (state.operator && !state.justCalc) {
    calculate(true);
  }

  state.prev     = state.current;
  state.operator = op;
  state.justCalc = true;

  const opSym = { "+": "+", "-": "−", "*": "×", "/": "÷" };
  exprEl.textContent = \`\${fmt(state.prev)} \${opSym[op] || op}\`;
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
    exprEl.textContent = \`\${fmt(state.prev)} \${opSym[state.operator] || state.operator} \${fmt(state.current)} =\`;
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
  state = { current: "0", prev: null, operator: null, justCalc: false };
  exprEl.textContent = "";
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

updateDisplay();`
    }
  };
}

module.exports = { generateTemplate };
