#!/usr/bin/env python3
"""Materialise ONLY the approved CloudStream target plugins.

Targets (from the user-provided CNCVerse + phisher repositories):
  - MovieBoxProvider / MovieBoxProviderIN / CastleTvProvider / VegaMoviesProvider
  - phisher MovieBoxProvider / FourKHDHub

Creates extensions/<repo>/plugins/<Name>/ with the .cs3, icon and plugin.json.
Idempotent: an existing .cs3 larger than 1 KB is not downloaded again.
Standard library only (runs with the host Python 3.13; no pip packages).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import ssl
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT_PATH = os.path.join(ROOT, "data", "catalog.json")
EXT = os.path.join(ROOT, "extensions")
LOG = os.path.join(ROOT, "data", "materialize_targets.log")
MANIFEST = os.path.join(ROOT, "data", "targets.json")

TARGET_REPOS = {"cncverse", "phisher"}
TARGET_NAMES = {
    "MovieBoxProvider",
    "MovieBoxProviderIN",
    "CastleTvProvider",
    "VegaMoviesProvider",
    "FourKHDHub",
}

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CloudStreamLocal/1.0"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def safe(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "plugin"


def fetch(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
        return resp.read()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def domains_from_cs3(path: str) -> list[str]:
    try:
        raw = open(path, "rb").read()
    except Exception:
        return []
    blobs = [raw]
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for name in z.namelist():
                if name.endswith((".dex", ".json")):
                    blobs.append(z.read(name)[:8_000_000])
    except Exception:
        pass
    ignore = ("github", "cloudstream", "google", "gstatic", "kotlin", "okhttp",
              "jsoup", "w3.org", "schema.org", "json-schema", "mozilla",
              "kotlinlang", "oracle", "android", "apache", "jetbrains",
              "cloudflare", "jsdelivr", "unpkg", "wikipedia")
    hosts: dict[str, int] = {}
    for blob in blobs:
        for match in re.finditer(rb"https?://([a-zA-Z0-9._-]{3,80})", blob):
            host = match.group(1).decode("ascii", "ignore").lower().strip(".")
            if any(x in host for x in ignore):
                continue
            hosts[host] = hosts.get(host, 0) + 1
    return [h for h, _ in sorted(hosts.items(), key=lambda kv: -kv[1])[:6]]


def materialise(entry: dict) -> dict:
    repo = entry["repo"]
    name = entry["name"]
    folder = os.path.join(EXT, repo, "plugins", safe(name))
    os.makedirs(folder, exist_ok=True)

    url = entry["url"]
    cs3_name = os.path.basename(url.split("?")[0]) or (safe(name) + ".cs3")
    dest = os.path.join(folder, cs3_name)
    status = {"repo": repo, "name": name, "folder": folder, "cs3": cs3_name, "source": None}

    if not (os.path.isfile(dest) and os.path.getsize(dest) > 1000):
        local = os.path.join(EXT, repo, cs3_name)
        if os.path.isfile(local) and os.path.getsize(local) > 1000:
            shutil.copy2(local, dest)
            status["source"] = "clone"
            log(f"COPY {repo}/{name} <- {local}")
        else:
            try:
                open(dest, "wb").write(fetch(url))
                status["source"] = "download"
                log(f"GET  {repo}/{name} <- {url}")
            except Exception as exc:  # noqa: BLE001
                status["error"] = f"download failed: {exc}"
                log(f"FAIL {repo}/{name}: {exc}")
                return status
    else:
        status["source"] = "existing"
        log(f"SKIP {repo}/{name} (already present)")

    expected = (entry.get("fileHash") or "").removeprefix("sha256-").lower()
    actual = sha256_file(dest)
    status["sha256"] = actual
    status["hashOk"] = (not expected) or (actual == expected)
    if expected and actual != expected:
        log(f"WARN {repo}/{name} hash mismatch expected={expected[:12]} actual={actual[:12]}")

    meta = dict(entry)
    meta["localFile"] = os.path.relpath(dest, ROOT).replace("\\", "/")
    meta["domains"] = domains_from_cs3(dest)

    icon_url = entry.get("iconUrl")
    if icon_url:
        icon_ext = os.path.splitext(icon_url.split("?")[0])[1].lower()
        if icon_ext not in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
            icon_ext = ".png"
        icon_path = os.path.join(folder, "icon" + icon_ext)
        if not (os.path.isfile(icon_path) and os.path.getsize(icon_path) > 100):
            try:
                open(icon_path, "wb").write(fetch(icon_url, 30))
            except Exception as exc:  # noqa: BLE001
                log(f"WARN {repo}/{name} icon failed: {exc}")
        if os.path.isfile(icon_path):
            meta["localIcon"] = os.path.relpath(icon_path, ROOT).replace("\\", "/")

    with open(os.path.join(folder, "plugin.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)

    status["domains"] = meta["domains"]
    status["version"] = entry.get("version")
    status["bytes"] = os.path.getsize(dest)
    log(f"OK   {repo}/{name} v{entry.get('version')} {status['bytes']} bytes domains={len(meta['domains'])}")
    return status


def main() -> int:
    with open(CAT_PATH, encoding="utf-8") as fh:
        catalog = json.load(fh)
    targets = [
        p for p in catalog["plugins"]
        if p.get("repo") in TARGET_REPOS and p.get("name") in TARGET_NAMES
    ]
    if not targets:
        log("No matching target plugins found in catalog.json")
        return 1

    open(LOG, "w", encoding="utf-8").close()
    log(f"=== target materialisation: {len(targets)} plugins ===")
    results = [materialise(entry) for entry in targets]

    summary = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "targetRepos": sorted(TARGET_REPOS),
        "targetNames": sorted(TARGET_NAMES),
        "count": len(results),
        "ok": sum(1 for r in results if "error" not in r),
        "failed": sum(1 for r in results if "error" in r),
        "hashMismatch": [f"{r['repo']}/{r['name']}" for r in results if r.get("hashOk") is False],
        "plugins": results,
    }
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1)
    log(f"=== done: ok={summary['ok']} failed={summary['failed']} manifest={MANIFEST} ===")
    return 0 if summary["failed"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
