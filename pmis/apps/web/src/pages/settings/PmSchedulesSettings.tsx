import { Plus, Trash2 } from "lucide-react";
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useRegisterDefs } from "@/api/registers";
import { useSite } from "@/api/sites";
import { dueSchedules, scheduleId, useGeneratePmDraft, usePmSchedules, useSetPmSchedules, type PmScheduleInput } from "@/api/pmSchedules";
import { errText, FormDialog } from "@/components/FormDialog";
import { fieldLabel, SitePicker } from "@/components/RegisterFields";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { DateInput } from '@/components/DateInput';

const UNITS = ["week", "month"] as const;
/** Field types a schedule can pre-fill as plain text. */
const FILLABLE = ["text", "number", "date", "list", "yes_no"];

function SiteCell({ id, onChange }: { id: string | null | undefined; onChange: (s: { id: string; code: string } | null) => void }) {
  const site = useSite(id ?? "");
  const value = id ? { id, code: site.data?.site_code ?? "…" } : null;
  return <SitePicker value={value} onChange={onChange} />;
}

/**
 * Settings, Screens, Preventive maintenance (contract 0.15.161). A schedule says: every N weeks or months a draft record is due in a register (for a site,
 * with the field values below). Nothing is created by a timer: a person who may create records in that register presses "Create draft" (here, or on the
 * register's own screen), the draft is saved as that person and goes through the normal review and approval. Needs admin.settings edit and a reason.
 */
