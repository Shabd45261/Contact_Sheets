"""Zip a list of files given by a JSON manifest.

Usage: python zip_sheets.py <manifest.json>
Manifest: { "out": "<zip path>", "files": ["<abs>", ...], "base": "<root>" }
Arc names are relative to `base` (so the zip keeps a clean folder tree).
"""
import json
import os
import sys
import zipfile


def main():
    if len(sys.argv) < 2:
        print("usage: zip_sheets.py <manifest.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        manifest = json.load(f)

    out = manifest["out"]
    files = manifest.get("files") or []
    base = manifest.get("base") or ""

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in files:
            if not fp or not os.path.isfile(fp):
                continue
            if base:
                try:
                    arc = os.path.relpath(fp, base)
                except ValueError:
                    arc = os.path.basename(fp)
            else:
                arc = os.path.basename(fp)
            # zip paths always use forward slashes
            arc = arc.replace(os.sep, "/")
            zf.write(fp, arc)
            count += 1

    print(json.dumps({"ok": True, "files": count, "bytes": os.path.getsize(out)}))


if __name__ == "__main__":
    main()
