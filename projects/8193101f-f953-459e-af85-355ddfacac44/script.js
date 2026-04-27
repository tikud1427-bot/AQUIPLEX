"use strict";

// ── FAQ accordion keyboard support ────────────────────────────────────────────
document.querySelectorAll(".faq-item summary").forEach(s => {
  s.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      s.parentElement.open = !s.parentElement.open;
    }
  });
});

// ── Feature cards stagger animation ──────────────────────────────────────────
const cards = document.querySelectorAll(".feat-card, .plan-card");
const obs = new IntersectionObserver(entries => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      entry.target.style.animationDelay = (i * 0.07) + "s";
      entry.target.classList.add("anim-in");
      obs.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

const style = document.createElement("style");
style.textContent = `
  .feat-card, .plan-card { opacity: 0; transform: translateY(18px); transition: opacity 0.45s ease, transform 0.45s ease; }
  .anim-in { opacity: 1 !important; transform: translateY(0) !important; }
`;
document.head.appendChild(style);
cards.forEach(c => obs.observe(c));

// ── Smooth scroll ─────────────────────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener("click", e => {
    const t = document.querySelector(a.getAttribute("href"));
    if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
  });
});