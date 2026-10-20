/* GSDN Site Delivery Dashboard · reads the GSDN Master workbook in the browser.
   The Master computes milestones, phase gates and status; this page only reads and presents them. */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DAY = 864e5;
const nf = new Intl.NumberFormat("en-US");
const fmt = n => n == null || isNaN(n) ? "—" : nf.format(Math.round(n));
const pct = (a, b) => b ? a / b : null;
const P = (v, d = 0) => v == null || isNaN(v) ? "—" : (v * 100).toFixed(d) + "%";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dstr = d => d ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "—";
const dshort = d => d ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` : "—";
const iso = d => d ? d.toISOString().slice(0, 10) : "";
const days = (a, b) => (a && b) ? Math.round((a - b) / DAY) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const uniq = a => [...new Set(a)];
const by = (f, dir = 1) => (x, y) => { const a = f(x), b = f(y); return (a > b ? 1 : a < b ? -1 : 0) * dir; };
const svgIcon = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  sun: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svgIcon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  print: svgIcon('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  file: svgIcon('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>'),
  x: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
  dl: svgIcon('<path d="M12 4v11m0 0l-4-4m4 4l4-4"/><path d="M4 19h16"/>'),
};
const MARK = `<svg viewBox="0 0 32 32" fill="none"><circle cx="6" cy="22" r="3.2" fill="var(--brand)"/><circle cx="16" cy="12" r="3.2" fill="var(--cw)"/><circle cx="26" cy="20" r="3.2" fill="var(--te)"/><path d="M8.6 20 13.6 14M18.6 13.4l4.9 5" stroke="var(--ink2)" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/* ================================================================ schema
   Every Master column is found by its three header rows (group · sub-group · header), never by position. */
const SCHEMA = {
  id: ["rf & design", "identification", "site id"], name: ["rf & design", "identification", "site name"],
  ownerId: ["rf & design", "identification", "site owner id"],
  region: ["rf & design", "identification", "region"], sub: ["rf & design", "identification", "sub region"],
  cluster: ["rf & design", "identification", "cluster id"],
  lat: ["rf & design", "coordinates", "latitude"], lng: ["rf & design", "coordinates", "longitude"],
  type: ["rf & design", "classification", "site type"], siteScen: ["rf & design", "classification", "site scenario"],
  uplink: ["rf & design", "classification", "site uplink"],
  owner: ["rf & design", "tower information", "tower owner"], existNew: ["rf & design", "tower information", "existing or new"],
  rtgf: ["rf & design", "tower information", "rt or gf"],
  relB: ["rf & design", "baseline", "site release date"], relA: ["rf & design", "milestone", "site release date"],
  g_precw: ["phase gate", "pre-cw readiness", ""],
  phase: ["pre-cw", "project phase", ""], batch: ["pre-cw", "delivery batch", ""], scen: ["pre-cw", "delivery scenario", ""],
  sowTower: ["pre-cw", "cw sow", "tower erection"], sowAdp: ["pre-cw", "cw sow", "site adaption"],
  sowGecol: ["pre-cw", "cw sow", "gecol power"], sowHlc: ["pre-cw", "cw sow", "hlc fiber"],
  teFull: ["pre-cw", "te sow", "full scope"], teRouter: ["pre-cw", "te sow", "ip router only"],
  dmodel: ["pre-cw", "cw procurement", "cw delivery model"], prStatus: ["pre-cw", "cw procurement", "pr status"],
  poStatus: ["pre-cw", "cw procurement", "po / wo status"], contractor: ["pre-cw", "cw procurement", "contractor name"],
  cwAccess: ["pre-cw", "cw access", "cw access date"], cwSE: ["pre-cw", "cw survey", "aat se name"],
  cwSurvey: ["pre-cw", "cw survey", "actual date"], repSub: ["pre-cw", "cw survey", "submitted date"],
  repApp: ["pre-cw", "cw survey", "approved date"], cwDnSub: ["pre-cw", "cw dn", "submitted date"],
  cwDnApp: ["pre-cw", "cw dn", "approved date"],
  precwB: ["pre-cw", "baseline", "pre-cw completion date"], precwA: ["pre-cw", "milestone", "pre-cw completion date"],
  g_cw: ["phase gate", "cw readiness", ""],
  cwMos: ["actual cw", "cw mos", "actual date"], cwStart: ["actual cw", "cw installation status", "actual start date"],
  cwB: ["actual cw", "baseline", "cw completion date"], cwA: ["actual cw", "milestone", "cw completion date"],
  g_rfi: ["phase gate", "rfi readiness", ""],
  pacPlan: ["rfi", "cw preliminary acceptance", "cw pac planned date"], snagF: ["rfi", "cw preliminary acceptance", "snags found"],
  snagC: ["rfi", "cw preliminary acceptance", "snags cleared"], cwAsb: ["rfi", "cw preliminary acceptance", "cw as-built submitted"],
  pacA: ["rfi", "cw preliminary acceptance", "cw pac actual date"],
  gecol: ["rfi", "gecol status", ""], hlc: ["rfi", "hlc fiber status", ""],
  rfiB: ["rfi", "baseline", "site rfi date"], rfiA: ["rfi", "milestone", "site rfi date"],
  g_te: ["phase gate", "te installation readiness", ""],
  teAccess: ["te installation", "te access", "te access date"], teSurvey: ["te installation", "te survey", "survey date"],
  vendor: ["te installation", "te survey", "vendor name"], teSE: ["te installation", "te survey", "aat se name"],
  teDnSub: ["te installation", "te dn", "submitted date"], teDnApp: ["te installation", "te dn", "approved date"],
  teMos: ["te installation", "te mos", "actual date"], teStart: ["te installation", "te installation status", "actual start date"],
  teB: ["te installation", "baseline", "te completion date"], teA: ["te installation", "milestone", "te completion date"],
  g_onair: ["phase gate", "on-air readiness", ""],
  comm: ["on-air", "commissioning", "commissioning date"], mwAlign: ["on-air", "commissioning", "mw alignment date"],
  rslDev: ["on-air", "commissioning", "rsl deviation (db)"], integ: ["on-air", "commissioning", "integration date"],
  cutRes: ["on-air", "cutover", "cutover result"], rollback: ["on-air", "cutover", "rollback count"],
  onairB: ["on-air", "baseline", "on-air date"], onairA: ["on-air", "milestone", "on-air date"],
  g_tepac: ["phase gate", "te pac readiness", ""],
  ssvDate: ["te pac", "ssv", "ssv date"], ssvRes: ["te pac", "ssv", "ssv result"], hwid: ["te pac", "hwid date", ""],
  eir: ["te pac", "site standalone", "eir date"], pat: ["te pac", "network test", "pat date"],
  teAsb: ["te pac", "as-built date", ""], teSnagF: ["te pac", "te snags", "snags found"], teSnagC: ["te pac", "te snags", "snags cleared"],
  tepacB: ["te pac", "baseline", "te pac date"], tepacA: ["te pac", "milestone", "te pac date"],
  g_kpi: ["phase gate", "cluster optimization", ""], clusterOpt: ["cluster optimization", "cluster optimization date", ""],
  kpiB: ["cluster optimization", "baseline", "kpi acceptance date"], kpiA: ["cluster optimization", "milestone", "kpi acceptance date"],
  g_hoto: ["phase gate", "hoto readiness", ""], matRec: ["soft / commercial", "material reconciliation", ""],
  hotoPkg: ["soft / commercial", "hoto package date", ""],
  hotoB: ["soft / commercial", "baseline", "hoto date"], hotoA: ["soft / commercial", "milestone", "hoto date"],
  g_fin: ["phase gate", "final closure readiness", ""],
  dlpEnd: ["final closure", "cw dlp / fac", "cw dlp end date"], cwFac: ["final closure", "cw dlp / fac", "cw fac date"],
  teFac: ["final closure", "te dlp / fac", "te fac date"],
  finB: ["final closure", "baseline", "final closure date"], finA: ["final closure", "milestone", "final closure date"],
  disCwRfd: ["dismantle", "cw dismantle", "site cw rfd"], disCwAct: ["dismantle", "cw dismantle", "actual date"],
  disCwRn: ["dismantle", "cw dismantle", "cw rn date"], disTeRfd: ["dismantle", "te dismantle", "site te rfd"],
  disTeAct: ["dismantle", "te dismantle", "actual date"], disTeRn: ["dismantle", "te dismantle", "te rn date"],
  cur: ["status", "progress", "current milestone"], next: ["status", "progress", "next milestone"],
  status: ["status", "progress", "overall status"],
  issue: ["status", "issue & remark", "pending issue"], issueOwner: ["status", "issue & remark", "issue owner"],
  issueDate: ["status", "issue & remark", "issue raised date"], issueStatus: ["status", "issue & remark", "issue status"],
  remark: ["status", "issue & remark", "remark"],
};
const REQUIRED = ["id", "region", "relA", "precwA", "cwA", "rfiA", "teA", "onairA", "tepacA", "kpiA", "hotoA", "finA", "status"];
const DATE_KEYS = new Set(["relB", "relA", "g_precw", "cwAccess", "cwSurvey", "repSub", "repApp", "cwDnSub", "cwDnApp", "precwB",
  "precwA", "g_cw", "cwMos", "cwStart", "cwB", "cwA", "g_rfi", "pacPlan", "pacA", "rfiB", "rfiA", "g_te", "teAccess", "teSurvey",
  "teDnSub", "teDnApp", "teMos", "teStart", "teB", "teA", "g_onair", "comm", "mwAlign", "integ", "onairB", "onairA", "g_tepac",
  "ssvDate", "hwid", "eir", "pat", "teAsb", "tepacB", "tepacA", "g_kpi", "clusterOpt", "kpiB", "kpiA", "g_hoto", "matRec",
  "hotoPkg", "hotoB", "hotoA", "g_fin", "dlpEnd", "cwFac", "teFac", "finB", "finA", "disCwAct", "disCwRn", "disTeAct",
  "disTeRn", "issueDate"]);

/* the ten Master milestones in delivery order */
const MS = [
  { k: "rel", n: "Site Release", s: "Release", a: "relA", b: "relB", g: null, sec: "cw" },
  { k: "precw", n: "PRE-CW Completion", s: "PRE-CW", a: "precwA", b: "precwB", g: "g_precw", sec: "cw" },
  { k: "cw", n: "CW Completion", s: "CW Complete", a: "cwA", b: "cwB", g: "g_cw", sec: "cw" },
  { k: "rfi", n: "Site RFI", s: "RFI", a: "rfiA", b: "rfiB", g: "g_rfi", sec: "cw" },
  { k: "te", n: "TE Completion", s: "TE Installed", a: "teA", b: "teB", g: "g_te", sec: "te" },
  { k: "onair", n: "On-Air", s: "On-Air", a: "onairA", b: "onairB", g: "g_onair", sec: "te" },
  { k: "tepac", n: "TE PAC", s: "TE PAC", a: "tepacA", b: "tepacB", g: "g_tepac", sec: "te" },
  { k: "kpi", n: "KPI Acceptance", s: "KPI Accept.", a: "kpiA", b: "kpiB", g: "g_kpi", sec: "te" },
  { k: "hoto", n: "HOTO", s: "HOTO", a: "hotoA", b: "hotoB", g: "g_hoto", sec: "te" },
  { k: "fin", n: "Final Closure", s: "Closure", a: "finA", b: "finB", g: "g_fin", sec: "te" },
];
const MSI = Object.fromEntries(MS.map((m, i) => [m.k, i]));
const STAGE_COL = { none: "#61757f", rel: "#8e7cc3", precw: "#c58a5c", cw: "#e3a548", rfi: "#e6cb57", te: "#63b4e6",
  onair: "#3fc1d9", tepac: "#35b59e", kpi: "#33c48d", hoto: "#2aa46e", fin: "#1f8257" };
/* readiness hints shown when a phase gate is not yet met (what the Master gate waits for) */
const GATE_HINT = {
  precw: "Pre-CW readiness: procurement (PR / PO), CW access and survey",
  cw: "CW readiness: CW access and PTW permits, PO / WO, report approval",
  rfi: "RFI readiness: CW PAC, GECOL power and HLC fiber where in scope",
  te: "TE readiness: TE access and PTW, DN approval, material dispatch",
  onair: "On-Air readiness: commissioning, MW alignment and integration",
  tepac: "TE PAC readiness: SSV, HWID, EIR, PAT and As-Built",
  kpi: "KPI readiness: cluster optimization and KPI source",
  hoto: "HOTO readiness: launch, material reconciliation, HOTO package",
  fin: "Closure readiness: CW and TE FAC, contractual obligations",
};

/* ================================================================ state */
const S = {
  wb: null, file: "", sites: [], rpt: null, ps: null, sla: null, risks: [], dq: [], qi: [], warn: [],
  page: "ov", tab: { cw: "cockpit", te: "cockpit" }, theme: "dark",
  F: { phase: "", region: "", type: "", owner: "", cluster: "", batch: "", scen: "", contractor: "", vendor: "", from: "", to: "" },
  mapOff: new Set(), sort: {}, search: {},
};

/* ================================================================ value helpers */
function toDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  if (typeof v === "number") return v > 20000 && v < 90000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY) : null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s.slice(0, 10) + "T00:00:00Z"); return isNaN(d) ? null : d; }
  return null;
}
const isNA = v => typeof v === "string" && norm(v) === "n/a";
const txt = v => v == null ? "" : String(v).trim();
const yes = v => norm(v) === "yes";
const doneTxt = v => norm(v) === "done";

/* ================================================================ workbook reading */
function sheetRows(name) {
  const wb = S.wb, sn = wb.SheetNames.find(n => norm(n) === norm(name));
  if (!sn) return null;
  return XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: true });
}
function locate(rows) {
  const r0 = rows[0] || [], r1 = rows[1] || [], r2 = rows[2] || [];
  const w = Math.max(r0.length, r1.length, r2.length);
  const cols = []; let g1 = "", g2 = "";
  for (let c = 0; c < w; c++) {
    if (r0[c] != null && r0[c] !== "") { g1 = norm(r0[c]); g2 = ""; }
    if (r1[c] != null && r1[c] !== "") g2 = norm(r1[c]);
    cols.push({ g1, g2, h: norm(r2[c]) });
  }
  const map = {}, miss = [];
  for (const [k, [a, b, h]] of Object.entries(SCHEMA)) {
    const i = cols.findIndex(x => x.g1.startsWith(a) && x.g2.startsWith(b) && x.h === h);
    if (i < 0) miss.push(k); else map[k] = i;
  }
  return { map, miss };
}
function readMaster() {
  const rows = sheetRows("Master");
  if (!rows) throw new Error("The workbook has no sheet named Master. Load the GSDN Master workbook.");
  const { map, miss } = locate(rows);
  const req = miss.filter(k => REQUIRED.includes(k));
  if (req.length) throw new Error("This is not the new GSDN Master template. Columns not found:\n" +
    req.map(k => "· " + SCHEMA[k].filter(Boolean).join(" › ")).join("\n"));
  if (miss.length) S.warn.push(`${miss.length} optional Master column(s) not found; the views that use them are left out.`);
  const out = [];
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const id = row[map.id];
    if (typeof id !== "string" || !id.trim()) continue;
    const o = {};
    for (const [k, i] of Object.entries(map)) {
      const v = row[i];
      o[k] = DATE_KEYS.has(k) ? (isNA(v) ? "N/A" : toDate(v)) : (v == null ? "" : v);
    }
    o.id = id.trim();
    out.push(o);
  }
  if (!out.length) throw new Error("The Master sheet has no site rows (Site ID is empty in every row).");
  const calc = out.filter(o => txt(o.status) || txt(o.cur)).length;
  if (calc === 0) throw new Error("The Master has site rows but no calculated values (Overall Status and Current Milestone are empty).\n" +
    "Open the file in Excel, press Calculate Now (F9), save it, and load it again.");
  return out;
}
function cellByName(name) {
  const names = (S.wb.Workbook && S.wb.Workbook.Names) || [];
  const n = names.find(x => norm(x.Name) === norm(name) && x.Sheet == null);
  if (!n) return undefined;
  const m = /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)$/.exec(n.Ref || "");
  if (!m) return undefined;
  const ws = S.wb.Sheets[m[1]]; if (!ws) return undefined;
  const c = ws[m[2] + m[3]]; return c ? c.v : undefined;
}
function findLabel(rows, re, maxR = 60) {
  for (let r = 0; r < Math.min(rows.length, maxR); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) if (typeof row[c] === "string" && re.test(row[c])) return [r, c];
  }
  return null;
}
function readReportDate() {
  let d = toDate(cellByName("RptDate"));
  if (!d) {
    const rows = sheetRows("Setting");
    const at = rows && findLabel(rows, /^report date$/i);
    if (at) d = toDate(rows[at[0]][at[1] + 1]);
  }
  if (!d) S.warn.push("Report Date is not set in Setting; today's date is used.");
  const t = new Date(); return d || new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}
