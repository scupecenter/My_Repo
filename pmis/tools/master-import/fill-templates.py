#!/usr/bin/env python3
"""
fill-templates.py: offline helper that copies the register sheets of the owner's Master workbook into the approved
templates issued by GSDN Workspace (gap G3 of docs/plans/2026-11-04-master-template-data-load.md).

Rules it keeps (CLAUDE.md "Approved templates only"):
  * it never invents a template: every template must carry the hidden `_tpl` sheet (template_id + version) issued by GSDN Workspace;
  * it never changes `_tpl`, the header row, the grey (never-read) columns, the drop-downs or the protection of a template;
  * it fixes only what is mechanical (spaces, dates typed as text, numbers typed as text, list case, "N/A" in a date cell);
    everything else is copied exactly as found and listed in the report;
  * the Master workbook is untrusted: read-only, values only (data_only), no macro, no external link is followed;
  * personal columns (landlord, contact, phone, e-mail) are not copied unless --include-personal is given (decision Q469);
  * the Markdown summary holds counts and cell addresses only. The CSV holds old and new values of the cells it changed,
    never of a personal column.

Nothing is uploaded: the owner uploads each filled template through GSDN Workspace (batch, then L2).

Usage:
  python3 -I fill-templates.py --master Master.xlsx --out OUT_DIR TEMPLATE.xlsx [TEMPLATE2.xlsx ...] [--include-personal]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import os
import re
import sys
import zipfile
from collections import Counter, OrderedDict
from pathlib import Path

try:
    import openpyxl
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    sys.stderr.write('openpyxl is required: pip install openpyxl\n')
    sys.exit(3)

TPL_SHEET = '_tpl'
LISTS_SHEET = '_lists'
DEFAULT_DATA_SHEET = 'Data'
GREY_FILL = 'D0D5D8'  # header fill of a derived (never-read) column and of Record ID (templates.service.ts)
UNIT_SEPARATOR = '\x1f'
TPL_ID = re.compile(r'^TPL-[A-Z0-9_-]{2,40}$')
TPL_VERSION = re.compile(r'^[0-9]{1,6}$')
BLANK_TOKENS = {'n/a', 'na', 'pending', 'cancelled', 'canceled'}  # plan section 5.2 / G10
PERSONAL_HEADER = re.compile(r'landlord|contact|phone|e-?mail', re.I)
OPEN_ENDED = {'open-ended', 'open ended', 'openended'}
# One source of truth (CHANGELOG 130): the maps ship with the API, which loads the same register sheets in "Master import and comparison" (migration 0088).
DEFAULT_MAPS = Path(__file__).resolve().parent.parent.parent / 'apps' / 'api' / 'src' / 'master-import' / 'register-maps'
MAX_ENTRIES = 1000
MAX_UNCOMPRESSED = 200 * 1024 * 1024
NUMBER = re.compile(r'^[+-]?\d+(\.\d+)?$')
DATE_MIN, DATE_MAX = dt.date(2020, 1, 1), dt.date(2035, 12, 31)  # the template's own date rule
ADDR_CAP = 25  # addresses listed per event in the Markdown summary


class Refused(Exception):
    """A file this tool will not touch."""


# ---------------------------------------------------------------------------------------------------------------------
# Safety checks on workbooks (untrusted input)
# ---------------------------------------------------------------------------------------------------------------------
def package_facts(path: Path) -> dict:
    """Inspect the zip directory without extracting anything: macros, external links, size."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
            names = [i.filename.lower() for i in infos]
            total = sum(i.file_size for i in infos)
    except zipfile.BadZipFile as e:
        raise Refused(f'{path.name}: not an .xlsx package') from e
    if len(infos) > MAX_ENTRIES or total > MAX_UNCOMPRESSED:
        raise Refused(f'{path.name}: package too large (entries or uncompressed size over the limit)')
    if not any(n == 'xl/workbook.xml' for n in names):
        raise Refused(f'{path.name}: not an .xlsx workbook')
    macros = any('vbaproject' in n or n.endswith('.bin') and 'activex' in n for n in names)
    return {'macros': macros, 'external_links': any(n.startswith('xl/externallinks/') for n in names)}


