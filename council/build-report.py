#!/usr/bin/env python3
"""Assemble the council HTML report and Markdown transcript from the files in this folder."""
import html, json, re, datetime, pathlib
D = pathlib.Path(__file__).parent
ts = datetime.datetime.utcnow().strftime('%Y-%m-%d-%H%M')
m = json.load(open(D/'anonymization-map.json'))
names = {'contrarian':'The Contrarian','first-principles':'The First Principles Thinker','expansionist':'The Expansionist','outsider':'The Outsider','executor':'The Executor'}
colors = {'contrarian':'#c2410c','first-principles':'#1d4ed8','expansionist':'#15803d','outsider':'#7c3aed','executor':'#b45309'}
question = (D/'framed-question.md').read_text().strip()
verdict = (D/'verdict.md').read_text().strip()
advisors = {k:(D/f'advisor-{k}.md').read_text().strip() for k in names}
reviews = [(l,(D/f).read_text().strip()) for f,l in [('review-1-general.md','Reviewer 1: general'),('review-2-affiliate.md','Reviewer 2: affiliate-site operator'),('review-3-product-analyst.md','Reviewer 3: product analyst'),('review-4-solo-founder.md','Reviewer 4: solo founder'),('review-5-seo.md','Reviewer 5: SEO and search quality')]]

def md(text):
    """Tiny Markdown: headings, bold, bullets, paragraphs."""
    out=[]; lines=text.split('\n'); i=0
    while i < len(lines):
        l=lines[i]
        if l.startswith('## '): out.append(f'<h2>{html.escape(l[3:])}</h2>'); i+=1; continue
        if l.startswith('### '): out.append(f'<h3>{html.escape(l[4:])}</h3>'); i+=1; continue
        if re.match(r'^\s*[-*] ', l):
            items=[]
            while i < len(lines) and re.match(r'^\s*[-*] ', lines[i]): items.append(re.sub(r'^\s*[-*] ','',lines[i])); i+=1
            out.append('<ul>'+''.join(f'<li>{inline(x)}</li>' for x in items)+'</ul>'); continue
        if re.match(r'^\s*\d+\. ', l):
            items=[]
            while i < len(lines) and re.match(r'^\s*\d+\. ', lines[i]): items.append(re.sub(r'^\s*\d+\. ','',lines[i])); i+=1
            out.append('<ol>'+''.join(f'<li>{inline(x)}</li>' for x in items)+'</ol>'); continue
        if not l.strip(): i+=1; continue
        para=[l]; i+=1
        while i < len(lines) and lines[i].strip() and not lines[i].startswith('#') and not re.match(r'^\s*([-*]|\d+\.) ', lines[i]): para.append(lines[i]); i+=1
        out.append(f'<p>{inline(" ".join(para))}</p>')
    return '\n'.join(out)
def inline(s):
    s=html.escape(s)
    s=re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s=re.sub(r'\*(.+?)\*', r'<em>\1</em>', s)
    return s

# position grid: which option each advisor backs first / calls a trap (hand-coded from the responses)
positions = {
 'contrarian':      {'A':'trap','B':'later','C':'test by hand','D':'trap','E':'trap','first':'Measure, then result-page conversion'},
 'first-principles':{'A':'wait','B':'later','C':'measured test','D':'trap','E':'trap','first':'Second affiliate programme (unit economics)'},
 'expansionist':    {'A':'scale to thousands','B':'trap','C':'neutral','D':'gate results','E':'unblock AI crawlers','first':'Programmatic pages from the data'},
 'outsider':        {'A':'trap','B':'first, as trust','C':'trap','D':'trap','E':'human Reddit','first':'Trust and clarity on the result page'},
 'executor':        {'A':'8 goal pages','B':'first','C':'trap','D':'trap','E':'1 hour a week','first':'Measurement, then B by Friday'},
}
opt_names={'A':'A Content engine','B':'B Conversion','C':'C Short video','D':'D Email loop','E':'E Distribution'}
def cell(v):
    cls = 'trap' if 'trap' in v else ('yes' if any(w in v for w in ['first','scale','8 goal','unblock','human','test','measured','gate','1 hour']) else 'mid')
    return f'<td class="{cls}">{html.escape(v)}</td>'
