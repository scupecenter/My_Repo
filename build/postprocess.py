"""Final packaging pass: shared formulas, merged validation / conditional-format rules, unused names dropped.

A run of consecutive cells in one column becomes one shared formula only if every cell's formula is
exactly the first cell's formula shifted by its row offset (verified with openpyxl's Translator).
Formulas that reference another sheet ("!") stay unshared: Excel rejects shared formulas holding
3D references and repairs the file on open. Rewriting them as INDEX(name,ROW()-k) to keep them
shared made Excel 365 crash on open, so they are written in full.
"""
import re
import shutil
import sys
import zipfile

from lxml import etree
from openpyxl.formula.translate import Translator
from openpyxl.utils import get_column_letter, range_boundaries

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
Q = "{%s}" % NS
REF = re.compile(r"([A-Z]+)(\d+)")
def share(xml):
    root = etree.fromstring(xml)
    cols = {}
    for c in root.iter(Q + "c"):
        f = c.find(Q + "f")
        if f is None or f.get("t") or not f.text:
            continue
        if "!" in f.text:
            continue
        m = REF.fullmatch(c.get("r"))
        cols.setdefault(m.group(1), []).append((int(m.group(2)), c, f))
    si = 0
    shared = 0
    for col, cells in cols.items():
        cells.sort(key=lambda x: x[0])
        i = 0
        while i < len(cells):
            r0, c0, f0 = cells[i]
            base = "=" + f0.text
            run = [cells[i]]
            j = i + 1
            while j < len(cells) and cells[j][0] == run[-1][0] + 1:
                rj, cj, fj = cells[j]
                if Translator(base, origin=f"{col}{r0}").translate_formula(f"{col}{rj}") != "=" + fj.text:
                    break
                run.append(cells[j])
                j += 1
            if len(run) >= 3:
                f0.set("t", "shared")
                f0.set("ref", f"{col}{r0}:{col}{run[-1][0]}")
                f0.set("si", str(si))
                for _, cj, fj in run[1:]:
                    fj.text = None
                    fj.set("t", "shared")
                    fj.set("si", str(si))
                    shared += 1
                si += 1
            i = j
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), shared


def merge_validations(root):
    """One <dataValidation> per identical rule (all rules here use names or constants, no relative
    references), and list sources written without the leading '=' as Excel itself stores them."""
    dvs = root.find(Q + "dataValidations")
    if dvs is None:
        return 0
    groups = {}
    for dv in list(dvs):
        for f in dv:
            if f.text and f.text.startswith("="):
                f.text = f.text[1:]
        key = (tuple(sorted((k, v) for k, v in dv.attrib.items() if k != "sqref")),
               tuple((f.tag, f.text) for f in dv))
        if key in groups:
            groups[key].set("sqref", groups[key].get("sqref") + " " + dv.get("sqref"))
            dvs.remove(dv)
        else:
            groups[key] = dv
    dvs.set("count", str(len(dvs)))
    return len(groups)


def _top_left(sqref):
    b = [range_boundaries(p) for p in sqref.split()]
    return min(x[0] for x in b), min(x[1] for x in b)


def _cf_pass(root, part):
    groups = {}
    for b in root.findall(Q + "conditionalFormatting"):
        rules = b.findall(Q + "cfRule")
        if len(rules) != 1:
            continue
        rule = rules[0]
        c, r = _top_left(b.get("sqref"))
        origin = get_column_letter(c) + str(r)
        target = "GJH500000"         # one fixed far cell: equal relative offsets give equal text
        forms = tuple(Translator("=" + (f.text or ""), origin=origin).translate_formula(target)
                      for f in rule.findall(Q + "formula"))
        extra = tuple(etree.tostring(e) for e in rule if e.tag != Q + "formula")   # colour scales, icons
        key = (tuple(sorted((k, v) for k, v in rule.attrib.items() if k != "priority")), forms, extra,
               part(c, r))
        groups.setdefault(key, []).append((c, r, b))
    merged = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        c0 = min(m[0] for m in members)
        r0 = min(m[1] for m in members)
        anchor = next((m for m in members if m[0] == c0 and m[1] == r0), None)
        if anchor is None:
            continue
        keep = anchor[2]
        keep.set("sqref", " ".join([keep.get("sqref")] + [m[2].get("sqref") for m in members if m[2] is not keep]))
        for m in members:
            if m[2] is not keep:
                root.remove(m[2])
                merged += 1
    return merged


def merge_conditional_formats(root):
    """Blocks whose single rule is the same once its formula is read relative to the block's top-left cell
    become one block: first down each column, then along each row. A group merges only around a block that
    sits at the group's overall top-left, so the kept formula is relative to the same cell however Excel
    anchors a multi-range rule."""
    return _cf_pass(root, lambda c, r: ("col", c)) + _cf_pass(root, lambda c, r: ("row", r))


NAME_TOKEN = re.compile(r"[A-Za-z_\\][\w.]*")


def drop_unused_names(workbook_xml, texts):
    """Remove defined names that no formula, validation, rule, table or other name uses."""
    root = etree.fromstring(workbook_xml)
    dn = root.find(Q + "definedNames")
    if dn is None:
        return workbook_xml, 0
    used = set()
    for t in texts:
        used.update(w.upper() for w in NAME_TOKEN.findall(t))
    removed = 0
    changed = True
    while changed:                        # a name only used by a removed name goes too
        changed = False
        refs = {}
        for d in dn:
            for w in set(NAME_TOKEN.findall(d.text or "")):
                refs.setdefault(w.upper(), set()).add(d.get("name").upper())
        for d in list(dn):
            n = d.get("name").upper()
            if d.get("name").startswith("_xlnm.") or d.get("localSheetId") is not None:
                continue
            if n not in used and not (refs.get(n, set()) - {n}):
                dn.remove(d)
                removed += 1
                changed = True
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), removed


def main(src, dst):
    tmp = dst + ".tmp"
    total = 0
    parts = {}
    texts = []
    cf = 0
    with zipfile.ZipFile(src) as zin:
        items = zin.infolist()
        for item in items:
            data = zin.read(item.filename)
            if item.filename.startswith("xl/worksheets/sheet") and item.filename.endswith(".xml"):
                root = etree.fromstring(data)
                merge_validations(root)
                cf += merge_conditional_formats(root)
                for el in root.iter(Q + "f", Q + "formula1", Q + "formula2", Q + "formula"):
                    texts.append(el.text or "")
                data, n = share(etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True))
                total += n
            elif item.filename.startswith("xl/tables/"):
                texts.append(data.decode())
            parts[item.filename] = data
    parts["xl/workbook.xml"], removed = drop_unused_names(parts["xl/workbook.xml"], texts)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
        for item in items:
            zout.writestr(item, parts[item.filename], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    shutil.move(tmp, dst)
    print("shared formula cells:", total, "| merged rule blocks:", cf, "| unused names removed:", removed)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
