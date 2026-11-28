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

/** Companies K4 (contract 0.15.626, migration 0746): the onboarding checklist, the bulk status change, and the import of the three company templates. */
export type CompanyOnboardingStatus = components['schemas']['CompanyOnboardingStatus'];
export type CompanyOnboardingItem = components['schemas']['CompanyOnboardingItem'];
export type CompanyOnboardingItems = components['schemas']['CompanyOnboardingItems'];
export type CompanyOnboardingProgress = components['schemas']['CompanyOnboardingProgress'];
export type CompanyImportResult = components['schemas']['CompanyImportResult'];
export type OnboardingState = CompanyOnboardingStatus['status'];
export const COMPANY_TEMPLATES = [
  { id: 'TPL-COMPANY-CONTACTS', key: 'contacts' },
  { id: 'TPL-COMPANY-DOCUMENTS', key: 'documents' },
  { id: 'TPL-COMPANY-ONBOARDING', key: 'onboarding' },
] as const;

const invOnb = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['company'] });
  void qc.invalidateQueries({ queryKey: ['company-onboarding'] });
};

export const useCompanyOnboarding = (party: string) => useQuery({ queryKey: ['company', party, 'onboarding'], queryFn: () => api.get<{ items: CompanyOnboardingStatus[] }>(`/companies/${party}/onboarding`).then((r) => r.items) });
export const useAllCompanyOnboarding = (enabled = true) => useQuery({ queryKey: ['company-onboarding', 'all'], enabled, queryFn: () => api.get<{ items: CompanyOnboardingProgress[] }>('/companies/onboarding').then((r) => r.items) });
export const useSetCompanyOnboarding = (party: string) => {
  const qc = useQueryClient();
  return useMutation<{ changed: boolean }, ApiError, { item: string; status: OnboardingState; note?: string | null }>({
    mutationFn: ({ item, ...body }) => api.put(`/companies/${party}/onboarding/${item}`, { body }),
    onSettled: () => invOnb(qc),
  });
};
export const useBulkCompanyOnboarding = () => {
  const qc = useQueryClient();
  return useMutation<{ companies: number; changed: number; unchanged: number }, ApiError, { party_ids: string[]; item: string; status: OnboardingState }>({
    mutationFn: (body) => api.post('/companies/onboarding-bulk', { idempotencyKey: crypto.randomUUID(), body }),
    onSettled: () => invOnb(qc),
  });
};
export const useImportCompanyTemplate = () => {
  const qc = useQueryClient();
  return useMutation<CompanyImportResult, ApiError, { file: File }>({
    mutationFn: ({ file }) => { const fd = new FormData(); fd.append('file', file); return api.post('/companies/import', { idempotencyKey: crypto.randomUUID(), body: fd }); },
    onSettled: () => { invOnb(qc); void qc.invalidateQueries({ queryKey: ['company-compliance'] }); },
  });
};
/** The company template, blank, or filled with the companies picked (the export of the list's bulk bar). */
export const downloadCompanyTemplate = (templateId: string, parties?: string[]) =>
  downloadFile(`/templates/${templateId}/download`, parties && parties.length ? { party_ids: parties.join(',') } : { prefill: 'true' });
export const downloadBlankCompanyTemplate = (templateId: string) => downloadFile(`/templates/${templateId}/download`);

export const useCompanyOnboardingItems = () => useQuery({ queryKey: ['company-onboarding-items'], queryFn: () => api.get<CompanyOnboardingItems>('/settings/company-onboarding-items') });
export const useSaveCompanyOnboardingItems = () => {
  const qc = useQueryClient();
  return useMutation<CompanyOnboardingItems, ApiError, { version: number; body: { reason: string; items: Partial<CompanyOnboardingItem>[] } }>({
    mutationFn: ({ version, body }) => api.put('/settings/company-onboarding-items', { body, version }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['company-onboarding-items'] }); invOnb(qc); },
  });
};
