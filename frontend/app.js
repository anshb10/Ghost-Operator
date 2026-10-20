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

const WEIGHT_LABELS = {
  fit: ["Requirement fit", "Specs match what you asked for"],
  value: ["Lifetime cost", "Cheaper to buy and own"],
  risk: ["Warranty risk", "Safer coverage and service"],
  anomaly: ["Price sanity", "Penalise suspicious prices"],
  trust: ["Source trust", "Confirmed on the vendor's page"],
};
const BETTER = { ram_gb: "max", storage_gb: "max", cpu_tier: "max", warranty_years: "max", thickness_mil: "max" };
const STATUS_LABEL = { awaiting_approval: "Awaiting approval", approved: "Approved", rejected: "Rejected", failed: "Failed", browsing: "Running", analyzing: "Analyzing" };

let INFO = null, PLAN = null, MISSION = null, ES = null;
let HISTORY = [], HISTORY_ALL = false;
let SELECTED = null;  // offer id the buyer will approve (defaults to the recommendation)
let WHATIF = null;    // /rerank result while the weight sliders are off their defaults
const COMPARE = new Set();
const clocks = {};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 2) + "…" : s);
const fmtDate = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
  $("#btn-compare").onclick = openCompare;
  $("#btn-history-all").onclick = () => { HISTORY_ALL = !HISTORY_ALL; renderHistory(); };
  $("#history").onclick = (ev) => { const b = ev.target.closest("[data-mid]"); if (b) openMission(b.dataset.mid); };
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (ev) => {
    if (ev.target === d || ev.target.closest("[data-close]")) d.close();  // backdrop or ✕
  }));
  $("#q-subject").oninput = $("#q-body").oninput = updateMailto;
  $("#q-copy").onclick = copyQuote;
  $("#memo-act").onclick = (ev) => { const b = ev.target.closest("[data-act=quote]"); if (b) openQuote(b.dataset.oid); };
  renderSliders();
  setStage(1); $("#stage-label").textContent = "Ready";
  await loadHistory();
  const linked = location.hash.match(/^#m=([a-z0-9]+)$/i);
  if (linked) openMission(linked[1]);
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
    history.replaceState(null, "", `#m=${id}`);
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
  ES?.close();  // only ever follow the mission on screen
  const es = ES = new EventSource(`/api/missions/${id}/events`);
  es.onmessage = async (msg) => {
    if (MISSION?.id !== id) { es.close(); return; }
    const ev = JSON.parse(msg.data);
    if (ev.kind === "agent" || ev.kind === "agent_step") updateAgent(ev);
    else if (ev.kind === "ml" || ev.kind === "verify") updateMl(ev);
    else if (ev.kind === "report") { MISSION = await api(`/api/missions/${id}`); renderReport(); loadHistory(); }
    else if (ev.kind === "status" && ev.status === "failed") { alert("Mission failed: " + ev.error); loadHistory(); }
  };
  es.addEventListener("end", () => es.close());
}

/* ── mission history ──────────────────────────────────── */
async function loadHistory() {
  try { HISTORY = await api("/api/missions"); } catch { HISTORY = []; }
  renderHistory();
}

function renderHistory() {
  if (!HISTORY.length) { hide("#s-history"); return; }
  const n = HISTORY.length, list = HISTORY_ALL ? HISTORY : HISTORY.slice(0, 6);
  $("#history-sub").textContent = `${n} saved · reopen any decision brief`;
  $("#btn-history-all").textContent = HISTORY_ALL ? "Show fewer" : `Show all ${n}`;
  $("#btn-history-all").classList.toggle("hidden", n <= 6);
  $("#history").innerHTML = list.map((h) => `
    <button class="card hcard ${MISSION?.id === h.id ? "current" : ""}" data-mid="${esc(h.id)}">
      <div class="h-top">${h.pick ? tile(h.pick.vendor, h.pick.url) : tile(h.item)}
        <div><div class="h-item">${esc(h.quantity)} × ${esc(h.item)}</div><div class="h-date">${esc(fmtDate(h.created))} · ${esc(h.mode)}</div></div>
        <span class="hst ${esc(h.status)}">${esc(STATUS_LABEL[h.status] || h.status)}</span></div>
      <div class="h-pick">${h.pick ? `<b>${esc(trunc(h.pick.name, 70))}</b><span>${esc(h.pick.vendor)} · ${usd(h.pick.total)}${h.approver ? ` · signed by ${esc(h.approver)}` : ""}</span>`
        : `<span>${h.n_offers ? "No offer met every must-have" : "No report yet"}</span>`}</div>
    </button>`).join("");
  show("#s-history");
}

