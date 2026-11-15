import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { gxRow, StatusChip, textMeasure } from "./TableKit";

describe("gxRow (shared row look)", () => {
  it("alternates zebra by position and marks hover-free picked rows", () => {
    expect(gxRow(0)["data-zebra"]).toBe("0");
    expect(gxRow(1)["data-zebra"]).toBe("1");
    expect(gxRow(2)["data-picked"]).toBeUndefined();
    expect(gxRow(2, { picked: true })["data-picked"]).toBe("");
  });

  it("adds the current-row ring and the muted look only when asked", () => {
    expect(gxRow(0).className).toBe("gx-row");
    expect(gxRow(0, { current: true }).className).toContain("ring-accent");
    expect(gxRow(0, { muted: true }).className).toContain("opacity-60");
  });
});

describe("StatusChip", () => {
  it("renders its label with the test id and state attribute", () => {
    render(
      <StatusChip
        tone="bg-doneBg text-doneInk"
        testid="chip-1"
        stateAttr="done"
      >
        Done
      </StatusChip>,
    );
    const chip = screen.getByTestId("chip-1");
    expect(chip).toHaveTextContent("Done");
    expect(chip).toHaveAttribute("data-value", "done");
    expect(chip.className).toContain("chip");
    expect(chip.className).toContain("bg-doneBg");
  });

  it("keeps the chip a plain element when there is no full text to show", () => {
    render(<StatusChip tone="x">Plain</StatusChip>);
    expect(screen.getByText("Plain").tagName).toBe("SPAN");
    expect(screen.queryByTestId("tip")).toBeNull();
  });
});

describe("textMeasure", () => {
  it("falls back to a fixed estimate in jsdom (no canvas)", () => {
    const measure = textMeasure();
    expect(measure("abc")).toBeCloseTo(22.8, 5);
    expect(measure("")).toBe(0);
  });
});
