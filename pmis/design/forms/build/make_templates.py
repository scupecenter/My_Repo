#!/usr/bin/env python3
"""Builds templates/GSDN_CW_*.tpl.html from the owner's approved forms in source/.
Head (CSS, fonts, logo) is copied verbatim; the body inputs are replaced in document order
by placeholders; item tables become repeating blocks. Re-run after any change to a source form.
Usage: python3 -I build/make_templates.py   (from pmis/design/forms)"""
import re, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / 'source', ROOT / 'templates'

OVERRIDES = """
<style id="tpl-overrides">
/* ===== template overrides (added for auto-fill rendering; everything above is the approved form) ===== */
@page{ size:A4; margin:9mm 12mm 17mm 12mm;
  @bottom-left{ content:url("{{{doc.qr_svg_uri}}}") "  %%LABEL%% · {{{doc.ref_no_css}}} · template {{{template.code_css}}} v{{{template.version_css}}}";
    font-family:'Inter','Cairo',sans-serif; font-size:9px; color:#5f6b78; vertical-align:middle; text-align:left; white-space:nowrap; }
  @bottom-right{ content:"Page " counter(page) " of " counter(pages); font-family:'Inter','Cairo',sans-serif; font-size:9.5px; color:#5f6b78; vertical-align:middle; } }
.sheet{ display:block; height:auto; min-height:0; overflow:visible; }
.v{ display:block; min-height:15px; line-height:1.35; }
span.fin.v{ background:transparent; }
.sig .row .ln.v, .role-fill .ln.v{ height:auto; min-height:13px; line-height:1.25; font-size:11px; color:#0b3550; padding:0 3px; }
.sig .row .ln.v{ display:block; }
.role-fill .ln.v{ display:block; }
.fta.v-box{ white-space:pre-wrap; background:#fbfdff; }
.rmk.v-box{ white-space:pre-wrap; }
.sn{ font-size:9.5px; color:#44505c; line-height:1.3; }
thead{ display:table-header-group; }
tfoot{ display:table-footer-group; }
table.t tr, table.kv tr, .sig td{ break-inside:avoid; page-break-inside:avoid; }
@media print{
  body{ background:#fff; }
  .sheet{ padding:0; width:auto; height:auto; min-height:0; margin:0; box-shadow:none; }
  .sheet + .sheet{ page-break-before:auto; break-before:auto; }
}
</style>
"""

def foot(label):
    return ""

LABELS = {'DN':'GSDN CW DN','RN':'GSDN CW RN','PAC':'GSDN CW PAC','FAC':'GSDN CW FAC'}
def V(x): return ('v', x)
SIG = ('blank',)
def CB(x): return ('cb', x)
def TA(x, rows): return ('ta', x, rows)

def fill(html, queue):
    q = list(queue)
    def rep_in(m):
        tag = m.group(0)
        if not q: raise SystemExit('queue exhausted at: ' + tag)
        it = q.pop(0)
        if 'type="checkbox"' in tag:
            assert it[0] == 'cb', (it, tag)
            return '<input type="checkbox" {{#if %s}}checked{{/if}}>' % it[1]
        assert it[0] in ('v', 'blank'), (it, tag)
        cls = 'ln' if 'class="ln"' in tag else 'fin'
        if it[0] == 'blank':
            return '<span class="ln"></span>'
        st = re.search(r'style="([^"]*)"', tag)
        st = ' style="%s"' % st.group(1) if st else ''
        return '<span class="%s v"%s dir="auto">{{%s}}</span>' % (cls, st, it[1])
    html = re.sub(r'<input\b[^>]*>', rep_in, html)
    def rep_ta(m):
        it = q.pop(0)
        assert it[0] == 'ta', it
        cls = 'rmk' if 'class="rmk"' in m.group(0) else 'fta'
        return '<div class="%s v-box" style="min-height:%dpx" dir="auto">{{%s}}</div>' % (cls, int(it[2]) * 16 + 8, it[1])
    html = re.sub(r'<textarea\b[^>]*>\s*</textarea>', rep_ta, html)
    return html, q

