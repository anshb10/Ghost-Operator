const $ = (s) => document.querySelector(s);
// Everything scraped from vendor sites is untrusted: always escape before rendering.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
const usd = (n, d = 0) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const EXAMPLES = [
  ["50 office laptops", $("#objective").value],
  ["Lab gloves", "Our lab needs 40 cases of powder-free nitrile exam gloves (ASTM D6319), at least 4 mil thick. Budget around $7,000. Compare suppliers and flag shelf-life or return-policy risks."],
  ["Dev team laptops", "Buy 12 developer laptops with 32GB RAM and 1TB SSD, Windows 11 Pro, onsite warranty required. Budget $30k."],
];
const ATTRS = {
  laptops: ["ram_gb", "storage_gb", "cpu_tier", "display_in", "os", "cpu", "warranty_years", "warranty_onsite"],
  lab_supplies: ["count_per_case", "thickness_mil", "powder_free", "certifications", "warranty_years"],
};
const LABELS = {
  ram_gb: "RAM (GB)", storage_gb: "Storage (GB)", cpu_tier: "CPU tier (1–4)", display_in: "Screen size (in)", os: "Operating system",
  cpu: "Processor", warranty_years: "Warranty (years)", warranty_onsite: "Onsite warranty (1 = yes)", count_per_case: "Count per case",
  thickness_mil: "Thickness (mil)", powder_free: "Powder-free", certifications: "Certifications",
};
const OPS = { ">=": "at least", "<=": "at most", "==": "equals", contains: "contains" };
const STAGE_NAMES = ["Ready", "Planning", "Discovering", "Browsing", "Verifying", "Deciding", "Complete"];
const VSTATUS = {
  verified: ["✓ Verified on page", "Price and specs match the vendor's product page."],
  partial: ["◐ Specs verified", "Specs match the product page; the price is rendered client-side and couldn't be read."],
  mismatch: ["✕ Page disagrees", "The vendor's product page contradicts what the agent extracted."],
  unverified: ["○ Not checked", "The product page couldn't be read."],
};
const FIELD = { price: "Price", ram_gb: "RAM (GB)", storage_gb: "Storage (GB)", thickness_mil: "Thickness (mil)", warranty: "Warranty", stock: "Stock", quantity: "Order quantity" };
const TILE_COLORS = ["#2f4bd8", "#0f1733", "#12805c", "#b0611c", "#7a3fd1", "#c23b2a", "#0e7490", "#8a5a06"];
const ICONS = {
  normalize: '<path d="M4 7h16M4 12h10M4 17h6"/>',
  verify: '<path d="M12 3.5 5 6.5v5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9v-5z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  match: '<circle cx="8" cy="12" r="4"/><circle cx="16" cy="12" r="4"/>',
  price: '<path d="M20 12 12 20l-8-8V4h8z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  risk: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17v.5"/>',
  rank: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  family: '<path d="M7 7h10M7 7l3-3M7 7l3 3M17 17H7m10 0-3-3m3 3-3 3"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ""}</svg>`;
const ML_STEPS = [
  ["normalize", "Normalize", "Canonical specs"],
  ["verify", "Verify", "TinyFish Fetch re-reads pages"],
  ["match", "Match", "Same products across vendors"],
  ["price", "Fair price", "Ridge regression + anomalies"],
  ["risk", "Warranty risk", "Clause classifier"],
  ["rank", "Rank", "Fit · lifetime cost · trust"],
];

let INFO = null, PLAN = null, MISSION = null;
const clocks = {};

/* Company logo from the vendor's domain (favicon service); the coloured initial stays underneath as a fallback. */
function tile(name, url = "") {
  const n = String(name || "?").replace(/^www\./, "");
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const domain = (host(url) || (/\./.test(n) ? n : "")).split(".").slice(-2).join(".");
  const logo = domain ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128" alt="" loading="lazy" onerror="this.parentNode.classList.remove('logo');this.remove()">` : "";
  return `<span class="mono-tile ${logo ? "logo" : ""}" style="--tile:${TILE_COLORS[h % TILE_COLORS.length]}"><b>${esc(n[0].toUpperCase())}</b>${logo}</span>`;
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

/* stage = index into the 5-step pipeline (1..5); 6 = all done */
function setStage(n) {
  document.querySelectorAll("#stages span").forEach((s, i) => { s.className = i + 1 < n ? "done" : i + 1 === n ? "active" : ""; });
  document.querySelectorAll("#pipe li").forEach((li, i) => { li.className = i + 1 < n ? "done" : i + 1 === n ? "active" : ""; });
  $("#stage-label").textContent = STAGE_NAMES[Math.min(n, 6)];
}

function countUp(el) {
  const target = parseFloat(el.dataset.count), prefix = el.dataset.prefix || "", suffix = el.dataset.suffix || "";
  const fmt = (v) => prefix + Math.round(v).toLocaleString("en-US") + suffix;
  if (REDUCED || !isFinite(target)) { el.textContent = fmt(target || 0); return; }
  const t0 = performance.now();
  const tick = (t) => { const k = Math.min(1, (t - t0) / 900); el.textContent = fmt(target * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

async function init() {
  INFO = await api("/api/info");
  const m = $("#mode");
  m.className = "status " + INFO.mode;
  m.innerHTML = `<i></i>${INFO.mode === "live" ? "Live · TinyFish" : "Replay · recorded runs"}`;
  $("#pipe-mode").textContent = INFO.mode === "live" ? "live" : "replay";
  $("#examples").innerHTML = EXAMPLES.map((e, i) => `<button class="chip" data-i="${i}">${esc(e[0])}</button>`).join("");
  $("#examples").onclick = (ev) => { const i = ev.target.dataset.i; if (i != null) $("#objective").value = EXAMPLES[i][1]; };
  $("#btn-plan").onclick = plan;
  $("#btn-run").onclick = dispatch;
  $("#btn-addc").onclick = () => { PLAN.requirements.constraints.push({ attribute: ATTRS[PLAN.requirements.domain][0], op: ">=", value: 0, hard: false, weight: 1 }); renderCons(); };
  $("#btn-approve").onclick = () => decide("approve");
  $("#btn-reject").onclick = () => decide("reject");
  setStage(1); $("#stage-label").textContent = "Ready";
}

/* ── plan ─────────────────────────────────────────────── */
async function plan() {
  const b = $("#btn-plan"); b.disabled = true; b.classList.add("busy"); b.innerHTML = "Planning &amp; searching the web";
  setStage(1);
  try {
    PLAN = await api("/api/plan", { method: "POST", body: JSON.stringify({ objective: $("#objective").value }) });
    const r = PLAN.requirements;
    $("#planner-used").textContent = "Planned by " + PLAN.planner;
    $("#r-item").value = r.item; $("#r-qty").value = r.quantity; $("#r-budget").value = r.budget_total_usd ?? "";
    $("#r-notes").textContent = r.notes || "";
    renderCons();
    renderVendors();
    ["#s-agents", "#s-ml", "#s-report"].forEach(hide);
    show("#s-plan"); setStage(3); $("#stage-label").textContent = "Ready to browse";
    $("#s-plan").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
  } catch (e) { alert("Planning failed: " + e.message); setStage(1); }
  b.disabled = false; b.classList.remove("busy"); b.innerHTML = 'Plan mission <span class="arrow">→</span>';
}

function renderCons() {
  const attrs = ATTRS[PLAN.requirements.domain] || [];
  $("#cons").innerHTML = PLAN.requirements.constraints.map((c, i) => `<tr data-i="${i}">
    <td><select data-k="attribute">${[...new Set([...attrs, c.attribute])].map((a) => `<option value="${esc(a)}" ${a === c.attribute ? "selected" : ""}>${esc(LABELS[a] || a)}</option>`).join("")}</select></td>
    <td><select data-k="op">${Object.entries(OPS).map(([o, l]) => `<option value="${o}" ${o === c.op ? "selected" : ""}>${l}</option>`).join("")}</select></td>
    <td><input data-k="value" value="${esc(c.value)}"></td>
    <td class="c"><label class="switch"><input type="checkbox" data-k="hard" ${c.hard ? "checked" : ""}><i></i></label></td>
    <td><input data-k="weight" type="number" step="0.5" min="0" max="3" value="${esc(c.weight)}" style="width:70px"></td>
    <td><button class="del" data-del="${i}" title="Remove" aria-label="Remove">✕</button></td></tr>`).join("");
  $("#cons").onchange = (ev) => {
    const tr = ev.target.closest("tr"), k = ev.target.dataset.k, c = PLAN.requirements.constraints[tr.dataset.i];
    if (k === "hard") c.hard = ev.target.checked;
    else if (k === "weight") c.weight = parseFloat(ev.target.value) || 0;
    else if (k === "value") c.value = ev.target.value !== "" && !isNaN(ev.target.value) ? parseFloat(ev.target.value) : ev.target.value;
    else c[k] = ev.target.value;
  };
  $("#cons").onclick = (ev) => { if (ev.target.dataset.del != null) { PLAN.requirements.constraints.splice(+ev.target.dataset.del, 1); renderCons(); } };
}

function renderVendors() {
  const disc = PLAN.discovery || { vendors: [] };
  $("#search-q").textContent = disc.query ? `“${disc.query}” · ${disc.n_results} results → ${disc.vendors.length} stores` : (disc.error ? "Search unavailable" : "No search run");
  const row = (v, kind, i) => {
    const ok = v.recorded !== false;
    const tag = !ok ? '<span class="tag na">live only</span>' : kind === "found" ? '<span class="tag found">Found by Search</span>' : '<span class="tag known">Known</span>';
    return `<label class="vrow ${ok ? "" : "off"}" title="${esc(v.snippet || "")}">${tile(v.name, v.url)}
      <span><div class="vname">${esc(v.name.replace(/^www\./, ""))}</div><div class="vdom">${esc(host(v.url))}</div></span>${tag}
      <span class="switch"><input type="checkbox" data-kind="${kind}" data-i="${i}" ${ok ? "checked" : "disabled"}><i></i></span></label>`;
  };
  $("#vendors").innerHTML = `<div class="vgroup">Known vendors</div>` + PLAN.vendors.map((v, i) => row(v, "known", i)).join("")
    + (disc.vendors.length ? `<div class="vgroup">Found on the live web</div>` + disc.vendors.map((v, i) => row(v, "found", i)).join("") : "");
  const count = () => { $("#vendor-count").textContent = `${document.querySelectorAll("#vendors input:checked").length} selected`; };
  $("#vendors").onchange = count; count();
}

async function dispatch() {
  const r = PLAN.requirements;
  r.item = $("#r-item").value; r.quantity = parseInt($("#r-qty").value, 10) || 1;
  r.budget_total_usd = $("#r-budget").value ? parseFloat($("#r-budget").value) : null;
  r.max_unit_price_usd = r.budget_total_usd ? Math.round((r.budget_total_usd / r.quantity) * 100) / 100 : null;
  const picked = [...document.querySelectorAll("#vendors input:checked")];
  const vendor_keys = picked.filter((i) => i.dataset.kind === "known").map((i) => PLAN.vendors[+i.dataset.i].key);
  const extra_vendors = picked.filter((i) => i.dataset.kind === "found").map((i) => {
    const v = PLAN.discovery.vendors[+i.dataset.i]; return { key: v.key, name: v.name.replace(/^www\./, ""), url: v.url, hint: v.hint || "" };
  });
  if (!picked.length) { alert("Pick at least one vendor."); return; }
  const b = $("#btn-run"); b.disabled = true; b.classList.add("busy");
  try {
    const { id } = await api("/api/missions", { method: "POST", body: JSON.stringify({ objective: $("#objective").value, requirements: r, vendor_keys, extra_vendors, planner: PLAN.planner }) });
    MISSION = await api(`/api/missions/${id}`);
    ["#s-ml", "#s-report"].forEach(hide);
    renderAgents(); renderMlFlow(); show("#s-agents"); setStage(3);
    $("#s-agents").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
    listen(id);
  } catch (e) { alert("Could not start: " + e.message); }
  b.disabled = false; b.classList.remove("busy");
}

/* ── agents ───────────────────────────────────────────── */
function renderAgents() {
  $("#agents-sub").textContent = INFO.mode === "live" ? `TinyFish Web Agents · ${INFO.concurrency} at a time · live browser view` : "Replaying recorded TinyFish runs, sped up";
  $("#agents").innerHTML = Object.entries(MISSION.agents).map(([k, v], i) => `
    <article class="win ${esc(v.status)}" id="ag-${esc(k)}" style="animation-delay:${i * 70}ms">
      <div class="chrome"><span class="lights"><i></i><i></i><i></i></span>
        <span class="url"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>${esc(host(v.url))}</span>
        <span class="st ${esc(v.status)}">${esc(v.status)}</span></div>
      <div class="viewport"><div class="skeleton"><span class="bar"></span><span class="tiles"><i></i><i></i><i></i><i></i><i></i><i></i></span></div>
        <span class="cursor"></span><div class="done-mark"><div><b class="n">0</b>offers extracted</div></div></div>
      <ol class="log"></ol>
      <div class="win-ft"><span>${esc(v.vendor)}</span><span class="clk">0:00</span></div>
    </article>`).join("");
}

function updateAgent(ev) {
  const el = $(`#ag-${CSS.escape(ev.vendor)}`); if (!el) return;
  const log = el.querySelector(".log");
  if (ev.kind === "agent_step") {
    const li = document.createElement("li"); li.textContent = ev.message; log.appendChild(li); log.scrollTop = log.scrollHeight; return;
  }
  el.className = "win " + ev.status;
  const st = el.querySelector(".st"); st.className = "st " + ev.status;
  st.textContent = ev.status === "done" ? "done" : ev.status;
  if (ev.status === "running" && !clocks[ev.vendor]) {
    const t0 = Date.now(), clk = el.querySelector(".clk");
    clocks[ev.vendor] = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); clk.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 500);
  }
  if (ev.stream_url && /^https:\/\//.test(ev.stream_url) && !el.querySelector("iframe")) {
    el.querySelector(".viewport").insertAdjacentHTML("beforeend", `<iframe src="${esc(ev.stream_url)}" title="Live browser" sandbox="allow-scripts allow-same-origin"></iframe>`);
  }
  if (ev.status === "done" || ev.status === "failed") {
    clearInterval(clocks[ev.vendor]); delete clocks[ev.vendor];
    el.querySelector("iframe")?.remove();
    if (ev.status === "done") el.querySelector(".done-mark .n").textContent = ev.n_offers ?? 0;
    if (ev.error) { const li = document.createElement("li"); li.className = "err"; li.textContent = ev.error; log.appendChild(li); }
  }
}

/* ── analysis ─────────────────────────────────────────── */
function renderMlFlow() {
  $("#mlflow").innerHTML = ML_STEPS.map(([k, t, d]) => `<div class="mlnode ${k}" id="ml-${k}"><span class="ic">${icon(k)}</span><h4>${t}</h4><p>${d}</p></div>`).join("");
}

function updateMl(ev) {
  if ($("#s-ml").classList.contains("hidden")) { show("#s-ml"); }
  setStage(ev.step === "verify" ? 4 : 5);
  const node = $(`#ml-${CSS.escape(ev.step)}`); if (!node) return;
  node.classList.add("on");
  node.querySelector("p").textContent = shortMl(ev);
}
function shortMl(ev) {
  const s = ev.summary;
  if (ev.step === "verify" && s) return `${s.pages_fetched} pages re-read · ${s.verified} confirmed · ${s.mismatch} disagree${s.corrections ? ` · ${s.corrections} fixed` : ""}`;
  return ev.message.replace(/^[^:]+:\s*/, "").replace(/\(.*?\)/g, "").trim();
}

function listen(id) {
  const es = new EventSource(`/api/missions/${id}/events`);
  es.onmessage = async (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.kind === "agent" || ev.kind === "agent_step") updateAgent(ev);
    else if (ev.kind === "ml" || ev.kind === "verify") updateMl(ev);
    else if (ev.kind === "report") { MISSION = await api(`/api/missions/${id}`); renderReport(); }
    else if (ev.kind === "status" && ev.status === "failed") alert("Mission failed: " + ev.error);
  };
  es.addEventListener("end", () => es.close());
}

/* ── decision brief ───────────────────────────────────── */
const unitOf = (o) => o.effective_unit_price || o.unit_price;

function renderReport() {
  const rep = MISSION.report, req = MISSION.requirements, offers = rep.offers;
  const best = offers.find((o) => o.id === rep.recommended_offer_id);
  setStage(5); $("#stage-label").textContent = "Awaiting approval";
  $("#summary-by").textContent = rep.summary_by === "claude" ? "Memo drafted by Claude" : "Memo drafted from the ranked evidence";
  $("#memo").textContent = rep.summary;
  $("#po-link").href = `/missions/${MISSION.id}/po`;

  if (best) {
    const a = best.attributes || {};
    const specs = [
      a.ram_gb && `${a.ram_gb} GB RAM`, a.storage_gb && `${a.storage_gb >= 1024 ? a.storage_gb / 1024 + " TB" : a.storage_gb + " GB"} SSD`,
      a.thickness_mil && `${a.thickness_mil} mil`, a.count_per_case && `${a.count_per_case}/case`, a.os,
    ].filter(Boolean).map((s) => `<span class="spec">${esc(s)}</span>`);
    specs.push(`<span class="spec ${best.warranty.service === "onsite" ? "ok" : "warn"}">${esc(best.warranty.raw || "Warranty not stated")}</span>`);
    if (best.verification?.status === "verified") specs.unshift(`<span class="spec ok">✓ Verified on vendor page</span>`);
    $("#pick").innerHTML = `
      <div class="pick-top">${tile(best.vendor, best.url)}<div><div class="pick-label">Recommended</div><div class="pick-vendor">${esc(best.vendor)}${best.sku ? " · " + esc(best.sku) : ""} · ${esc(best.stock || "stock n/a")}</div></div></div>
      <h3><a class="pname" href="${safeUrl(best.url)}" target="_blank" rel="noopener noreferrer">${esc(best.name)}</a></h3>
      <div class="specs">${specs.join("")}</div>
      <div class="pick-price"><span class="big">${usd(unitOf(best))}</span><span class="unit">per unit</span>
        <span class="total">${req.quantity} units<b>${usd(unitOf(best) * req.quantity)}</b></span></div>`;
    const vs = rep.insights.verification || {};
    const checked = (vs.verified || 0) + (vs.mismatch || 0) + (vs.partial || 0) + (vs.unverified || 0);
    const headroom = req.budget_total_usd ? req.budget_total_usd - unitOf(best) * req.quantity : null;
    $("#kpis").innerHTML = [
      ["var(--brand)", "Purchase total", `<span data-count="${unitOf(best) * req.quantity}" data-prefix="$">$0</span>`, `${req.quantity} × ${usd(unitOf(best))}`],
      ["var(--navy)", "Lifetime cost", `<span data-count="${best.tco}" data-prefix="$">$0</span>`, "incl. expected repairs & downtime"],
      ["var(--ok)", "Budget headroom", headroom == null ? "—" : `<span data-count="${Math.abs(headroom)}" data-prefix="${headroom < 0 ? "−$" : "$"}">$0</span>`,
        headroom == null ? "No budget set" : `<span class="s ${headroom >= 0 ? "ok" : "bad"}">${headroom >= 0 ? "within" : "over"} ${usd(req.budget_total_usd)}</span>`],
      ["var(--gold)", "Source-checked", `<span data-count="${vs.verified || 0}">0</span><span style="color:var(--faint);font-size:18px"> / ${checked}</span>`,
        `<div class="meter"><i style="width:${checked ? Math.round(((vs.verified || 0) / checked) * 100) : 0}%;background:var(--ok)"></i></div>`],
    ].map(([c, l, v, s]) => `<div class="card kpi"><div class="l"><i style="background:${c}"></i>${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
    document.querySelectorAll("#kpis [data-count]").forEach(countUp);
    $("#decide-what").textContent = `${req.quantity} × ${best.name.length > 60 ? best.name.slice(0, 58) + "…" : best.name} · ${usd(unitOf(best) * req.quantity)}`;
  } else {
    $("#pick").innerHTML = `<div class="pick-label">No recommendation</div><h3>No option met every must-have.</h3><p class="notes">See the excluded offers below and loosen a requirement or add vendors.</p>`;
    $("#kpis").innerHTML = "";
    $("#decide-what").textContent = "Nothing to approve";
  }

  const ins = [];
  const vs = rep.insights.verification;
  if (vs) ins.push(["verify", "Checked against the source", `TinyFish Fetch re-read <b>${vs.pages_fetched} product pages</b>: ${vs.verified} confirmed, ${vs.mismatch} disagreed${vs.corrections ? `, ${vs.corrections} correction${vs.corrections > 1 ? "s" : ""} applied` : ""}.`]);
  (rep.insights.families || []).slice(0, 2).forEach((f) => {
    const nm = f.cheaper.name.length > 44 ? f.cheaper.name.slice(0, 42) + "…" : f.cheaper.name;
    const better = f.cheaper_has_better.length ? ` and has better ${f.cheaper_has_better.join(", ").replace(/_gb|_tier/g, "")}` : "";
    const worse = f.cheaper_has_worse.length ? `, but lower ${f.cheaper_has_worse.join(", ").replace(/_gb|_tier/g, "")}` : "";
    ins.push(["family", "Same model, other vendor", `<b>${esc(nm)}</b> is ${Math.round(f.saving_pct * 100)}% cheaper at ${esc(f.cheaper.vendor)} than at ${esc(f.pricier.vendor)}${better}${worse}.`]);
  });
  (rep.insights.cross_vendor || []).forEach((d) => ins.push(["same", "Identical product", `${esc(d.name)}: ${usd(d.best_price)} at ${esc(d.best_vendor)} vs ${usd(d.worst_price)} at ${esc(d.worst_vendor)}.`]));
  $("#insights").innerHTML = ins.map(([k, t, b], i) => `<div class="card insight ${k}" style="animation-delay:${i * 70}ms"><span class="ii">${icon(k === "same" ? "match" : k)}</span><div><span class="k">${t}</span>${b}</div></div>`).join("");

  renderTable(rep, offers);
  renderDecision();
  show("#s-report");
  $("#s-report").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
}

function renderTable(rep, offers) {
  const eligible = offers.filter((o) => o.rank).length;
  $("#offers-meta").textContent = `${offers.length} offers · ${eligible} eligible · ${offers.length - eligible} excluded`;
  $("#price-note").textContent = rep.insights.price_model?.method
    ? `“vs fair” compares each price with a model fit on ${rep.insights.price_model.n} comparable offers (${rep.insights.price_model.method}). Lifetime cost adds expected out-of-warranty repairs and downtime. Score weighs fit, lifetime cost, warranty risk, price sanity and source trust.` : "";
  const firstExcluded = offers.findIndex((o) => !o.rank);
  $("#offers").innerHTML = offers.map((o, idx) => {
    const riskColor = o.warranty_risk > 0.6 ? "var(--bad)" : o.warranty_risk > 0.35 ? "var(--warn)" : "var(--ok)";
    const d = o.price_delta_pct;
    const delta = d == null ? "—" : `<span class="delta ${d <= -0.05 ? "neg" : d >= 0.05 ? "pos" : "neu"}">${d > 0 ? "+" : ""}${Math.round(d * 100)}%</span>`;
    const isBest = o.id === rep.recommended_offer_id;
    const flags = [
      isBest ? '<span class="flag rec">Recommended</span>' : "",
      o.id === rep.value_pick_id ? '<span class="flag quote">Ask for quote</span>' : "",
      o.price_flag ? `<span class="flag ${o.price_flag}">${o.price_flag}</span>` : "",
      o.condition !== "new" && o.condition !== "unknown" ? `<span class="flag bad">${esc(o.condition)}</span>` : "",
      /backorder|out of stock|sold out/i.test(o.stock) ? `<span class="flag warn">${esc(o.stock)}</span>` : "",
      ...o.failed_constraints.map((f) => `<span class="flag ${f.startsWith("unverified") ? "warn" : "bad"}">${esc(f)}</span>`),
    ].join("");
    const v = o.verification?.status;
    const sep = idx === firstExcluded ? `<tr class="excluded-hd"><td colspan="9">Excluded · did not meet a must-have</td></tr>` : "";
    return `${sep}<tr class="row ${isBest ? "best" : ""} ${o.rank ? "" : "excluded"}" style="animation-delay:${Math.min(idx, 14) * 40}ms">
      <td class="rk">${o.rank ?? "–"}</td>
      <td><div class="pcell">${tile(o.vendor, o.url)}<div><a class="pname" href="${safeUrl(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.name)}</a>
        <div class="pvendor">${esc(o.vendor)}${o.sku ? " · " + esc(o.sku) : ""}</div><div class="flags">${flags}</div></div></div></td>
      <td class="num">${usd(o.unit_price, 2)}${o.effective_unit_price ? `<div class="eff">≈ ${usd(o.effective_unit_price)} avg (capped promo)</div>` : ""}
        ${v ? `<div class="vb ${esc(v)}" title="${esc(VSTATUS[v]?.[1] || "")}">${VSTATUS[v]?.[0] || ""}</div>` : ""}</td>
      <td class="num">${delta}</td>
      <td><div class="mini"><div class="meter"><i style="width:${Math.round(o.fit_score * 100)}%"></i></div><span>${Math.round(o.fit_score * 100)}%</span></div></td>
      <td><div class="wtxt">${esc(o.warranty.raw || "not stated")}</div><div class="meter" style="width:90px" title="warranty risk ${o.warranty_risk}"><i style="width:${Math.max(4, o.warranty_risk * 100)}%;background:${riskColor}"></i></div></td>
      <td class="num">${usd(o.tco)}</td>
      <td class="num"><span class="score">${o.rank ? Math.round(o.score) : "–"}</span></td>
      <td><button class="btn btn-link" data-id="${esc(o.id)}">Why</button></td></tr>
      <tr class="details hidden" id="d-${esc(o.id)}"><td colspan="9"><div class="cols"><div>
        ${verifyHtml(o)}
        <h5>Warranty risk</h5><ul>${o.warranty_risk_reasons.map((r) => `<li>${esc(r)}</li>`).join("") || "<li>None flagged</li>"}</ul>
        ${o.anomaly ? `<h5>Price check</h5><ul><li>${esc(o.anomaly)}</li></ul>` : ""}
        <h5>Lifetime cost</h5><ul>${Object.entries(o.tco_breakdown).map(([k, val]) => `<li>${esc(k.replace(/_/g, " "))}: ${usd(val)}</li>`).join("")}</ul>
      </div><div><h5>Evidence from the agent</h5><pre>${esc(JSON.stringify(o.evidence, null, 1))}</pre></div></div></td></tr>`;
  }).join("");
  $("#offers").onclick = (ev) => { const id = ev.target.dataset.id; if (id) $(`#d-${CSS.escape(id)}`).classList.toggle("hidden"); };
}

function verifyHtml(o) {
  const v = o.verification || {};
  if (!v.status) return "";
  const fmt = (f, x) => {
    const one = (a) => (f === "price" && typeof a === "number" ? usd(a, 2) : esc(a ?? "—"));
    return Array.isArray(x) ? x.map(one).join(" / ") : one(x);
  };
  const rows = (v.checks || []).map((c) => `<li class="${c.ok === false ? "bad" : c.ok ? "ok" : ""}">${FIELD[c.field] || esc(c.field)}: ${c.ok === null ? "couldn't read on page" : c.ok ? "matches page" : `${c.field === "quantity" ? "you need" : "agent said"} ${fmt(c.field, c.claimed)}, page says ${fmt(c.field, c.page)}`}</li>`).join("");
  const fixes = (v.corrections || []).map((c) => `<li>${esc(c)}</li>`).join("");
  return `<h5>TinyFish Fetch verification · ${esc(VSTATUS[v.status]?.[0] || v.status)}</h5>
    <ul class="checks">${rows || `<li>${esc(v.note || "No checkable fields")}</li>`}</ul>
    ${v.source_url ? `<p class="src">Source: <a href="${safeUrl(v.source_url)}" target="_blank" rel="noopener noreferrer">${esc(host(v.source_url))}</a></p>` : ""}
    ${fixes ? `<h5>Corrections applied</h5><ul>${fixes}</ul>` : ""}`;
}

function renderDecision() {
  const d = MISSION.decision, bar = $("#decision");
  if (!d) { bar.className = "decide"; return; }
  setStage(6);
  bar.className = "decide " + (d.decision === "approve" ? "approved" : "rejected");
  bar.innerHTML = d.decision === "approve"
    ? `<div class="what"><small style="color:#fff">Approved</small><span>Signed off by ${esc(d.approver || "buyer")}</span></div><a class="btn btn-gold" target="_blank" href="/missions/${MISSION.id}/po">Open purchase order →</a>`
    : `<div class="what"><small>Rejected</small><span>No purchase order issued.</span></div>`;
}

async function decide(decision) {
  try {
    MISSION = await api(`/api/missions/${MISSION.id}/decision`, { method: "POST", body: JSON.stringify({ decision, approver: $("#approver").value }) });
    renderDecision();
  } catch (e) { alert("Could not record decision: " + e.message); }
}

const show = (s) => $(s).classList.remove("hidden");
const hide = (s) => $(s).classList.add("hidden");
init();
