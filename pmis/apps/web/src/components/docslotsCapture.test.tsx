import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import type { DocumentSlot } from '@/api/documents';
import { SlotList } from './DocSlots';
import { MentionBox } from './Comments';

const upload = vi.fn(async () => ({}));
vi.mock('@/api/documents', () => ({
  downloadDocument: vi.fn(),
  suggestSlots: vi.fn(async () => []),
  taskTarget: (t: unknown) => t,
  useAddSlot: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSlotUpload: () => ({ mutateAsync: upload, isPending: false }),
  useWithdrawFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/api/admin', () => ({ usePicker: () => ({ data: [] }) }));

afterEach(() => { vi.unstubAllGlobals(); upload.mockClear(); });

let n = 0;
const slot = (formats: string[] | null): DocumentSlot => {
  n += 1;
  return {
    id: `s${n}`, doc_code: `D${n}`, name_en: `Doc ${n}`, name_ar: null, kind: 'photo', mandatory: false, conditional: false,
    status: 'missing', formats, max_size_mb: 20, max_files: null, files: [], can_upload: true,
  } as unknown as DocumentSlot;
};

const list = (s: DocumentSlot) => render(<SlotList slots={[s]} target={{ target: 'task', ref: 'T1' } as never} edit />);

describe('field capture on document slots (item 14 widened)', () => {
  it('offers annotate and video on an unrestricted slot', () => {
    const s = slot(null);
    list(s);
    expect(screen.getByTestId(`slot-annotate-open-${s.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`slot-video-${s.id}`)).toBeInTheDocument();
  });
  it('offers annotate but no video on an image-only slot', () => {
    const s = slot(['jpg', 'png']);
    list(s);
    expect(screen.getByTestId(`slot-annotate-open-${s.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`slot-video-${s.id}`)).not.toBeInTheDocument();
  });
  it('offers video but no annotate on a video-only slot (the annotated copy is a PNG)', () => {
    const s = slot(['webm']);
    list(s);
    expect(screen.getByTestId(`slot-video-${s.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`slot-annotate-open-${s.id}`)).not.toBeInTheDocument();
  });
  it('offers neither on a document-only slot nor on a read-only one', () => {
    const s = slot(['pdf', 'docx']);
    const { unmount } = list(s);
    expect(screen.queryByTestId(`slot-annotate-open-${s.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`slot-video-${s.id}`)).not.toBeInTheDocument();
    unmount();
    render(<SlotList slots={[s]} target={{ target: 'task', ref: 'T1' } as never} edit={false} />);
    expect(screen.queryByTestId(`slot-annotate-open-${s.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`slot-video-${s.id}`)).not.toBeInTheDocument();
  });
  it('annotates a picked photo and uploads the marked copy', async () => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const s = slot(['png', 'jpg']);
    list(s);
    const u = userEvent.setup();
    const input = screen.getByTestId(`slot-annotate-input-${s.id}`) as HTMLInputElement;
    const img = new File([new Uint8Array([1, 2, 3])], 'wall.jpg', { type: 'image/jpeg' });
    await u.upload(input, img);
    expect(screen.getByTestId(`slot-annotate-${s.id}`)).toBeInTheDocument();
    await u.click(screen.getByTestId(`slot-annotate-${s.id}-asis`));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(`slot-annotate-${s.id}`)).not.toBeInTheDocument();
  });
});

describe('voice capture on the comment box (item 14 widened)', () => {
  it('dictates into the comment text where the browser has speech recognition', async () => {
    let onresult: ((e: unknown) => void) | undefined;
    class SR {
      lang = ''; interimResults = false; continuous = false; onend = null; onerror = null;
      set onresult(cb: (e: unknown) => void) { onresult = cb; }
      start = vi.fn(); stop = vi.fn();
    }
    vi.stubGlobal('SpeechRecognition', SR);
    const u = userEvent.setup();
    render(<MentionBox onSend={() => undefined} pending={false} label="Comment" />);
    await u.click(screen.getByTestId('comment-dictate'));
    act(() => onresult?.({ results: [[{ transcript: 'needs rebar check', isFinal: true }]] }));
    expect(screen.getByTestId('comment-input')).toHaveValue('needs rebar check');
  });
});
