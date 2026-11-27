import { CalendarClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { dueSchedules, useGeneratePmDraft, usePmSchedules } from "@/api/pmSchedules";
import { useMe } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { errText } from "@/components/FormDialog";

/**
 * Due preventive-maintenance schedules of one register (contract 0.15.161). Nothing is created by a timer: a person who may create records here presses
 * "Create draft" and one draft (state entry) is saved as that person, then goes through the normal review and approval. Shown only when a schedule is due.
 */
export function PmDuePanel({ registerKey, onCreated }: { registerKey: string; onCreated?: (recordId: string) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = usePmSchedules();
  const gen = useGeneratePmDraft();
  const me = useMe(true);
  const due = dueSchedules(q.data, registerKey);
  if (!due.length) return null;
  const ar = i18n.language.startsWith("ar");
  return (
    <section className="card mb-3 space-y-2 p-3" data-testid="pm-due" aria-label={t("pm.due_title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold"><CalendarClock size={16} aria-hidden="true" />{t("pm.due_title")}</h2>
        {me.data?.is_system_admin && <Link className="text-xs text-link" to="/admin/settings/screens/pm-schedules" data-testid="pm-due-settings">{t("pm.manage")}</Link>}
      </div>
      <ul className="space-y-1.5">
        {due.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`pm-due-${s.id}`}>
            <span>{(ar && s.name_ar) || s.name_en} <span className="chip bg-waitBg text-waitInk tnum" dir="ltr">{s.next_due}</span></span>
            <button className="btn" data-testid={`pm-create-${s.id}`} disabled={gen.isPending}
              onClick={() => gen.mutate(s.id, { onSuccess: (r) => { toast(t("pm.created")); onCreated?.(r.record_id); }, onError: (e) => toast(errText(e, t), "err") })}>
              {t("pm.create_draft")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
