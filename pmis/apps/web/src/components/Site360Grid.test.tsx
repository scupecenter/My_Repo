import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/utils";
import type { Site360MenuItem } from "@/api/site360";
import { Site360Grid } from "./Site360Grid";

// A synthetic CW menu: identity, a phase gate, two groups in the PRE-CW band, and the status columns.
const cw: Site360MenuItem = {
  key: "cw",
  name_en: "CW",
  name_ar: "الأعمال المدنية",
  frozen_ords: [1, 2, 3, 4],
  columns: [
    {
      ord: 1,
      letter: "A",
      group_top: "#",
      group_mid: null,
      header: "#",
      sections: ["design_acq"],
      is_phase_gate: false,
    },
    {
      ord: 2,
      letter: "B",
      group_top: "RF & DESIGN",
      group_mid: "Identification",
      header: "Site ID",
      sections: ["design_acq"],
      is_phase_gate: false,
    },
    {
      ord: 3,
      letter: "C",
      group_top: "RF & DESIGN",
      group_mid: "Identification",
      header: "Site Owner ID",
      sections: ["design_acq"],
      is_phase_gate: false,
    },
    {
      ord: 4,
      letter: "D",
      group_top: "RF & DESIGN",
      group_mid: "Identification",
      header: "Site Name",
      sections: ["design_acq"],
      is_phase_gate: false,
    },
    {
      ord: 23,
      letter: "W",
      group_top: "Phase Gate",
      group_mid: "Pre-CW Readiness",
      header: "Pre-CW Readiness",
      sections: ["cw"],
      is_phase_gate: true,
    },
    {
      ord: 33,
      letter: "AG",
      group_top: "PRE-CW",
      group_mid: "CW Procurement",
      header: "CW Delivery Model",
      sections: ["cw"],
      is_phase_gate: false,
    },
    {
      ord: 34,
      letter: "AH",
      group_top: "PRE-CW",
      group_mid: "CW Procurement",
      header: "PR Status",
      sections: ["cw"],
      is_phase_gate: false,
    },
    {
      ord: 180,
      letter: "FX",
      group_top: "Progress",
      group_mid: null,
      header: "Current Milestone",
      sections: ["status"],
      is_phase_gate: false,
    },
  ],
  bands: [
    { name: "#", is_phase_gate: false, groups: [{ name: null, ords: [1] }] },
    {
      name: "RF & DESIGN",
      is_phase_gate: false,
      groups: [{ name: "Identification", ords: [2, 3, 4] }],
    },
    {
      name: "Phase Gate",
      is_phase_gate: true,
      groups: [{ name: "Pre-CW Readiness", ords: [23] }],
    },
    {
      name: "PRE-CW",
      is_phase_gate: false,
      groups: [{ name: "CW Procurement", ords: [33, 34] }],
    },
    {
      name: "Progress",
      is_phase_gate: false,
      groups: [{ name: null, ords: [180] }],
    },
  ],
};

const rows = [
  { id: "a", site_code: "S-001", name: "Synthetic site one" },
  { id: "b", site_code: "S-002", name: "Synthetic site two" },
];

