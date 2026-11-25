/**
 * The eight Site Master menus in menu order (names as the API sends them in `GET /site-master/sections`).
 * The `master` entry is a section key only (`/sites?section=master`): the sidebar shows it as the parent entry "Site Master", not as a sub-menu.
 */
export const SITE_MASTER_NAV: { key: string; en: string; ar: string }[] = [
  { key: "master", en: "Master", ar: "الماستر" },
  { key: "design_acq", en: "Design & Acquisition", ar: "التصميم والاستحواذ" },
  { key: "sow", en: "SOW", ar: "نطاق العمل" },
  { key: "cw", en: "CW", ar: "الأعمال المدنية" },
  { key: "te", en: "TE", ar: "التركيبات" },
  { key: "hoto", en: "HOTO", ar: "التسليم والإغلاق" },
  { key: "dismantle", en: "Dismantle", ar: "الفك" },
  { key: "om", en: "O&M", ar: "التشغيل والصيانة" },
];

/** The section key of the Master menu. It is the parent entry "Site Master" (the default view of /sites), not one of the sub-menus. */
export const SITE_MASTER_MASTER = 'master';

/**
 * The six sub-menus shown under the Site Master entry, in menu order (owner request 2026-11-22): Design & Acquisition, SOW, CW, TE, HOTO and O&M.
 * Dismantle is not one of them: it lives only under "Registers & Logs" (`/registers/dismantle`).
 */
export const SITE_MASTER_SUBMENUS = SITE_MASTER_NAV.filter((m) => m.key !== SITE_MASTER_MASTER && m.key !== 'dismantle');
