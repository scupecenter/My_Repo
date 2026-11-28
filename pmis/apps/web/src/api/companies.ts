import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadFile, type ApiError } from './client';
import type { components } from './schema';

/** Companies K3 (contract 0.15.625, migration 0745): company contacts, documents with expiry, compliance, and the document types of Settings. */
export type CompanyContact = components['schemas']['CompanyContact'];
export type CompanyContactInput = components['schemas']['CompanyContactInput'];
export type CompanyDocument = components['schemas']['CompanyDocument'];
export type CompanyCompliance = components['schemas']['CompanyCompliance'];
export type CompanyDocumentType = components['schemas']['CompanyDocumentType'];
export type CompanyDocumentTypes = components['schemas']['CompanyDocumentTypes'];

const inv = (qc: ReturnType<typeof useQueryClient>, party: string) => {
  void qc.invalidateQueries({ queryKey: ['company', party] });
  void qc.invalidateQueries({ queryKey: ['company-compliance'] });
};

export const useCompanyContacts = (party: string) => useQuery({ queryKey: ['company', party, 'contacts'], queryFn: () => api.get<{ items: CompanyContact[] }>(`/companies/${party}/contacts`).then((r) => r.items) });
export const useSaveCompanyContact = (party: string) => {
  const qc = useQueryClient();
  return useMutation<CompanyContact, ApiError, { id?: string; version?: number; body: CompanyContactInput }>({
    mutationFn: ({ id, version, body }) => (id ? api.patch<CompanyContact>(`/companies/${party}/contacts/${id}`, { body, version }) : api.post<CompanyContact>(`/companies/${party}/contacts`, { body })),
    onSettled: () => inv(qc, party),
  });
};

export const useCompanyDocuments = (party: string) => useQuery({ queryKey: ['company', party, 'documents'], queryFn: () => api.get<{ items: CompanyDocument[] }>(`/companies/${party}/documents`).then((r) => r.items) });
/** The fields go as multipart so a file can ride along; an empty value clears the field. */
export const useSaveCompanyDocument = (party: string) => {
  const qc = useQueryClient();
  return useMutation<CompanyDocument, ApiError, { id?: string; version?: number; fields: Record<string, string | boolean | null | undefined>; file?: File | null }>({
    mutationFn: ({ id, version, fields, file }) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v === null ? '' : String(v));
      if (file) fd.append('file', file);
      return id ? api.patch<CompanyDocument>(`/companies/${party}/documents/${id}`, { body: fd, version }) : api.post<CompanyDocument>(`/companies/${party}/documents`, { body: fd });
    },
    onSettled: () => inv(qc, party),
  });
};
export const downloadCompanyDocument = (party: string, id: string) => downloadFile(`/companies/${party}/documents/${id}/file`);

export const useCompanyCompliance = (party: string) => useQuery({ queryKey: ['company-compliance', party], queryFn: () => api.get<CompanyCompliance>(`/companies/${party}/compliance`) });
export const useAllCompanyCompliance = (enabled = true) => useQuery({ queryKey: ['company-compliance', 'all'], enabled, queryFn: () => api.get<{ items: CompanyCompliance[] }>('/companies/compliance').then((r) => r.items) });

export const useCompanyDocumentTypes = () => useQuery({ queryKey: ['company-document-types'], queryFn: () => api.get<CompanyDocumentTypes>('/settings/company-document-types') });
export const useSaveCompanyDocumentTypes = () => {
  const qc = useQueryClient();
  return useMutation<CompanyDocumentTypes, ApiError, { version: number; body: { reason: string; types: Partial<CompanyDocumentType>[] } }>({
    mutationFn: ({ version, body }) => api.put('/settings/company-document-types', { body, version }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['company-document-types'] }); void qc.invalidateQueries({ queryKey: ['company-compliance'] }); },
  });
};
