/**
 * The data a Library form is filled with: the contract of lib_form_context (migration 0151) in one list, so the Templates page can show the author
 * every placeholder that exists and flag one that does not. Keep it in step with db/sql/150_library.sql (lib_form_context) and the renderer.
 */
export interface ContextGroup { key: string; paths: string[] }

export const CONTEXT_GROUPS: ContextGroup[] = [
  { key: 'site', paths: ['site.id', 'site.code', 'site.name', 'site.name_ar', 'site.owner_site_id', 'site.region_code', 'site.region_name', 'site.region_name_ar', 'site.cluster',
    'site.latitude', 'site.longitude', 'site.address', 'site.site_type', 'site.tower_owner', 'site.tower_type', 'site.tower_height_m', 'site.delivery_scenario', 'site.sub_region',
    'site.po_wo', 'site.cw_start_date', 'site.cw_finish_date'] },
  { key: 'region', paths: ['region.code', 'region.name', 'region.name_ar'] },
  { key: 'task', paths: ['task.code', 'task.name', 'task.name_ar', 'task.state', 'task.planned_date', 'task.actual_date', 'task.due_date'] },
  { key: 'doc', paths: ['doc.ref_no', 'doc.date', 'doc.dispatch_date', 'doc.remarks'] },
  { key: 'template', paths: ['template.code', 'template.version', 'template.name', 'template.name_ar'] },
  { key: 'generated_by', paths: ['generated_by.name', 'generated_by.employee_id'] },
  // the CW warehouse forms (migration 0712, design/forms/bindings.md); the flag maps use the printed keys of the layouts
  { key: 'contractor', paths: ['contractor.name'] },
  { key: 'warehouse', paths: ['warehouse.name'] },
  { key: 'dismantle', paths: ['dismantle.date', 'dismantle.po_wo'] },
  { key: 'rn', paths: ['rn.reason_other', 'rn.reason_is.faulty', 'rn.reason_is.relocation', 'rn.reason_is.cancellation', 'rn.reason_is.other'] },
  { key: 'pac', paths: ['pac.ref_no', 'pac.date', 'pac.dlp_start', 'pac.dlp_expiry', 'pac.dlp_duration', 'pac.final_remarks',
    'pac.statement_is.accepted', 'pac.statement_is.with_snags', 'pac.statement_is.not_accepted'] },
  { key: 'fac', paths: ['fac.recommendation_is.recommended', 'fac.recommendation_is.not_recommended', 'fac.decision_is.granted', 'fac.decision_is.withheld'] },
  { key: 'checks', paths: ['checks.ground_ohm'] },
  { key: 'cw_flags', paths: ['site.sow_is.erection', 'site.sow_is.adaption', 'site.sow_is.both', 'site.tower_is.GF_SST', 'site.tower_is.RT_GMT', 'site.tower_is.RT_Pole', 'site.tower_is.Other',
    'site.schedule_is.ahead', 'site.schedule_is.behind', 'site.schedule_is.on'] },
  { key: 'signatories', paths: ['signatories.applicant.name', 'signatories.applicant.position', 'signatories.applicant.date',
    'signatories.reviewer_se.name', 'signatories.reviewer_se.position', 'signatories.reviewer_se.date',
    'signatories.approver_inventory.name', 'signatories.approver_inventory.position', 'signatories.approver_inventory.date',
    'signatories.site_engineer.name', 'signatories.site_engineer.position', 'signatories.site_engineer.date',
    'signatories.cw_team_lead.name', 'signatories.cw_team_lead.position', 'signatories.cw_team_lead.date',
    'signatories.project_manager.name', 'signatories.project_manager.position', 'signatories.project_manager.date',
    'signatories.contractor.name', 'signatories.contractor.position', 'signatories.contractor.date'] },
];

/** Server-built values a template may print raw with triple braces (the renderer's RAW_OK list). */
export const RAW_PATHS = ['doc.qr_svg_uri', 'doc.ref_no_css', 'template.code_css', 'template.version_css'];

const KNOWN = new Set<string>([...CONTEXT_GROUPS.flatMap((g) => g.paths), ...RAW_PATHS, 'this']);

/** True when a placeholder path from an uploaded template can be filled: a known path, a region flag, a bound field, or a name inside a block. */
export function isKnownPath(path: string, bindingNames: string[]): boolean {
  const p = path.trim();
  if (KNOWN.has(p)) return true;
  if (/^site\.region_is\.[A-Za-z0-9_-]+$/.test(p)) return true;
  if (p.startsWith('fields.')) return bindingNames.includes(p.slice('fields.'.length));
  return false;
}

/** Placeholders of a template that no data path fills. A name used inside a {{#each}} block is not checked (its list is a path of its own). */
export function unknownPlaceholders(placeholders: string[] | undefined, bindings: Record<string, string> | undefined): string[] {
  const names = Object.keys(bindings ?? {});
  return (placeholders ?? []).filter((p) => !/^[#/]/.test(p) && !/\s/.test(p.trim()) && p.includes('.') && !isKnownPath(p, names));
}
