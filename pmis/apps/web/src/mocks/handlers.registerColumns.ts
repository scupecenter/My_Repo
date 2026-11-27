import { http, HttpResponse } from "msw";
import { API_BASE as B } from "@/api/client";
import type {
  RegisterColumn,
  RegisterColumnImpact,
  RegisterColumnsScreen,
  RegisterSection,
} from "@/api/types";
import { stepUpValid, viewer } from "./db";
import { guard, problem, stepUp } from "./handlers";
import { REGISTER_DEFS } from "./registersData";

/**
 * Contract 0.15.15: the columns, sections and name of a register, as admin_reg_field_save, admin_reg_field_delete, admin_reg_fields_order, admin_reg_section_save
 * and admin_reg_definition_rename of migration 0095 decide them. Synthetic: the columns start from the mock catalogue; one is protected (`is_system`) and one
 * "holds values", so the deactivation and the protected paths can be shown. Only the System Admin (account `pm`) writes; a reason is needed; a delete, a type
 * change and a deactivation need the step-up.
 */
type State = {
  sections: RegisterSection[];
  fields: RegisterColumn[];
  name_en: string;
  name_ar: string | null;
  version: number;
};
const S: Record<string, State> = {};
const PROTECTED = new Set(["pr_no"]);
const USED = new Set(["request_date"]);
const TYPE_OF: Record<string, RegisterColumn["type"]> = {
  text: "text",
  number: "number",
  date: "date",
  list: "list",
  yes_no: "yes_no",
  user: "user",
};

const state = (key: string): State | null => {
  const def = REGISTER_DEFS.find((d) => d.register_key === key);
  if (!def) return null;
  return (S[key] ??= {
    name_en: def.name_en,
    name_ar: def.name_ar ?? null,
    version: 1,
    sections: [],
    fields: def.fields.map((f, i) => ({
      code: f.code,
      label_en: f.label_en,
      label_ar: f.label_ar ?? null,
      type: TYPE_OF[f.type as string] ?? "text",
      required: !!f.required,
      list_catalogue: null,
      list_catalogue_name: null,
      section: null,
      sort_order: (i + 1) * 10,
      in_list: true,
      in_filter: true,
      in_template: true,
      in_export: true,
      is_active: true,
      is_system: PROTECTED.has(f.code),
      system_reason: PROTECTED.has(f.code)
        ? "A natural key of the register template."
        : null,
      derived: false,
      usage: {
        records_with_value: USED.has(f.code) ? 3 : 0,
        records_missing_value: USED.has(f.code) ? 0 : 3,
        records_current: 3,
      },
      version: 1,
    })),
  });
};
const isAdmin = () => viewer()?.key === "pm";
const reasonOk = (b: { reason?: string }) =>
  (b.reason ?? "").trim().length >= 3;
const invalid = (path: string, code: string) =>
  problem(422, "validation_failed", "Validation failed", {
    errors: [{ path, code }],
  });
const forbidden = () =>
  problem(403, "action_forbidden", "You are not allowed to do this.");
const screenOf = (key: string, s: State): RegisterColumnsScreen => ({
  register: {
    register_key: key,
    name_en: s.name_en,
    name_ar: s.name_ar,
    version: s.version,
  },
  sections: s.sections.map((x) => ({
    ...x,
    field_count: s.fields.filter((f) => f.section === x.name_en).length,
  })),
  fields: [...s.fields].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  ),
});
/** What a type change of a text column would do to its three values: they convert to a number unless the column is the "dirty" one. */
const conversion = (c: RegisterColumn, to: string) => {
  const n = c.usage?.records_with_value ?? 0;
  const bad = to === "number" && c.code === "remarks" ? Math.min(1, n) : 0;
  return {
    convertible: n - bad,
    failed: bad,
    rewritten: n - bad,
    failures: bad ? [{ value: "twelve", message: "Not a number." }] : [],
  };
};
const impactOf = (c: RegisterColumn, to?: string): RegisterColumnImpact => ({
  code: c.code,
  is_system: c.is_system,
  system_reason: c.system_reason ?? null,
  usage: c.usage ?? {},
  required_missing: null,
  delete_mode: c.is_system
    ? "blocked"
    : (c.usage?.records_with_value ?? 0) > 0
      ? "deactivate"
      : "hard",
  conversion: to ? conversion(c, to) : null,
});

