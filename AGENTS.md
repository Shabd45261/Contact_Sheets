# AGENTS.md - Cloudstream (local)

Local-first source for film, series, episode and YouTube-native edits. Node bridge +
extension repositories + an edit workspace. Read this before touching the folder.

**Agent gate:** this folder is its OWN git repo (`Contact_Sheets`); the parent repo
ignores `cloudstream/` on purpose. See the root `..\AGENTS.md` §0 before any work.
Publish only authored source (`app\`, `scripts\`, config, launchers, docs) and UI assets
the source references. Never commit generated contact sheets, clips, PDFs, caches,
downloads, subtitles (`*.srt`, `*.vtt`) or screenshot artifacts. Extensions under
`extensions\<repo>\` are restored by URL from `config\repos.json`, not from git.

## Layout

```
app\server.js            the bridge (HTTP API + UI); app\lib\*, app\public\*
scripts\                 index_repos.py, clone_all.py, contact_sheets.py, env.ps1,
                         run_bridge.ps1, terminate.ps1, delete_cache.ps1
extensions\<repo>\       cloned repositories, plugins\, plus bridge output:
                         clips\ (keep)  contact-sheets\ (disposable)  pdfs\ (keep)
extensions\youtube\      NOT a clone: output root of the bridge-native YouTube
                         provider (same clips\ / contact-sheets\ layout)
data\                    catalog.json, cache\ (disposable), jobs, downloads, ...
media\<Title>\...        the local library (keep)
edit-workspace\<Title>\  inputs\ plan\ output\ (keep)   cache\ (disposable)
start.bat  terminate.bat  DELETE_CACHE.bat  start_youtube.bat
```

## The bridge

`start.bat` serves everything on `http://127.0.0.1:8787` (the `start_<provider>.bat`
launchers use 8788-8792). The bridge's own agent guide is at
`http://127.0.0.1:8787/api/agent.md` and the OpenAPI document at `/api/openapi.json`.
Check `/api/health` first. If it reports `stale: true` or `api < 3`, run `terminate.bat`
then `start.bat`; the server keeps old JavaScript in memory.

Bind to `127.0.0.1` only. Never expose the bridge or upload the library.

### Runtime requirements

The bridge shells out to `ffmpeg` and `ffprobe`. If they are not on PATH, every job
fails with `spawn ffprobe ENOENT` and the error names nothing useful. Start it
through `scripts\run_bridge.ps1` (which dot-sources `scripts\env.ps1` and sets
`FFMPEG_PATH`/`FFPROBE_PATH`), or set those two variables before starting
`node app\server.js` by hand.

The `youtube` provider additionally needs the **yt-dlp** binary (`env.ps1` sets
`YTDLP_PATH`; winget, `tools\yt-dlp\yt-dlp.exe` or PATH all work). Without it,
YouTube search-with-a-pasted-link, streams, sheets and clips all fail. YouTube
streams pair a video-only and an audio-only format: provider streams carry
`audioUrl`, and clip jobs mux both inputs — do not treat `url` as self-contained.

`/api/duration` can return 500 while the stream still probes fine; use
`/api/streams` and probe the returned URL directly.

### Working with a film or series: contact sheets and clips

**Never download a whole movie or series.** Sample frames from the stream instead.

- `POST /api/jobs` — contact-sheet job. Any two of `interval` / `perSheet` / `sheets`.
  `maxFrames` defaults to 120; raise it for a feature film.
- `interval` is seconds between frames. **60 s for a feature film.** 300 s skips too
  much: whole scenes fall between samples.
- `window` samples a slice: `{ "center":"12:34", "before":60, "after":30, "interval":2 }`.
- `captions: true` (YouTube only) burns the video's own YouTube caption line into
  every sampled frame; `captionLang` picks the track (`en`, `en-US`, …). A video
  without captions still gets a normal sheet.
- Subtitle files (SRT/VTT with timestamps) can be downloaded for YouTube videos
  via `GET /api/subtitles?provider=youtube&id=<id>&lang=<track>&format=srt|vtt`;
  `GET /api/captions?provider=youtube&id=<id>` lists available tracks. MovieBox
  and CastleTV expose subtitle tracks too (`season`/`episode` params select the
  episode; MovieBox serves .srt, CastleTV serves .vtt — both are converted to the
  requested format). 4KHDHub / VegaMovies have no subtitle source.
- **Video → PDF** (UI card, meant for Shorts): paste a YouTube Shorts link, pick
  fps (30 default) and width. It works for any video but is sized for short clips.
  `POST /api/jobs` with `"kind":"pdf"` downloads the whole video once, decodes every
  frame, writes one PDF page per frame and then deletes the video and the frame
  images. Output: `extensions\<repo>\pdfs\<Provider>\<Title>\frames-<fps>fps-<width>w.pdf`
  (served at `/pdfs/...`). Capped at 30,000 frames (~16 min at 30 fps).
- Sheets are written to `extensions\<repo>\contact-sheets\...` and served at
  `/sheets/...`.
- `GET /api/clip?...&start=<s>&duration=<s>` — pull only the range you will cut.
  Clips cache under `extensions\<repo>\clips\...` with a `.json` sidecar.
- Provider signed URLs expire; a batch of clip requests can 500 mid-run. Retry.
- Direct ffmpeg on a stream URL needs `-allowed_extensions ALL -extension_picky 0`
  plus the provider headers via `-headers`. `-origin` is not an ffmpeg option.

### Working with YouTube: native content only

The `youtube` provider (bridge-native, `app\lib\providers\youtube.js`) exists for
**creating content**: music videos, official trailers, creator videos, UGC and
Shorts — edit footage, pacing/style reference and audio. The search box (and
`/api/search?q=`) also accepts a pasted watch / Shorts / `youtu.be` link, a bare
11-character video id, or a playlist / channel URL (returned as a series whose
episodes are the videos, capped at 200). Live streams are rejected.

Output lands in `extensions\youtube\clips\` and `contact-sheets\` like any other
provider.

Contact-sheet jobs can burn YouTube's caption line into each frame: send
`"captions": true` (the UI shows a **Captions** row with a language box only on
this provider). The track is fetched with yt-dlp (`--write-subs`, falling back to
`--write-auto-subs`, converted to SRT), parsed, and the line that belongs to each
sampled timestamp is drawn at the bottom of the tile — so a music video sheet
shows the lyrics being sung at that moment. Auto-caption rolls are de-duplicated
(longest cue wins). A video with no captions logs `captions skipped` and produces
a normal sheet; `job.sheets[].captions` reports `{ lang, source, cues }`.

## Rules for agents

1. Edit workflows live in the skill `D:\Claude Cinematics\skills\cloudstream-edit` (SKILL.md).
   Use its scripts rather than calling the bridge by hand where one exists.
2. Do not delete anything. Cache cleanup is the user's job: `DELETE_CACHE.bat`
   (`-ListOnly` to preview). It empties `edit-workspace\*\cache`, `data\cache` and
   `extensions\*\contact-sheets` only, after three confirmations.
3. Never modify `media\`, `extensions\*\clips`, `inputs`, `plan` or `output` folders
   except to add the files the task asks for.
4. Do not claim a provider, download or subtitle source works until it has answered on
   this machine. The `.cs3` files are Android artifacts; the bridge uses its own
   provider implementations.
5. Footage for edits comes from here or from a clean file the user supplies. The
   `youtube` provider may supply **native YouTube content** (music videos,
   trailers, creator videos, UGC, Shorts); it must never be used to pull a film
   or series episode — those come from the moviebox/castle providers or a clean
   user file.
6. Keys live in `config\subtitle_keys.json` (not in the repo, never printed).
