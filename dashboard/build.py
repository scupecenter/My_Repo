"""Assemble the single-file offline dashboard: shell + CSS (fonts inlined) + SheetJS + app."""
import base64
import pathlib
import re

SRC = pathlib.Path(__file__).parent / "src"
OUT = pathlib.Path(__file__).parent / "GSDN_Dashboard.html"

css = (SRC / "app.css").read_text(encoding="utf-8")
for f in (SRC / "fonts").glob("*.woff2"):
    css = css.replace("@@" + f.stem + "@@", base64.b64encode(f.read_bytes()).decode())
assert "@@" not in css, re.findall(r"@@[\w-]+@@", css)

app = (SRC / "app.js").read_text(encoding="utf-8")
icons = dict(re.findall(r'(\w+): svgIcon\(\'(.*?)\'\)', app))


def icon(name):
    return ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
            'stroke-linejoin="round">' + icons[name] + "</svg>")


mark = re.search(r"const MARK = `(.*?)`;", app).group(1)
html = (SRC / "shell.html").read_text(encoding="utf-8")
parts = {"CSS": css, "SHEETJS": (SRC / "sheetjs.html").read_text(encoding="utf-8"), "MARK": mark,
         "PRINT": icon("print"), "FILE": icon("file"), "LIBYA": (SRC / "libya.js").read_text(encoding="utf-8"), "APP": app}
for k, v in parts.items():
    html = html.replace("@@" + k + "@@", v)
OUT.write_text(html, encoding="utf-8")
print(OUT, round(OUT.stat().st_size / 1024), "KB")