async function openMission(id) {
  try { MISSION = await api(`/api/missions/${encodeURIComponent(id)}`); }
  catch (e) { history.replaceState(null, "", location.pathname); alert("Could not open mission " + id); return; }
  history.replaceState(null, "", `#m=${MISSION.id}`);
  $("#objective").value = MISSION.objective;
  ["#s-plan", "#s-agents", "#s-ml", "#s-report"].forEach(hide);
  if (MISSION.report) renderReport();
  else if (MISSION.status === "browsing" || MISSION.status === "analyzing") {
    renderAgents(); renderMlFlow(); show("#s-agents"); setStage(3); listen(MISSION.id);
    $("#s-agents").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
  } else alert(`Mission ${MISSION.id} has no decision brief (status: ${MISSION.status}).`);
  renderHistory();
}

/* ── decision brief ───────────────────────────────────── */
const unitOf = (o) => o.effective_unit_price || o.unit_price;
const offerById = (id) => MISSION.report.offers.find((o) => o.id === id);

function renderReport() {
  const rep = MISSION.report, req = MISSION.requirements, offers = rep.offers;
  const best = offers.find((o) => o.id === rep.recommended_offer_id);
  SELECTED = MISSION.decision?.offer_id || rep.recommended_offer_id;
  WHATIF = null; COMPARE.clear();
  setStage(5); $("#stage-label").textContent = "Awaiting approval";
  $("#summary-by").textContent = rep.summary_by === "claude" ? "Memo drafted by Claude" : "Memo drafted from the ranked evidence";
  $("#memo").textContent = rep.summary;
  $("#csv-link").href = `/api/missions/${MISSION.id}/offers.csv`;
  const valuePick = offers.find((o) => o.id === rep.value_pick_id);
  $("#memo-act").innerHTML = valuePick ? `<button class="btn btn-ghost btn-sm" data-act="quote" data-oid="${esc(valuePick.id)}">Draft quote request to ${esc(valuePick.vendor)}</button>` : "";

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
  } else {
    $("#pick").innerHTML = `<div class="pick-label">No recommendation</div><h3>No option met every must-have.</h3><p class="notes">See the excluded offers below and loosen a requirement or add vendors.</p>`;
    $("#kpis").innerHTML = "";
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

  resetSliders();
  renderWhatif();
  renderTable();
  renderDecision();
  show("#s-report");
  $("#s-report").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
}

/* Offers in display order: the what-if ranking when the sliders are moved, else the mission's own. */
function viewOffers() {
  const offers = MISSION.report.offers;
  if (!WHATIF) return offers;
  const byId = new Map(offers.map((o) => [o.id, o]));
  return WHATIF.offers.map((x) => ({ ...byId.get(x.id), score: x.score, rank: x.rank }));
}

