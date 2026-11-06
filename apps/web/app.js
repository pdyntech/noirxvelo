// Sailo dashboard. No build step: plain ES modules, live state over Server-Sent Events.
// Covers UI-01 role switcher, UI-02 portals, UI-03 voyage, UI-04 decision stream, OPS-01 debug panel.

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (x) => (x == null || x === "" ? null : Number(x));
const fmtXlm = (x) => (x == null ? "—" : `${Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 })} XLM`);
const fmtPhp = (x) => (x == null ? "—" : `₱${Math.round(Number(x) * 1000).toLocaleString("en-US")}`);
const short = (h, n = 6) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const txLink = (t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(short(t.hash, 8))} ↗</a>`;

const STEPS = ["TOKENIZED", "FUNDED", "ADVANCED", "IN_TRANSIT", "BERTHED", "PAID", "SETTLED"];
const ORDER = ["DRAFT", ...STEPS];
const rank = (s) => ORDER.indexOf(s);

let S = null; // latest server state
let role = localStorage.getItem("role") || "ops";
try {
  if (!["shipowner", "investor", "debtor", "ops"].includes(role)) role = "ops";
} catch {
  role = "ops";
}
const pending = new Set(); // actions the user just clicked (spinner until the server reports busy)

// ---------------- API ----------------
async function act(path, label) {
  pending.add(path);
  render();
  try {
    const r = await fetch(`/api/${path}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) toast(j.error || `${label} failed (${r.status})`, true);
  } catch (e) {
    toast(`Network error: ${e.message}`, true);
  } finally {
    setTimeout(() => {
      pending.delete(path);
      render();
    }, 500);
  }
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 4200);
}

function connect() {
  let es;
  const start = () => {
    es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        S = JSON.parse(ev.data);
        render();
      } catch {
        /* ignore partial frames */
      }
    };
    es.onerror = () => {
      es.close();
      setTimeout(start, 2000);
      fetch("/api/state").then((r) => r.json()).then((j) => { S = j; render(); }).catch(() => {});
    };
  };
  start();
}

// ---------------- helpers ----------------
const busy = () => !!S?.busy;
const chainReady = () => !!S?.config?.chainReady;

const BUSY_NAMES = {
  tokenize: "Tokenize & register",
  fund: "Fund 85% advance",
  depart: "Depart Manila",
  checkout: "Create Velo checkout",
  "simulate-webhook": "Simulate Velo webhook",
  guardrail: "Guardrail demo",
  default: "Simulate default",
  reset: "Reset",
  "run-demo": "Run Demo",
};

function button(path, label, { cls = "", enabled = true, title = "" } = {}) {
  const spinning = pending.has(path) || (!!S?.busy && S.busy === BUSY_NAMES[path]);
  const dis = !enabled || (busy() && path !== "fast-forward") || pending.has(path);
  return `<button class="btn ${cls}" data-act="${esc(path)}" data-label="${esc(label)}" ${dis ? "disabled" : ""} title="${esc(title)}">${spinning ? '<span class="spin"></span>' : ""}${esc(label)}</button>`;
}

function field(label, value, full = false) {
  return `<div class="field${full ? " full" : ""}"><label>${esc(label)}</label><div class="val">${value}</div></div>`;
}

function wallet(name, key) {
  const addr = S.addresses?.[key];
  const bal = S.balances?.[key];
  return `<div class="wallet"><span>${esc(name)} wallet ${addr ? `<a href="https://stellar.expert/explorer/testnet/account/${esc(addr)}" target="_blank" rel="noopener" class="mono">${esc(short(addr, 5))}</a>` : '<span class="muted">not configured</span>'}</span><b>${fmtXlm(bal)}</b></div>`;
}

const txWhere = (re) => (S?.txs || []).filter((t) => re.test(t.label));

// ---------------- sections ----------------
function renderChips() {
  const c = S.config;
  const chip = (cls, text, title = "") => `<span class="chip ${cls}" title="${esc(title)}"><span class="dot"></span>${esc(text)}</span>`;
  $("#chips").innerHTML = [
    chip(c.chainReady ? "ok" : "bad", c.chainReady ? "Stellar Testnet" : "Wallets missing", c.chainReady ? "Noir contracts via @noirx402/agent-sdk" : c.missing.join(", ")),
    chip(c.veloCheckout ? "ok" : "warn", c.veloCheckout ? "Velo checkout live" : "Velo checkout simulated", "VELO_API_KEY"),
    chip(c.llm ? "ok" : "", c.llm ? "LLM reasoning on" : "Rules agent", "LLM_API_KEY"),
    `<span class="chip">${esc(S.invoice.id)}</span>`,
    `<span class="chip" title="Fixed demo conversion">1 XLM = ₱1,000</span>`,
  ].join("");
}