export const registerColumnHandlers = [
  http.get(`${B}/registers/:key/fields`, ({ params }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const s = state(String(params.key));
    return s
      ? HttpResponse.json(screenOf(String(params.key), s))
      : problem(404, "not_found", "The register does not exist.");
  }),
  http.get(`${B}/registers/:key/fields/:code/impact`, ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const c = state(String(params.key))?.fields.find(
      (f) => f.code === params.code,
    );
    return c
      ? HttpResponse.json(
          impactOf(
            c,
            new URL(request.url).searchParams.get("field_type") ?? undefined,
          ),
        )
      : problem(404, "not_found", "The column does not exist.");
  }),
  http.post(`${B}/registers/:key/fields`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const s = state(String(params.key));
    if (!s) return problem(404, "not_found", "The register does not exist.");
    const b = (await request.json()) as Partial<RegisterColumn> & {
      field_type?: RegisterColumn["type"];
      reason?: string;
      new_list?: { name_en: string };
      list_catalogue?: string;
    };
    if (!reasonOk(b)) return invalid("/reason", "required");
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(b.code ?? ""))
      return invalid("/code", "invalid");
    if (s.fields.some((f) => f.code === b.code))
      return problem(409, "duplicate", "This code is used already.");
    if (
      (b.field_type === "list" || b.field_type === "multi_list") &&
      !b.new_list &&
      !b.list_catalogue
    )
      return invalid("/list_catalogue", "required");
    s.fields.push({
      code: b.code!,
      label_en: b.label_en ?? b.code!,
      label_ar: b.label_ar ?? null,
      type: b.field_type ?? "text",
      required: !!b.required,
      list_catalogue: b.list_catalogue ?? (b.new_list ? "NewList" : null),
      list_catalogue_name: b.new_list?.name_en ?? null,
      section: b.section ?? null,
      sort_order: (s.fields.length + 1) * 10,
      in_list: b.in_list ?? true,
      in_filter: b.in_filter ?? true,
      in_template: b.in_template ?? true,
      in_export: b.in_export ?? true,
      is_active: true,
      is_system: false,
      system_reason: null,
      derived: b.field_type === "computed",
      usage: {
        records_with_value: 0,
        records_missing_value: 3,
        records_current: 3,
      },
      version: 1,
    });
    return HttpResponse.json({ code: b.code, version: 1 }, { status: 201 });
  }),
  http.patch(
    `${B}/registers/:key/fields/:code`,
    async ({ params, request }) => {
      const g = guard();
      if (g) return g;
      if (!isAdmin()) return forbidden();
      const c = state(String(params.key))?.fields.find(
        (f) => f.code === params.code,
      );
      if (!c) return problem(404, "not_found", "The column does not exist.");
      const b = (await request.json()) as Partial<RegisterColumn> & {
        field_type?: RegisterColumn["type"];
        reason?: string;
        confirm_conversion?: boolean;
      };
      if (!reasonOk(b)) return invalid("/reason", "required");
      const typeChange = b.field_type !== undefined && b.field_type !== c.type;
      if (
        c.is_system &&
        (typeChange || b.is_active === false || b.required !== undefined)
      )
        return problem(409, "system_field", "Protected", {
          detail: "This column is protected.",
        });
      if ((typeChange || b.is_active !== undefined) && !stepUpValid())
        return stepUp();
      let converted = 0;
      if (typeChange) {
        const cv = conversion(c, b.field_type!);
        if (cv.failed)
          return problem(
            409,
            "conversion_blocked",
            "Some values cannot be converted.",
            { failures: cv.failures } as never,
          );
        if (cv.rewritten && !b.confirm_conversion)
          return problem(
            409,
            "conversion_unconfirmed",
            "Confirm the conversion.",
          );
        converted = cv.rewritten;
        c.type = b.field_type!;
      }
      for (const k of [
        "label_en",
        "label_ar",
        "required",
        "section",
        "in_list",
        "in_filter",
        "in_template",
        "in_export",
        "is_active",
      ] as const)
        if (k in b) (c as Record<string, unknown>)[k] = b[k];
      c.version += 1;
      return HttpResponse.json({
        code: c.code,
        version: c.version,
        converted,
        records_missing_value: b.required
          ? (c.usage?.records_missing_value ?? 0)
          : null,
      });
    },
  ),
  http.put(`${B}/registers/:key/fields/:code/default`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const c = state(String(params.key))?.fields.find((f) => f.code === params.code);
    if (!c) return problem(404, "not_found", "The column does not exist.");
    const b = (await request.json()) as { value?: unknown; reason?: string };
    if (!reasonOk(b)) return invalid("/reason", "required");
    const value = b.value === undefined ? null : b.value;
    (c as { default_value?: unknown }).default_value = value;
    // the form reads the register definition: keep it in step (the real API serves it from the same column)
    const rf = REGISTER_DEFS.find((d) => d.register_key === params.key)?.fields.find((f) => f.code === params.code);
    if (rf) (rf as { default_value?: unknown }).default_value = value ?? undefined;
    c.version += 1;
    return HttpResponse.json({ code: c.code, version: c.version, default_value: value });
  }),
  http.delete(
    `${B}/registers/:key/fields/:code`,
    async ({ params, request }) => {
      const g = guard();
      if (g) return g;
      if (!isAdmin()) return forbidden();
      const s = state(String(params.key));
      const c = s?.fields.find((f) => f.code === params.code);
      if (!s || !c)
        return problem(404, "not_found", "The column does not exist.");
      if (!reasonOk((await request.json()) as { reason?: string }))
        return invalid("/reason", "required");
      if (c.is_system)
        return problem(409, "system_field", "Protected", {
          detail: "This column is protected.",
        });
      if (!stepUpValid()) return stepUp();
      if ((c.usage?.records_with_value ?? 0) > 0) {
        c.is_active = false;
        return HttpResponse.json({ mode: "deactivated", code: c.code });
      }
      s.fields = s.fields.filter((f) => f !== c);
      return HttpResponse.json({ mode: "deleted", code: c.code });
    },
  ),
  http.put(`${B}/registers/:key/fields-order`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const s = state(String(params.key));
    if (!s) return problem(404, "not_found", "The register does not exist.");
    const b = (await request.json()) as { codes: string[]; reason?: string };
    if (!reasonOk(b)) return invalid("/reason", "required");
    if (b.codes.some((c) => !s.fields.some((f) => f.code === c)))
      return invalid("/codes", "unknown_code");
    b.codes.forEach((code, i) => {
      const f = s.fields.find((x) => x.code === code);
      if (f) f.sort_order = (i + 1) * 10;
    });
    return HttpResponse.json({ ordered: b.codes.length });
  }),
  http.post(`${B}/registers/:key/sections`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const s = state(String(params.key));
    if (!s) return problem(404, "not_found", "The register does not exist.");
    const b = (await request.json()) as {
      name_en?: string;
      name_ar?: string | null;
      reason?: string;
    };
    if (!reasonOk(b)) return invalid("/reason", "required");
    if (!b.name_en?.trim()) return invalid("/name_en", "required");
    const id = `5c000000-0000-4000-8000-${String(s.sections.length + 1).padStart(12, "0")}`;
    s.sections.push({
      id,
      name_en: b.name_en.trim(),
      name_ar: b.name_ar ?? null,
      sort_order: (s.sections.length + 1) * 10,
      version: 1,
      field_count: 0,
    });
    return HttpResponse.json({ id, version: 1 }, { status: 201 });
  }),
  http.patch(
    `${B}/registers/:key/sections/:id`,
    async ({ params, request }) => {
      const g = guard();
      if (g) return g;
      if (!isAdmin()) return forbidden();
      const s = state(String(params.key));
      const sec = s?.sections.find((x) => x.id === params.id);
      if (!s || !sec)
        return problem(404, "not_found", "The section does not exist.");
      const b = (await request.json()) as {
        name_en?: string;
        name_ar?: string | null;
        reason?: string;
      };
      if (!reasonOk(b)) return invalid("/reason", "required");
      const old = sec.name_en;
      if (b.name_en) sec.name_en = b.name_en.trim();
      if ("name_ar" in b) sec.name_ar = b.name_ar ?? null;
      s.fields.forEach((f) => {
        if (f.section === old) f.section = sec.name_en;
      });
      sec.version += 1;
      return HttpResponse.json({ id: sec.id, version: sec.version });
    },
  ),
  http.delete(
    `${B}/registers/:key/sections/:id`,
    async ({ params, request }) => {
      const g = guard();
      if (g) return g;
      if (!isAdmin()) return forbidden();
      const s = state(String(params.key));
      const sec = s?.sections.find((x) => x.id === params.id);
      if (!s || !sec)
        return problem(404, "not_found", "The section does not exist.");
      if (!reasonOk((await request.json()) as { reason?: string }))
        return invalid("/reason", "required");
      if (s.fields.some((f) => f.section === sec.name_en))
        return problem(
          409,
          "section_not_empty",
          "The section still holds columns.",
        );
      s.sections = s.sections.filter((x) => x !== sec);
      return HttpResponse.json({ deleted: true });
    },
  ),
  http.patch(`${B}/registers/:key`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const s = state(String(params.key));
    if (!s) return problem(404, "not_found", "The register does not exist.");
    const b = (await request.json()) as {
      name_en?: string;
      name_ar?: string | null;
      reason?: string;
    };
    if (!reasonOk(b)) return invalid("/reason", "required");
    if (b.name_en) s.name_en = b.name_en.trim();
    if ("name_ar" in b) s.name_ar = b.name_ar ?? null;
    s.version += 1;
    return HttpResponse.json({
      register_key: String(params.key),
      version: s.version,
    });
  }),
];
/** Test helper: forget the in-memory columns. */
export const resetRegisterColumns = () => {
  for (const k of Object.keys(S)) delete S[k];
};
