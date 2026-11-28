import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/i18n';
import type { DocumentSlot } from '@/api/documents';
import { SlotList } from './DocSlots';

vi.mock('@/api/documents', () => ({
  downloadDocument: vi.fn(), openDocument: vi.fn(), suggestSlots: vi.fn(async () => []), taskTarget: (t: unknown) => t,
  useAddSlot: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSlotUpload: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWithdrawFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/api/library', () => ({
  useLibraryForms: () => ({ data: { items: [{ id: 'tpl1', kind: 'html', doc_code: 'D1', trigger_task_code: 'T9', name_en: 'Form', code: 'F' }] } }),
  useArchiveRows: () => ({ data: { pages: [{ items: [{ slot_id: 's1', generated_id: 'g1', doc_number: 'SSR-2026-0001', status: 'generated' }] }] } }),
  generatedHtml: vi.fn(), downloadGenerated: vi.fn(), printHtml: vi.fn(),
}));
const dialog = vi.fn((_p: { recordId?: string }) => null);
vi.mock('@/pages/library/Forms', () => ({ GenerateDialog: (p: { recordId?: string }) => dialog(p) }));
vi.mock('./Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/api/admin', () => ({ usePicker: () => ({ data: [] }) }));

const slot = { id: 's1', doc_code: 'D1', name_en: 'Doc', name_ar: null, kind: 'file', mandatory: true, conditional: false, status: 'missing', formats: ['pdf'], max_size_mb: 20, max_files: 1, files: [], can_upload: true } as unknown as DocumentSlot;

describe('generated copy inside the task document', () => {
  it('shows the unsigned generated copy beside the slot, keeps the slot status and still takes the signed upload', () => {
    render(<SlotList slots={[slot]} target={{ target: 'task', ref: 'T1' } as never} edit generate={{ siteId: 'site1', siteCode: 'S1', taskCode: 'T9' }} />);
    expect(screen.getByTestId('slot-generated-s1')).toHaveTextContent('Generated copy (unsigned)');
    expect(screen.getByTestId('slot-generated-s1')).toHaveTextContent('SSR-2026-0001');
    expect(screen.getByTestId('slot-s1')).toHaveAttribute('data-status', 'missing');
    expect(screen.getByTestId('slot-input-s1')).toBeInTheDocument();
    expect(screen.getByTestId('slot-generate-s1')).toBeInTheDocument();
  });
  it('a record slot: Generate takes the record id, any approved form of the document type, and the slot status stays', async () => {
    render(<SlotList slots={[slot]} target={{ target: 'record', ref: 'R1' } as never} edit={false} generate={{ siteId: 'site1', siteCode: 'S1', taskCode: '', recordId: 'rec1' }} />);
    expect(screen.getByTestId('slot-s1')).toHaveAttribute('data-status', 'missing');
    await userEvent.setup().click(screen.getByTestId('slot-generate-s1'));
    expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ recordId: 'rec1' }));
  });
});
