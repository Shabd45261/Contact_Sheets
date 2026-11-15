#!/usr/bin/env python3
"""Timestamped contact sheets for films, seasons and episodes.

Samples one frame every N seconds with ffmpeg, burns the *source* timecode into
every tile, and tiles the frames into page-ordered JPEG sheets (default 5x4,
20 frames per page). Writes index.csv, manifest.json and README.md next to the
pages so an agent can quote exact page + tile + timecode in a shot pool.

Part of `direction` rule 09 (Cloudstream source gate + contact sheets).
Runtime needs: ffmpeg + ffprobe on PATH, Pillow.

Examples
--------
# a season, one overview page per 100 s (5 s interval)
python contact_sheets.py "D:\\Claude Cinematics\\cloudstream\\media\\Better Call Saul\\S01" \
  --out "work\\contact_sheets\\Better Call Saul\\S01" --interval 5 --recursive

# one episode
python contact_sheets.py "...\\S01E03.mkv" --out "work\\contact_sheets\\BCS\\S01" --interval 5

# a list of episodes
python contact_sheets.py "...\\S01" --only S01E01,S01E03 --out ...

# detail pass on one act
python contact_sheets.py "...\\S01E03.mkv" --out ... --interval 1 \
  --start 00:12:00 --end 00:18:00 --pass-name detail_12-18

# shot-level grid for a selected scene
python contact_sheets.py "...\\S01E03.mkv" --out ... --interval 1 --grid 6x5 --width 300
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

VIDEO_EXT = {".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".wmv"}

try:  # never crash on a Windows console codepage
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def run(cmd: list[str], timeout: int | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def need(tool: str) -> str:
    p = shutil.which(tool)
    if not p:
        sys.exit(f"ERROR: `{tool}` not found on PATH. Install ffmpeg and retry.")
    return p


def ffprobe(path: str) -> dict:
    ffprobe_bin = need("ffprobe")
    r = run([
        ffprobe_bin, "-v", "error",
        "-show_entries", "format=duration,size,bit_rate",
        "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate",
        "-of", "json", path,
    ])
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path}\n{r.stderr.strip()}")
    data = json.loads(r.stdout)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    fps = 0.0
    raw = video.get("r_frame_rate", "0/0")
    try:
        num, den = raw.split("/")
        if float(den) != 0:
            fps = round(float(num) / float(den), 3)
    except (ValueError, ZeroDivisionError):
        pass
    return {
        "path": os.path.abspath(path),
        "duration": float(fmt.get("duration") or 0.0),
        "size": int(fmt.get("size") or 0),
        "bit_rate": int(fmt.get("bit_rate") or 0),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": fps,
        "video_codec": video.get("codec_name", ""),
        "audio_codec": audio.get("codec_name", ""),
        "audio_channels": int(audio.get("channels") or 0),
        "audio_sample_rate": int(audio.get("sample_rate") or 0),
    }


def parse_time(value: str | None, default: float) -> float:
    """Accept `12:34`, `01:02:03`, `1h2m3s` or plain seconds."""
    if value is None:
        return default
    s = str(value).strip().lower()
    if not s:
        return default
    for pattern, mults in (
        (r"^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$", (3600, 60, 1)),
        (r"^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$", (60, 1)),
    ):
        m = re.match(pattern, s)
        if m:
            return sum(float(g) * mu for g, mu in zip(m.groups(), mults))
    m = re.match(r"^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$", s)
    if m and any(m.groups()):
        h, mi, se = (float(x) if x else 0.0 for x in m.groups())
        return h * 3600 + mi * 60 + se
    try:
        return float(s)
    except ValueError:
        sys.exit(f"ERROR: cannot parse time `{value}` (use HH:MM:SS or seconds).")


def hms(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def natural_key(text: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text)]


def collect_sources(path: str, recursive: bool, only: list[str]) -> list[str]:
    if os.path.isfile(path):
        return [path]
    if not os.path.isdir(path):
        sys.exit(f"ERROR: not a file or folder: {path}")

    found: list[str] = []
    if recursive:
        for root, _dirs, files in os.walk(path):
            for f in files:
                if os.path.splitext(f)[1].lower() in VIDEO_EXT:
                    found.append(os.path.join(root, f))
    else:
        for f in os.listdir(path):
            full = os.path.join(path, f)
            if os.path.isfile(full) and os.path.splitext(f)[1].lower() in VIDEO_EXT:
                found.append(full)

    found.sort(key=lambda p: natural_key(os.path.relpath(p, path)))

    if only:
        wanted = [w.strip().lower() for w in only if w.strip()]
        filtered = []
        for p in found:
            name = os.path.basename(p).lower()
            rel = os.path.relpath(p, path).lower()
            if any(w in name or w in rel for w in wanted):
                filtered.append(p)
        missing = [w for w in wanted if not any(w in os.path.basename(p).lower() or w in os.path.relpath(p, path).lower() for p in found)]
        if missing:
            print(f"WARNING: --only matched nothing for: {', '.join(missing)}", file=sys.stderr)
        found = filtered

    if not found:
        sys.exit(f"ERROR: no video files found in {path} (extensions: {', '.join(sorted(VIDEO_EXT))}).")
    return found


def load_font(size: int):
    from PIL import ImageFont
    candidates = [
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except OSError:
                pass
    return ImageFont.load_default()


# --------------------------------------------------------------------------- #
# extraction + tiling
# --------------------------------------------------------------------------- #

def extract_frames(src: str, start: float, end: float, interval: float,
                   width: int, tmp: str) -> int:
    """One ffmpeg pass. Returns the number of frames written."""
    ffmpeg = need("ffmpeg")
    duration = max(0.0, end - start)
    out_pattern = os.path.join(tmp, "f_%06d.jpg")
    vf = f"fps=1/{interval:g},scale={width}:-2:flags=lanczos"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
        "-i", src,
        "-vf", vf,
        "-q:v", "3",
        "-fps_mode", "vfr",
        out_pattern,
    ]
    r = run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg frame extraction failed for {src}\n{r.stderr.strip()}")
    return len([f for f in os.listdir(tmp) if f.startswith("f_") and f.endswith(".jpg")])


def make_pages(frames: list[str], times: list[float], out_dir: str,
               cols: int, rows: int, tile_w: int, gap: int) -> list[dict]:
    from PIL import Image, ImageDraw

    per_page = cols * rows
    font = load_font(max(12, round(tile_w * 0.048)))
    pages: list[dict] = []
    os.makedirs(out_dir, exist_ok=True)

    for page_idx in range(0, len(frames), per_page):
        chunk = frames[page_idx:page_idx + per_page]
        chunk_times = times[page_idx:page_idx + per_page]

        thumbs = []
        for path in chunk:
            im = Image.open(path).convert("RGB")
            if im.width != tile_w:
                h = max(2, round(im.height * tile_w / im.width))
                im = im.resize((tile_w, h), Image.LANCZOS)
            thumbs.append(im)

        tile_h = max(im.height for im in thumbs) if thumbs else round(tile_w * 9 / 16)
        page_w = cols * tile_w + (cols + 1) * gap
        page_h = rows * tile_h + (rows + 1) * gap
        page = Image.new("RGB", (page_w, page_h), (8, 8, 8))
        draw = ImageDraw.Draw(page)

        rows_written = []
        for i, im in enumerate(thumbs):
            r_idx, c_idx = divmod(i, cols)
            x = gap + c_idx * (tile_w + gap)
            y = gap + r_idx * (tile_h + gap)
            page.paste(im, (x, y))

            # burned-in source timecode: white text on a 60% black box
            label = hms(chunk_times[i])
            try:
                box = draw.textbbox((0, 0), label, font=font)
                tw, th = box[2] - box[0], box[3] - box[1]
            except Exception:
                tw = th = 0
            pad_x, pad_y = max(3, font.size // 3), max(2, font.size // 4)
            bg = Image.new("RGB", (tw + pad_x * 2, th + pad_y * 2), (0, 0, 0))
            page.paste(bg, (x + 4, y + im.height - th - pad_y * 2 - 4))
            draw.text((x + 4 + pad_x, y + im.height - th - pad_y * 2 - 4 + pad_y),
                      label, fill=(255, 255, 255), font=font)

            rows_written.append({
                "page": len(pages) + 1,
                "row": r_idx + 1,
                "col": c_idx + 1,
                "timecode": label,
                "seconds": round(chunk_times[i], 3),
            })

        page_name = f"page_{len(pages) + 1:04d}.jpg"
        page.save(os.path.join(out_dir, page_name), "JPEG", quality=88, optimize=True)
        pages.append({"file": page_name, "tiles": rows_written})

    return pages


def sheet_readme(manifest: dict) -> str:
    return (
        f"# Contact sheets - {manifest['title']}\n\n"
        f"Source: `{manifest['source']}`  \n"
        f"Duration: {hms(manifest['duration'])} ({manifest['duration']:.3f} s) | "
        f"{manifest['width']}x{manifest['height']} | {manifest['fps']} fps  \n"
        f"Sampled: one frame every **{manifest['interval']} s**, "
        f"grid **{manifest['grid']}**, tile width **{manifest['tile_width']} px**, "
        f"{manifest['page_count']} page(s), {manifest['frame_count']} frames.  \n"
        f"Range: {hms(manifest['start'])} - {hms(manifest['end'])}.  \n"
        f"Every tile burns its **source timecode** (`HH:MM:SS`). Pages are in "
        f"chronological order. `index.csv` maps page/row/col to timecode; "
        f"`manifest.json` records the settings.  \n"
        f"Generated {manifest['generated']}.\n"
    )


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def process_source(src: str, args) -> dict:
    need("ffmpeg")
    probe = ffprobe(src)
    duration = probe["duration"]
    if duration <= 0:
        print(f"WARNING: zero/unknown duration, skipping {src}", file=sys.stderr)
        return {}

    start = parse_time(args.start, 0.0)
    end = parse_time(args.end, duration)
    end = min(end, duration)
    if end <= start:
        print(f"WARNING: empty range {start}-{end}, skipping {src}", file=sys.stderr)
        return {}

    interval = args.interval
    if interval <= 0:
        sys.exit("ERROR: --interval must be > 0 seconds.")

    stem = os.path.splitext(os.path.basename(src))[0]
    if args.flat and args.single_source:
        source_dir = args.out
    else:
        source_dir = os.path.join(args.out, stem)
    out_dir = os.path.join(source_dir, args.pass_name)

    if os.path.isdir(out_dir) and not args.overwrite:
        existing = [f for f in os.listdir(out_dir) if f.startswith("page_") and f.endswith(".jpg")]
        if existing:
            sys.exit(f"ERROR: {out_dir} already has {len(existing)} page(s). "
                     f"Use --overwrite or a new --pass-name.")

    print(f"\n=== {stem}")
    print(f"    source   {src}")
    print(f"    probe    {probe['width']}x{probe['height']} {probe['fps']} fps "
          f"{hms(duration)}  {probe['video_codec']}/{probe['audio_codec']}")
    print(f"    range    {hms(start)} - {hms(end)}   every {interval:g}s   "
          f"grid {args.grid}   width {args.width}")

    tmp = tempfile.mkdtemp(prefix="cs_")
    try:
        n = extract_frames(src, start, end, interval, args.width, tmp)
        if n == 0:
            print(f"WARNING: no frames extracted for {src}", file=sys.stderr)
            return {}
        frames = [os.path.join(tmp, f) for f in sorted(os.listdir(tmp))
                  if f.startswith("f_") and f.endswith(".jpg")]
        times = [min(end, start + i * interval) for i in range(len(frames))]

        os.makedirs(out_dir, exist_ok=True)
        cols, rows = (int(x) for x in args.grid.lower().split("x"))
        pages = make_pages(frames, times, out_dir, cols, rows, args.width, args.gap)

        with open(os.path.join(out_dir, "index.csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["page", "row", "col", "timecode", "seconds"])
            w.writeheader()
            for page in pages:
                for tile in page["tiles"]:
                    w.writerow(tile)

        manifest = {
            "title": stem,
            "source": probe["path"],
            "duration": round(duration, 3),
            "width": probe["width"],
            "height": probe["height"],
            "fps": probe["fps"],
            "video_codec": probe["video_codec"],
            "audio_codec": probe["audio_codec"],
            "interval": interval,
            "grid": args.grid.lower(),
            "tile_width": args.width,
            "gap": args.gap,
            "start": round(start, 3),
            "end": round(end, 3),
            "frame_count": len(frames),
            "page_count": len(pages),
            "pages": pages,
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, ensure_ascii=False)
        with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as fh:
            fh.write(sheet_readme(manifest))

        print(f"    wrote    {len(pages)} page(s), {len(frames)} tiles -> {out_dir}")
        return manifest
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Timestamped contact sheets for a film, season or episode.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Examples", 1)[-1],
    )
    ap.add_argument("input", help="video file or folder")
    ap.add_argument("--out", required=True, help="output root, e.g. work\\contact_sheets\\<Title>\\S01")
    ap.add_argument("--interval", type=float, default=10.0,
                    help="seconds between samples (default 10; use 5 for an episode)")
    ap.add_argument("--grid", default="5x4", help="cols x rows per page (default 5x4 = 20 tiles)")
    ap.add_argument("--width", type=int, default=320, help="tile width in px (default 320)")
    ap.add_argument("--gap", type=int, default=4, help="gutter between tiles in px (default 4)")
    ap.add_argument("--start", default=None, help="range start (HH:MM:SS or seconds)")
    ap.add_argument("--end", default=None, help="range end (HH:MM:SS or seconds)")
    ap.add_argument("--recursive", action="store_true", help="recurse into subfolders")
    ap.add_argument("--only", default="", help="comma-separated filenames/episodes, e.g. S01E01,S01E03")
    ap.add_argument("--pass-name", default="overview",
                    help="subfolder under each episode, e.g. overview or detail_12-18")
    ap.add_argument("--flat", action="store_true",
                    help="when input is one file, write pages directly under --out/<pass-name>")
    ap.add_argument("--overwrite", action="store_true", help="overwrite existing pages")
    args = ap.parse_args()

    only = [x for x in args.only.split(",") if x.strip()]
    sources = collect_sources(args.input, args.recursive, only)
    args.single_source = len(sources) == 1

    print(f"contact_sheets.py - {len(sources)} source(s) - Pillow + ffmpeg")
    started = time.time()
    done = []
    for src in sources:
        try:
            m = process_source(src, args)
            if m:
                done.append(m)
        except Exception as exc:  # keep going across a season
            print(f"ERROR: {src}: {exc}", file=sys.stderr)

    if not done:
        sys.exit("ERROR: nothing written.")
    total_pages = sum(m["page_count"] for m in done)
    print(f"\nDone: {len(done)} source(s), {total_pages} page(s) in {time.time()-started:.1f}s.")


if __name__ == "__main__":
    main()
