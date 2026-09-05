/* E17 Holiday Camp Planner — app logic.
 * Data: assets/camps.js (verified directory) + assets/planner-data.js (enrichment).
 * All state lives in this browser via localStorage; nothing is sent anywhere.
 * "Share plan" packs children + week assignments into a #plan= URL hash that
 * the user explicitly copies — opening such a link only ever OFFERS the plan.
 */

const D = window.E17_DIRECTORY;
const P = window.E17_PLANNER;

const STORE_KEY = `e17planner.v1.${P.season}`;
const CHILD_COLORS = ["var(--child-1)", "var(--child-2)", "var(--child-3)", "var(--child-4)", "var(--child-5)", "var(--child-6)"];

/* ────────────────────────── state ────────────────────────── */

const state = {
  search: "",
  area: "all",
  category: "all",
  funding: "all",
  age: "any",          // "any" | "under5" | "primary" | "teen" | "child:<id>"
  dayLength: "all",
  price: "all",
  confirmedOnly: false,
  sort: "confirmed",
  children: [],         // {id, name, age, color}
  shortlist: [],        // provider ids
  plan: {},             // { [weekId]: { [childId]: [{id, type, days, campId?, label?}] } }
  checks: [],           // checklist item ids
  pickerShowAll: false,
  hafShowAll: false     // HAF table: true after "Show all", reset when filters change
};

let pickerCtx = null;   // {mode:"cell", weekId, childId} | {mode:"camp", campId}
let pendingShared = null;   // parsed #plan= payload awaiting the user's decision
let pickerReturnFocus = null;  // CSS selector re-focused when the picker dialog closes
let pendingCampId = null;      // camp chosen before any child exists — reopened after add
let searchDebounceTimer = null;
let gridHasRendered = false;   // first grid render plays the stagger; later ones don't

const MOBILE_MQ = window.matchMedia("(max-width: 680px)");

/* ────────────────────────── persistence ────────────────────────── */

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      version: 2,
      children: state.children,
      shortlist: state.shortlist,
      plan: state.plan,
      checks: state.checks
    }));
    const staleShare = document.querySelector("#waShare");
    if (staleShare) { staleShare.hidden = true; staleShare.removeAttribute("href"); }
  } catch (e) { /* storage full/blocked — keep going in-memory */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.children)) state.children = data.children.filter((c) => c && /^[a-zA-Z0-9_-]{1,60}$/.test(c.id) && Number.isFinite(c.age)).slice(0,6).map((c,i)=>({...c,name:String(c.name||"Child").slice(0,20),color:CHILD_COLORS[i]}));
    if (Array.isArray(data.shortlist)) state.shortlist = data.shortlist.filter((id) => providerById(id));
    if (data.plan && typeof data.plan === "object") {
      state.plan = normalizePlan(data.plan, state.children);
      if (data.version !== 2 && !localStorage.getItem(STORE_KEY + '.before-daily')) localStorage.setItem(STORE_KEY + '.before-daily', raw);
    }
    if (Array.isArray(data.checks)) state.checks = data.checks;
  } catch (e) { /* corrupt store — start fresh */ }
}

/* ────────────────────────── helpers ────────────────────────── */

const normalize = (value) => String(value || "").toLowerCase();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function providerById(id) {
  return D.providers.find((p) => p.id === id) || null;
}

function plannerOf(provider) {
  return (P.byId && P.byId[provider.id]) || {};
}

function money(n) {
  if (n == null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return "£" + (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2));
}

