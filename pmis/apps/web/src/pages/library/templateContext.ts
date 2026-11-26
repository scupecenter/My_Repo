/**
 * The data a Library form is filled with: the contract of lib_form_context (migration 0151) in one list, so the Templates page can show the author
 * every placeholder that exists and flag one that does not. Keep it in step with db/sql/150_library.sql (lib_form_context) and the renderer.
 */
export interface ContextGroup { key: string; paths: string[] }

export const CONTEXT_GROUPS: ContextGroup[] = [
  { key: 'site', paths: ['site.id', 'site.code', 'site.name', 'site.name_ar', 'site.owner_site_id', 'site.region_code', 'site.region_name', 'site.region_name_ar', 'site.cluster',
    'site.latitude', 'site.longitude', 'site.address', 'site.site_type', 'site.tower_owner', 'site.tower_type', 'site.tower_height_m', 'site.delivery_scenario', 'site.sub_region'] },
  { key: 'region', paths: ['region.code', 'region.name', 'region.name_ar'] },
  { key: 'task', paths: ['task.code', 'task.name', 'task.name_ar', 'task.state', 'task.planned_date', 'task.actual_date', 'task.due_date'] },
  { key: 'doc', paths: ['doc.ref_no', 'doc.date', 'doc.remarks'] },
  { key: 'template', paths: ['template.code', 'template.version', 'template.name', 'template.name_ar'] },
  { key: 'generated_by', paths: ['generated_by.name', 'generated_by.employee_id'] },
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
