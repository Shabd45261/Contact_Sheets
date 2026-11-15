# Cloudstream (local) — status

Local-first source for film / series / episode edits. **In development.** The bridge
runs; the media library fills as titles are downloaded. The skills use this folder
first and fall back to a clean local file the user provides when a title is missing.

The workflow that depends on this folder is documented in
`D:\Claude Cinematics\skills\direction\rules\09-source-and-contact-sheets.md`.

## What is here now

```text
config\repos.json      extension repositories (from the Cloudstream extension list)
data\catalog.json      normalised catalogue of every plugin
data\raw\              downloaded repo.json / plugins.json
data\clone.log         clone + materialise log
extensions\<repo-id>\  one folder per repository (git clone)
  plugins\<Name>\      materialised plugin: .cs3, icon, metadata
scripts\index_repos.py build the catalogue from config\repos.json
scripts\clone_all.py   clone every repo and materialise its plugins
scripts\contact_sheets.py  timestamped contact sheets (works now, ffmpeg + Pillow)
```

## Bridge and library status

- The bridge is `app\server.js` (Node, provider code in `app\lib\providers`). It is
  started with `start.bat` (all providers, port 8787) or `start_<provider>.bat`, and
  serves search, detail, streams, clips, contact-sheet jobs and window sheets under
  `/api/...`. Its agent guide is at `/api/agent.md`. It replaces the older plan
  (`scripts\bridge\server.py` with `/health`, `/title`, ...).
