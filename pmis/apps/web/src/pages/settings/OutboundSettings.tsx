import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useArchiveOutboundDestination,
  useOutbound,
  useOutboundDeliveries,
  useSaveOutboundDestination,
  useSetOutboundEnabled,
  type OutboundDestination,
} from "@/api/outbound";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";

type Dlg =
  | { t: "enabled"; value: boolean }
  | { t: "dest"; dest: OutboundDestination | null }
  | { t: "archive"; dest: OutboundDestination };

/**
 * Settings, Alerts, Outbound (contract 0.15.475, D8): sends chosen in-app notification kinds to an https webhook (HMAC-signed) or an email address. OFF by default and
 * blocked by the disable_export lock. The payload carries the kind, the title, the ids and the link only. A webhook secret is write-only. Every change has a reason and an audit row.
 */
export function OutboundSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useOutbound();
  const dq = useOutboundDeliveries();
  const setEnabled = useSetOutboundEnabled();
  const save = useSaveOutboundDestination();
  const archive = useArchiveOutboundDestination();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [kind, setKind] = useState<"webhook" | "email">("webhook");
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  if (!q.data) return <QueryFallback queries={[q]} testid="outbound-loading" />;
  const s = q.data;
  const close = () => setDlg(null);
  const done = () => {
    toast(t("settings.audited"));
    close();
  };
  const openDest = (d: OutboundDestination | null) => {
    setKind(d?.kind ?? "webhook");
    setLabel(d?.label ?? "");
    setTarget(d?.target ?? "");
    setSecret("");
    setEvents(d?.events ?? []);
    setActive(d?.active ?? true);
    setDlg({ t: "dest", dest: d });
  };
  const toggle = (e: string) => setEvents((v) => (v.includes(e) ? v.filter((x) => x !== e) : [...v, e]));
  return (
    <div className="space-y-4" data-testid="outbound-settings">
      <fieldset className="space-y-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t("outbound.title")}</legend>
        <p className="text-xs text-mute">{t("outbound.note")}</p>
        <p className="text-sm" data-testid="outbound-state">
          {s.enabled ? t("outbound.on") : t("outbound.off")}
        </p>
        {s.locked && (
          <p className="text-xs text-danger" data-testid="outbound-locked">
            {t("outbound.locked")}
          </p>
        )}
        <button
          className="btn btn-accent"
          data-testid="outbound-toggle"
          aria-label={s.enabled ? t("outbound.turn_off") : t("outbound.turn_on")}
          onClick={() => setDlg({ t: "enabled", value: !s.enabled })}
        >
          {s.enabled ? t("outbound.turn_off") : t("outbound.turn_on")}
        </button>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t("outbound.destinations")}</legend>
        <p className="text-xs text-mute">{t("outbound.destinations_note")}</p>
        <button className="btn" data-testid="outbound-add" aria-label={t("outbound.add")} onClick={() => openDest(null)}>
          {t("outbound.add")}
        </button>
        {s.destinations.length === 0 && <p className="text-sm text-mute">{t("outbound.none")}</p>}
        <ul className="space-y-2">
          {s.destinations.map((d) => (
            <li key={d.id} className="rounded border border-line p-2 text-sm" data-testid={`outbound-dest-${d.id}`}>
              <div className="font-semibold">
                {d.label} <span className="mono text-xs text-mute">({t(`outbound.kind_${d.kind}`)})</span>
              </div>
              <div className="mono text-xs break-all" dir="ltr">{d.target}</div>
              <div className="text-xs text-mute">
                {d.events.map((e) => t(`outbound.event_${e}`)).join(", ")}
              </div>
              <div className="text-xs">
                {d.archived_at ? t("outbound.archived") : d.active ? t("outbound.active") : t("outbound.paused")} · {t("outbound.queued", { n: d.queued })} · {t("outbound.dead", { n: d.dead })}
              </div>
              {!d.archived_at && (
                <div className="mt-1 flex gap-2">
                  <button className="btn" aria-label={t("outbound.edit")} data-testid={`outbound-edit-${d.id}`} onClick={() => openDest(d)}>
                    {t("outbound.edit")}
                  </button>
                  <button className="btn" aria-label={t("outbound.archive")} data-testid={`outbound-archive-${d.id}`} onClick={() => setDlg({ t: "archive", dest: d })}>
                    {t("outbound.archive")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t("outbound.log")}</legend>
        <table className="w-full text-xs" data-testid="outbound-log">
          <thead>
            <tr className="text-start">
              <th className="text-start">{t("outbound.log_when")}</th>
              <th className="text-start">{t("outbound.log_dest")}</th>
              <th className="text-start">{t("outbound.log_event")}</th>
              <th className="text-start">{t("outbound.log_status")}</th>
            </tr>
          </thead>
          <tbody>
            {(dq.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <td className="mono" dir="ltr">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                <td>{r.destination}</td>
                <td>{t(`outbound.event_${r.event}`, { defaultValue: r.event })}</td>
                <td>
                  {t(`outbound.status_${r.status}`)}
                  {r.last_error ? ` (${r.last_error})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      {dlg?.t === "enabled" && (
        <FormDialog
          open
          onClose={close}
          testid="outbound-enabled-dialog"
          title={dlg.value ? t("outbound.turn_on") : t("outbound.turn_off")}
          busy={setEnabled.isPending}
          error={setEnabled.isError ? errText(setEnabled.error, t) : null}
          onSubmit={(reason) => setEnabled.mutate({ version: s.version, body: { enabled: dlg.value, reason } }, { onSuccess: done })}
        >
          <p className="text-sm">{dlg.value ? t("outbound.confirm_on") : t("outbound.confirm_off")}</p>
        </FormDialog>
      )}

      {dlg?.t === "archive" && (
        <FormDialog
          open
          onClose={close}
          testid="outbound-archive-dialog"
          title={t("outbound.archive")}
          busy={archive.isPending}
          error={archive.isError ? errText(archive.error, t) : null}
          onSubmit={(reason) => archive.mutate({ id: dlg.dest.id, archived: true, reason }, { onSuccess: done })}
        >
          <p className="text-sm">{t("outbound.confirm_archive", { label: dlg.dest.label })}</p>
        </FormDialog>
      )}

      {dlg?.t === "dest" && (
        <FormDialog
          open
          onClose={close}
          testid="outbound-dest-dialog"
          title={dlg.dest ? t("outbound.edit") : t("outbound.add")}
          busy={save.isPending}
          disabled={!label.trim() || !target.trim() || events.length === 0 || (!dlg.dest && kind === "webhook" && secret.length < 16)}
          error={save.isError ? errText(save.error, t) : null}
          onSubmit={(reason) =>
            save.mutate(
              { id: dlg.dest?.id, body: { kind, label: label.trim(), target: target.trim(), secret: secret || undefined, events, active, reason } },
              { onSuccess: done },
            )
          }
        >
          <div className="space-y-2">
            <label className="block text-sm">
              {t("outbound.kind")}
              <select className="input mt-1 w-48" data-testid="outbound-kind" value={kind} disabled={!!dlg.dest} onChange={(e) => setKind(e.target.value === "email" ? "email" : "webhook")}>
                <option value="webhook">{t("outbound.kind_webhook")}</option>
                <option value="email">{t("outbound.kind_email")}</option>
              </select>
            </label>
            <label className="block text-sm">
              {t("outbound.label")}
              <input className="input mt-1 w-full" data-testid="outbound-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="block text-sm">
              {kind === "webhook" ? t("outbound.url") : t("outbound.address")}
              <input className="input mt-1 w-full" dir="ltr" data-testid="outbound-target" value={target} maxLength={500} onChange={(e) => setTarget(e.target.value)} />
            </label>
            {kind === "webhook" && (
              <label className="block text-sm">
                {t("outbound.secret")}
                <input className="input mt-1 w-full" dir="ltr" type="password" autoComplete="new-password" data-testid="outbound-secret" value={secret} maxLength={200} onChange={(e) => setSecret(e.target.value)} />
                <span className="text-xs text-mute">{dlg.dest ? t("outbound.secret_keep") : t("outbound.secret_hint")}</span>
              </label>
            )}
            <div className="text-sm">
              {t("outbound.events")}
              <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {s.event_kinds.map((e) => (
                  <label key={e} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" data-testid={`outbound-event-${e}`} checked={events.includes(e)} onChange={() => toggle(e)} />
                    {t(`outbound.event_${e}`)}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid="outbound-active" checked={active} onChange={(e) => setActive(e.target.checked)} />
              {t("outbound.active")}
            </label>
          </div>
        </FormDialog>
      )}
    </div>
  );
}
