import json, re
c = json.load(open('data/catalog.json', encoding='utf-8'))
pat = re.compile(r'moviebox|castle|4khd|vega', re.I)
for p in c['plugins']:
    n = p['name'] + ' ' + p['internalName']
    if pat.search(n):
        print(json.dumps({k: p.get(k) for k in ('repo','name','internalName','language','url','authors','description','fileSize','repoUrl','repoName')}, ensure_ascii=False))
