import { render, screen } from '@testing-library/react';
import { MissingArabicHint } from '@/components/MissingArabicHint';
import '@/i18n';

describe('MissingArabicHint (Settings gap 2)', () => {
  it('warns when the Arabic name is empty and the English one is filled', () => {
    render(<MissingArabicHint en="Survey" ar="" testid="w" />);
    expect(screen.getByTestId('w')).toBeInTheDocument();
  });
  it('is silent when Arabic is filled or the English name is empty', () => {
    const { rerender } = render(<MissingArabicHint en="Survey" ar="مسح" testid="w" />);
    expect(screen.queryByTestId('w')).not.toBeInTheDocument();
    rerender(<MissingArabicHint en=" " ar="" testid="w" />);
    expect(screen.queryByTestId('w')).not.toBeInTheDocument();
  });
});