def fill_all(html, queue):
    # inputs and textareas are consumed in document order, so run one combined pass
    pos = [(m.start(), m.group(0)) for m in re.finditer(r'<input\b[^>]*>|<textarea\b[^>]*>\s*</textarea>', html)]
    assert len(pos) == len(queue), 'placeholder count %d != queue %d' % (len(pos), len(queue))
    q = iter(queue)
    def rep(m):
        tag, it = m.group(0), next(q)
        if tag.startswith('<textarea'):
            assert it[0] == 'ta', (it, tag)
            cls = 'rmk' if 'class="rmk"' in tag else 'fta'
            return '<div class="%s v-box" style="min-height:%dpx" dir="auto">{{%s}}</div>' % (cls, it[2] * 16 + 8, it[1])
        if 'type="checkbox"' in tag:
            assert it[0] == 'cb', (it, tag)
            return '<input type="checkbox" {{#if %s}}checked{{/if}}>' % it[1]
        assert it[0] in ('v', 'blank'), (it, tag)
        if it[0] == 'blank': return '<span class="ln"></span>'
        cls = 'ln' if 'class="ln"' in tag else 'fin'
        st = re.search(r'style="([^"]*)"', tag)
        st = ' style="%s"' % st.group(1) if st else ''
        return '<span class="%s v"%s dir="auto">{{%s}}</span>' % (cls, st, it[1])
    return re.sub(r'<input\b[^>]*>|<textarea\b[^>]*>\s*</textarea>', rep, html)

REG = ['Tripoli', 'Middle', 'Zawia', 'WM', 'Sebha', 'Benghazi', 'GM']          # DN/RN label order
REG_PAC = ['Tripoli', 'Middle', 'Zawia', 'WM', 'Sebha', 'Benghazi', 'GM']      # labels Zawya/Sabha, same codes
region_cbs = [CB('site.region_is.' + c) for c in REG]

def split_src(name):
    s = (SRC / ('GSDN_CW_%s.html' % name)).read_text(encoding='utf-8')
    head, body = s.split('</head>', 1)
    body = body.split('<body>', 1)[1].rsplit('</body>', 1)[0]
    return head, body

def write(name, head, body):
    html = head + OVERRIDES.replace('%%LABEL%%', LABELS[name]) + '</head>\n<body>\n' + body.strip() + '\n</body>\n</html>\n'
    html = html.replace('<title>', '<title>', 1)
    (OUT / ('GSDN_CW_%s.tpl.html' % name)).write_text(html, encoding='utf-8')
    print(name, len(html))

def cut(s, a, b=None):
    i = s.index(a); j = s.index(b, i) if b else len(s)
    return s[:i], s[i:j], s[j:]

