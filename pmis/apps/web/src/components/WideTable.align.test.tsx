import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The header rows follow the Text alignment option (owner request 2026-11-26): the stylesheet must reach plain th headers of a table inside a [data-talign=center] container. */
describe('header alignment rule', () => {
  const css = readFileSync(`${process.cwd()}/src/styles/index.css`, 'utf8');
  it('centres th headers (band, group, column rows) under data-talign=center and keeps the # and Site ID columns', () => {
    expect(css).toMatch(/\[data-talign='center'\] table th:not\(\[data-col='rowno'\]\)[^{]*\{text-align:center\}/);
    expect(css).toContain("[data-testid='wide-col-site']");
  });
});
