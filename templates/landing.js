/**
 * templates/landing.js — Aquiplex Site Builder Template
 *
 * Generates a modern SaaS/product landing page.
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
  <title>ProductName — Built for Teams</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
  <!-- NAV -->
  <nav class="nav">
    <div class="nav-inner">
      <a href="#" class="logo">&#9670; Nexus</a>
      <ul class="nav-links">
        <li><a href="#features">Features</a></li>
        <li><a href="#pricing">Pricing</a></li>
        <li><a href="#faq">FAQ</a></li>
      </ul>
      <div class="nav-ctas">
        <a href="#" class="btn-text">Sign In</a>
        <a href="#" class="btn btn-sm">Get Started Free</a>
      </div>
    </div>
  </nav>

  <!-- HERO -->
  <section class="hero">
    <div class="hero-noise"></div>
    <div class="container">
      <div class="hero-badge">&#127881; Trusted by 10,000+ teams worldwide</div>
      <h1 class="hero-h1">Ship faster.<br/>Break nothing.<br/><span class="gradient-text">Stay in flow.</span></h1>
      <p class="hero-p">Nexus is the all-in-one project intelligence platform that keeps your team aligned, your deadlines on track, and your shipping velocity at an all-time high.</p>
      <div class="hero-ctas">
        <a href="#" class="btn btn-primary btn-lg">Start for free — no card needed</a>
        <a href="#" class="btn btn-outline btn-lg">&#9654;  Watch 2-min demo</a>
      </div>
      <p class="hero-micro">Free forever on small teams · SOC 2 Type II certified</p>

      <!-- Fake dashboard preview -->
      <div class="hero-preview">
        <div class="preview-bar">
          <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
          <span class="preview-url">app.nexus.io/dashboard</span>
        </div>
        <div class="preview-body">
          <div class="preview-sidebar">
            <div class="ps-item active">&#128202; Overview</div>
            <div class="ps-item">&#9989; Tasks</div>
            <div class="ps-item">&#128172; Discussions</div>
            <div class="ps-item">&#128218; Docs</div>
            <div class="ps-item">&#128200; Analytics</div>
          </div>
          <div class="preview-main">
            <div class="pm-header">
              <span class="pm-title">Q4 Roadmap</span>
              <div class="pm-tags"><span class="tag-g">On Track</span><span class="tag-b">12 tasks</span></div>
            </div>
            <div class="pm-progress">
              <div class="pm-bar" style="width:72%"></div>
            </div>
            <div class="pm-cards">
              <div class="pm-card done">&#10003; Design System v2 <span>Done</span></div>
              <div class="pm-card active">&#9679; API Integration <span>In Progress</span></div>
              <div class="pm-card">&#9675; QA &amp; Testing <span>Upcoming</span></div>
              <div class="pm-card">&#9675; Launch Prep <span>Upcoming</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- LOGOS -->
  <section class="logos">
    <div class="container">
      <p class="logos-label">Loved by teams at</p>
      <div class="logos-row">
        <span>Stripe</span><span>Vercel</span><span>Notion</span><span>Linear</span><span>Figma</span><span>Loom</span>
      </div>
    </div>
  </section>

  <!-- FEATURES -->
  <section class="section" id="features">
    <div class="container">
      <div class="section-label">Features</div>
      <h2 class="section-h2">Everything your team needs to ship</h2>
      <p class="section-p">Stop juggling seven tools. Nexus brings together planning, execution, and communication in one elegant workspace.</p>
      <div class="features-grid">
        <div class="feat-card">
          <div class="feat-icon">&#9889;</div>
          <h3>Lightning Fast</h3>
          <p>Real-time sync across your entire team. Changes appear in under 100ms, no matter where your team is in the world.</p>
        </div>
        <div class="feat-card">
          <div class="feat-icon">&#129504;</div>
          <h3>AI-Powered Insights</h3>
          <p>Let our AI surface bottlenecks, predict delays, and surface the next most impactful task for each team member.</p>
        </div>
        <div class="feat-card">
          <div class="feat-icon">&#128202;</div>
          <h3>Rich Analytics</h3>
          <p>Understand velocity, cycle time, and team health with dashboards that give you the full picture at a glance.</p>
        </div>
        <div class="feat-card">
          <div class="feat-icon">&#128275;</div>
          <h3>Enterprise Security</h3>
          <p>SOC 2 Type II, GDPR-compliant, SSO, audit logs, and fine-grained permissions give your security team peace of mind.</p>
        </div>
        <div class="feat-card">
          <div class="feat-icon">&#128279;</div>
          <h3>200+ Integrations</h3>
          <p>Connect GitHub, Slack, Figma, Jira, and 200+ more tools your team already uses. Your workflow, not ours.</p>
        </div>
        <div class="feat-card">
          <div class="feat-icon">&#128241;</div>
          <h3>Native Mobile Apps</h3>
          <p>Full-featured iOS and Android apps so your team stays in sync whether they're at their desk or on the go.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- PRICING -->
  <section class="section pricing-section" id="pricing">
    <div class="container">
      <div class="section-label">Pricing</div>
      <h2 class="section-h2">Simple, honest pricing</h2>
      <p class="section-p">No hidden fees. No surprise overage charges. Cancel anytime.</p>
      <div class="pricing-grid">
        <div class="plan-card">
          <div class="plan-name">Free</div>
          <div class="plan-price">$0<span>/mo</span></div>
          <ul class="plan-features">
            <li>&#10003; Up to 5 team members</li>
            <li>&#10003; 3 active projects</li>
            <li>&#10003; 1GB storage</li>
            <li>&#10003; Community support</li>
          </ul>
          <a href="#" class="btn btn-outline btn-full">Get started free</a>
        </div>
        <div class="plan-card plan-featured">
          <div class="plan-badge">Most Popular</div>
          <div class="plan-name">Pro</div>
          <div class="plan-price">$12<span>/seat/mo</span></div>
          <ul class="plan-features">
            <li>&#10003; Unlimited members</li>
            <li>&#10003; Unlimited projects</li>
            <li>&#10003; 50GB storage</li>
            <li>&#10003; AI Insights</li>
            <li>&#10003; Priority support</li>
            <li>&#10003; Analytics dashboard</li>
          </ul>
          <a href="#" class="btn btn-primary btn-full">Start 14-day trial</a>
        </div>
        <div class="plan-card">
          <div class="plan-name">Enterprise</div>
          <div class="plan-price">Custom</div>
          <ul class="plan-features">
            <li>&#10003; Everything in Pro</li>
            <li>&#10003; SSO &amp; SAML</li>
            <li>&#10003; Audit logs</li>
            <li>&#10003; Custom contracts</li>
            <li>&#10003; Dedicated CSM</li>
          </ul>
          <a href="#" class="btn btn-outline btn-full">Contact sales</a>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="section" id="faq">
    <div class="container faq-inner">
      <div class="section-label">FAQ</div>
      <h2 class="section-h2">Common questions</h2>
      <div class="faq-list">
        <details class="faq-item"><summary>Is there a free trial for Pro?</summary><p>Yes! Every new account gets a 14-day Pro trial with full access, no credit card required. After the trial, you can upgrade or move to the Free plan.</p></details>
        <details class="faq-item"><summary>Can I import from Jira or Asana?</summary><p>Absolutely. We have one-click importers for Jira, Asana, Linear, Trello, and CSV files. Your data, your choice.</p></details>
        <details class="faq-item"><summary>How is data secured?</summary><p>We're SOC 2 Type II certified, GDPR compliant, and encrypt all data at rest (AES-256) and in transit (TLS 1.3). Your data is yours — always.</p></details>
        <details class="faq-item"><summary>Can I cancel anytime?</summary><p>Yes. Cancel from your account settings at any moment. You'll retain access until the end of your billing period and we'll never charge you again.</p></details>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="cta-section">
    <div class="container cta-inner">
      <h2>Ready to ship smarter?</h2>
      <p>Join 10,000+ teams who have cut their release cycles in half with Nexus.</p>
      <a href="#" class="btn btn-primary btn-lg">Start free — no card needed</a>
    </div>
  </section>

  <footer class="footer">
    <div class="container footer-inner">
      <span>&#9670; Nexus &copy; 2024</span>
      <div class="footer-links">
        <a href="#">Privacy</a><a href="#">Terms</a><a href="#">Security</a><a href="#">Status</a>
      </div>
    </div>
  </footer>

  <script src="script.js"></script>
</body>
</html>`,

      "style.css": `@import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #05080f;
  --bg2: #0a0e1a;
  --border: rgba(255,255,255,0.07);
  --text: #e8eaf0;
  --muted: #5a6280;
  --accent: #4f6ef7;
  --accent2: #7c3aed;
}

html { scroll-behavior: smooth; }
body { font-family: 'Geist', -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.container { max-width: 1120px; margin: 0 auto; padding: 0 24px; }

/* ── NAV ── */
.nav { position: sticky; top: 0; z-index: 100; background: rgba(5,8,15,0.8); backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); }
.nav-inner { display: flex; align-items: center; gap: 32px; max-width: 1120px; margin: 0 auto; padding: 16px 24px; }
.logo { font-size: 1.1rem; font-weight: 700; color: var(--text); text-decoration: none; letter-spacing: -0.01em; margin-right: auto; }
.nav-links { display: flex; gap: 28px; list-style: none; }
.nav-links a { color: var(--muted); text-decoration: none; font-size: 0.88rem; font-weight: 500; transition: color 0.18s; }
.nav-links a:hover { color: var(--text); }
.nav-ctas { display: flex; align-items: center; gap: 14px; }
.btn-text { color: var(--muted); text-decoration: none; font-size: 0.88rem; font-weight: 500; transition: color 0.18s; }
.btn-text:hover { color: var(--text); }

