/**
 * templates/portfolio.js — Aquiplex Site Builder Template
 *
 * Generates a professional developer portfolio.
 * No CDN. No external dependencies. Fully offline.
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
  <title>Portfolio</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
  <!-- NAV -->
  <nav class="nav">
    <div class="nav-inner">
      <a href="#" class="nav-logo">JD.</a>
      <ul class="nav-links">
        <li><a href="#about">About</a></li>
        <li><a href="#work">Work</a></li>
        <li><a href="#skills">Skills</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
      <button class="nav-toggle" aria-label="Menu">&#9776;</button>
    </div>
  </nav>

  <!-- HERO -->
  <section class="hero" id="about">
    <div class="hero-bg"></div>
    <div class="container hero-inner">
      <div class="hero-text">
        <span class="hero-eyebrow">Hello, I'm</span>
        <h1 class="hero-name">Jane Doe</h1>
        <p class="hero-role">Full-Stack Developer &amp; UI Designer</p>
        <p class="hero-bio">I craft clean, performant digital experiences for startups and growing companies. Currently open to new opportunities.</p>
        <div class="hero-actions">
          <a href="#work" class="btn btn-primary">See My Work</a>
          <a href="#contact" class="btn btn-ghost">Get In Touch</a>
        </div>
      </div>
      <div class="hero-avatar">
        <div class="avatar-ring">
          <div class="avatar-inner">JD</div>
        </div>
        <div class="avatar-badge">Available for hire</div>
      </div>
    </div>
  </section>

  <!-- WORK -->
  <section class="section" id="work">
    <div class="container">
      <h2 class="section-title">Selected Work</h2>
      <p class="section-sub">A curated collection of projects I'm proud of.</p>
      <div class="projects-grid">
        <article class="project-card">
          <div class="project-img" style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)">
            <span class="project-emoji">&#128200;</span>
          </div>
          <div class="project-info">
            <span class="project-tag">SaaS · React · Node</span>
            <h3 class="project-name">DataLens Analytics</h3>
            <p class="project-desc">Real-time business intelligence platform processing 2M+ events/day. Built with React, Node.js, and PostgreSQL.</p>
            <div class="project-links">
              <a href="#" class="link-btn">Live Demo &#8599;</a>
              <a href="#" class="link-btn link-ghost">GitHub &#8599;</a>
            </div>
          </div>
        </article>

        <article class="project-card">
          <div class="project-img" style="background: linear-gradient(135deg, #06b6d4 0%, #0284c7 100%)">
            <span class="project-emoji">&#127863;</span>
          </div>
          <div class="project-info">
            <span class="project-tag">E-commerce · Next.js</span>
            <h3 class="project-name">Bloom Market</h3>
            <p class="project-desc">Boutique e-commerce platform with 3D product previews and AR try-on. Generated $240k in first-year revenue.</p>
            <div class="project-links">
              <a href="#" class="link-btn">Live Demo &#8599;</a>
              <a href="#" class="link-btn link-ghost">GitHub &#8599;</a>
            </div>
          </div>
        </article>

        <article class="project-card">
          <div class="project-img" style="background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)">
            <span class="project-emoji">&#127758;</span>
          </div>
          <div class="project-info">
            <span class="project-tag">Mobile · React Native</span>
            <h3 class="project-name">Roam Travel App</h3>
            <p class="project-desc">AI-powered travel planning app with offline maps. 50,000+ downloads on iOS and Android in 6 months.</p>
            <div class="project-links">
              <a href="#" class="link-btn">App Store &#8599;</a>
              <a href="#" class="link-btn link-ghost">Case Study &#8599;</a>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>

  <!-- SKILLS -->
  <section class="section section-alt" id="skills">
    <div class="container">
      <h2 class="section-title">Skills &amp; Tools</h2>
      <p class="section-sub">Technologies I use to bring ideas to life.</p>
      <div class="skills-grid">
        <div class="skill-group">
          <h4 class="skill-group-title">Frontend</h4>
          <div class="skill-tags">
            <span class="tag">React</span><span class="tag">Next.js</span>
            <span class="tag">TypeScript</span><span class="tag">Vue</span>
            <span class="tag">CSS / Tailwind</span><span class="tag">Figma</span>
          </div>
        </div>
        <div class="skill-group">
          <h4 class="skill-group-title">Backend</h4>
          <div class="skill-tags">
            <span class="tag">Node.js</span><span class="tag">Express</span>
            <span class="tag">Python</span><span class="tag">FastAPI</span>
            <span class="tag">GraphQL</span><span class="tag">REST APIs</span>
          </div>
        </div>
        <div class="skill-group">
          <h4 class="skill-group-title">Data &amp; Cloud</h4>
          <div class="skill-tags">
            <span class="tag">PostgreSQL</span><span class="tag">MongoDB</span>
            <span class="tag">Redis</span><span class="tag">AWS</span>
            <span class="tag">Docker</span><span class="tag">CI/CD</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- CONTACT -->
  <section class="section" id="contact">
    <div class="container contact-inner">
      <h2 class="section-title">Let's Work Together</h2>
      <p class="section-sub">I'm currently available for freelance projects and full-time roles. Let's build something great.</p>
      <div class="contact-links">
        <a href="mailto:hello@janedoe.dev" class="contact-pill">&#128140; hello@janedoe.dev</a>
        <a href="#" class="contact-pill">&#128279; LinkedIn</a>
        <a href="#" class="contact-pill">&#128025; GitHub</a>
        <a href="#" class="contact-pill">&#128196; Resume PDF</a>
      </div>
    </div>
  </section>

  <footer class="footer">
    <p>Designed &amp; built by Jane Doe · 2024</p>
  </footer>

  <script src="script.js"></script>
</body>
</html>`,

      "style.css": `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #0d0f14;
  --bg-alt:   #121519;
  --border:   rgba(255,255,255,0.08);
  --text:     #e2e8f0;
  --muted:    #64748b;
  --accent:   #6366f1;
  --accent2:  #22d3ee;
}

html { scroll-behavior: smooth; }

body {
  font-family: 'DM Sans', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.65;
  font-size: 1rem;
}

.container {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 24px;
}

/* ── NAV ── */
.nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(13,15,20,0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.nav-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1100px;
  margin: 0 auto;
  padding: 18px 24px;
}
.nav-logo {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
  letter-spacing: -0.02em;
}
.nav-links {
  display: flex;
  gap: 32px;
  list-style: none;
}
.nav-links a {
  color: var(--muted);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 500;
  transition: color 0.2s;
}
.nav-links a:hover { color: var(--text); }
.nav-toggle { display: none; background: none; border: none; color: var(--text); font-size: 1.4rem; cursor: pointer; }

