import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { AnnotatePhoto } from './AnnotatePhoto';
import { DictateButton } from './DictateButton';
import { RecordVideo } from './RecordVideo';

afterEach(() => vi.unstubAllGlobals());

describe('DictateButton', () => {
  it('renders nothing where the browser has no speech recognition', () => {
    const { container } = render(<DictateButton testid="dict" onText={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('starts the engine on click and passes what it hears on', async () => {
    const start = vi.fn(), stop = vi.fn();
    let onresult: ((e: unknown) => void) | undefined;
    class SR {
      lang = ''; interimResults = false; continuous = false; onend = null; onerror = null;
      set onresult(cb: (e: unknown) => void) { onresult = cb; }
      start = start; stop = stop;
    }
    vi.stubGlobal('SpeechRecognition', SR);
    const heard: string[] = [];
    const u = userEvent.setup();
    render(<DictateButton testid="dict" onText={(t) => heard.push(t)} />);
    const btn = screen.getByTestId('dict');
    await u.click(btn);
    expect(start).toHaveBeenCalled();
    expect(btn).toHaveAttribute('data-listening');
    onresult?.({ results: [[{ transcript: 'crack on column', isFinal: true }]] });
    expect(heard).toEqual(['crack on column']);
    await u.click(btn);
    expect(stop).toHaveBeenCalled();
  });
});

describe('AnnotatePhoto', () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
  it('offers arrows and circles and can hand the photo on untouched', async () => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const u = userEvent.setup();
    const used: File[] = [];
    const cancel = vi.fn();
    render(<AnnotatePhoto file={file()} testid="ann" onUse={(f) => used.push(f)} onCancel={cancel} />);
    expect(screen.getByTestId('ann-arrow')).toBeInTheDocument();
    expect(screen.getByTestId('ann-circle')).toBeInTheDocument();
    expect(screen.getByTestId('ann-undo')).toBeDisabled();
    await u.click(screen.getByTestId('ann-asis'));
    expect(used).toHaveLength(1);
    expect(used[0]!.name).toBe('photo.jpg');
    await u.click(screen.getByTestId('ann-cancel'));
    expect(cancel).toHaveBeenCalled();
  });
});

describe('RecordVideo', () => {
  it('stays hidden while the snag type lists no video format', () => {
    const { container } = render(<RecordVideo formats={['JPG', 'PNG', 'HEIC']} testid="vid" onFile={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('appears once a video format is allowed and explains instead of failing where recording is impossible', async () => {
    const u = userEvent.setup();
    render(<RecordVideo formats={['JPG', 'WEBM']} testid="vid" onFile={() => undefined} />);
    const btn = screen.getByTestId('vid');
    await u.click(btn);
    expect(screen.getByTestId('vid-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('vid-error')).toBeInTheDocument();
    await u.click(screen.getByTestId('vid-cancel'));
    expect(screen.queryByTestId('vid-dialog')).not.toBeInTheDocument();
  });
});
