import { describe, expect, it } from 'vitest';
import {
  isDashTab,
  rememberKey,
  readRemembered,
  resolveTab,
  tabView,
  teamTabs,
  writeRemembered,
} from "./dashboardTabs";

describe("dashboard tabs (F6)", () => {
  it("a tab is the view filter: PMO has none, CW and TE are their view codes", () => {
    expect(tabView("pmo")).toBe("");
    expect(tabView("cw")).toBe("CW");
    expect(tabView("te")).toBe("TE");
  });

  it("teams map to the tabs: cw to CW, te to TE, both to both, none to nothing", () => {
    expect(teamTabs(["cw"])).toEqual(["cw"]);
    expect(teamTabs(["te"])).toEqual(["te"]);
    expect(teamTabs(["both"])).toEqual(["cw", "te"]);
    expect(teamTabs(["none", undefined])).toEqual([]);
    expect(teamTabs(["cw", "te", "cw"])).toEqual(["cw", "te"]);
  });

  it("an explicit tab in the URL wins over everything", () => {
    expect(resolveTab("te", "cw", ["cw"])).toBe("te");
    expect(resolveTab("pmo", "te", ["cw"])).toBe("pmo");
  });

  it("a user with only a CW team gets CW, only TE gets TE, without a remembered choice", () => {
    expect(resolveTab(null, null, ["cw"])).toBe("cw");
    expect(resolveTab(null, "pmo", ["te"])).toBe("te");
  });

  it("management, PM and users with several teams get the tab they used last, else PMO", () => {
    expect(resolveTab(null, null, [])).toBe("pmo");
    expect(resolveTab(null, "te", ["cw", "te"])).toBe("te");
    expect(resolveTab(null, "bogus", ["cw", "te"])).toBe("pmo");
    expect(resolveTab(null, null, ["cw", "te"])).toBe("pmo");
  });

  it("recognises only the three tabs", () => {
    expect(isDashTab("cw")).toBe(true);
    expect(isDashTab("OM")).toBe(false);
    expect(isDashTab(null)).toBe(false);
  });

  it("the remembered tab is kept per user", () => {
    expect(rememberKey("u1")).toBe("dash.tab.u1");
    expect(rememberKey(undefined)).toBe("dash.tab.anon");
    writeRemembered('u1', 'te');
    expect(readRemembered('u1')).toBe('te');
    expect(readRemembered('u2')).toBeNull();
    window.localStorage.removeItem(rememberKey('u1'));
  });
});
