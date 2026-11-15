import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
