/* GSDN PMIS prototype · synthetic data on the new Master structure (all names and values are fictional) */
const REPORT = "2026-10-20";
const REGIONS = ["Tripoli Area", "Middle Area", "WM Area", "Zawia Area", "Benghazi Area", "GM Area", "Sebha Area"];
const REG_CODE = { "Tripoli Area": "TR", "Middle Area": "MI", "WM Area": "WM", "Zawia Area": "ZW", "Benghazi Area": "BG", "GM Area": "GM", "Sebha Area": "SB" };
const STAGES = ["Site Release", "PRE-CW", "CW", "Site RFI", "TE Installation", "On-Air", "TE PAC", "KPI Acceptance", "HOTO", "Final Closure"];
const STAGES_AR = ["Site Release", "PRE-CW", "CW", "Site RFI", "تركيب TE", "On-Air", "TE PAC", "KPI Acceptance", "HOTO", "Final Closure"];
const GATES = ["—", "Pre-CW Readiness", "CW Readiness", "RFI Readiness", "TE Installation Readiness", "On-Air Readiness", "TE PAC Readiness", "Cluster Optimization Readiness", "HOTO Readiness", "Final Closure Readiness"];
// stage, code, task, sla [min,max] | null, document | null, master field, template | null
const STEPS = [
  [0, "A1", "Site search · first SAR", [10, 20], "SAR", "Acquisition · SAR", "Acquisition"],
  [0, "A2", "TSSR approval", [1, 2], "TSSR", "RF & Design · TSSR Approved", "RF & Design"],
  [0, "A3", "Site acquisition · contract signed", null, "Contract", "Master T", "Acquisition"],
  [0, "A4", "LLD approval", null, "LLD", "RF & Design · LLD Approved", "RF & Design"],
  [0, "MS1", "Site Release"],
  [1, "B1", "PR", null, "PR Email", "PR-PO · PR Date", "Procurement"],
  [1, "B2", "PO / WO and contractor", [1, 2], "PO / WO Email", "Master AI · AJ", "Procurement"],
  [1, "B3", "CW access permission", [1, 2], "Access Permission", "Permits · Access - CW", "Permits"],
  [1, "B4", "CW survey", [1, 2], null, "Master AO", "Site tasks"],
  [1, "B6", "Layout submission", [1, 2], "Layout", "Master AR", "Site tasks"],
  [1, "B7", "Layout and CW DN approval", [1, 2], "Approval Email", "Master AS · AU", "Site tasks"],
  [1, "MS2", "PRE-CW Completion"],
  [2, "B9", "CW MOS", [1, 2], "MOS Proof", "Master AZ", "Site tasks"],
  [2, "B11", "Tower / adaption items", [4, 8], null, "Master BA:BJ · BN", "Site tasks"],
  [2, "MS3", "CW Completion"],
  [3, "B13", "CW PAC · snags cleared", [1, 3], "CW PAC", "Master BR:BV", "Site tasks"],
  [3, "C2", "GECOL Power-On", [7, 10], "Power-On Certificate", "GECOL · Power-On", "GECOL"],
  [3, "C4", "HLC TX link tested", [7, 10], "TX Test Report", "HLC · TX Link Tested", "HLC"],
  [3, "MS4", "Site RFI"],
  [4, "D1", "TE access permission", [3, 5], "Access Permission", "Permits · Access - TE", "Permits"],
  [4, "D2", "TE survey", [1, 2], "Link Budget", "Master CC", "Site tasks"],
  [4, "D3", "TE DN submission", [1, 2], "TE DN", "Master CG", "Site tasks"],
  [4, "D4", "TE DN approval", [1, 2], "DN Approval Email", "Master CH", "Site tasks"],
  [4, "D5", "TE MOS", [1, 1], "MOS Proof", "Master CJ", "Site tasks"],
  [4, "D6", "TE installation", [3, 5], null, "Master CK:CO · CS", "Site tasks"],
  [4, "MS5", "TE Completion"],
  [5, "D7", "Commissioning", [1, 1], null, "Master CW", "Site tasks"],
  [5, "D8", "MW alignment", [1, 1], null, "Master CX:CZ", "Site tasks"],
  [5, "D9", "Integration", [1, 1], null, "Master DA", "Site tasks"],
  [5, "MS6", "On-Air"],
  [6, "D11", "SSV", [3, 5], "SSV Report", "Master DR:DS", "Site tasks"],
  [6, "D13", "EIR", [3, 5], "EIR", "Master DU:DY", "Site tasks"],
  [6, "D14", "PAT · NOC alarms", [3, 5], "PAT", "Master DZ:EE", "Site tasks"],
  [6, "D16", "TE PAC", [5, 10], "TE PAC", "Master EI:EJ", "Site tasks"],
  [6, "MS7", "TE PAC"],
  [7, "F1", "Cluster optimization", null, "Optimization Report", "Master EO", "Site tasks"],
  [7, "MS8", "KPI Acceptance"],
  [8, "D17", "Launch · reconciliation · HOTO package", [3, 5], "HOTO", "Master EU:EW", "Handover"],
  [8, "MS9", "HOTO"],
  [9, "B15", "CW FAC", [3, 10], "CW FAC", "Master FE", "Site tasks"],
  [9, "D18", "TE FAC", [3, 10], "TE FAC", "Master FJ", "Site tasks"],
  [9, "MS10", "Final Closure"],
].map((r, i) => ({ i, stage: r[0], code: r[1], name: r[2], ms: !r[3] && !r[4] && !r[5], sla: r[3] || null, doc: r[4] || null, src: r[5] || "Master · calculated", tpl: r[6] || null }));
STEPS.forEach(s => { if (s.code.startsWith("MS")) s.ms = true; });

