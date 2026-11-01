import type { AsBuiltItem, StockLevel, StockMovement, WarehouseItem } from '@/api/types';

/** Mock Warehouse (item master, DN/RN movements, stock) and As-Built items, in the shapes of contract 0.4.8 (synthetic data). */
const id = (p: string, n: number) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, code: string, name_en: string, name_ar: string, uom: string, category: string | null, serial_tracked: boolean): WarehouseItem =>
  ({ id: id('b', n), code, name_en, name_ar, uom, category, serial_tracked, is_active: true, version: 1, as_built_item_code: null });
const asb = (n: number, code: string, section: 'cw' | 'te', name_en: string, name_ar: string, unit: string, warehouse_item_code: string | null): AsBuiltItem =>
  ({ id: id('d', n), code, section, name_en, name_ar, unit, warehouse_item_code, sort_order: n, field_code: `q_${code.toLowerCase()}`, is_active: true, version: 1 });
const mv = (n: number, doc_no: string, record_type: StockMovement['record_type'], kind: StockMovement['kind'], status: StockMovement['status'], site_code: string, itemN: number, code: string, qty: number): StockMovement => ({
  id: id('c', n), doc_no, record_type, kind, status, site_id: null, site_code, register_record_id: id('e', n), reserved: status === 'pending' && kind === 'issue', version: 1,
  lines: [{ item_id: id('b', itemN), item_code: code, qty }], created_by: { id: id('1', 1), display_name: 'Ahmed Salem' }, created_at: '2026-10-20T08:00:00Z', posted_at: status === 'posted' ? '2026-10-21T08:00:00Z' : null,
});

export function initWarehouse() {
  const items = [
    item(1, 'ANT-900', 'Panel antenna 900 MHz', 'هوائي لوحي 900 ميغاهرتز', 'pcs', 'Antennas', true),
    item(2, 'CBL-FEED', 'Feeder cable 7/8"', 'كابل تغذية 7/8 بوصة', 'm', 'Cables', false),
    item(3, 'RRU-3', 'Remote radio unit', 'وحدة راديو بعيدة', 'pcs', null, true),
  ];
  const stock: StockLevel[] = [
    { item_id: items[0]!.id, item_code: 'ANT-900', item_name: items[0]!.name_en, uom: 'pcs', site_id: null, on_hand: 40, reserved: 6, pending_issue: 6, pending_return: 0, available: 34 },
    { item_id: items[1]!.id, item_code: 'CBL-FEED', item_name: items[1]!.name_en, uom: 'm', site_id: null, on_hand: 1200, reserved: 0, pending_issue: 0, pending_return: 100, available: 1200 },
    { item_id: items[2]!.id, item_code: 'RRU-3', item_name: items[2]!.name_en, uom: 'pcs', site_id: null, on_hand: 3, reserved: 0, pending_issue: 0, pending_return: 0, available: 3 },
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
  return { items, stock, movements, asBuilt, inUse: ['ANT-900'] as string[] };
}