export function PmSchedulesSettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = usePmSchedules();
  const defs = useRegisterDefs();
  const set = useSetPmSchedules();
  const gen = useGeneratePmDraft();
  const [draft, setDraft] = useState<PmScheduleInput[] | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <section className="card p-4" data-testid="page-pm-settings"><QueryFallback queries={[q]} testid="pm-settings-loading" /></section>;
  const s = q.data;
  const rows: PmScheduleInput[] = draft ?? s.schedules.map(({ id, name_en, name_ar, register_key, site_id, record_type, data, every, unit, next_due, active }) => ({ id, name_en, name_ar, register_key, site_id, record_type, data, every, unit, next_due, active }));
  const ar = i18n.language.startsWith("ar");
  const regName = (k: string) => { const r = s.catalogue.registers.find((x) => x.key === k); return r ? ((ar && r.name_ar) || r.name_en) : k; };
  const change = (i: number, patch: Partial<PmScheduleInput>) => setDraft(rows.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const add = () => {
    const first = s.catalogue.registers[0];
    setDraft([...rows, { id: scheduleId("schedule", rows.map((g) => g.id)), name_en: "", name_ar: null, register_key: first?.key ?? "", site_id: null, record_type: null, data: {}, every: 1, unit: "month", next_due: s.today, active: true }]);
  };
  const invalid = rows.some((g) => g.name_en.trim() === "" || !g.register_key || !Number.isInteger(g.every) || g.every < 1 || g.every > 52 || !/^\d{4}-\d{2}-\d{2}$/.test(g.next_due)
    || (!!s.catalogue.registers.find((r) => r.key === g.register_key)?.site_scoped && !g.site_id));
  const dueIds = new Set(dueSchedules(s).map((x) => x.id));
  return (
    <section className="card space-y-4 p-4" data-testid="page-pm-settings">
      <h2 className="font-bold">{t("pm.settings_title")}</h2>
      <p className="text-sm text-mute">{t("pm.settings_note")}</p>
      <p className="mono text-xs text-mute" data-testid="pm-version">
        {t("scopeMatch.version", { version: s.version })}
        {draft && <span className="chip ms-2">{t("scopeMatch.unsaved")}</span>}
      </p>
      {rows.length === 0 && <p className="text-mute" data-testid="pm-empty">{t("pm.none")}</p>}
      <ul className="space-y-3">
        {rows.map((g, i) => {
          const def = defs.data?.find((d) => d.register_key === g.register_key);
          const siteScoped = !!s.catalogue.registers.find((r) => r.key === g.register_key)?.site_scoped;
          const fields = (def?.fields ?? []).filter((f) => FILLABLE.includes(f.type) && !f.read_only);
          const entries = Object.entries(g.data ?? {});
          const saved = !draft && dueIds.has(g.id);
          return (
            <li key={g.id} className="space-y-2 rounded-lg border border-line p-3" data-testid={`pm-row-${g.id}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block space-y-1"><span className="text-xs font-semibold text-mute">{t("pm.name_en")}</span>
                  <input className="input w-full" data-testid={`pm-name-en-${g.id}`} value={g.name_en} maxLength={120} onChange={(e) => change(i, { name_en: e.target.value })} /></label>
                <label className="block space-y-1"><span className="text-xs font-semibold text-mute">{t("pm.name_ar")}</span>
                  <input className="input w-full" dir="rtl" data-testid={`pm-name-ar-${g.id}`} value={g.name_ar ?? ""} maxLength={120} onChange={(e) => change(i, { name_ar: e.target.value || null })} /></label>
              </div>
              <div className="grid gap-2 md:grid-cols-4">
                <label className="block space-y-1"><span className="text-xs font-semibold text-mute">{t("pm.register")}</span>
                  <select className="input w-full" data-testid={`pm-register-${g.id}`} value={g.register_key} onChange={(e) => change(i, { register_key: e.target.value, data: {}, record_type: null })}>
                    {s.catalogue.registers.map((r) => <option key={r.key} value={r.key}>{(ar && r.name_ar) || r.name_en}</option>)}
                  </select></label>
                <div className="block space-y-1 md:col-span-1"><span className="text-xs font-semibold text-mute">{t("pm.site")}{siteScoped ? " *" : ""}</span>
                  <SiteCell id={g.site_id} onChange={(x) => change(i, { site_id: x?.id ?? null })} /></div>
                <div className="flex items-end gap-2">
                  <label className="block space-y-1"><span className="text-xs font-semibold text-mute">{t("pm.every")}</span>
                    <input type="number" min={1} max={52} className="input w-20" data-testid={`pm-every-${g.id}`} value={Number.isFinite(g.every) ? g.every : ""} onChange={(e) => change(i, { every: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
                  <select className="input" aria-label={t("pm.unit")} data-testid={`pm-unit-${g.id}`} value={g.unit} onChange={(e) => change(i, { unit: e.target.value as PmScheduleInput["unit"] })}>
                    {UNITS.map((u) => <option key={u} value={u}>{t(`pm.unit_${u}`)}</option>)}
                  </select>
                </div>
                <label className="block space-y-1"><span className="text-xs font-semibold text-mute">{t("pm.next_due")}</span>
                  <DateInput dir="ltr" className="input w-full" data-testid={`pm-next-${g.id}`} value={g.next_due} onChange={(e) => change(i, { next_due: e.target.value })} /></label>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-mute">{t("pm.template")}</div>
                {entries.map(([code, v]) => (
                  <div key={code} className="flex flex-wrap items-center gap-2" data-testid={`pm-field-${g.id}-${code}`}>
                    <select className="input" aria-label={t("pm.field")} value={code} onChange={(e) => { const d = { ...g.data }; delete d[code]; d[e.target.value] = v; change(i, { data: d }); }}>
                      {fields.map((f) => <option key={f.code} value={f.code}>{fieldLabel(f, i18n.language)}</option>)}
                      {!fields.some((f) => f.code === code) && <option value={code}>{code}</option>}
                    </select>
                    <input className="input min-w-40 flex-1" aria-label={t("pm.value")} value={typeof v === "string" ? v : String(v ?? "")} onChange={(e) => change(i, { data: { ...g.data, [code]: e.target.value } })} />
                    <button className="btn" aria-label={t("pm.remove_field")} onClick={() => { const d = { ...g.data }; delete d[code]; change(i, { data: d }); }}><Trash2 size={14} aria-hidden="true" /></button>
                  </div>
                ))}
                <button className="btn px-2 py-1 text-xs" data-testid={`pm-add-field-${g.id}`} disabled={!fields.some((f) => !(f.code in (g.data ?? {})))}
                  onClick={() => { const f = fields.find((x) => !(x.code in (g.data ?? {}))); if (f) change(i, { data: { ...g.data, [f.code]: "" } }); }}>
                  <Plus size={14} aria-hidden="true" /> {t("pm.add_field")}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-2 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" data-testid={`pm-active-${g.id}`} checked={g.active ?? true} onChange={(e) => change(i, { active: e.target.checked })} />{t("pm.active")}</label>
                <span className="text-mute">{regName(g.register_key)}</span>
                {saved && <button className="btn" data-testid={`pm-create-${g.id}`} disabled={gen.isPending} onClick={() => gen.mutate(g.id, { onSuccess: () => toast(t("pm.created")), onError: (e) => toast(errText(e, t), "err") })}>{t("pm.create_draft")}</button>}
                <Link className="text-link" to={`/registers/${g.register_key}`} data-testid={`pm-open-${g.id}`}>{t("pm.open_register")}</Link>
                <button className="btn ms-auto" aria-label={t("pm.remove")} data-testid={`pm-remove-${g.id}`} onClick={() => setDraft(rows.filter((_, j) => j !== i))}><Trash2 size={16} aria-hidden="true" /></button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button className="btn" data-testid="pm-add" disabled={rows.length >= 100 || s.catalogue.registers.length === 0} onClick={add}><Plus size={16} aria-hidden="true" /> {t("pm.add")}</button>
        <button className="btn btn-accent" data-testid="pm-save" disabled={!draft || invalid} onClick={() => setOpen(true)}>{t("common.save")}</button>
        {draft && <button className="btn" data-testid="pm-discard" onClick={() => setDraft(null)}>{t("common.cancel")}</button>}
      </div>
      <UnsavedGuard scope="settings" dirty={!!draft} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: s.version, body: { schedules: rows.map((g) => ({ ...g, name_en: g.name_en.trim(), name_ar: g.name_ar?.trim() || null })), reason } }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      <FormDialog inline open={open} onClose={() => setOpen(false)} title={t("pm.save_title")} testid="pm-save-dialog" busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
        onSubmit={(reason) => set.mutate({ version: s.version, body: { schedules: rows.map((g) => ({ ...g, name_en: g.name_en.trim(), name_ar: g.name_ar?.trim() || null })), reason } },
          { onSuccess: () => { setDraft(null); setOpen(false); toast(t("settings.audited")); } })} />
    </section>
  );
}