function renderBanner() {
  let html = "";
  if (!S.config.chainReady) html = `<div class="banner bad">On-chain actions are disabled: missing ${esc(S.config.missing.join(", "))}. Run <code>npm run provision</code> or set the wallet env vars on the host.</div>`;
  else if (S.error) html = `<div class="banner bad">${esc(S.error)}</div>`;
  else if (S.status === "SETTLED") html = `<div class="banner ok">Invoice ${esc(S.invoice.id)} settled on Testnet. Escrow is ${fmtXlm(S.escrowXlm ?? 0)}. Every payout below links to Stellar Expert.</div>`;
  $("#banner").innerHTML = html;
}

function renderPipeline() {
  const st = S.status;
  const ref = st === "HOLD" ? S.holdFrom || "DRAFT" : st === "DEFAULT" ? "FUNDED" : st;
  const r = rank(ref);
  const html = STEPS.map((s, i) => {
    const sr = i + 1;
    const cls = sr <= r ? "done" : sr === r + 1 && st !== "SETTLED" && st !== "DEFAULT" ? "current" : "";
    return `<div class="step ${cls}"><div class="node"><div class="circle">${sr <= r ? "✓" : sr}</div><div class="label">${s.replace("_", " ")}</div></div><div class="bar"></div></div>`;
  }).join("");
  const term = st === "HOLD" ? '<span class="terminal hold">HOLD</span>' : st === "DEFAULT" ? '<span class="terminal default">DEFAULT · recovered</span>' : "";
  $("#pipeline").innerHTML = html + term;
}

