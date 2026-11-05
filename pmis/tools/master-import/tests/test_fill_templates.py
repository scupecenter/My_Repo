"""Tests for fill-templates.py. Synthetic data only: a fake Master and fake templates built here.

Run: python3 -m unittest discover -s pmis/tools/master-import/tests   (or pytest)
"""
import csv
import datetime as dt
import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

import openpyxl
from openpyxl.styles import PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fill_templates', HERE.parent / 'fill-templates.py')
ft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ft)

HEADERS = ['Site ID', 'Candidate', 'TSS Date', 'Selected', 'Owner / Landlord', 'Phone', 'Calculated', 'Record ID']
GREY = PatternFill('solid', fgColor='FFD0D5D8')


def make_template(path, template_id='TPL-ACQ', tamper_checksum=False, with_tpl=True, prefilled=False, kind='acquisition'):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Data'
    for i, h in enumerate(HEADERS, 1):
        ws.cell(1, i, h)
        if h in ('Calculated', 'Record ID'):
            ws.cell(1, i).fill = GREY
    lists = wb.create_sheet('_lists')
    for r, v in enumerate(['Candidate', 'A', 'B'], 1):
        lists.cell(r, 1, v)
    for r, v in enumerate(['Selected', 'Yes', 'No'], 1):
        lists.cell(r, 2, v)
    dv = DataValidation(type='list', formula1='_lists!$A$2:$A$3', allow_blank=True)
    dv2 = DataValidation(type='list', formula1='_lists!$B$2:$B$3', allow_blank=True)
    dv3 = DataValidation(type='date', operator='between', formula1='43831', formula2='49000', allow_blank=True)
    ws.add_data_validation(dv)
    ws.add_data_validation(dv2)
    ws.add_data_validation(dv3)
    dv.add('B2:B300')
    dv2.add('D2:D300')
    dv3.add('C2:C300')
    ws.protection.sheet = True
    if prefilled:
        ws['A2'] = 'XX001'
    if with_tpl:
        t = wb.create_sheet('_tpl')
        sums = hashlib.sha256('\x1f'.join(HEADERS).encode()).hexdigest()
        rows = [('template_id', template_id), ('version', 3), ('kind', kind), ('data_sheet', 'Data'),
                ('header_checksum', 'bad' if tamper_checksum else sums)]
        for i, (k, v) in enumerate(rows, 1):
            t.cell(i, 1, k)
            t.cell(i, 2, v)
        t.sheet_state = 'veryHidden'
    wb.save(path)


def make_master(path, acq_rows, site_ids=('XX001', 'XX002', 'XX003', 'XX004')):
    wb = openpyxl.Workbook()
    m = wb.active
    m.title = 'Master'
    for r in range(1, 5):
        m.cell(r, 1, 'hdr')
    for i, s in enumerate(site_ids):
        m.cell(5 + i, 2, s)
    a = wb.create_sheet('Acquisition')
    a.append(['#', 'Site ID', 'Candidate', 'TSS Date', 'Selected', 'Owner / Landlord', 'Phone'])
    a.append(['SUBTOTAL'])
    for r in acq_rows:
        a.append(r)
    wb.save(path)


def make_maps(d):
    d = Path(d)
    (d / 'index.csv').write_text(
        'register,template_id,master_sheet,header_row,first_data_row,site_header,key_headers,key_any_of,site_scoped\n'
        'acquisition,TPL-ACQ,Acquisition,1,3,Site ID,Site ID|Candidate,,yes\n', encoding='utf-8')
    (d / 'acquisition.csv').write_text(
        'template_header,master_header,master_column,transform,personal,notes\n'
        'Site ID,Site ID,B,site_id,,\n'
        'Candidate,Candidate,C,,,\n'
        'TSS Date,TSS Date,D,,,\n'
        'Selected,Selected,E,,,\n'
        'Owner / Landlord,Owner / Landlord,F,,yes,\n'
        'Phone,Phone,G,,yes,\n'
        'Calculated,Site ID,B,,,maps onto a grey column on purpose\n', encoding='utf-8')


class FillTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.maps = self.dir / 'maps'
        self.maps.mkdir()
        make_maps(self.maps)
        self.out = self.dir / 'out'
        self.tpl = self.dir / 'blank.xlsx'
        self.master = self.dir / 'master.xlsx'
        make_template(self.tpl)

    def tearDown(self):
        self._tmp.cleanup()

    def run_tool(self, *extra, templates=None, master=None):
        args = ['--master', str(master or self.master), '--out', str(self.out), '--maps', str(self.maps), *extra,
                *[str(t) for t in (templates or [self.tpl])]]
        return ft.main(args)

    def filled(self):
        return openpyxl.load_workbook(self.out / 'TPL-ACQ_v3_filled.xlsx')

    def rows(self):
        return [
            [None, 'xx001 ', 'A', '2026-03-05', 'Yes', 'Fake Landlord One', '0910000001'],
            [None, 'XX002', 'a', dt.datetime(2026, 4, 1), 'y', 'Fake Landlord Two', '0910000002'],
            [None, 'XX003', 'B', 'Pending', 'No', None, None],
            [None, 'XX003', 'B', '2026-01-01', 'No', None, None],   # duplicate key
            [None, 'ZZ999', 'A', None, None, None, None],            # not in Master
            [None, None, 'A', None, None, None, None],               # no site id
            [None, 'XX004', 'Z', '13/04/2026', 'Maybe', None, None],  # outside list, dd/mm
        ]

    def test_mapping_and_normalisation(self):
        make_master(self.master, self.rows())
        self.assertEqual(self.run_tool(), 0)
        ws = self.filled()['Data']
        self.assertEqual(ws['A2'].value, 'XX001')          # trimmed and upper-cased
        self.assertEqual(ws['B2'].value, 'A')
        self.assertEqual(ws['C2'].value, dt.datetime(2026, 3, 5))  # text to date
        self.assertEqual(ws['C2'].number_format, 'yyyy-mm-dd')
        self.assertEqual(ws['B3'].value, 'A')              # list case
        self.assertEqual(ws['D3'].value, 'Yes')            # y alias for a Yes/No list
        self.assertIsNone(ws['C4'].value)                  # "Pending" in a date cell is blanked
        self.assertEqual(ws['C5'].value, dt.datetime(2026, 4, 13))  # day first, unambiguous
        self.assertEqual(ws['D5'].value, 'Maybe')          # outside list: copied as found
        self.assertEqual(ws['B5'].value, 'Z')

    def test_skipped_rows_and_report(self):
        make_master(self.master, self.rows())
        self.run_tool()
        md = (self.out / 'TPL-ACQ_v3_summary.md').read_text()
        self.assertIn('Rows copied: 4', md)
        self.assertIn('duplicate_key: 6', md)
        self.assertIn('site_not_in_master: 7', md)
        self.assertIn('no_site_id: 8', md)
        self.assertIn('Values outside their list (copied as found): 2', md)  # Z and Maybe
        self.assertIn('B5', md)
        with open(self.out / 'TPL-ACQ_v3_report.csv', encoding='utf-8') as f:
            rows = list(csv.DictReader(f))
        changed = [r for r in rows if r['event'] == 'changed' and r['template_cell'] == 'C2']
        self.assertEqual(len(changed), 1)
        self.assertEqual((changed[0]['old'], changed[0]['new']), ('2026-03-05', '2026-03-05'))
        self.assertTrue(any(r['event'] == 'blanked' and r['template_cell'] == 'C4' for r in rows))

    def test_grey_columns_never_filled(self):
        make_master(self.master, self.rows())
        self.run_tool()
        ws = self.filled()['Data']
        for r in range(2, 8):
            self.assertIsNone(ws.cell(r, 7).value)  # Calculated
            self.assertIsNone(ws.cell(r, 8).value)  # Record ID
        md = (self.out / 'TPL-ACQ_v3_summary.md').read_text()
        self.assertIn('Grey, not filled', md)

    def test_personal_columns_skipped_by_default(self):
        make_master(self.master, self.rows())
        self.run_tool()
        ws = self.filled()['Data']
        self.assertIsNone(ws['E2'].value)
        self.assertIsNone(ws['F2'].value)
        text = (self.out / 'TPL-ACQ_v3_summary.md').read_text() + (self.out / 'TPL-ACQ_v3_report.csv').read_text()
        self.assertNotIn('Fake Landlord', text)
        self.assertNotIn('0910000001', text)
        self.assertRegex((self.out / 'TPL-ACQ_v3_summary.md').read_text(), r'Owner / Landlord \| 0 \| 0 \| 2')

    def test_include_personal_copies_but_never_prints(self):
        make_master(self.master, self.rows())
        self.run_tool('--include-personal')
        ws = self.filled()['Data']
        self.assertEqual(ws['E2'].value, 'Fake Landlord One')
        text = (self.out / 'TPL-ACQ_v3_summary.md').read_text() + (self.out / 'TPL-ACQ_v3_report.csv').read_text()
        self.assertNotIn('Fake Landlord', text)
        self.assertNotIn('0910000001', text)

    def test_tpl_sheet_preserved(self):
        make_master(self.master, self.rows())
        self.run_tool()
        wb = self.filled()
        self.assertIn('_tpl', wb.sheetnames)
        t = wb['_tpl']
        self.assertEqual(t.sheet_state, 'veryHidden')
        self.assertEqual({t.cell(r, 1).value: t.cell(r, 2).value for r in range(1, 6)},
                         {'template_id': 'TPL-ACQ', 'version': 3, 'kind': 'acquisition', 'data_sheet': 'Data',
                          'header_checksum': hashlib.sha256('\x1f'.join(HEADERS).encode()).hexdigest()})
        # header row, list validations and protection survive
        self.assertEqual([wb['Data'].cell(1, i).value for i in range(1, 9)], HEADERS)
        self.assertEqual(len(wb['Data'].data_validations.dataValidation), 3)
        self.assertTrue(wb['Data'].protection.sheet)

    def test_template_without_tpl_is_refused(self):
        make_master(self.master, self.rows())
        bad = self.dir / 'no_tpl.xlsx'
        make_template(bad, with_tpl=False)
        self.assertEqual(self.run_tool(templates=[self.tpl, bad]), 2)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))  # nothing written for the good one either

    def test_tampered_header_checksum_refused(self):
        make_master(self.master, self.rows())
        bad = self.dir / 'tampered.xlsx'
        make_template(bad, tamper_checksum=True)
        self.assertEqual(self.run_tool(templates=[bad]), 2)

    def test_prefilled_template_refused(self):
        make_master(self.master, self.rows())
        bad = self.dir / 'prefilled.xlsx'
        make_template(bad, prefilled=True)
        self.assertEqual(self.run_tool(templates=[bad]), 2)

    def test_master_template_kind_refused(self):
        make_master(self.master, self.rows())
        bad = self.dir / 'm.xlsx'
        make_template(bad, template_id='TPL-MASTER', kind='master')
        self.assertEqual(self.run_tool(templates=[bad]), 2)

    def test_refuses_to_overwrite_inputs_or_existing_output(self):
        make_master(self.master, self.rows())
        self.assertEqual(self.run_tool(), 0)
        self.assertEqual(self.run_tool(), 2)  # output already there
        # an output folder equal to the template folder would write TPL-ACQ_v3_filled.xlsx: allowed only if it is not an input
        clash = self.dir / 'clash'
        clash.mkdir()
        inp = clash / 'TPL-ACQ_v3_filled.xlsx'
        make_template(inp)
        args = ['--master', str(self.master), '--out', str(clash), '--maps', str(self.maps), str(inp)]
        self.assertEqual(ft.main(args), 2)

    def test_macro_workbook_refused(self):
        import zipfile
        make_master(self.master, self.rows())
        with zipfile.ZipFile(self.master, 'a') as z:
            z.writestr('xl/vbaProject.bin', b'x')
        self.assertEqual(self.run_tool(), 2)

    def test_formulas_read_as_values(self):
        make_master(self.master, self.rows())
        wb = openpyxl.load_workbook(self.master)
        wb['Acquisition']['C3'] = '=1+1'  # no cached value: data_only reads None, never evaluates
        wb.save(self.master)
        self.assertEqual(self.run_tool(), 0)
        self.assertIsNone(self.filled()['Data']['B2'].value)

    def test_shipped_maps_are_consistent(self):
        reg = ft.load_registers(HERE.parent / 'register-maps')
        self.assertEqual(set(reg), {'TPL-RF', 'TPL-ACQ', 'TPL-PRM', 'TPL-PO', 'TPL-GECOL', 'TPL-HLC', 'TPL-ASB', 'TPL-RSK'})
        for tid, r in reg.items():
            heads = [c['template_header'] for c in r['columns']]
            self.assertEqual(len(heads), len(set(heads)), tid)
            self.assertTrue(any(h == r['site_header'] for h in heads), tid)
            for k in r['key_headers'].split('|'):
                self.assertIn(k, heads, tid)
        acq = {c['template_header']: c for c in reg['TPL-ACQ']['columns']}
        for h in ('Owner / Landlord', 'Contact Person', 'Phone', 'E-mail'):
            self.assertEqual(acq[h]['personal'], 'yes')