/* ── BUTTONS ── */
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; border-radius: 9px; font-size: 0.88rem; font-weight: 600; text-decoration: none; transition: all 0.18s; cursor: pointer; border: none; font-family: inherit; }
.btn-sm { padding: 8px 18px; font-size: 0.82rem; }
.btn-lg { padding: 14px 28px; font-size: 0.95rem; border-radius: 11px; }
.btn-full { width: 100%; justify-content: center; margin-top: auto; }
.btn-primary { background: var(--accent); color: #fff; box-shadow: 0 0 30px rgba(79,110,247,0.3); }
.btn-primary:hover { background: #6b83f8; box-shadow: 0 0 40px rgba(79,110,247,0.45); }
.btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
.btn-outline:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.15); }

/* ── HERO ── */
.hero { padding: 96px 0 72px; text-align: center; position: relative; overflow: hidden; }
.hero-noise {
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse at 50% -10%, rgba(79,110,247,0.18) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 80%, rgba(124,58,237,0.10) 0%, transparent 50%);
}
.hero-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 16px; border-radius: 20px; font-size: 0.8rem; font-weight: 600;
  background: rgba(79,110,247,0.1); border: 1px solid rgba(79,110,247,0.25); color: #7b96f9;
  margin-bottom: 28px;
}
.hero-h1 { font-size: clamp(2.8rem, 7vw, 5.5rem); font-weight: 800; line-height: 1.06; letter-spacing: -0.04em; margin-bottom: 22px; }
.gradient-text { background: linear-gradient(90deg, var(--accent), #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.hero-p { font-size: 1.1rem; color: var(--muted); max-width: 560px; margin: 0 auto 36px; line-height: 1.7; }
.hero-ctas { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-bottom: 14px; }
.hero-micro { font-size: 0.78rem; color: var(--muted); margin-bottom: 56px; }

/* Preview */
.hero-preview { max-width: 900px; margin: 0 auto; border-radius: 16px; border: 1px solid var(--border); overflow: hidden; box-shadow: 0 40px 100px rgba(0,0,0,0.6); }
.preview-bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #0d1120; border-bottom: 1px solid var(--border); }
.dot { width: 11px; height: 11px; border-radius: 50%; }
.dot.red { background: #ff5f57; }
.dot.yellow { background: #febc2e; }
.dot.green { background: #28c840; }
.preview-url { font-family: 'Geist Mono', monospace; font-size: 0.72rem; color: var(--muted); margin-left: 8px; }
.preview-body { display: flex; height: 320px; background: #080c18; }
.preview-sidebar { width: 160px; border-right: 1px solid var(--border); padding: 16px 0; flex-shrink: 0; }
.ps-item { padding: 9px 16px; font-size: 0.8rem; color: var(--muted); cursor: pointer; transition: background 0.15s; }
.ps-item.active { background: rgba(79,110,247,0.1); color: #7b96f9; }
.preview-main { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.pm-header { display: flex; align-items: center; justify-content: space-between; }
.pm-title { font-size: 0.95rem; font-weight: 600; }
.pm-tags { display: flex; gap: 6px; }
.tag-g { padding: 3px 8px; background: rgba(34,197,94,0.12); color: #4ade80; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
.tag-b { padding: 3px 8px; background: rgba(79,110,247,0.12); color: #7b96f9; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
.pm-progress { height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
.pm-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #a78bfa); border-radius: 3px; }
.pm-cards { display: flex; flex-direction: column; gap: 8px; }
.pm-card { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; font-size: 0.8rem; color: var(--muted); }
.pm-card span { font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; background: rgba(255,255,255,0.05); }
.pm-card.done { color: #4ade80; }
.pm-card.active { color: var(--text); border-color: rgba(79,110,247,0.25); }

/* LOGOS */
.logos { padding: 48px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: center; }
.logos-label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; margin-bottom: 20px; }
.logos-row { display: flex; justify-content: center; flex-wrap: wrap; gap: 40px; }
.logos-row span { font-size: 1.1rem; font-weight: 700; color: rgba(255,255,255,0.18); letter-spacing: -0.02em; }

/* SECTIONS */
.section { padding: 96px 0; text-align: center; }
.section-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); margin-bottom: 14px; }
.section-h2 { font-size: clamp(1.9rem, 4vw, 2.8rem); font-weight: 800; letter-spacing: -0.03em; margin-bottom: 14px; }
.section-p { font-size: 1rem; color: var(--muted); max-width: 520px; margin: 0 auto 56px; }

/* FEATURES */
.features-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; text-align: left; }
.feat-card { padding: 28px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg2); transition: border-color 0.2s, transform 0.2s; }
.feat-card:hover { border-color: rgba(79,110,247,0.3); transform: translateY(-3px); }
.feat-icon { font-size: 1.8rem; margin-bottom: 14px; }
.feat-card h3 { font-size: 1rem; font-weight: 700; margin-bottom: 8px; }
.feat-card p { font-size: 0.88rem; color: var(--muted); line-height: 1.65; }

/* PRICING */
.pricing-section { background: var(--bg2); }
.pricing-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; max-width: 900px; margin: 0 auto; text-align: left; }
.plan-card { padding: 28px; border: 1px solid var(--border); border-radius: 16px; background: var(--bg); display: flex; flex-direction: column; gap: 20px; position: relative; }
.plan-featured { border-color: var(--accent); background: rgba(79,110,247,0.05); }
.plan-badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); padding: 4px 14px; background: var(--accent); border-radius: 20px; font-size: 0.72rem; font-weight: 700; color: #fff; white-space: nowrap; }
.plan-name { font-size: 0.88rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.plan-price { font-size: 2.4rem; font-weight: 800; letter-spacing: -0.03em; }
.plan-price span { font-size: 0.85rem; font-weight: 500; color: var(--muted); }
.plan-features { list-style: none; display: flex; flex-direction: column; gap: 10px; font-size: 0.88rem; color: var(--muted); flex: 1; }

/* FAQ */
.faq-inner { max-width: 680px; margin: 0 auto; }
.faq-list { margin-top: 40px; display: flex; flex-direction: column; gap: 8px; text-align: left; }
.faq-item { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.faq-item summary { padding: 18px 20px; font-weight: 600; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; font-size: 0.95rem; }
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after { content: "+"; font-size: 1.2rem; color: var(--muted); }
.faq-item[open] summary::after { content: "−"; }
.faq-item p { padding: 0 20px 18px; color: var(--muted); font-size: 0.9rem; line-height: 1.7; }

/* CTA */
.cta-section { padding: 96px 0; background: linear-gradient(135deg, rgba(79,110,247,0.08) 0%, rgba(124,58,237,0.06) 100%); border-top: 1px solid var(--border); text-align: center; }
.cta-inner h2 { font-size: clamp(1.8rem, 4vw, 2.8rem); font-weight: 800; letter-spacing: -0.03em; margin-bottom: 14px; }
.cta-inner p { color: var(--muted); margin-bottom: 32px; }

/* FOOTER */
.footer { padding: 28px 0; border-top: 1px solid var(--border); }
.footer-inner { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; font-size: 0.82rem; color: var(--muted); }
.footer-links { display: flex; gap: 24px; }
.footer-links a { color: var(--muted); text-decoration: none; transition: color 0.18s; }
.footer-links a:hover { color: var(--text); }

@media (max-width: 768px) {
  .nav-links { display: none; }
  .nav-ctas .btn-text { display: none; }
  .hero-h1 { font-size: 2.4rem; }
  .preview-sidebar { display: none; }
  .pricing-grid { grid-template-columns: 1fr; }
}`,

      "script.js": `"use strict";

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
style.textContent = \`
  .feat-card, .plan-card { opacity: 0; transform: translateY(18px); transition: opacity 0.45s ease, transform 0.45s ease; }
  .anim-in { opacity: 1 !important; transform: translateY(0) !important; }
\`;
document.head.appendChild(style);
cards.forEach(c => obs.observe(c));

// ── Smooth scroll ─────────────────────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener("click", e => {
    const t = document.querySelector(a.getAttribute("href"));
    if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
  });
});`
    }
  };
}

module.exports = { generateTemplate };
