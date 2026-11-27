import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every route that hands data out as a file carries @ExportAction(), so the lock key disable_export cannot be bypassed by a route nobody remembered (migration 0290). */
const SRC = join(__dirname, '..', 'src');
const ROUTES: [file: string, route: string][] = [
  ['exports/exports.controller.ts', "@Post('master')"],
  ['exports/exports.controller.ts', "@Get('master/:id/download')"],
  ['documents/documents.controller.ts', "@Post('exports/zip')"],
  ['documents/documents.controller.ts', "@Get('exports/zip/:id/download')"],
  ['library/library.controller.ts', "@Post('library/archive/zip')"],
  ['master-import/master-import.controller.ts', "@Get('runs/:id/export')"],
  ['announcements/announcements.controller.ts', "@Get(':id/responses/export')"],
  ['workflow/tasks.controller.ts', "@Get('me/tasks.ics')"],
  ['dashboard/dashboard.controller.ts', "@Get('dashboard/export')"],
  ['daily-plan/daily-plan.controller.ts', "@Get('export')"],
  ['logs/logs.controller.ts', "@Post('exports')"],
  ['logs/logs.controller.ts', "@Get('exports/:id/download')"],
  ['logs/logs.controller.ts', "@Get('reports/activity')"],
];

/** S1b (migration 0293): the downloads that are not exports of data carry a category, gated by their own switch (off by default). */
const CATEGORY_ROUTES: [file: string, route: string, category: string][] = [
  ['templates/templates.controller.ts', "@Get(':templateId/download')", 'templates'],
  ['documents/documents.controller.ts', "@Get('files/:id/download')", 'uploaded_files'],
  ['library/library.controller.ts', "@Get('library/generated/:id/download')", 'generated_documents'],
  ['master-import/master-import.controller.ts', "@Get('runs/:id/file')", 'uploaded_files'],
];

describe('download category routes carry @ExportAction({ category })', () => {
  for (const [file, route, category] of CATEGORY_ROUTES) {
    it(`${file} ${route} is ${category}`, () => {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      const i = lines.findIndex((l) => l.trim() === route);
      expect(i).toBeGreaterThan(0);
      expect(lines[i - 1]).toContain(`@ExportAction({ category: '${category}'`);
    });
  }
});

describe('export routes carry @ExportAction()', () => {
  for (const [file, route] of ROUTES) {
    it(`${file} ${route}`, () => {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trim() === route);
      expect(hits.length).toBeGreaterThan(0);
      for (const [, i] of hits) expect(lines[i - 1]).toMatch(/^\s*@ExportAction\(/);
    });
  }
  it('no controller sets a file attachment without being listed here (add the route above, or explain why it is not an export)', () => {
    // Allowed without the lock: blank templates, uploaded documents and generated forms (not exports of data), and the master-import uploaded file.
    const NOT_EXPORTS = new Set(['templates/templates.controller.ts', 'library/library.controller.ts', 'master-import/master-import.controller.ts', 'documents/documents.controller.ts']);
    const listed = new Set(ROUTES.map(([f]) => f));
    const files = ['exports/exports.controller.ts', 'logs/logs.controller.ts', 'announcements/announcements.controller.ts', 'workflow/tasks.controller.ts', 'dashboard/dashboard.controller.ts', 'daily-plan/daily-plan.controller.ts',
      'templates/templates.controller.ts', 'library/library.controller.ts', 'master-import/master-import.controller.ts', 'documents/documents.controller.ts'];
    for (const f of files) {
      const s = readFileSync(join(SRC, f), 'utf8');
      if (/Content-Disposition|attachmentHeader|StreamableFile/.test(s)) expect(listed.has(f) || NOT_EXPORTS.has(f), f).toBe(true);
    }
  });
});