/* Escape a value for use inside a querySelector attribute selector. */
function cssEsc(value) {
  return window.CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/* "2026-07-02" → "2 Jul" (null when unparseable — render nothing). */
function formatShortDate(iso) {
  const d = parseIsoDate(iso);
  return d ? `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}` : null;
}

/* provider.availability {status:'waitlist'|'full'|'mixed', asOf, note} → display
 * strings, or null when absent/unrecognised (field is optional per provider). */
function availabilityInfo(provider) {
  const av = provider && provider.availability;
  if (!av || !av.status) return null;
  const label = { waitlist: "Waitlist-only", full: "Full", mixed: "Some weeks full" }[av.status];
  if (!label) return null;
  const asOf = formatShortDate(av.asOf);
  return { label, asOf, note: av.note || "", text: label + (asOf ? " — as of " + asOf : "") };
}

/* planner entry bookBy "YYYY-MM-DD" → {label, daysLeft, closed} or null.
 * Within 14 days the label carries a countdown; past dates read "booking closed". */
function bookByInfo(pl) {
  const due = parseIsoDate(pl && pl.bookBy);
  if (!due) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((due - today) / 86400000);
  let label = `Book by ${WEEKDAYS_SHORT[due.getDay()]} ${due.getDate()} ${MONTHS_FULL[due.getMonth()]}`;
  if (daysLeft < 0) label += " (booking closed)";
  else if (daysLeft === 0) label += " (today — last day)";
  else if (daysLeft <= 14) label += ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)`;
  return { label, daysLeft, closed: daysLeft < 0 };
}

/* Effective per-day price for sorting/filtering: exact day price first,
 * else a stated week price divided over 5 days (estimate). */
function effectiveDayPrice(provider) {
  const pl = plannerOf(provider);
  const pr = pl.price || {};
  if (Number.isFinite(pr.day)) return { value: pr.day, estimate: false };
  if (pr.weekByWeek) {
    const vals = Object.values(pr.weekByWeek).filter(Number.isFinite);
    if (vals.length) return { value: Math.min(...vals) / 5, estimate: true };
  }
  if (Number.isFinite(pr.week)) return { value: pr.week / 5, estimate: true };
  if (pr.weekBands && pr.weekBands.length) {
    const vals = pr.weekBands.map((b) => b.week).filter(Number.isFinite);
    if (vals.length) return { value: Math.min(...vals) / 5, estimate: true };
  }
  return null;
}

function isHafOnly(provider) {
  return (provider.funding || []).includes("Free/HAF") && !(provider.funding || []).includes("Paid");
}

function hoursSpanMinutes(provider) {
  const h = plannerOf(provider).hours;
  if (!h) return null;
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = toMin(h.extStart) ?? toMin(h.start);
  const end = toMin(h.extEnd) ?? toMin(h.end);
  if (start == null || end == null) return null;
  return end - start;
}

function hoursLabel(provider) {
  const h = plannerOf(provider).hours;
  if (!h) return provider.hours || "Check hours";
  let label = `${h.start}–${h.end}`;
  if (h.extStart || h.extEnd) label += ` (ext ${h.extStart || h.start}–${h.extEnd || h.end})`;
  return label;
}

function coverageLabel(provider) {
  const c = plannerOf(provider).coverage;
  if (c === "working") return "Working-day friendly";
  if (c === "standard") return "Standard day";
  if (c === "short") return "Short / half day";
  return "Hours vary — check";
}

function mapLink(provider) {
  const addr = `${provider.venue || ""} ${provider.address || ""}`;
  if (/vary|varies|check|borough|multiple|sites|mobile|wide/i.test(addr)) return null;
  const q = encodeURIComponent(`${provider.venue}, ${provider.address}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function weekById(id) {
  return P.weeks.find((w) => w.id === Number(id)) || null;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/* Which weekdays a provider actually runs in a given week (drives the day toggles).
 * dayPattern lists explicit weekdays (1=Mon … 5=Fri) for weeks that don't start on
 * Monday — e.g. Church Hill's Tue–Fri first week; daysPerWeek covers plain
 * first-N-days weeks (Mon–Thu camps, the Mon–Wed final Soccer Stars week). */
function allowedDaysFor(provider, weekId) {
  const pl = plannerOf(provider);
  if (pl.fridaysOnly) return [5];
  const pat = pl.dayPattern && pl.dayPattern[String(weekId)];
  if (Array.isArray(pat) && pat.length) return pat.filter((d) => d >= 1 && d <= 5);
  const n = pl.daysPerWeek && pl.daysPerWeek[String(weekId)];
  if (n) return [1, 2, 3, 4, 5].slice(0, n);
  const wk = weekById(weekId);
  if (wk && wk.stub) return [1, 2, 3, 4, 5].slice(0, wk.days);
  return [1, 2, 3, 4, 5];
}

/* Resolve an entry's selected days: explicit selection, else the full pattern. */
function entryDays(entry, weekId) {
  if (entry.type === "camp") {
    const p = providerById(entry.campId);
    const allowed = p ? allowedDaysFor(p, weekId) : [1, 2, 3, 4, 5];
    const sel = Array.isArray(entry.days) && entry.days.length
      ? entry.days.filter((d) => allowed.includes(d))
      : allowed;
    return { days: sel.length ? sel : allowed, allowed, isDefault: !(Array.isArray(entry.days) && entry.days.length) };
  }
  const allowed = [1, 2, 3, 4, 5];
  const sel = Array.isArray(entry.days) && entry.days.length ? entry.days : allowed;
  return { days: sel, allowed, isDefault: !(Array.isArray(entry.days) && entry.days.length) };
}

/* Cost of one provider for one planner week.
 * Returns {value, estimate, label, basis} or null when unpriced. */
function weekCost(provider, weekId) {
  const pl = plannerOf(provider);
  const wk = weekById(weekId);
  if (!wk) return null;
  if (isHafOnly(provider) && (pl.weeks || []).includes(Number(weekId))) return { value: 0, estimate: false, label: "Free (HAF, if eligible)" };
  const pr = pl.price || {};
  const days = (pl.daysPerWeek && pl.daysPerWeek[String(weekId)]) || (wk.stub ? wk.days : 5);

  if (pr.weekByWeek && Number.isFinite(pr.weekByWeek[String(weekId)])) {
    return { value: pr.weekByWeek[String(weekId)], estimate: false, label: "listed week price" };
  }
  if (pr.weekBands && pr.weekBands.length) {
    const min = Math.min(...pr.weekBands.map((b) => b.week).filter(Number.isFinite));
    if (Number.isFinite(min)) return { value: min, estimate: true, label: "from (per age band)" };
  }
  if (Number.isFinite(pr.week)) {
    return { value: pr.week, estimate: false, label: pl.priceStale ? `week price (${pl.priceStale})` : "listed week price" };
  }
  if (Number.isFinite(pr.day)) {
    const v = pr.day * days;
    return {
      value: v,
      estimate: true,
      label: `${money(pr.day)} × ${days} day${days === 1 ? "" : "s"}${pl.priceStale ? ` (${pl.priceStale})` : ""}`
    };
  }
  return null;
}

function ageFits(provider, age) {
  return Number.isFinite(provider.ageMin) && Number.isFinite(provider.ageMax)
    ? age >= provider.ageMin && (Number.isInteger(provider.ageMax) ? age < provider.ageMax + 1 : age <= provider.ageMax)
    : true;
}

function childById(id) {
  return state.children.find((c) => c.id === id) || null;
}

function assignmentLabel(entry) {
  if (!entry) return null;
  if (entry.type === "camp") {
    const p = providerById(entry.campId);
    return p ? p.name : "Unknown camp — tap to fix";
  }
  if (entry.type === "leave") return "Annual leave";
  if (entry.type === "family") return "Family / grandparents";
  if (entry.type === "swap") return "Friend / childcare swap";
  return entry.label || "Other";
}

/* ────────────────────────── element handles ────────────────────────── */

const els = {
  providerGrid: document.querySelector("#providerGrid"),
  hafTable: document.querySelector("#hafTable"),
  sourceGrid: document.querySelector("#sourceGrid"),
  searchInput: document.querySelector("#searchInput"),
  areaFilter: document.querySelector("#areaFilter"),
  categoryFilter: document.querySelector("#categoryFilter"),
  fundingFilter: document.querySelector("#fundingFilter"),
  dayLengthFilter: document.querySelector("#dayLengthFilter"),
  priceFilter: document.querySelector("#priceFilter"),
  sortSelect: document.querySelector("#sortSelect"),
  confirmedOnly: document.querySelector("#confirmedOnly"),
  resultCount: document.querySelector("#resultCount"),
  emptyState: document.querySelector("#emptyState"),
  childForm: document.querySelector("#childForm"),
  childName: document.querySelector("#childName"),
  childAge: document.querySelector("#childAge"),
  childChips: document.querySelector("#childChips"),
  childAgeChips: document.querySelector("#childAgeChips"),
  compareWrap: document.querySelector("#compareWrap"),
  compareTable: document.querySelector("#compareTable"),
  compareCount: document.querySelector("#compareCount"),
  compareHint: document.querySelector("#compareHint"),
  plannerWrap: document.querySelector("#plannerWrap"),
  plannerTable: document.querySelector("#plannerTable"),
  plannerEmpty: document.querySelector("#plannerEmpty"),
  budgetBand: document.querySelector("#budgetBand"),
  budgetCards: document.querySelector("#budgetCards"),
  budgetNotes: document.querySelector("#budgetNotes"),
  checklistList: document.querySelector("#checklistList"),
  checklistCount: document.querySelector("#checklistCount"),
  pickerDialog: document.querySelector("#pickerDialog"),
  pickerTitle: document.querySelector("#pickerTitle"),
  pickerSub: document.querySelector("#pickerSub"),
  pickerBody: document.querySelector("#pickerBody"),
  pickerClose: document.querySelector("#pickerClose"),
  hafProviderCount: document.querySelector("#hafProviderCount"),
  tfcProviderCount: document.querySelector("#tfcProviderCount"),
  siblingProviderCount: document.querySelector("#siblingProviderCount"),
  shareBanner: document.querySelector("#shareBanner"),
  shareBannerText: document.querySelector("#shareBannerText"),
  shareUse: document.querySelector("#shareUse"),
  shareMerge: document.querySelector("#shareMerge"),
  shareDismiss: document.querySelector("#shareDismiss")
};

/* ────────────────────────── filtering ────────────────────────── */

function ageMatches(item) {
  if (state.age === "any") return true;
  if (state.age.startsWith("child:")) {
    const child = childById(state.age.slice(6));
    if (!child) return true;
    return ageFits(item, child.age);
  }
  if (state.age === "under5") return item.ageMin < 5;
  if (state.age === "primary") return item.ageMin <= 11 && item.ageMax >= 5;
  if (state.age === "teen") return item.ageMax >= 12;
  return true;
}

function textMatches(item) {
  if (!state.search) return true;
  const haystack = normalize([
    item.name, item.kind, item.area, item.venue, item.address,
    item.ageLabel || item.ages, item.summary, item.goodFor,
    ...(item.categories || []), ...(item.funding || [])
  ].join(" "));
  return haystack.includes(normalize(state.search));
}

function dayLengthMatches(provider) {
  if (state.dayLength === "all") return true;
  return plannerOf(provider).coverage === state.dayLength;
}

function priceMatches(provider) {
  if (state.price === "all") return true;
  if (state.price === "free") return (provider.funding || []).includes("Free/HAF");
  const eff = effectiveDayPrice(provider);
  if (state.price === "unpriced") return !eff && !isHafOnly(provider);
  if (!eff) return false;
  if (state.price === "under40") return eff.value < 40;
  if (state.price === "40to60") return eff.value >= 40 && eff.value <= 60;
  if (state.price === "over60") return eff.value > 60;
  return true;
}

function providerMatches(provider) {
  const areaOk = state.area === "all" || provider.areas.includes(state.area);
  const categoryOk = state.category === "all" || provider.categories.includes(state.category);
  const fundingOk = state.funding === "all" || provider.funding.includes(state.funding);
  const confirmedOk = !state.confirmedOnly || (plannerOf(provider).weeks || []).length > 0;
  return areaOk && categoryOk && fundingOk && confirmedOk &&
    dayLengthMatches(provider) && priceMatches(provider) &&
    ageMatches(provider) && textMatches(provider);
}

function sortProviders(list) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (state.sort === "price") {
    return list.sort((a, b) => {
      const ea = effectiveDayPrice(a); const eb = effectiveDayPrice(b);
      const va = isHafOnly(a) ? 0 : (ea ? ea.value : Infinity);
      const vb = isHafOnly(b) ? 0 : (eb ? eb.value : Infinity);
      return va - vb || byName(a, b);
    });
  }
  if (state.sort === "hours") {
    return list.sort((a, b) => (hoursSpanMinutes(b) ?? -1) - (hoursSpanMinutes(a) ?? -1) || byName(a, b));
  }
  if (state.sort === "confirmed") {
    return list.sort((a, b) =>
      ((plannerOf(b).weeks || []).length - (plannerOf(a).weeks || []).length) || byName(a, b));
  }
  return list.sort(byName);
}

/* ────────────────────────── directory cards ────────────────────────── */

function badgeRow(provider) {
  const pl = plannerOf(provider);
  const f = provider.funding || [];
  const badges = [];
  const wk = pl.weeks || [];
  if (wk.length) {
    badges.push(`<span class="badge badge-confirmed">2026 dates ✓ wk ${wk.filter((w) => w <= 6).join("·")}</span>`);
  } else if (pl.sessionBased) {
    badges.push(`<span class="badge badge-tbc">Session-based</span>`);
  } else {
    badges.push(`<span class="badge badge-tbc">October dates TBC</span>`);
  }
  if (f.includes("Free/HAF")) badges.push(`<span class="badge badge-haf">HAF free places</span>`);
  if (f.includes("Tax-Free Childcare")) badges.push(`<span class="badge badge-tfc">Tax-Free Childcare</span>`);
  else if (f.includes("Childcare vouchers")) badges.push(`<span class="badge badge-tfc">Vouchers</span>`);
  if (pl.ofsted) badges.push(`<span class="badge badge-ofsted">Ofsted-registered</span>`);
  if (f.includes("Sibling discount")) badges.push(`<span class="badge badge-sibling">Sibling discount</span>`);
  if ((provider.categories || []).includes("SEND aware") || pl.sendAware) badges.push(`<span class="badge badge-send">SEND aware</span>`);
  if (pl.lunch && pl.lunch.policy === "included") badges.push(`<span class="badge badge-food">Meals included</span>`);
  if (pl.fridaysOnly) badges.push(`<span class="badge badge-tbc">Fridays only</span>`);
  const av = availabilityInfo(provider);
  if (av) badges.push(`<span class="badge badge-waitlist"${av.note ? ` title="${escapeHtml(av.note)}"` : ""}>&#9888; ${escapeHtml(av.text)}</span>`);
  badges.push(`<span class="badge badge-tbc">${escapeHtml(bookingState(provider))}</span>`);
  return badges.join("");
}

function priceFact(provider) {
  const pl = plannerOf(provider);
  const pr = pl.price || {};
  if (isHafOnly(provider)) return "Free (HAF, if eligible)";
  const bits = [];
  if (Number.isFinite(pr.day)) bits.push(`${money(pr.day)}/day`);
  if (Number.isFinite(pr.dayExtended)) bits.push(`${money(pr.dayExtended)}/ext day`);
  if (Number.isFinite(pr.week)) bits.push(`${money(pr.week)}/wk`);
  if (pr.weekByWeek) {
    const vals = Object.values(pr.weekByWeek).filter(Number.isFinite);
    if (vals.length) bits.push(vals.map(money).join("–") + "/wk");
  }
  if (pr.weekBands) bits.push(pr.weekBands.map((b) => money(b.week)).join("–") + "/wk");
  if (Number.isFinite(pr.sessionFrom)) bits.push(`${money(pr.sessionFrom)}–${money(pr.sessionTo)}/session`);
  if (!bits.length) return "Not published — check";
  return (pl.priceFrom ? "From " : "") + bits.join(" · ") + (pl.priceStale ? ` (${pl.priceStale} — confirm October rate)` : "");
}

function weeksFact(provider) {
  const pl = plannerOf(provider);
  const wk = (pl.weeks || []).filter((w) => w <= 6);
  if (wk.length === P.weeks.length) return "26–30 October";
  if (wk.length) return "Weeks " + wk.join(", ");
  if (pl.sessionBased) return "Selected dates";
  if (pl.weeksLikely) return "Likely — confirm";
  return "Check provider";
}

function sourceLinks(provider) {
  const sources = [provider.source, ...(provider.secondarySources || [])];
  return sources
    .map((s) => `<a class="source-link" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.label)} ↗</a>`)
    .join("");
}

function renderProviders() {
  const matches = sortProviders(D.providers.filter(providerMatches));
  // Only the very first render plays the stagger animation.
  if (gridHasRendered) els.providerGrid.classList.add("no-anim");
  gridHasRendered = true;

  const cardHtml = (provider, i) => {
    const pl = plannerOf(provider);
    const shortlisted = state.shortlist.includes(provider.id);
    const map = mapLink(provider);
    const stalePrice = pl.priceStale
      ? `<p class="provenance">⚠ Price is from the ${escapeHtml(pl.priceStale)} — use as a guide and confirm the October rate.</p>`
      : "";
    const reconfirm = pl.reconfirm
      ? `<p class="provenance">⚠ Reconfirm dates with the provider before booking — see basis below.</p>`
      : "";
    const bb = bookByInfo(pl);
    const deadline = bb ? `<p class="deadline-note">⏰ ${escapeHtml(bb.label)}</p>` : "";
    const checkedShort = formatShortDate(provider.checkedOn) || formatShortDate(D.updated);
    return `
      <article class="camp-card ${shortlisted ? "is-shortlisted" : ""}" style="--i:${i}">
        <div class="card-topline">
          <span class="kind">${escapeHtml(provider.kind)}</span>
          <button class="heart-btn ${shortlisted ? "is-on" : ""}" type="button"
            data-shortlist="${escapeHtml(provider.id)}"
            aria-pressed="${shortlisted}"
            aria-label="${shortlisted ? "Remove from" : "Add to"} shortlist: ${escapeHtml(provider.name)}">♥</button>
        </div>
        <h3>${escapeHtml(provider.name)}</h3>
        <p class="venue">${escapeHtml(provider.venue)}${map ? ` · <a href="${map}" target="_blank" rel="noreferrer">map ↗</a>` : ""}</p>
        <div class="badge-row">${badgeRow(provider)}</div>
        ${deadline}
        <div class="quick-facts">
          <span><strong>Ages</strong>${escapeHtml(provider.ageLabel)}</span>
          <span><strong>Hours</strong>${escapeHtml(hoursLabel(provider))}</span>
          <span class="fact-price"><strong>Cost</strong>${escapeHtml(priceFact(provider))}</span>
          <span><strong>October dates</strong>${escapeHtml(weeksFact(provider))}</span>
        </div>
        <p class="summary">${escapeHtml(provider.summary)}</p>
        <p class="good-for"><strong>Best for:</strong> ${escapeHtml(provider.goodFor)}</p>
        <details class="card-details">
          <summary>Details, dates &amp; where this info comes from</summary>
          <div class="card-details-body">
            <p><strong>Day length:</strong> ${escapeHtml(coverageLabel(provider))} (${escapeHtml(provider.hours)})</p>
            <p><strong>How to book:</strong> ${escapeHtml(provider.booking)}</p>
            ${pl.weeksBasis ? `<p><strong>2026 dates:</strong> ${escapeHtml(pl.weeksBasis)}</p>` : ""}
            ${pl.priceBasis ? `<p><strong>Pricing:</strong> ${escapeHtml(pl.priceBasis)}</p>` : ""}
            ${pl.lunch ? `<p><strong>Food:</strong> ${escapeHtml(pl.lunch.note)}</p>` : ""}
            ${stalePrice}${reconfirm}
            <p class="provenance">Verified against the sources below — checked ${escapeHtml(checkedShort || D.updated)} (${escapeHtml(provider.confidence)}).</p>
            <div class="source-row">${sourceLinks(provider)}</div>
          </div>
        </details>
        <div class="card-actions">
          <button class="btn btn-add" type="button" data-addplan="${escapeHtml(provider.id)}">+ Add to plan</button>
          <a class="btn btn-book" href="${escapeHtml(provider.bookingUrl || provider.source.url)}" target="_blank" rel="noreferrer">${(pl.weeks || []).length ? "Booking details ↗" : "Check provider ↗"}</a>
        </div>
      </article>
    `;
  };
  const confirmed = matches.filter(p => (plannerOf(p).weeks || []).length);
  const unconfirmed = matches.filter(p => !(plannerOf(p).weeks || []).length);
  els.providerGrid.innerHTML = confirmed.map(cardHtml).join('');
  document.querySelector('#unconfirmedGrid').innerHTML = unconfirmed.map(cardHtml).join('');
  const totalConfirmed = D.providers.filter(p => (plannerOf(p).weeks || []).length).length;
  document.querySelector('#confirmedCount').textContent = `${confirmed.length} confirmed October options${confirmed.length !== totalConfirmed ? ` matching your filters (${totalConfirmed} total)` : ''} — dates published; check booking status on each card.`;
  document.querySelector('#unconfirmedCount').textContent = `${unconfirmed.length} previous providers — October unconfirmed`;
  document.querySelector('#unconfirmedProviders').hidden = !unconfirmed.length || state.confirmedOnly;
  els.resultCount.textContent = `${confirmed.length} confirmed · ${unconfirmed.length} unconfirmed`;
  els.emptyState.hidden = confirmed.length > 0;
  els.emptyState.textContent = unconfirmed.length
    ? 'No confirmed October camps match those filters. Expand the previous providers above to see unconfirmed leads, or widen your filters.'
    : 'No camps match those filters. Try widening the day length or price, or reset the filters.';

}

/* ────────────────────────── compare ────────────────────────── */

const COMPARE_ROWS = [
  { label: "Ages", get: (p) => p.ageLabel },
  { label: "Hours", get: (p) => hoursLabel(p) },
  { label: "Day length", get: (p) => coverageLabel(p) },
  { label: "Cost", get: (p) => priceFact(p) },
  { label: "October 2026 dates", get: (p) => weeksFact(p) },
  { label: "Food", get: (p) => (plannerOf(p).lunch ? plannerOf(p).lunch.note : "Ask provider") },
  { label: "Funding & discounts", get: (p) => (p.funding || []).join(", ") },
  { label: "Venue", get: (p) => p.venue },
  { label: "Area", get: (p) => p.area }
];

function renderCompare() {
  const items = state.shortlist.map(providerById).filter(Boolean);
  els.compareCount.textContent = items.length ? `${items.length} shortlisted` : "";
  els.compareHint.hidden = items.length > 0;
  els.compareWrap.hidden = items.length === 0;
  if (!items.length) { els.compareTable.innerHTML = ""; return; }

  const head = `<thead><tr><th></th>${items.map((p) => `
    <th>
      <span class="compare-name">${escapeHtml(p.name)}</span><br>
      <button class="compare-remove" type="button" data-shortlist="${escapeHtml(p.id)}">remove</button>
    </th>`).join("")}</tr></thead>`;

  const body = `<tbody>${COMPARE_ROWS.map((row) => `
    <tr>
      <th scope="row">${escapeHtml(row.label)}</th>
      ${items.map((p) => `<td>${escapeHtml(row.get(p) || "—")}</td>`).join("")}
    </tr>`).join("")}
    <tr>
      <th scope="row">Book</th>
      ${items.map((p) => `<td><a class="source-link" href="${escapeHtml(p.bookingUrl || p.source.url)}" target="_blank" rel="noreferrer">Open booking ↗</a></td>`).join("")}
    </tr>
  </tbody>`;

  els.compareTable.innerHTML = head + body;
}

/* ────────────────────────── children ────────────────────────── */

function renderChildren() {
  els.childChips.innerHTML = state.children.map((c) => `
    <span class="child-chip">
      <span class="child-dot" style="background:${c.color}"></span>
      ${escapeHtml(c.name)} <small>· ${ageLabel(c.age)}</small>
      <button class="child-remove" type="button" data-removechild="${escapeHtml(c.id)}"
        aria-label="Remove ${escapeHtml(c.name)}">×</button>
    </span>
  `).join("");

  els.childAgeChips.innerHTML = state.children.map((c) => `
    <button class="age-chip is-child ${state.age === "child:" + c.id ? "is-active" : ""}"
      type="button" data-age="child:${escapeHtml(c.id)}">
      Fits ${escapeHtml(c.name)} (${ageLabel(c.age)})
    </button>
  `).join("");
  bindAgeChips();
}

function addChild(name, age) {
  const id = "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const color = CHILD_COLORS[state.children.length % CHILD_COLORS.length];
  state.children.push({ id, name: name || `Child ${state.children.length + 1}`, age, color });
  saveState();
  renderChildren();
  renderPlanner();
}

function removeChild(id) {
  state.children = state.children.filter((c) => c.id !== id);
  Object.values(state.plan).forEach((week) => { delete week[id]; });
  if (state.age === "child:" + id) state.age = "any";
  saveState();
  renderChildren();
  renderPlanner();
  applyFilters();
}

/* ────────────────────────── planner grid ────────────────────────── */

/* Multiple bookings per child/week. Days belong to at most one booking. */
function weekDays(weekId) {
  const wk = weekById(weekId);
  return Array.from({ length: Math.min(wk?.days || 5, 5) }, (_, i) => i + 1);
}
function bookingId() { return 'b' + crypto.randomUUID().replaceAll('-', ''); }
function planEntries(weekId, childId) {
  const raw = state.plan[weekId]?.[childId];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}
function normalizePlan(plan, children) {
  const out = {};
  for (const wk of P.weeks) for (const child of children) {
    const raw = plan?.[wk.id]?.[child.id];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const occupied = new Set();
    const entries = list.slice(0, 5).flatMap((r, i) => {
      if (!r || !['camp','other','family','leave','swap'].includes(r.type)) return [];
      if (r.type === 'camp' && typeof r.campId !== 'string') return [];
      const days = [...new Set(Array.isArray(r.days) ? r.days : weekDays(wk.id))]
        .filter(d => weekDays(wk.id).includes(d) && !occupied.has(d)).sort();
      if (!days.length) return [];
      days.forEach(d => occupied.add(d));
      const e = { id: `b${wk.id}_${child.id}_${i}`, type: r.type, days };
      if (typeof r.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(r.id)) e.id = r.id;
      if (r.type === 'camp') e.campId = r.campId.slice(0, 60);
      if (r.type === 'other') {
        e.label = String(r.label || 'My own camp').slice(0, 60);
        e.costBasis = r.costBasis === 'day' ? 'day' : 'week';
      }
      for (const key of ['cost','myCost']) if (Number.isFinite(r[key]) && r[key] >= 0) e[key] = Math.round(r[key] * 100) / 100;
      if (r.booked === true) e.booked = true;
      return [e];
    });
    if (entries.length) { out[wk.id] ||= {}; out[wk.id][child.id] = entries; }
  }
  return out;
}
function writeEntries(weekId, childId, entries) {
  state.plan[weekId] ||= {};
  if (entries.length) state.plan[weekId][childId] = entries;
  else delete state.plan[weekId][childId];
  if (!Object.keys(state.plan[weekId]).length) delete state.plan[weekId];
  saveState(); renderPlanner();
}
function entryCost(entry, weekId) {
  if (!entry) return null;
  if (entry.type !== 'camp') {
    if (entry.type !== 'other') return { value: 0, estimate: false };
    if (!Number.isFinite(entry.cost)) return null;
    return { value: entry.cost * (entry.costBasis === 'day' ? entry.days.length : 1), estimate: false };
  }
  if (Number.isFinite(entry.myCost)) return { value: entry.myCost, estimate: false };
  const p = providerById(entry.campId);
  if (!p) return null;
  const pl = plannerOf(p);
  if (pl.fullWeekOnly || entry.days.length === allowedDaysFor(p, weekId).length) return weekCost(p, weekId);
  if (Number.isFinite(pl.price?.day)) return { value: pl.price.day * entry.days.length, estimate: true };
  return null;
}
function totalLabel(total, unknown) {
  return unknown ? total ? `${money(total)} + ${unknown} price${unknown === 1 ? '' : 's'} to confirm` : 'Price to confirm' : money(total);
}
function isBooking(e) { return e.type === 'camp' || e.type === 'other'; }
function bookingState(p, now = new Date()) {
  const pl = plannerOf(p);
  if (pl.bookingOpens && now < new Date(pl.bookingOpens)) return 'Opens ' + pl.bookingOpensLabel;
  return (pl.weeks || []).length ? 'Dates published · places unverified' : 'October availability unverified';
}
function ageLabel(age) {
  const total = Math.round(age * 12), years = Math.floor(total / 12), months = total % 12;
  return `${years}y${months ? ` ${months}m` : ''}`;
}
function updatePlannerActionState() {
  const has = P.weeks.some(w=>state.children.some(c=>planEntries(w.id,c.id).length));
  for(const id of ['sharePlan','calendarPlan','copyPlan','printPlan','clearPlan']) document.getElementById(id).disabled=!has;
}
function renderPlanner() {
  document.querySelector('.planner-section').dataset.printTitle = `KidSorted — ${P.seasonLabel} (data checked ${D.updated})`;
  updatePlannerActionState();
  const has = !!state.children.length;
  els.plannerEmpty.hidden = has; els.plannerWrap.hidden = !has; els.budgetBand.hidden = !has;
  els.plannerTable.innerHTML = '';
  if (!has) return;
  els.plannerTable.innerHTML = state.children.map(c => `<section class="child-plan" aria-label="Plan for ${escapeHtml(c.name)}">
    <h3>${escapeHtml(c.name)} <small>${ageLabel(c.age)}</small></h3>
    ${P.weeks.map(wk => {
      const entries = planEntries(wk.id, c.id);
      return `<section class="week-plan"><h4>${escapeHtml(wk.label)} · ${escapeHtml(wk.dates)}</h4>
        ${wk.note ? `<p class="school-note">${escapeHtml(wk.note)}</p>` : ''}
        <div class="daily-grid">${weekDays(wk.id).map(d => {
          const entry = entries.find(e => e.days.includes(d));
          const date = new Date(wk.mon + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + d - 1);
          const status = !entry ? 'Needs cover' : isBooking(entry) ? entry.booked ? 'Booked' : 'Planned · not booked' : 'Cover arranged';
          return `<button type="button" class="daily-card ${entry ? 'has-cover' : 'needs-cover'}" data-open-day="${d}" data-week="${wk.id}" data-child="${escapeHtml(c.id)}">
            <span class="daily-date">${DAY_LABELS[d-1]} ${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}</span>
            <strong>${entry ? escapeHtml(assignmentLabel(entry)) : '+ Add cover'}</strong><span class="daily-status">${status}</span></button>`;
        }).join('')}</div>
        <div class="booking-list">${entries.map(e => {
          const cost = entryCost(e, wk.id);
          return `<article class="booking-row"><div><strong>${escapeHtml(assignmentLabel(e))}</strong><p>${e.days.map(d => DAY_LABELS[d-1]).join(', ')} · ${cost ? money(cost.value) + (cost.estimate ? ' estimate' : '') : 'Price to confirm'}</p>
            ${e.type === 'camp' && !(plannerOf(providerById(e.campId) || {}).weeks || []).includes(wk.id) ? '<p class="po-warn">Dates unconfirmed — check with provider</p>' : ''}</div>
            <div class="booking-actions"><button type="button" class="btn-sub" data-edit-booking="${e.id}" data-week="${wk.id}" data-child="${escapeHtml(c.id)}">Edit booking</button>
            ${isBooking(e) ? `<button type="button" class="btn-sub ${e.booked ? 'is-booked' : ''}" aria-pressed="${!!e.booked}" data-booking-toggle="${e.id}" data-week="${wk.id}" data-child="${escapeHtml(c.id)}">${e.booked ? 'Booked ✓' : 'Mark booked'}</button>` : ''}</div></article>`;
        }).join('')}</div></section>`;
    }).join('')}</section>`).join('');
  renderBudget();
}
function renderBudget() {
  let grand = 0, grandUnknown = 0, totalPlanned = 0, totalRequired = 0, totalBooked = 0, tfcSpend = 0;
  const notes = [];
  const cards = state.children.map(c => {
    let total = 0, unknown = 0, planned = 0, booked = 0, arranged = 0, required = 0;
    const gaps = [];
    for (const wk of P.weeks) {
      const entries = planEntries(wk.id, c.id);
      required += weekDays(wk.id).length;
      const occupied = new Set(entries.flatMap(e => e.days));
      planned += occupied.size;
      gaps.push(...weekDays(wk.id).filter(d => !occupied.has(d)).map(d => `${DAY_LABELS[d-1]} ${new Date(Date.parse(wk.mon+'T12:00:00Z')+(d-1)*86400000).getUTCDate()} ${MONTHS_SHORT[new Date(wk.mon).getUTCMonth()]}`));
      for (const e of entries) {
        const cost = entryCost(e, wk.id);
        if (cost) {total += cost.value;if(e.type === "camp" && plannerOf(providerById(e.campId)||{}).tfc)tfcSpend += cost.value;} else unknown++;
        if (isBooking(e) && e.booked) booked += e.days.length;
        if (!isBooking(e)) arranged += e.days.length;
      }
    }
    grand += total; grandUnknown += unknown; totalPlanned += planned; totalRequired += required; totalBooked += booked;
    if (gaps.length) notes.push(`<p><strong>${escapeHtml(c.name)} — still needs cover:</strong> ${gaps.join(', ')}.</p>`);
    return `<div class="budget-card"><span class="budget-label">${escapeHtml(c.name)}</span><span class="budget-value">${totalLabel(total, unknown)}</span>
      <span class="budget-sub">${planned} of ${required} days planned · ${required-planned} still to cover</span>
      <span class="budget-sub">${booked} camp day${booked === 1 ? '' : 's'} booked · ${arranged} day${arranged === 1 ? '' : 's'} of other cover · ${planned-booked-arranged} camp day${planned-booked-arranged === 1 ? '' : 's'} awaiting booking</span></div>`;
  });
  els.budgetCards.innerHTML = cards.join('') + `<div class="budget-card grand"><span class="budget-label">Whole holiday</span><span class="budget-value">${totalLabel(grand, grandUnknown)}</span><span class="budget-sub">${totalPlanned} of ${totalRequired} child-days planned · ${totalBooked} camp day${totalBooked === 1 ? '' : 's'} booked</span></div>`;
  if(tfcSpend > 0) notes.push(`<p><strong>Tax-Free Childcare:</strong> ${money(tfcSpend)} is with providers listed as accepting TFC. If eligible, the government contribution could cover approximately ${money(tfcSpend * .2)} of this bill; limits and provider participation apply.</p>`);
  els.budgetNotes.innerHTML = notes.join('') + '<p>Estimates exclude unverified extras and discounts. Published dates do not guarantee a place; book directly with the provider.</p>';
}

/* ────────────────────────── picker dialog ────────────────────────── */

/* Re-focus a control inside the picker body after an innerHTML re-render. */
function refocusPicker(selector) {
  const el = els.pickerBody.querySelector(selector);
  if (el) el.focus();
}

function openCellPicker(weekId, childId, day) {
  pickerCtx = { mode: 'choose', weekId:Number(weekId), childId, days:day ? [Number(day)] : weekDays(weekId) };
  pickerReturnFocus = `[data-open-day="${day || 1}"][data-week="${weekId}"][data-child="${cssEsc(childId)}"]`;
  renderPicker(); els.pickerDialog.showModal();
}
function openCampAssign(campId) {
  if (!state.children.length) {
    pendingCampId = campId;
    document.querySelector('#childrenHint').textContent = 'Add a child to choose days for this camp. Your plan stays on this device.';
    document.querySelector('#children').scrollIntoView({behavior:'smooth'}); els.childAge.focus(); return;
  }
  pickerCtx = { mode:'target', campId }; pickerReturnFocus = `[data-addplan="${cssEsc(campId)}"]`;
  renderPicker(); els.pickerDialog.showModal();
}
function startDraft(weekId, childId, entry, days, editId) {
  const full = entry.type === 'camp' && plannerOf(providerById(entry.campId) || {}).fullWeekOnly;
  pickerCtx = {mode:'draft', weekId:Number(weekId), childId, editId, draft:{...entry,id:entry.id || bookingId(),days:full ? weekDays(weekId) : [...days]}};
  renderPicker();
}
function draftCostText() {
  const cost = entryCost(pickerCtx.draft, pickerCtx.weekId);
  return cost ? `${money(cost.value)}${cost.estimate ? ' estimate' : ''}` : 'Price to confirm';
}
function readDraftFields() {
  const d = pickerCtx.draft;
  if (!d) return;
  const price = document.querySelector('#draftPrice');
  if (price) {
    const key = d.type === 'camp' ? 'myCost' : 'cost';
    if (price.value.trim() && price.validity.valid) d[key] = Number(price.value); else delete d[key];
  }
  if (d.type === 'other') {
    d.label = document.querySelector('#draftName')?.value.trim().slice(0,60) || 'My own camp';
    d.costBasis = document.querySelector('#draftBasis')?.value || 'week';
  }
}
function renderPicker() {
  const ctx = pickerCtx;
  if (!ctx) return;
  if (ctx.mode === 'target') {
    const p = providerById(ctx.campId);
    els.pickerTitle.textContent = p.name;
    els.pickerSub.textContent = 'Choose a child, then the days you need.';
    els.pickerBody.innerHTML = state.children.map(c => P.weeks.map(w => `<button type="button" class="picker-option" data-target-child="${escapeHtml(c.id)}" data-target-week="${w.id}"><strong>${escapeHtml(c.name)} · ${ageLabel(c.age)}</strong><span>${escapeHtml(w.dates)}${ageFits(p,c.age) ? '' : ' · outside listed ages — check eligibility'}</span></button>`).join('')).join(''); return;
  }
  const c = childById(ctx.childId), wk = weekById(ctx.weekId);
  if (!c || !wk) return;
  els.pickerTitle.textContent = `${c.name} · ${wk.dates}`;
  if (ctx.mode === 'choose') {
    els.pickerSub.textContent = 'Choose a camp or other cover. You can review the days before saving.';
    const options = confirmed => D.providers.filter(p => plannerOf(p).plannerRole !== 'route' && ageFits(p,c.age) && (!!plannerOf(p).weeks?.includes(wk.id) === confirmed)).map(p => `<button type="button" class="picker-option" data-choose-camp="${escapeHtml(p.id)}"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.ageLabel)} · ${escapeHtml(priceFact(p))}</span><small>${escapeHtml(bookingState(p))}</small></button>`).join('');
    els.pickerBody.innerHTML = `<p class="picker-group-title">Dates published for this holiday</p>${options(true) || '<p>No date-confirmed camps fit this age. Check eligibility with providers or add your own.</p>'}<details><summary>Other providers — October unconfirmed</summary>${options(false)}</details>
      <p class="picker-group-title">Other cover</p>${[['family','Family / grandparents'],['leave','Annual leave'],['swap','Friend / childcare swap'],['other','Add my own camp']].map(([v,t])=>`<button type="button" class="picker-option" data-choose-type="${v}">${t}</button>`).join('')}`; return;
  }
  const d = ctx.draft, p = d.type === 'camp' ? providerById(d.campId) : null, full = p && plannerOf(p).fullWeekOnly;
  els.pickerSub.textContent = assignmentLabel(d);
  const conflicts = conflictingEntries(ctx);
  els.pickerBody.innerHTML = `<p>${p ? escapeHtml(bookingState(p)) : 'Choose which days this cover applies to.'}</p>
    ${p && !ageFits(p,c.age) ? `<p class="po-warn">Outside listed ages (${escapeHtml(p.ageLabel)}). Check eligibility before booking.</p>` : ''}
    ${full ? '<p class="full-week-note"><strong>Full-week booking only.</strong> All five days are included. Individual days cannot be bought separately.</p>' : ''}
    <fieldset class="draft-days"><legend>Days to cover</legend>${weekDays(wk.id).map(day=>`<label><input type="checkbox" data-draft-day="${day}" ${d.days.includes(day)?'checked':''} ${full?'disabled':''}> ${DAY_LABELS[day-1]} ${new Date(Date.parse(wk.mon+'T12:00:00Z')+(day-1)*86400000).getUTCDate()}</label>`).join('')}</fieldset>
    ${d.type === 'other' ? `<label class="field"><span>Camp name</span><input id="draftName" maxlength="60" value="${escapeHtml(d.label || '')}"></label><label class="field"><span>Price applies to</span><select id="draftBasis"><option value="week">All selected days</option><option value="day" ${d.costBasis==='day'?'selected':''}>Each day</option></select></label>` : ''}
    ${isBooking(d) ? `<label class="field"><span>${p ? 'Your total price for this booking (£, optional)' : 'Price (£, leave blank if unknown)'}</span><input id="draftPrice" type="number" min="0" step="0.01" inputmode="decimal" value="${Number.isFinite(p ? d.myCost : d.cost) ? (p ? d.myCost : d.cost) : ''}"></label>` : ''}
    <p class="draft-price" id="draftCost" aria-live="polite">${draftCostText()}</p>
    ${p && plannerOf(p).priceBasis ? `<p class="picker-note">${escapeHtml(plannerOf(p).priceBasis)}</p>` : ''}
    <div id="draftConflict" role="status">${ctx.reviewOverlap && conflicts.length ? `<div class="overlap-review"><strong>These days already have cover:</strong><ul>${conflicts.map(e=>`<li>${escapeHtml(assignmentLabel(e))} — ${e.days.filter(day=>d.days.includes(day)).map(day=>DAY_LABELS[day-1]).join(', ')}${e.type==='camp' && plannerOf(providerById(e.campId)||{}).fullWeekOnly ? '. Replacing any day removes this full-week booking from the plan.' : ''}${e.booked ? ' This is marked booked; changing the plan does not cancel your provider booking.' : ''}</li>`).join('')}</ul><button class="btn btn-danger" type="button" data-confirm-replace="1">Replace this cover</button><button class="btn-sub" type="button" data-review-cancel="1">Keep existing cover</button></div>` : ''}</div>
    ${d.booked ? '<p>This booking is marked booked. Changing dates resets that status; changing or removing it here does not cancel a provider booking.</p>' : ''}<p id="draftError" role="alert"></p><div class="draft-actions"><button type="button" class="btn btn-solid" data-save-draft="1">Save cover</button>${ctx.editId ? '<button type="button" class="btn btn-danger" data-remove-draft="1">Remove from plan</button>' : ''}</div>`;
  for (const el of els.pickerBody.querySelectorAll('#draftPrice,#draftBasis,#draftName')) el.addEventListener('input',()=>{readDraftFields();document.querySelector('#draftCost').textContent=draftCostText();});
}
function conflictingEntries(ctx) {
  return planEntries(ctx.weekId,ctx.childId).filter(e=>e.id!==ctx.editId && e.days.some(d=>ctx.draft.days.includes(d)));
}
function commitDraft() {
  const {weekId,childId,draft,editId} = pickerCtx;
  let entries = planEntries(weekId,childId).filter(e=>e.id!==editId).flatMap(e=>{
    const days=e.days.filter(d=>!draft.days.includes(d));
    if (days.length===e.days.length) return [e];
    // A full-week reservation is atomic: never turn it into an invented daily rate.
    if (e.type==='camp' && plannerOf(providerById(e.campId)||{}).fullWeekOnly) return [];
    const remainder={...e,days};
    // A quoted total cannot safely be prorated after dates change.
    if ('myCost' in remainder) delete remainder.myCost;
    if (remainder.type==='other' && remainder.costBasis!=='day') delete remainder.cost;
    return days.length?[remainder]:[];
  });
  const previous = planEntries(weekId,childId).find(e=>e.id===editId);
  if(previous && previous.days.join() !== [...draft.days].sort().join()) delete draft.booked;
  entries.push({...draft,days:[...draft.days].sort()});
  writeEntries(weekId,childId,entries); els.pickerDialog.close();
}
function handlePickerClick(event) {
  const ctx=pickerCtx;
  if (!ctx) return;
  const target=event.target.closest('[data-target-child]');
  if (target) { const w=Number(target.dataset.targetWeek), c=target.dataset.targetChild;const occupied=new Set(planEntries(w,c).flatMap(e=>e.days)); const free=weekDays(w).filter(d=>!occupied.has(d));startDraft(w,c,{type:'camp',campId:ctx.campId},free.length?free:weekDays(w));return; }
  const camp=event.target.closest('[data-choose-camp]'), type=event.target.closest('[data-choose-type]');
  if (camp || type) {startDraft(ctx.weekId,ctx.childId,camp?{type:'camp',campId:camp.dataset.chooseCamp}:{type:type.dataset.chooseType},ctx.days);return;}
  if (ctx.mode!=='draft') return;
  if (event.target.matches('[data-draft-day]')) {
    readDraftFields();ctx.draft.days=[...els.pickerBody.querySelectorAll('[data-draft-day]:checked')].map(el=>Number(el.dataset.draftDay));ctx.reviewOverlap=false;renderPicker();return;
  }
  if (event.target.closest('[data-review-cancel]')) {ctx.reviewOverlap=false;renderPicker();return;}
  if (event.target.closest('[data-remove-draft]')) {writeEntries(ctx.weekId,ctx.childId,planEntries(ctx.weekId,ctx.childId).filter(e=>e.id!==ctx.editId));els.pickerDialog.close();return;}
  if (event.target.closest('[data-save-draft],[data-confirm-replace]')) {
    const bad=[...els.pickerBody.querySelectorAll('input')].find(el=>!el.validity.valid);
    if (bad) {bad.reportValidity();return;}
    readDraftFields();
    if (!ctx.draft.days.length) {document.querySelector('#draftError').textContent='Choose at least one day.';return;}
    if (conflictingEntries(ctx).length && !event.target.closest('[data-confirm-replace]')) {ctx.reviewOverlap=true;renderPicker();return;}
    commitDraft();
  }
}

/* ─────────── calendar export (.ics — Apple Calendar, Outlook, Google) ─────────── */

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function icsFold(line) {
  // RFC 5545 §3.1: fold content lines longer than 75 octets
  const out = [];
  let l = line;
  while (l.length > 74) { out.push(l.slice(0, 74)); l = " " + l.slice(74); }
  out.push(l);
  return out.join("\r\n");
}

function addDaysCompact(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10).replace(/-/g, "");
}

