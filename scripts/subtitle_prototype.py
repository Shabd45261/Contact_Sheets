"""Subtitle providers — Python port of the subtitle logic from the CloudStream extensions.

Source of truth: decompiled .cs3 plugins (data\\decompile\\, jadx + baksmali):

  moviebox   MovieBoxProvider.cs3 (phisher + cncverse builds are identical here)
             - loadCaptions(subjectId, streamId, audioLanguage) calls two endpoints
               with the SAME signed auth headers as the streams:
                 GET /wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=..&streamId=..
                 GET /wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=..&resourceId=..&episode=0
             - both answers carry data.extCaptions = [{url, lanName?, language?, lan?}]
             - label = EnglishName(rawLang) || EnglishName(rawLang.split("-")[0]) || rawLang
                       + " (" + audioLanguage.replace("dub", "Audio") + ")"
             - deduped by URL; streamId = play-info stream "id", fallback "season|episode"

  castle     CastleTvProvider.cs3 (cncverse)
             - GET  /v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US
               -> {code:200, data:"<base64>"}
             - AES key = first 16 bytes of base64decode(data) + b"T!BgJB" (zero-padded if short)
             - every film-api answer is base64(AES-128-CBC(PKCS7)) with IV == key
             - POST /film-api/v2.0.1/movie/getVideo2?...  body carries movieId, episodeId,
               optional languageId (trailing comma), apkSignKey ED0955EB04E67A1D9F3305B95454FED485261475
               -> decrypted data.subtitles = [{languageId, abbreviate, title, url, isDefault, isAI}]
             - label = title || abbreviate || "Unknown"; blank urls skipped
             - episode tracks (details v1.9.9) give languageId/languageName per audio track

  fourkhdhub FourKHDHub.cs3 (phisher)
             - provides NO subtitles. The subtitleCallback is only threaded through
               HubCloud/Hubdrive/Hblinks/HUBCDN and none of them emit a SubtitleFile.

Status rule from AGENTS.md: nothing is "working" until it has answered on this machine —
run `python subtitle_prototype.py moviebox <name>` / `... castle <name>` to verify live.

Usage:
  python subtitle_prototype.py moviebox <query>              search + list caption candidates
  python subtitle_prototype.py castle <query>                search + details + subtitle list
  python subtitle_prototype.py serve [--port 8799]           serve subtitle-test.html + /api/*
  python subtitle_prototype.py fetch --provider castle --url <subtitle-url>
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import string
import sys
import time
import urllib.parse
import urllib.request

from Crypto.Cipher import AES  # pycryptodome, already on this machine

# --------------------------------------------------------------------------------------
# MovieBox (aoneroom) — auth identical to app/lib/providers/moviebox.js
# --------------------------------------------------------------------------------------

MB_HOSTS = [
    "https://apig.inmoviebox.com", "https://apii.inmoviebox.com",
    "https://api7.aoneroom.com", "https://api6.aoneroom.com", "https://api5.aoneroom.com",
    "https://api4.aoneroom.com", "https://api4sg.aoneroom.com", "https://api3.aoneroom.com",
]
MB_CLIENT_BUILDS = [
    "1790144723381916466.632cf3fe507b339bc757f117f85b4c4a",
]
# base64 of text which is itself base64 of the real HMAC key (same double encoding as the app)
_MB_SECRET_B64 = "NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw=="
MB_SECRET = base64.b64decode(base64.b64decode(_MB_SECRET_B64).decode())
MB_VERSION_NAME = os.environ.get("MB_VERSION_NAME", "4.0.03.1028.03")
MB_VERSION_CODE = os.environ.get("MB_VERSION_CODE", "50020135")
MB_UA = (f"com.community.oneroom/{MB_VERSION_CODE} (Linux; U; Android 14; en_IN; Pixel 8; "
         "Build/UD1A.230803.041; Cronet/145.0.7582.0)")
MB_CLIENT_INFO_BASE = {
    "package_name": "com.community.oneroom", "version_name": MB_VERSION_NAME,
    "version_code": int(MB_VERSION_CODE), "os": "android", "os_version": "14",
    "install_store": "official", "gaid": "1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",
    "brand": "Google", "model": "Pixel 8", "system_language": "en",
    "net": "NETWORK_WIFI", "region": "IN", "timezone": "Asia/Calcutta", "sp_code": "",
}


class MovieBoxError(RuntimeError):
    pass


class MovieBox:
    def __init__(self, host: str | None = None):
        self.hosts = [host] if host else list(MB_HOSTS)
        self.host = self.hosts[0]
        self.token: str | None = None
        self.device_id = "".join(random.choices("0123456789abcdef", k=32))

    # ---- auth headers (port of MovieBoxProvider.buildAuthHeaders / _headers in moviebox.js)
    def _headers(self, method: str, url: str, body: bytes | None, ct: str, accept: str) -> dict:
        ts = str(int(time.time() * 1000))
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        canonical_url = parsed.path
        if query:
            canonical_url += "?" + "&".join(f"{k}={v}" for k, v in sorted(query))
        body_md5 = hashlib.md5(body[:102400]).hexdigest() if body else ""
        canonical = "\n".join([
            method.upper(), accept, ct, str(len(body)) if body else "", ts, body_md5, canonical_url,
        ])
        sig = base64.b64encode(hmac.new(MB_SECRET, canonical.encode(), hashlib.md5).digest()).decode()
        client_token = f"{ts},{hashlib.md5(ts[::-1].encode()).hexdigest()}"
        h = {
            "user-agent": MB_UA,
            "accept": accept,
            "content-type": ct,
            "connection": "keep-alive",
            "x-client-token": client_token,
            "x-tr-signature": f"{ts}|2|{sig}",
            "x-client-info": json.dumps({**MB_CLIENT_INFO_BASE, "device_id": self.device_id}),
            "x-client-status": "0",
            "x-client-build": MB_CLIENT_BUILDS[0],
        }
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        return h

    def _req(self, method: str, path: str, body: bytes | None = None,
             *, no_auth: bool = False, retried: bool = False) -> dict:
        last_err: Exception | None = None
        for host in self.hosts:
            url = host + path
            ct, accept = "application/json; charset=utf-8", "application/json"
            headers = self._headers(method, url, body, ct, accept)
            if no_auth:
                headers.pop("Authorization", None)
            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            try:
                # go direct like Node fetch does — the system proxy answers 407
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(req, timeout=30) as resp:
                    text = resp.read().decode("utf-8", "replace")
            except Exception as e:  # noqa: BLE001 - try the next host
                last_err = e
                continue
            try:
                data = json.loads(text)
            except ValueError:
                data = {"raw": text}
            if resp.status == 441 and not no_auth and not retried:
                self.login(force=True)
                return self._req(method, path, body, retried=True)
            self.host = host
            return data
        raise MovieBoxError(f"moviebox unreachable: {last_err}")

    def login(self, force: bool = False) -> str:
        if self.token and not force:
            return self.token
        data = self._req("POST", "/wefeed-mobile-bff/user-api/visitor-login", b"{}", no_auth=True)
        token = ((data.get("data") or {}).get("token")) or ""
        if not token:
            raise MovieBoxError("moviebox login failed: " + json.dumps(data)[:200])
        self.token = token
        return token

    # ---- catalogue
    def search(self, keyword: str, page: int = 1) -> list[dict]:
        self.login()
        body = json.dumps({"page": page, "perPage": 20, "keyword": keyword, "restrictKid": 0}).encode()
        data = self._req("POST", "/wefeed-mobile-bff/subject-api/search/v2", body)
        items: list[dict] = []
        for group in ((data.get("data") or {}).get("results")) or []:
            items.extend(group.get("subjects") or [])
        return items

    def detail(self, subject_id: str) -> dict:
        self.login()
        return (self._req("GET", f"/wefeed-mobile-bff/subject-api/get?subjectId={subject_id}")
                .get("data") or {})

    def play_info(self, subject_id: str, season: int = 0, episode: int = 0) -> dict:
        self.login()
        return (self._req("GET", "/wefeed-mobile-bff/subject-api/play-info"
                              f"?subjectId={subject_id}&se={season}&ep={episode}")
                .get("data") or {})

    def resources(self, subject_id: str, page: int = 1, resolution: int | None = None) -> dict:
        self.login()
        url = (f"/wefeed-mobile-bff/subject-api/resource?subjectId={subject_id}"
               f"&page={page}&perPage=20&all=0&pagerMode=0")
        if resolution:
            url += f"&resolution={resolution}"
        return self._req("GET", url).get("data") or {}

    # ---- the subtitle part (loadCaptions port)
    def stream_id_candidates(self, subject_id: str, season: int = 0, episode: int = 0) -> list[str]:
        """streamId the extension passes to loadCaptions: play-info stream ids,
        resource item ids, then the documented 'season|episode' fallback."""
        ids: list[str] = []
        try:
            for s in (self.play_info(subject_id, season, episode).get("streams")) or []:
                sid = s.get("id")
                if sid is not None and str(sid) not in ids:
                    ids.append(str(sid))
        except Exception:  # noqa: BLE001
            pass
        try:
            res = self.resources(subject_id)
            for item in (res.get("list")) or []:
                rid = item.get("id")
                if rid is not None and str(rid) not in ids:
                    ids.append(str(rid))
        except Exception:  # noqa: BLE001
            pass
        fallback = f"{season}|{episode}"
        if fallback not in ids:
            ids.append(fallback)
        return ids

    def _caption_items(self, path: str) -> list[dict]:
        data = self._req("GET", path)
        root = data.get("data") or {}
        ext = root.get("extCaptions")
        return ext if isinstance(ext, list) else []

    def captions(self, subject_id: str, stream_id: str, audio_language: str = "English") -> list[dict]:
        """Both loadCaptions endpoints, merged, normalised and deduped by url."""
        self.login()
        seen: set[str] = set()
        out: list[dict] = []
        paths = [
            f"/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId={subject_id}&streamId={urllib.parse.quote(stream_id)}",
            f"/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId={subject_id}&resourceId={urllib.parse.quote(stream_id)}&episode=0",
        ]
        for path in paths:
            for caption in self._caption_items(path):
                url = (caption.get("url") or "").strip()
                if not url or url in seen:
                    continue
                seen.add(url)
                raw = caption.get("lanName") or caption.get("language") or caption.get("lan") or ""
                label = tag_to_english(raw) or tag_to_english(raw.split("-")[0]) or raw
                label = f"{label} ({audio_language.replace('dub', 'Audio')})"
                out.append({
                    "url": url, "label": label, "rawLang": raw,
                    "endpoint": "stream-captions" if "get-stream-captions" in path else "ext-captions",
                })
        return out

    def captions_all(self, subject_id: str, audio_language: str = "English",
                     season: int = 0, episode: int = 0) -> list[dict]:
        merged: list[dict] = []
        seen: set[str] = set()
        for stream_id in self.stream_id_candidates(subject_id, season, episode):
            try:
                for cap in self.captions(subject_id, stream_id, audio_language):
                    if cap["url"] not in seen:
                        seen.add(cap["url"])
                        merged.append({**cap, "streamId": stream_id})
            except Exception as e:  # noqa: BLE001 - next candidate
                print(f"  ! streamId {stream_id!r}: {e}", file=sys.stderr)
        return merged


# Compact stand-in for SubtitleHelper.fromTagToEnglishLanguageName
_LANG_TAGS = {
    "en": "English", "hi": "Hindi", "ta": "Tamil", "te": "Telugu", "ml": "Malayalam",
    "kn": "Kannada", "bn": "Bengali", "mr": "Marathi", "pa": "Punjabi", "gu": "Gujarati",
    "ur": "Urdu", "ar": "Arabic", "es": "Spanish", "fr": "French", "de": "German",
    "pt": "Portuguese", "ru": "Russian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
    "it": "Italian", "tr": "Turkish", "id": "Indonesian", "th": "Thai", "vi": "Vietnamese",
    "ms": "Malay", "fa": "Persian", "pl": "Polish", "nl": "Dutch", "sv": "Swedish",
}


def tag_to_english(tag: str) -> str:
    t = (tag or "").strip().lower()
    if not t:
        return ""
    return _LANG_TAGS.get(t, "")


# --------------------------------------------------------------------------------------
# CastleTV (api.hlowb.com film-api) — AES-CBC responses
# --------------------------------------------------------------------------------------

CASTLE_MAIN = "https://api.hlowb.com"
CASTLE_KEY_SALT = b"T!BgJB"            # CastleTvProvider.keySupFixx
CASTLE_APK_SIGN_KEY = "ED0955EB04E67A1D9F3305B95454FED485261475"
CASTLE_UA = ("Dalvik/2.1.0 (Linux; U; Android 13; Pixel 8 Build/TQ3A.230901.001)")
CASTLE_PKG = "com.external.castle"


class CastleError(RuntimeError):
    pass


class Castle:
    def __init__(self, main_url: str = CASTLE_MAIN):
        self.main_url = main_url
        self._key: bytes | None = None

    # ---- crypto (deriveKey + decryptData port)
    def _derive_key(self, api_key_b64: str) -> bytes:
        material = base64.b64decode(api_key_b64) + CASTLE_KEY_SALT
        if len(material) < 16:
            return material + b"\x00" * (16 - len(material))
        return material[:16]

    def security_key(self) -> str:
        url = f"{self.main_url}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US"
        req = urllib.request.Request(url, headers={"user-agent": CASTLE_UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
        if payload.get("code") != 200 or not payload.get("data"):
            raise CastleError(f"getSecurityKey failed: {json.dumps(payload)[:200]}")
        return payload["data"]

    def _aes_key(self) -> bytes:
        if self._key is None:
            self._key = self._derive_key(self.security_key())
        return self._key

    def decrypt(self, encrypted_b64: str) -> dict | None:
        key = self._aes_key()
        raw = base64.b64decode(encrypted_b64)
        if len(raw) == 0 or len(raw) % 16 != 0:
            return None
        cipher = AES.new(key, AES.MODE_CBC, iv=key)
        text = cipher.decrypt(raw)
        pad = text[-1]
        if 1 <= pad <= 16:
            text = text[:-pad]
        try:
            return json.loads(text.decode("utf-8"))
        except ValueError:
            return None

    # ---- film-api calls (all answers encrypted)
    def _encrypted_get(self, path: str) -> dict | None:
        url = self.main_url + path
        req = urllib.request.Request(url, headers={"user-agent": CASTLE_UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return self.decrypt(resp.read().decode("utf-8", "replace"))

    def _encrypted_post(self, path: str, body: dict) -> dict | None:
        url = self.main_url + path
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"user-agent": CASTLE_UA, "content-type": "application/json; charset=utf-8"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return self.decrypt(resp.read().decode("utf-8", "replace"))

    def search(self, keyword: str) -> list[dict]:
        path = (f"/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&clientType=1"
                f"&keyword={urllib.parse.quote(keyword)}&lang=en-US&mode=1"
                f"&packageName={CASTLE_PKG}&page=1&size=30")
        data = self._encrypted_get(path) or {}
        return ((data.get("data") or {}).get("rows")) or []

    def details(self, movie_id: str) -> dict:
        path = (f"/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&clientType=1&lang=en-US"
                f"&movieId={movie_id}&packageName={CASTLE_PKG}")
        data = self._encrypted_get(path) or {}
        return data.get("data") or {}

    def get_video2(self, movie_id: str, episode_id: str,
                   language_id: str | int | None = None, resolution: str = "1080") -> dict:
        """VideoData{videoUrl, videos, subtitles[], ...}. languageId picks the audio track."""
        lang = f"\"languageId\":\"{language_id}\"," if language_id is not None else ""
        body_raw = (
            '{"mode":"1","appMarket":"GuanWang","clientType":"1","woolUser":"false",'
            f'"apkSignKey":"{CASTLE_APK_SIGN_KEY}","androidVersion":"13",{lang}'
            f'"movieId":"{movie_id}","episodeId":"{episode_id}","isNewUser":"true",'
            f'"resolution":"{resolution}","packageName":"{CASTLE_PKG}"}}'
        )
        path = ("/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle"
                "&channel=IndiaA&lang=en-US")
        data = self._encrypted_post(path, json.loads(body_raw)) or {}
        return data.get("data") or {}

    @staticmethod
    def _normalise_subs(raw_subs: list[dict], source: str) -> list[dict]:
        out: list[dict] = []
        seen: set[str] = set()
        for sub in raw_subs:
            url = (sub.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            label = sub.get("title") or sub.get("abbreviate") or "Unknown"
            out.append({
                "url": url, "label": label, "source": source,
                "abbreviate": sub.get("abbreviate") or "",
                "languageId": sub.get("languageId"),
                "isDefault": bool(sub.get("isDefault")),
                "isAI": bool(sub.get("isAI")),
            })
        return out

    def episode_subtitles(self, movie_id: str, episode_id: str) -> list[dict]:
        """Details v1.9.9 already carries the full SubtitleData list per episode —
        the simplest source, no getVideo2 needed."""
        for ep in (self.details(movie_id).get("episodes")) or []:
            if str(ep.get("id")) == str(episode_id):
                return self._normalise_subs(ep.get("subtitles") or [], "details")
        return []

    def subtitles(self, movie_id: str, episode_id: str,
                  language_id: str | int | None = None,
                  resolution: str | None = None) -> list[dict]:
        """SubtitleData list, normalised the way emitTrack does it.

        Order: episode-level subtitles from details, then getVideo2. Live-verified
        on this machine: getVideo2 accepts the internal resolution codes "2"/"1"
        and answers permissionDenied for "1080"/"4"."""
        subs = self.episode_subtitles(movie_id, episode_id)
        if subs:
            return subs
        for res in ([resolution] if resolution else ["2", "1"]):
            video = self.get_video2(movie_id, episode_id, language_id, res)
            if video.get("permissionDenied"):
                continue
            subs = self._normalise_subs(video.get("subtitles") or [], f"getVideo2:{res}")
            if subs:
                return subs
        return []


# --------------------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------------------

def fetch_subtitle_text(url: str, user_agent: str | None = None) -> str:
    # subtitle urls from both providers contain raw spaces ("English - SDH.vtt");
    # ExoPlayer accepts them, urllib does not — encode anything unsafe.
    url = urllib.parse.quote(url, safe="!#$&'()*+,/:;=?@-._~%")
    headers = {"user-agent": user_agent or "Mozilla/5.0"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def srt_to_vtt(text: str) -> str:
    """Only if a file arrives as SRT and a player wants VTT; otherwise passthrough."""
    if text.lstrip().startswith("WEBVTT"):
        return text
    out = ["WEBVTT", ""]
    for block in text.replace("\r\n", "\n").split("\n\n"):
        lines = [l for l in block.split("\n") if l.strip()]
        if len(lines) >= 2 and "-->" in lines[1]:
            lines[1] = lines[1].replace(",", ".")
            out += lines
        elif len(lines) >= 2 and "-->" in lines[0]:
            out += lines
    return "\n".join(out)


def pick_moviebox_subject(results: list[dict]) -> dict | None:
    for s in results:
        if s.get("hasResource") is not False:
            return s
    return results[0] if results else None


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

def _cli_moviebox(query: str) -> None:
    mb = MovieBox()
    print("login ok")
    results = mb.search(query)
    subject = pick_moviebox_subject(results)
    if not subject:
        print("no results")
        return
    subject_id = str(subject.get("subjectId") or subject.get("id") or "")
    print(f"subject: {subject_id}  {subject.get('title')!r}  type={subject.get('subjectType')}")
    caps = mb.captions_all(subject_id)
    if not caps:
        print("no caption tracks returned for any streamId candidate")
        return
    for cap in caps:
        print(f"  [{cap['endpoint']} via streamId={cap['streamId']}] {cap['label']}\n    {cap['url']}")
    text = fetch_subtitle_text(caps[0]["url"], MB_UA)
    print(f"\nfirst track, first 300 chars:\n{text[:300]}")


def _cli_castle(query: str) -> None:
    castle = Castle()
    results = castle.search(query)
    if not results:
        print("no results")
        return
    items = results if isinstance(results, list) else [results]
    first = items[0]
    movie_id = str(first.get("movieId") or first.get("id") or "")
    print(f"movie: {movie_id}  {first.get('title') or first.get('movieName')!r}")
    details = castle.details(movie_id)
    episodes = details.get("episodes") or []
    if not episodes:
        print("no episodes in details; keys:", list(details.keys()))
        return
    ep = episodes[0]
    episode_id = str(ep.get("id") or "")
    tracks = ep.get("tracks") or []
    print(f"episode: {episode_id}  tracks: "
          f"{[(t.get('languageId'), t.get('languageName')) for t in tracks]}")
    language_id = tracks[0].get("languageId") if tracks else None
    subs = castle.subtitles(movie_id, episode_id, language_id)
    if not subs:
        print("no subtitle tracks returned by getVideo2")
        return
    for s in subs:
        print(f"  {s['label']}  default={s['isDefault']}  isAI={s['isAI']}\n    {s['url']}")
    text = fetch_subtitle_text(subs[0]["url"], CASTLE_UA)
    print(f"\nfirst track, first 300 chars:\n{text[:300]}")


def _serve(port: int, html_path: str) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    mb = MovieBox()
    castle = Castle()

    class Handler(BaseHTTPRequestHandler):
        def _json(self, obj, status: int = 200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            q = dict(urllib.parse.parse_qsl(parsed.query))
            try:
                if parsed.path == "/" or parsed.path.endswith("subtitle-test.html"):
                    with open(html_path, "rb") as f:
                        body = f.read()
                    self.send_response(200)
                    self.send_header("content-type", "text/html; charset=utf-8")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif parsed.path == "/api/moviebox/search":
                    self._json({"items": mb.search(q.get("q", ""))})
                elif parsed.path == "/api/moviebox/captions":
                    self._json({"items": mb.captions_all(q.get("subjectId", ""))})
                elif parsed.path == "/api/castle/search":
                    self._json({"items": castle.search(q.get("q", ""))})
                elif parsed.path == "/api/castle/details":
                    self._json({"data": castle.details(q.get("movieId", ""))})
                elif parsed.path == "/api/castle/subtitles":
                    self._json({"items": castle.subtitles(
                        q.get("movieId", ""), q.get("episodeId", ""),
                        q.get("languageId") or None,
                        q.get("resolution") or None)})
                elif parsed.path == "/api/preview":
                    prov = q.get("provider") or ""
                    ua = MB_UA if prov == "moviebox" else (CASTLE_UA if prov == "castle" else None)
                    text = fetch_subtitle_text(q.get("url", ""), ua)
                    self._json({"text": text[:6000], "vtt": srt_to_vtt(text)[:6000]})
                else:
                    self._json({"error": "unknown path"}, 404)
            except Exception as e:  # noqa: BLE001
                self._json({"error": str(e)}, 500)

        def log_message(self, *args):  # keep the console quiet
            pass

    print(f"subtitle prototype on http://127.0.0.1:{port}/  (html: {html_path})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["moviebox", "castle", "serve", "fetch"])
    ap.add_argument("query", nargs="?", help="search query for moviebox/castle")
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--provider", choices=["moviebox", "castle"])
    ap.add_argument("--url", help="subtitle url to download (fetch)")
    args = ap.parse_args()

    if args.command == "moviebox":
        _cli_moviebox(args.query or "")
    elif args.command == "castle":
        _cli_castle(args.query or "")
    elif args.command == "fetch":
        if not args.url:
            ap.error("--url required")
        ua = MB_UA if args.provider == "moviebox" else None
        print(fetch_subtitle_text(args.url, ua))
    elif args.command == "serve":
        _serve(args.port, os.path.join(here, "subtitle-test.html"))


if __name__ == "__main__":
    main()