const TEMPLATES = [
  { id: "TPL-MASTER", name: "GSDN Site Master", ver: "v1.1", scope: "All stages · all registers", fmt: "xlsx / xlsb", approved: "2026-10-21" },
  { id: "TPL-SITE", name: "Site tasks (dates and statuses)", ver: "v1.0", scope: "One site or selected sites · all tasks", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-RF", name: "RF & Design", ver: "v1.0", scope: "New sites and design data", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-ACQ", name: "Acquisition", ver: "v1.0", scope: "Candidates and contracts", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-PO", name: "Procurement", ver: "v1.0", scope: "PR · PO / WO · contractor", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-PRM", name: "Permits", ver: "v1.0", scope: "Access and PTW", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-GECOL", name: "GECOL", ver: "v1.0", scope: "Power steps per site", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-HLC", name: "HLC", ver: "v1.0", scope: "Fiber request and installation", fmt: "xlsx", approved: "2026-10-21" },
  { id: "TPL-WH", name: "Warehouse movements", ver: "v1.0", scope: "PL · DN · RN · ADJ", fmt: "xlsx", approved: "2026-10-21" },
];
const TPL_BY = { "Acquisition": "TPL-ACQ", "RF & Design": "TPL-RF", "Procurement": "TPL-PO", "Permits": "TPL-PRM", "Site tasks": "TPL-SITE", "GECOL": "TPL-GECOL", "HLC": "TPL-HLC", "Handover": "TPL-SITE" };

