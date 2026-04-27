"use strict";

// ── Nav mobile toggle ──────────────────────────────────────────────────────────
const toggle = document.querySelector(".nav-toggle");
const links  = document.querySelector(".nav-links");

toggle?.addEventListener("click", () => {
  const open = links.style.display === "flex";
  links.style.display = open ? "" : "flex";
  links.style.flexDirection = "column";
  links.style.position = "absolute";
  links.style.top = "70px";
  links.style.left = "0";
  links.style.right = "0";
  links.style.background = "#0d0f14";
  links.style.padding = "20px 24px";
  links.style.borderBottom = "1px solid rgba(255,255,255,0.08)";
});

// ── Smooth scroll for nav links ───────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener("click", e => {
    const target = document.querySelector(a.getAttribute("href"));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth" });
    }
  });
});

// ── Scroll-based nav highlight ────────────────────────────────────────────────
const sections = document.querySelectorAll("section[id]");
const navAs    = document.querySelectorAll(".nav-links a");

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navAs.forEach(a => {
        a.style.color = a.getAttribute("href") === "#" + entry.target.id
          ? "#e2e8f0"
          : "";
      });
    }
  });
}, { threshold: 0.5 });

sections.forEach(s => observer.observe(s));

// ── Fade-in on scroll ─────────────────────────────────────────────────────────
const fadeEls = document.querySelectorAll(".project-card, .skill-group");

const fadeObs = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = "1";
      entry.target.style.transform = "translateY(0)";
      fadeObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

fadeEls.forEach(el => {
  el.style.opacity = "0";
  el.style.transform = "translateY(20px)";
  el.style.transition = "opacity 0.5s ease, transform 0.5s ease";
  fadeObs.observe(el);
});