function shipownerPanel() {
  const w = S.invoice.waybill || {};
  const adv = txWhere(/authorize \(SHIPOWNER 850/)[0];
  const advanced = rank(S.status) >= rank("ADVANCED") || (S.status === "HOLD" && rank(S.holdFrom) >= rank("ADVANCED"));
  return `
  <div class="card">
    <div class="card-head"><h2>Shipowner portal</h2><span class="muted small">MV VisMin Pioneer Shipping</span></div>
    <h3>Freight manifest (e-Waybill)</h3>
    <div class="fields">
      ${field("Waybill no.", esc(w.waybill_no))}
      ${field("Terms", esc(w.terms))}
      ${field("Vessel", `${esc(w.vessel)} · MMSI ${esc(w.vessel_mmsi)}`, true)}
      ${field("Route", esc(w.route), true)}
      ${field("Debtor", esc(w.debtor))}
      ${field("Due", esc(w.due_date))}
      ${field("Face value", `<b>₱1,000,000</b> <span class="muted">· ${fmtXlm(S.invoice.faceXlm)}</span>`, true)}
      ${S.invoice.hash ? field("Invoice hash (device id)", `<span class="mono">${esc(S.invoice.hash)}</span>`, true) : ""}
      ${S.invoice.hash ? field("Agent policy", `cap ${fmtXlm(S.invoice.payouts.maxAmount)} per payment · XLM only · expires ${esc((S.invoice.policyExpiresAt || "").slice(0, 10))}`, true) : ""}
    </div>
    <div class="actions">
      ${button("tokenize", "Tokenize & register", { cls: "primary", enabled: chainReady() && S.status === "DRAFT", title: "device_registry.register + agent_registry.register_agent" })}
      ${button("depart", "Depart Manila", { enabled: chainReady() && S.status === "FUNDED" && !S.voyage.running, title: "Start the AIS voyage; the agent releases the advance once underway" })}
    </div>
    ${
      advanced
        ? `<div class="callout gold"><div class="sub">Advance received</div><div class="big">${fmtXlm(S.invoice.payouts.advance)} <span class="muted" style="font-size:14px">(₱850,000)</span></div><div class="sub">for bunker fuel & port dues, the day the ship sailed ${adv ? "· " + txLink(adv) : ""}</div></div>`
        : `<div class="callout teal"><div class="sub">You will receive</div><div class="big">${fmtXlm(S.invoice.payouts.advance)} now</div><div class="sub">+ ${fmtXlm(S.invoice.payouts.rebate)} rebate when the debtor pays · no XLM needed for fees</div></div>`
    }
    ${S.status === "SETTLED" ? `<div class="callout teal"><div class="sub">Reserve rebate received at settlement</div><div class="big">${fmtXlm(S.invoice.payouts.rebate)}</div></div>` : ""}
    ${wallet("Shipowner", "SHIPOWNER")}
  </div>`;
}

function investorPanel() {
  const p = S.invoice.payouts;
  const funded = rank(S.status) >= rank("FUNDED") || S.status === "HOLD" || S.status === "DEFAULT";
  const settled = S.status === "SETTLED";
  const pct = settled ? 100 : funded ? 50 : 0;
  return `
  <div class="card">
    <div class="card-head"><h2>Investor portal</h2><span class="muted small">Freight receivable pool</span></div>
    <div class="callout teal" style="margin-top:0"><div class="sub">${esc(S.invoice.id)} · MV VisMin Pioneer · Manila → Cebu</div><div class="big">Isla Beverages Corp. · Net-60</div></div>
    <div class="stat-row" style="margin-top:12px">
      <div class="stat"><div class="k">Face value</div><div class="v">₱1,000,000</div><div class="s">${fmtXlm(S.invoice.faceXlm)}</div></div>
      <div class="stat"><div class="k">Advance required</div><div class="v">${fmtXlm(p.advance)}</div><div class="s">85% of face</div></div>
      <div class="stat"><div class="k">Expected yield</div><div class="v">${fmtXlm(p.yield)}</div><div class="s">3.0% of face · 3.53% on capital</div></div>
      <div class="stat"><div class="k">Tenor</div><div class="v">60 days</div><div class="s">≈21.5% simple annualized</div></div>
    </div>
    <div class="actions">${button("fund", "Fund 85% advance", { cls: "primary block", enabled: chainReady() && S.status === "TOKENIZED", title: "payment_escrow.fund_escrow from the LP wallet" })}</div>
    <div style="margin-top:14px">
      <div class="small muted" style="display:flex;justify-content:space-between"><span>Capital recovery</span><span>${settled ? `${fmtXlm(p.lpRepayment)} returned` : funded ? `${fmtXlm(p.advance)} deployed` : "not funded"}</span></div>
      <div class="progress" style="margin-top:6px"><span style="width:${pct}%"></span></div>
    </div>
    ${settled ? `<div class="callout teal"><div class="sub">Repaid by the settlement agent</div><div class="big">${fmtXlm(p.lpRepayment)}</div><div class="sub">${fmtXlm(p.advance)} principal + ${fmtXlm(p.yield)} yield</div></div>` : ""}
    ${S.status === "DEFAULT" ? `<div class="callout red"><div class="sub">Default: escrow swept to Treasury by ops recovery. Funds not yet advanced are returned off-escrow.</div></div>` : ""}
    ${wallet("LP", "LP")}
  </div>`;
}

function debtorPanel() {
  const c = S.checkout;
  const pay = S.payment;
  const canPay = S.status !== "DRAFT" && !pay;
  return `
  <div class="card">
    <div class="card-head"><h2>Debtor · pay invoice</h2><span class="muted small">Isla Beverages Corp. treasury</span></div>
    <div class="fields">
      ${field("From", "MV VisMin Pioneer Shipping")}
      ${field("Invoice", esc(S.invoice.id))}
      ${field("Amount due", `<b>₱1,000,000</b> <span class="muted">· ${fmtXlm(S.invoice.faceXlm)}</span>`, true)}
    </div>
    <div class="actions">
      ${button("checkout", c ? "Checkout created" : "Pay with Velo checkout", { cls: "primary", enabled: S.status !== "DRAFT" && !c })}
      ${button("simulate-webhook", "Simulate payment.succeeded", { enabled: canPay, title: "Signs a delivery exactly like Velo and posts it to /api/webhooks/velo" })}
    </div>
    ${
      c
        ? `<div class="callout teal"><div class="sub">Velo payment intent ${c.simulated ? "(simulated: no VELO_API_KEY)" : ""}</div><div class="mono">${esc(c.id)}</div>${c.checkoutUrl ? `<div style="margin-top:6px"><a class="btn gold" href="${esc(c.checkoutUrl)}" target="_blank" rel="noopener">Open Velo checkout ↗</a></div>` : ""}<div class="sub" style="margin-top:6px">${esc(c.amount)} ${esc(c.asset)} · status ${esc(c.status)}</div></div>`
        : ""
    }
    ${
      pay
        ? `<div class="callout ${pay.amountMatches ? "teal" : "red"}"><div class="sub">Webhook ${pay.simulated ? "(simulated delivery)" : ""} verified by ${esc(pay.verifiedBy)}</div><div class="big">payment.succeeded</div><div class="sub">${esc(pay.amountXlm)} XLM · delivery ${esc(pay.deliveryId)} · ${pay.amountMatches ? "amount matches invoice" : "AMOUNT MISMATCH"}</div></div>`
        : `<p class="muted small" style="margin-top:12px">Settlement waits for both a verified Velo webhook and the berthing attestation. The debtor never touches a crypto wallet.</p>`
    }
  </div>`;
}

function opsPanel() {
  const g = S.guardrail;
  const rec = S.recovery;
  return `
  <div class="card">
    <div class="card-head"><h2>Ops overview</h2><span class="muted small">run ${esc(S.run)}</span></div>
    <div class="stat-row">
      <div class="stat"><div class="k">Status</div><div class="v" style="font-size:15px">${esc(S.status)}</div></div>
      <div class="stat"><div class="k">Escrow</div><div class="v">${fmtXlm(S.escrowXlm)}</div></div>
    </div>
    <div class="actions">
      ${button("run-demo", "▶ Run Demo", { cls: "gold block", enabled: chainReady(), title: "Drives the full loop on Testnet in about 90 seconds" })}
    </div>
    ${
      g
        ? `<div class="callout ${g.unexpectedSuccess ? "red" : "teal"}"><div class="sub">Guardrail · ${esc(time(g.ranAt))}</div><div style="font-weight:700;margin:2px 0">${g.unexpectedSuccess ? "NOT refused!" : `Refused on-chain policy: ${esc(g.checkPayment?.reason || "")}`}</div><div class="sub">${esc(g.summary)}</div></div>`
        : `<p class="muted small" style="margin-top:12px">Guardrail: before settling, the agent tries a single 1,000 XLM payout against its 880 XLM cap. Noir's <code>agent_registry</code> refuses it.</p>`
    }
    ${rec ? `<div class="callout red"><div class="sub">Default recovery</div><div class="sub">escrow ${fmtXlm(Number(rec.escrowBefore) / 1e7)} → ${fmtXlm(Number(rec.escrowAfter) / 1e7)} · revoked agent check: ${esc(rec.checkAfterRevoke)}</div></div>` : ""}
    ${wallet("Treasury", "TREASURY")}
    ${wallet("Agent", "AGENT")}
  </div>`;
}

function renderRolePanel() {
  const map = { shipowner: [shipownerPanel], investor: [investorPanel], debtor: [debtorPanel], ops: [opsPanel, shipownerPanel, investorPanel, debtorPanel] };
  $("#role-panel").innerHTML = map[role].map((f) => f()).join("");
  document.querySelectorAll("#roles button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.role === role)));
}

// ----- voyage chart -----
const BOX = { lng0: 120.2, lng1: 125.0, lat0: 9.55, lat1: 14.95, w: 480, h: 520 };
const px = (lat, lng) => [((lng - BOX.lng0) / (BOX.lng1 - BOX.lng0)) * BOX.w, ((BOX.lat1 - lat) / (BOX.lat1 - BOX.lat0)) * BOX.h];
const ptsStr = (arr) => arr.map(([la, ln]) => px(la, ln).map((v) => v.toFixed(1)).join(",")).join(" ");
const ROUTE = [[14.58, 120.965], [14.4, 120.62], [13.75, 120.55], [13.6, 121.05], [12.95, 122.05], [12.25, 122.95], [11.3, 123.75], [10.75, 124.15], [10.42, 124.0], [10.3015, 123.908]];
// Schematic coastlines (approximate, for orientation only).
const LAND = {
  Luzon: [[14.95, 120.55], [14.95, 121.7], [14.1, 122.0], [14.05, 122.7], [14.1, 123.15], [13.6, 123.95], [12.8, 124.15], [12.95, 123.5], [13.35, 122.6], [13.55, 121.75], [13.72, 121.3], [13.75, 120.68], [14.15, 120.62], [14.35, 120.98], [14.62, 120.97], [14.75, 120.55]],
  Bataan: [[14.85, 120.3], [14.85, 120.55], [14.45, 120.6], [14.4, 120.45]],
  Mindoro: [[13.5, 120.4], [13.5, 121.5], [12.6, 121.6], [12.2, 121.2], [12.4, 120.8], [13.0, 120.5]],
  Marinduque: [[13.55, 121.85], [13.45, 122.15], [13.2, 122.05], [13.3, 121.85]],
  Panay: [[11.95, 121.9], [11.8, 122.7], [11.1, 123.1], [10.45, 122.5], [10.8, 121.95], [11.6, 121.85]],
  Masbate: [[12.6, 123.2], [12.3, 123.95], [11.85, 124.0], [12.15, 123.3]],
  Negros: [[10.95, 123.2], [10.5, 123.5], [9.9, 123.2], [9.6, 122.9], [9.9, 122.55], [10.4, 122.85], [10.95, 123.0]],
  Cebu: [[11.28, 124.0], [10.9, 124.02], [10.6, 123.95], [10.32, 123.885], [10.0, 123.75], [9.62, 123.42], [9.72, 123.3], [10.2, 123.55], [10.8, 123.78], [11.15, 123.85]],
  Bohol: [[10.15, 123.85], [10.1, 124.45], [9.75, 124.6], [9.6, 124.1], [9.7, 123.8]],
  Leyte: [[11.55, 124.35], [11.25, 125.0], [10.1, 125.25], [10.2, 124.75], [10.9, 124.4]],
  Samar: [[12.6, 124.2], [12.5, 125.0], [11.1, 125.0], [11.35, 124.9], [12.05, 124.4]],
};

function chartSvg() {
  const v = S.voyage;
  const t = v.latest;
  const [cx, cy] = px(10.3015, 123.908);
  const rPx = (0.8 / 111) / (BOX.lat1 - BOX.lat0) * BOX.h; // 800 m in px (tiny), drawn with a visible halo
  const grid = [];
  for (let lat = 10; lat <= 14.5; lat += 1) {
    const [, y] = px(lat, BOX.lng0);
    grid.push(`<line x1="0" x2="${BOX.w}" y1="${y}" y2="${y}" class="g"/><text x="4" y="${y - 3}" class="gt">${lat}°N</text>`);
  }
  for (let lng = 121; lng <= 124.5; lng += 1) {
    const [x] = px(BOX.lat1, lng);
    grid.push(`<line y1="0" y2="${BOX.h}" x1="${x}" x2="${x}" class="g"/><text x="${x + 3}" y="${BOX.h - 4}" class="gt">${lng}°E</text>`);
  }
  const land = Object.entries(LAND).map(([n, p]) => `<polygon points="${ptsStr(p)}" class="land"><title>${n}</title></polygon>`).join("");
  const done = v.ticks.length ? ROUTE.slice(0, 1).concat(v.ticks.map((k) => [k.lat, k.lng])) : [];
  const ship = t ? px(t.lat, t.lng) : px(14.58, 120.965);
  const berthed = v.berthed;
  return `
  <svg viewBox="0 0 ${BOX.w} ${BOX.h}" role="img" aria-label="Voyage chart Manila to Cebu">
    <style>
      .g{stroke:#13284a;stroke-width:1}.gt{fill:#2c4670;font:10px ui-monospace,monospace}
      .land{fill:#132a3f;stroke:#21466a;stroke-width:1}
      .route{fill:none;stroke:#2a4d7a;stroke-width:2;stroke-dasharray:5 6}
      .done{fill:none;stroke:#2dd4bf;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
      .port{fill:#f5b94a}.pl{fill:#e7eefb;font:600 11px Inter,system-ui,sans-serif}.ps{fill:#8c9cbb;font:10px Inter,system-ui,sans-serif}
      .fence{fill:${berthed ? "rgba(52,211,153,.18)" : "rgba(96,165,250,.08)"};stroke:${berthed ? "#34d399" : "#3b6fb0"};stroke-width:1.5;stroke-dasharray:${berthed ? "0" : "3 3"}}
    </style>
    ${grid.join("")}
    ${land}
    <polyline points="${ptsStr(ROUTE)}" class="route"/>
    ${done.length > 1 ? `<polyline points="${ptsStr(done)}" class="done"/>` : ""}
    <circle cx="${cx}" cy="${cy}" r="${Math.max(rPx, 15)}" class="fence"/>
    <circle cx="${px(14.58, 120.965)[0]}" cy="${px(14.58, 120.965)[1]}" r="4.5" class="port"/>
    <text x="${px(14.58, 120.965)[0] + 8}" y="${px(14.58, 120.965)[1] + 4}" class="pl">Manila South Harbor</text>
    <circle cx="${cx}" cy="${cy}" r="4.5" class="port"/>
    <text x="${cx - 92}" y="${cy + 30}" class="pl">Port of Cebu</text>
    <text x="${cx - 92}" y="${cy + 43}" class="ps">800 m geofence</text>
    <text x="${px(12.75, 122.25)[0]}" y="${px(12.75, 122.25)[1]}" class="ps">Sibuyan Sea</text>
    <text x="${px(11.55, 123.3)[0]}" y="${px(11.55, 123.3)[1]}" class="ps">Visayan Sea</text>
    <g transform="translate(${ship[0].toFixed(1)},${ship[1].toFixed(1)}) rotate(${t ? t.cog : 200})">
      <circle r="11" fill="rgba(245,185,74,.18)"><animate attributeName="r" values="9;14;9" dur="2s" repeatCount="indefinite"/></circle>
      <path d="M0,-9 L5,6 L0,3 L-5,6 Z" fill="#f5b94a" stroke="#2a1a00" stroke-width="1"/>
    </g>
  </svg>`;
}

function renderVoyage() {
  const v = S.voyage;
  const t = v.latest;
  const p = t ? Math.round(t.progress * 100) : 0;
  const leg = t?.leg || "Manila South Harbor";
  const stop = (name, on) => `<span class="${on ? "on" : ""}">${name}</span>`;
  $("#voyage-card").innerHTML = `
    <div class="voyage-top">
      <div><h2>Voyage · MV VisMin Pioneer</h2><div class="muted small">AIS simulator (offline, deterministic) · MMSI 548123456</div></div>
      <span class="geo ${v.berthed ? "on" : ""}">${v.berthed ? "● Berthed in Cebu geofence" : t?.inGeofence ? "● Inside geofence" : v.running ? "● Underway" : "○ In port"}</span>
    </div>
    <div class="chart">${chartSvg()}<div class="legend">Schematic chart · not for navigation</div></div>
    <div class="track">
      <div class="progress"><span style="width:${p}%"></span></div>
      <div class="track-labels">${stop("Manila South Harbor", p < 30)}${stop("Sibuyan Sea", p >= 30 && p < 85)}${stop("Port of Cebu", p >= 85)}</div>
    </div>
    <div class="hud">
      <div class="stat"><div class="k">Lat / Lng</div><div class="v">${t ? `${t.lat.toFixed(3)}, ${t.lng.toFixed(3)}` : "14.580, 120.965"}</div></div>
      <div class="stat"><div class="k">SOG</div><div class="v">${t ? t.sog.toFixed(1) : "0.0"} kn</div></div>
      <div class="stat"><div class="k">COG</div><div class="v">${t ? t.cog : "—"}°</div></div>
      <div class="stat"><div class="k">Nav status</div><div class="v" style="font-family:inherit;font-size:13px">${esc(t?.navStatus || "Moored")}</div></div>
      <div class="stat"><div class="k">Leg</div><div class="v" style="font-family:inherit;font-size:13px">${esc(leg)}</div></div>
      <div class="stat"><div class="k">Progress</div><div class="v">${p}%</div></div>
    </div>
    ${S.attestation ? `<div class="callout teal" style="cursor:pointer" data-open="attestation"><div class="sub">Proof of delivery · signed by agent ${esc(short(S.attestation.signer, 5))}</div><div class="mono">sha256 ${esc(short(S.attestation.sha256, 16))}</div><div class="sub">click to inspect the attestation</div></div>` : ""}`;
}

function renderKpis() {
  const p = S.invoice.payouts;
  const settled = S.status === "SETTLED";
  const claimed = (S.txs || []).filter((t) => /claim/.test(t.label)).length;
  $("#kpis").innerHTML = `
    <div class="card-head"><h2>Money flow</h2><span class="muted small">integer stroops · parts always sum to face value</span></div>
    <div class="kpis">
      <div class="stat"><div class="k">Escrow now</div><div class="v">${fmtXlm(S.escrowXlm)}</div><div class="s">${S.escrowXlm != null ? fmtPhp(S.escrowXlm) : "not funded"}</div></div>
      <div class="stat"><div class="k">LP repayment</div><div class="v">${fmtXlm(p.lpRepayment)}</div><div class="s">advance + 3% yield</div></div>
      <div class="stat"><div class="k">Shipowner rebate</div><div class="v">${fmtXlm(p.rebate)}</div><div class="s">reserve minus yield & fee</div></div>
      <div class="stat"><div class="k">Protocol fee</div><div class="v">${fmtXlm(p.fee)}</div><div class="s">0.5% to treasury</div></div>
    </div>
    <div class="conserve ${settled ? "" : "muted"}">${settled ? `✓ Conservation: ${p.lpRepayment} + ${p.rebate} + ${p.fee} = ${S.invoice.faceXlm} XLM settled · ${claimed} claims landed · escrow ${fmtXlm(S.escrowXlm ?? 0)}` : `Settlement split: ${p.lpRepayment} + ${p.rebate} + ${p.fee} = ${S.invoice.faceXlm} XLM`}</div>`;
}

function renderDecisions() {
  const list = [...(S.decisions || [])].reverse();
  if (!list.length) {
    $("#decisions").innerHTML = `<div class="empty">No decisions yet.<br/>Tokenize, fund and depart, or press <b>▶ Run Demo</b>. The agent decides on its own as facts arrive.</div>`;
    return;
  }
  $("#decisions").innerHTML = list
    .map((d) => {
      const pills = d.payouts.map((p) => `<span class="pill ${esc(p.role)} ${d.decision === "REFUSED" ? "strike" : ""}">${esc(p.role)}: ${esc(p.xlm)} XLM</span>`).join("");
      const txs = d.txs.map((t) => `<div><span class="muted">${esc(t.step)} ${esc(t.role)}</span> · ${txLink(t)}</div>`).join("");
      const refusal = d.refusal ? `<div class="small" style="margin-top:6px;color:${d.decision === "REFUSED" ? "#c4b5fd" : "var(--amber)"}">refusal: <b>${esc(d.refusal)}</b>${d.detail ? ` · ${esc(d.detail)}` : ""}</div>` : "";
      return `<article class="dec" data-dec="${esc(d.id)}" tabindex="0">
        <div class="dec-head"><span class="badge b-${esc(d.decision)}">${esc(d.decision)}</span>${d.requested !== d.decision ? `<span class="engine">requested ${esc(d.requested)}</span>` : ""}<span class="engine">${esc(d.engine)}</span><span class="dec-time">${esc(time(d.at))}</span></div>
        <div class="dec-reason">${esc(d.reason)}</div>
        ${pills ? `<div class="pills">${pills}</div>` : ""}
        ${refusal}
        ${txs ? `<div class="dec-txs">${txs}</div>` : ""}
        ${d.finalEscrowXlm != null ? `<div class="small muted" style="margin-top:6px">escrow after: ${esc(d.finalEscrowXlm)} XLM</div>` : ""}
      </article>`;
    })
    .join("");
}

function renderLedger() {
  const txs = [...(S.txs || [])].reverse();
  $("#ledger").innerHTML = txs.length
    ? `<table><thead><tr><th>Time</th><th>Call</th><th>Signer</th><th>Transaction</th></tr></thead><tbody>${txs
        .map((t) => `<tr><td class="muted">${esc(time(t.at))}</td><td>${esc(t.label)}</td><td><span class="role-tag">${esc(t.role)}</span></td><td class="mono">${txLink(t)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">Transactions appear here as they land on Stellar Testnet.</div>`;
}

function renderOps() {
  const st = S.status;
  const actions = [
    button("run-demo", "▶ Run Demo", { cls: "gold", enabled: chainReady() }),
    button("fast-forward", "⏩ Fast-forward to Cebu", { enabled: S.voyage.running || st === "FUNDED" }),
    button("simulate-webhook", "Simulate Velo webhook", { enabled: st !== "DRAFT" && !S.payment }),
    button("guardrail", "Trigger guardrail (1,000 XLM)", { enabled: chainReady() && !!S.invoice.hash }),
    button("default", "Simulate default + recover", { cls: "danger", enabled: chainReady() && ["FUNDED", "ADVANCED", "IN_TRANSIT", "BERTHED", "HOLD"].includes(st) }),
    button("reset", "↺ Reset demo", { enabled: true }),
  ];
  $("#ops-actions").innerHTML = actions.join("") + `<div class="small muted" style="width:100%;margin-top:4px">Every button makes real Testnet calls except the simulated webhook delivery, which is HMAC-signed and verified by the same code path as a real Velo webhook.</div>`;
  $("#ops-busy").innerHTML = S.busy ? `<span class="busy-pill"><span class="spin" style="width:10px;height:10px;border-width:2px;border-radius:50%;border-style:solid;border-right-color:transparent;display:inline-block;animation:spin .8s linear infinite"></span>${esc(S.busy)}…</span>` : S.voyage.running ? `<span class="busy-pill">voyage streaming…</span>` : "";
  const box = $("#ops-log");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = (S.log || []).map((l) => `<div class="l-${esc(l.level)}"><span class="t">${esc(time(l.at))}</span> ${esc(l.text)}</div>`).join("");
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function render() {
  if (!S) return;
  renderChips();
  renderBanner();
  renderPipeline();
  renderRolePanel();
  renderVoyage();
  renderKpis();
  renderDecisions();
  renderLedger();
  renderOps();
}

// ---------------- modal ----------------
const pretty = (o) => esc(JSON.stringify(o, null, 2));
function openModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  const m = $("#modal");
  if (!m.open) m.showModal();
}
function attestationHtml(a) {
  return `<div class="kv"><div class="k">Scheme</div><div class="v">${esc(a.scheme)}</div><div class="k">Signer (agent)</div><div class="v mono">${esc(a.signer)}</div><div class="k">sha256</div><div class="v mono">${esc(a.sha256)}</div><div class="k">Signature</div><div class="v mono">${esc(a.signature)}</div></div>
  <h3>Record</h3><pre class="json">${pretty(a.record)}</pre><h3>Canonical JSON (hashed)</h3><pre class="json">${esc(a.canonical)}</pre>`;
}
function openDecision(id) {
  const d = (S.decisions || []).find((x) => x.id === id);
  if (!d) return;
  let html = `<div class="kv"><div class="k">Decision</div><div class="v"><span class="badge b-${esc(d.decision)}">${esc(d.decision)}</span> ${d.requested !== d.decision ? `(requested ${esc(d.requested)})` : ""}</div><div class="k">Engine</div><div class="v">${esc(d.engine)}</div><div class="k">Time</div><div class="v">${esc(d.at)}</div><div class="k">Executor result</div><div class="v">${d.ok ? "executed" : "refused / held"}${d.refusal ? ` · ${esc(d.refusal)}` : ""}${d.detail ? ` · ${esc(d.detail)}` : ""}</div></div>`;
  if (d.txs.length) html += `<h3>Transactions</h3><div class="kv">${d.txs.map((t) => `<div class="k">${esc(t.step)} ${esc(t.role)} ${esc(t.xlm)} XLM</div><div class="v">${txLink(t)}</div>`).join("")}</div>`;
  if (d.proposal) html += `<h3>AgentDecision JSON (PRD §8.3, roles only, never addresses)</h3><pre class="json">${pretty(d.proposal)}</pre>`;
  if (d.attestation) html += `<h3>Berthing attestation</h3>${attestationHtml(d.attestation)}`;
  if (d.extra) html += `<h3>Guardrail proof (checkPayment + SDK refusal)</h3><pre class="json">${pretty(d.extra)}</pre>`;
  openModal(`${d.decision} · ${S.invoice.id}`, html);
}

// ---------------- events ----------------
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const a = el.closest("[data-act]");
  if (a && !a.disabled) return void act(a.dataset.act, a.dataset.label);
  const r = el.closest("#roles button");
  if (r) {
    role = r.dataset.role;
    try { localStorage.setItem("role", role); } catch { /* private mode */ }
    return render();
  }
  if (el.closest("a")) return;
  const d = el.closest("[data-dec]");
  if (d) return openDecision(d.dataset.dec);
  if (el.closest('[data-open="attestation"]') && S?.attestation) return openModal("Proof of delivery", attestationHtml(S.attestation));
});
document.addEventListener("keydown", (e) => {
  const d = e.target instanceof Element ? e.target.closest("[data-dec]") : null;
  if (d && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openDecision(d.dataset.dec);
  }
});
$("#ops-toggle").addEventListener("click", () => {
  const o = $("#ops");
  o.classList.toggle("collapsed");
  $("#ops-toggle").setAttribute("aria-expanded", String(!o.classList.contains("collapsed")));
  document.body.style.paddingBottom = o.classList.contains("collapsed") ? "60px" : "";
});

if (window.matchMedia("(max-width: 800px)").matches) {
  $("#ops").classList.add("collapsed");
  $("#ops-toggle").setAttribute("aria-expanded", "false");
  document.body.style.paddingBottom = "60px";
}
connect();
