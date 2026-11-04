import type { AsBuiltItem, SiteDispatch, StockLevel, StockMovement, WarehouseConfigGaps, WarehouseItem } from '@/api/types';
import { siteMeta } from './sites';

/** Mock Warehouse (item master, DN/RN movements, stock) and As-Built items, in the shapes of contract 0.4.8, 0.12.1 (P7: quarantine, code source, need
 * status, numbering lock, TE dispatch, missing configuration) and 0.13.1 (Q270: quarantine exits, pending quarantine; synthetic data). */
const id = (p: string, n: number) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, code: string, name_en: string, name_ar: string, uom: string, category: string | null, serial_tracked: boolean): WarehouseItem =>
  ({ id: id('b', n), code, name_en, name_ar, uom, category, serial_tracked, is_active: true, version: 1, as_built_item_code: null, code_source: 'master', need_rules: [] });
const asb = (n: number, code: string, section: 'cw' | 'te', name_en: string, name_ar: string, unit: string, warehouse_item_code: string | null): AsBuiltItem =>
  ({ id: id('d', n), code, section, name_en, name_ar, unit, warehouse_item_code, sort_order: n, field_code: `q_${code.toLowerCase()}`, is_active: true, version: 1 });
const mv = (n: number, doc_no: string, record_type: StockMovement['record_type'], kind: StockMovement['kind'], status: StockMovement['status'], site_code: string, itemN: number, code: string, qty: number): StockMovement => ({
  id: id('c', n), doc_no, record_type, kind, status, site_id: null, site_code, register_record_id: id('e', n), reserved: status === 'pending' && kind === 'issue', version: 1,
  doc_no_locked: status === 'posted', sequence_key: null, doc_date: '2026-10-20',
  lines: [{ item_id: id('b', itemN), item_code: code, qty }], created_by: { id: id('1', 1), display_name: 'Ahmed Salem' }, created_at: '2026-10-20T08:00:00Z', posted_at: status === 'posted' ? '2026-10-21T08:00:00Z' : null,
});

export function initWarehouse() {
  const items = [
    item(1, 'ANT-900', 'Panel antenna 900 MHz', 'هوائي لوحي 900 ميغاهرتز', 'pcs', 'Antennas', true),
    item(2, 'CBL-FEED', 'Feeder cable 7/8"', 'كابل تغذية 7/8 بوصة', 'm', 'Cables', false),
    item(3, 'RRU-3', 'Remote radio unit', 'وحدة راديو بعيدة', 'pcs', null, true),
  ];
  items[0]!.need_rules = [{ need_unit: 'Cambium Sector', quantity: 1, status: 'pending_configuration', quantity_rule: { per: 'rf_sector', wl_vendor: 'Cambium' }, applies_when: { scope: ['te_full'] } }];
  items[2]!.need_rules = [{ need_unit: 'Router', quantity: 1, status: 'confirmed', quantity_rule: { per: 'te_site', group: 'ROUTER' }, applies_when: { scope: ['te_full', 'router_only'] } }];
  items[1]!.code_source = 'internal_provisional';
  const stock: StockLevel[] = [
    { item_id: items[0]!.id, item_code: 'ANT-900', item_name: items[0]!.name_en, uom: 'pcs', site_id: null, on_hand: 40, reserved: 6, pending_issue: 6, pending_return: 0, available: 34, quarantine: 2, quarantine_pending: 0 },
    { item_id: items[1]!.id, item_code: 'CBL-FEED', item_name: items[1]!.name_en, uom: 'm', site_id: null, on_hand: 1200, reserved: 0, pending_issue: 0, pending_return: 100, available: 1200, quarantine: 0, quarantine_pending: 0 },
    { item_id: items[2]!.id, item_code: 'RRU-3', item_name: items[2]!.name_en, uom: 'pcs', site_id: null, on_hand: 3, reserved: 0, pending_issue: 0, pending_return: 0, available: 3, quarantine: 0, quarantine_pending: 0 },
  ];
  const movements = [
    mv(1, 'DN-2026-0101', 'te_dn', 'issue', 'pending', 'TR101', 1, 'ANT-900', 6),
    mv(2, 'DN-2026-0099', 'cw_dn', 'issue', 'posted', 'TR101', 2, 'CBL-FEED', 300),
    mv(3, 'RN-2026-0007', 'te_rn', 'return', 'pending', 'TR101', 2, 'CBL-FEED', 100),
    mv(4, 'PL-2026-0003', 'pl', 'receipt', 'posted', '', 1, 'ANT-900', 40),
  ].map((m) => (m.record_type === 'pl' ? { ...m, site_code: null } : m));
  const asBuilt = [
    asb(1, 'CW_FENCE', 'cw', 'Fence length', 'طول السياج', 'm', null),
    asb(2, 'TE_ANT', 'te', 'Antennas installed', 'الهوائيات المركّبة', 'pcs', 'ANT-900'),
  ];
  const gaps: WarehouseConfigGaps = {
    pending_need_rules: [{ item_id: items[0]!.id, item_code: 'ANT-900', item_name: items[0]!.name_en, need_unit: 'Cambium Sector', quantity: 1 }],
    provisional_codes: [{ item_id: items[1]!.id, item_code: 'CBL-FEED', item_name: items[1]!.name_en, category: 'Cables' }],
    regions_without_wl_vendor: [2, 3, 4, 5, 6, 7],
    regions_without_sequence: [{ region_id: 2, record_types: ['cw_dn', 'cw_rn', 'te_dn', 'te_rn'] }],
  };
  return { items, stock, movements, asBuilt, gaps, inUse: ['ANT-900'] as string[] };
}

/** The TE dispatch of a mock site (D6): the latest TE DN date beside the need status. Site 0 is complete, site 1 short, every other site pending configuration. */
export function dispatchOf(i: number): SiteDispatch {
  const m = siteMeta(i);
  const status: SiteDispatch['need_status'] = i % 3 === 0 ? 'complete' : i % 3 === 1 ? 'short' : 'pending_configuration';
  const routerDone = status !== 'short';
  return {
    site_id: m.id, site_code: m.code, region_id: m.region_id as SiteDispatch['region_id'], te_applies: true, router_only: false,
    te_dispatch_complete_date: status === 'short' ? null : '2026-10-18', latest_te_dn_no: status === 'short' ? null : `DN-TE-TR-2026-${String(i + 1).padStart(4, '0')}`,
    need_status: status, short_lines: routerDone ? 0 : 1, pending_lines: status === 'pending_configuration' ? 1 : 0,
    lines: [
      { need_unit: 'Router', need_group: 'ROUTER', rule_status: 'confirmed', unit_source: 'te_site', units: 1, quantity: 1, need: 1, delivered: routerDone ? 1 : 0, short: routerDone ? 0 : 1,
        line_status: routerDone ? 'complete' : 'short', missing: null, items: [{ item_code: 'RRU-3', item_name: 'Remote radio unit', delivered: routerDone ? 1 : 0, rule_status: 'confirmed' }] },
      ...(status === 'pending_configuration' ? [{ need_unit: 'Cambium Sector', need_group: 'ANT-900', rule_status: 'pending_configuration' as const, unit_source: 'rf_sector' as const, units: null, quantity: 1,
        need: null, delivered: 0, short: null, line_status: 'pending_configuration' as const, missing: 'need_quantity' as const, items: [{ item_code: 'ANT-900', item_name: 'Panel antenna 900 MHz', delivered: 0, rule_status: 'pending_configuration' as const }] }] : []),
    ],
  };
}
