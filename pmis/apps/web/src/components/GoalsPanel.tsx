import { Target } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useGoalsProgress, type GoalProgress } from "@/api/goals";
import { useMe } from "@/api/hooks";
import { QueryFallback } from "@/components/States";

const TONE: Record<GoalProgress["status"], string> = {
  achieved: "bg-doneBg text-doneInk",
  on_track: "bg-doneBg text-doneInk",
  at_risk: "bg-waitBg text-waitInk",
  behind: "bg-lateBg text-lateInk",
};

/**
 * Dashboard card "Goals" (contract 0.15.99): every active goal with its automatic progress, the share of the period that has passed (the tick) and a
 * status. Each goal links to the sites list it counts (region filter), and the card links to Settings, Screens, Goals for an administrator.
 */
export function GoalsPanel() {
  const { t, i18n } = useTranslation();
  const q = useGoalsProgress();
  const me = useMe(true);
  const ar = i18n.language.startsWith("ar");
  if (!q.data)
    return (
      <section className="card p-4" data-testid="dash-goals">
        <QueryFallback queries={[q]} testid="dash-goals-loading" />
      </section>
    );
  const goals = q.data.goals;
  return (
    <section
      className="card p-4 print:break-inside-avoid"
      data-testid="dash-goals"
      aria-label={t("goals.title")}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-bold">
          <Target size={18} aria-hidden="true" />
          {t("goals.title")}
        </h2>
        {me.data?.is_system_admin && (
          <Link
            className="btn"
            to="/admin/settings/screens/goals"
            data-testid="dash-goals-settings"
          >
            {t("goals.manage")}
          </Link>
        )}
      </div>
      {goals.length === 0 ? (
        <p className="text-mute" data-testid="dash-goals-empty">
          {t("goals.none")}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {goals.map((g) => {
            const shown = Math.min(100, g.percent);
            return (
              <li
                key={g.id}
                className="rounded-md border border-line p-3"
                data-testid={`dash-goal-${g.id}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {(ar && g.name_ar) || g.name_en}
                  </span>
                  <span className={`chip ${TONE[g.status]}`}>
                    {t(`goals.status_${g.status}`)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-mute">
                  {g.metric} · {t(`goals.period_${g.period}`)} ·{" "}
                  <span className="tnum">
                    {g.period_start} – {g.period_end}
                  </span>
                </div>
                <div
                  className="relative mt-2 h-2 rounded-full bg-line"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(shown)}
                  aria-label={(ar && g.name_ar) || g.name_en}
                >
                  <div
                    className="h-2 rounded-full bg-accent"
                    style={{ width: `${shown}%` }}
                  />
                  <div
                    className="absolute -top-1 h-4 w-0.5 bg-ink"
                    style={{ insetInlineStart: `${Math.min(100, g.expected_percent)}%` }}
                    aria-hidden="true"
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="tnum">
                    <b>{g.actual}</b> / {g.target} ({g.percent}%)
                  </span>
                  <Link
                    className="text-accent hover:underline"
                    to={g.region_id ? `/sites?region_id=${g.region_id}` : "/sites"}
                    data-testid={`dash-goal-${g.id}-sites`}
                  >
                    {t("goals.open_sites")}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