function readProjectStatus() {
  const rows = sheetRows("Project Status"); if (!rows) return null;
  const num = v => typeof v === "number" ? v : null;
  const below = re => { const at = findLabel(rows, re); return at ? num((rows[at[0] + 1] || [])[at[1]]) : null; };
  const ps = { actual: below(/^ACTUAL PROGRESS$/), planned: below(/^PLANNED PROGRESS$/), spi: below(/^SPI/),
    coverage: below(/^PLAN COVERAGE$/), acts: [] };
  const hd = findLabel(rows, /^activity$/i);
  if (hd) {
    const h = rows[hd[0]].map(norm), ci = n => h.indexOf(n);
    const iW = ci("weight"), iA = ci("actual %"), iP = ci("planned %");
    for (let r = hd[0] + 1; r < rows.length; r++) {
      const row = rows[r] || [], name = txt(row[hd[1]]);
      if (!name || /^total/i.test(name)) break;
      ps.acts.push({ no: txt(row[hd[1] - 1]), name, w: num(row[iW]) || 0, a: num(row[iA]), p: num(row[iP]) });
    }
  }
  return ps.actual == null && !ps.acts.length ? null : ps;
}
function readSLA(ids) {
  const rows = sheetRows("SLA"); if (!rows) return null;
  const at = findLabel(rows, /^step$/i, 12); if (!at) return null;
  const hr = at[0], grp = rows[hr - 1] || [], hdr = rows[hr] || [];
  const maxAt = findLabel(rows, /^max \(wd\)$/i, 14);
  const maxRow = maxAt ? rows[maxAt[0]] : [];
  const steps = []; let g = "";
  for (let c = 2; c < hdr.length; c++) {
    if (grp[c]) g = norm(grp[c]);
    const h = txt(hdr[c]); if (!h || !/·/.test(h)) continue;
    const blk = g.startsWith("completed") ? "done" : g.startsWith("open") ? "open" : null; if (!blk) continue;
    const [code, ...rest] = h.split("·");
    const mx = typeof maxRow[c] === "number" ? maxRow[c] : parseFloat(maxRow[c]);
    steps.push({ c, blk, code: code.trim(), name: rest.join("·").trim(), max: isNaN(mx) ? null : mx });
  }
  const per = new Map();
  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r] || [], sid = typeof row[1] === "string" ? row[1].trim() : "";
    if (!sid || !ids.has(sid)) continue;
    const o = {};
    for (const s of steps) { const v = row[s.c]; if (typeof v === "number") o[s.blk + ":" + s.code] = v; }
    per.set(sid, o);
  }
  const uniqSteps = []; const seen = new Set();
  for (const s of steps) if (!seen.has(s.code)) { seen.add(s.code); uniqSteps.push({ code: s.code, name: s.name, max: s.max }); }
  return { steps: uniqSteps, per };
}
function readTable(sheet, keyHeader) {
  const rows = sheetRows(sheet); if (!rows) return [];
  const at = findLabel(rows, new RegExp("^" + keyHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"), 10); if (!at) return [];
  const h = rows[at[0]].map(x => txt(x));
  const out = [];
  for (let r = at[0] + 1; r < rows.length; r++) {
    const row = rows[r] || []; if (!txt(row[at[1]])) continue;
    const o = {}; h.forEach((k, i) => { if (k) o[k] = row[i]; }); out.push(o);
  }
  return out;
}

/* ================================================================ model */
function buildSite(o) {
  const s = Object.assign({}, o);
  s.cwApp = yes(o.sowTower) || yes(o.sowAdp);
  s.rfiApp = s.cwApp || yes(o.sowGecol) || yes(o.sowHlc);
  s.teApp = yes(o.teFull) || yes(o.teRouter) || (!("teFull" in o) && !("teRouter" in o));
  s.cancel = norm(o.status) === "cancelled";
  s.hold = norm(o.status) === "on hold";
  s.ms = MS.map(m => {
    const a = o[m.a], b = o[m.b], g = m.g ? o[m.g] : null;
    let na = a === "N/A" || b === "N/A" || g === "N/A";
    if ((m.k === "precw" || m.k === "cw") && "sowTower" in o && !s.cwApp) na = true;
    if (m.k === "rfi" && "sowTower" in o && !s.rfiApp) na = true;
    return { a: a instanceof Date ? a : null, b: b instanceof Date ? b : null, g: g instanceof Date ? g : null, na };
  });
  const it = txt(o.issue), st = norm(o.issueStatus);
  s.issueOpen = !!it && !/^(closed|resolved|done|cancel)/.test(st);
  s.issueAge = s.issueOpen && o.issueDate instanceof Date ? days(S.rpt, o.issueDate) : null;
  s.contractor = txt(o.contractor); s.vendor = txt(o.vendor);
  return s;
}
/* milestone state of one site as of date T */
function msState(s, j, T) {
  const m = s.ms[j];
  if (m.na) return "na";
  if (m.a && m.a <= T) return "done";
  if (j === 0) return s.cancel ? "na" : "due";
  if (m.g && m.g <= T) return "due";
  return "wait";
}
function siteView(s, T) {
  const st = s.ms.map((_, j) => msState(s, j, T));
  let cur = -1, next = -1;
  st.forEach((x, j) => { if (x === "done") cur = j; });
  next = st.findIndex(x => x === "due" || x === "wait");
  const prevDate = j => { for (let i = j - 1; i >= 0; i--) if (st[i] === "done") return s.ms[i].a; return null; };
  const v = { st, cur, next };
  if (next >= 0) {
    const m = s.ms[next];
    v.state = st[next];
    v.since = v.state === "due" ? (m.g || prevDate(next)) : prevDate(next);
    v.age = v.since ? days(T, v.since) : null;
    v.overdue = m.b && m.b < T ? days(T, m.b) : 0;
  }
  return v;
}

/* ================================================================ filters */
const FILTERS = [
  ["phase", "Project Phase", "phase"], ["batch", "Delivery Batch", "batch"], ["scen", "Delivery Scenario", "scen"],
  ["region", "Region", "region"], ["cluster", "Cluster ID", "cluster"], ["type", "Site Type", "type"],
  ["owner", "Tower Owner", "owner"], ["contractor", "Contractor", "contractor", "cw"], ["vendor", "Vendor", "vendor", "te"],
];
function T() { return S.F.to ? toDate(S.F.to) : S.rpt; }
function FROM() { return S.F.from ? toDate(S.F.from) : null; }
function scope(page = S.page) {
  const F = S.F;
  return S.sites.filter(s => !s.cancel && FILTERS.every(([k, , f, pg]) => {
    if (!F[k] || (pg && pg !== page)) return true;
    return txt(s[f]) === F[k];
  }));
}
const secScope = (rows, sec) => sec === "cw" ? rows.filter(s => s.cwApp || s.rfiApp) : sec === "te" ? rows.filter(s => s.teApp) : rows;

/* ================================================================ aggregation */
function msAgg(rows, j, T, from) {
  const a = { app: 0, done: 0, due: 0, wait: 0, overdue: 0, late: 0, plan: 0, period: 0, onTime: 0, varDays: [], ovDays: [] };
  for (const s of rows) {
    const st = msState(s, j, T); if (st === "na") continue;
    const m = s.ms[j]; a.app++;
    if (m.b && m.b <= T) a.plan++;
    if (st === "done") {
      a.done++;
      if (from && m.a >= from) a.period++;
      if (m.b) { const v = days(m.a, m.b); a.varDays.push(v); if (v > 0) a.late++; else a.onTime++; }
    } else {
      a[st]++;
      if (m.b && m.b < T) { a.overdue++; a.ovDays.push(days(T, m.b)); }
    }
  }
  return a;
}
function weekly(rows, j, T, extend = true) {
  const acts = [], plans = [];
  let app = 0;
  for (const s of rows) {
    if (msState(s, j, T) === "na") continue; app++;
    const m = s.ms[j];
    if (m.a && m.a <= T) acts.push(+m.a);
    if (m.b) plans.push(+m.b);
  }
  if (!app) return null;
  const all = acts.concat(plans);
  if (!all.length) return { app, pts: [] };
  const start = Math.min(...all), wk = 7 * DAY;
  const t0 = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY;
  const lastPlan = plans.length ? Math.max(...plans) : +T;
  acts.sort((x, y) => x - y); plans.sort((x, y) => x - y);
  const recent = acts.filter(x => x > +T - 56 * DAY).length / 8;
  const done = acts.length, remain = app - done;
  const ecd = remain <= 0 ? null : recent > 0 ? +T + Math.ceil(remain / recent) * wk : null;
  const end = Math.max(+T + 8 * wk, Math.min(Math.max(lastPlan, extend && ecd ? ecd : 0), +T + 40 * wk));
  const pts = []; let ia = 0, ip = 0;
  for (let t = t0; t <= end + wk; t += wk) {
    while (ia < acts.length && acts[ia] <= t) ia++;
    while (ip < plans.length && plans[ip] <= t) ip++;
    pts.push({ t, a: t <= +T ? ia : null, p: ip });
  }
  return { app, pts, rate: recent, ecd: ecd ? new Date(ecd) : null, done, remain };
}
function statusMix(rows) {
  const c = { "Not Started": 0, "In Progress": 0, "On Hold": 0, "Completed": 0 };
  for (const s of rows) { const k = txt(s.status) || "Not Started"; if (k in c) c[k]++; }
  return c;
}

/* ================================================================ tooltip */
const tip = { el: null };
function showTip(html, e) {
  const el = tip.el; el.innerHTML = html; el.classList.add("on");
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  el.style.left = x + "px"; el.style.top = y + "px";
}
const hideTip = () => tip.el.classList.remove("on");

/* ================================================================ components */
function kpi({ lab, big, small, meta = "", bar, mark, cls = "", go, color }) {
  const b = bar != null ? `<div class="kbar"><i style="width:${Math.min(100, bar * 100)}%;background:${color || "var(--ink2)"}"></i>${mark != null ? `<u style="left:${Math.min(100, mark * 100)}%"></u>` : ""}</div>` : "";
  return `<div class="k ${cls}" ${go ? `data-go='${esc(JSON.stringify(go))}'` : ""}><div class="lab">${lab}</div>
    <div class="big num">${big}${small ? `<small>${small}</small>` : ""}</div>${b}<div class="meta">${meta}</div></div>`;
}
function deltaTag(n, good = 1) {
  if (n == null) return "";
  const cls = n === 0 ? "flat" : (n > 0) === (good > 0) ? "up" : "down";
  return `<span class="delta ${cls}">${n > 0 ? "+" : ""}${fmt(n)}</span>`;
}
function ring(p, color) {
  const r = 34, C = 2 * Math.PI * r, v = Math.max(0, Math.min(1, p || 0));
  return `<svg viewBox="0 0 74 74"><circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round"
    stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}"/></svg>`;
}
/* the delivery pipeline: scope → milestones, each node = sites done; gaps = sites in execution at the next node */
function pipeline(rows, idx, T, from, opts = {}) {
  const n = idx.length + 1;
  const scopeN = rows.length;
  const aggs = idx.map(j => msAgg(rows, j, T, from));
  let html = `<div class="pipe"><div class="pipe-track" style="grid-template-columns:repeat(${n},minmax(0,1fr))">`;
  const totApp = aggs.reduce((x, a) => x + a.app, 0), totDone = aggs.reduce((x, a) => x + a.done, 0);
  html += `<div class="pipe-line" style="left:${50 / n}%;right:${50 / n}%"><i style="width:${(totApp ? totDone / totApp : 0) * 100}%"></i></div>`;
  html += `<div class="st scope" data-pipe="scope"><div class="node"><b class="num">${fmt(scopeN)}</b><small>sites</small></div>
    <div class="nm">${opts.scopeLabel || "In scope"}</div><div class="stats">${opts.scopeMeta || ""}</div></div>`;
  idx.forEach((j, i) => {
    const a = aggs[i], m = MS[j], p = pct(a.done, a.app);
    const col = STAGE_COL[m.k];
    const stats = [`${P(p)} of ${fmt(a.app)}`];
    if (a.plan) stats.push(`plan ${fmt(a.plan)} ${deltaTag(a.done - a.plan)}`);
    if (from) stats.push(`<span class="pd">+${fmt(a.period)} in period</span>`);
    if (a.overdue) stats.push(`<span class="late">${fmt(a.overdue)} overdue</span>`);
    html += `<div class="st" data-pipe="${m.k}"><div class="node">${ring(p, col)}<b class="num">${fmt(a.done)}</b><small>done</small></div>
      <div class="nm">${m.s}</div><div class="stats">${stats.join("<br>")}</div></div>`;
  });
  html += `</div>`;
  idx.forEach((j, i) => {
    const a = aggs[i]; if (!a.due) return;
    const x = (i + 0.5) / n * 100 + 50 / n;
    html += `<span class="flowgap ${a.due > 0.15 * Math.max(1, a.app) ? "hot" : ""}" style="left:${x}%" title="Sites ready and in execution for ${MS[j].n}">${fmt(a.due)} in work</span>`;
  });
  html += `</div><div class="pipe-legend"><span><i class="dot" style="background:var(--te)"></i>Ring = share of applicable sites done</span>
    <span>“in work” = phase gate open, milestone not yet achieved</span><span>plan = baseline due by ${dstr(T)}</span></div>`;
  return { html, aggs };
}
function barList(items, opt = {}) {
  const max = opt.max || Math.max(1, ...items.map(i => i.v));
  return `<div class="bars">${items.map(i => {
    const w = (i.v / max) * 100;
    return `<div class="bar ${i.go ? "click" : ""}" ${i.go ? `data-go='${esc(JSON.stringify(i.go))}'` : ""}>
      <span class="bl" title="${esc(i.l)}">${esc(i.l)}</span>
      <span class="bt"><i style="width:${w}%;background:${i.c || "var(--ink2)"}"></i>${i.mark != null ? `<u style="left:${(i.mark / max) * 100}%"></u>` : ""}</span>
      <span class="bv">${i.vt != null ? i.vt : fmt(i.v)}${i.st ? ` <small>${i.st}</small>` : ""}</span></div>`;
  }).join("")}</div>`;
}
function lineChart(series, opt = {}) {
  const W = 760, H = opt.h || 230, L = 40, R = 14, Tp = 12, B = 26;
  const xs = series.flatMap(s => s.pts.map(p => p[0]));
  if (!xs.length) return `<div class="empty">No dated records yet.</div>`;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ymax = opt.ymax || Math.max(1, ...series.flatMap(s => s.pts.map(p => p[1] || 0)));
  const sx = x => L + (x1 === x0 ? 0 : (x - x0) / (x1 - x0)) * (W - L - R);
  const sy = y => Tp + (1 - y / ymax) * (H - Tp - B);
  let g = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = ymax * i / ticks, y = sy(v);
    g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${opt.pct ? Math.round(v * 100) + "%" : fmt(v)}</text>`;
  }
  const months = []; const d0 = new Date(x0);
  for (let d = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1); d <= x1; d = Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth() + 1, 1)) months.push(d);
  const stepM = Math.max(1, Math.ceil(months.length / 8));
  months.forEach((m, i) => { if (m < x0 || i % stepM) return; const x = sx(m); g += `<text x="${x}" y="${H - 6}" text-anchor="middle">${MON[new Date(m).getUTCMonth()]}${new Date(m).getUTCMonth() === 0 ? " " + String(new Date(m).getUTCFullYear()).slice(2) : ""}</text><line class="ax" x1="${x}" x2="${x}" y1="${H - B}" y2="${H - B + 4}"/>`; });
  g += `<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
  if (opt.marker) { const x = sx(+opt.marker); g += `<line class="hl" x1="${x}" x2="${x}" y1="${Tp}" y2="${H - B}"/><text x="${x + 4}" y="${Tp + 9}" style="fill:var(--ink2)">${opt.markerLabel || ""}</text>`; }
  for (const s of series) {
    const pts = s.pts.filter(p => p[1] != null); if (!pts.length) continue;
    const d = pts.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join("");
    if (s.area) g += `<path d="${d}L${sx(pts[pts.length - 1][0]).toFixed(1)} ${sy(0)}L${sx(pts[0][0]).toFixed(1)} ${sy(0)}Z" fill="${s.color}" opacity=".12"/>`;
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2.2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  const id = "c" + Math.random().toString(36).slice(2, 8);
  CHARTS[id] = { series, sx, sy, x0, x1, W, H, L, R, Tp, B, pct: opt.pct };
  const leg = `<div class="cleg">${series.filter(s => !s.nolegend).map(s => `<span style="color:${s.color}"><i class="${s.dash ? "dash" : ""}" style="background:${s.color}"></i><em style="font-style:normal;color:var(--ink2)">${esc(s.name)}</em></span>`).join("")}</div>`;
  return `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${opt.ph || H}px">${g}<line class="hl cur" x1="0" x2="0" y1="${Tp}" y2="${H - B}" style="display:none"/></svg></div>${leg}`;
}
const CHARTS = {};
function wireCharts(root) {
  $$(".chart[data-chart]", root).forEach(el => {
    const c = CHARTS[el.dataset.chart]; if (!c) return;
    const svg = $("svg", el), cur = $(".cur", svg);
    svg.addEventListener("mousemove", e => {
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * c.W;
      if (x < c.L || x > c.W - c.R) { cur.style.display = "none"; hideTip(); return; }
      const t = c.x0 + (x - c.L) / (c.W - c.L - c.R) * (c.x1 - c.x0);
      let html = `<b>${dstr(new Date(t))}</b>`; let any = false;
      for (const s of c.series) {
        if (s.nolegend) continue;
        let best = null; for (const p of s.pts) if (p[1] != null && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
        if (best && Math.abs(best[0] - t) < 8 * DAY) { any = true; html += `<div class="r"><span style="color:${s.color}">${esc(s.name)}</span><em>${c.pct ? Math.round(best[1] * 100) + "%" : fmt(best[1])}</em></div>`; }
      }
      cur.setAttribute("x1", x); cur.setAttribute("x2", x); cur.style.display = "";
      if (any) showTip(html, e); else hideTip();
    });
    svg.addEventListener("mouseleave", () => { cur.style.display = "none"; hideTip(); });
  });
}
function fcast(w, T) {
  const end = w.pts[w.pts.length - 1].t, e = Math.min(+w.ecd, end);
  return [[+T, w.done], [e, w.done + (w.app - w.done) * (e - +T) / Math.max(1, +w.ecd - +T)]];
}
function sCurve(rows, j, T, color, label) {
  const w = weekly(rows, j, T); if (!w || !w.pts.length) return { html: `<div class="empty">No ${label} dates yet.</div>`, w };
  const act = w.pts.filter(p => p.a != null).map(p => [p.t, p.a]);
  const plan = w.pts.map(p => [p.t, p.p]);
  const series = [{ name: `${label} · baseline plan`, color: "var(--plan)", dash: "5 5", pts: plan, w: 1.8 },
    { name: `${label} · actual`, color, pts: act, area: true }];
  if (w.ecd && act.length) series.push({ name: `Forecast at ${w.rate.toFixed(1)} sites / week`, color, dash: "1.5 5", w: 2, pts: fcast(w, T) });
  series.push({ name: "scope", nolegend: true, color: "var(--line2)", dash: "2 6", w: 1, pts: [[w.pts[0].t, w.app], [w.pts[w.pts.length - 1].t, w.app]] });
  return { html: lineChart(series, { marker: T, markerLabel: "Report date", ymax: Math.max(w.app, 1) * 1.04 }), w };
}
function table(cols, rows, opt = {}) {
  const key = opt.key;
  let data = rows;
  if (key && S.sort[key]) { const { c, d } = S.sort[key]; const col = cols.find(x => x.k === c); if (col) data = [...rows].sort(by(r => { const v = col.sv ? col.sv(r) : col.v(r); return v == null || v === "" ? (d > 0 ? Infinity : -Infinity) : v; }, d)); }
  const cap = opt.cap || 400, shown = data.slice(0, cap);
  const th = cols.map(c => `<th class="${c.cls || ""}" ${key && c.sort !== false ? `data-sort="${key}|${c.k}"` : ""}>${c.h}${key && S.sort[key] && S.sort[key].c === c.k ? (S.sort[key].d > 0 ? " ▲" : " ▼") : ""}</th>`).join("");
  const tb = shown.map(r => `<tr class="${opt.click ? "click" : ""}" ${opt.click ? `data-site="${esc(r.id)}"` : ""}>${cols.map(c => `<td class="${c.cls || ""}">${c.f ? c.f(r) : esc(c.v(r))}</td>`).join("")}</tr>`).join("");
  const foot = opt.foot ? `<tfoot><tr>${opt.foot.map((f, i) => `<td class="${cols[i] && cols[i].cls || ""}">${f}</td>`).join("")}</tr></tfoot>` : "";
  return `<div class="tw" style="${opt.maxh ? `max-height:${opt.maxh}px` : ""}"><table class="t"><thead><tr>${th}</tr></thead><tbody>${tb || `<tr><td colspan="${cols.length}" class="muted">No sites match.</td></tr>`}</tbody>${foot}</table></div>${data.length > cap ? `<div class="note">Showing ${cap} of ${fmt(data.length)}. Use search or filters to narrow down.</div>` : ""}`;
}
const tagFor = (st) => ({ done: `<span class="tag ok">Done</span>`, due: `<span class="tag watch">In work</span>`, wait: `<span class="tag">Waiting gate</span>`, na: `<span class="tag">N/A</span>` }[st] || "");
function heat(rows, idx, T, field = "region") {
  const keys = uniq(rows.map(s => txt(s[field]) || "(not set)")).sort();
  const head = `<tr><th class="rl">${field === "region" ? "Region" : "Group"}</th><th>Sites</th>${idx.map(j => `<th>${MS[j].s}</th>`).join("")}</tr>`;
  const body = keys.map(k => {
    const sub = rows.filter(s => (txt(s[field]) || "(not set)") === k);
    return `<tr><td class="rl">${esc(k)}</td><td class="sc">${fmt(sub.length)}</td>${idx.map(j => {
      const a = msAgg(sub, j, T); if (!a.app) return `<td class="na">—</td>`;
      const p = a.done / a.app, lag = a.plan ? a.done - a.plan : 0;
      const bg = `color-mix(in srgb, ${STAGE_COL[MS[j].k]} ${Math.round(8 + p * 72)}%, var(--surface2))`;
      return `<td style="background:${bg};color:${p > .55 ? "#0c1a22" : "var(--ink)"}" data-go='${esc(JSON.stringify({ list: "ms", j, f: field, v: k }))}' title="${esc(k)} · ${MS[j].n}: ${a.done} of ${a.app} done${a.plan ? `, plan ${a.plan}` : ""}">${Math.round(p * 100)}%<small>${a.done}/${a.app}${lag < 0 ? ` · ${lag}` : ""}</small></td>`;
    }).join("")}</tr>`;
  }).join("");
  return `<table class="heat"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
function stackBar(parts, total) {
  const t = total || parts.reduce((x, p) => x + p.v, 0) || 1;
  return `<div class="stack">${parts.map(p => `<i style="width:${p.v / t * 100}%;background:${p.c}" title="${esc(p.l)}: ${p.v}"></i>`).join("")}</div>
    <div class="stack-leg">${parts.map(p => `<span ${p.go ? `data-go='${esc(JSON.stringify(p.go))}'` : ""}><i class="dot" style="background:${p.c}"></i>${esc(p.l)} <b>${fmt(p.v)}</b></span>`).join("")}</div>`;
}

/* ---------------- map ---------------- */
const GEO = (() => {
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
  for (let i = 0; i < LIBYA_RING.length; i += 2) { const lo = LIBYA_RING[i], la = LIBYA_RING[i + 1]; mnx = Math.min(mnx, lo); mxx = Math.max(mxx, lo); mny = Math.min(mny, la); mxy = Math.max(mxy, la); }
  const k = Math.cos((mny + mxy) / 2 * Math.PI / 180), W = 1000, pad = 18;
  const xs = (mxx - mnx) * k, ys = mxy - mny, H = Math.round(W * ys / xs);
  const px = lo => pad + ((lo - mnx) * k / xs) * (W - 2 * pad), py = la => pad + ((mxy - la) / ys) * (H - 2 * pad);
  let d = ""; for (let i = 0; i < LIBYA_RING.length; i += 2) d += (i ? "L" : "M") + px(LIBYA_RING[i]).toFixed(1) + " " + py(LIBYA_RING[i + 1]).toFixed(1);
  return { W, H, px, py, path: d + "Z", ok: (la, lo) => la > 18 && la < 34.5 && lo > 8 && lo < 26 };
})();
function mapGroups(sec) {
  if (sec === "cw") return [["none", "Not released"], ["rel", "Released"], ["precw", "PRE-CW done"], ["cw", "CW complete"], ["rfi", "RFI ready"]];
  if (sec === "te") return [["pre", "Before TE"], ["te", "TE installed"], ["onair", "On-Air"], ["tepac", "TE PAC"], ["kpi", "KPI accepted"], ["hoto", "HOTO / closed"]];
  return [["none", "Not released"], ["rel", "Released"], ["precw", "PRE-CW"], ["cw", "CW complete"], ["rfi", "RFI"], ["te", "TE installed"],
    ["onair", "On-Air"], ["tepac", "TE PAC"], ["kpi", "KPI"], ["hoto", "HOTO / closed"]];
}
function mapGroupOf(v, sec) {
  const k = v.cur < 0 ? "none" : MS[v.cur].k;
  if (sec === "cw") { const i = Math.min(v.cur, 3); return i < 0 ? "none" : MS[i].k; }
  if (sec === "te") { if (v.cur < 4) return "pre"; return k === "fin" ? "hoto" : k; }
  return k === "fin" ? "hoto" : k;
}
const GROUP_COL = k => k === "pre" ? "#61757f" : STAGE_COL[k] || "#61757f";
function mapPanel(rows, T, sec) {
  const groups = mapGroups(sec), cnt = Object.fromEntries(groups.map(g => [g[0], 0]));
  let dots = "", nocoord = 0;
  const vs = rows.map(s => ({ s, v: siteView(s, T) }));
  for (const { s, v } of vs) {
    const g = mapGroupOf(v, sec); cnt[g] = (cnt[g] || 0) + 1;
    const la = +s.lat, lo = +s.lng;
    if (!GEO.ok(la, lo)) { nocoord++; continue; }
    if (S.mapOff.has(sec + ":" + g)) continue;
    const late = v.overdue > 0, r = late ? 5.2 : 4.4;
    dots += `<circle cx="${GEO.px(lo).toFixed(1)}" cy="${GEO.py(la).toFixed(1)}" r="${r}" fill="${GROUP_COL(g)}" data-site="${esc(s.id)}" data-tipsite="1"/>`;
  }
  const leg = groups.map(([k, l]) => `<span class="${S.mapOff.has(sec + ":" + k) ? "off" : ""}" data-mapkey="${sec}:${k}"><i class="dot" style="background:${GROUP_COL(k)}"></i>${l} <b>${fmt(cnt[k] || 0)}</b></span>`).join("");
  return `<div class="map" data-map="1"><svg viewBox="0 0 ${GEO.W} ${GEO.H}" data-vb="0 0 ${GEO.W} ${GEO.H}"><path class="land" d="${GEO.path}"/><g class="dots">${dots}</g></svg>
    <div class="ctrl"><button data-zoom="in" aria-label="Zoom in">+</button><button data-zoom="out" aria-label="Zoom out">−</button><button data-zoom="reset" aria-label="Reset map">⟲</button></div></div>
    <div class="mleg">${leg}</div>${nocoord ? `<div class="note">${fmt(nocoord)} site(s) without valid coordinates are not drawn.</div>` : ""}`;
}
function wireMaps(root) {
  $$(".map[data-map]", root).forEach(m => {
    const svg = $("svg", m); let vb = svg.getAttribute("data-vb").split(" ").map(Number), drag = null;
    const set = () => svg.setAttribute("viewBox", vb.join(" "));
    const zoom = (f, cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2) => {
      const w = Math.min(GEO.W, Math.max(GEO.W / 10, vb[2] * f)), h = w * GEO.H / GEO.W;
      vb = [cx - (cx - vb[0]) * w / vb[2], cy - (cy - vb[1]) * h / vb[3], w, h]; set();
    };
    svg.addEventListener("wheel", e => { e.preventDefault(); const r = svg.getBoundingClientRect(); zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, vb[0] + (e.clientX - r.left) / r.width * vb[2], vb[1] + (e.clientY - r.top) / r.height * vb[3]); }, { passive: false });
    svg.addEventListener("pointerdown", e => { if (e.target.tagName === "circle") return; drag = { x: e.clientX, y: e.clientY, vb: [...vb] }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener("pointermove", e => { if (!drag) return; const r = svg.getBoundingClientRect(), k = Math.max(vb[2] / r.width, vb[3] / r.height); vb[0] = drag.vb[0] - (e.clientX - drag.x) * k; vb[1] = drag.vb[1] - (e.clientY - drag.y) * k; set(); });
    svg.addEventListener("pointerup", () => drag = null);
    $$("[data-zoom]", m).forEach(b => b.onclick = () => { if (b.dataset.zoom === "reset") { vb = [0, 0, GEO.W, GEO.H]; set(); } else zoom(b.dataset.zoom === "in" ? 1 / 1.5 : 1.5); });
  });
}

/* ================================================================ site lists, drawer */
const siteById = id => S.sites.find(s => s.id === id);
function whereText(s, v) {
  if (s.cancel) return { now: "Cancelled", why: "Excluded from scope.", cls: "" };
  if (v.next < 0) return { now: v.cur >= 0 ? `${MS[v.cur].n} achieved` : "Complete", why: "All applicable milestones achieved.", cls: "" };
  const m = MS[v.next];
  let why;
  if (v.state === "due") why = `Ready for ${m.n} since ${dstr(v.since)}${v.age != null ? ` · ${fmt(v.age)} days in this step` : ""}.`;
  else {
    const extra = [];
    if (m.k === "rfi") { if (norm(s.gecol) === "pending") extra.push("GECOL power pending"); if (norm(s.hlc) === "pending") extra.push("HLC fiber pending"); if (!(s.pacA instanceof Date) && s.cwApp) extra.push("CW PAC not dated"); }
    why = `Waiting for readiness · ${GATE_HINT[m.k] || ""}${extra.length ? `. Open now: ${extra.join(", ")}` : ""}.`;
  }
  const head = v.cur >= 0 ? `${MS[v.cur].n} done · next ${m.n}` : `Next ${m.n}`;
  return { now: head, why: (s.hold ? "On hold. " : "") + why + (v.overdue ? ` Baseline for ${m.n} passed ${fmt(v.overdue)} days ago.` : ""),
    cls: s.hold || v.overdue > 15 ? "crit" : v.overdue > 0 || v.state === "wait" ? "watch" : "" };
}
function openSite(id) {
  const s = siteById(id); if (!s) return;
  const Tn = T(), v = siteView(s, Tn), w = whereText(s, v);
  const kv = [["Region", s.region], ["Sub region", s.sub], ["Cluster", s.cluster], ["Site type", s.type], ["Delivery scenario", s.scen],
    ["Tower owner", s.owner], ["Phase · batch", [s.phase, s.batch].filter(Boolean).join(" · ")], ["Uplink site", s.uplink],
    ["CW contractor", s.contractor], ["TE vendor", s.vendor], ["CW AAT SE", s.cwSE], ["TE AAT SE", s.teSE],
    ["CW scope", [yes(s.sowTower) && "Tower", yes(s.sowAdp) && "Adaption", yes(s.sowGecol) && "GECOL", yes(s.sowHlc) && "HLC"].filter(Boolean).join(", ") || "—"],
    ["Coordinates", s.lat && s.lng ? `${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}` : "—"]]
    .map(([k, x]) => `<div>${k}<b>${esc(txt(x) || "—")}</b></div>`).join("");
  const tl = MS.map((m, j) => {
    const st = v.st[j], d = s.ms[j];
    const vd = st === "done" && d.b ? days(d.a, d.b) : st !== "done" && st !== "na" && d.b && d.b < Tn ? days(Tn, d.b) : null;
    const vcls = vd == null ? "" : vd > 15 ? "crit" : vd > 0 ? "watch" : "ok";
    return `<div class="row ${st}"><span class="pt" style="${st === "done" ? `background:${STAGE_COL[m.k]};border-color:${STAGE_COL[m.k]}` : ""}"></span>
      <span>${m.n}${st === "due" ? ` <span class="tag watch">in work</span>` : ""}${st === "na" ? ` <span class="tag">N/A</span>` : ""}</span>
      <span class="d">${st === "na" ? "" : dstr(d.b)}</span><span class="d">${st === "done" ? dstr(d.a) : st === "na" ? "" : "—"}</span>
      <span class="v ${vcls}">${vd == null ? "" : (vd > 0 ? "+" : "") + vd + "d"}</span></div>`;
  }).join("");
  const iss = txt(s.issue) ? `<div class="dw-sec"><h4>Issue</h4><div class="where ${s.issueOpen ? "crit" : ""}"><b>${esc(s.issue)}</b>
    <div class="why">${s.issueOpen ? "Open" : esc(txt(s.issueStatus) || "Recorded")}${s.issueOwner ? ` · owner ${esc(s.issueOwner)}` : ""}${s.issueAge != null ? ` · ${s.issueAge} days` : ""}</div>
    ${txt(s.remark) ? `<div class="why muted">${esc(s.remark)}</div>` : ""}</div></div>` : "";
  $("#drawer").innerHTML = `<div class="dw-h"><button class="ibtn x" data-close aria-label="Close">${ICON.x}</button>
    <h2>${esc(s.id)}</h2><div class="sub">${esc(s.name || "")} · ${esc(s.region || "")}</div>
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><span class="chip ${s.hold ? "crit" : ""}">${esc(txt(s.status) || "—")}</span>${s.issueOpen ? `<span class="chip crit">Open issue</span>` : ""}${v.overdue ? `<span class="chip watch">Behind baseline ${v.overdue}d</span>` : ""}</div></div>
    <div class="dw-b"><div class="where ${w.cls}"><div class="now">${esc(w.now)}</div><div class="why">${esc(w.why)}</div></div>
    <div class="dw-sec"><h4>Milestones · baseline and actual as of ${dstr(Tn)}</h4><div class="tl"><div class="row hd"><span></span><span>Milestone</span><span>Baseline</span><span>Actual</span><span class="v">Var.</span></div>${tl}</div></div>
    ${iss}<div class="dw-sec"><h4>Site</h4><div class="kv">${kv}</div></div></div>`;
  $("#drawer").classList.add("on"); $("#scrim").classList.add("on");
  $("#drawer [data-close]").onclick = closeOverlays;
}
function closeOverlays() { $("#drawer").classList.remove("on"); $("#modal").classList.remove("on"); $("#scrim").classList.remove("on"); }
let LIST = null;
function openList(title, sites, note = "") {
  LIST = { title, sites, note, q: "" };
  renderList();
  $("#modal").classList.add("on"); $("#scrim").classList.add("on");
}
function renderList() {
  const Tn = T(), q = norm(LIST.q);
  const rows = LIST.sites.filter(s => !q || norm([s.id, s.name, s.region, s.contractor, s.vendor, s.issue].join(" ")).includes(q))
    .map(s => Object.assign(s, { _v: siteView(s, Tn) }));
  const cols = siteCols("list");
  $("#modal").innerHTML = `<div class="md-h"><h3>${esc(LIST.title)}</h3><span class="chip">${fmt(rows.length)} sites</span><span class="sp"></span>
    <input class="search" placeholder="Search site, region, issue…" value="${esc(LIST.q)}" id="listQ">
    <button class="btn ghost" id="listCsv">${ICON.dl} CSV</button><button class="ibtn" data-close aria-label="Close">${ICON.x}</button></div>
    <div class="md-b">${LIST.note ? `<div class="note" style="margin:0 0 10px">${esc(LIST.note)}</div>` : ""}${table(cols, rows, { key: "list", click: true, maxh: 620 })}</div>`;
  $("#modal [data-close]").onclick = closeOverlays;
  const qi = $("#listQ"); qi.oninput = () => { LIST.q = qi.value; const pos = qi.selectionStart; renderList(); const n = $("#listQ"); n.focus(); n.setSelectionRange(pos, pos); };
  $("#listCsv").onclick = () => csv(LIST.title, cols, rows);
  wireCommon($("#modal"));
}
function siteCols(kind) {
  const nx = r => r._v.next >= 0 ? MS[r._v.next].n : "—";
  const base = [
    { k: "id", h: "Site ID", v: r => r.id, f: r => `<b>${esc(r.id)}</b>` },
    { k: "name", h: "Name", v: r => txt(r.name) },
    { k: "region", h: "Region", v: r => txt(r.region) },
    { k: "type", h: "Type", v: r => txt(r.type) },
  ];
  const tail = [
    { k: "cur", h: "Current", v: r => r._v.cur >= 0 ? MS[r._v.cur].n : "Not released" },
    { k: "next", h: "Next", v: nx, f: r => esc(nx(r)) + (r._v.next >= 0 ? " " + tagFor(r._v.state) : "") },
    { k: "age", h: "Days in step", cls: "r", v: r => r._v.age, f: r => r._v.age == null ? "—" : `<span class="num">${r._v.age}</span>` },
    { k: "ovd", h: "Behind baseline", cls: "r", v: r => r._v.overdue || 0, f: r => r._v.overdue ? `<span class="num ${r._v.overdue > 15 ? "crit" : "watch"}">${r._v.overdue}d</span>` : `<span class="dim">—</span>` },
    { k: "issue", h: "Open issue", v: r => r.issueOpen ? r.issue : "", f: r => r.issueOpen ? `<span class="tag crit">${esc(String(r.issue).slice(0, 40))}</span>` : "" },
  ];
  if (kind === "cw") return [...base, { k: "con", h: "Contractor", v: r => r.contractor },
    { k: "cwB", h: "CW baseline", v: r => r.ms[2].b ? +r.ms[2].b : null, f: r => dstr(r.ms[2].b) },
    { k: "cwA", h: "CW actual", v: r => r.ms[2].a ? +r.ms[2].a : null, f: r => r.ms[2].na ? "N/A" : dstr(r.ms[2].a) },
    { k: "rfiA", h: "RFI actual", v: r => r.ms[3].a ? +r.ms[3].a : null, f: r => r.ms[3].na ? "N/A" : dstr(r.ms[3].a) }, ...tail];
  if (kind === "te") return [...base, { k: "ven", h: "Vendor", v: r => r.vendor },
    { k: "teA", h: "TE installed", v: r => r.ms[4].a ? +r.ms[4].a : null, f: r => dstr(r.ms[4].a) },
    { k: "oaB", h: "On-Air baseline", v: r => r.ms[5].b ? +r.ms[5].b : null, f: r => dstr(r.ms[5].b) },
    { k: "oaA", h: "On-Air actual", v: r => r.ms[5].a ? +r.ms[5].a : null, f: r => dstr(r.ms[5].a) },
    { k: "pac", h: "TE PAC", v: r => r.ms[6].a ? +r.ms[6].a : null, f: r => dstr(r.ms[6].a) }, ...tail];
  return [...base, { k: "scen", h: "Scenario", v: r => txt(r.scen) }, ...tail];
}
function csv(name, cols, rows) {
  const q = v => { const s = v == null ? "" : String(v instanceof Date ? iso(v) : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = [cols.map(c => q(c.h)).join(","), ...rows.map(r => cols.map(c => q(c.v(r))).join(","))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + out], { type: "text/csv;charset=utf-8" }));
  a.download = name.replace(/[^\w-]+/g, "_") + ".csv"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/* go: {list:'ms', j, st, f, v} | {list:'issues'} | {page, tab} */
function go(spec) {
  const Tn = T(), sec = S.page === "ov" ? null : S.page;
  let rows = secScope(scope(), sec);
  if (spec.page) { setPage(spec.page, spec.tab); return; }
  if (spec.list === "ms") {
    if (spec.f) rows = rows.filter(s => (txt(s[spec.f]) || "(not set)") === spec.v);
    const j = spec.j;
    const pick = rows.filter(s => { const st = msState(s, j, Tn); if (st === "na") return false; if (!spec.st) return true;
      if (spec.st === "overdue") return st !== "done" && s.ms[j].b && s.ms[j].b < Tn; if (spec.st === "period") return st === "done" && FROM() && s.ms[j].a >= FROM(); return st === spec.st; });
    const lab = { done: "achieved", due: "in work (gate open)", wait: "waiting for readiness", overdue: "behind baseline", period: "achieved in period" }[spec.st] || "applicable";
    openList(`${MS[j].n} · ${lab}${spec.v ? " · " + spec.v : ""}`, pick);
  } else if (spec.list === "scope") openList("Sites in scope", rows);
  else if (spec.list === "issues") openList("Sites with an open issue", rows.filter(s => s.issueOpen && (!spec.owner || (txt(s.issueOwner) || "(no owner)") === spec.owner)));
  else if (spec.list === "status") openList(`Sites · ${spec.v}`, rows.filter(s => (txt(s.status) || "Not Started") === spec.v));
  else if (spec.list === "next") openList(`Next milestone ${MS[spec.j].n}${spec.st ? " · " + (spec.st === "due" ? "in work" : "waiting for readiness") : ""}`,
    rows.filter(s => { const v = siteView(s, Tn); return v.next === spec.j && (!spec.st || v.state === spec.st) && (!spec.age || ageBucket(v.age) === spec.age); }));
  else if (spec.list === "field") openList(spec.title, rows.filter(s => (txt(s[spec.f]) || "(not set)") === spec.v));
  else if (spec.list === "ids") openList(spec.title, rows.filter(s => spec.ids.includes(s.id)));
}
const AGE_B = [["0–7 d", 7, "var(--ok)"], ["8–15 d", 15, "#9bc86a"], ["16–30 d", 30, "var(--watch)"], ["> 30 d", Infinity, "var(--crit)"]];
const ageBucket = a => a == null ? "—" : AGE_B.find(b => a <= b[1])[0];

/* ================================================================ decisions (overview + sections) */
function decisions(rows, Tn, sec) {
  const out = [];
  const idx = sec === "cw" ? [1, 2, 3] : sec === "te" ? [4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7, 8];
  for (const j of idx) {
    const a = msAgg(rows, j, Tn);
    if (a.overdue >= 3) out.push({ w: a.overdue * (1 + (median(a.ovDays) || 0) / 30), sev: a.overdue > 0.25 * a.app ? "crit" : "watch",
      t: `${fmt(a.overdue)} sites behind baseline for ${MS[j].n}`, d: `Median ${fmt(median(a.ovDays))} days late · ${fmt(a.wait)} still waiting for readiness, ${fmt(a.due)} in work.`,
      go: { list: "ms", j, st: "overdue" } });
  }
  const iss = rows.filter(s => s.issueOpen);
  const own = {}; iss.forEach(s => { const o = txt(s.issueOwner) || "(no owner)"; (own[o] = own[o] || []).push(s); });
  Object.entries(own).sort((a, b) => b[1].length - a[1].length).slice(0, 2).forEach(([o, l]) => {
    const old = Math.max(...l.map(s => s.issueAge || 0));
    if (l.length >= 2) out.push({ w: l.length * 1.6 + old / 20, sev: old > 60 || l.length >= 10 ? "crit" : "watch",
      t: `${o} holds ${fmt(l.length)} open site issues`, d: `Oldest ${fmt(old)} days · top: ${esc(mode(l.map(s => txt(s.issue))))}.`, go: { list: "issues", owner: o } });
  });
  const crit = S.risks.filter(r => !/closed/i.test(txt(r.Status)) && /critical|high/i.test(txt(r["Risk Level"])));
  if (crit.length && !sec) out.push({ w: crit.length * 2.2, sev: crit.some(r => /critical/i.test(txt(r["Risk Level"]))) ? "crit" : "watch",
    t: `${fmt(crit.length)} critical / high risks open`, d: crit.slice(0, 2).map(r => `${txt(r["Risk ID"])} ${txt(r["Risk Statement"])}`).join(" · "), go: { page: "ov", risk: 1 } });
  const hold = rows.filter(s => s.hold);
  if (hold.length) out.push({ w: hold.length * 1.2, sev: "watch", t: `${fmt(hold.length)} sites on hold`, d: "Suspended through Change Control; confirm resumption or cancellation.", go: { list: "status", v: "On Hold" } });
  const vs = rows.map(s => ({ s, v: siteView(s, Tn) })).filter(x => x.v.next >= 0 && idx.includes(x.v.next) && x.v.state === "wait" && x.v.age > 30);
  const byNext = {}; vs.forEach(x => (byNext[x.v.next] = byNext[x.v.next] || []).push(x.s));
  Object.entries(byNext).sort((a, b) => b[1].length - a[1].length).slice(0, 1).forEach(([j, l]) => {
    if (l.length >= 3) out.push({ w: l.length, sev: "watch", t: `${fmt(l.length)} sites stalled before ${MS[j].n} for 30+ days`, d: GATE_HINT[MS[j].k] + ".", go: { list: "next", j: +j, st: "wait" } });
  });
  const dqHigh = S.dq.filter(d => /high/i.test(txt(d.Severity)) && +d.Rows > 0);
  if (dqHigh.length && !sec) out.push({ w: dqHigh.length * 1.1, sev: "watch", t: `${dqHigh.length} high-severity data checks failing`, d: dqHigh.slice(0, 3).map(d => txt(d.Check)).join(" · ") + ".", go: { dq: 1 } });
  return out.sort((a, b) => b.w - a.w).slice(0, 5);
}
const mode = a => { const c = {}; let b = "", n = 0; a.forEach(x => { if (!x) return; c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; b = x; } }); return b; };
function decisionList(items) {
  if (!items.length) return `<div class="empty">Nothing needs a decision: no milestone is more than 3 sites behind baseline and no owner holds several open issues.</div>`;
  return `<div class="dec">${items.map((d, i) => `<div class="it" data-go='${esc(JSON.stringify(d.go))}'><span class="rk">${i + 1}</span>
    <span class="tx"><b>${esc(d.t)}</b><span>${d.d}</span></span><span class="sev"><span class="tag ${d.sev}">${d.sev === "crit" ? "Act now" : "Watch"}</span></span></div>`).join("")}</div>`;
}

/* ================================================================ narrative */
function health(spi, behind) {
  if (spi != null) return spi >= .95 && behind < .1 ? "ok" : spi >= .85 ? "watch" : "crit";
  return behind < .1 ? "ok" : behind < .25 ? "watch" : "crit";
}
const HEALTH_LBL = { ok: "On track", watch: "Needs attention", crit: "Off track" };

/* ================================================================ Project Overview */
function pageOverview(root) {
  const Tn = T(), from = FROM(), rows = scope("ov");
  const ps = S.ps;
  const rfi = msAgg(rows, 3, Tn, from), oa = msAgg(rows, 5, Tn, from), ho = msAgg(rows, 8, Tn, from);
  const woa = weekly(rows, 5, Tn);
  const vs = rows.map(s => siteView(s, Tn));
  const behind = vs.filter(v => v.overdue > 0).length;
  const iss = rows.filter(s => s.issueOpen);
  const openRisks = S.risks.filter(r => !/closed/i.test(txt(r.Status)));
  const hiRisk = openRisks.filter(r => /critical|high/i.test(txt(r["Risk Level"])));
  const hstate = health(ps && ps.spi, rows.length ? behind / rows.length : 0);
  const lede = `<b>${fmt(oa.done)}</b> of ${fmt(oa.app)} sites are On-Air and <b>${fmt(rfi.done)}</b> are ready for installation.
    ${ps && ps.actual != null ? `Weighted progress is <b>${P(ps.actual, 1)}</b> against ${P(ps.planned, 1)} planned.` : ""}
    ${behind ? `<b>${fmt(behind)}</b> sites are behind their baseline on the next milestone.` : "No site is behind its baseline."}
    ${woa && woa.ecd ? `At the current rate of ${woa.rate.toFixed(1)} On-Air sites a week, the scope completes around <b>${dstr(woa.ecd)}</b>.` : ""}`;
  const k = [
    kpi({ cls: "hero", lab: "Weighted physical progress", big: ps && ps.actual != null ? (ps.actual * 100).toFixed(1) : "—", small: "%", bar: ps && ps.actual, mark: ps && ps.planned, color: "var(--brand)",
      meta: ps ? `planned <b>${P(ps.planned, 1)}</b> · SPI <b class="${ps.spi >= .95 ? "ok" : ps.spi >= .85 ? "watch" : "crit"}">${ps.spi != null ? ps.spi.toFixed(2) : "—"}</b>` : "Project Status sheet not found" }),
    kpi({ lab: `<i class="dot" style="background:${STAGE_COL.rfi}"></i>Site RFI`, big: fmt(rfi.done), small: `/ ${fmt(rfi.app)}`, bar: pct(rfi.done, rfi.app), mark: pct(rfi.plan, rfi.app), color: STAGE_COL.rfi,
      meta: `plan ${fmt(rfi.plan)} ${deltaTag(rfi.done - rfi.plan)}${from ? ` · +${rfi.period} in period` : ""}`, go: { list: "ms", j: 3, st: "done" } }),
    kpi({ lab: `<i class="dot" style="background:${STAGE_COL.onair}"></i>On-Air`, big: fmt(oa.done), small: `/ ${fmt(oa.app)}`, bar: pct(oa.done, oa.app), mark: pct(oa.plan, oa.app), color: STAGE_COL.onair,
      meta: `plan ${fmt(oa.plan)} ${deltaTag(oa.done - oa.plan)}${from ? ` · +${oa.period} in period` : ""}`, go: { list: "ms", j: 5, st: "done" } }),
    kpi({ lab: `<i class="dot" style="background:${STAGE_COL.hoto}"></i>HOTO`, big: fmt(ho.done), small: `/ ${fmt(ho.app)}`, bar: pct(ho.done, ho.app), mark: pct(ho.plan, ho.app), color: STAGE_COL.hoto,
      meta: `plan ${fmt(ho.plan)} ${deltaTag(ho.done - ho.plan)}`, go: { list: "ms", j: 8, st: "done" } }),
    kpi({ lab: "On-Air forecast", big: woa && woa.ecd ? dshort(woa.ecd) : woa && woa.remain === 0 ? "Done" : "—", small: woa && woa.ecd ? String(woa.ecd.getUTCFullYear()) : "",
      meta: woa ? `${woa.rate.toFixed(1)} sites / week (last 8 weeks) · ${fmt(woa.remain)} to go` : "" }),
    kpi({ lab: "Needs attention", big: fmt(iss.length), small: "issues", meta: `<b>${fmt(behind)}</b> behind baseline · <b>${fmt(hiRisk.length)}</b> high risks`, go: { list: "issues" } }),
  ].join("");
  const pipe = pipeline(rows, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], Tn, from, { scopeMeta: `${fmt(rows.filter(s => s.hold).length)} on hold` });
  const sc = scurveDual(rows, Tn);
  const acts = ps && ps.acts.length ? barList(ps.acts.map(a => ({ l: `${a.no}. ${a.name}`, v: a.a || 0, vt: P(a.a), st: `/ ${P(a.p)}`, mark: a.p, c: (a.a || 0) >= (a.p || 0) * .95 ? "var(--ok)" : (a.a || 0) >= (a.p || 0) * .85 ? "var(--watch)" : "var(--crit)" })), { max: 1 }) : `<div class="empty">The Project Status sheet has no activity table.</div>`;
  const mix = statusMix(rows);
  const scen = scenarioTable(rows, Tn);
  root.innerHTML = `
    <div class="phead"><div><h1>Project Overview</h1></div><span class="status-pill ${hstate}"><i class="dot" style="background:currentColor"></i>${HEALTH_LBL[hstate]}</span><div class="sp"></div></div>
    <p class="lede">${lede}</p>
    <div class="kband">${k}</div>
    <div class="panel mt"><div class="ph"><h3>Delivery pipeline</h3><span class="sub">sites achieving each milestone, scope to closure · as of ${dstr(Tn)}${from ? ` · period from ${dstr(from)}` : ""}</span></div>${pipe.html}</div>
    <div class="g mt">
      <div class="panel c8"><div class="ph"><h3>RFI and On-Air against baseline</h3><span class="sub">cumulative sites per week</span></div>${sc}</div>
      <div class="panel c4"><div class="ph"><h3>Weighted progress by activity</h3><span class="sub">actual · tick = planned</span></div><div class="wide">${acts}</div>
        <div class="note">From the Project Status sheet${ps && ps.coverage != null ? ` · plan coverage ${P(ps.coverage)}` : ""}. Site filters do not change this figure.</div></div>
    </div>
    <div class="g mt">
      <div class="panel c7"><div class="ph"><h3>Sites on the map</h3><span class="sub">coloured by current milestone · larger dot = behind baseline · click a site</span></div>${mapPanel(rows, Tn, "ov")}</div>
      <div class="panel c5"><div class="ph"><h3>Decisions required</h3><span class="sub">ranked by size and age</span></div>${decisionList(decisions(rows, Tn, null))}</div>
    </div>
    <div class="panel mt"><div class="ph"><h3>Regions by milestone</h3><span class="sub">share of applicable sites done · small: done / applicable · negative = behind plan · click a cell for the sites</span></div>${heat(rows, [0, 1, 2, 3, 4, 5, 6, 7, 8], Tn)}</div>
    <div class="g mt">
      <div class="panel c4"><div class="ph"><h3>Site status</h3><span class="sub">Master Overall Status</span></div>
        ${stackBar([{ l: "Not started", v: mix["Not Started"], c: "#61757f", go: { list: "status", v: "Not Started" } }, { l: "In progress", v: mix["In Progress"], c: "var(--te)", go: { list: "status", v: "In Progress" } },
          { l: "On hold", v: mix["On Hold"], c: "var(--crit)", go: { list: "status", v: "On Hold" } }, { l: "Completed", v: mix.Completed, c: "var(--ok)", go: { list: "status", v: "Completed" } }])}
        <div class="note">${fmt(S.sites.filter(s => s.cancel).length)} cancelled sites are excluded from every figure.</div></div>
      <div class="panel c4"><div class="ph"><h3>Risks</h3><span class="sub">open · Risk Register</span></div>${riskMatrix(openRisks)}</div>
      <div class="panel c4"><div class="ph"><h3>Data quality</h3><span class="sub">checks with rows to fix</span></div>${dqPanel()}</div>
    </div>
    <div class="g mt">
      <div class="panel c8"><div class="ph"><h3>Swap and relocation</h3><span class="sub">by delivery scenario</span></div>${scen}</div>
      <div class="panel c4"><div class="ph"><h3>Dismantle</h3><span class="sub">legacy equipment recovery</span></div>${dismantle(rows, Tn)}</div>
    </div>`;
}
function scurveDual(rows, Tn) {
  const a = weekly(rows, 3, Tn), b = weekly(rows, 5, Tn);
  const ser = [];
  if (a && a.pts.length) { ser.push({ name: "RFI baseline", color: STAGE_COL.rfi, dash: "5 5", w: 1.6, pts: a.pts.map(p => [p.t, p.p]) }); ser.push({ name: "RFI actual", color: STAGE_COL.rfi, pts: a.pts.filter(p => p.a != null).map(p => [p.t, p.a]) }); }
  if (b && b.pts.length) { ser.push({ name: "On-Air baseline", color: STAGE_COL.onair, dash: "5 5", w: 1.6, pts: b.pts.map(p => [p.t, p.p]) }); ser.push({ name: "On-Air actual", color: STAGE_COL.onair, pts: b.pts.filter(p => p.a != null).map(p => [p.t, p.a]), area: true });
    if (b.ecd) ser.push({ name: "On-Air forecast", color: STAGE_COL.onair, dash: "1.5 5", pts: fcast(b, Tn) }); }
  return ser.length ? lineChart(ser, { marker: Tn, markerLabel: "Report date" }) : `<div class="empty">No baseline or actual dates yet.</div>`;
}
function riskMatrix(risks) {
  if (!risks.length) return `<div class="empty">No open risks in the Risk Register.</div>`;
  const cell = {}; risks.forEach(r => { const p = +r["Probability (1-5)"], i = +r["Impact (1-5)"]; if (p && i) { const k = p + "," + i; cell[k] = (cell[k] || 0) + 1; } });
  let h = "";
  for (let p = 5; p >= 1; p--) {
    h += `<div class="ax">${p}</div>`;
    for (let i = 1; i <= 5; i++) { const s = p * i, n = cell[p + "," + i] || 0; const c = s >= 15 ? "var(--crit)" : s >= 10 ? "var(--watch)" : s >= 5 ? "#9bc86a" : "var(--ok)";
      h += `<div style="background:color-mix(in srgb,${c} ${n ? 70 : 14}%,var(--surface2));color:${n ? "#0c1a22" : "transparent"}">${n || ""}</div>`; }
  }
  h += `<div class="ax"></div>${[1, 2, 3, 4, 5].map(i => `<div class="ax">${i}</div>`).join("")}`;
  const top = [...risks].sort(by(r => +r["Risk Score"] || 0, -1)).slice(0, 3);
  return `<div style="display:grid;grid-template-columns:150px 1fr;gap:14px;align-items:start"><div><div class="rmx">${h}</div><div class="note" style="margin-top:4px">probability ↑ · impact →</div></div>
    <div class="dec">${top.map(r => `<div class="it" style="grid-template-columns:1fr auto;cursor:default"><span class="tx"><b>${esc(txt(r["Risk ID"]))} · ${esc(txt(r["Risk Statement"]))}</b><span>${esc(txt(r["Risk Owner"]))} · ${esc(txt(r.Trend))}</span></span><span class="sev"><span class="tag ${/critical/i.test(txt(r["Risk Level"])) ? "crit" : /high/i.test(txt(r["Risk Level"])) ? "watch" : ""}">${esc(txt(r["Risk Score"]))}</span></span></div>`).join("")}</div></div>`;
}
function dqPanel() {
  if (!S.dq.length) return `<div class="empty">Data Quality sheet not found.</div>`;
  const bad = S.dq.filter(d => +d.Rows > 0).sort(by(d => (/high/i.test(txt(d.Severity)) ? 1000 : /medium/i.test(txt(d.Severity)) ? 100 : 0) + +d.Rows, -1));
  if (!bad.length) return `<div class="empty">All ${S.dq.length} checks pass.</div>`;
  return barList(bad.slice(0, 7).map(d => ({ l: `${txt(d["Check ID"])} ${txt(d.Check)}`, v: +d.Rows, c: /high/i.test(txt(d.Severity)) ? "var(--crit)" : /medium/i.test(txt(d.Severity)) ? "var(--watch)" : "var(--ink2)" })))
    + `<div class="note">${bad.length} of ${S.dq.length} checks need action. Fix them in the Master; see the Data Quality sheet.</div>`;
}
function scenarioTable(rows, Tn) {
  const sc = uniq(rows.map(s => txt(s.scen) || "(not set)"));
  const order = ["New Build", "Expansion", "Hot Swap", "Cold Swap", "Relocation"];
  sc.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const data = sc.map(k => { const sub = rows.filter(s => (txt(s.scen) || "(not set)") === k); const rf = msAgg(sub, 3, Tn), oa = msAgg(sub, 5, Tn), pac = msAgg(sub, 6, Tn);
    const cut = sub.filter(s => txt(s.cutRes)); const ok = cut.filter(s => /success|pass|ok/i.test(txt(s.cutRes))).length;
    return { id: k, k, n: sub.length, rfi: rf, oa, pac, cut: cut.length, ok, rb: sub.reduce((x, s) => x + (+s.rollback || 0), 0) }; });
  return table([{ k: "k", h: "Scenario", v: r => r.k, f: r => `<b>${esc(r.k)}</b>` }, { k: "n", h: "Sites", cls: "r", v: r => r.n, f: r => `<span class="num">${fmt(r.n)}</span>` },
    { k: "rfi", h: "RFI done", cls: "r", v: r => r.rfi.done, f: r => r.rfi.app ? `${fmt(r.rfi.done)} <span class="dim">/ ${fmt(r.rfi.app)}</span>` : `<span class="dim">N/A</span>` },
    { k: "oa", h: "On-Air", cls: "r", v: r => r.oa.done, f: r => `${fmt(r.oa.done)} <span class="dim">/ ${fmt(r.oa.app)}</span>` },
    { k: "oap", h: "On-Air %", v: r => pct(r.oa.done, r.oa.app), f: r => `<span class="mini"><i style="width:${(pct(r.oa.done, r.oa.app) || 0) * 100}%;background:${STAGE_COL.onair}"></i></span> ${P(pct(r.oa.done, r.oa.app))}` },
    { k: "pac", h: "TE PAC", cls: "r", v: r => r.pac.done, f: r => fmt(r.pac.done) },
    { k: "cut", h: "Cutover success", cls: "r", v: r => pct(r.ok, r.cut), f: r => r.cut ? `${P(pct(r.ok, r.cut))} <span class="dim">of ${r.cut}</span>` : `<span class="dim">—</span>` },
    { k: "rb", h: "Rollbacks", cls: "r", v: r => r.rb, f: r => r.rb ? `<span class="crit num">${r.rb}</span>` : `<span class="dim">0</span>` }], data);
}
function dismantle(rows) {
  const has = rows.some(s => "disCwRfd" in s);
  if (!has) return `<div class="empty">Dismantle columns not found.</div>`;
  const cw = rows.filter(s => yes(s.disCwRfd)), te = rows.filter(s => yes(s.disTeRfd));
  const line = (l, a, b, c, col) => ({ l, v: a, vt: `${fmt(b)} / ${fmt(a)}`, st: `RN ${fmt(c)}`, c: col });
  if (!cw.length && !te.length) return `<div class="empty">No site is marked ready for dismantle.</div>`;
  return barList([line("CW dismantle", cw.length, cw.filter(s => s.disCwAct instanceof Date).length, cw.filter(s => s.disCwRn instanceof Date).length, "var(--cw)"),
    line("TE dismantle", te.length, te.filter(s => s.disTeAct instanceof Date).length, te.filter(s => s.disTeRn instanceof Date).length, "var(--te)")])
    + `<div class="note">Executed of ready-for-dismantle sites · RN = equipment returned to the warehouse.</div>`;
}

/* ================================================================ CW / TE sections (one template) */
const SEC = {
  cw: { name: "Civil Works", short: "CW", color: "var(--cw)", ms: [0, 1, 2, 3], prime: 3, sub: 2, acts: [/civil/i], who: "contractor", whoL: "Contractor",
    steps: [["RF survey", "S_rf"], ["CW access", "cwAccess", "relA"], ["CW survey", "cwSurvey", "cwAccess"], ["Report submitted", "repSub", "cwSurvey"],
      ["Report approved", "repApp", "repSub"], ["CW DN approved", "cwDnApp", "repApp"], ["CW MOS", "cwMos", "g_cw"], ["CW start", "cwStart", "cwMos"],
      ["CW completion", "cwA", "cwStart"], ["CW PAC", "pacA", "cwA"], ["GECOL power", "#gecol", "cwA"], ["HLC fiber", "#hlc", "cwA"], ["Site RFI", "rfiA", "g_rfi"]],
    sla: c => /^(B-|C-|RFI|E2E-B)/.test(c) },
  te: { name: "Telecom Equipment", short: "TE", color: "var(--te)", ms: [4, 5, 6, 7, 8, 9], prime: 5, sub: 4, acts: [/te install/i, /integration/i, /testing/i], who: "vendor", whoL: "Vendor",
    steps: [["TE access", "teAccess", "g_te"], ["TE survey", "teSurvey", "teAccess"], ["DN submitted", "teDnSub", "teSurvey"], ["DN approved", "teDnApp", "teDnSub"],
      ["TE MOS", "teMos", "teDnApp"], ["TE start", "teStart", "teMos"], ["TE completion", "teA", "teStart"], ["Commissioning", "comm", "teA"],
      ["MW alignment", "mwAlign", "comm"], ["Integration", "integ", "comm"], ["On-Air", "onairA", "integ"], ["SSV", "ssvDate", "onairA"], ["HWID", "hwid", "onairA"],
      ["EIR", "eir", "hwid"], ["PAT", "pat", "eir"], ["As-Built", "teAsb", "pat"], ["TE PAC", "tepacA", "teAsb"], ["Cluster optimization", "clusterOpt", "tepacA"],
      ["KPI acceptance", "kpiA", "clusterOpt"], ["Material reconciliation", "matRec", "kpiA"], ["HOTO package", "hotoPkg", "matRec"], ["HOTO", "hotoA", "hotoPkg"]],
    sla: c => /^(D-|E2E-D|S-)/.test(c) },
};
const TABS = [["cockpit", "Cockpit"], ["milestones", "Milestones & checkpoints"], ["schedule", "Schedule"], ["flow", "Flow & SLA"],
  ["constraints", "Constraints & ownership"], ["partners", "Partners"], ["quality", "Quality & closure"], ["register", "Site register"]];
function sectionRows(sec) {
  const rows = secScope(scope(sec), sec);
  return rows;
}
function pageSection(root, sec) {
  const C = SEC[sec], tab = S.tab[sec];
  root.innerHTML = `<div class="phead"><div><h1>${C.short} · ${C.name}</h1></div><div class="sp"></div></div>
    <div class="tabs" style="--accent:${C.color}">${TABS.map(([k, l], i) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}"><span class="n">${i + 1}</span>${l}</button>`).join("")}</div><div id="tabBody"></div>`;
  const body = $("#tabBody", root);
  ({ cockpit: tabCockpit, milestones: tabMilestones, schedule: tabSchedule, flow: tabFlow, constraints: tabConstraints, partners: tabPartners, quality: tabQuality, register: tabRegister })[tab](body, sec);
}
function secActs(sec) {
  const ps = S.ps; if (!ps || !ps.acts.length) return null;
  const a = ps.acts.filter(x => SEC[sec].acts.some(re => re.test(x.name)));
  if (!a.length) return null;
  const w = a.reduce((x, y) => x + y.w, 0) || 1;
  return { a: a.reduce((x, y) => x + y.w * (y.a || 0), 0) / w, p: a.every(x => x.p != null) ? a.reduce((x, y) => x + y.w * (y.p || 0), 0) / w : null, acts: a };
}
function tabCockpit(el, sec) {
  const C = SEC[sec], Tn = T(), from = FROM(), rows = sectionRows(sec);
  const prime = msAgg(rows, C.prime, Tn, from), sub = msAgg(rows, C.sub, Tn, from);
  const vs = rows.map(s => ({ s, v: siteView(s, Tn) }));
  const here = vs.filter(x => x.v.next >= 0 && C.ms.includes(x.v.next));
  const inwork = here.filter(x => x.v.state === "due").length, waiting = here.filter(x => x.v.state === "wait").length;
  const behind = here.filter(x => x.v.overdue > 0);
  const iss = here.filter(x => x.s.issueOpen).length;
  const wa = secActs(sec);
  const slaC = slaStats(rows, sec);
  const within = slaC.reduce((x, s) => x + s.within, 0), tot = slaC.reduce((x, s) => x + s.n, 0);
  const k = [
    kpi({ cls: "hero", lab: `${C.short} weighted progress`, big: wa ? (wa.a * 100).toFixed(1) : "—", small: "%", bar: wa && wa.a, mark: wa && wa.p, color: C.color,
      meta: wa ? `planned <b>${P(wa.p, 1)}</b> · ${wa.acts.map(a => esc(a.name)).join(", ")}` : "Project Status activity not found" }),
    kpi({ lab: `<i class="dot" style="background:${STAGE_COL[MS[C.prime].k]}"></i>${MS[C.prime].n}`, big: fmt(prime.done), small: `/ ${fmt(prime.app)}`, bar: pct(prime.done, prime.app), mark: pct(prime.plan, prime.app), color: STAGE_COL[MS[C.prime].k],
      meta: `plan ${fmt(prime.plan)} ${deltaTag(prime.done - prime.plan)}${from ? ` · +${prime.period} in period` : ""}`, go: { list: "ms", j: C.prime, st: "done" } }),
    kpi({ lab: MS[C.sub].n, big: fmt(sub.done), small: `/ ${fmt(sub.app)}`, bar: pct(sub.done, sub.app), mark: pct(sub.plan, sub.app), color: STAGE_COL[MS[C.sub].k],
      meta: `plan ${fmt(sub.plan)} ${deltaTag(sub.done - sub.plan)}`, go: { list: "ms", j: C.sub, st: "done" } }),
    kpi({ lab: "In work now", big: fmt(inwork), meta: `${fmt(waiting)} waiting for readiness`, go: { list: "ids", title: `${C.short} · sites in work`, ids: here.filter(x => x.v.state === "due").map(x => x.s.id) } }),
    kpi({ lab: "Behind baseline", big: fmt(behind.length), meta: behind.length ? `median ${fmt(median(behind.map(x => x.v.overdue)))} days late` : "on or ahead of plan",
      go: { list: "ids", title: `${C.short} · behind baseline on next milestone`, ids: behind.map(x => x.s.id) } }),
    kpi({ lab: "SLA within max", big: tot ? Math.round(within / tot * 100) : "—", small: tot ? "%" : "", meta: `${fmt(tot)} completed steps · ${fmt(iss)} open issues` }),
  ].join("");
  const pipe = pipeline(rows, C.ms, Tn, from, { scopeLabel: `${C.short} scope`, scopeMeta: `${fmt(rows.filter(s => s.hold).length)} on hold` });
  const sc = sCurve(rows, C.prime, Tn, STAGE_COL[MS[C.prime].k], MS[C.prime].s);
  const thr = throughput(rows, C.ms.filter(j => j > 0), Tn);
  el.innerHTML = `<div class="kband">${k}</div>
    <div class="panel mt"><div class="ph"><h3>${C.short} pipeline</h3><span class="sub">as of ${dstr(Tn)}</span></div>${pipe.html}</div>
    <div class="g mt"><div class="panel c7"><div class="ph"><h3>${MS[C.prime].n} burn-up</h3><span class="sub">actual · baseline · forecast</span></div>${sc.html}</div>
      <div class="panel c5"><div class="ph"><h3>Weekly throughput</h3><span class="sub">milestones achieved per week · last 12 weeks</span></div>${thr}</div></div>
    <div class="g mt"><div class="panel c7"><div class="ph"><h3>Sites on the map</h3><span class="sub">${C.short} stage</span></div>${mapPanel(rows, Tn, sec)}</div>
      <div class="panel c5"><div class="ph"><h3>Decisions required</h3><span class="sub">${C.short}</span></div>${decisionList(decisions(rows, Tn, sec))}</div></div>`;
}
function throughput(rows, idx, Tn) {
  const wk = 7 * DAY, end = +Tn, start = end - 12 * wk;
  const weeks = Array.from({ length: 12 }, (_, i) => start + i * wk);
  const ser = idx.map(j => ({ j, c: weeks.map(w => rows.filter(s => { const a = s.ms[j].a; return a && !s.ms[j].na && +a > w && +a <= w + wk; }).length) }));
  const max = Math.max(1, ...ser.flatMap(s => s.c));
  const W = 520, H = 190, L = 28, B = 22, bw = (W - L) / 12;
  let g = "";
  for (let i = 0; i <= 3; i++) { const y = 8 + (H - B - 8) * (1 - i / 3); g += `<line class="gl" x1="${L}" x2="${W}" y1="${y}" y2="${y}"/><text x="${L - 5}" y="${y + 4}" text-anchor="end">${Math.round(max * i / 3)}</text>`; }
  const n = ser.length, gap = 3, iw = Math.max(2, (bw - 8 - gap * (n - 1)) / n);
  weeks.forEach((w, i) => {
    ser.forEach((s, k) => { const v = s.c[i], h = (H - B - 8) * v / max; const x = L + i * bw + 4 + k * (iw + gap);
      g += `<rect x="${x}" y="${H - B - h}" width="${iw}" height="${h}" rx="1.5" fill="${STAGE_COL[MS[s.j].k]}"><title>${MS[s.j].n} · week of ${dstr(new Date(w + DAY))}: ${v}</title></rect>`; });
    if (i % 2 === 0) g += `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${dshort(new Date(w + DAY))}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" style="height:${H}px">${g}<line class="ax" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/></svg></div>
    <div class="cleg">${ser.map(s => `<span><i style="background:${STAGE_COL[MS[s.j].k]}"></i>${MS[s.j].s} · ${s.c.reduce((a, b) => a + b, 0)}</span>`).join("")}</div>`;
}
function checkpoint(rows, sec, Tn) {
  const C = SEC[sec];
  const val = (s, key) => {
    if (key === "S_rf") return null;
    if (key[0] === "#") { const v = norm(s[key.slice(1)]); return v === "done" ? "done" : v === "n/a" ? "na" : v === "pending" ? "pend" : null; }
    const d = s[key]; if (d === "N/A") return "na"; return d instanceof Date && d <= Tn ? "done" : null;
  };
  const appl = (s, key) => {
    if (key === "#gecol") return yes(s.sowGecol); if (key === "#hlc") return yes(s.sowHlc);
    if (sec === "cw" && key !== "rfiA") return s.cwApp; if (key === "rfiA") return s.rfiApp; return s.teApp;
  };
  const out = [];
  for (const [l, key, pred] of C.steps) {
    if (key === "S_rf") continue;
    if (key[0] !== "#" && !rows.some(s => key in s)) continue;
    let app = 0, done = 0, pend = 0, nd = 0;
    for (const s of rows) {
      if (!appl(s, key)) continue;
      const v = val(s, key); if (v === "na") continue; app++;
      if (v === "done") { done++; continue; }
      const pv = pred ? (pred.startsWith("g_") ? (s[pred] instanceof Date && s[pred] <= Tn ? "done" : null) : val(s, pred)) : "done";
      if (v === "pend" || pv === "done") pend++; else nd++;
    }
    out.push({ l, key, app, done, pend, nd });
  }
  return out;
}
function tabMilestones(el, sec) {
  const C = SEC[sec], Tn = T(), from = FROM(), rows = sectionRows(sec);
  const pipe = pipeline(rows, C.ms, Tn, from, { scopeLabel: `${C.short} scope` });
  const cp = checkpoint(rows, sec, Tn);
  const max = Math.max(1, ...cp.map(c => c.app));
  const cpt = `<table class="t"><thead><tr><th>Checkpoint</th><th class="r">Applicable</th><th class="r">Done</th><th class="r">Pending (due)</th><th class="r">Not due</th><th style="width:38%">Progress</th><th class="r">% done</th></tr></thead><tbody>
    ${cp.map(c => `<tr><td><b>${c.l}</b></td><td class="r n">${fmt(c.app)}</td><td class="r n">${fmt(c.done)}</td><td class="r n ${c.pend > 0.2 * c.app ? "watch" : ""}">${fmt(c.pend)}</td><td class="r n dim">${fmt(c.nd)}</td>
      <td><div class="stack" style="height:10px;width:${c.app / max * 100}%"><i style="width:${pct(c.done, c.app) * 100 || 0}%;background:${C.color}"></i><i style="width:${pct(c.pend, c.app) * 100 || 0}%;background:color-mix(in srgb,${C.color} 35%,var(--surface2))"></i></div></td>
      <td class="r n">${P(pct(c.done, c.app))}</td></tr>`).join("")}</tbody></table>`;
  el.innerHTML = `<div class="panel"><div class="ph"><h3>Milestones</h3><span class="sub">the Master milestones of ${C.short}</span></div>${pipe.html}</div>
    <div class="panel mt"><div class="ph"><h3>Detailed checkpoints</h3><span class="sub">Pending (due) = previous checkpoint done, this one not yet · Not due = previous not done</span></div>${cpt}</div>
    <div class="panel mt"><div class="ph"><h3>Regions</h3><span class="sub">${C.short} milestones by region</span></div>${heat(rows, C.ms, Tn)}</div>`;
}
function tabSchedule(el, sec) {
  const C = SEC[sec], Tn = T(), rows = sectionRows(sec);
  const data = C.ms.map(j => { const a = msAgg(rows, j, Tn); return { id: MS[j].k, j, a }; });
  const st = table([{ k: "m", h: "Milestone", v: r => MS[r.j].n, f: r => `<i class="dot" style="background:${STAGE_COL[MS[r.j].k]}"></i> <b>${MS[r.j].n}</b>` },
    { k: "app", h: "Applicable", cls: "r", v: r => r.a.app, f: r => `<span class="num">${fmt(r.a.app)}</span>` },
    { k: "plan", h: "Planned to date", cls: "r", v: r => r.a.plan, f: r => `<span class="num">${fmt(r.a.plan)}</span>` },
    { k: "done", h: "Achieved", cls: "r", v: r => r.a.done, f: r => `<span class="num">${fmt(r.a.done)}</span>` },
    { k: "gap", h: "vs plan", cls: "r", v: r => r.a.done - r.a.plan, f: r => deltaTag(r.a.done - r.a.plan) },
    { k: "ot", h: "On time", cls: "r", v: r => pct(r.a.onTime, r.a.onTime + r.a.late), f: r => r.a.onTime + r.a.late ? `<span class="num ${pct(r.a.onTime, r.a.onTime + r.a.late) >= .8 ? "ok" : pct(r.a.onTime, r.a.onTime + r.a.late) >= .6 ? "watch" : "crit"}">${P(pct(r.a.onTime, r.a.onTime + r.a.late))}</span>` : "—" },
    { k: "var", h: "Median variance", cls: "r", v: r => median(r.a.varDays), f: r => r.a.varDays.length ? `<span class="num">${median(r.a.varDays) > 0 ? "+" : ""}${fmt(median(r.a.varDays))}d</span>` : "—" },
    { k: "ov", h: "Behind baseline", cls: "r", v: r => r.a.overdue, f: r => r.a.overdue ? `<span class="num crit" data-go='${esc(JSON.stringify({ list: "ms", j: r.j, st: "overdue" }))}' style="cursor:pointer">${fmt(r.a.overdue)}</span>` : "0" },
    { k: "ovm", h: "Median days late", cls: "r", v: r => median(r.a.ovDays), f: r => r.a.ovDays.length ? `<span class="num">${fmt(median(r.a.ovDays))}d</span>` : "—" }], data);
  const slips = [];
  for (const s of rows) for (const j of C.ms) {
    const m = s.ms[j]; if (m.na || !m.b) continue;
    const st2 = msState(s, j, Tn);
    const v = st2 === "done" ? days(m.a, m.b) : m.b < Tn ? days(Tn, m.b) : null;
    if (v > 0) slips.push({ id: s.id, s, j, v, open: st2 !== "done" });
  }
  slips.sort(by(x => x.v, -1));
  const sl = table([{ k: "id", h: "Site", v: r => r.id, f: r => `<b>${esc(r.id)}</b>` }, { k: "r", h: "Region", v: r => txt(r.s.region) },
    { k: "m", h: "Milestone", v: r => MS[r.j].n }, { k: "b", h: "Baseline", v: r => +r.s.ms[r.j].b, f: r => dstr(r.s.ms[r.j].b) },
    { k: "a", h: "Actual", v: r => r.s.ms[r.j].a ? +r.s.ms[r.j].a : null, f: r => r.open ? `<span class="tag watch">open</span>` : dstr(r.s.ms[r.j].a) },
    { k: "v", h: "Slip", cls: "r", v: r => r.v, f: r => `<span class="num ${r.v > 15 ? "crit" : "watch"}">+${r.v}d</span>` },
    { k: "w", h: SEC[sec].whoL, v: r => r.s[SEC[sec].who] }], slips.slice(0, 200), { key: "slip" + sec, click: true, maxh: 420 });
  const scA = sCurve(rows, C.sub, Tn, STAGE_COL[MS[C.sub].k], MS[C.sub].s);
  const scB = sCurve(rows, C.prime, Tn, STAGE_COL[MS[C.prime].k], MS[C.prime].s);
  el.innerHTML = `<div class="panel"><div class="ph"><h3>Schedule against baseline</h3><span class="sub">approved baseline from the Baseline sheet</span></div>${st}</div>
    <div class="g mt"><div class="panel c6"><div class="ph"><h3>${MS[C.sub].n}</h3><span class="sub">cumulative</span></div>${scA.html}</div>
      <div class="panel c6"><div class="ph"><h3>${MS[C.prime].n}</h3><span class="sub">cumulative</span></div>${scB.html}</div></div>
    <div class="panel mt"><div class="ph"><h3>Biggest slips</h3><span class="sub">achieved late, or still open past baseline · ${fmt(slips.length)} in total</span></div>${sl}</div>`;
}
function slaStats(rows, sec) {
  if (!S.sla) return [];
  const ids = new Set(rows.map(s => s.id));
  return S.sla.steps.filter(st => SEC[sec].sla(st.code)).map(st => {
    const d = [], o = [];
    for (const [id, v] of S.sla.per) { if (!ids.has(id)) continue; const x = v["done:" + st.code]; if (x != null) d.push(x); const y = v["open:" + st.code]; if (y != null) o.push(y); }
    const within = st.max != null ? d.filter(x => x <= st.max).length : d.length;
    return { ...st, n: d.length, med: median(d), p85: quant(d, .85), within, openN: o.length, openOver: st.max != null ? o.filter(x => x > st.max).length : 0 };
  }).filter(s => s.n || s.openN);
}
function tabFlow(el, sec) {
  const C = SEC[sec], Tn = T(), rows = sectionRows(sec);
  const ss = slaStats(rows, sec);
  const mx = Math.max(1, ...ss.map(s => Math.max(s.p85 || 0, s.max || 0)));
  const slaT = ss.length ? `<table class="t"><thead><tr><th>Step</th><th class="r">SLA max (wd)</th><th class="r">Completed</th><th class="r">Median</th><th class="r">P85</th><th style="width:28%">Median · P85 · max</th><th class="r">Within max</th><th class="r">Open over max</th></tr></thead><tbody>
    ${ss.map(s => { const w = pct(s.within, s.n);
      return `<tr><td><span class="dim">${esc(s.code)}</span> <b>${esc(s.name)}</b></td><td class="r n">${s.max == null ? "—" : fmt(s.max)}</td><td class="r n">${fmt(s.n)}</td><td class="r n">${s.med == null ? "—" : fmt(s.med)}</td><td class="r n">${s.p85 == null ? "—" : fmt(s.p85)}</td>
      <td><div style="position:relative;height:12px;background:var(--surface2);border-radius:6px">${s.p85 != null ? `<i style="position:absolute;left:0;top:3px;height:6px;border-radius:4px;width:${s.p85 / mx * 100}%;background:color-mix(in srgb,${C.color} 40%,transparent)"></i>` : ""}${s.med != null ? `<i style="position:absolute;left:0;top:3px;height:6px;border-radius:4px;width:${s.med / mx * 100}%;background:${C.color}"></i>` : ""}${s.max != null ? `<u style="position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--ink);left:${s.max / mx * 100}%"></u>` : ""}</div></td>
      <td class="r n ${w >= .8 ? "ok" : w >= .6 ? "watch" : "crit"}">${P(w)}</td><td class="r n ${s.openOver ? "crit" : "dim"}">${fmt(s.openOver)}<span class="dim"> / ${fmt(s.openN)}</span></td></tr>`; }).join("")}</tbody></table>` :
    `<div class="empty">The SLA sheet has no ${C.short} durations for these sites.</div>`;
  const vs = rows.map(s => ({ s, v: siteView(s, Tn) })).filter(x => x.v.next >= 0 && C.ms.includes(x.v.next));
  const cols = C.ms.filter(j => vs.some(x => x.v.next === j)).map(j => {
    const l = vs.filter(x => x.v.next === j);
    const b = AGE_B.map(([n]) => l.filter(x => ageBucket(x.v.age) === n).length);
    const old = [...l].sort(by(x => x.v.age ?? -1, -1)).slice(0, 5);
    return `<div class="kcol"><h4><span>${MS[j].n}</span><b class="num">${fmt(l.length)}</b></h4>
      <div class="ages">${AGE_B.map(([n, , c], i) => `<i style="width:${pct(b[i], l.length) * 100}%;background:${c}" title="${n}: ${b[i]}"></i>`).join("")}</div>
      <div class="muted" style="font-size:11.5px">${fmt(l.filter(x => x.v.state === "due").length)} in work · ${fmt(l.filter(x => x.v.state === "wait").length)} waiting</div>
      ${old.map(x => `<div class="kcard" data-site="${esc(x.s.id)}"><span>${esc(x.s.id)} <span class="dim">${esc(txt(x.s.region).split(" ")[0])}</span></span><em class="${x.v.age > 30 ? "crit" : x.v.age > 15 ? "watch" : ""}">${x.v.age == null ? "—" : x.v.age + "d"}</em></div>`).join("")}
      ${l.length > 5 ? `<button class="lnk" data-go='${esc(JSON.stringify({ list: "next", j }))}' style="text-align:left">All ${fmt(l.length)} sites</button>` : ""}</div>`;
  }).join("");
  el.innerHTML = `<div class="panel"><div class="ph"><h3>Work in progress by next milestone</h3><span class="sub">days since the step became possible · colour bar = age mix</span>
      <span class="sp"></span><span class="cleg" style="margin:0">${AGE_B.map(([n, , c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("")}</span></div><div class="kan">${cols || `<div class="empty">No ${C.short} work is open.</div>`}</div></div>
    <div class="panel mt"><div class="ph"><h3>SLA durations</h3><span class="sub">working days · from the SLA sheet · bar: median (solid), P85 (light), tick = SLA max</span></div>${slaT}</div>`;
}
function tabConstraints(el, sec) {
  const C = SEC[sec], Tn = T(), rows = sectionRows(sec);
  const vs = rows.map(s => ({ s, v: siteView(s, Tn) })).filter(x => x.v.next >= 0 && C.ms.includes(x.v.next));
  const stuck = C.ms.filter(j => j > 0).map(j => {
    const l = vs.filter(x => x.v.next === j);
    return { id: MS[j].k, j, wait: l.filter(x => x.v.state === "wait").length, due: l.filter(x => x.v.state === "due").length,
      ov: l.filter(x => x.v.overdue > 0).length, iss: l.filter(x => x.s.issueOpen).length, old: l.filter(x => x.v.age > 30).length };
  });
  const sT = `<table class="t"><thead><tr><th>Next milestone</th><th class="r">Waiting for readiness</th><th class="r">In work</th><th class="r">Older than 30 d</th><th class="r">Behind baseline</th><th class="r">Open issues</th><th>What the gate waits for</th></tr></thead><tbody>
    ${stuck.map(r => `<tr><td><b>${MS[r.j].n}</b></td>
      <td class="r n"><span style="cursor:pointer" data-go='${esc(JSON.stringify({ list: "next", j: r.j, st: "wait" }))}'>${fmt(r.wait)}</span></td>
      <td class="r n"><span style="cursor:pointer" data-go='${esc(JSON.stringify({ list: "next", j: r.j, st: "due" }))}'>${fmt(r.due)}</span></td>
      <td class="r n ${r.old ? "watch" : "dim"}">${fmt(r.old)}</td><td class="r n ${r.ov ? "crit" : "dim"}">${fmt(r.ov)}</td><td class="r n ${r.iss ? "crit" : "dim"}">${fmt(r.iss)}</td>
      <td class="wrap muted">${esc(GATE_HINT[MS[r.j].k])}</td></tr>`).join("")}</tbody></table>`;
  let extra = "";
  if (sec === "cw") {
    const waitRfi = vs.filter(x => x.v.next === 3);
    const g = waitRfi.filter(x => norm(x.s.gecol) === "pending"), h = waitRfi.filter(x => norm(x.s.hlc) === "pending"), p = waitRfi.filter(x => x.s.cwApp && !(x.s.pacA instanceof Date));
    extra = `<div class="panel c5"><div class="ph"><h3>What holds RFI</h3><span class="sub">${fmt(waitRfi.length)} sites with CW done and no RFI</span></div>
      ${barList([{ l: "CW PAC not dated", v: p.length, c: "var(--cw)", go: { list: "ids", title: "RFI pending · CW PAC not dated", ids: p.map(x => x.s.id) } },
        { l: "GECOL power pending", v: g.length, c: "var(--watch)", go: { list: "ids", title: "RFI pending · GECOL power", ids: g.map(x => x.s.id) } },
        { l: "HLC fiber pending", v: h.length, c: "var(--info)", go: { list: "ids", title: "RFI pending · HLC fiber", ids: h.map(x => x.s.id) } }], { max: Math.max(1, waitRfi.length) })}</div>`;
  } else {
    const live = new Set(rows.filter(s => msState(s, 5, Tn) === "done").map(s => s.id));
    const dep = vs.filter(x => x.v.next === 5 && txt(x.s.uplink) && x.s.uplink !== x.s.id && !live.has(txt(x.s.uplink)) && S.sites.some(y => y.id === txt(x.s.uplink)));
    const waitTE = vs.filter(x => x.v.next === 4 && x.v.state === "wait");
    extra = `<div class="panel c5"><div class="ph"><h3>Dependencies</h3><span class="sub">what TE waits for outside TE</span></div>
      ${barList([{ l: "Waiting for TE readiness", v: waitTE.length, c: "var(--te)", go: { list: "ids", title: "TE readiness not met", ids: waitTE.map(x => x.s.id) } },
        { l: "Uplink site not On-Air", v: dep.length, c: "var(--watch)", go: { list: "ids", title: "On-Air blocked by uplink site", ids: dep.map(x => x.s.id) } },
        { l: "RFI not yet achieved", v: rows.filter(s => s.rfiApp && msState(s, 3, Tn) !== "done" && msState(s, 4, Tn) !== "done").length, c: "var(--cw)" }])}</div>`;
  }
  const iss = vs.filter(x => x.s.issueOpen);
  const own = {}; iss.forEach(x => { const o = txt(x.s.issueOwner) || "(no owner)"; own[o] = (own[o] || 0) + 1; });
  const ownB = barList(Object.entries(own).sort((a, b) => b[1] - a[1]).map(([l, v]) => ({ l, v, c: "var(--crit)", go: { list: "issues", owner: l } })));
  S.sort["iss" + sec] = S.sort["iss" + sec] || { c: "ag", d: -1 };
  const it = table([{ k: "id", h: "Site", v: r => r.s.id, f: r => `<b>${esc(r.s.id)}</b>` }, { k: "rg", h: "Region", v: r => txt(r.s.region) },
    { k: "nx", h: "Next milestone", v: r => MS[r.v.next].n }, { k: "is", h: "Issue", v: r => txt(r.s.issue), cls: "wrap" }, { k: "ow", h: "Owner", v: r => txt(r.s.issueOwner) },
    { k: "ag", h: "Age", cls: "r", v: r => r.s.issueAge, f: r => r.s.issueAge == null ? "—" : `<span class="num ${r.s.issueAge > 60 ? "crit" : r.s.issueAge > 30 ? "watch" : ""}">${r.s.issueAge}d</span>` }],
    iss.map(x => Object.assign({ id: x.s.id }, x)), { key: "iss" + sec, click: true, maxh: 380 });
  el.innerHTML = `<div class="g"><div class="panel c7"><div class="ph"><h3>Where ${C.short} sites wait</h3><span class="sub">grouped by the next milestone · click a number</span></div>${sT}</div>${extra}</div>
    <div class="g mt"><div class="panel c4"><div class="ph"><h3>Open issues by owner</h3><span class="sub">${fmt(iss.length)} sites</span></div>${iss.length ? ownB : `<div class="empty">No open issue on ${C.short} sites.</div>`}</div>
      <div class="panel c8"><div class="ph"><h3>Open issues</h3><span class="sub">oldest first</span></div>${it}</div></div>
    <div class="panel mt"><div class="ph"><h3>Risks</h3><span class="sub">open · Risk Register</span></div>${riskMatrix(S.risks.filter(r => !/closed/i.test(txt(r.Status))))}</div>`;
}
function tabPartners(el, sec) {
  const C = SEC[sec], Tn = T(), rows = sectionRows(sec);
  const who = uniq(rows.map(s => txt(s[C.who])).filter(Boolean)).sort();
  const slaIds = S.sla ? S.sla.per : new Map();
  const e2e = sec === "cw" ? ["E2E-B1", "E2E-B2", "E2E-B3"] : ["E2E-D1"];
  const data = who.map(w => {
    const sub = rows.filter(s => txt(s[C.who]) === w);
    const p = msAgg(sub, C.prime, Tn), sb = msAgg(sub, C.sub, Tn);
    const vs = sub.map(s => siteView(s, Tn)).filter(v => v.next >= 0 && C.ms.includes(v.next));
    const dur = []; sub.forEach(s => { const o = slaIds.get(s.id); if (o) e2e.forEach(c => { if (o["done:" + c] != null) dur.push(o["done:" + c]); }); });
    const sn = sec === "cw" ? sub.filter(s => yes(s.snagF)).length : sub.filter(s => yes(s.teSnagF)).length;
    const snBase = sec === "cw" ? sub.filter(s => s.pacA instanceof Date).length : sub.filter(s => s.ms[6].a).length;
    return { id: w, w, n: sub.length, p, sb, open: vs.length, late: vs.filter(v => v.overdue > 0).length, iss: sub.filter(s => s.issueOpen).length,
      med: median(dur), ot: pct(p.onTime + sb.onTime, p.onTime + p.late + sb.onTime + sb.late), sn: pct(sn, Math.max(snBase, sn)) };
  });
  const t = data.length ? table([{ k: "w", h: C.whoL, v: r => r.w, f: r => `<b>${esc(r.w)}</b>` }, { k: "n", h: "Sites", cls: "r", v: r => r.n, f: r => `<span class="num">${fmt(r.n)}</span>` },
    { k: "sb", h: MS[C.sub].s, cls: "r", v: r => pct(r.sb.done, r.sb.app), f: r => `${fmt(r.sb.done)} <span class="dim">/ ${fmt(r.sb.app)}</span>` },
    { k: "p", h: MS[C.prime].s, cls: "r", v: r => pct(r.p.done, r.p.app), f: r => `${fmt(r.p.done)} <span class="dim">/ ${fmt(r.p.app)}</span>` },
    { k: "pp", h: "Progress", v: r => pct(r.p.done, r.p.app), f: r => `<span class="mini" style="width:90px"><i style="width:${(pct(r.p.done, r.p.app) || 0) * 100}%;background:${C.color}"></i></span> ${P(pct(r.p.done, r.p.app))}` },
    { k: "ot", h: "On time", cls: "r", v: r => r.ot, f: r => r.ot == null ? "—" : `<span class="num ${r.ot >= .8 ? "ok" : r.ot >= .6 ? "watch" : "crit"}">${P(r.ot)}</span>` },
    { k: "med", h: sec === "cw" ? "Median full CW (wd)" : "Median MOS → On-Air (wd)", cls: "r", v: r => r.med, f: r => r.med == null ? "—" : `<span class="num">${fmt(r.med)}</span>` },
    { k: "open", h: "Open work", cls: "r", v: r => r.open, f: r => `<span class="num">${fmt(r.open)}</span>` },
    { k: "late", h: "Behind baseline", cls: "r", v: r => r.late, f: r => r.late ? `<span class="num crit">${fmt(r.late)}</span>` : "0" },
    { k: "sn", h: "Snags at PAC", cls: "r", v: r => r.sn, f: r => r.sn == null ? "—" : P(r.sn) },
    { k: "iss", h: "Open issues", cls: "r", v: r => r.iss, f: r => r.iss ? `<span class="num crit">${fmt(r.iss)}</span>` : "0" }], data, { key: "par" + sec }) :
    `<div class="empty">No ${C.whoL.toLowerCase()} is recorded on these sites.</div>`;
  el.innerHTML = `<div class="panel"><div class="ph"><h3>${C.whoL} scorecard</h3><span class="sub">click a header to sort · on time = achieved by baseline date</span></div>${t}</div>
    <div class="g mt">${data.slice(0, 6).map(r => `<div class="panel c4"><div class="ph"><h3>${esc(r.w)}</h3><span class="sub">${fmt(r.n)} sites</span><span class="sp"></span><button class="lnk" data-go='${esc(JSON.stringify({ list: "field", f: C.who, v: r.w, title: `${C.whoL} · ${r.w}` }))}'>Sites</button></div>
      ${barList(C.ms.filter(j => j > 0).map(j => { const a = msAgg(rows.filter(s => txt(s[C.who]) === r.w), j, Tn); return { l: MS[j].s, v: pct(a.done, a.app) || 0, vt: P(pct(a.done, a.app)), st: `${a.done}/${a.app}`, mark: pct(a.plan, a.app), c: STAGE_COL[MS[j].k] }; }), { max: 1 })}</div>`).join("")}</div>`;
}
function tabQuality(el, sec) {
  const C = SEC[sec], Tn = T(), rows = sectionRows(sec);
  const qi = S.qi.filter(q => norm(q.Stage) === sec || !q.Stage);
  const ids = new Set(rows.map(s => s.id));
  const qiS = qi.filter(q => !txt(q["Site ID"]) || ids.has(txt(q["Site ID"])));
  const open = qiS.filter(q => !/closed|cleared|released|pass/i.test(txt(q.Status) + " " + txt(q.Result)) || /open/i.test(txt(q.Status)));
  const overdue = open.filter(q => { const d = toDate(q["Target Date"]); return d && d < Tn; });
  const sev = ["Critical", "Major", "Minor"].map(s => ({ l: s, v: open.filter(q => norm(q.Severity) === norm(s)).length, c: s === "Critical" ? "var(--crit)" : s === "Major" ? "var(--watch)" : "var(--ink2)" }));
  const qiPanel = `<div class="panel c4"><div class="ph"><h3>Quality inspections</h3><span class="sub">${C.short} stage · open records</span></div>
    ${qiS.length ? barList(sev) + `<div class="note">${fmt(open.length)} open of ${fmt(qiS.length)} · ${fmt(overdue.length)} past target · ${fmt(open.filter(q => yes(q.Blocking)).length)} blocking.</div>` : `<div class="empty">No ${C.short} inspection records.</div>`}</div>`;
  let body = "";
  if (sec === "cw") {
    const cwDone = rows.filter(s => msState(s, 2, Tn) === "done");
    const pac = cwDone.filter(s => s.pacA instanceof Date && s.pacA <= Tn);
    const snag = cwDone.filter(s => yes(s.snagF)), snagC = snag.filter(s => yes(s.snagC));
    const asb = cwDone.filter(s => yes(s.cwAsb));
    const dlp = pac.filter(s => s.dlpEnd instanceof Date && s.dlpEnd > Tn), fac = rows.filter(s => s.cwFac instanceof Date && s.cwFac <= Tn);
    const fdue = pac.filter(s => s.dlpEnd instanceof Date && s.dlpEnd <= Tn && !(s.cwFac instanceof Date));
    const gec = { done: rows.filter(s => norm(s.gecol) === "done").length, pend: rows.filter(s => norm(s.gecol) === "pending").length };
    const hlc = { done: rows.filter(s => norm(s.hlc) === "done").length, pend: rows.filter(s => norm(s.hlc) === "pending").length };
    body = `<div class="panel c8"><div class="ph"><h3>From CW completion to FAC</h3><span class="sub">acceptance and warranty</span></div>
      ${barList([{ l: "CW complete", v: cwDone.length, c: STAGE_COL.cw }, { l: "CW PAC dated", v: pac.length, c: STAGE_COL.rfi, go: { list: "ids", title: "CW PAC dated", ids: pac.map(s => s.id) } },
        { l: "As-Built submitted", v: asb.length, c: "var(--info)" }, { l: "In DLP (warranty)", v: dlp.length, c: "var(--watch)" },
        { l: "DLP ended, FAC due", v: fdue.length, c: "var(--crit)", go: { list: "ids", title: "DLP ended · CW FAC not dated", ids: fdue.map(s => s.id) } }, { l: "CW FAC", v: fac.length, c: "var(--ok)" }], { max: Math.max(1, cwDone.length) })}
      <div class="note">First-time pass at PAC: <b>${P(pct(cwDone.length - snag.length, cwDone.length))}</b> of completed sites had no snag · ${fmt(snag.length)} with snags, ${fmt(snagC.length)} cleared.</div></div>
      ${qiPanel}
      <div class="panel c6"><div class="ph"><h3>GECOL power</h3><span class="sub">sites with GECOL in scope</span></div>${stackBar([{ l: "Done", v: gec.done, c: "var(--ok)" }, { l: "Pending", v: gec.pend, c: "var(--watch)" }])}</div>
      <div class="panel c6"><div class="ph"><h3>HLC fiber</h3><span class="sub">sites with HLC in scope</span></div>${stackBar([{ l: "Done", v: hlc.done, c: "var(--ok)" }, { l: "Pending", v: hlc.pend, c: "var(--watch)" }])}</div>`;
  } else {
    const live = rows.filter(s => msState(s, 5, Tn) === "done");
    const ssv = live.filter(s => txt(s.ssvRes)), ssvOk = ssv.filter(s => /pass/i.test(txt(s.ssvRes)));
    const d = k => live.filter(s => s[k] instanceof Date && s[k] <= Tn).length;
    const pac = d("tepacA"), fac = rows.filter(s => s.teFac instanceof Date && s.teFac <= Tn).length;
    const sn = live.filter(s => yes(s.teSnagF)), snC = sn.filter(s => yes(s.teSnagC));
    const rsl = rows.map(s => +s.rslDev).filter(x => !isNaN(x) && s_ok(x));
    const out = rsl.filter(x => Math.abs(x) > 3).length;
    const cut = rows.filter(s => txt(s.cutRes)), cutOk = cut.filter(s => /success|pass|ok/i.test(txt(s.cutRes)));
    body = `<div class="panel c8"><div class="ph"><h3>From On-Air to TE PAC</h3><span class="sub">acceptance documents · ${fmt(live.length)} sites On-Air</span></div>
      ${barList([{ l: "SSV done", v: ssv.length, st: ssv.length ? `${P(pct(ssvOk.length, ssv.length))} pass` : "", c: "var(--info)" }, { l: "HWID", v: d("hwid"), c: "var(--te)" },
        { l: "EIR (standalone)", v: d("eir"), c: "var(--te)" }, { l: "PAT (network test)", v: d("pat"), c: "var(--te)" }, { l: "As-Built", v: d("teAsb"), c: "var(--te)" },
        { l: "TE PAC", v: pac, c: STAGE_COL.tepac, go: { list: "ms", j: 6, st: "done" } }, { l: "TE FAC", v: fac, c: "var(--ok)" }], { max: Math.max(1, live.length) })}
      <div class="note">${fmt(sn.length)} On-Air sites raised TE snags, ${fmt(snC.length)} cleared.</div></div>
      ${qiPanel}
      <div class="panel c6"><div class="ph"><h3>MW link RSL deviation</h3><span class="sub">measured against design · dB</span></div>${rsl.length ? rslHist(rsl) + `<div class="note">${fmt(out)} of ${fmt(rsl.length)} links deviate by more than 3 dB.</div>` : `<div class="empty">No RSL measurements yet.</div>`}</div>
      <div class="panel c6"><div class="ph"><h3>Cutover</h3><span class="sub">swap sites</span></div>${cut.length ? stackBar([{ l: "Success", v: cutOk.length, c: "var(--ok)" }, { l: "Rolled back / failed", v: cut.length - cutOk.length, c: "var(--crit)" }]) : `<div class="empty">No cutover results yet.</div>`}</div>`;
  }
  el.innerHTML = `<div class="g">${body}</div>`;
}
const s_ok = x => Math.abs(x) < 40;
function rslHist(v) {
  const bins = [-9, -6, -3, -1, 1, 3, 6, 9]; const lab = ["< −9", "−9…−6", "−6…−3", "−3…−1", "±1", "1…3", "3…6", "6…9", "> 9"];
  const c = new Array(9).fill(0); v.forEach(x => { let i = bins.findIndex(b => x < b); if (i < 0) i = 8; c[i]++; });
  return barList(lab.map((l, i) => ({ l, v: c[i], c: Math.abs(i - 4) <= 1 ? "var(--ok)" : Math.abs(i - 4) === 2 ? "var(--watch)" : "var(--crit)" })));
}
function tabRegister(el, sec) {
  const Tn = T(), rows = sectionRows(sec).map(s => Object.assign(s, { _v: siteView(s, Tn) }));
  const key = "reg" + sec, q = norm(S.search[key] || "");
  const data = rows.filter(s => !q || norm([s.id, s.name, s.region, s.contractor, s.vendor, s.issue, s.cluster].join(" ")).includes(q));
  const cols = siteCols(sec);
  el.innerHTML = `<div class="panel"><div class="ph"><h3>Site register</h3><span class="sub">${fmt(data.length)} of ${fmt(rows.length)} sites · click a row for the site card</span><span class="sp"></span>
    <div class="tools"><input class="search" id="regQ" placeholder="Search site, region, contractor, issue…" value="${esc(S.search[key] || "")}"><button class="btn ghost" id="regCsv">${ICON.dl} CSV</button></div></div>
    ${table(cols, data, { key, click: true, maxh: 680, cap: 600 })}</div>`;
  const qi = $("#regQ", el); qi.oninput = () => { S.search[key] = qi.value; const p = qi.selectionStart; render(); const n = $("#regQ"); if (n) { n.focus(); n.setSelectionRange(p, p); } };
  $("#regCsv", el).onclick = () => csv(`GSDN_${sec.toUpperCase()}_register_${iso(Tn)}`, cols, data);
}

/* ================================================================ print · one A4 landscape sheet per page */
function printSheet() {
  const Tn = T(), from = FROM(), sec = S.page === "ov" ? null : S.page;
  const rows = sec ? sectionRows(sec) : scope("ov");
  const fl = FILTERS.filter(([k, , , pg]) => S.F[k] && (!pg || pg === S.page)).map(([k, l]) => `${l}: ${S.F[k]}`).join(" · ") || "All sites";
  const head = (t) => `<div class="ps-h"><h1>${t}</h1><div class="meta">GSDN Site Delivery · as of ${dstr(Tn)}${from ? ` · period from ${dstr(from)}` : ""} · ${esc(fl)}</div><div class="sp"></div><div class="meta">Source: ${esc(S.file)}</div></div>`;
  const kbox = items => `<div class="ps-k">${items.map(i => `<div><div class="l">${i[0]}</div><div class="v">${i[1]}${i[2] ? `<small> ${i[2]}</small>` : ""}</div><div class="m">${i[3] || ""}</div></div>`).join("")}</div>`;
  let html;
  if (!sec) {
    const ps = S.ps, rfi = msAgg(rows, 3, Tn, from), oa = msAgg(rows, 5, Tn, from), ho = msAgg(rows, 8, Tn, from), w = weekly(rows, 5, Tn);
    const behind = rows.map(s => siteView(s, Tn)).filter(v => v.overdue > 0).length;
    const lede = $("#main .lede") ? $("#main .lede").innerHTML : "";
    html = head("Project Overview") + `<div class="ps-lede">${lede}</div>` +
      kbox([["Weighted progress", ps ? P(ps.actual, 1) : "—", "", ps ? `planned ${P(ps.planned, 1)} · SPI ${ps.spi != null ? ps.spi.toFixed(2) : "—"}` : ""],
        ["Site RFI", fmt(rfi.done), `/ ${fmt(rfi.app)}`, `plan ${fmt(rfi.plan)} (${rfi.done - rfi.plan >= 0 ? "+" : ""}${rfi.done - rfi.plan})`],
        ["On-Air", fmt(oa.done), `/ ${fmt(oa.app)}`, `plan ${fmt(oa.plan)} (${oa.done - oa.plan >= 0 ? "+" : ""}${oa.done - oa.plan})`],
        ["HOTO", fmt(ho.done), `/ ${fmt(ho.app)}`, `plan ${fmt(ho.plan)}`],
        ["On-Air forecast", w && w.ecd ? dstr(w.ecd) : "—", "", w ? `${w.rate.toFixed(1)} sites / week` : ""],
        ["Behind baseline", fmt(behind), "sites", `${fmt(rows.filter(s => s.issueOpen).length)} open issues`]]) +
      `<div class="ps-box"><h3>Delivery pipeline</h3>${pipeline(rows, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], Tn, from).html.replace(/<div class="pipe-legend">[\s\S]*$/, "")}</div>
      <div class="ps-g" style="flex:1"><div class="ps-box" style="grid-column:span 5"><h3>RFI and On-Air against baseline</h3>${scurveDual(rows, Tn).replace(/height:\d+px/, "height:150px")}</div>
        <div class="ps-box" style="grid-column:span 4"><h3>Regions by milestone (% done)</h3>${heat(rows, [2, 3, 4, 5, 6, 8], Tn)}</div>
        <div class="ps-box" style="grid-column:span 3"><h3>Decisions required</h3>${decisionList(decisions(rows, Tn, null).slice(0, 4))}</div></div>`;
  } else {
    const C = SEC[sec], p = msAgg(rows, C.prime, Tn, from), sb = msAgg(rows, C.sub, Tn, from), wa = secActs(sec);
    const vs = rows.map(s => siteView(s, Tn)).filter(v => v.next >= 0 && C.ms.includes(v.next));
    const cp = checkpoint(rows, sec, Tn);
    const half = Math.ceil(cp.length / 2);
    const cpb = l => barList(l.map(c => ({ l: c.l, v: pct(c.done, c.app) || 0, vt: P(pct(c.done, c.app)), st: `${c.done}/${c.app}`, c: C.color })), { max: 1 });
    html = head(`${C.short} · ${C.name}`) +
      kbox([[`${C.short} weighted progress`, wa ? P(wa.a, 1) : "—", "", wa && wa.p != null ? `planned ${P(wa.p, 1)}` : ""],
        [MS[C.prime].n, fmt(p.done), `/ ${fmt(p.app)}`, `plan ${fmt(p.plan)} (${p.done - p.plan >= 0 ? "+" : ""}${p.done - p.plan})`],
        [MS[C.sub].n, fmt(sb.done), `/ ${fmt(sb.app)}`, `plan ${fmt(sb.plan)}`],
        ["In work now", fmt(vs.filter(v => v.state === "due").length), "", `${fmt(vs.filter(v => v.state === "wait").length)} waiting for readiness`],
        ["Behind baseline", fmt(vs.filter(v => v.overdue > 0).length), "sites", ""],
        ["Open issues", fmt(rows.filter(s => s.issueOpen).length), "sites", ""]]) +
      `<div class="ps-box"><h3>${C.short} pipeline</h3>${pipeline(rows, C.ms, Tn, from, { scopeLabel: `${C.short} scope` }).html.replace(/<div class="pipe-legend">[\s\S]*$/, "")}</div>
      <div class="ps-g" style="flex:1"><div class="ps-box" style="grid-column:span 4"><h3>${MS[C.prime].n} against baseline</h3>${sCurve(rows, C.prime, Tn, STAGE_COL[MS[C.prime].k], MS[C.prime].s).html.replace(/height:\d+px/, "height:140px")}</div>
        <div class="ps-box" style="grid-column:span 5"><h3>Checkpoints (% done)</h3><div style="display:grid;grid-template-columns:1fr 1fr;gap:3mm">${cpb(cp.slice(0, half))}${cpb(cp.slice(half))}</div></div>
        <div class="ps-box" style="grid-column:span 3"><h3>Decisions required</h3>${decisionList(decisions(rows, Tn, sec).slice(0, 4))}</div></div>
      <div class="ps-g"><div class="ps-box" style="grid-column:span 6"><h3>Regions by milestone (% done)</h3>${heat(rows, C.ms.filter(j => j > 0), Tn)}</div>
        <div class="ps-box" style="grid-column:span 6"><h3>${C.whoL}s</h3>${partnerMini(rows, sec, Tn)}</div></div>`;
  }
  html += `<div class="ps-f"><span>GSDN Site Delivery Dashboard · computed from the Master workbook</span><span>Printed ${dstr(new Date())}</span></div>`;
  $("#printSheet").innerHTML = `<div class="ps"><div class="ps-in">${html}</div></div>`;
  fitPrint();
  setTimeout(() => window.print(), 60);
}

function partnerMini(rows, sec, Tn) {
  const C = SEC[sec];
  const data = uniq(rows.map(s => txt(s[C.who])).filter(Boolean)).map(w => {
    const sub = rows.filter(s => txt(s[C.who]) === w), p = msAgg(sub, C.prime, Tn), sb = msAgg(sub, C.sub, Tn);
    const vs = sub.map(s => siteView(s, Tn)).filter(v => v.next >= 0 && C.ms.includes(v.next));
    return { id: w, w, n: sub.length, p, sb, late: vs.filter(v => v.overdue > 0).length, iss: sub.filter(s => s.issueOpen).length };
  }).sort(by(r => r.n, -1)).slice(0, 8);
  return table([{ k: "w", h: C.whoL, v: r => r.w, f: r => `<b>${esc(r.w)}</b>` }, { k: "n", h: "Sites", cls: "r", v: r => r.n },
    { k: "sb", h: MS[C.sub].s, cls: "r", v: r => r.sb.done, f: r => `${r.sb.done} / ${r.sb.app}` }, { k: "p", h: MS[C.prime].s, cls: "r", v: r => r.p.done, f: r => `${r.p.done} / ${r.p.app} · ${P(pct(r.p.done, r.p.app))}` },
    { k: "l", h: "Behind baseline", cls: "r", v: r => r.late }, { k: "i", h: "Open issues", cls: "r", v: r => r.iss }], data);
}
/* shrink the sheet content until it fits one A4 landscape page */
function fitPrint() {
  const box = $("#printSheet"), inner = $(".ps-in", box);
  box.style.cssText = "display:block;position:absolute;left:-10000px;top:0";
  inner.style.zoom = 1;
  const target = $(".ps", box).clientHeight, h = inner.scrollHeight;
  if (h > target * .96) inner.style.zoom = (target * .96 / h).toFixed(3);
  box.style.cssText = "";
}

/* ================================================================ shell */
function filterBar() {
  const opts = k => uniq(S.sites.filter(s => !s.cancel).map(s => txt(s[k])).filter(Boolean)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const f = FILTERS.filter(([, , , pg]) => !pg || pg === S.page).map(([k, l, fld]) => {
    const o = opts(fld); if (!o.length) return "";
    return `<div class="fld"><label for="f_${k}">${l}</label><select id="f_${k}" data-f="${k}" class="${S.F[k] ? "set" : ""}"><option value="">All</option>${o.map(v => `<option ${S.F[k] === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>`;
  }).join("");
  const any = Object.entries(S.F).some(([k, v]) => v && (!FILTERS.find(f => f[0] === k && f[3] && f[3] !== S.page)));
  $("#filters").innerHTML = `<div class="filters-in">${f}<span class="fsep"></span>
    <div class="fld"><label for="f_from">Period from</label><input type="date" id="f_from" data-f="from" value="${S.F.from}" class="${S.F.from ? "set" : ""}"></div>
    <div class="fld"><label for="f_to">To · as of</label><input type="date" id="f_to" data-f="to" value="${S.F.to || iso(S.rpt)}" class="${S.F.to && S.F.to !== iso(S.rpt) ? "set" : ""}"></div>
    ${S.F.from ? `<span class="period-note">Pipeline and KPIs add what was achieved in the period.</span>` : ""}
    ${any ? `<button class="freset" id="freset">Clear filters</button>` : ""}</div>`;
  $$("#filters [data-f]").forEach(el => el.onchange = () => { let v = el.value; if (el.dataset.f === "to" && v === iso(S.rpt)) v = ""; S.F[el.dataset.f] = v; render(); });
  const r = $("#freset"); if (r) r.onclick = () => { Object.keys(S.F).forEach(k => S.F[k] = ""); render(); };
}
function setPage(p, tab) { S.page = p; if (tab) S.tab[p] = tab; render(); scrollTo({ top: 0 }); }
function render() {
  $$(".seg button").forEach(b => b.classList.toggle("on", b.dataset.page === S.page));
  filterBar();
  const Tn = T();
  $("#asofD").textContent = dstr(Tn);
  $("#asofL").textContent = S.F.to ? "As of (time-shifted)" : "Report date";
  const root = $("#main");
  for (const k in CHARTS) delete CHARTS[k];
  if (S.page === "ov") pageOverview(root); else pageSection(root, S.page);
  $$("[data-tab]", root).forEach(b => b.onclick = () => { S.tab[S.page] = b.dataset.tab; render(); });
  wireCommon(root);
  $("#foot").innerHTML = `<div class="foot-in"><span>${esc(S.file)}</span><span>${fmt(S.sites.length)} Master rows · ${fmt(S.sites.filter(s => s.cancel).length)} cancelled</span>${S.warn.map(w => `<span class="watch">${esc(w)}</span>`).join("")}<span style="margin-left:auto">GSDN Site Delivery Dashboard</span></div>`;
}
function wireCommon(root) {
  $$("[data-site]", root).forEach(el => el.addEventListener("click", e => { e.stopPropagation(); openSite(el.dataset.site); }));
  $$("[data-go]", root).forEach(el => el.addEventListener("click", e => { e.stopPropagation(); const g = JSON.parse(el.dataset.go); if (g.dq) return dqModal(); if (g.risk) return riskModal(); go(g); }));
  $$("[data-pipe]", root).forEach(el => el.onclick = () => { const k = el.dataset.pipe; if (k === "scope") go({ list: "scope" }); else pipeModal(MSI[k]); });
  $$("[data-sort]", root).forEach(th => th.onclick = () => { const [key, c] = th.dataset.sort.split("|"); const cur = S.sort[key]; S.sort[key] = { c, d: cur && cur.c === c ? -cur.d : -1 }; if (key === "list") renderList(); else render(); });
  $$("[data-mapkey]", root).forEach(el => el.onclick = () => { const k = el.dataset.mapkey; S.mapOff.has(k) ? S.mapOff.delete(k) : S.mapOff.add(k); render(); });
  $$("circle[data-tipsite]", root).forEach(c => {
    c.addEventListener("mouseenter", e => { const s = siteById(c.dataset.site), v = siteView(s, T()); const w = whereText(s, v);
      showTip(`<b>${esc(s.id)} · ${esc(s.name || "")}</b><div class="r"><span>${esc(w.now)}</span></div>${v.overdue ? `<div class="r"><span class="crit">Behind baseline</span><em>${v.overdue}d</em></div>` : ""}${s.issueOpen ? `<div class="r"><span class="crit">${esc(s.issue)}</span></div>` : ""}`, e); });
    c.addEventListener("mousemove", e => showTip(tip.el.innerHTML, e));
    c.addEventListener("mouseleave", hideTip);
  });
  wireCharts(root); wireMaps(root);
}
function pipeModal(j) {
  const Tn = T(), sec = S.page === "ov" ? null : S.page, rows = secScope(scope(), sec), a = msAgg(rows, j, Tn, FROM());
  const opts = [["done", "Achieved", a.done], ["due", "In work", a.due], ["wait", "Waiting for readiness", a.wait], ["overdue", "Behind baseline", a.overdue]];
  if (FROM()) opts.splice(1, 0, ["period", "Achieved in period", a.period]);
  go({ list: "ms", j, st: a.overdue ? "overdue" : "due" });
  const bar = `<div style="display:flex;gap:6px;margin:-4px 0 12px;flex-wrap:wrap">${opts.map(([k, l, n]) => `<button class="chip click" data-ms="${k}">${l} <b class="num">${fmt(n)}</b></button>`).join("")}</div>`;
  const inject = () => { const b = $("#modal .md-b"); if (!b || $("#modal [data-ms]")) return; b.insertAdjacentHTML("afterbegin", bar);
    $$("#modal [data-ms]").forEach(x => x.onclick = () => { go({ list: "ms", j, st: x.dataset.ms }); inject(); }); };
  inject();
}
function dqModal() {
  const rows = S.dq.map(d => ({ id: d["Check ID"], ...d }));
  $("#modal").innerHTML = `<div class="md-h"><h3>Data quality checks</h3><span class="sp"></span><button class="ibtn" data-close aria-label="Close">${ICON.x}</button></div><div class="md-b">
    ${table([{ k: "id", h: "Check", v: r => txt(r["Check ID"]) }, { k: "a", h: "Area", v: r => txt(r.Area) }, { k: "c", h: "Rule", cls: "wrap", v: r => txt(r.Check) },
      { k: "r", h: "Rows", cls: "r", v: r => +r.Rows || 0, f: r => +r.Rows ? `<span class="num crit">${r.Rows}</span>` : `<span class="dim">0</span>` },
      { k: "s", h: "Severity", v: r => txt(r.Severity) }, { k: "f", h: "How to fix", cls: "wrap", v: r => txt(r["How to fix"]) }], rows, { maxh: 640 })}</div>`;
  $("#modal").classList.add("on"); $("#scrim").classList.add("on"); $("#modal [data-close]").onclick = closeOverlays;
}
function riskModal() {
  const rows = S.risks.map(r => ({ id: r["Risk ID"], ...r }));
  $("#modal").innerHTML = `<div class="md-h"><h3>Risk Register</h3><span class="sp"></span><button class="ibtn" data-close aria-label="Close">${ICON.x}</button></div><div class="md-b">
    ${table([{ k: "id", h: "ID", v: r => txt(r["Risk ID"]) }, { k: "s", h: "Risk", cls: "wrap", v: r => txt(r["Risk Statement"]) }, { k: "c", h: "Category", v: r => txt(r.Category) },
      { k: "sc", h: "Score", cls: "r", v: r => +r["Risk Score"] || 0 }, { k: "l", h: "Level", v: r => txt(r["Risk Level"]), f: r => `<span class="tag ${/critical/i.test(txt(r["Risk Level"])) ? "crit" : /high/i.test(txt(r["Risk Level"])) ? "watch" : ""}">${esc(txt(r["Risk Level"]))}</span>` },
      { k: "m", h: "Mitigation", cls: "wrap", v: r => txt(r["Mitigation Action"]) }, { k: "o", h: "Owner", v: r => txt(r["Risk Owner"]) },
      { k: "t", h: "Target", v: r => toDate(r["Target Date"]) ? +toDate(r["Target Date"]) : null, f: r => dstr(toDate(r["Target Date"])) }, { k: "st", h: "Status", v: r => txt(r.Status) }, { k: "tr", h: "Trend", v: r => txt(r.Trend) }], rows, { maxh: 640 })}</div>`;
  $("#modal").classList.add("on"); $("#scrim").classList.add("on"); $("#modal [data-close]").onclick = closeOverlays;
}
function setTheme(t) {
  S.theme = t; document.documentElement.dataset.theme = t;
  $$(".themeBtn").forEach(b => b.innerHTML = t === "dark" ? ICON.sun : ICON.moon);
  try { localStorage.setItem("gsdn-theme", t); } catch (e) { /* storage unavailable */ }
}
function load(file) {
  const err = $("#gateErr"); err.textContent = "";
  $("#dropMsg").textContent = `Reading ${file.name}…`;
  const fr = new FileReader();
  fr.onload = e => {
    setTimeout(() => {
      try {
        S.warn = [];
        S.wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: false, cellNF: false, cellStyles: false });
        S.file = file.name;
        S.rpt = readReportDate();
        const raw = readMaster();
        S.sites = raw.map(buildSite);
        S.ps = readProjectStatus();
        S.sla = readSLA(new Set(S.sites.map(s => s.id)));
        S.risks = readTable("Risk Register", "Risk ID");
        S.dq = readTable("Data Quality", "Check ID");
        S.qi = readTable("Quality Inspections", "Record ID");
        if (!S.ps) S.warn.push("Project Status sheet not found; weighted progress is not shown.");
        if (!S.sla) S.warn.push("SLA sheet not found; SLA durations are not shown.");
        $("#gate").classList.add("hidden"); $("#app").classList.remove("hidden");
        render();
      } catch (ex) {
        console.error(ex);
        err.textContent = ex.message || String(ex);
        $("#dropMsg").textContent = "Drop the Master workbook here";
      }
    }, 20);
  };
  fr.readAsArrayBuffer(file);
}
function inLibya(x, y) {
  let c = false; const R = LIBYA_RING;
  for (let i = 0, j = R.length - 2; i < R.length; j = i, i += 2) {
    const xi = R[i], yi = R[i + 1], xj = R[j], yj = R[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function gateArt() {
  let dots = "";
  let seed = 11; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 900; i++) {
    const la = 20 + rnd() * 13.4, lo = 9.5 + rnd() * 15.5; if (!inLibya(lo, la)) continue;
    const k = Object.keys(STAGE_COL)[Math.floor(rnd() * 11)];
    dots += `<circle cx="${GEO.px(lo).toFixed(1)}" cy="${GEO.py(la).toFixed(1)}" r="${3 + rnd() * 2}" fill="${STAGE_COL[k]}" opacity=".85"/>`;
  }
  return `<svg viewBox="-60 -80 ${GEO.W + 120} ${GEO.H + 260}" preserveAspectRatio="xMidYMid slice"><path d="${GEO.path}" fill="var(--land)" stroke="var(--land-line)" stroke-width="1.5"/>${dots}</svg>`;
}
function boot() {
  tip.el = $("#tip");
  let t = "dark"; try { t = localStorage.getItem("gsdn-theme") || "dark"; } catch (e) { /* storage unavailable */ }
  setTheme(t);
  $(".gate-art").insertAdjacentHTML("afterbegin", gateArt());
  $$(".themeBtn").forEach(b => b.onclick = () => setTheme(S.theme === "dark" ? "light" : "dark"));
  const drop = $("#drop"), inp = $("#file");
  $("#pick").onclick = () => inp.click();
  inp.onchange = () => inp.files[0] && load(inp.files[0]);
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) load(f); });
  $$(".seg button").forEach(b => b.onclick = () => setPage(b.dataset.page));
  $("#printBtn").onclick = printSheet;
  $("#newBtn").onclick = () => { $("#app").classList.add("hidden"); $("#gate").classList.remove("hidden"); inp.value = ""; $("#dropMsg").textContent = "Drop the Master workbook here"; };
  $("#scrim").onclick = closeOverlays;
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlays(); });
}
document.addEventListener("DOMContentLoaded", boot);