def norm_header(v) -> str:
    return re.sub(r'\s+', ' ', str(v if v is not None else '').replace(' ', ' ')).strip().casefold()


def clean_text(s: str) -> str:
    return re.sub(r'[ \t ]+', ' ', s).strip()


def header_checksum(headers: list[str]) -> str:
    return hashlib.sha256(UNIT_SEPARATOR.join(headers).encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------------------------------------------------
# Mapping files
# ---------------------------------------------------------------------------------------------------------------------
def read_csv(path: Path) -> list[dict]:
    with open(path, newline='', encoding='utf-8') as f:
        lines = (ln for ln in f if not ln.lstrip().startswith('#'))
        return [{k.strip(): (v or '').strip() for k, v in row.items() if k} for row in csv.DictReader(lines)]


def load_registers(maps_dir: Path) -> dict[str, dict]:
    """template_id -> {register, master_sheet, ..., columns: [map rows]}"""
    out: dict[str, dict] = {}
    for r in read_csv(maps_dir / 'index.csv'):
        f = maps_dir / f"{r['register']}.csv"
        if not f.is_file():
            raise SystemExit(f'index.csv names {r["register"]} but {f.name} is missing')
        r['columns'] = read_csv(f)
        r['header_row'] = int(r['header_row'])
        r['first_data_row'] = int(r['first_data_row'])
        out[r['template_id']] = r
    return out


# ---------------------------------------------------------------------------------------------------------------------
# The template
# ---------------------------------------------------------------------------------------------------------------------
class Template:
    def __init__(self, path: Path):
        self.path = path
        facts = package_facts(path)
        if facts['macros'] or facts['external_links']:
            raise Refused(f'{path.name}: a template with macros or external links is not a PMIS template')
        # not read-only: the file is written back. Links are never kept; no VBA.
        self.wb = openpyxl.load_workbook(path, data_only=False, keep_vba=False, keep_links=False)
        if TPL_SHEET not in self.wb.sheetnames:
            raise Refused(f'{path.name}: no _tpl sheet. This is not a template issued by GSDN Workspace; download it again from the Templates page.')
        kv = {}
        for row in self.wb[TPL_SHEET].iter_rows(min_row=1, max_col=2, values_only=True):
            if row[0] is not None:
                kv[str(row[0]).strip()] = '' if row[1] is None else str(row[1]).strip()
        self.kv = kv
        tid, ver = kv.get('template_id', ''), kv.get('version', '')
        if not TPL_ID.match(tid) or not TPL_VERSION.match(ver):
            raise Refused(f'{path.name}: the _tpl sheet has no valid template_id and version')
        self.template_id, self.version = tid, int(ver)
        if kv.get('kind') in ('master', 'stream', 'sites'):
            raise Refused(f'{path.name}: {tid} is not a register template (kind {kv.get("kind")})')
        sheet = kv.get('data_sheet') or DEFAULT_DATA_SHEET
        if sheet not in self.wb.sheetnames or sheet in (TPL_SHEET, LISTS_SHEET):
            raise Refused(f'{path.name}: the data sheet named in _tpl is missing')
        self.ws = self.wb[sheet]
        self.headers: list[str] = []
        c = 1
        while self.ws.cell(1, c).value not in (None, ''):
            self.headers.append(str(self.ws.cell(1, c).value).strip())
            c += 1
        if not self.headers:
            raise Refused(f'{path.name}: the header row is empty')
        claimed = kv.get('header_checksum')
        if claimed and header_checksum(self.headers) != claimed:
            raise Refused(f'{path.name}: the header row does not match the checksum in _tpl; the template was changed')
        if any(self.ws.cell(r, cc).value not in (None, '') for r in range(2, min(self.ws.max_row, 400) + 1) for cc in range(1, len(self.headers) + 1)):
            raise Refused(f'{path.name}: the data sheet already holds rows. Use a blank template from GSDN Workspace.')
        self.cols = self._describe()

    def _lists(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        if LISTS_SHEET in self.wb.sheetnames:
            ws = self.wb[LISTS_SHEET]
            for c in range(1, ws.max_column + 1):
                vals = [ws.cell(r, c).value for r in range(2, ws.max_row + 1)]
                out[get_column_letter(c)] = [str(v).strip() for v in vals if v not in (None, '')]
        return out

    def _describe(self) -> list[dict]:
        lists = self._lists()
        val: dict[int, dict] = {}
        for dv in self.ws.data_validations.dataValidation:
            info = {'type': dv.type, 'options': None, 'warn_only': dv.errorStyle == 'warning'}
            if dv.type == 'list' and dv.formula1:
                f = dv.formula1.strip()
                m = re.match(rf"^'?{LISTS_SHEET}'?!\$?([A-Z]+)\$?\d+:\$?[A-Z]+\$?\d+$", f)
                if m:
                    info['options'] = lists.get(m.group(1), [])
                elif f.startswith('"') and f.endswith('"'):
                    info['options'] = [x.strip() for x in f[1:-1].split(',')]
            for rng in str(dv.sqref).split():
                m = re.match(r'^([A-Z]+)\d+', rng)
                if m:
                    val[openpyxl.utils.column_index_from_string(m.group(1))] = info
        cols = []
        for i, h in enumerate(self.headers, start=1):
            fill = self.ws.cell(1, i).fill.fgColor.rgb if self.ws.cell(1, i).fill and self.ws.cell(1, i).fill.fgColor else None
            grey = (isinstance(fill, str) and fill.upper().endswith(GREY_FILL)) or h == 'Record ID'
            v = val.get(i, {})
            kind = {'date': 'date', 'decimal': 'number', 'whole': 'number', 'list': 'list'}.get(v.get('type'), 'text')
            cols.append({'idx': i, 'letter': get_column_letter(i), 'header': h, 'key': norm_header(h), 'grey': grey, 'kind': kind,
                         'options': v.get('options'), 'warn_only': v.get('warn_only', False)})
        return cols


# ---------------------------------------------------------------------------------------------------------------------
# Value normalisation
# ---------------------------------------------------------------------------------------------------------------------
def parse_date_text(s: str, month_first: bool = False):
    """Return (date, None) when the text is a date without doubt, (date, 'assumed') when day and month are both 12 or less and differ
    (read day first, dd/mm/yyyy, unless month_first; Q491), (None, None) otherwise."""
    s = s.strip()
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%d-%b-%Y', '%d %b %Y', '%d-%B-%Y', '%d %B %Y', '%b %d, %Y', '%B %d, %Y', '%Y.%m.%d'):
        try:
            return dt.datetime.strptime(s, fmt).date(), None
        except ValueError:
            pass
    m = re.match(r'^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$', s)
    if m:
        a, b, y = int(m[1]), int(m[2]), int(m[3])
        try:
            if a > 12 and b <= 12:
                return dt.date(y, b, a), None
            if b > 12 and a <= 12:
                return dt.date(y, a, b), None
            if a == b:
                return dt.date(y, a, b), None
            if a <= 12 and b <= 12:
                return (dt.date(y, a, b) if month_first else dt.date(y, b, a)), 'assumed'
        except ValueError:
            return None, None
    return None, None


class Report:
    def __init__(self):
        self.events: list[dict] = []
        self.counts: Counter = Counter()
        self.per_column: dict[str, Counter] = {}
        self.skipped_rows: list[tuple[int, str]] = []
        self.rows_copied = 0

    def add(self, event, cell='', source='', header='', old='', new='', note=''):
        self.events.append({'event': event, 'cell': cell, 'source_cell': source, 'header': header, 'old': old, 'new': new, 'note': note})
        self.counts[event] += 1

    def col(self, header: str, what: str, n: int = 1):
        self.per_column.setdefault(header, Counter())[what] += n


def short(v, n=40):
    s = str(v)
    return s if len(s) <= n else s[:n] + '...'


def normalise(value, col, boolean_like: bool, month_first: bool = False):
    """Return (new_value, event, note). event is None when nothing changed, 'changed', 'blanked' or 'not_normalised'."""
    if value is None:
        return None, None, ''
    if isinstance(value, str):
        cleaned = clean_text(value)
        if cleaned == '':
            return None, 'blanked', 'empty text'
        text_changed = cleaned != value
        value = cleaned
    else:
        text_changed = False
    kind = col['kind']
    if kind == 'date':
        if isinstance(value, dt.datetime):
            d = value.date()
            return d, ('changed' if value.time() != dt.time(0) else None), 'time removed'
        if isinstance(value, dt.date):
            return value, None, ''
        if isinstance(value, str):
            if value.casefold() in BLANK_TOKENS:
                return None, 'blanked', 'not a date'
            d, why = parse_date_text(value, month_first)
            if d:
                if why == 'assumed':
                    return d, 'date_month_first_assumed' if month_first else 'date_day_first_assumed', 'day and month both 12 or less'
                return d, 'changed', 'text to date'
            return value, 'not_normalised', 'text in date column'
        return value, 'not_normalised', 'number in date column'
    if kind == 'number':
        if isinstance(value, bool):
            return value, 'not_normalised', 'boolean in number column'
        if isinstance(value, (int, float)):
            return value, None, ''
        if isinstance(value, str):
            if value.casefold() in BLANK_TOKENS:
                return None, 'blanked', 'not a number'
            if NUMBER.match(value):
                n = float(value)
                return (int(n) if n.is_integer() and '.' not in value else n), 'changed', 'text to number'
            return value, 'not_normalised', 'text in number column'
    if kind == 'list' and col['options'] is not None and isinstance(value, str):
        opts = col['options']
        if value in opts:
            return value, ('changed' if text_changed else None), 'trimmed'
        by_fold = {o.casefold(): o for o in opts}
        if value.casefold() in by_fold:
            return by_fold[value.casefold()], 'changed', 'list case'
        if boolean_like:
            low = value.casefold()
            if low in ('y', 'true', '1'):
                return 'Yes', 'changed', 'yes alias'
            if low in ('n', 'false', '0'):
                return 'No', 'changed', 'no alias'
        return value, 'outside_list', 'not in the list' + (' (list allows another value)' if col['warn_only'] else '')
    if isinstance(value, str) and text_changed:
        return value, 'changed', 'spaces'
    return value, None, ''


# ---------------------------------------------------------------------------------------------------------------------
# The Master workbook
# ---------------------------------------------------------------------------------------------------------------------
class MasterBook:
    def __init__(self, path: Path):
        facts = package_facts(path)
        self.facts = facts
        if facts['macros']:
            raise Refused(f'{path.name}: contains a macro project; save it as .xlsx without macros')
        # read-only, values only; external links are not followed (keep_links False) and no formula is evaluated
        self.wb = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False)
        self._cache: dict[str, list[tuple]] = {}

    def has(self, sheet: str) -> bool:
        return sheet in self.wb.sheetnames

    def rows(self, sheet: str) -> list[tuple]:
        if sheet not in self._cache:
            ws = self.wb[sheet]
            try:
                ws.reset_dimensions()
            except Exception:  # pragma: no cover
                pass
            self._cache[sheet] = [tuple(r) for r in ws.iter_rows(values_only=True)]
        return self._cache[sheet]


def site_ids_of_master(book: MasterBook, sheet: str, col_letter: str, first_row: int) -> set[str]:
    ci = openpyxl.utils.column_index_from_string(col_letter) - 1
    ids = set()
    for r in book.rows(sheet)[first_row - 1:]:
        if ci < len(r) and r[ci] not in (None, ''):
            ids.add(clean_text(str(r[ci])).upper())
    return ids


# ---------------------------------------------------------------------------------------------------------------------
# Filling one template
# ---------------------------------------------------------------------------------------------------------------------
def fill(tpl: Template, reg: dict, book: MasterBook, master_ids: set[str] | None, include_personal: bool, month_first: bool = False) -> Report:
    rep = Report()
    rows = book.rows(reg['master_sheet'])
    hdr_idx = reg['header_row'] - 1
    if hdr_idx >= len(rows):
        raise Refused(f"{reg['master_sheet']}: header row {reg['header_row']} not found")
    mheaders: dict[str, int] = {}
    for i, h in enumerate(rows[hdr_idx]):
        if h is not None and norm_header(h) not in mheaders:
            mheaders[norm_header(h)] = i
    tcols = {c['key']: c for c in tpl.cols}

    plan = []  # (template col, master index or None, map row)
    for m in reg['columns']:
        col = tcols.get(norm_header(m['template_header']))
        if col is None:
            rep.add('map_unknown_template_header', header=m['template_header'], note='in the mapping file, not in the template')
            continue
        src = None
        if m.get('master_header'):
            src = next((mheaders[norm_header(alt)] for alt in m['master_header'].split('|') if norm_header(alt) in mheaders), None)
            if src is None:
                rep.add('master_header_not_found', header=m['template_header'], note='Master header missing from the sheet')
        elif m.get('master_column'):
            src = openpyxl.utils.column_index_from_string(m['master_column']) - 1
        personal = m.get('personal', '').lower() == 'yes' or bool(PERSONAL_HEADER.search(col['header']))
        plan.append({'col': col, 'src': src, 'map': m, 'personal': personal})
    mapped_keys = {p['col']['key'] for p in plan}
    for c in tpl.cols:
        if c['key'] not in mapped_keys and not c['grey']:
            rep.col(c['header'], 'no_source')
    site = next((p for p in plan if p['col']['key'] == norm_header(reg['site_header'])), None)
    if site is None or site['src'] is None:
        raise Refused(f"{reg['register']}: the mapping has no usable Site ID column")

    key_headers = [norm_header(h) for h in reg['key_headers'].split('|')] if reg.get('key_headers') else [site['col']['key']]
    any_of = [norm_header(h) for h in reg['key_any_of'].split('|')] if reg.get('key_any_of') else []
    seen: set[tuple] = set()
    out_row = 2
    for ri in range(reg['first_data_row'] - 1, len(rows)):
        raw = rows[ri]
        xl_row = ri + 1
        if all(v in (None, '') for v in raw):
            continue
        sid_raw = raw[site['src']] if site['src'] < len(raw) else None
        if sid_raw in (None, '') or clean_text(str(sid_raw)) == '':
            rep.skipped_rows.append((xl_row, 'no_site_id'))
            continue
        sid = clean_text(str(sid_raw)).upper()
        if master_ids is not None and reg.get('site_scoped', 'yes') != 'no' and sid not in master_ids:
            rep.skipped_rows.append((xl_row, 'site_not_in_master'))
            continue

        values: dict[str, tuple] = {}
        pending = []
        for p in plan:
            col = p['col']
            if col['grey']:
                if p['src'] is not None:
                    rep.col(col['header'], 'grey_not_filled')
                continue
            if p['personal'] and not include_personal:
                if p['src'] is not None and p['src'] < len(raw) and raw[p['src']] not in (None, ''):
                    rep.col(col['header'], 'personal_skipped')
                continue
            const = (p['map'].get('transform') or '').startswith('const:')
            if not const and (p['src'] is None or p['src'] >= len(raw)):
                continue
            v = raw[p['src']] if p['src'] is not None and p['src'] < len(raw) else None
            src_addr = f"{get_column_letter(p['src'] + 1)}{xl_row}" if p['src'] is not None else ''
            if p['col']['key'] == site['col']['key']:
                new, ev, note = sid, ('changed' if sid != sid_raw else None), 'site id trimmed / upper case'
            elif p['map'].get('transform') == 'record_type_po_pr':
                # Q494: PO / WO No. filled = the po record type, otherwise pr (codes of register_definitions.record_types, procurement)
                new = 'po' if (v not in (None, '') and clean_text(str(v)) != '') else 'pr'
                opts = col['options'] or []
                new = next((o for o in opts if o.casefold() == new), new)
                ev, note = ('outside_list' if opts and new not in opts else 'derived'), 'record type from PO / WO No.'
            elif const:
                # a fixed value for every copied row (As-Built: the TE configuration columns are the te_part record)
                new = p['map']['transform'][len('const:'):].strip()
                opts = col['options'] or []
                new = next((o for o in opts if o.casefold() == new.casefold()), new)
                ev, note = ('outside_list' if opts and new not in opts else 'derived'), 'fixed value of the mapping'
            elif p['map'].get('transform') == 'open_ended_no' and isinstance(v, str) and clean_text(v).casefold() in OPEN_ENDED:
                new, ev, note = 'No', 'changed', 'Open-ended to No'
            else:
                bl = bool(col['options']) and {o.casefold() for o in col['options']} >= {'yes', 'no'} and len(col['options']) <= 3
                new, ev, note = normalise(v, col, bl, month_first)
            pending.append((p, v, new, ev, note, src_addr))
            values[col['key']] = (new,)
        # duplicate key
        key = tuple(str(values.get(k, (None,))[0] or '').strip().casefold() for k in key_headers)
        if any_of and not any(values.get(k, (None,))[0] not in (None, '') for k in any_of):
            rep.counts['incomplete_key'] += 1
        else:
            if key in seen:
                rep.skipped_rows.append((xl_row, 'duplicate_key'))
                continue
            seen.add(key)

        # write
        for p, old, new, ev, note, src_addr in pending:
            col = p['col']
            addr = f"{col['letter']}{out_row}"
            if ev == 'derived':
                rep.counts['derived'] += 1
            elif ev in ('date_day_first_assumed', 'date_month_first_assumed'):
                rep.add(ev, addr, src_addr, col['header'], '' if p['personal'] else short(old), '' if p['personal'] else short(new), note)
            elif ev == 'outside_list':
                rep.add('outside_list', addr, src_addr, col['header'], '' if p['personal'] else short(old), '', note)
            elif ev == 'not_normalised':
                rep.add('not_normalised', addr, src_addr, col['header'], '' if p['personal'] else short(old), '', note)
            elif ev in ('changed', 'blanked'):
                if p['personal']:
                    rep.add(ev, addr, src_addr, col['header'], '', '', note)
                else:
                    rep.add(ev, addr, src_addr, col['header'], short(old), '' if new is None else short(new), note)
            if isinstance(new, dt.date) and not (DATE_MIN <= (new.date() if isinstance(new, dt.datetime) else new) <= DATE_MAX):
                rep.add('date_outside_range', addr, src_addr, col['header'], '', '', 'outside 2020-2035 (the template rule)')
            if new is None:
                rep.col(col['header'], 'blank')
                continue
            cell = tpl.ws.cell(out_row, col['idx'])
            cell.value = new
            if isinstance(new, str) and new[:1] in FORMULA_LEAD:
                # untrusted text that would read as a formula is kept as literal text, never a live formula (security review 2026-11-05)
                cell.data_type = 's'
                cell.quotePrefix = True
                rep.add('formula_text_kept', addr, src_addr, col['header'], '', '', 'starts with = + - @ or a control character: written as text')
            if col['kind'] == 'date' and isinstance(new, (dt.date, dt.datetime)):
                cell.number_format = 'yyyy-mm-dd'
        for h in (reg.get('needs_headers') or '').split('|'):
            c = tcols.get(norm_header(h)) if h else None
            if c is not None and not c['grey'] and tpl.ws.cell(out_row, c['idx']).value in (None, ''):
                rep.add('needs_delivery_team', f"{get_column_letter(c['idx'])}{out_row}", '', c['header'], '', '', 'to be completed in GSDN Workspace before submitting')
        out_row += 1
        rep.rows_copied += 1
    return rep


# ---------------------------------------------------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------------------------------------------------
FORMULA_LEAD = ('=', '+', '-', '@', '\t', '\r')


def csv_safe(v):
    """A report cell that a spreadsheet would read as a formula is prefixed with ' (CSV injection)."""
    if isinstance(v, str) and v[:1] in FORMULA_LEAD:
        return "'" + v
    return v


def write_reports(out_dir: Path, base: str, tpl: Template, reg: dict, rep: Report, include_personal: bool, master_facts: dict):
    csv_path = out_dir / f'{base}_report.csv'
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['event', 'template_cell', 'master_cell', 'header', 'old', 'new', 'note'])
        for e in rep.events:
            w.writerow([csv_safe(x) for x in (e['event'], e['cell'], e['source_cell'], e['header'], e['old'], e['new'], e['note'])])
        for row, why in rep.skipped_rows:
            w.writerow([csv_safe(x) for x in ('row_skipped', '', f"row {row}", '', '', '', why)])
        for h, c in rep.per_column.items():
            for what, n in c.items():
                w.writerow([csv_safe(x) for x in (f'column_{what}', '', '', h, '', '', f'{n} cells')])
    md = out_dir / f'{base}_summary.md'
    skip_counts = Counter(w for _, w in rep.skipped_rows)
    lines = [
        f'# {tpl.template_id} v{tpl.version}: fill report',
        '',
        f"Register: {reg['register']}. Master sheet: {reg['master_sheet']}. Personal columns copied: {'yes (--include-personal)' if include_personal else 'no (default)'}.",
        'This summary holds counts and cell addresses only.',
        '',
        f'- Rows copied: {rep.rows_copied}',
        f'- Rows skipped: {len(rep.skipped_rows)} (' + (', '.join(f'{k}: {v}' for k, v in sorted(skip_counts.items())) or 'none') + ')',
    ]
    if rep.counts['incomplete_key']:
        lines.append(f"- Rows copied with an incomplete key: {rep.counts['incomplete_key']} (not deduplicated; a second upload would repeat them)")
    labels = [('changed', 'Cells changed by normalisation'),
              ('date_day_first_assumed', 'Text dates read day first (dd/mm/yyyy), to be checked by L2'),
              ('date_month_first_assumed', 'Text dates read month first (--month-first), to be checked by L2'),
              ('needs_delivery_team', 'Cells the Procurement team completes in GSDN Workspace before submitting'), ('blanked', 'Cells blanked (N/A, Pending, Cancelled or empty text)'),
              ('outside_list', 'Values outside their list (copied as found)'), ('not_normalised', 'Values GSDN Workspace may refuse (copied as found)'),
              ('date_outside_range', 'Dates outside 2020-2035'), ('master_header_not_found', 'Mapped Master headers not found'),
              ('map_unknown_template_header', 'Mapping rows whose template header does not exist')]
    for ev, label in labels:
        n = rep.counts[ev]
        if not n:
            continue
        addrs = [e['cell'] or e['header'] for e in rep.events if e['event'] == ev]
        shown = ', '.join(addrs[:ADDR_CAP]) + (f' ... (+{len(addrs) - ADDR_CAP} more)' if len(addrs) > ADDR_CAP else '')
        lines.append(f'- {label}: {n}. {shown}')
    if rep.skipped_rows:
        lines += ['', '## Rows skipped (Master row numbers)']
        for why in sorted(skip_counts):
            rows = [str(r) for r, w in rep.skipped_rows if w == why]
            lines.append(f"- {why}: {', '.join(rows[:ADDR_CAP])}" + (f' ... (+{len(rows) - ADDR_CAP} more)' if len(rows) > ADDR_CAP else ''))
    if rep.per_column:
        lines += ['', '## Cells left blank, by template column', '', '| Column | Left blank | Not in the mapping | Personal, skipped | Grey, not filled |', '|---|---|---|---|---|']
        for h, c in rep.per_column.items():
            lines.append(f"| {h} | {c['blank']} | {c['no_source']} | {c['personal_skipped']} | {c['grey_not_filled']} |")
    if master_facts.get('external_links'):
        lines += ['', 'Note: the Master workbook carries an external-link part. It was not followed.']
    lines += ['', 'Next: upload this filled template in GSDN Workspace Templates page. It becomes one batch for L1, then L2.', '']
    md.write_text('\n'.join(lines), encoding='utf-8')
    return csv_path, md