const ROLES6 = ["Project Manager", "RF & Design / Acquisition Team Lead", "CW Team Lead", "TE Team Lead", "Inventory Supervisor", "Project Support"];
const USERS = [
  { id: "1001", name: "Ahmed Salem", role: "Project Manager", regions: "all", c: "#1f3a3d" },
  { id: "1102", name: "Mona Fathi", role: "RF & Design / Acquisition Team Lead", regions: "all", c: "#6b5b95" },
  { id: "1103", name: "Ali Barka", role: "RF Engineer", sub: "RF & Design / Acquisition Team Lead", regions: "all", c: "#88619a" },
  { id: "1203", name: "Omar Khaled", role: "CW Team Lead", regions: "all", c: "#c8693f" },
  { id: "1204", name: "Sami Nuri", role: "Site Engineers", sub: "CW Team Lead", regions: ["Tripoli Area", "Zawia Area"], c: "#d08b5b" },
  { id: "1205", name: "Fadi Omran", role: "Site Engineers", sub: "CW Team Lead", regions: ["Middle Area", "WM Area"], c: "#b97a4f" },
  { id: "1206", name: "Khalid Jaber", role: "GECOL Power Team", sub: "CW Team Lead", regions: "all", c: "#a0522d" },
  { id: "1207", name: "Nadia Hamed", role: "HLC Fiber Team", sub: "CW Team Lead", regions: "all", c: "#8b6b3e" },
  { id: "1305", name: "Hassan Ali", role: "TE Team Lead", regions: "all", c: "#2f6f8f" },
  { id: "1306", name: "Tarek Mansour", role: "Site Engineers", sub: "TE Team Lead", regions: ["Tripoli Area", "Zawia Area", "WM Area"], c: "#3f86a8" },
  { id: "1307", name: "Rami Saeed", role: "HOTO Engineer", sub: "TE Team Lead", regions: "all", c: "#4a90a4" },
  { id: "1407", name: "Rania Saad", role: "Inventory Supervisor", regions: "all", c: "#4f8a6e" },
  { id: "1508", name: "Laila Omar", role: "Project Support", regions: "all", c: "#7a7a72" },
  { id: "1509", name: "Yousef Adel", role: "Project Procurement Team", sub: "Project Support", regions: "all", c: "#8f8f86" },
];
const U = Object.fromEntries(USERS.map(u => [u.id, u]));
// responsibility matrix per stage: entry / review / approve (lists of employee IDs)
const MATRIX = [
  { entry: ["1103", "1102"], review: ["1102"], approve: ["1001"] },
  { entry: ["1204", "1205", "1509"], review: ["1203"], approve: ["1203"] },
  { entry: ["1204", "1205"], review: ["1203"], approve: ["1203"] },
  { entry: ["1204", "1205", "1206", "1207"], review: ["1203"], approve: ["1001"] },
  { entry: ["1306"], review: ["1305"], approve: ["1305"] },
  { entry: ["1306"], review: ["1305"], approve: ["1305"] },
  { entry: ["1306"], review: ["1305"], approve: ["1001"] },
  { entry: ["1103"], review: ["1102"], approve: ["1001"] },
  { entry: ["1307"], review: ["1305"], approve: ["1001"] },
  { entry: ["1204", "1306"], review: ["1203", "1305"], approve: ["1001"] },
];

/* ---------- deterministic random */
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = rng(20261020);
const pick = a => a[Math.floor(R() * a.length)];
function isOff(d) { const w = d.getUTCDay(); return w === 5 || w === 6; }
function addWd(iso, n) { const d = new Date(iso + "T00:00:00Z"); let k = 0; while (k < n) { d.setUTCDate(d.getUTCDate() + 1); if (!isOff(d)) k++; } return d.toISOString().slice(0, 10); }
function wd(a, b) { if (!a || !b) return null; let d = new Date(a + "T00:00:00Z"), e = new Date(b + "T00:00:00Z"), s = 1; if (d > e) { [d, e] = [e, d]; s = -1; } let n = 0; while (d < e) { d.setUTCDate(d.getUTCDate() + 1); if (!isOff(d)) n++; } return s * n; }

