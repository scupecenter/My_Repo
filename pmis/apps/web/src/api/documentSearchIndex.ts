import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { components } from './schema';

export type DocumentSearchIndex = components['schemas']['DocumentSearchIndex'];

/** 0.15.104: counts of the files whose text is searchable (System Admin only). */
export const useDocumentSearchIndex = () => useQuery({ queryKey: ['documentSearchIndex'], queryFn: () => api.get<DocumentSearchIndex>('/admin/document-search-index') });
