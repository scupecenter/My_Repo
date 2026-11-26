import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n';
import { EvidenceDot } from './EvidenceDot';

const d = (state: 'green' | 'yellow' | 'red', o = {}) => ({ state, need: 3, approved: 1, pending: 1, missing: 1, rejected: 0, expired: 0, ...o });

describe('EvidenceDot', () => {
  it('draws nothing when no document is required', () => {
    const { container } = render(<EvidenceDot docs={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('draws one tiny dot per state with its words in the tooltip, in the line of the text', () => {
    for (const s of ['red', 'yellow', 'green'] as const) {
      const { unmount } = render(<EvidenceDot docs={d(s)} testid={`dot-${s}`} />);
      const dot = screen.getByTestId(`dot-${s}`);
      expect(dot).toHaveAttribute('data-state', s);
      expect(dot.getAttribute('title')).toMatch(/\d/);
      expect(dot.className).toContain('inline-block');
      expect(dot.className).toContain('h-1.5');
      unmount();
    }
  });
});
