import { describe, expect, it } from "vitest";
import { ragTone, type RagItem } from "./progressRag";

const items: RagItem[] = [
  { code: "spi", enabled: true, green: 0.95, amber: 0.85 },
  { code: "progress_gap", enabled: false, green: -2, amber: -5 },
  { code: "velocity", enabled: true, green: 1.5, amber: 0.75 },
];

describe("progress figure colours", () => {
  it("colours by green and amber, higher is better, edges belong to the better colour", () => {
    expect(ragTone(items, "spi", 0.95)).toBe("green");
    expect(ragTone(items, "spi", 0.9)).toBe("amber");
    expect(ragTone(items, "spi", 0.85)).toBe("amber");
    expect(ragTone(items, "spi", 0.84)).toBe("red");
    expect(ragTone(items, "velocity", -1)).toBe("red");
  });
  it("gives no colour when the figure is off, unknown, missing or not yet read", () => {
    expect(ragTone(items, "progress_gap", -10)).toBeNull();
    expect(ragTone(items, "spi", null)).toBeNull();
    expect(ragTone(undefined, "spi", 1)).toBeNull();
    expect(ragTone([], "velocity", 2)).toBeNull();
  });
});
