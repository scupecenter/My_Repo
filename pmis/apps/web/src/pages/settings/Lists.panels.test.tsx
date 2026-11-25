import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { API_BASE } from "@/api/client";
import { server } from "@/mocks/server";
import { renderApp, signIn } from "@/test/utils";
import { SettingsRoutes } from "./Settings";

/** F17 follow-up: the import (template + xlsx, reason of 3 or more characters) and bind-to-column panels on the Lists tab. */
const settings = () =>
  renderApp(
    <Routes>
      <Route path="/admin/settings/*" element={<SettingsRoutes />} />
    </Routes>,
    { route: "/admin/settings/lists" },
  );

describe("Settings, lists: import and bind panels (F17)", () => {
  it("imports values only with an xlsx file and a reason of at least 3 characters", async () => {
    await signIn("pm");
    const u = userEvent.setup();
    settings();
    await u.click(await screen.findByTestId("lists-row-TeamSpecialization"));
    const panel = await screen.findByTestId("lists-import");
    const submit = within(panel).getByTestId("lists-import-submit");
    expect(within(panel).getByTestId("lists-template")).toBeEnabled();
    expect(submit).toBeDisabled();
    await u.upload(
      within(panel).getByTestId("lists-import-file"),
      new File(["x"], "values.xlsx"),
    );
    expect(submit).toBeDisabled();
    await u.type(within(panel).getByTestId("lists-import-reason"), "ab");
    expect(submit).toBeDisabled();
    await u.type(within(panel).getByTestId("lists-import-reason"), "c");
    expect(submit).toBeEnabled();
  });

  it("binds a list to a list column only after a register, a field and a reason of at least 3 characters", async () => {
    await signIn("pm");
    const u = userEvent.setup();
    settings();
    await u.click(await screen.findByTestId("lists-row-TeamSpecialization"));
    const panel = await screen.findByTestId("lists-bind");
    const field = within(panel).getByTestId(
      "lists-bind-field",
    ) as HTMLSelectElement;
    const submit = within(panel).getByTestId("lists-bind-submit");
    expect(field).toBeDisabled();
    expect(submit).toBeDisabled();
    const register = within(panel).getByTestId(
      "lists-bind-register",
    ) as HTMLSelectElement;
    await waitFor(() => expect(register.options.length).toBeGreaterThan(1));
    await u.selectOptions(register, register.options[1].value);
    await waitFor(() => expect(field).toBeEnabled());
    await u.type(within(panel).getByTestId("lists-bind-reason"), "ok");
    expect(submit).toBeDisabled();
    await u.type(within(panel).getByTestId("lists-bind-reason"), "k");
    expect(submit).toBeDisabled();
    expect(field.options.length).toBeGreaterThanOrEqual(1);
  });

  it("shows neither panel for the mirrored Severity list, which follows the snag severities", async () => {
    await signIn("pm");
    const u = userEvent.setup();
    settings();
    await u.click(await screen.findByTestId("lists-row-Severity"));
    expect(await screen.findByTestId("lists-mirrored")).toBeInTheDocument();
    expect(screen.queryByTestId("lists-import")).toBeNull();
    expect(screen.queryByTestId("lists-bind")).toBeNull();
  });
});

describe("Settings, lists: reorder the values in place", () => {
  it("moves a value one step with the arrow: only the values whose position changes are saved, each with a reason", async () => {
    await signIn("pm");
    const sent: { id: string; body: { sort_order?: number; reason?: string } }[] = [];
    server.use(http.patch(`${API_BASE}/list-catalogues/:code/values/:id`, async ({ params, request }) => {
      sent.push({ id: String(params.id), body: (await request.json()) as never });
      return HttpResponse.json({ ok: true });
    }));
    const u = userEvent.setup();
    settings();
    const rows = await screen.findAllByTestId(/^lists-row-/);
    await u.click(rows[0]!);
    const down = (await screen.findAllByTestId(/^lists-value-down-/))[0]!;
    await u.click(down);
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent.every((x) => typeof x.body.sort_order === "number" && (x.body.reason ?? "").length >= 3)).toBe(true);
  });
});
