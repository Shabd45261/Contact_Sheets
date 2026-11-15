#!/usr/bin/env python3
"""Clone every repository from config/repos.json into extensions/<repo-id>/ using a
shallow single-branch clone, then materialise every plugin into
extensions/<repo-id>/plugins/<PluginName>/ with its .cs3 file, icon and metadata."""
import json, os, re, shutil, ssl, subprocess, sys, time, urllib.request, urllib.error, zipfile, io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "config", "repos.json"), encoding="utf-8"))
CAT = json.load(open(os.path.join(ROOT, "data", "catalog.json"), encoding="utf-8"))
EXT = os.path.join(ROOT, "extensions")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CloudStreamLocal/1.0"
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
LOG = os.path.join(ROOT, "data", "clone.log")

os.makedirs(EXT, exist_ok=True)


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run(cmd, cwd=None, timeout=1800):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"})
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def clone(repo):
    dest = os.path.join(EXT, repo["id"])
    if os.path.isdir(os.path.join(dest, ".git")) or (os.path.isdir(dest) and os.listdir(dest)):
        log(f"SKIP (exists) {repo['id']}")
        return True
    cmds = []
    if repo.get("branch"):
        cmds.append(["git", "clone", "--depth", "1", "--single-branch", "--branch", repo["branch"], repo["git"], dest])
    cmds.append(["git", "clone", "--depth", "1", repo["git"], dest])
    for cmd in cmds:
        log(f"CLONE {repo['id']} ({' '.join(cmd[:6])} ...)")
        try:
            rc, out = run(cmd)
        except subprocess.TimeoutExpired:
            log(f"TIMEOUT {repo['id']}")
            continue
        if rc == 0:
            log(f"OK {repo['id']}")
            return True
        log(f"FAIL {repo['id']}: {out.strip().splitlines()[-1] if out.strip() else rc}")
        if os.path.isdir(dest):
            shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    log(f"EMPTY folder created for {repo['id']} (clone failed, plugins still downloadable)")
    return False


def safe(name):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "plugin"


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read()


def domains_from_cs3(path):
    try:
        raw = open(path, "rb").read()
    except Exception:
        return []
    # .cs3 is a zip that contains classes.dex; search both the archive and inflated dex
    blobs = [raw]
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for n in z.namelist():
                if n.endswith(".dex") or n.endswith(".json"):
                    blobs.append(z.read(n)[:8_000_000])
    except Exception:
        pass
    hosts = {}
    for b in blobs:
        for m in re.finditer(rb"https?://([a-zA-Z0-9._-]{3,80})", b):
            h = m.group(1).decode("ascii", "ignore").lower().strip(".")
            if any(x in h for x in ("github", "cloudstream", "google", "gstatic", "kotlin", "okhttp",
                                    "jsoup", "w3.org", "schema.org", "json-schema", "mozilla",
                                    "kotlinlang", "oracle", "android", "apache", "jetbrains",
                                    "cloudflare", "jsdelivr", "unpkg", "wikipedia")):
                continue
            hosts[h] = hosts.get(h, 0) + 1
    return [h for h, _ in sorted(hosts.items(), key=lambda kv: -kv[1])[:6]]


def materialise():
    by_repo = {}
    for p in CAT["plugins"]:
        by_repo.setdefault(p["repo"], []).append(p)
    for repo in CFG["repos"]:
        rid = repo["id"]
        plugs = by_repo.get(rid, [])
        base = os.path.join(EXT, rid)
        pdir_root = os.path.join(base, "plugins")
        os.makedirs(pdir_root, exist_ok=True)
        log(f"PLUGINS {rid}: {len(plugs)}")
        for p in plugs:
            name = safe(p["name"])
            folder = os.path.join(pdir_root, name)
            os.makedirs(folder, exist_ok=True)
            cs3_name = os.path.basename(p["url"].split("?")[0]) or (name + ".cs3")
            cs3_path = os.path.join(folder, cs3_name)
            meta_path = os.path.join(folder, "plugin.json")
            if not (os.path.isfile(cs3_path) and os.path.getsize(cs3_path) > 1000):
                # try to find it inside the clone first
                found = None
                for root, _, files in os.walk(base):
                    if cs3_name in files and os.path.join(root, cs3_name) != cs3_path:
                        found = os.path.join(root, cs3_name); break
                if found:
                    shutil.copy2(found, cs3_path)
                else:
                    try:
                        data = fetch(p["url"])
                        open(cs3_path, "wb").write(data)
                    except Exception as e:
                        log(f"  ! download failed {p['name']}: {e}")
            meta = dict(p)
            meta["localFile"] = os.path.relpath(cs3_path, ROOT).replace("\\", "/")
            meta["domains"] = domains_from_cs3(cs3_path) if os.path.isfile(cs3_path) else []
            if p.get("iconUrl"):
                icon_ext = os.path.splitext(p["iconUrl"].split("?")[0])[1].lower()
                if icon_ext not in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
                    icon_ext = ".png"
                icon_path = os.path.join(folder, "icon" + icon_ext)
                if not os.path.isfile(icon_path):
                    try:
                        open(icon_path, "wb").write(fetch(p["iconUrl"], 30))
                        meta["localIcon"] = os.path.relpath(icon_path, ROOT).replace("\\", "/")
                    except Exception:
                        pass
            json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    # quick per-repo summary file
    for repo in CFG["repos"]:
        base = os.path.join(EXT, repo["id"])
        os.makedirs(base, exist_ok=True)
        json.dump(repo, open(os.path.join(base, "repo.source.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    open(LOG, "w", encoding="utf-8").close()
    log("=== clone phase ===")
    for repo in CFG["repos"]:
        if only and repo["id"] != only:
            continue
        clone(repo)
    log("=== plugin phase ===")
    materialise()
    log("=== done ===")


if __name__ == "__main__":
    main()
