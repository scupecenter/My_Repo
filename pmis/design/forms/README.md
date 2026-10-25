# CW forms: auto-fill templates

The owner's approved forms in `source/` are the origin. `templates/*.tpl.html` are the same forms with placeholders and repeating blocks, rendered to A4 PDF by headless Chromium.

| Path | Purpose |
|---|---|
| `templates/` | The four auto-fill templates. They are generated from `source/` by `build/make_templates.py`. The head (CSS, fonts, logo) is copied unchanged. |
| `bindings.md` | Every placeholder, its schema source and its rule. |
| `items-seed.csv` | CW item master seed (CW-001..CW-028, from the DN/RN lists). |
| `samples/`, `out/` | Synthetic data, and the PDFs and page-1 PNGs rendered from it. |
| `render.js` | `node render.js <tpl> <data.json> [out.pdf] [--png] [--verify]`. |

Run `npm i && npm run render`. Playwright is found through `require('playwright')`, or through `PLAYWRIGHT_NODE_PATH`. `--png` needs `pdftoppm` and `--verify` needs `pdftotext` (poppler-utils). `RENDER_MINI=1` forces the built-in mini renderer, which gives the same output.

## Adding a TE form later (no code change)

1. **Drop in the template.** Open the Document Library in the admin screen, create an entry of kind "generated form", and upload the HTML (self-contained: inline CSS, fonts and logo as data URIs). Use only `{{x}}`, `{{{x}}}`, `{{#each}}` and `{{#if}}`. Copy the pagination block from any CW template: `thead` for the header row, `@page` margin boxes for "Page X of Y", `break-inside: avoid` on rows.
2. **Define the bindings.** In the same entry, map each placeholder to a data source from the binding catalogue (site, contractor, register fields, matrix signatories, movement lines, snags, linked document). The admin also sets the guard conditions in the entry (e.g. "no open snags"). Classify the document as issued by Aljeel, vendor-issued (upload only) or jointly signed.
3. **Set the number sequence.** Set a pattern such as `PAC-TE-{REGION}-{YYYY}-{NNNN}`, its scope and its reset rule.
4. Publish. The form appears on the site task slot. Each PDF records the template version.

## What the engine needs

- **A binding catalogue**: named, permission-checked resolvers (`site.*`, `contractor.*`, `procurement.*`, `matrix.signatories.<stage>`, `register.<module>.<field>`, `lines.<movement>`, `snags`, `linked_form.<code>`, plus custom fields). The catalogue is data, so a new template only selects from it. A new resolver kind is the only thing that needs code.
- **Derived flag maps** (`*_is.<value>`) built from a list field, because the template syntax has no comparison. The binding says "flags of field X".
- **A guard evaluator**: rules stored with the document type (conditions on counts and states), reusing the Document Library `condition_rule` format.
- **Tables** (`generated_forms`, `number_sequences`, `template_versions` for forms), with a transaction-safe number allocator (never reused).
- **Renderer service**: one Chromium instance and a queue, with the template version pinned to each PDF. Derived fields are added as in `render.js` (`doc.qr_svg_uri`, `*_css`). Chromium 131 or later is required for `@page` margin boxes. Fonts must be embedded, so the output does not depend on the server.
- **Escaping**: the margin-box text goes into a CSS string. The engine strips quotes, backslashes and angle brackets from it.
- **Audit** of generate, void and download.