function renderTable() {
  const rep = MISSION.report, offers = viewOffers();
  const origRank = new Map(rep.offers.map((o) => [o.id, o.rank]));
  const valueId = WHATIF ? WHATIF.value_pick_id : rep.value_pick_id;
  const locked = !!MISSION.decision;
  const eligible = offers.filter((o) => o.rank).length;
  $("#offers-meta").textContent = `${offers.length} offers · ${eligible} eligible · ${offers.length - eligible} excluded${WHATIF ? " · what-if ranking" : ""}`;
  $("#price-note").textContent = rep.insights.price_model?.method
    ? `“vs fair” compares each price with a model fit on ${rep.insights.price_model.n} comparable offers (${rep.insights.price_model.method}). Lifetime cost adds expected out-of-warranty repairs and downtime. Score weighs fit, lifetime cost, warranty risk, price sanity and source trust.` : "";
  const firstExcluded = offers.findIndex((o) => !o.rank);
  $("#offers").innerHTML = offers.map((o, idx) => {
    const riskColor = o.warranty_risk > 0.6 ? "var(--bad)" : o.warranty_risk > 0.35 ? "var(--warn)" : "var(--ok)";
    const d = o.price_delta_pct;
    const delta = d == null ? "—" : `<span class="delta ${d <= -0.05 ? "neg" : d >= 0.05 ? "pos" : "neu"}">${d > 0 ? "+" : ""}${Math.round(d * 100)}%</span>`;
    const isBest = o.id === rep.recommended_offer_id;
    const moved = WHATIF && o.rank && origRank.get(o.id) ? origRank.get(o.id) - o.rank : 0;
    const flags = [
      isBest ? '<span class="flag rec">Recommended</span>' : "",
      WHATIF && o.id === WHATIF.recommended_offer_id && !isBest ? '<span class="flag whatif">What-if pick</span>' : "",
      o.id === SELECTED && !isBest ? `<span class="flag mine">${locked ? "Approved instead" : "Your choice"}</span>` : "",
      o.id === valueId ? '<span class="flag quote">Ask for quote</span>' : "",
      o.price_flag ? `<span class="flag ${o.price_flag}">${o.price_flag}</span>` : "",
      o.condition !== "new" && o.condition !== "unknown" ? `<span class="flag bad">${esc(o.condition)}</span>` : "",
      /backorder|out of stock|sold out/i.test(o.stock) ? `<span class="flag warn">${esc(o.stock)}</span>` : "",
      ...o.failed_constraints.map((f) => `<span class="flag ${f.startsWith("unverified") ? "warn" : "bad"}">${esc(f)}</span>`),
    ].join("");
    const v = o.verification?.status;
    const sep = idx === firstExcluded ? `<tr class="excluded-hd"><td colspan="10">Excluded · did not meet a must-have</td></tr>` : "";
    const choose = locked ? "" : o.rank
      ? (o.id === SELECTED ? `<span class="act-note">✓ Selected for approval</span>` : `<button class="btn btn-primary btn-sm" data-act="choose" data-oid="${esc(o.id)}">Choose this offer</button>`)
      : `<span class="act-note">Excluded offers can't be approved</span>`;
    return `${sep}<tr class="row ${isBest ? "best" : ""} ${o.id === SELECTED && !isBest ? "mine" : ""} ${o.rank ? "" : "excluded"}" style="animation-delay:${Math.min(idx, 14) * 40}ms">
      <td class="cmpcol"><input type="checkbox" data-cmp="${esc(o.id)}" ${COMPARE.has(o.id) ? "checked" : ""} aria-label="Compare ${esc(o.name)}"></td>
      <td class="rk">${o.rank ?? "–"}${moved ? `<span class="mv ${moved > 0 ? "up" : "down"}">${moved > 0 ? "▲" : "▼"}${Math.abs(moved)}</span>` : ""}</td>
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
      <tr class="details hidden" id="d-${esc(o.id)}"><td colspan="10">
        <div class="row-acts">${choose}${o.unit_price ? `<button class="btn btn-ghost btn-sm" data-act="quote" data-oid="${esc(o.id)}">Draft quote request</button>` : ""}</div>
        <div class="cols"><div>
        ${verifyHtml(o)}
        <h5>Warranty risk</h5><ul>${o.warranty_risk_reasons.map((r) => `<li>${esc(r)}</li>`).join("") || "<li>None flagged</li>"}</ul>
        ${o.anomaly ? `<h5>Price check</h5><ul><li>${esc(o.anomaly)}</li></ul>` : ""}
        <h5>Lifetime cost</h5><ul>${Object.entries(o.tco_breakdown).map(([k, val]) => `<li>${esc(k.replace(/_/g, " "))}: ${usd(val)}</li>`).join("")}</ul>
      </div><div><h5>Evidence from the agent</h5><pre>${esc(JSON.stringify(o.evidence, null, 1))}</pre></div></div></td></tr>`;
  }).join("");
  $("#offers").onclick = (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.id) $(`#d-${CSS.escape(b.dataset.id)}`).classList.toggle("hidden");
    else if (b.dataset.act === "choose") choose(b.dataset.oid);
    else if (b.dataset.act === "quote") openQuote(b.dataset.oid);
  };
  $("#offers").onchange = (ev) => {
    const id = ev.target.dataset.cmp; if (!id) return;
    if (ev.target.checked) COMPARE.add(id); else COMPARE.delete(id);
    updateCompareUi();
  };
  updateCompareUi();
}

