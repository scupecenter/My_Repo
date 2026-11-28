import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

/**
 * The shared card primitives of the dashboard (extracted from Dashboard.tsx unchanged, 0.15.98), so the follow-up
 * cards (dashboardOps.tsx) use the same design system: card, progress bar, KPI tile and the percentage format.
 */

export const pct = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined ? "–" : `${Number(n.toFixed(digits))}%`;
/** One number format on the whole dashboard: Western digits with a thousands separator (the digits of the charts and the tables match). */
const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export function num(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "–" : NUM.format(n);
}
export const signed = (n: number): string => (n > 0 ? `+${num(n)}` : num(n));
/** The bar charts show the first CHART_ROWS rows. */
export const CHART_ROWS = 8;
/** A thin bar under a count: its share of the row total (a visual cue only; the number stays the source). */
export function MiniShare({ part, total, tone = "bg-accent" }: { part: number; total: number; tone?: string }) {
  const w = total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0;
  return (
    <span className="mt-0.5 block h-1 w-full rounded bg-line" aria-hidden="true">
      <span className={`block h-1 rounded ${tone}`} style={{ width: `${w}%` }} />
    </span>
  );
}
/** The wording line under a truncated bar chart: how many rows the chart leaves out. */
export function MoreLine({ total, testid }: { total: number; testid: string }) {
  const { t } = useTranslation();
  if (total <= CHART_ROWS) return null;
  return (
    <p className="mt-1 text-xs text-mute" data-testid={testid}>
      {t("dash.more", { n: num(total - CHART_ROWS) })}
    </p>
  );
}

export function Card({
  title,
  testid,
  children,
  aside,
  className = "",
  basisNote,
}: {
  title: string;
  testid: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
  /** Where the figures of the card come from (live, snapshot or computed as of a date). */
  basisNote?: string;
}) {
  return (
    <section
      className={`card p-4 ${className}`}
      data-testid={testid}
      aria-label={title}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{title}</h2>
        {aside}
      </div>
      {basisNote && (
        <p className="-mt-2 mb-2 text-xs text-mute" data-testid={`${testid}-basis`}>
          {basisNote}
        </p>
      )}
      {children}
    </section>
  );
}

/** A progress bar with an optional tick for the plan. */
export function Bar({
  value,
  plan,
  tone = "bg-accent",
  label,
}: {
  value: number;
  plan?: number | null;
  tone?: string;
  label?: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  const { t } = useTranslation();
  return (
    <div
      className="relative h-3 w-full rounded-full bg-lockBg"
      role="progressbar"
      aria-label={label ?? t("cells.progress")}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i
        className={`absolute inset-y-0 start-0 rounded-full ${tone}`}
        style={{ width: `${v}%` }}
      />
      {plan !== null && plan !== undefined && (
        <u
          className="absolute -inset-y-1 border-s-2 border-dashed border-ink no-underline"
          style={{ insetInlineStart: `${Math.max(0, Math.min(100, plan))}%` }}
          aria-hidden
        />
      )}
    </div>
  );
}

export function Kpi({
  title,
  value,
  sub,
  to,
  testid,
  tone,
}: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  to?: string;
  testid: string;
  tone?: string;
}) {
  const body = (
    <>
      <div className="text-sm text-mute">{title}</div>
      <div className={`text-3xl font-bold tnum ${tone ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-mute">{sub}</div>}
    </>
  );
  return to ? (
    <Link
      to={to}
      className="card motion-lift block p-4 hover:border-mute"
      data-testid={testid}
    >
      {body}
    </Link>
  ) : (
    <div className="card p-4" data-testid={testid}>
      {body}
    </div>
  );
}
