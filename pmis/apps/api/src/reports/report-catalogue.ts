/**
 * The ready reports of the Report Center (spec docs/plans/2026-11-28-report-center.md). The catalogue is code, not a table: a ready report names the register it
 * reads (through RegistersService.listRecords, the same read path and grants as the register screen), the way it groups and its default look. Settings can hide
 * a report (step 5); a report whose register the caller may not view is not offered.
 */
export type ReportGroup = 'projects' | 'procurement' | 'quality' | 'risk' | 'warehouse' | 'finance' | 'equipment';
export type ReportBy = 'state' | 'region' | 'record_type' | 'site_code';

export interface ReportDef {
  key: string;
  register: string;
  group: ReportGroup;
  title_en: string;
  title_ar: string;
  /** Rows are grouped by this column unless the caller picks another. */
  group_by: ReportBy;
  /** Display the first look as one of these (the caller can switch). */
  default_view: 'table' | 'grouped' | 'chart' | 'cards';
}

export const REPORT_GROUPS: Record<ReportGroup, [string, string]> = {
  projects: ['Projects', 'المشاريع'],
  procurement: ['Procurement', 'المشتريات'],
  quality: ['Quality and issues', 'الجودة والمشاكل'],
  risk: ['Risks and permits', 'المخاطر والتصاريح'],
  warehouse: ['Warehouse', 'المخزن'],
  finance: ['Finance', 'المالية'],
  equipment: ['Tools and equipment', 'الأدوات والمعدات'],
};

export const REPORTS: readonly ReportDef[] = [
  { key: 'procurement_status', register: 'procurement', group: 'procurement', title_en: 'Procurement status', title_ar: 'حالة المشتريات', group_by: 'state', default_view: 'grouped' },
  { key: 'issues_overview', register: 'issues', group: 'quality', title_en: 'Issues overview', title_ar: 'نظرة عامة على المشاكل', group_by: 'state', default_view: 'chart' },
  { key: 'quality_inspections', register: 'quality', group: 'quality', title_en: 'Quality inspections', title_ar: 'فحوصات الجودة', group_by: 'state', default_view: 'grouped' },
  { key: 'risk_register', register: 'risks', group: 'risk', title_en: 'Risk register', title_ar: 'سجل المخاطر', group_by: 'state', default_view: 'grouped' },
  { key: 'permits_hse', register: 'permits_hse', group: 'risk', title_en: 'Permits and HSE', title_ar: 'التصاريح والسلامة', group_by: 'region', default_view: 'grouped' },
  { key: 'warehouse_stock', register: 'warehouse', group: 'warehouse', title_en: 'Warehouse by region', title_ar: 'المخزن حسب المنطقة', group_by: 'region', default_view: 'grouped' },
  { key: 'equipment_status', register: 'tools_equipment', group: 'equipment', title_en: 'Tools and equipment', title_ar: 'الأدوات والمعدات', group_by: 'state', default_view: 'grouped' },
  { key: 'invoices_overview', register: 'invoices', group: 'finance', title_en: 'Invoices', title_ar: 'الفواتير', group_by: 'state', default_view: 'grouped' },
  { key: 'advances_overview', register: 'financial_advances', group: 'finance', title_en: 'Financial advances', title_ar: 'السلف المالية', group_by: 'state', default_view: 'grouped' },
];

export const reportByKey = (key: string): ReportDef | undefined => REPORTS.find((r) => r.key === key);