- `media\<Title>\<Season>\<episode>.mkv` exists only once something has been
  downloaded (by the edit skill's `get_source.py`, or by hand).

Do not claim a provider or a download works until it has answered on this machine.
The `.cs3` files are Android artifacts; the bridge does not run them.

## Start / stop the local server

```text
start.bat                     all providers on http://127.0.0.1:8787/
start_<provider>.bat          one provider on its own port (8788-8792)
start_youtube.bat             YouTube only on http://127.0.0.1:8792/?provider=youtube
terminate.bat                 stop every running CloudStream server (any port)
```

Backend edits (`app\server.js`, `app\lib\*`) only load when a server starts.
If the UI shows a new button but the API answers 404, the running server is
stale — run `terminate.bat`, then start again.

Two things can still look "old" after a restart:

- **The page layout** — the browser may keep a cached page. Hard-refresh once
  with `Ctrl+F5`. The pill at the top right shows the UI build (`ui 2026-11-11.1`);
  hover it to see which server (pid, start time, code date) you are talking to.
  If it does not say the current build, the page is stale.
- **Remove/Cancel answering 404 "job not found"** — the jobs panel lists jobs
  from the run that rendered the page; after a restart those ids no longer
  exist. The panel explains this and refreshes itself.

## Run the contact sheets now


```powershell
# one episode, one frame every 5 s
python "D:\Claude Cinematics\cloudstream\scripts\contact_sheets.py" `
  "D:\Claude Cinematics\cloudstream\media\Better Call Saul\S01\S01E01.mkv" `
  --out "D:\EDITSSSS\work\contact_sheets\Better Call Saul\S01" --interval 5 --flat

# a whole season
python "D:\Claude Cinematics\cloudstream\scripts\contact_sheets.py" `
  "D:\Claude Cinematics\cloudstream\media\Better Call Saul\S01" `
  --out "D:\EDITSSSS\work\contact_sheets\Better Call Saul\S01" `
  --interval 5 --grid 5x4 --width 320 --recursive

# selected episodes
python "D:\Claude Cinematics\cloudstream\scripts\contact_sheets.py" "...\S01" --only S01E01,S01E03 --out ...
```

Every tile burns its source `HH:MM:SS`; `index.csv`, `manifest.json` and
`README.md` are written next to the pages. Pages are chronological and never
overwritten unless `--overwrite` is passed.

## Window sheets (UI build 2026-11-10.3)

Sample only a time period around a fixed timestamp, with its own
interval / images-per-sheet / number-of-sheets (any two; the third is
computed from the window length).

* UI: **Window sheet** row - timestamp (`2:44:30`, `164:30` or seconds),
  seconds before / after - then **Window plan** and **Window for selected**.
* API: `POST /api/jobs` with
  `"window": {"center":"2:44:30","before":300,"after":55,"interval":10,"perSheet":30}`
  (`start`/`end` may replace center/before/after). Clamped to the runtime.
* Output: its own folder `<S01E01|Movie>-win-<HHMMSS>-<HHMMSS>/` next to the
  full-runtime sheets; frame labels are absolute seconds. Removing a window job
  deletes only its own folder.

## Episode selection

No episode is pre-selected any more. Click chips to choose; the label shows
the selection. Runtime detection, **Download clip** and **Preview stream** use
the chip you clicked last.

## "Nothing I changed seems to work" - stale server

The server reads the web page from disk on every request but keeps its
JavaScript in memory. An old `node` process can therefore serve a NEW page
while running OLD job code (Remove/Cancel 404, plan values ignored, ...).
A red banner now appears when `/api/health` reports `api < 3` or `stale: true`.
Fix: run `terminate.bat` (it now also kills any node process on ports
8787-8799), then `start.bat`, then Ctrl+F5.

## YouTube source (UI build 2026-11-12.1)

A bridge-native provider — not a `.cs3` plugin — for **native YouTube content**:
music videos, official trailers, creator videos, UGC and Shorts. Use it for edit
footage, pacing/style reference and audio. It is **not** a film/series rip
substitute (AGENTS.md rule 5): a movie or episode still comes from
MovieBox/CastleTV or a clean user file.

* **Search box accepts a pasted link**: watch, Shorts, `youtu.be`, a bare
  11-character video id, or a playlist / channel URL (a channel or playlist
  appears as a "series"; its videos are the episodes, capped at 200). The UI
  switches to the YouTube tab automatically when a youtube.com / youtu.be link
  is pasted while another provider is active.
* Keyword search uses YouTube's InnerTube API with a `yt-dlp ytsearch` fallback.
* Streams resolve through **yt-dlp** (`scripts\env.ps1` sets `YTDLP_PATH`).
  YouTube serves video-only and audio-only formats, so each stream carries an
  extra `audioUrl`; clip jobs mux video + audio automatically, and the clip's
  `.json` sidecar records `stream.audio: true`.
* Output lands in `extensions\youtube\` (clips / contact-sheets) — see its
  README for why that folder is not a git clone.
* **Captions on snapshots** (UI build 2026-11-12.1): the detail page shows a
  **Captions** row (checkbox + language) only for this provider. With it on, the
  sheet job downloads the video's own caption track with yt-dlp (`--write-subs`,
  else `--write-auto-subs`, converted to SRT) and draws the line that belongs to
  each sampled timestamp along the bottom of the tile. Music-video sheets then
  read like lyrics sheets. API: add `"captions": true` and optionally
  `"captionLang": "en"` to `POST /api/jobs`. A video without a caption track is
  not an error — the job logs `captions skipped` and makes a normal sheet.
* UI build 2026-11-12.7: the Captions row now uses a **dropdown** populated from
  `GET /api/captions?provider=youtube&id=<id>` listing every track YouTube offers
  (manual + auto-generated, grouped). Selecting a track sends
  `"captionLang": "<lang>::<source>"` (e.g. `"en::manual"`); blank = automatic pick.
  Tracks without captions show “no captions on this video”.
* UI build 2026-11-12.9: **Download subtitles** button in the Captions section
  downloads the selected track as SRT or VTT (with timestamps) via
  `GET /api/subtitles?provider=youtube&id=<id>&lang=<track>&format=srt|vtt`.
  Subtitles are only available for the YouTube provider.
* Smoke test: `. .\scripts\env.ps1; node scripts\smoke_youtube.js [query|link]`
  (includes a caption-parser unit step and live caption downloads).

## Video → PDF (UI build 2026-11-12.2)

A card in the search panel turns a whole YouTube **Short** into a PDF of its frames.
It is not restricted to Shorts — any video link works — but it is built for short
clips: a 60 s Short at 30 fps is 1,800 pages, while a 20 min video is not practical.

* Paste a Shorts / watch / `youtu.be` link, choose **fps** (default **30**, max 30)
  and frame width (320/480/640/854, default 640), press **Make PDF**.
* The bridge resolves the link, downloads the whole video once with yt-dlp, decodes
  every frame at the chosen rate (`ffmpeg fps=N`), and writes one PDF page per frame.
  JPEGs are embedded as-is (`DCTDecode`), so building thousands of pages is quick and
  memory-cheap.
* When the PDF is written, the downloaded video and **all frame images are deleted**
  (`data\cache\pdf-*`). The PDF survives in
  `extensions\youtube\pdfs\YouTube\<Title>\frames-<fps>fps-<width>w.pdf` with a
  `.json` sidecar, served at `/pdfs/...`.
* Progress appears in the **Jobs** panel; the finished card offers **Save PDF**, and
  the browser saves it automatically when the page queued it.
* API: `POST /api/jobs` with `{"provider":"youtube","id":"<videoId>","kind":"pdf",
  "fps":30,"width":640,"title":"<name>","type":"movie"}`; poll `GET /api/jobs/<id>`
  and read `job.pdfs[0]`. Frames are capped at 30,000 (~16 min at 30 fps) so a long
  video fails with a clear message instead of filling the disk.
* Video → PDF is **YouTube only** in the UI (same native-content rule as sheets).

## Edit workspace and cache cleanup

The edit skill (`D:\Claude Cinematics\skills\cloudstream-edit`) keeps one folder per title:

```text
edit-workspace\<Title>\inputs\   reference, song, source copies   (kept)
edit-workspace\<Title>\plan\     brief, edit_map.csv, profile     (kept)
edit-workspace\<Title>\output\   renders                          (kept)
edit-workspace\<Title>\cache\    sheets, frames, subtitles, strips (disposable)
```

`DELETE_CACHE.bat` lists the disposable caches with their sizes, then asks three times
(`y` + Enter, "are you sure" `y`, "really sure" `y`); any other answer cancels. It empties
only `edit-workspace\*\cache`, `data\cache` and `extensions\*\contact-sheets`, and leaves
`inputs`, `plan`, `output`, `media` and the bridge's `clips` alone. `DELETE_CACHE.bat
-ListOnly` shows the list and deletes nothing. Agent rules for this folder: `AGENTS.md`.
