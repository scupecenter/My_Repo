/**
 * The three tabs of the dashboard (F6, owner decisions 2026-11-15): PMO and management, CW follow-up, TE follow-up.
 * A tab is the existing `view` filter of GET /dashboard: PMO has none, CW is `CW`, TE is `TE` (contract 0.15.16).
 * Pure functions, so the default tab and the storage key are unit tested without rendering.
 */

export const DASH_TABS = ["pmo", "cw", "te"] as const;
export type DashTab = (typeof DASH_TABS)[number];

/** The `view` sent to GET /dashboard for a tab. PMO sends none (the whole project). */
export function tabView(tab: DashTab): string {
  return tab === "cw" ? "CW" : tab === "te" ? "TE" : "";
}

export function isDashTab(v: string | null | undefined): v is DashTab {
  return !!v && (DASH_TABS as readonly string[]).includes(v);
}

/** The team values of the caller's assignments (`cw`, `te`, `both`, `none`) reduced to the tabs they can follow. */
export function teamTabs(teams: (string | null | undefined)[]): DashTab[] {
  const out = new Set<DashTab>();
  for (const t of teams) {
    if (t === "cw" || t === "both") out.add("cw");
    if (t === "te" || t === "both") out.add("te");
  }
  return [...out];
}

/**
 * The tab to show. An explicit `tab` in the URL wins. Without one: a user whose teams give exactly one tab (CW only or TE only)
 * gets that tab; anyone else (management, PM, several teams, or no team) gets the tab they used last, or PMO when none is remembered.
 */
export function resolveTab(
  urlTab: string | null | undefined,
  remembered: string | null | undefined,
  teams: DashTab[],
): DashTab {
  if (isDashTab(urlTab)) return urlTab;
  if (teams.length === 1) return teams[0]!;
  if (isDashTab(remembered)) return remembered;
  return "pmo";
}

/** The localStorage key of the last tab a user used. Per user, so a shared browser keeps each person's choice. */
export function rememberKey(userId: string | null | undefined): string {
  return `dash.tab.${userId ?? "anon"}`;
}

/** The tab a user used last in this browser, or null (storage may be blocked: then nothing is remembered). */
export function readRemembered(userId: string | null | undefined): string | null {
  try {
    return globalThis.localStorage?.getItem(rememberKey(userId)) ?? null;
  } catch {
    return null;
  }
}

export function writeRemembered(userId: string | null | undefined, tab: DashTab): void {
  try {
    globalThis.localStorage?.setItem(rememberKey(userId), tab);
  } catch {
    /* storage blocked: the tab still works for this visit */
  }
}