grid='<table class="grid"><thead><tr><th>Advisor</th>'+''.join(f'<th>{html.escape(o)}</th>' for o in opt_names.values())+'<th>Would do first</th></tr></thead><tbody>'
for k in names:
    p=positions[k]
    grid+=f'<tr><td class="adv" style="border-left-color:{colors[k]}">{names[k]}</td>'+''.join(cell(p[o]) for o in 'ABCDE')+f'<td>{html.escape(p["first"])}</td></tr>'
grid+='</tbody></table>'

adv_sections=''.join(f'<details><summary style="border-left:4px solid {colors[k]}">{names[k]} <span class="letter">(Response {m[k]} in peer review)</span></summary><div class="body">{md(advisors[k])}</div></details>' for k in names)
rev_sections=''.join(f'<details><summary>{html.escape(l)}</summary><div class="body">{md(t)}</div></details>' for l,t in reviews)

page=f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Council report: Wellness Whizz growth strategy</title>
<style>
:root{{--ink:#1d272d;--muted:#5b6770;--line:#e3e8ea;--accent:#87d581;--bg:#fff}}
body{{margin:0;background:#f5f7f8;color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}}
.wrap{{max-width:900px;margin:0 auto;padding:32px 20px 60px}}
.card{{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:24px 28px;margin:0 0 20px}}
h1{{font-size:26px;margin:0 0 6px}} h2{{font-size:19px;margin:26px 0 8px}} h3{{font-size:16px;margin:18px 0 6px}}
.sub{{color:var(--muted);font-size:14px;margin:0 0 14px}}
.q{{white-space:pre-wrap;font-size:14.5px;color:#2b3a43}}
.verdict h2:first-child{{margin-top:0}}
.verdict{{border-left:5px solid var(--accent)}}
table.grid{{width:100%;border-collapse:collapse;font-size:13px}} .grid th,.grid td{{border:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}}
.grid th{{background:#f0f4f5;font-weight:600}} .grid td.adv{{font-weight:600;border-left:4px solid}}
.grid td.yes{{background:#e8f6e6}} .grid td.trap{{background:#fdecec}} .grid td.mid{{background:#f7f7f7}}
details{{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:#fff}} summary{{cursor:pointer;padding:12px 16px;font-weight:600;border-left:4px solid #cbd5dc;border-radius:10px}}
details .body{{padding:4px 18px 14px;font-size:15px}} .letter{{color:var(--muted);font-weight:400;font-size:13px}}
.legend{{font-size:13px;color:var(--muted);margin-top:8px}} .legend span{{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;margin:0 4px 0 10px}}
footer{{color:var(--muted);font-size:13px;margin-top:30px}}
</style></head><body><div class="wrap">
<div class="card"><h1>Council report: Wellness Whizz growth strategy</h1><p class="sub">Five advisors, anonymous peer review, chairman synthesis. Generated {ts} UTC.</p>
<details open><summary>The question</summary><div class="body q">{html.escape(question)}</div></details></div>
<div class="card verdict">{md(verdict)}</div>
<div class="card"><h2 style="margin-top:0">Where the advisors stood</h2>{grid}<div class="legend"><span style="background:#e8f6e6"></span>backs it <span style="background:#fdecec"></span>calls it a trap <span style="background:#f7f7f7"></span>conditional or later</div></div>
<div class="card"><h2 style="margin-top:0">Advisor responses</h2>{adv_sections}</div>
<div class="card"><h2 style="margin-top:0">Peer review highlights</h2>{rev_sections}</div>
<footer>Counciled: 90-day growth strategy for aiww.io. Transcript: council-transcript-{ts}.md</footer>
</div></body></html>'''
(D/f'council-report-{ts}.html').write_text(page)

tr=["# Council transcript: Wellness Whizz growth strategy","",f"Generated {ts} UTC","","## Original question","","Which skills and free tools can promote the site, and what is the 90-day growth strategy? (user request, 3 October 2026)","","## Framed question","",question,"","## Advisor responses",""]
for k in names: tr+= [f"### {names[k]} (Response {m[k]} in peer review)","",advisors[k],""]
tr+=["## Peer reviews","",f"Anonymization map: "+", ".join(f"{v} = {names[k]}" for k,v in sorted(m.items(), key=lambda kv: kv[1])),""]
for l,t in reviews: tr+=[f"### {l}","",t,""]
tr+=["## Chairman's verdict","",verdict,""]
(D/f'council-transcript-{ts}.md').write_text("\n".join(tr))
print(f'council-report-{ts}.html', f'council-transcript-{ts}.md')