const NAMES = ["Souq Al Juma", "Ain Zara", "Tajoura", "Janzour", "Gargaresh", "Hay Al Andalus", "Abu Salim", "Fashloum", "Misurata Port", "Zliten", "Khoms", "Gharyan", "Yefren", "Nalut", "Zawia Center", "Sabratha", "Surman", "Benina", "Al Kish", "Garyounis", "Ajdabiya", "Brak", "Ubari", "Sebha Center", "Bani Walid", "Tarhuna", "Msallata", "Al Maya", "Jadu", "Zuwara"];
const CONTRACTORS = ["Alasema", "Omniacom", "Atlas", "ALC", "Alarabiya", "Almanar", "Alwadi", "Tamteen"];
const GECOLC = ["Al Markaziya", "Najmat Al Ufuq", "Al Mashhar", "Al Bab Al Ali", "Nahr Tasnim"];
const SITES = [];
const regionW = [40, 30, 18, 14, 22, 14, 12];
let seq = {};
for (let n = 0; n < 150; n++) {
  let r = R() * regionW.reduce((a, b) => a + b), ri = 0; while (r > regionW[ri]) { r -= regionW[ri]; ri++; }
  const region = REGIONS[ri], code = REG_CODE[region]; seq[code] = (seq[code] || 100) + 1 + Math.floor(R() * 3);
  const type = pick(["HUB", "HUB", "Terminal", "Terminal", "Terminal", "FN", "MFN", "Core"]);
  const site = {
    id: code + seq[code], name: pick(NAMES) + " " + (1 + Math.floor(R() * 6)), region, type,
    scen: pick(["Outdoor", "Outdoor", "Indoor"]), tower: pick(["RT · Existing", "GF · Existing", "RT · New", "N/A"]),
    phase: R() < .85 ? "PH1" : "PH2", batch: pick(["Batch 1", "Batch 2", "Batch 3", "Batch 3"]),
    scenario: R() < .9 ? "New Build" : pick(["Cold Swap", "Hot Swap", "Expansion"]),
    contractor: pick(CONTRACTORS), vendor: "A&T Global", gecol: R() < .78, hlc: R() < .16, gcon: pick(GECOLC),
    cluster: "CL-" + code + "-" + (1 + Math.floor(R() * 4)), tasks: [], issues: [], status: "In Progress",
  };
  // progress: how many non-milestone steps are done
  const work = STEPS.filter(s => !s.ms && !(s.code === "C2" && !site.gecol) && !(s.code === "C4" && !site.hlc) && !(s.code === "D8" && ["FN", "MFN", "Core"].includes(type)));
  const k = Math.min(work.length, Math.floor(Math.pow(R(), 0.8) * (work.length + 2)));
  let plan = "2025-" + pick(["09", "10", "11", "12"]) + "-" + String(1 + Math.floor(R() * 26)).padStart(2, "0");
  let act = plan, wi = 0, stalled = false;
  STEPS.forEach(s => {
    const t = { step: s.i, state: "lock", plan: "", act: "", docState: s.doc ? "missing" : "none", notes: [], hist: [], by: null };
    const na = (s.code === "C2" && !site.gecol) || (s.code === "C4" && !site.hlc) || (s.code === "D8" && ["FN", "MFN", "Core"].includes(type)) || (["Cold Swap", "Hot Swap"].includes(site.scenario) && s.stage === 3);
    const dur = s.sla ? s.sla[1] : (s.ms ? 0 : 5);
    plan = addWd(plan, dur); t.plan = plan;
    if (na) { t.state = "na"; t.docState = "none"; site.tasks.push(t); return; }
    if (s.ms) { site.tasks.push(t); return; }
    if (wi < k) {
      const real = s.sla ? Math.max(0, Math.round(s.sla[0] + R() * (s.sla[1] * 1.7 - s.sla[0]))) + (R() < .12 ? Math.floor(R() * 25) : 0) : Math.floor(2 + R() * 8);
      act = addWd(act, real); if (act > REPORT) act = REPORT;
      t.act = act; t.state = "done"; if (s.doc) t.docState = R() < .9 ? "verified" : "missing";
      t.hist = [["Entered", act, pick(MATRIX[s.stage].entry)], ["Reviewed", act, MATRIX[s.stage].review[0]], ["Approved", act, MATRIX[s.stage].approve[0]]];
    } else if (wi === k && !stalled) {
      const roll = R();
      t.state = roll < .55 ? "open" : roll < .8 ? "review" : "approve";
      if (t.state !== "open") { t.act = addWd(act, s.sla ? s.sla[0] : 2) > REPORT ? REPORT : addWd(act, s.sla ? s.sla[0] : 2); if (s.doc) t.docState = "pending"; t.hist = [["Entered", t.act, pick(MATRIX[s.stage].entry)]]; if (t.state === "approve") t.hist.push(["Reviewed", t.act, MATRIX[s.stage].review[0]]); }
      stalled = true;
    }
    wi++; site.tasks.push(t);
  });
  SITES.push(site);
}
/* milestone dates and current stage */
function recompute(site) {
  STEPS.forEach((s, i) => {
    if (!s.ms) return; const t = site.tasks[i];
    const rows = STEPS.filter(x => x.stage === s.stage && !x.ms).map(x => site.tasks[x.i]);
    if (rows.every(r => r.state === "done" || r.state === "na")) { t.state = "done"; t.act = rows.reduce((a, r) => r.act > a ? r.act : a, ""); }
    else t.state = "lock";
  });
  // open the next task when the previous is approved
  const cur = site.tasks.findIndex((t, i) => !STEPS[i].ms && t.state !== "done" && t.state !== "na");
  site.cur = cur;
  if (cur >= 0 && site.tasks[cur].state === "lock") site.tasks[cur].state = "open";
  if (cur >= 0) {
    const t = site.tasks[cur], s = STEPS[cur];
    const from = prevAct(site, cur);
    t.late = !!(s.sla && from && wd(from, t.act || REPORT) > s.sla[1]);
  }
  site.stage = cur < 0 ? 10 : STEPS[cur].stage;
  if (site.stage >= 10) site.status = "Completed";
}
function prevAct(site, i) { for (let j = i - 1; j >= 0; j--) { const t = site.tasks[j]; if (!STEPS[j].ms && t.act && t.state === "done") return t.act; } return null; }
SITES.forEach(recompute);
/* a few site issues */
const ISSUE_TXT = ["No team available", "Access refused by owner", "GECOL meter delayed", "Uplink site not On-Air", "Material shortage (cabinet)", "Layout returned with comments", "Permit renewal pending"];
SITES.forEach(s => { if (R() < .28 && s.stage < 10) s.issues.push({ text: pick(ISSUE_TXT), owner: pick(["A&T Global", s.contractor, "GECOL", "Aljeel"]), raised: addWd("2026-06-01", Math.floor(R() * 90)), status: R() < .8 ? "Open" : "In Progress" }); });
/* GECOL register rows */
const GECOL = SITES.filter(s => s.gecol).map(s => {
  const t = s.tasks[STEPS.find(x => x.code === "C2").i];
  const pr = s.tasks[STEPS.find(x => x.code === "B2").i].act;
  return { site: s.id, contractor: s.gcon, pr, survey: pr ? addWd(pr, 3) : "", install: t.state === "done" ? addWd(t.act, -2) : "", powerOn: t.state === "done" ? t.act : "", follow: R() < .5 ? [{ at: "2026-10-12", by: "1206", text: "Called GECOL office · meter scheduled next week" }] : [] };
});
/* audit and system log seeds */
const AUDIT = [];
const SYSLOG = [
  { at: "2026-10-20 08:14", lvl: "ERROR", src: "Import", msg: "Batch B-0007 rejected: sheet 'Master' column 'Site ID' not found (file not built from an approved template)" },
  { at: "2026-10-19 17:42", lvl: "WARN", src: "Notifications", msg: "Email to 1306 deferred: Microsoft 365 throttling, retried 3 times, delivered 17:49" },
  { at: "2026-10-19 11:05", lvl: "INFO", src: "Scheduler", msg: "Weekly KPI snapshot saved (150 sites)" },
  { at: "2026-10-18 09:30", lvl: "ERROR", src: "Documents", msg: "Upload of 'TR244_PAT.pdf' failed: file over 5 MB limit" },
];
(function seedAudit() {
  const acts = [["Approved", "task"], ["Reviewed", "task"], ["Submitted", "task"], ["Rejected", "task"], ["Uploaded document", "document"], ["Changed responsibility", "matrix"]];
  for (let n = 0; n < 26; n++) { const s = pick(SITES), a = pick(acts); AUDIT.push({ at: "2026-10-" + String(20 - Math.floor(n / 3)).padStart(2, "0") + " " + String(8 + Math.floor(R() * 9)).padStart(2, "0") + ":" + String(Math.floor(R() * 60)).padStart(2, "0"), user: pick(USERS).id, action: a[0], target: a[1] === "matrix" ? "Stage " + (1 + Math.floor(R() * 10)) : s.id + " · " + pick(STEPS.filter(x => !x.ms)).code, detail: a[0] === "Rejected" ? "Date before access permit · please correct" : "", before: "", after: "" }); }
  AUDIT.sort((a, b) => b.at.localeCompare(a.at));
})();
const BATCHES = [];
