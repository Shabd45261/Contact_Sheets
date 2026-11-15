import json, re, sys
c = json.load(open('data/catalog.json', encoding='utf-8'))
pat = re.compile(r'moviebox|castle|4khd|vega', re.I)
for p in c['plugins']:
    n = p['name'] + ' ' + p['internalName'] + ' ' + (p.get('description') or '')
    if pat.search(n):
        print(f"{p['repo']:<18} {p['name']:<30} {p['language']:<4} {p['fileSize']/1024:8.0f}KB  {p['url']}")
