import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/i18n';
import type { DocumentSlot } from '@/api/documents';
import { SlotList } from './DocSlots';

const upload = vi.fn(async () => ({}));
const open = vi.fn(async () => 'x.pdf');
vi.mock('@/api/documents', () => ({
  downloadDocument: vi.fn(),
  openDocument: (...a: unknown[]) => open(...(a as [])),
  suggestSlots: vi.fn(async () => []),
  taskTarget: (t: unknown) => t,
  useAddSlot: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSlotUpload: () => ({ mutateAsync: upload, isPending: false }),
  useWithdrawFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/api/admin', () => ({ usePicker: () => ({ data: [] }) }));

const slot = (canUpload: boolean): DocumentSlot => ({
  id: 's1', doc_code: 'D1', name_en: 'Doc', name_ar: null, kind: 'file', mandatory: true, conditional: false, status: canUpload ? 'uploaded' : 'approved',
  formats: ['pdf'], max_size_mb: 20, max_files: 3, can_upload: canUpload,
  files: [{ id: 'f1', file_group_id: 'g1', version: 1, is_current: true, original_name: 'a.pdf', download_name: 'a.pdf', size_bytes: 2048, mime_type: 'application/pdf' }],
} as unknown as DocumentSlot);

describe('open and replace on a stored document', () => {
  it('Open shows the file; Replace uploads the next version of that file', async () => {
    render(<SlotList slots={[slot(true)]} target={{ target: 'task', ref: 'T1' } as never} edit />);
    await userEvent.click(screen.getByTestId('file-open-f1'));
    expect(open).toHaveBeenCalledWith('f1', 'application/pdf');
    const f = new File(['x'], 'b.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByTestId('file-replace-input-f1'), f);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ replaceGroup: 'g1' }));
  });
  it('an approved slot still opens but offers no replace (the workflow keeps it)', () => {
    render(<SlotList slots={[slot(false)]} target={{ target: 'task', ref: 'T1' } as never} edit />);
    expect(screen.getByTestId('file-open-f1')).toBeInTheDocument();
    expect(screen.queryByTestId('file-replace-f1')).toBeNull();
  });
});
