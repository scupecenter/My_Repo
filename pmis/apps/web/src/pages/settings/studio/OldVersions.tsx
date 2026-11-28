import { Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeleteVersion, useRestoreVersion, useVersionArchive, useWorkflowVersion, useWorkflowVersions, type ArchivedVersion, type WorkflowVersionSummary } from "@/api/workflowEditor";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";

/**
 * Workflow Studio, old versions (contract 0.15.436): a small isolated card under the Studio. It lists the published versions that are not the one in force and lets a
 * holder of the publish right delete one that no site uses, after the server has archived a full snapshot of it. The reason, the password step-up and the typed
 * confirmation `v<version>` are required; the server decides every rule again and answers with the reasons that block a delete.
 */
export function OldVersions() {
  const { t } = useTranslation();
  const q = useWorkflowVersions();
  const [target, setTarget] = useState<number | null>(null);
  const arch = useVersionArchive();
  const [restore, setRestore] = useState<ArchivedVersion | null>(null);
  const old = (q.data?.items ?? []).filter((v) => v.status === "published" && !v.is_current);
  const archived = (arch.data?.items ?? []).filter((a) => !a.restored_at);
  if (old.length === 0 && archived.length === 0) return null;
  return (
    <section className="card space-y-2 p-3" data-testid="old-versions" aria-label={t("oldVersions.title")}>
      <h3 className="font-semibold">{t("oldVersions.title")}</h3>
      <p className="text-xs text-mute">{t("oldVersions.note")}</p>
      <ul className="space-y-1">
        {old.map((v: WorkflowVersionSummary) => (
          <li key={v.version} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`old-version-${v.version}`}>
            <span className="mono">v{v.version}</span>
            <span className="text-mute">{t("oldVersions.sites", { count: v.site_count ?? 0 })}</span>
            <button
              type="button"
              className="btn ms-auto min-h-11"
              data-testid={`old-version-delete-${v.version}`}
              aria-label={t("oldVersions.delete_aria", { version: v.version })}
              disabled={(v.site_count ?? 0) > 0}
              title={(v.site_count ?? 0) > 0 ? t("oldVersions.has_sites") : undefined}
              onClick={() => setTarget(v.version)}
            >
              <Trash2 size={14} aria-hidden />
              {t("oldVersions.delete")}
            </button>
          </li>
        ))}
      </ul>
      {archived.length > 0 && (
        <div className="space-y-1" data-testid="archived-versions">
          <h4 className="text-sm font-semibold">{t("oldVersions.archived_title")}</h4>
          <ul className="space-y-1">
            {archived.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`archived-version-${a.version}`}>
                <span className="mono">v{a.version}</span>
                <span className="text-mute">{new Date(a.archived_at).toLocaleDateString()}{a.reason ? ` · ${a.reason}` : ""}</span>
                <button type="button" className="btn ms-auto min-h-11" data-testid={`archived-restore-${a.version}`} aria-label={t("oldVersions.restore_aria", { version: a.version })} onClick={() => setRestore(a)}>
                  <Undo2 size={14} aria-hidden />
                  {t("oldVersions.restore")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {target !== null && <DeleteDialog version={target} onClose={() => setTarget(null)} />}
      {restore && <RestoreDialog item={restore} onClose={() => setRestore(null)} />}
    </section>
  );
}

function RestoreDialog({ item, onClose }: { item: ArchivedVersion; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const res = useRestoreVersion();
  return (
    <FormDialog
      open
      onClose={onClose}
      testid="archived-restore-dialog"
      title={t("oldVersions.restore_title", { version: item.version })}
      submitLabel={t("oldVersions.restore")}
      busy={res.isPending}
      error={res.isError ? errText(res.error, t) : null}
      onSubmit={(reason) =>
        res.mutate(
          { id: item.id, reason },
          {
            onSuccess: () => {
              toast(t("oldVersions.restored"));
              onClose();
            },
          },
        )
      }
    >
      <p className="text-sm text-mute">{t("oldVersions.restore_hint")}</p>
    </FormDialog>
  );
}

function DeleteDialog({ version, onClose }: { version: number; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const one = useWorkflowVersion(version);
  const etag = one.data?.version_etag ?? 0;
  const del = useDeleteVersion(version, etag);
  const [typed, setTyped] = useState("");
  return (
    <FormDialog
      open
      onClose={onClose}
      testid="old-version-delete-dialog"
      title={t("oldVersions.dialog_title", { version })}
      submitLabel={t("oldVersions.delete")}
      busy={del.isPending}
      disabled={!one.data || typed !== `v${version}`}
      error={del.isError ? errText(del.error, t) : null}
      onSubmit={(reason) =>
        del.mutate(
          { reason, confirm_text: typed },
          {
            onSuccess: () => {
              toast(t("oldVersions.deleted"));
              onClose();
            },
          },
        )
      }
    >
      <p className="text-sm text-mute">{t("oldVersions.hint")}</p>
      <label className="block text-sm">
        {t("oldVersions.confirm", { version })}
        <input className="input mt-1 w-40" dir="ltr" data-testid="old-version-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </FormDialog>
  );
}
