"""Store repeated column formulas as Excel shared formulas (same calculation, much smaller file).

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


def main(src, dst):
    tmp = dst + ".tmp"
    total = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename.startswith("xl/worksheets/sheet") and item.filename.endswith(".xml"):
                data, n = share(data)
                total += n
            zout.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    shutil.move(tmp, dst)
    print("shared formula cells:", total)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
