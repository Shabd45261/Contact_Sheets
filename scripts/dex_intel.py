#!/usr/bin/env python3
"""Extract readable strings/URLs from target plugin .cs3 (zip + classes.dex) for reverse engineering."""
import json, os, re, ssl, urllib.request, zipfile, io, collections, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "intel")
os.makedirs(OUT, exist_ok=True)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0"

TARGETS = [
    ("phisher", "MovieBoxProvider", "https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/builds/MovieBoxProvider.cs3"),
    ("cncverse", "MovieBoxProvider", "https://raw.githubusercontent.com/NivinCNC/CNCVerse-Cloud-Stream-Extension/builds/MovieBoxProvider.cs3"),
    ("cncverse", "MovieBoxProviderIN", "https://raw.githubusercontent.com/NivinCNC/CNCVerse-Cloud-Stream-Extension/builds/MovieBoxProviderIN.cs3"),
    ("cncverse", "CastleTvProvider", "https://raw.githubusercontent.com/NivinCNC/CNCVerse-Cloud-Stream-Extension/builds/CastleTvProvider.cs3"),
    ("cncverse", "VegaMoviesProvider", "https://raw.githubusercontent.com/NivinCNC/CNCVerse-Cloud-Stream-Extension/builds/VegaMoviesProvider.cs3"),
    ("csx", "VegaMovies", "https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/VegaMovies.cs3"),
    ("raghav", "VegaMovies", "https://raw.githubusercontent.com/KSHITIJ8473/raghav/builds/VegaMovies.cs3"),
    ("indflix", "Vegamovies", "https://raw.githubusercontent.com/dipender98/Indflix/builds/Vegamovies.cs3"),
    ("desi", "vegamovies", "https://raw.githubusercontent.com/Faisal0786/Desi/builds/vegamovies.cs3"),
    ("phisher", "FourKHDHub", None),
]
for pid, name, url in TARGETS:
    if url is None:
        c = json.load(open(os.path.join(ROOT, "data", "catalog.json"), encoding="utf-8"))
        for p in c["plugins"]:
            if p["repo"] == pid and re.search("four.*hd", p["name"], re.I):
                url = p["url"]; name = p["name"]; break
    if not url:
        continue
    raw_path = os.path.join(OUT, f"{pid}__{name}.cs3")
    if not os.path.exists(raw_path):
        print("download", pid, name)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        open(raw_path, "wb").write(urllib.request.urlopen(req, timeout=60, context=ctx).read())
    raw = open(raw_path, "rb").read()
    blobs = [raw]
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = z.namelist()
            for n in names:
                if n.endswith(".dex") or n.endswith(".json") or n.endswith(".txt"):
                    blobs.append(z.read(n))
    except Exception as e:
        print("zip err", e)
    strings, urls = [], collections.Counter()
    for b in blobs:
        for m in re.finditer(rb"[\x20-\x7e]{5,400}", b):
            s = m.group(0).decode("ascii", "ignore")
            strings.append(s)
            for u in re.findall(r"https?://[^\s\"'<>\\]+", s):
                urls[u] += 1
    txt = os.path.join(OUT, f"{pid}__{name}.strings.txt")
    open(txt, "w", encoding="utf-8").write("\n".join(strings))
    print(f"\n===== {pid}/{name}  ({len(raw)//1024}KB, {len(strings)} strings) =====")
    hosts = collections.Counter()
    for u, n in urls.items():
        hosts[re.sub(r"^https?://([^/]+).*", r"\1", u)] += n
    for h, n in hosts.most_common(25):
        print(f"  {n:4}x {h}")
    print("  -- example urls --")
    for u, n in urls.most_common(30):
        print("   ", u[:160])
