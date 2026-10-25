import base64,re,sys
import os
P=os.path.dirname(os.path.abspath(__file__))+'/'
D=os.path.dirname(P.rstrip('/'))+'/'
def rd(p):return open(p).read().strip()
fonts=''
rng={'arabic':'U+0600-06FF,U+0750-077F,U+08A0-08FF,U+200C-200E,U+FB50-FDFF,U+FE70-FEFC','latin':'U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212'}
for sc in ['arabic','latin']:
    for w in [400,700]:
        fonts+="@font-face{font-family:'Cairo';font-style:normal;font-weight:%d;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2');unicode-range:%s}\n"%(w,rd(D+'prototype-v2/f_%s-%d.b64'%(sc,w)),rng[sc])
data=open(D+'prototype-v2/data.js').read()
import csv,json
REG=list(csv.DictReader(open(D+'../db/seed/staff-registry.draft.csv',encoding='utf-8')))
data+='\nconst REGISTRY='+json.dumps(REG,ensure_ascii=False).replace('<','\\u003c')+';\n'
HOL=list(csv.DictReader(open(D+'../db/seed/holidays-2026-2027.csv',encoding='utf-8')))
data+='const HOLIDAYS='+json.dumps(HOL,ensure_ascii=False).replace('<','\\u003c')+';\n'
js=''.join(open(P+f).read()+'\n' for f in ['i18n.js','core.js','people.js','flow.js','shell.js','views1.js','views2.js','views3.js','views4.js','main.js','views5.js','views6.js','boot.js'])
html='''<!doctype html>
<html lang="en" dir="ltr" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GSDN PMIS · Prototype v2</title>
<!-- GSDN PMIS prototype v2. Single file, offline, vanilla JS, no external requests. Tokens: frappe-ui@1.0.2 (MIT) via tokens.css. All data is synthetic. -->
<style>
%s
%s
%s
</style></head><body><a class="sr" href="#page">Skip to content</a><div id="app"></div><div id="toasts" class="toasts" aria-live="polite"></div>
<script>
%s
%s
</script></body></html>'''%(fonts,open(D+'tokens.css').read(),open(P+'app.css').read(),data,js)
open(D+'GSDN_PMIS_Prototype_v2.html','w').write(html)
print(len(html))