# ---------------------------------------------------------------- DN / RN
def build_move(name, ref_label):
    head, body = split_src(name)
    s1, s2 = body.split('</div>\n<div class="sheet">', 1) if '</div>\n<div class="sheet">' in body else (None, None)
    s1 = s1.strip() + '</div>'
    # section 1 (up to the item table)
    pre, _, _ = cut(s1, '<div class="sec"><span class="n">2.')
    pre = pre.replace('<div class="sheet">', '<div class="sheet">', 1)
    if name == 'DN':
        q = [V('doc.ref_no'), V('doc.date'), V('site.id'), V('site.name')] + region_cbs + \
            [V('contractor.name'), V('site.po_wo'), V('warehouse.name'), V('doc.dispatch_date')]
        sec2 = ('<div class="sec"><span class="n">2.</span>Material Description (Issued to Site)</div>'
          '<table class="t items"><thead><tr><th style="width:6%">No.</th><th style="">Item Description</th><th style="width:8%">UOM</th>'
          '<th style="width:14%">Qty Approved</th><th style="width:14%">Qty Dispatched</th></tr></thead><tbody>'
          '{{#each lines}}<tr><td class="c">{{no}}</td><td class="pp">{{description}}{{#if serials}}<div class="sn">S/N: {{serials}}</div>{{/if}}</td>'
          '<td class="u">{{uom}}</td><td class="c">{{qty_approved}}</td><td class="c">{{qty_dispatched}}</td></tr>{{/each}}'
          '{{#each blank_rows}}<tr class="blank"><td class="c">{{no}}</td><td></td><td></td><td></td><td></td></tr>{{/each}}'
          '</tbody></table>')
        who = [('applicant', 'Applicant'), ('reviewer_se', None), ('approver_inventory', None)]
    else:
        q = [V('doc.ref_no'), V('doc.date'), V('site.id'), V('site.name')] + region_cbs + \
            [V('contractor.name'), V('dismantle.date'), V('site.po_wo'), V('dismantle.po_wo'), V('warehouse.name'),
             CB('rn.reason_is.faulty'), CB('rn.reason_is.relocation'), CB('rn.reason_is.cancellation'), CB('rn.reason_is.other'), V('rn.reason_other')]
        sec2 = ('<div class="sec"><span class="n">2.</span>Material Description (Returned to Warehouse)</div>'
          '<table class="t items"><thead><tr><th style="width:6%">No.</th><th style="">Item Description</th><th style="width:8%">UOM</th>'
          '<th style="width:9%">QTY</th><th style="width:25%">Condition</th></tr></thead><tbody>'
          '{{#each lines}}<tr><td class="c">{{no}}</td><td class="pp">{{description}}{{#if serials}}<div class="sn">S/N: {{serials}}</div>{{/if}}</td>'
          '<td class="u">{{uom}}</td><td class="c">{{qty}}</td><td><div class="cond-cell"><label><input type="checkbox" {{#if is_good}}checked{{/if}}>Good</label>'
          '<label><input type="checkbox" {{#if is_faulty}}checked{{/if}}>Faulty / Damaged</label></div></td></tr>{{/each}}'
          '{{#each blank_rows}}<tr class="blank"><td class="c">{{no}}</td><td></td><td></td><td></td><td><div class="cond-cell"><label><input type="checkbox">Good</label>'
          '<label><input type="checkbox">Faulty / Damaged</label></div></td></tr>{{/each}}'
          '</tbody></table>')
    pre = fill_all(pre, q)
    # second page: remarks + signatures
    _, tail, _ = cut(s2, '<div class="rmk-lab">', '<div class="foot">')
    sig_who = ['applicant', 'reviewer_se', 'approver_inventory']
    tq = [TA('doc.remarks', 5)]
    for w in sig_who: tq += [V('signatories.%s.name' % w), V('signatories.%s.date' % w), SIG]
    tail = fill_all(tail, tq)
    # keep remarks+signatures together
    tail = '<div class="keep">' + tail + '</div>'
    body = pre + sec2 + tail + foot('GSDN CW &middot; %s' % name)
    # sheet wrapper: pre starts with <div class="sheet">; close it
    body += '</div>'
    write(name, head, body)

