import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';
import type { RegisterRecord } from './types';

/**
 * Work package P4c (contract 0.12.11, migration 0063): the HLC purchase requests of an HLC record (Q150), the Dismantle order picker (Q114), the one-time
 * migration of the legacy HLC requests (Q139) and the GECOL order warnings (Q151).
 */
type S = components['schemas'];
export type HlcPurchaseRequests = S['HlcPurchaseRequests'];
export type HlcLegacyMigration = S['HlcLegacyMigration'];
export type DismantleOrderOption = S['DismantleOrderOption'];
export type GecolOrderWarnings = S['GecolOrderWarnings'];
export type GecolOrderWarningsInput = S['GecolOrderWarningsInput'];
export type DeriveRules = S['DeriveRules'];
export type DeriveRule = S['DeriveRule'];

/** PUT /registers/hlc/records/{id}/purchase-requests (If-Match = record version). */
export function useSetHlcPurchaseRequests() {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; ids: string[] }>({
    mutationFn: ({ record, ids }) => api.put(`/registers/hlc/records/${record.id}/purchase-requests`, { version: record.version, body: { procurement_entity_ids: ids } }),
    onSuccess: (r) => qc.setQueryData(['register-record', 'hlc', r.id], r),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['register-records', 'hlc'] }),
  });
}

/** GET /registers/dismantle/order-options: the approved, active orders of the site for the part. */
export const useDismantleOrders = (siteId: string | null | undefined, part: string | null | undefined) =>
  useQuery({
    queryKey: ['dismantle-orders', siteId, part], enabled: !!siteId && (part === 'cw' || part === 'te'),
    queryFn: () => api.get<{ items: DismantleOrderOption[] }>('/registers/dismantle/order-options', { query: { site_id: siteId!, record_type: part! } }).then((r) => r.items),
  });

/** GET /registers/dismantle/rn-options: the received Warehouse RNs of the part on the site (0321). */
export const useDismantleRns = (siteId: string | null | undefined, part: string | null | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['dismantle-rns', siteId, part], enabled: enabled && !!siteId && (part === 'cw' || part === 'te'),
    queryFn: () => api.get<{ items: S['DismantleRnOption'][] }>('/registers/dismantle/rn-options', { query: { site_id: siteId!, record_type: part! } }).then((r) => r.items),
  });

/** GET /registers/warehouse/order-options: the approved, active orders a PL / OPEN receipt may name (of the site when it has one). */
export const useWarehouseOrders = (siteId: string | null | undefined, enabled: boolean, key: 'warehouse' | 'car_dispatcher' | 'financial_advances' | 'issues' | 'quality' | 'change_control' | 'invoices' = 'warehouse') =>
  useQuery({
    queryKey: ['warehouse-orders', key, siteId ?? null], enabled,
    queryFn: () => api.get<{ items: S['WarehouseOrderOption'][] }>(`/registers/${key}/order-options`, { query: siteId ? { site_id: siteId } : {} }).then((r) => r.items),
  });

/** GET /registers/financial_advances/advance-options: the advances an expense or settlement may name (D58). */
export const useAdvanceOptions = (siteId: string | null | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['advance-options', siteId ?? null], enabled,
    queryFn: () => api.get<{ items: { entity_id: string; advance_state?: string; advance_kind?: string; disbursed_date?: string; po_wo_no?: string; pr_no?: string }[] }>('/registers/financial_advances/advance-options', { query: siteId ? { site_id: siteId } : {} }).then((r) => r.items),
  });

/** GET /registers/invoices/supplier-options: the companies an invoice may name as its supplier (D58). */
export const useInvoiceSuppliers = (enabled: boolean) =>
  useQuery({
    queryKey: ['invoice-suppliers'], enabled,
    queryFn: () => api.get<{ items: { id: string; name: string; type?: string }[] }>('/registers/invoices/supplier-options').then((r) => r.items),
  });

/** GET /registers/issues/risk-options: the risks an Issue may name as realised (0322). */
export const useIssueRisks = (enabled: boolean) =>
  useQuery({
    queryKey: ['issue-risks'], enabled,
    queryFn: () => api.get<{ items: S['IssueRiskOption'][] }>('/registers/issues/risk-options').then((r) => r.items),
  });