/* Re-render the table but keep any open "Why" panels open. */
function refreshTable() {
  const open = [...document.querySelectorAll("#offers tr.details:not(.hidden)")].map((tr) => tr.id);
  renderTable();
  open.forEach((id) => document.getElementById(id)?.classList.remove("hidden"));
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

/* ── what-if weights ──────────────────────────────────── */
let whatifTimer = null, whatifSeq = 0;
const sliderWeights = () => Object.fromEntries([...document.querySelectorAll("#sliders [data-w]")].map((i) => [i.dataset.w, +i.value]));
const isDefaultWeights = (w) => Object.entries(INFO.weights).every(([k, d]) => Math.abs(w[k] - d * 100) < 0.5);

function renderSliders() {
  $("#sliders").innerHTML = Object.entries(WEIGHT_LABELS).map(([k, [l, h]]) => `
    <label class="slider"><span class="sl-top"><b>${l}</b><output id="w-${k}"></output></span>
      <input type="range" min="0" max="100" step="5" data-w="${k}" aria-label="${l} weight"><small>${h}</small></label>`).join("")
    + `<button class="btn btn-link" id="btn-wreset">Reset</button>`;
  $("#sliders").oninput = (ev) => {
    if (!ev.target.dataset.w) return;
    showWeightShares(); clearTimeout(whatifTimer); whatifTimer = setTimeout(runWhatif, 150);
  };
  $("#btn-wreset").onclick = () => { resetSliders(); runWhatif(); };
  resetSliders();
}

function resetSliders() {
  document.querySelectorAll("#sliders [data-w]").forEach((i) => { i.value = Math.round(INFO.weights[i.dataset.w] * 100); });
  showWeightShares();
}

function showWeightShares() {
  const w = sliderWeights(), total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  Object.entries(w).forEach(([k, v]) => { $(`#w-${k}`).textContent = `${Math.round((v / total) * 100)}%`; });
  $("#btn-wreset").classList.toggle("hidden", isDefaultWeights(w));
}

async function runWhatif() {
  const w = sliderWeights(), seq = ++whatifSeq;
  if (isDefaultWeights(w) || !Object.values(w).some(Boolean)) WHATIF = null;
  else {
    try {
      const res = await api(`/api/missions/${MISSION.id}/rerank`, { method: "POST", body: JSON.stringify({ weights: w }) });
      if (seq !== whatifSeq) return;  // a newer slider move already landed
      WHATIF = res;
    } catch (e) { $("#whatif-out").textContent = "Couldn't re-rank: " + e.message; return; }
  }
  renderWhatif(); refreshTable();
}

function renderWhatif() {
  const rep = MISSION.report, out = $("#whatif-out");
  if (!WHATIF) { out.innerHTML = `<span class="muted">Default weights. These produced the recommendation above.</span>`; return; }
  const orig = new Map(rep.offers.map((o) => [o.id, o.rank]));
  const moved = WHATIF.offers.filter((x) => x.rank && x.rank !== orig.get(x.id)).length;
  const pick = WHATIF.recommended_offer_id && offerById(WHATIF.recommended_offer_id);
  const q = MISSION.requirements.quantity;
  if (!pick) { out.innerHTML = "No eligible offer under these weights."; return; }
  const same = pick.id === rep.recommended_offer_id;
  const btn = !MISSION.decision && pick.id !== SELECTED ? ` <button class="btn btn-primary btn-sm" data-act="choose" data-oid="${esc(pick.id)}">Choose this offer</button>` : "";
  out.innerHTML = (same
    ? `<b>Recommendation unchanged.</b> ${esc(trunc(pick.name, 60))} from ${esc(pick.vendor)} still leads the page-verified, in-stock offers.`
    : `<span class="flag whatif">What-if pick</span> <b>${esc(trunc(pick.name, 60))}</b> from ${esc(pick.vendor)} at ${usd(unitOf(pick))}/unit (${usd(unitOf(pick) * q)} for ${q}).${btn}`)
    + ` <span class="muted">${moved} offer${moved === 1 ? "" : "s"} changed rank.</span>`;
  out.onclick = (ev) => { const b = ev.target.closest("[data-act=choose]"); if (b) choose(b.dataset.oid); };
}

/* ── compare ──────────────────────────────────────────── */
function updateCompareUi() {
  const n = COMPARE.size, b = $("#btn-compare");
  b.disabled = n < 2;
  b.textContent = n ? `Compare ${n}` : "Compare";
  b.title = n < 2 ? "Tick 2 or 3 offers in the table" : "";
  document.querySelectorAll("#offers [data-cmp]").forEach((i) => { i.disabled = !i.checked && n >= 3; });
}

function openCompare() {
  const q = MISSION.requirements.quantity, rep = MISSION.report;
  const list = viewOffers().filter((o) => COMPARE.has(o.id));
  const attrs = [...new Set(list.flatMap((o) => Object.keys(o.attributes || {})))].filter((a) => a !== "warranty_onsite");
  const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
  // [label, render, numeric value for "best" highlighting, which direction wins]
  const rows = [
    ["Rank · score", (o) => (o.rank ? `#${o.rank} · ${Math.round(o.score)}` : "Excluded"), (o) => (o.rank ? o.score : null), "max"],
    ["Unit price", (o) => usd(o.unit_price, 2), (o) => o.unit_price, "min"],
    [`Expected avg for ${q}`, (o) => usd(unitOf(o)) + (o.effective_unit_price ? ' <span class="muted">capped promo</span>' : ""), unitOf, "min"],
    [`Total for ${q}`, (o) => usd(unitOf(o) * q), (o) => unitOf(o) && unitOf(o) * q, "min"],
    ["Lifetime cost", (o) => usd(o.tco), (o) => o.tco, "min"],
    ["vs fair price", (o) => (o.price_delta_pct == null ? "—" : `${o.price_delta_pct > 0 ? "+" : ""}${Math.round(o.price_delta_pct * 100)}%`), (o) => o.price_delta_pct, "min"],
    ["Requirement fit", (o) => pct(o.fit_score), (o) => o.fit_score, "max"],
    ["Warranty", (o) => esc(o.warranty.raw || "not stated")],
    ["Warranty risk", (o) => pct(o.warranty_risk), (o) => o.warranty_risk, "min"],
    ["Verified on page", (o) => esc(VSTATUS[o.verification?.status]?.[0] || "—")],
    ["Stock", (o) => esc(o.stock || "—")],
    ["Seller · condition", (o) => esc(`${o.seller || o.vendor} · ${o.condition}`)],
    ...attrs.map((a) => [LABELS[a] || a, (o) => esc(o.attributes[a] ?? "—"),
      BETTER[a] ? (o) => (typeof o.attributes[a] === "number" ? o.attributes[a] : null) : null, BETTER[a]]),
    ["Failed must-haves", (o) => (o.failed_constraints.length ? o.failed_constraints.map(esc).join("<br>") : "None")],
  ];
  const head = `<tr><th></th>${list.map((o) => `<th><div class="pcell">${tile(o.vendor, o.url)}<div>
    <a class="pname" href="${safeUrl(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.name)}</a>
    <div class="pvendor">${esc(o.vendor)}${o.id === rep.recommended_offer_id ? ' · <span class="flag rec">Recommended</span>' : ""}</div></div></div></th>`).join("")}</tr>`;
  const body = rows.map(([label, render, val, dir]) => {
    const nums = val ? list.map(val) : [];
    const valid = nums.filter((x) => x != null && isFinite(x));
    const win = valid.length >= 2 && new Set(valid).size > 1 ? (dir === "max" ? Math.max(...valid) : Math.min(...valid)) : null;
    return `<tr><th scope="row">${esc(label)}</th>${list.map((o, i) => `<td class="${win != null && nums[i] === win ? "top" : ""}">${render(o)}</td>`).join("")}</tr>`;
  }).join("");
  const acts = MISSION.decision ? "" : `<tr><th></th>${list.map((o) => `<td>${o.rank && o.id !== SELECTED
    ? `<button class="btn btn-primary btn-sm" data-act="choose" data-oid="${esc(o.id)}">Choose this offer</button>`
    : o.id === SELECTED ? '<span class="act-note">✓ Selected</span>' : ""}</td>`).join("")}</tr>`;
  $("#cmp-body").innerHTML = `<table class="cmp"><thead>${head}</thead><tbody>${body}${acts}</tbody></table><p class="hint">Green marks the best value in each row.</p>`;
  $("#cmp-body").onclick = (ev) => { const b = ev.target.closest("[data-act=choose]"); if (b) { choose(b.dataset.oid); $("#dlg-compare").close(); } };
  $("#dlg-compare").showModal();
}

/* ── quote request draft ──────────────────────────────── */
async function openQuote(offerId) {
  try {
    const q = await api(`/api/missions/${MISSION.id}/offers/${encodeURIComponent(offerId)}/quote-request`);
    $("#q-title").textContent = `Quote request · ${q.vendor}`;
    $("#q-subject").value = q.subject; $("#q-body").value = q.body;
    $("#q-copy").textContent = "Copy message";
    updateMailto();
    $("#dlg-quote").showModal();
  } catch (e) { alert("Could not draft the quote request: " + e.message); }
}

function updateMailto() {
  $("#q-mail").href = `mailto:?subject=${encodeURIComponent($("#q-subject").value)}&body=${encodeURIComponent($("#q-body").value)}`;
}

async function copyQuote() {
  const text = `Subject: ${$("#q-subject").value}\n\n${$("#q-body").value}`;
  try { await navigator.clipboard.writeText(text); $("#q-copy").textContent = "Copied ✓"; }
  catch { $("#q-body").select(); $("#q-copy").textContent = "Press ⌘C to copy"; }
}

/* ── sign-off ─────────────────────────────────────────── */
function choose(id) {
  if (MISSION.decision || !offerById(id)?.rank) return;
  SELECTED = id;
  refreshTable(); renderWhatif(); renderDecision();
}

function renderDecision() {
  const d = MISSION.decision, bar = $("#decision"), rep = MISSION.report, req = MISSION.requirements;
  const po = `/missions/${MISSION.id}/po`;
  if (d) {
    setStage(6);
    const o = offerById(d.offer_id), what = o ? `${req.quantity} × ${trunc(o.name, 56)} · ${usd(unitOf(o) * req.quantity)}` : "";
    $("#po-link").href = po;
    bar.className = "decide " + (d.decision === "approve" ? "approved" : "rejected");
    bar.innerHTML = d.decision === "approve"
      ? `<div class="what"><small style="color:#fff">Approved${d.offer_id !== rep.recommended_offer_id ? " · buyer override" : ""}</small><span>Signed off by ${esc(d.approver || "buyer")} · ${esc(what)}</span>${d.offer_id !== rep.recommended_offer_id && d.note ? `<span class="why">Reason: ${esc(d.note)}</span>` : ""}</div><a class="btn btn-gold" target="_blank" href="${po}">Open purchase order →</a>`
      : `<div class="what"><small>Rejected</small><span>No purchase order issued.${d.note ? " " + esc(d.note) : ""}</span></div>`;
    return;
  }
  const o = SELECTED && offerById(SELECTED), override = !!o && SELECTED !== rep.recommended_offer_id;
  const approver = $("#approver")?.value || "", note = $("#note")?.value || "";
  $("#po-link").href = po + (override ? `?offer=${encodeURIComponent(SELECTED)}` : "");
  bar.className = "decide" + (override ? " override" : "");
  bar.innerHTML = `
    <div class="what"><small>${override ? "Buyer override · not the recommendation" : "Ready for sign-off"}</small>
      <span>${o ? esc(`${req.quantity} × ${trunc(o.name, 60)} · ${usd(unitOf(o) * req.quantity)}`) : "Nothing to approve"}</span>
      ${override ? `<button class="btn btn-link" id="btn-unpick">Back to recommendation</button>` : ""}</div>
    ${override ? `<input id="note" placeholder="Why this offer? Required, printed on the PO" aria-label="Reason for choosing this offer (required)" maxlength="1000" required>` : ""}
    <input id="approver" placeholder="Approver name" aria-label="Approver name" maxlength="120">
    <button id="btn-reject" class="btn btn-ghost">Reject</button>
    <button id="btn-approve" class="btn btn-gold" ${o ? "" : "disabled"}>Approve purchase</button>`;
  $("#approver").value = approver;
  if ($("#note")) { $("#note").value = note; $("#note").oninput = () => $("#note").classList.remove("need"); }
  $("#btn-approve").onclick = () => decide("approve");
  $("#btn-reject").onclick = () => decide("reject");
  $("#btn-unpick")?.addEventListener("click", () => choose(rep.recommended_offer_id));
}

async function decide(decision) {
  const rep = MISSION.report, override = SELECTED !== rep.recommended_offer_id, note = $("#note")?.value.trim() || "";
  const needReason = () => {
    const el = $("#note"); el.classList.add("need"); el.placeholder = `A reason is required (at least ${INFO.min_override_reason ?? 3} characters)`; el.focus();
  };
  if (decision === "approve" && override && note.length < (INFO.min_override_reason ?? 3)) { needReason(); return; }
  try {
    MISSION = await api(`/api/missions/${MISSION.id}/decision`, { method: "POST", body: JSON.stringify({
      decision, offer_id: SELECTED || null, approver: $("#approver").value, note,
      weights: WHATIF ? sliderWeights() : null,
    }) });
    renderDecision(); refreshTable(); renderWhatif(); loadHistory();
  } catch (e) {
    if (/needs a reason/.test(e.message) && $("#note")) { needReason(); return; }  // server-side rule, same as above
    alert("Could not record decision: " + e.message);
  }
}

const show = (s) => $(s).classList.remove("hidden");
const hide = (s) => $(s).classList.add("hidden");
init();