/* ── HERO ── */
.hero {
  position: relative;
  padding: 100px 0 80px;
  overflow: hidden;
}
.hero-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 70% 40%, rgba(99,102,241,0.12) 0%, transparent 60%),
    radial-gradient(ellipse at 20% 80%, rgba(34,211,238,0.08) 0%, transparent 50%);
  pointer-events: none;
}
.hero-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 48px;
}
.hero-text { flex: 1; }
.hero-eyebrow {
  font-family: 'DM Mono', monospace;
  font-size: 0.8rem;
  color: var(--accent2);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  display: block;
  margin-bottom: 12px;
}
.hero-name {
  font-size: clamp(2.5rem, 6vw, 4rem);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
  margin-bottom: 12px;
}
.hero-role {
  font-size: 1.15rem;
  color: var(--muted);
  margin-bottom: 20px;
}
.hero-bio {
  font-size: 1rem;
  color: var(--muted);
  max-width: 480px;
  margin-bottom: 36px;
  line-height: 1.7;
}
.hero-actions { display: flex; gap: 14px; flex-wrap: wrap; }

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 13px 28px;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.2s;
  cursor: pointer;
  border: none;
}
.btn-primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 4px 20px rgba(99,102,241,0.35);
}
.btn-primary:hover { background: #818cf8; box-shadow: 0 4px 28px rgba(99,102,241,0.5); }
.btn-ghost {
  background: rgba(255,255,255,0.06);
  color: var(--text);
  border: 1px solid var(--border);
}
.btn-ghost:hover { background: rgba(255,255,255,0.1); }

/* Avatar */
.hero-avatar { flex-shrink: 0; text-align: center; position: relative; }
.avatar-ring {
  width: 200px;
  height: 200px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  padding: 3px;
}
.avatar-inner {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #1a1d26;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.8rem;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
}
.avatar-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 6px 14px;
  background: rgba(34,197,94,0.12);
  border: 1px solid rgba(34,197,94,0.25);
  border-radius: 20px;
  font-size: 0.75rem;
  color: #4ade80;
  font-weight: 600;
}
.avatar-badge::before {
  content: "";
  width: 7px;
  height: 7px;
  background: #4ade80;
  border-radius: 50%;
  animation: pulse 2s ease infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── SECTIONS ── */
.section { padding: 96px 0; }
.section-alt { background: var(--bg-alt); }

.section-title {
  font-size: clamp(1.8rem, 4vw, 2.4rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 10px;
}
.section-sub {
  color: var(--muted);
  font-size: 1rem;
  margin-bottom: 56px;
}

/* Projects */
.projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 24px;
}
.project-card {
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  transition: transform 0.25s, box-shadow 0.25s;
}
.project-card:hover { transform: translateY(-4px); box-shadow: 0 20px 50px rgba(0,0,0,0.4); }
.project-img {
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.project-emoji { font-size: 3.5rem; }
.project-info { padding: 22px; }
.project-tag { font-family: 'DM Mono', monospace; font-size: 0.7rem; color: var(--accent2); text-transform: uppercase; letter-spacing: 0.06em; }
.project-name { font-size: 1.15rem; font-weight: 700; margin: 8px 0 10px; }
.project-desc { font-size: 0.88rem; color: var(--muted); line-height: 1.6; margin-bottom: 18px; }
.project-links { display: flex; gap: 10px; }
.link-btn {
  font-size: 0.8rem;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: 7px;
  text-decoration: none;
  background: var(--accent);
  color: #fff;
  transition: opacity 0.2s;
}
.link-btn:hover { opacity: 0.8; }
.link-ghost { background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid var(--border); }

/* Skills */
.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 28px;
}
.skill-group-title { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 14px; }
.skill-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.tag {
  padding: 6px 14px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.82rem;
  color: var(--text);
  font-weight: 500;
}

/* Contact */
.contact-inner { text-align: center; }
.contact-links { display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; margin-top: 40px; }
.contact-pill {
  padding: 12px 22px;
  border: 1px solid var(--border);
  border-radius: 30px;
  text-decoration: none;
  color: var(--text);
  font-size: 0.88rem;
  font-weight: 500;
  transition: all 0.2s;
  background: rgba(255,255,255,0.03);
}
.contact-pill:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); }

/* Footer */
.footer {
  border-top: 1px solid var(--border);
  text-align: center;
  padding: 28px;
  color: var(--muted);
  font-size: 0.82rem;
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .hero-inner { flex-direction: column-reverse; gap: 40px; }
  .hero-avatar { margin: 0 auto; }
  .nav-links { display: none; }
  .nav-toggle { display: block; }
  .projects-grid { grid-template-columns: 1fr; }
}`,

      "script.js": `"use strict";

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
});`
    }
  };
}

module.exports = { generateTemplate };