/* [1,2,3,5] → [[1,3],[5,5]] — one calendar event per contiguous run of days */
function contiguousRuns(days) {
  const sorted = [...days].sort((a, b) => a - b);
  const runs = [];
  let start = sorted[0], prev = sorted[0];
  for (const d of sorted.slice(1)) {
    if (d === prev + 1) { prev = d; continue; }
    runs.push([start, prev]); start = d; prev = d;
  }
  runs.push([start, prev]);
  return runs;
}

function planCalendarText() {
  const events = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  P.weeks.forEach((wk) => {
    state.children.forEach((c) => {
      planEntries(wk.id, c.id).forEach(entry => {
      const label = assignmentLabel(entry);
      const info = entryDays(entry, wk.id);
      const cost = entryCost(entry, wk.id);
      const p = entry.type === "camp" ? providerById(entry.campId) : null;
      const descBits = [];
      if (p) {
        descBits.push(`Venue: ${p.venue}${p.address ? ", " + p.address : ""}`);
        descBits.push(`Hours: ${hoursLabel(p)}`);
        descBits.push(`Booking: ${p.source.url}`);
      }
      if (cost && cost.value != null) descBits.push(`Cost for this booking: ${money(cost.value)}${cost.estimate ? " (est.)" : ""}`);
      else if (entry.type === "camp") descBits.push("Cost: confirm with provider");
      descBits.push("Planned with KidSorted (kidsorted.co.uk) — confirm details with the provider before the day.");
      contiguousRuns(info.days).forEach(([a, b]) => {
        events.push([
          "BEGIN:VEVENT",
          `UID:e17hc-${P.season}-${wk.id}-${c.id}-${entry.id}-${a}${b}@kidsorted.co.uk`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${addDaysCompact(wk.mon, a - 1)}`,
          `DTEND;VALUE=DATE:${addDaysCompact(wk.mon, b)}`,
          icsFold(`SUMMARY:${icsEscape(`${c.name}: ${label}`)}`),
          ...(p ? [icsFold(`LOCATION:${icsEscape(`${p.venue}${p.address ? ", " + p.address : ""}`)}`)] : []),
          icsFold(`DESCRIPTION:${icsEscape(descBits.join("\n"))}`),
          `STATUS:${!isBooking(entry) || entry.booked ? "CONFIRMED" : "TENTATIVE"}`,
          "TRANSP:TRANSPARENT",
          "END:VEVENT"
        ].join("\r\n"));
      });
      });
    });
  });
  if (!events.length) return null;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KidSorted//Holiday Camp Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsFold(`X-WR-CALNAME:KidSorted — ${P.seasonLabel}`),
    events.join("\r\n"),
    "END:VCALENDAR"
  ].join("\r\n") + "\r\n";
}

/* ────────────────────────── copy / print / clear ────────────────────────── */

function planSummaryText() {
  const lines = [`KIDSORTED — ${P.seasonLabel}`, ''];
  for (const c of state.children) {
    lines.push(`${c.name} (${ageLabel(c.age)})`);
    let total=0, unknown=0;
    for (const wk of P.weeks) {
      const entries=planEntries(wk.id,c.id);
      for (const day of weekDays(wk.id)) {
        const e=entries.find(e=>e.days.includes(day));
        lines.push(`${wk.dates} · ${DAY_LABELS[day-1]}: ${e ? assignmentLabel(e) + (isBooking(e) ? e.booked ? ' — booked' : ' — not booked' : '') : 'NEEDS COVER'}`);
      }
      for (const e of entries) {const cost=entryCost(e,wk.id);if(cost)total+=cost.value;else unknown++;}
    }
    lines.push(`Total: ${totalLabel(total,unknown)}`, '');
  }
  lines.push(`Source dates: ${D.updated}. Confirm prices and places with providers.`);
  return lines.join('\n');
}

function bindPlannerActions() {
  // The plain tool link — no names, no plan. Safe to broadcast to a group:
  // everyone who opens it gets their own private, blank planner.
  const toolUrl = () => location.origin + location.pathname;

  const tellBtn = document.querySelector("#tellParents");
  const tellWa = document.querySelector("#tellWa");
  if (tellBtn) {
    tellBtn.addEventListener("click", async () => {
      const url = toolUrl();
      const msg = `Free local tool for planning October holiday camps in and around Walthamstow — local camps with clearly marked confirmed and unconfirmed dates, plus a daily planner you fill in yourself: ${url}`;
      tellWa.href = "https://wa.me/?text=" + encodeURIComponent(msg);
      tellWa.hidden = false;
      try {
        await navigator.clipboard.writeText(url);
        tellBtn.textContent = "Tool link copied ✓";
      } catch {
        tellBtn.textContent = "Use WhatsApp →";
      }
      setTimeout(() => { tellBtn.textContent = "Share blank planner"; }, 2000);
    });
  }

  const shareBtn = document.querySelector("#sharePlan");
  const waShare = document.querySelector("#waShare");
  const SHARE_LABEL = "Share my plan (private)";
  shareBtn.addEventListener("click", async () => {
    if (!state.children.length) {
      shareBtn.textContent = "Add a child first";
      setTimeout(() => { shareBtn.textContent = SHARE_LABEL; }, 1800);
      return;
    }
    document.querySelector('#privateShareReview').hidden = false;
  });
  document.querySelector('#confirmPrivateShare').addEventListener('click', async () => {
    document.querySelector('#privateShareReview').hidden = true;
    const url = planShareUrl();
    waShare.href = "https://wa.me/?text=" + encodeURIComponent(`Our ${P.seasonLabel} holiday camp plan — daily cover and costs: ${url}`);
    waShare.hidden = false;
    try {
      await navigator.clipboard.writeText(url);
      shareBtn.textContent = "Private link copied ✓";
    } catch {
      shareBtn.textContent = "Copy blocked — use WhatsApp";
    }
    setTimeout(() => { shareBtn.textContent = SHARE_LABEL; }, 2200);
  });

  document.querySelector("#copyPlan").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(planSummaryText());
      btn.textContent = "Copied ✓";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy summary"; }, 1800);
  });

  document.querySelector("#printPlan").addEventListener("click", () => window.print());

  document.querySelector("#calendarPlan").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const ics = planCalendarText();
    if (!ics) {
      btn.textContent = "Nothing planned yet";
      setTimeout(() => { btn.textContent = "Add to calendar"; }, 1800);
      return;
    }
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "e17-holiday-camp-plan.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    btn.textContent = "Downloaded ✓";
    setTimeout(() => { btn.textContent = "Add to calendar"; }, 1800);
  });

  document.querySelector("#clearPlan").addEventListener("click", () => {
    if (!Object.keys(state.plan).length) return;
    if (confirm("Clear all planned days? Your children and shortlist stay.")) {
      state.plan = {};
      saveState();
      renderPlanner();
    }
  });
}

/* ────────────────── shareable plan links (#plan=…) ────────────────── */

function base64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value) {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/* Children + week assignments only — shortlist and checklist stay private. */
function planShareUrl() {
  const plan = {};
  Object.entries(state.plan).forEach(([weekId, row]) => {
    if (row && Object.keys(row).length) plan[weekId] = row;
  });
  const payload = {
    v: 2,
    season: P.season,
    children: state.children.map((c) => ({ id: c.id, name: c.name, age: c.age })),
    plan
  };
  return location.href.split("#")[0] + "#plan=" + base64urlEncode(JSON.stringify(payload));
}

/* Validate an incoming #plan= hash into {children, plan}, or null. Every field
 * is whitelisted — a malformed link must never corrupt local state. */
function parseSharedPlan(hash) {
  const m = /^#plan=([A-Za-z0-9_-]+)$/.exec(hash || '');
  if (!m || m[1].length > 100000) return null;
  try {
    const data=JSON.parse(base64urlDecode(m[1]));
    if (![1,2].includes(data.v) || data.season!==P.season || !Array.isArray(data.children)) return null;
    const ids=new Set();
    const children=data.children.filter(c=>c && /^[a-zA-Z0-9_-]{1,60}$/.test(c.id) && Number.isFinite(c.age) && !ids.has(c.id) && ids.add(c.id)).slice(0,6).map(c=>({id:c.id,name:String(c.name||'Child').slice(0,20),age:Math.round(Math.max(2,Math.min(17.99,c.age))*12)/12}));
    if (!children.length) return null;
    return {children,plan:normalizePlan(data.plan,children)};
  } catch {return null;}
}

function applySharedPlan(shared, mode) {
  if (mode === "replace") {
    state.children = shared.children.map((c, i) => ({ ...c, color: CHILD_COLORS[i % CHILD_COLORS.length] }));
    state.plan = shared.plan;
  } else {
    // Merge adds children and fills free dates while preserving existing cover.
    shared.children.forEach((c) => {
      if (!childById(c.id) && state.children.length < 6) {
        state.children.push({ ...c, color: CHILD_COLORS[state.children.length % CHILD_COLORS.length] });
      }
    });
    Object.entries(shared.plan).forEach(([weekId,row])=>{
      for (const [childId,incoming] of Object.entries(row)) {
        if (!childById(childId)) continue;
        // Merge fills free dates only. Existing cover always wins.
        const current=planEntries(weekId,childId), occupied=new Set(current.flatMap(e=>e.days));
        const added=incoming.flatMap(e=>{
          const days=e.days.filter(d=>!occupied.has(d));
          if (!days.length || (e.type==='camp' && plannerOf(providerById(e.campId)||{}).fullWeekOnly && days.length!==e.days.length)) return [];
          const copy={...e,id:bookingId(),days};
          if(days.length!==e.days.length) {delete copy.myCost;if(copy.costBasis!=='day')delete copy.cost;}
          return [copy];
        });
        state.plan[weekId] ||= {};state.plan[weekId][childId]=[...current,...added];
      }
    });
  }
  saveState();
  renderChildren();
  renderPlanner();
}

function offerSharedPlan() {
  const shared = parseSharedPlan(location.hash);
  pendingShared = shared;
  document.querySelector('#legacyShareNotice').hidden = true;
  if (!shared) {
    els.shareBanner.hidden = true;
    if (location.hash.startsWith('#plan=')) {
      const notice=document.querySelector('#legacyShareNotice');notice.hidden=false;
      let old=false;
      try {const data=JSON.parse(base64urlDecode(location.hash.slice(6)));old=data.v===1 && (!data.season || data.season==='summer-2026');}catch{}
      document.querySelector('#legacyShareText').textContent=old ? 'This link is for summer 2026. Open the archived plan to view or export it; your October plan stays here.' : 'This plan link is invalid or belongs to another holiday. Your current plan has not changed.';
      const link=document.querySelector('#legacyShareLink');link.hidden=!old;link.href='previous-plans.html'+location.hash;
    }
    return;
  }
  const names = shared.children.map((c) => `${c.name} (${ageLabel(c.age)})`).join(", ");
  const weeks = Object.keys(shared.plan).length;
  els.shareBannerText.textContent =
    `Someone sent you a ${P.seasonLabel} plan for ${names} — ${weeks} week${weeks === 1 ? "" : "s"} planned. ` +
    `Replace loads their plan. Merge adds children and fills free days; your existing cover wins. Shortlist and checklist stay on this device.`;
  els.shareMerge.hidden = !state.children.length;
  els.shareBanner.hidden = false;
}

function closeSharedPlanOffer() {
  pendingShared = null;
  els.shareBanner.hidden = true;
  // Drop the hash so a refresh doesn't re-offer (history API can throw on file://).
  if (/^#plan=/.test(location.hash)) {
    try { history.replaceState(null, "", location.pathname + location.search); }
    catch (e) { location.hash = ""; }
  }
}

/* ────────────────────────── HAF, sources, money meta ────────────────────────── */

function hafMatches(entry) {
  const areaOk = state.area === "all" || normalize(entry.area).includes(normalize(state.area));
  return areaOk && ageMatches(entry) && textMatches(entry);
}

function renderHaf() {
  const all = D.hafSnapshot;
  const matches = state.hafShowAll ? all : all.filter(hafMatches);
  const rows = matches.map((entry) => `
    <tr class="${/summer/i.test(entry.name) ? "haf-summer" : ""}">
      <td>${escapeHtml(entry.name)}</td>
      <td>${escapeHtml(entry.venue)}</td>
      <td>${escapeHtml(entry.ages)}</td>
      <td>${escapeHtml(entry.area)}</td>
    </tr>
  `).join("");

  // When the directory filters hide HAF rows, say so — "Show all" lifts only
  // the HAF filtering; the directory filters above are untouched.
  let notice = "";
  if (!state.hafShowAll && matches.length < all.length) {
    const message = matches.length
      ? `Showing ${matches.length} of ${all.length} free HAF sessions — filtered by your search/age above.`
      : `No free HAF sessions match your search/age filters above — all ${all.length} are hidden, not gone.`;
    notice = `<tr class="haf-filter-note"><td colspan="4">${escapeHtml(message)}
      <button class="btn-sub" type="button" data-haf-showall="1">Show all</button></td></tr>`;
  }
  els.hafTable.innerHTML = rows + notice || '<tr><td colspan="4">No October HAF sessions verified yet. Check the live Eequ list above.</td></tr>';
}

function renderSources() {
  const allSources = D.providers.flatMap((p) => [p.source, ...(p.secondarySources || [])]);
  const deduped = new Map();
  allSources.forEach((s) => { if (!deduped.has(s.url)) deduped.set(s.url, s); });
  els.sourceGrid.innerHTML = [...deduped.values()]
    .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.label)}</a>`)
    .join("");
}

function renderMoneyMeta() {
  const haf = D.providers.filter((p) => (p.funding || []).includes("Free/HAF")).length;
  const tfc = D.providers.filter((p) => (p.funding || []).includes("Tax-Free Childcare") || (p.funding || []).includes("Childcare vouchers"));
  const sib = D.providers.filter((p) => (p.funding || []).includes("Sibling discount"));
  els.hafProviderCount.textContent = `${haf} of the ${D.providers.length} entries in this directory have HAF-funded routes.`;
  els.tfcProviderCount.textContent = `${tfc.length} directory entries advertise Tax-Free Childcare or voucher payment.`;
  els.siblingProviderCount.textContent = sib.length
    ? `Advertising sibling discounts: ${sib.map((p) => p.name.split(" ").slice(0, 2).join(" ")).join(", ")}.`
    : "";
}

/* ────────────────────────── checklist ────────────────────────── */

const CHECKLIST = [
  { id: "dates", title: "Exact dates & current price", why: "Listings change between holidays — get this October's price and dates in writing." },
  { id: "ofsted", title: "Ofsted registration number", why: "You need it (and the provider signed up) to pay with Tax-Free Childcare or vouchers." },
  { id: "food", title: "Lunch & snack arrangements", why: "Included, a paid add-on, or packed lunch? Ask about the nut/allergy policy too." },
  { id: "times", title: "Drop-off and pick-up windows", why: "Exact times, who signs in/out, and the late-collection policy and fees." },
  { id: "collect", title: "Who's allowed to collect", why: "Named adults and collection passwords — sort this before day one, not at 5:55pm." },
  { id: "kit", title: "First-day kit list", why: "Water bottle, waterproof coat, layers, trainers and spare clothes; check the provider’s kit list." },
  { id: "send", title: "SEND & medical conversation", why: "1:1 support, medication storage, allergy plans and inhalers — speak to the lead, not the booking form." },
  { id: "groups", title: "Age groups & friends", why: "How groups are split and whether siblings or school friends can be placed together." },
  { id: "cancel", title: "Cancellation & swap policy", why: "Refund or credit if your child is ill or plans change? Any swap fees?" },
  { id: "discount", title: "Sibling / early-bird discounts", why: "Ask explicitly — several local providers offer them and not all advertise it." },
  { id: "phones", title: "Phone & photo policy", why: "What happens to phones during the day, and set your photo-consent preference." },
  { id: "reconfirm", title: "Re-confirm the week before", why: "A 2-minute check of venue and start time the Friday before saves a chaotic Monday." }
];

function renderChecklist() {
  els.checklistList.innerHTML = CHECKLIST.map((item) => {
    const done = state.checks.includes(item.id);
    return `<li>
      <label class="check-item ${done ? "is-done" : ""}">
        <input type="checkbox" data-check="${item.id}" ${done ? "checked" : ""}>
        <span><strong>${escapeHtml(item.title)}</strong><span class="why">${escapeHtml(item.why)}</span></span>
      </label>
    </li>`;
  }).join("");
  els.checklistCount.textContent = `${state.checks.length} of ${CHECKLIST.length} ticked`;
}

/* ────────────────────────── stats + selects ────────────────────────── */

function populateSelect(select, label, values) {
  select.innerHTML = [
    `<option value="all">All ${label}</option>`,
    ...values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
  ].join("");
}

/* ────────────────────────── events & init ────────────────────────── */

function applyFilters() {
  // Any filter change re-collapses the HAF table.
  state.hafShowAll = false;
  renderProviders();
  renderHaf();
}

function bindAgeChips() {
  document.querySelectorAll(".age-chip[data-age]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.age === state.age ? "true" : "false");
    button.onclick = () => {
      state.age = button.dataset.age;
      document.querySelectorAll(".age-chip[data-age]").forEach((chip) => {
        chip.classList.toggle("is-active", chip.dataset.age === state.age);
        chip.setAttribute("aria-pressed", chip.dataset.age === state.age ? "true" : "false");
      });
      applyFilters();
    };
  });
}

function resetFilters() {
  clearTimeout(searchDebounceTimer); // a pending debounced search must not undo the reset
  Object.assign(state, { search: "", area: "all", category: "all", funding: "all", age: "any", dayLength: "all", price: "all", confirmedOnly: false, sort: "confirmed" });
  els.searchInput.value = "";
  els.areaFilter.value = "all";
  els.categoryFilter.value = "all";
  els.fundingFilter.value = "all";
  els.dayLengthFilter.value = "all";
  els.priceFilter.value = "all";
  els.sortSelect.value = "confirmed";
  els.confirmedOnly.checked = false;
  document.querySelectorAll(".age-chip[data-age]").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.age === "any");
    chip.setAttribute("aria-pressed", chip.dataset.age === "any" ? "true" : "false");
  });
  applyFilters();
}

function init() {
  loadState();

  // Age select 2–17
  els.childAge.innerHTML = `<option value="" disabled selected>Age…</option>` +
    Array.from({ length: 16 }, (_, i) => i + 2).map((a) => `<option value="${a}">${a}</option>`).join("");

  const areas = uniqueSorted(D.providers.flatMap((p) => p.areas));
  const categories = uniqueSorted(D.providers.flatMap((p) => p.categories));
  const funding = uniqueSorted(D.providers.flatMap((p) => p.funding));
  populateSelect(els.areaFilter, "areas", areas);
  populateSelect(els.categoryFilter, "activities", categories);
  populateSelect(els.fundingFilter, "funding", funding);

  els.searchInput.addEventListener("input", (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      applyFilters();
    }, 200);
  });
  els.areaFilter.addEventListener("change", (e) => { state.area = e.target.value; applyFilters(); });
  els.categoryFilter.addEventListener("change", (e) => { state.category = e.target.value; applyFilters(); });
  els.fundingFilter.addEventListener("change", (e) => { state.funding = e.target.value; applyFilters(); });
  els.dayLengthFilter.addEventListener("change", (e) => { state.dayLength = e.target.value; applyFilters(); });
  els.priceFilter.addEventListener("change", (e) => { state.price = e.target.value; applyFilters(); });
  els.sortSelect.addEventListener("change", (e) => { state.sort = e.target.value; applyFilters(); });
  els.confirmedOnly.addEventListener("change", (e) => { state.confirmedOnly = e.target.checked; applyFilters(); });
  document.querySelector("#resetFilters").addEventListener("click", resetFilters);
  bindAgeChips();

  // On small screens start with the extra filters collapsed (guard: the
  // <details id="moreFilters"> may not exist in every build of the page).
  const moreFilters = document.querySelector("#moreFilters");
  if (moreFilters && MOBILE_MQ.matches) moreFilters.removeAttribute("open");

  // The planner empty-state gets a real button: scroll to and focus the child form.
  if (els.plannerEmpty && !els.plannerEmpty.querySelector("button")) {
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "btn btn-add planner-empty-btn";
    startBtn.textContent = "Add a child to start";
    startBtn.addEventListener("click", () => {
      document.querySelector("#children").scrollIntoView({ behavior: "smooth" });
      els.childName.focus({ preventScroll: true });
    });
    els.plannerEmpty.appendChild(startBtn);
  }

  // Children
  els.childForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const age = Number(els.childAge.value) + Number(document.querySelector("#childMonths").value) / 12;
    if (!Number.isFinite(age) || age < 2 || state.children.length >= 6) return;
    addChild(els.childName.value.trim(), age);
    els.childName.value = "";
    els.childAge.selectedIndex = 0;
    document.querySelector("#childMonths").value = "0";
    els.childName.focus();
    // If they tapped "+ Add to plan" before any child existed, resume that flow.
    if (pendingCampId) {
      const campId = pendingCampId;
      pendingCampId = null;
      const gateMsg = document.querySelector("#childGateMsg");
      if (gateMsg) gateMsg.remove();
      if (providerById(campId)) openCampAssign(campId);
    }
  });

  // Delegated clicks: shortlist hearts, add-to-plan, child remove, planner cells
  document.body.addEventListener("click", (event) => {
    const heart = event.target.closest("[data-shortlist]");
    if (heart) {
      const id = heart.dataset.shortlist;
      const wasHeart = heart.classList.contains("heart-btn");
      state.shortlist = state.shortlist.includes(id)
        ? state.shortlist.filter((x) => x !== id)
        : [...state.shortlist, id];
      saveState();
      renderProviders();
      renderCompare();
      if (wasHeart) {
        // The grid was re-rendered — put focus back on this camp's new heart button.
        const newHeart = document.querySelector(`.heart-btn[data-shortlist="${cssEsc(id)}"]`);
        if (newHeart) newHeart.focus();
      }
      return;
    }
    const add = event.target.closest("[data-addplan]");
    if (add) { openCampAssign(add.dataset.addplan); return; }

    const hafShowAllBtn = event.target.closest("[data-haf-showall]");
    if (hafShowAllBtn) {
      state.hafShowAll = true;
      renderHaf();
      return;
    }
    const removeChildBtn = event.target.closest("[data-removechild]");
    if (removeChildBtn) {
      const child = childById(removeChildBtn.dataset.removechild);
      if (child && confirm(`Remove ${child.name} and their assignments?`)) {
        removeChild(child.id);
      }
      return;
    }
    const day = event.target.closest('[data-open-day]');
    if (day) { openCellPicker(day.dataset.week,day.dataset.child,day.dataset.openDay); return; }
    const edit = event.target.closest('[data-edit-booking]');
    if (edit) {
      const e = planEntries(edit.dataset.week,edit.dataset.child).find(e=>e.id===edit.dataset.editBooking);
      if (e) { pickerReturnFocus = `[data-edit-booking="${e.id}"]`;startDraft(edit.dataset.week,edit.dataset.child,{...e},e.days,e.id);els.pickerDialog.showModal(); } return;
    }
    const toggle = event.target.closest('[data-booking-toggle]');
    if (toggle) {
      writeEntries(toggle.dataset.week,toggle.dataset.child,planEntries(toggle.dataset.week,toggle.dataset.child).map(e=>e.id===toggle.dataset.bookingToggle ? {...e,booked:!e.booked} : e));
    }
  });

  // Picker
  els.pickerBody.addEventListener("click", handlePickerClick);
  els.pickerClose.addEventListener("click", () => els.pickerDialog.close());
  els.pickerDialog.addEventListener("click", (e) => {
    if (e.target === els.pickerDialog) els.pickerDialog.close();
  });
  els.pickerDialog.addEventListener("close", () => {
    if (pickerCtx && pickerCtx.mode === "camp") renderPlanner();
    // The close event is queued async — if the picker was already reopened
    // for another cell, don't clobber the new context.
    if (!els.pickerDialog.open) {
      pickerCtx = null;
      // Re-renders destroyed the originating button — re-focus its replacement
      // (same data attributes) so keyboard/screen-reader users aren't dropped.
      // Deferred a tick: the browser's own focus restore runs after this event
      // and would otherwise send focus to a stale (or removed) element.
      if (pickerReturnFocus) {
        const selector = pickerReturnFocus;
        pickerReturnFocus = null;
        setTimeout(() => {
          if (els.pickerDialog.open) return; // reopened for another cell meanwhile
          const returnEl = document.querySelector(selector);
          if (returnEl) returnEl.focus();
        }, 0);
      }
    }
  });

  // Checklist
  els.checklistList.addEventListener("change", (e) => {
    const box = e.target.closest("[data-check]");
    if (!box) return;
    const id = box.dataset.check;
    state.checks = box.checked ? [...new Set([...state.checks, id])] : state.checks.filter((x) => x !== id);
    saveState();
    renderChecklist();
  });

  bindPlannerActions();

  // Shared-plan links (#plan=…) — always offered, never auto-applied.
  els.shareUse.addEventListener("click", () => {
    if (pendingShared) {
      applySharedPlan(pendingShared, "replace");
      document.querySelector("#plan").scrollIntoView({ behavior: "smooth" });
    }
    closeSharedPlanOffer();
  });
  els.shareMerge.addEventListener("click", () => {
    if (pendingShared) {
      applySharedPlan(pendingShared, "merge");
      document.querySelector("#plan").scrollIntoView({ behavior: "smooth" });
    }
    closeSharedPlanOffer();
  });
  els.shareDismiss.addEventListener("click", () => closeSharedPlanOffer());
  window.addEventListener("hashchange", offerSharedPlan);

  renderChildren();
  renderMoneyMeta();
  renderSources();
  renderChecklist();
  renderCompare();
  renderPlanner();
  applyFilters();
  offerSharedPlan();
}

init();

// Exposed for the automated test suite only — not a public API.
window.E17_DEBUG = { planCalendarText };
