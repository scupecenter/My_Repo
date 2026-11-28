import { describe, expect, it } from 'vitest';
import { isKnownPath, unknownPlaceholders } from './templateContext';

describe('template placeholders', () => {
  it('knows the paths the server fills, region flags, raw values and bound fields', () => {
    expect(isKnownPath('site.name', [])).toBe(true);
    expect(isKnownPath('doc.ref_no', [])).toBe(true);
    expect(isKnownPath('site.region_is.Tripoli', [])).toBe(true);
    expect(isKnownPath('doc.qr_svg_uri', [])).toBe(true);
    expect(isKnownPath('fields.owner', ['owner'])).toBe(true);
    expect(isKnownPath('contractor.name', [])).toBe(true);
    expect(isKnownPath('pac.dlp_expiry', [])).toBe(true);
    expect(isKnownPath('site.schedule_is.ahead', [])).toBe(true);
    expect(isKnownPath('signatories.cw_team_lead.name', [])).toBe(true);
  });
  it('flags a typo, an unbound field and an unknown group', () => {
    expect(isKnownPath('site.nmae', [])).toBe(false);
    expect(isKnownPath('fields.owner', [])).toBe(false);
    expect(isKnownPath('invoice.total', [])).toBe(false);
  });
  it('lists only the unknown placeholders of a template', () => {
    expect(unknownPlaceholders(['site.name', 'site.nmae', 'fields.owner', '#if site.name', 'this', 'boq'], { owner: 'site.tower_owner' })).toEqual(['site.nmae']);
    expect(unknownPlaceholders(undefined, undefined)).toEqual([]);
  });
});
