import ExcelJS from 'exceljs';

type Cell = string | number | null;
type UserRef = { id: string; display_name: string; employee_id: string | null };

export interface WorkbookInput {
  month: string;
  from: string;
  to: string;
  timeZone: string;
  scope: string;
  regions: 'all' | number[];
  regionNames: Map<number, string>;
  generatedAt: Date;
  generatedBy: UserRef;
  users: { user: UserRef; actions: number; field_changes: number; approvals: number }[];
  modules: { module_key: string; actions: number; approvals: number; users: number; overrides: number }[];
  exports: { id: number; at: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; module_key: string | null; region_id: number | null; rows: number | null }[];
  exceptions: { id: number; at: string; actor_id: string | null; on_behalf_of: string | null; action: string; entity_type: string; entity_id: string | null; module_key: string | null;
    region_id: number | null; reason: string | null; kind: string }[];
  exportsTruncated: boolean;
  exceptionsTruncated: boolean;
  people: Map<string, UserRef>;
}

/**
 * The monthly activity workbook (owner answer Q169): Summary, User Activity, Module Activity, Exports, Exceptions and About. Every sheet has a frozen
 * header with a filter and prints landscape on one page width. Text is always a text cell (number format @), never a formula. The security log is not
 * part of it (it is exported separately by whoever holds its rights).
 */
export async function activityWorkbook(d: WorkbookInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GSDN PMIS';
  wb.created = d.generatedAt;
  const name = (id: string | null): string => (id ? d.people.get(id)?.display_name ?? id : '');
  const emp = (id: string | null): string => (id ? d.people.get(id)?.employee_id ?? '' : '');
  const region = (r: number | null): string => (r === null ? '' : d.regionNames.get(r) ?? String(r));

  const sheet = (title: string, header: string[], widths: number[], rows: Cell[][]): void => {
    const ws = wb.addWorksheet(title, {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
      headerFooter: { oddFooter: `GSDN PMIS · ${title} · ${d.month} · &P / &N` },
    });
    ws.columns = widths.map((w) => ({ width: w }));
    for (const r of [header, ...rows]) {
      const row = ws.addRow(r.map((c) => (c === null ? null : typeof c === 'number' ? c : String(c))));
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') cell.numFmt = '@';
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
    ws.pageSetup.printTitlesRow = '1:1';
  };

  const total = (k: 'actions' | 'field_changes' | 'approvals'): number => d.users.reduce((a, u) => a + u[k], 0);
  sheet('Summary', ['Measure', 'Value'], [40, 24], [
    ['Month', d.month],
    ['Period from (UTC)', d.from],
    ['Period to (UTC, exclusive)', d.to],
    ['Scope', d.scope === 'all' ? 'All modules and regions' : 'Limited to your Audit Log scope'],
    ['People with activity', d.users.filter((u) => u.actions > 0 || u.field_changes > 0).length],
    ['Actions', total('actions')],
    ['Field changes', total('field_changes')],
    ['Approvals', total('approvals')],
    ['Modules with activity', d.modules.length],
    ['Exports and downloads', d.exports.length],
    ['Exceptions', d.exceptions.length],
    ['Admin overrides', d.exceptions.filter((e) => e.kind === 'override').length],
    ['Self-approvals', d.exceptions.filter((e) => e.kind === 'self_approval').length],
  ]);
  sheet('User Activity', ['Employee ID', 'Name', 'Actions', 'Field changes', 'Approvals'], [14, 32, 12, 14, 12],
    d.users.map((u) => [u.user.employee_id ?? '', u.user.display_name, u.actions, u.field_changes, u.approvals]));
  sheet('Module Activity', ['Module', 'Actions', 'Approvals', 'People', 'Admin overrides'], [28, 12, 12, 12, 16],
    d.modules.map((m) => [m.module_key || '(none)', m.actions, m.approvals, m.users, m.overrides]));
  sheet('Exports', ['At (UTC)', 'Employee ID', 'Name', 'Action', 'Entity type', 'Entity ID', 'Module', 'Region', 'Rows'], [28, 12, 28, 30, 18, 38, 18, 14, 10],
    d.exports.map((x) => [x.at, emp(x.actor_id), name(x.actor_id), x.action, x.entity_type, x.entity_id ?? '', x.module_key ?? '', region(x.region_id), x.rows]));
  sheet('Exceptions', ['At (UTC)', 'Kind', 'Employee ID', 'Name', 'On behalf of', 'Action', 'Entity type', 'Entity ID', 'Module', 'Region', 'Reason'],
    [28, 14, 12, 28, 24, 30, 18, 38, 18, 14, 48],
    d.exceptions.map((x) => [x.at, x.kind, emp(x.actor_id), name(x.actor_id), name(x.on_behalf_of), x.action, x.entity_type, x.entity_id ?? '', x.module_key ?? '', region(x.region_id), x.reason ?? '']));
  sheet('About', ['Item', 'Value'], [30, 90], [
    ['Report', 'GSDN PMIS monthly activity report'],
    ['Month', d.month],
    ['Period (UTC)', `${d.from} to ${d.to}`],
    ['Calendar month in', d.timeZone],
    ['Regions', d.regions === 'all' ? 'All regions' : d.regions.map((r) => region(r)).join(', ')],
    ['Scope', d.scope === 'all' ? 'Everything (full Audit Log reader)' : 'Only the modules and regions you may read in the Audit Log (decision B4)'],
    ['Filters', `month=${d.month}`],
    ['Generated at (UTC)', d.generatedAt.toISOString()],
    ['Generated by', `${d.generatedBy.display_name}${d.generatedBy.employee_id ? ` (${d.generatedBy.employee_id})` : ''}`],
    ['Source', 'The Audit Log and the field change log. Reads of the logs themselves are not counted.'],
    ['Security log', 'Not included. Whoever holds its rights exports it separately from the security log screen.'],
    ['Limits', `Exports and Exceptions list at most 5000 rows each${d.exportsTruncated || d.exceptionsTruncated ? ' (this month reached the limit: narrow the period in the Audit Log screen for the rest)' : ''}.`],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
