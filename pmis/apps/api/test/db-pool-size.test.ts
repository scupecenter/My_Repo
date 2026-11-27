import { describe, expect, it } from 'vitest';
import { withPoolSize } from '../src/db/db.service';

describe('withPoolSize', () => {
  it('adds connection_limit when the URL names none', () => {
    expect(withPoolSize('postgresql://u:p@h:5433/db', 10)).toContain('connection_limit=10');
  });
  it('keeps an explicit connection_limit of the URL', () => {
    expect(withPoolSize('postgresql://u:p@h/db?connection_limit=4', 10)).toContain('connection_limit=4');
    expect(withPoolSize('postgresql://u:p@h/db?connection_limit=4', 10)).not.toContain('connection_limit=10');
  });
  it('changes nothing when no size is configured (tests) or the URL is unparsable', () => {
    expect(withPoolSize('postgresql://u:p@h/db', undefined)).toBe('postgresql://u:p@h/db');
    expect(withPoolSize('not a url', 10)).toBe('not a url');
  });
});