# ---------------------------------------------------------------- PAC
def build_pac():
    head, body = split_src('PAC')
    a, mid, rest = cut(body, '<div class="sec page-before"><span class="n">5.', None)
    # part A: everything before the checklist (sections 1-4)
    q = [V('doc.ref_no'), V('doc.date'), V('site.id'), V('site.po_wo'), V('contractor.name')] + region_cbs + \
        [CB('site.tower_is.GF_SST'), CB('site.tower_is.RT_GMT'), CB('site.tower_is.RT_Pole'), CB('site.tower_is.Other'),
         V('site.tower_height_m'), V('site.name'), V('site.latitude'), V('site.longitude'),
         CB('site.sow_is.erection'), CB('site.sow_is.adaption'), CB('site.sow_is.both'),
         V('site.cw_start_date'), V('site.cw_finish_date'),
         CB('site.schedule_is.ahead'), CB('site.schedule_is.behind'), CB('site.schedule_is.on'),
         CB('pac.statement_is.accepted'), CB('pac.statement_is.with_snags'), CB('pac.statement_is.not_accepted'), TA('doc.remarks', 2),
         V('pac.dlp_start'), V('pac.dlp_expiry'), V('pac.dlp_duration'),
         V('contractor.name'), V('signatories.contractor.name'), V('signatories.contractor.position'), V('signatories.contractor.date'), SIG,
         V('signatories.site_engineer.name'), V('signatories.site_engineer.date'), SIG,
         V('signatories.cw_team_lead.name'), V('signatories.cw_team_lead.date'), SIG,
         V('signatories.project_manager.name'), V('signatories.project_manager.date'), SIG]
    a = fill_all(a, q)
    # part B: checklist (static, ticked by hand) | snags | BoQ | remarks
    chk, _, rest2 = cut(mid, '<div class="sec"><span class="n">6.')
    chk = chk.replace('(____) Ohm', '({{#if checks.ground_ohm}}{{checks.ground_ohm}}{{else}}____{{/if}}) Ohm')
    assert 'checks.ground_ohm' in chk
    snag = ('<div class="sec"><span class="n">6.</span>Snag / Punch List (Defects &amp; Closure)</div>'
      '<table class="t"><thead><tr><th style="width:11%">Snag No.</th><th>Description of Defect / Non-Conformance</th><th style="width:14%">Raised Date</th>'
      '<th style="width:12%">Closed Date</th><th style="width:12%">Verified by</th><th style="width:12%">Status</th></tr></thead><tbody>'
      '{{#each snags}}<tr><td class="c">{{no}}</td><td>{{description}}</td><td class="c">{{raised_date}}</td><td class="c">{{closed_date}}</td>'
      '<td class="c">{{verified_by}}</td><td class="c">{{status}}</td></tr>'
      '{{else}}<tr><td class="c">&mdash;</td><td colspan="5">No snags recorded.</td></tr>{{/each}}</tbody></table>')
    boq = ('<div class="sec"><span class="n">7.</span>Accepted Item List (BoQ)</div>'
      '<table class="t"><thead><tr><th style="width:7%">No.</th><th style="width:20%">Item Code</th><th>Item Description</th><th style="width:10%">UOM</th>'
      '<th style="width:10%">QTY</th><th style="width:13%">Remark</th></tr></thead><tbody>'
      '{{#each boq}}<tr><td class="c">{{no}}</td><td>{{item_code}}</td><td>{{description}}</td><td class="c">{{uom}}</td><td class="c">{{qty}}</td><td>{{remark}}</td></tr>{{/each}}'
      '{{#each blank_rows}}<tr class="blank"><td class="c">{{no}}</td><td></td><td></td><td></td><td></td><td></td></tr>{{/each}}</tbody></table>')
    rem = '<div class="keep"><div style="margin-top:8px;font-size:11px"><b style="color:#005088">Remarks:</b></div><div class="fta v-box" style="min-height:120px" dir="auto">{{pac.final_remarks}}</div></div>'
    body = a + chk + snag + boq + rem + foot('GSDN CW Acceptance &middot; PAC') + '</div>'
    write('PAC', head, body)

# ---------------------------------------------------------------- FAC
def build_fac():
    head, body = split_src('FAC')
    q = [V('doc.ref_no'), V('doc.date'), V('site.id'), V('site.po_wo'), V('contractor.name'), V('site.tower_type'), V('site.region_name'),
         V('pac.ref_no'), V('pac.date'), V('pac.dlp_start'), V('pac.dlp_expiry'),
         CB('fac.recommendation_is.recommended'), CB('fac.recommendation_is.not_recommended'),
         CB('fac.decision_is.granted'), CB('fac.decision_is.withheld'), TA('doc.remarks', 10),
         V('signatories.cw_team_lead.name'), V('signatories.cw_team_lead.date'), SIG,
         V('signatories.project_manager.name'), V('signatories.project_manager.date'), SIG]
    body = fill_all(body, q)
    i = body.index('<div class="keep">\n<div class="foot">')
    body = body[:i] + foot('GSDN CW Acceptance &middot; FAC')
    body = body.rstrip() + '</div>'
    write('FAC', head, body)

OUT.mkdir(exist_ok=True)
build_move('DN', 'DN'); build_move('RN', 'RN'); build_pac(); build_fac()
