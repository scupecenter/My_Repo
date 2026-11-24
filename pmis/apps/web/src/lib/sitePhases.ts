import type { TFunction } from 'i18next';
import type { SiteTasks, Stream, StreamStatus, View, ViewRef } from '@/api/types';
import { DISMANTLE_CODE, isRealStream, streamName, viewName, withDismantle } from '@/lib/streams';

/**
 * One phase tab of the site page (W1, owner decision 2026-11-23: one tab row, its phases taken from the site's published
 * workflow version). A phase is a stream of the version (a group of stages), a view of the version that is not a stream
 * (O&M), or the Dismantle placeholder (owner decision Q41) while the version has no DISMANTLE stream.
 */
export type SitePhase = {
  code: string;
  /** The stream this phase filters on (`GET /sites/{id}/tasks?stream=`); null for a view-only phase and the placeholder. */
  stream: Stream | null;
  /** The view of the same code, when the version has one. A view-only phase filters on it (`?view=`). */
  view: ViewRef | null;
  /** Dismantle while the API knows no such stream: nothing to fetch. */
  placeholder: boolean;
};

/**
 * The phases of the site's workflow version, in the order of the configuration: the streams in their sort order, and each
 * view whose code is not a stream placed right after the phase of the view before it (views keep their own sort order), so
 * the seed gives Design & Acquisition, Civil Works, Installation (TE), O&M, Handover & Closure, Dismantle. A view with the
 * code of a stream (CW, TE) is the same phase as that stream, so no label appears twice. Nothing is hard-coded: a version
 * with other streams or views shows those.
 */
export function sitePhases(streams: Stream[] | undefined, views: ViewRef[] | undefined): SitePhase[] {
  const out: SitePhase[] = withDismantle(streams).map((s) => {
    const real = isRealStream(s.code, streams);
    return { code: s.code, stream: real ? s : null, view: null, placeholder: !real };
  });
  const sorted = [...(views ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  // where the next view-only phase goes: after the phase of the previous view; before the Dismantle placeholder by default
  let at = out.findIndex((p) => p.placeholder);
  if (at < 0) at = out.length;
  for (const v of sorted) {
    const same = out.find((p) => p.code === v.code);
    if (same) { same.view = v; at = out.indexOf(same) + 1; continue; }
    out.splice(at, 0, { code: v.code, stream: null, view: v, placeholder: false });
    at += 1;
  }
  return out;
}

/** The phase label in the UI language: the stream name (locale first), else the view name the admin configured. */
export function phaseLabel(t: TFunction, lang: string, p: SitePhase): string {
  if (!p.stream && !p.placeholder && p.view) return viewName(lang, p.view);
  return streamName(t, lang, p.stream ?? { code: p.code, name_en: p.code === DISMANTLE_CODE ? 'Dismantle' : p.code, name_ar: null });
}

/**
 * The phase the URL asks for. Backward compatible: an old `stream=` link opens the phase of that stream, and an old
 * `view=` link opens the phase of that view (CW and TE are the stream phases of the same code). `stream=` wins when both
 * are given. An unknown code opens All.
 */
export function phaseFromUrl(phases: SitePhase[], stream: string, view: string): SitePhase | null {
  return (stream ? phases.find((p) => p.code === stream) : undefined) ?? (view ? phases.find((p) => p.code === view) : undefined) ?? null;
}

/** The query of the task grid for a phase: the stream for a stream phase, the view for a view-only phase. */
export function phaseQuery(p: SitePhase | null): { stream: string | null; view: string | null } {
  if (!p || p.placeholder) return { stream: null, view: null };
  return p.stream ? { stream: p.stream.code, view: null } : { stream: null, view: p.view?.code ?? null };
}

/**
 * Whether a phase has no task that applies to this site (shown disabled). A stream phase uses the server status (`na`:
 * no counting task in the stream); a view-only phase counts the tasks of its members in the unfiltered task grid that
 * are not N/A, and stays enabled until that grid has loaded. The placeholder has no tasks.
 */
export function phaseEmpty(p: SitePhase, statuses: StreamStatus[] | undefined, all: SiteTasks | undefined): boolean {
  if (p.placeholder) return true;
  if (p.stream) return statuses?.find((s) => s.code === p.code)?.state === 'na';
  const members = (all?.views as View[] | undefined)?.find((v) => v.code === p.code);
  if (!all || !members) return false;
  const stages = new Set(members.stage_codes), tasks = new Set(members.task_codes);
  return !all.stages.some((st) => st.tasks.some((x) => (stages.has(st.code) || tasks.has(x.task_code)) && x.state !== 'na'));
}