class DateAndProcurementTests(unittest.TestCase):
    PO_HEADERS = ['Site ID', 'Record Type', 'PO / WO No.', 'Delivery', 'Team', 'PO Date']

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.maps = self.dir / 'maps'
        self.maps.mkdir()
        (self.maps / 'index.csv').write_text(
            'register,template_id,master_sheet,header_row,first_data_row,site_header,key_headers,key_any_of,site_scoped,needs_headers\n'
            'procurement,TPL-PO,PR-PO,1,2,Site ID,Site ID|PO / WO No.,,yes,Delivery|Team\n', encoding='utf-8')
        (self.maps / 'procurement.csv').write_text(
            'template_header,master_header,master_column,transform,personal,notes\n'
            'Site ID,Site ID,B,site_id,,\nRecord Type,PO No.,C,record_type_po_pr,,\nPO / WO No.,PO No.,C,,,\n'
            'Delivery,,,,,\nTeam,,,,,\nPO Date,PO Date,D,,,\n', encoding='utf-8')
        self.tpl = self.dir / 'po.xlsx'
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = 'Data'
        for i, h in enumerate(self.PO_HEADERS, 1):
            ws.cell(1, i, h)
        lists = wb.create_sheet('_lists')
        for r, v in enumerate(['Record Type', 'pr', 'po', 'wo'], 1):
            lists.cell(r, 1, v)
        dv = DataValidation(type='list', formula1='_lists!$A$2:$A$4')
        dv2 = DataValidation(type='date', operator='between', formula1='43831', formula2='49000')
        ws.add_data_validation(dv)
        ws.add_data_validation(dv2)
        dv.add('B2:B300')
        dv2.add('F2:F300')
        t = wb.create_sheet('_tpl')
        for i, (k, v) in enumerate([('template_id', 'TPL-PO'), ('version', 1), ('kind', 'procurement'), ('data_sheet', 'Data'),
                                     ('header_checksum', hashlib.sha256('\x1f'.join(self.PO_HEADERS).encode()).hexdigest())], 1):
            t.cell(i, 1, k)
            t.cell(i, 2, v)
        t.sheet_state = 'veryHidden'
        wb.save(self.tpl)
        self.master = self.dir / 'm.xlsx'
        wb = openpyxl.Workbook()
        m = wb.active
        m.title = 'Master'
        m.cell(5, 2, 'XX001')
        m.cell(6, 2, 'XX002')
        m.cell(7, 2, 'XX003')
        a = wb.create_sheet('PR-PO')
        a.append(['#', 'Site ID', 'PO No.', 'PO Date'])
        a.append([1, 'XX001', 'PO-1', '05/06/2025'])   # day first: 5 June
        a.append([2, 'XX002', None, '13/06/2025'])
        a.append([3, 'XX003', 'PO-3', '2025-07-01'])
        wb.save(self.master)
        self.out = self.dir / 'out'

    def tearDown(self):
        self._tmp.cleanup()

    def run_tool(self, *extra):
        return ft.main(['--master', str(self.master), '--out', str(self.out), '--maps', str(self.maps), *extra, str(self.tpl)])

    def test_day_first_by_default_and_reported(self):
        self.assertEqual(self.run_tool(), 0)
        ws = openpyxl.load_workbook(self.out / 'TPL-PO_v1_filled.xlsx')['Data']
        self.assertEqual(ws['F2'].value, dt.datetime(2025, 6, 5))
        self.assertEqual(ws['F3'].value, dt.datetime(2025, 6, 13))
        self.assertEqual(ws['F4'].value, dt.datetime(2025, 7, 1))
        with open(self.out / 'TPL-PO_v1_report.csv', encoding='utf-8') as f:
            rows = [r for r in csv.DictReader(f) if r['event'] == 'date_day_first_assumed']
        self.assertEqual([(r['template_cell'], r['old'], r['new']) for r in rows], [('F2', '05/06/2025', '2025-06-05')])
        self.assertIn('read day first', (self.out / 'TPL-PO_v1_summary.md').read_text())

    def test_month_first_flag(self):
        self.assertEqual(self.run_tool('--month-first'), 0)
        ws = openpyxl.load_workbook(self.out / 'TPL-PO_v1_filled.xlsx')['Data']
        self.assertEqual(ws['F2'].value, dt.datetime(2025, 5, 6))
        self.assertEqual(ws['F3'].value, dt.datetime(2025, 6, 13))  # unambiguous: unchanged
        with open(self.out / 'TPL-PO_v1_report.csv', encoding='utf-8') as f:
            events = [r['event'] for r in csv.DictReader(f)]
        self.assertIn('date_month_first_assumed', events)
        self.assertNotIn('date_day_first_assumed', events)

    def test_record_type_derived_and_needs_delivery_team(self):
        self.run_tool()
        ws = openpyxl.load_workbook(self.out / 'TPL-PO_v1_filled.xlsx')['Data']
        self.assertEqual([ws['B2'].value, ws['B3'].value, ws['B4'].value], ['po', 'pr', 'po'])
        self.assertIsNone(ws['D2'].value)
        self.assertIsNone(ws['E2'].value)
        with open(self.out / 'TPL-PO_v1_report.csv', encoding='utf-8') as f:
            needs = [r['template_cell'] for r in csv.DictReader(f) if r['event'] == 'needs_delivery_team']
        self.assertEqual(sorted(needs), ['D2', 'D3', 'D4', 'E2', 'E3', 'E4'])

    def test_include_personal_prints_warning(self):
        import contextlib
        import io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.run_tool('--include-personal')
        self.assertIn('WARNING', err.getvalue())
        self.assertEqual(err.getvalue().count('\n'), 1)


if __name__ == '__main__':
    unittest.main()