/** GET /registers/risks/{entity_id}/issues: the issues that realise a risk (0322). */
export const useRiskIssues = (entityId: string | null | undefined) =>
  useQuery({
    queryKey: ['risk-issues', entityId], enabled: !!entityId,
    queryFn: () => api.get<{ items: S['RiskRealisedIssue'][] }>(`/registers/risks/${entityId}/issues`).then((r) => r.items),
  });

/** GET /registers/procurement/{entity_id}/receipts: the warehouse receipts against an order. */
export const useOrderReceipts = (entityId: string | null | undefined) =>
  useQuery({
    queryKey: ['order-receipts', entityId], enabled: !!entityId,
    queryFn: () => api.get<{ items: S['ProcurementOrderReceipt'][] }>(`/registers/procurement/${entityId}/receipts`).then((r) => r.items),
  });

/** GET /registers/{key}/{entity_id}/related: the records linked to this record, both directions (0324). */
export const useRelatedRecords = (key: string | null | undefined, entityId: string | null | undefined) =>
  useQuery({
    queryKey: ['related-records', key, entityId], enabled: !!key && !!entityId,
    queryFn: () => api.get<{ groups: S['RelatedRecordGroup'][] }>(`/registers/${key}/${entityId}/related`).then((r) => r.groups),
  });

/** POST /registers/hlc/legacy-migration: the preview (dry_run) or the run (reason; the server asks for a step-up). */
export function useHlcLegacyMigration() {
  const qc = useQueryClient();
  return useMutation<HlcLegacyMigration, ApiError, { dry_run: boolean; reason?: string }>({
    mutationFn: (body) => api.post('/registers/hlc/legacy-migration', { body }),
    onSettled: (_d, _e, v) => { if (!v.dry_run) void qc.invalidateQueries({ queryKey: ['register-records', 'procurement'] }); },
  });
}

export const useGecolOrderWarnings = () => useQuery({ queryKey: ['gecolOrderWarnings'], queryFn: () => api.get<GecolOrderWarnings>('/settings/gecol-order-warnings') });
export function useSetGecolOrderWarnings() {
  const qc = useQueryClient();
  return useMutation<GecolOrderWarnings, ApiError, { version: number; body: GecolOrderWarningsInput & { reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/settings/gecol-order-warnings', { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['gecolOrderWarnings'] }),
  });
}

/** 0.15.260: the cross-register derive rules (Settings, Registers). */
export const useDeriveRules = () => useQuery({ queryKey: ['deriveRules'], queryFn: () => api.get<DeriveRules>('/settings/derive-rules') });
export function useSetDeriveRules() {
  const qc = useQueryClient();
  return useMutation<DeriveRules, ApiError, { version: number; body: { rules: DeriveRule[]; reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/settings/derive-rules', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['deriveRules'] }); void qc.invalidateQueries({ queryKey: ['register-records'] }); },
  });
}

/** D60: the declared links of a register (GET /registers/{key}/links): the fields that name a record of another register. */
export type RegisterLink = { field: string; target_register: string; target_record_type?: string | null; same_site: boolean; enforce: boolean };
export const useRegisterLinks = (key: string) =>
  useQuery({ queryKey: ['register-links', key], staleTime: 5 * 60_000, queryFn: () => api.get<{ items: RegisterLink[] }>(`/registers/${key}/links`).then((r) => r.items) });

/** D60: the generic picker of one declared link field (GET /registers/{key}/link-options/{field}). */
export const useRegisterLinkOptions = (key: string, field: string, siteId: string | null | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['register-link-options', key, field, siteId ?? null], enabled,
    queryFn: () => api.get<{ items: { entity_id: string; label: string; site_id?: string; record_type?: string }[] }>(`/registers/${key}/link-options/${field}`, { query: siteId ? { site_id: siteId } : {} }).then((r) => r.items),
  });

/** D60 phase 3: GET /registers/site-linked/{site_id}: the records of a site per register with the records they point to. */
export type SiteLinkedItem = { entity_id: string; record_id?: string; record_type?: string; state?: string; title?: string; links: { field: string; target_register: string; entity_id: string; label: string }[] };
export type SiteLinkedRegister = { register_key: string; name_en: string; name_ar?: string | null; count: number; linked: boolean; items: SiteLinkedItem[] };
export const useSiteLinked = (siteId: string, enabled = true) =>
  useQuery({ queryKey: ['site-linked', siteId], enabled, queryFn: () => api.get<{ items: SiteLinkedRegister[] }>(`/registers/site-linked/${siteId}`).then((r) => r.items) });
