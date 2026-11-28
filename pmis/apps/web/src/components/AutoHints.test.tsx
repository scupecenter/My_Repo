import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AutoHints } from './AutoHints';
import { Tip } from './Tip';

describe('AutoHints', () => {
  it('gives an icon-only control its name as a hover hint, and leaves written titles and Tip controls alone', () => {
    render(<><AutoHints />
      <button aria-label="History" data-testid="a">i</button>
      <button aria-label="Named" title="Own words" data-testid="b">i</button>
      <Tip text="Explains"><button aria-label="Tipped" data-testid="c">i</button></Tip></>);
    fireEvent.pointerOver(screen.getByTestId('a'));
    fireEvent.pointerOver(screen.getByTestId('b'));
    fireEvent.pointerOver(screen.getByTestId('c'));
    expect(screen.getByTestId('a')).toHaveAttribute('title', 'History');
    expect(screen.getByTestId('b')).toHaveAttribute('title', 'Own words');
    expect(screen.getByTestId('c')).not.toHaveAttribute('title');
  });

  it('gives a chip with no hint its full text on hover, and keeps its own title and a Tip', () => {
    render(<><AutoHints />
      <span className="chip" data-testid="a">  In   progress </span>
      <span className="chip" title="Why" data-testid="b">Protected</span>
      <Tip text="Explains"><span className="chip" data-testid="c">Late</span></Tip></>);
    fireEvent.pointerOver(screen.getByTestId('a'));
    fireEvent.pointerOver(screen.getByTestId('b'));
    fireEvent.pointerOver(screen.getByTestId('c'));
    expect(screen.getByTestId('a')).toHaveAttribute('title', 'In progress');
    expect(screen.getByTestId('b')).toHaveAttribute('title', 'Why');
    expect(screen.getByTestId('c')).not.toHaveAttribute('title');
  });
});