describe("SITE 360 grid", () => {
  it("draws the three header rows with the phase gate band highlighted", () => {
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    expect(screen.getByTestId("site360-grid-band-row")).toBeTruthy();
    expect(screen.getByTestId("site360-grid-group-row")).toBeTruthy();
    expect(screen.getByTestId("site360-grid-field-row")).toBeTruthy();
    expect(
      screen.getByTestId("site360-grid-band-2").getAttribute("data-gate"),
    ).toBe("true");
    expect(
      screen.getByTestId("site360-grid-band-3").getAttribute("data-gate"),
    ).toBe("false");
    expect(screen.getByTestId("site360-grid-field-AG").textContent).toContain(
      "CW Delivery Model",
    );
  });

  it("shows one row per site and a totals row with the count of visible rows", () => {
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    expect(screen.getByTestId("site360-grid-row-S-001")).toBeTruthy();
    expect(screen.getByTestId("site360-grid-row-S-002")).toBeTruthy();
    expect(screen.getByTestId("site360-grid-totals").textContent).toContain(
      "2 of 2 sites",
    );
  });

  it("collapses a phase band to one column and expands it again", () => {
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    const band = screen.getByTestId("site360-grid-band-3");
    const button = band.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("site360-grid-field-AG")).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("site360-grid-field-AG")).toBeNull();
    expect(screen.queryByTestId("site360-grid-field-AH")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId("site360-grid-field-AG")).toBeTruthy();
  });

  it("freezes and unfreezes a column", () => {
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    const field = screen.getByTestId("site360-grid-field-AG");
    expect(field.style.position).toBe("");
    fireEvent.click(screen.getByTestId("site360-grid-freeze-AG"));
    expect(screen.getByTestId("site360-grid-field-AG").style.position).toBe(
      "sticky",
    );
    expect(
      screen.getByTestId("site360-grid-freeze-AG").getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("site360-grid-freeze-AG"));
    expect(screen.getByTestId("site360-grid-field-AG").style.position).toBe("");
  });

  it("keeps the identity columns frozen by default", () => {
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    expect(screen.getByTestId("site360-grid-field-B").style.position).toBe(
      "sticky",
    );
    expect(screen.getByTestId("site360-grid-field-D").style.position).toBe(
      "sticky",
    );
    expect(screen.getByTestId("site360-grid-row-S-001").textContent).toContain(
      "Synthetic site one",
    );
  });

  it("draws the Master values, the status pill and the filtered count of the footer", () => {
    const valued = [
      { id: "c", site_code: "S-003", row_no: 7, values: { "1": "7", "2": "S-003", "4": "Synthetic site three", "5": "Zawia", "182": "on_hold" } },
    ];
    const withStatus: Site360MenuItem = {
      ...cw,
      columns: [
        ...cw.columns,
        { ord: 182, letter: "FZ", group_top: "Progress", group_mid: null, header: "Overall Status", sections: ["status"], is_phase_gate: false },
      ],
      bands: [...cw.bands, { name: "Progress", is_phase_gate: false, groups: [{ name: null, ords: [182] }] }],
    };
    renderApp(<Site360Grid menu={withStatus} rows={valued} total={9} filtered={1} />);
    expect(screen.getByTestId("site360-grid-status").textContent).toBe("on hold");
    expect(screen.getByTestId("site360-grid-totals").textContent).toContain("1 of 9 sites");
  });

  it("edits a task-backed cell on double-click and saves on Enter; a read-only cell does not open", () => {
    const onEditCell = vi.fn();
    const rows = [
      {
        id: "c",
        site_code: "S-003",
        values: { "3": "2026-03-10", "4": "Synthetic site three" },
        cells: {
          "3": { task_id: "t-1", version: 2, editable: true, field: "actual_date" as const },
          "4": { task_id: "t-1", version: 2, editable: false },
        },
      },
    ];
    renderApp(<Site360Grid menu={cw} rows={rows} onEditCell={onEditCell} />);
    fireEvent.doubleClick(screen.getByTestId("site360-grid-cell-S-003-3"));
    const input = screen.getByTestId("site360-grid-input-S-003-3") as HTMLInputElement;
    expect(input.type).toBe("date");
    fireEvent.change(input, { target: { value: "2026-04-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEditCell).toHaveBeenCalledWith(
      expect.objectContaining({ ord: 3, value: "2026-04-01", target: expect.objectContaining({ task_id: "t-1", version: 2 }) }),
    );
    fireEvent.doubleClick(screen.getByTestId("site360-grid-cell-S-003-4"));
    expect(screen.queryByTestId("site360-grid-input-S-003-4")).toBeNull();
  });

  it("sorts and filters from the header menu, and hides a column until it is shown again", () => {
    const rows = [
      { id: "a", site_code: "S-A", values: { "3": "2026-03-10", "4": "Synthetic A" } },
      { id: "b", site_code: "S-B", values: { "3": "2026-01-02", "4": "Synthetic B" } },
      { id: "c", site_code: "S-C", values: { "3": null, "4": "Synthetic C" } },
    ];
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    const order = () =>
      Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.getAttribute("data-testid"));
    fireEvent.click(screen.getByTestId("site360-grid-menu-C"));
    fireEvent.click(screen.getByTestId("site360-grid-sort-asc-C"));
    expect(order()).toEqual(["site360-grid-row-S-B", "site360-grid-row-S-A", "site360-grid-row-S-C"]);
    fireEvent.click(screen.getByTestId("site360-grid-menu-C"));
    // the checklist is sorted: blank, 2026-01-02, 2026-03-10; untick 2026-01-02 (index 1)
    fireEvent.click(screen.getAllByTestId("site360-grid-filter-value-C")[1]!);
    expect(order()).toEqual(["site360-grid-row-S-A", "site360-grid-row-S-C"]);
    fireEvent.click(screen.getByTestId("site360-grid-hide-C"));
    expect(screen.queryByTestId("site360-grid-field-C")).toBeNull();
    fireEvent.click(screen.getByTestId("site360-grid-show-hidden"));
    expect(screen.getByTestId("site360-grid-field-C")).toBeInTheDocument();
  });

  it("selects a rectangle of cells and sums its numbers in the footer", () => {
    const rows = [
      { id: "a", site_code: "S-A", values: { "3": "1,200", "4": "Synthetic A" } },
      { id: "b", site_code: "S-B", values: { "3": "300", "4": "Synthetic B" } },
    ];
    renderApp(<Site360Grid menu={cw} rows={rows} />);
    const cell = (site: string, ord: number) =>
      document.querySelector(`tbody tr[data-testid="site360-grid-row-${site}"] td[data-ord="${ord}"]`)!;
    fireEvent.mouseDown(cell("S-A", 3), { button: 0 });
    fireEvent.mouseDown(cell("S-B", 3), { button: 0, shiftKey: true });
    expect(cell("S-B", 3).getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("site360-grid-selection").textContent).toContain("2 cells selected, 2 numeric");
    expect(screen.getByTestId("site360-grid-selection").textContent).toContain("1,500");
  });

  it("resizes a column by dragging its edge and fits it to the text on double-click", () => {
    renderApp(<Site360Grid menu={cw} rows={[{ id: "a", site_code: "S-A", values: { "3": "x" } }]} />);
    const handle = screen.getByTestId("site360-grid-resize-C");
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 160 });
    fireEvent.pointerUp(window);
    expect(screen.getByTestId("site360-grid-field-C").style.width).toBe("180px");
    fireEvent.doubleClick(handle);
    expect(screen.getByTestId("site360-grid-field-C").style.width).toBe(
      `${Math.max(40, "Site Owner ID".length * 7 + 24)}px`,
    );
  });
});
