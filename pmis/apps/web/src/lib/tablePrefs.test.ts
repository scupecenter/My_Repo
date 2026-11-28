import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_HEAD_PAD,
  AUTO_PAD,
  defaultHidden,
  fitWidth,
  loadPrefs,
  pinOffsets,
  prefsKey,
  reconcile,
  resizeCol,
  storePrefs,
  EMPTY_PREFS,
  type ColDef,
} from "./tablePrefs";

const DEFS: ColDef[] = [
  { id: "code", w: 100, min: 70, pinned: true },
  { id: "name", w: 220, min: 100, max: 340, pinned: true },
  { id: "region", w: 120, min: 80, max: 240 },
  { id: "extra", w: 90, min: 60, off: true },
];
// 10 px per character keeps the arithmetic readable in the assertions below
const measure = (t: string) => t.length * 10;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("fitWidth (auto size to content)", () => {
  it("takes the wider of the header and the widest sampled cell, plus padding", () => {
    const head = "ab".length * 10 + AUTO_PAD + AUTO_HEAD_PAD; // 54
    const w = fitWidth(DEFS[2], "ab", ["abcdef", "abc"], measure); // body 60 + 20 = 80
    expect(w).toBe(Math.max(head, 80));
    expect(w).toBe(80);
  });

  it("counts the extra pixels of a chip sample on top of its text", () => {
    // 3 chars = 30, + 24 chip px + 20 padding = 74; the 70 minimum does not apply
    expect(
      fitWidth({ id: "x", w: 100, min: 60 }, "", [["abc", 24]], measure),
    ).toBe(74);
  });

  it("never goes below the column minimum, nor above its maximum", () => {
    expect(fitWidth(DEFS[0], "", [], measure)).toBe(70); // min 70, nothing to measure
    const long = "x".repeat(100); // 1000 px of text
    expect(fitWidth(DEFS[2], "", [long], measure)).toBe(240); // capped at max 240
  });

  it("falls back to the default maximum (360) when no max is set", () => {
    const long = "x".repeat(100);
    expect(fitWidth({ id: "x", w: 100 }, "", [long], measure)).toBe(360);
  });

  it("measures only the first 120 sampled cells", () => {
    const samples = [...Array(120).fill("a"), "x".repeat(100)]; // the long one is the 121st
    expect(
      fitWidth({ id: "x", w: 100, min: 60, max: 2000 }, "", samples, measure),
    ).toBe(60); // sampled body is 50, below the 60 minimum
  });
});

describe("pinOffsets (frozen columns)", () => {
  it("starts after the select box and stacks the pinned columns in order", () => {
    const cols = [
      { id: "code", px: 100, pinned: true },
      { id: "a", px: 50 },
      { id: "name", px: 200, pinned: true },
    ];
    expect(pinOffsets(cols, 36)).toEqual({ code: 36, name: 136 });
  });

  it("starts at zero when there is no select box", () => {
    expect(pinOffsets([{ id: "code", px: 100, pinned: true }], 0)).toEqual({
      code: 0,
    });
  });
});

describe("column prefs: width and hidden defaults", () => {
  it("clamps a dragged width to the column minimum and to 640 px", () => {
    const p = reconcile(EMPTY_PREFS, DEFS);
    expect(resizeCol(p, DEFS, "region", 5).width.region).toBe(80);
    expect(resizeCol(p, DEFS, "region", 9999).width.region).toBe(640);
    expect(resizeCol(p, DEFS, "missing", 200)).toBe(p);
  });

  it("starts columns marked off as hidden", () => {
    expect(defaultHidden(DEFS)).toEqual(["extra"]);
  });

  it("drops an unknown density, so the table follows the defaults of Settings > Display (W8)", () => {
    const p = reconcile(
      { ...EMPTY_PREFS, density: "tiny" as unknown as "compact" },
      DEFS,
    );
    expect(p.density).toBeUndefined();
    expect(reconcile({ ...EMPTY_PREFS, density: "normal" }, DEFS).density).toBe("normal");
    expect(reconcile({ ...EMPTY_PREFS, display: { size: "lg", font: 1 } as never }, DEFS).display).toEqual({ size: "lg" });
    expect(reconcile({ ...EMPTY_PREFS, display: { colors: false } }, DEFS).display).toEqual({ colors: false });
  });
});

describe("column prefs: per-user storage", () => {
  it("stores widths and density per user and screen, and reads them back", () => {
    const p = reconcile(
      { ...EMPTY_PREFS, width: { region: 150 }, density: "compact" },
      DEFS,
    );
    storePrefs("sites", "u1", p);
    const back = loadPrefs("sites", "u1", DEFS);
    expect(back.width).toEqual({ region: 150 });
    expect(back.density).toBe("compact");
    // another user on the same screen does not see it
    expect(loadPrefs("sites", "u2", DEFS).width).toEqual({});
    expect(localStorage.getItem(prefsKey("sites", "u1"))).not.toBeNull();
  });

  it("falls back to defaults when stored JSON is corrupt", () => {
    localStorage.setItem(prefsKey("sites", "u1"), "{not json");
    const p = loadPrefs("sites", "u1", DEFS);
    expect(p.width).toEqual({});
    expect(p.hidden).toEqual(["extra"]);
    expect(p.density).toBeUndefined(); // W8: no choice of the user, the defaults of Settings > Display apply
  });

  it("never throws when storage is blocked or full", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => loadPrefs("sites", "u1", DEFS)).not.toThrow();
    expect(loadPrefs("sites", "u1", DEFS).hidden).toEqual(["extra"]);
    expect(() => storePrefs("sites", "u1", EMPTY_PREFS)).not.toThrow();
  });
});

describe("unpinned preference", () => {
  it("is kept by reconcile only when true", () => {
    const defs = [{ id: "a", label: "A", w: 80 }] as never;
    const base = { order: ["a"], hidden: [], width: {} };
    expect(reconcile({ ...base, unpinned: true }, defs).unpinned).toBe(true);
    expect("unpinned" in reconcile({ ...base, unpinned: false }, defs)).toBe(false);
  });
});
