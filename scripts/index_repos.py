#!/usr/bin/env python3
"""Download repo.json / plugins.json for every repository in config/repos.json
and build data/catalog.json (one flat, normalised catalogue of every plugin)."""
import json, os, re, ssl, sys, urllib.request, urllib.error, hashlib
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "config", "repos.json")
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "catalog.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CloudStreamLocal/1.0"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

os.makedirs(RAW, exist_ok=True)


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read()


def norm_obj(data):
    """CloudStream plugins.json can be an array, an object keyed 0..n, or {plugins:[...]}"""
    if isinstance(data, list):
        return [p for p in data if isinstance(p, dict)]
    if isinstance(data, dict):
        if isinstance(data.get("plugins"), list):
            return [p for p in data["plugins"] if isinstance(p, dict)]
        vals = [v for v in data.values() if isinstance(v, dict)]
        if vals and any(k in vals[0] for k in ("name", "url", "internalName")):
            return vals
        # maybe nested pluginLists
        if "pluginLists" in data:
            return norm_obj(data["pluginLists"])
    return []


def absolutize(base, url):
    if not url:
        return url
    if re.match(r"^https?://", url):
        return url
    return urllib.parse.urljoin(base, url)


def main():
    cfg = json.load(open(CFG, encoding="utf-8"))
    catalog = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": cfg["generatedFrom"],
        "repos": [],
        "plugins": [],
    }
    for repo in cfg["repos"]:
        entry = dict(repo)
        entry.update({"ok": False, "error": None, "plugins": 0, "bytes": 0, "pluginLists": []})
        try:
            raw = fetch(repo["repoJson"])
            txt = raw.decode("utf-8", "replace")
            open(os.path.join(RAW, repo["id"] + ".repo.json"), "w", encoding="utf-8").write(txt)
            manifest = json.loads(txt)
            entry["repoName"] = manifest.get("name") or repo["name"]
            entry["repoIcon"] = manifest.get("iconUrl", "")
            entry["repoDescription"] = manifest.get("description", "")
            lists = manifest.get("pluginLists") or manifest.get("plugins") or []
            if isinstance(lists, str):
                lists = [lists]
            if isinstance(lists, dict):
                lists = list(lists.values())
            plugins = []
            for i, pl in enumerate(lists):
                if isinstance(pl, str):
                    purl = absolutize(repo["repoJson"], pl)
                    entry["pluginLists"].append(purl)
                    try:
                        pdata = json.loads(fetch(purl).decode("utf-8", "replace"))
                        open(os.path.join(RAW, f"{repo['id']}.plugins{i}.json"), "w", encoding="utf-8").write(
                            json.dumps(pdata, ensure_ascii=False))
                        plugins.extend(norm_obj(pdata))
                    except Exception as e:  # noqa
                        entry["error"] = (entry["error"] or "") + f" plugins{i}: {e}"
                elif isinstance(pl, dict):
                    plugins.append(pl)
            # Some repos use repo.json as the plugin list itself
            if not plugins:
                plugins = norm_obj(manifest)
            for p in plugins:
                name = p.get("name") or p.get("internalName") or "Unknown"
                url = absolutize(repo["repoJson"], p.get("url", ""))
                cat = {
                    "repo": repo["id"],
                    "repoName": entry["repoName"],
                    "shortcode": repo.get("shortcode", ""),
                    "region": repo.get("region", ""),
                    "name": name,
                    "internalName": p.get("internalName", name),
                    "authors": p.get("authors") or [],
                    "description": p.get("description", ""),
                    "language": p.get("language", ""),
                    "tvTypes": p.get("tvTypes") or [],
                    "iconUrl": p.get("iconUrl", ""),
                    "url": url,
                    "version": p.get("version"),
                    "apiVersion": p.get("apiVersion"),
                    "fileSize": p.get("fileSize", 0),
                    "status": p.get("status", 1),
                    "fileHash": p.get("fileHash", ""),
                }
                catalog["plugins"].append(cat)
            entry["plugins"] = len(plugins)
            entry["bytes"] = sum(int(p.get("fileSize") or 0) for p in plugins)
            entry["ok"] = True
        except Exception as e:  # noqa
            entry["error"] = str(e)
        catalog["repos"].append(entry)
        print(f"{'OK ' if entry['ok'] else 'ERR'} {repo['id']:<26} {entry['plugins']:>4} plugins  {entry['bytes']/1e6:8.1f} MB  {entry['error'] or ''}")

    # de-duplicate by plugin url
    seen = {}
    deduped = []
    for p in catalog["plugins"]:
        key = p["url"] or (p["repo"] + "/" + p["name"])
        if key in seen:
            continue
        seen[key] = True
        deduped.append(p)
    catalog["plugins"] = deduped
    catalog["totalPlugins"] = len(deduped)
    catalog["totalBytes"] = sum(int(p.get("fileSize") or 0) for p in deduped)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(catalog, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\nTOTAL: {len(deduped)} plugins across {len(catalog['repos'])} repos, {catalog['totalBytes']/1e9:.2f} GB of plugin files")


if __name__ == "__main__":
    main()