# ---------------------------------------------------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Fill PMIS-issued register templates from the owner Master workbook.')
    ap.add_argument('templates', nargs='+', help='blank templates downloaded from GSDN Workspace (each with its _tpl sheet)')
    ap.add_argument('--master', required=True, help="the owner's Master workbook (.xlsx, values only)")
    ap.add_argument('--out', required=True, help='output folder (filled templates and reports)')
    ap.add_argument('--maps', default=str(DEFAULT_MAPS), help='folder with index.csv and one CSV per register')
    ap.add_argument('--include-personal', action='store_true', help='also copy landlord, contact, phone and e-mail columns (default off, decision Q469)')
    ap.add_argument('--month-first', action='store_true', help='read text dates with day and month both 12 or less as mm/dd/yyyy (default: dd/mm/yyyy)')
    ap.add_argument('--master-sheet', default='Master', help='sheet that lists the valid Site IDs')
    ap.add_argument('--master-site-col', default='B')
    ap.add_argument('--master-first-row', type=int, default=5)
    ap.add_argument('--no-site-check', action='store_true', help='do not check Site IDs against the Master sheet')
    a = ap.parse_args(argv)

    master_path = Path(a.master).resolve()
    tpl_paths = [Path(t).resolve() for t in a.templates]
    out_dir = Path(a.out).resolve()
    inputs = {master_path, *tpl_paths}
    try:
        if not master_path.is_file():
            raise Refused(f'{master_path.name}: not found')
        registers = load_registers(Path(a.maps))
        templates = []
        for p in tpl_paths:
            if not p.is_file():
                raise Refused(f'{p.name}: not found')
            templates.append(Template(p))  # refuses before anything is written
        ids = [t.template_id for t in templates]
        if len(set(ids)) != len(ids):
            raise Refused('two templates with the same template_id were given')
        plans = []
        for t in templates:
            base = f'{t.template_id}_v{t.version}'
            target = out_dir / f'{base}_filled.xlsx'
            if target.resolve() in inputs or any(target.exists() and os.path.samefile(target, i) for i in inputs if i.exists()):
                raise Refused(f'{target.name}: would overwrite an input file; choose another output folder')
            if target.exists():
                raise Refused(f'{target}: already exists; choose a new output folder')
            plans.append((t, base, target))
        book = MasterBook(master_path)
    except Refused as e:
        sys.stderr.write(f'REFUSED: {e}\n')
        return 2

    if a.include_personal:
        sys.stderr.write('WARNING: --include-personal copies landlord, contact, phone and e-mail data. Only a System Admin may run it, on the server or an Aljeel machine, never a personal device (Q469, Q492).\n')
    out_dir.mkdir(parents=True, exist_ok=True)
    master_ids = None
    if not a.no_site_check:
        if not book.has(a.master_sheet):
            sys.stderr.write(f'REFUSED: the Master workbook has no sheet "{a.master_sheet}" (use --no-site-check to skip the Site ID check)\n')
            return 2
        master_ids = site_ids_of_master(book, a.master_sheet, a.master_site_col, a.master_first_row)

    status = 0
    for t, base, target in plans:
        reg = registers.get(t.template_id)
        if reg is None:
            print(f'{t.path.name}: no mapping for {t.template_id}; skipped')
            status = max(status, 1)
            continue
        if not book.has(reg['master_sheet']):
            print(f"{t.path.name}: Master sheet \"{reg['master_sheet']}\" not found; skipped")
            status = max(status, 1)
            continue
        try:
            rep = fill(t, reg, book, master_ids, a.include_personal, a.month_first)
        except Refused as e:
            sys.stderr.write(f'REFUSED: {e}\n')
            return 2
        before = dict(t.kv)
        t.wb.save(target)
        # _tpl must be exactly as issued
        check = openpyxl.load_workbook(target, data_only=False, keep_links=False)
        after = {str(r[0]).strip(): ('' if r[1] is None else str(r[1]).strip()) for r in check[TPL_SHEET].iter_rows(min_row=1, max_col=2, values_only=True) if r[0] is not None}
        if after != before:  # pragma: no cover
            target.unlink()
            sys.stderr.write(f'REFUSED: {t.template_id}: _tpl changed while saving; nothing written\n')
            return 2
        csv_path, md = write_reports(out_dir, base, t, reg, rep, a.include_personal, book.facts)
        print(f"{t.template_id} v{t.version}: {rep.rows_copied} rows copied, {len(rep.skipped_rows)} skipped, "
              f"{rep.counts['changed']} cells changed, {rep.counts['outside_list']} outside lists -> {target.name}, {csv_path.name}, {md.name}")
    return status


if __name__ == '__main__':
    sys.exit(main())
