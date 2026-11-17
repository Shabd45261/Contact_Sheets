'use strict';
/* CastleTV provider — ported from cncverse/CastleTvProvider (AES-wrapped JSON API). */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { request, UA_DESKTOP, ensureDir } = require('../util');
const { convertSubtitle } = require('../subtitles');

const HOST = 'https://api.hlowb.com';
const SUP = 'T!BgJB';
const HEADERS = {
  'user-agent': UA_DESKTOP,
  accept: 'application/json',
  referer: 'https://www.castleapp.com/',
  origin: 'https://www.castleapp.com',
};

function deriveKey(b64) {
  const raw = Buffer.from(b64, 'base64');
  const material = Buffer.concat([raw, Buffer.from(SUP, 'ascii')]);
  return material.length >= 16 ? material.subarray(0, 16) : Buffer.concat([material, Buffer.alloc(16 - material.length)]);
}
function decrypt(b64, keyB64) {
  const key = deriveKey(keyB64);
  const d = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

class CastleProvider {
  constructor(meta = {}) {
    this.id = meta.id || 'castle';
    this.name = meta.name || 'CastleTV';
    this.repo = meta.repo || 'cncverse';
    this.plugin = meta.plugin || 'CastleTvProvider';
    this.pluginUrl = meta.pluginUrl || '';
    this._key = null;
    this._keyAt = 0;
  }

  async securityKey(force = false) {
    if (!force && this._key && Date.now() - this._keyAt < 30 * 60 * 1000) return this._key;
    const r = await request(`${HOST}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US`, { headers: HEADERS });
    const j = r.json();
    if (!j || j.code !== 200 || !j.data) throw new Error('CastleTV: security key unavailable');
    this._key = j.data;
    this._keyAt = Date.now();
    return this._key;
  }

  async _get(pathAndQuery) {
    const key = await this.securityKey();
    const r = await request(HOST + pathAndQuery, { headers: HEADERS });
    if (!r.ok) throw new Error(`CastleTV HTTP ${r.status}`);
    try {
      return JSON.parse(decrypt(r.text, key));
    } catch (e) {
      throw new Error('CastleTV: could not decrypt response (' + e.message + ')');
    }
  }

  /* Cached raw detail for a movieId (each season is its own movieId). */
  async _raw(movieId) {
    const key = String(movieId);
    if (!this._cache) this._cache = new Map();
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
    const p = `/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&clientType=1&lang=en-US&movieId=${encodeURIComponent(key)}&packageName=com.external.castle`;
    const j = await this._get(p);
    const data = j.data || {};
    this._cache.set(key, { at: Date.now(), data });
    return data;
  }

  async search(query) {
    const p = `/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&clientType=1&keyword=${encodeURIComponent(query)}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=30`;
    const j = await this._get(p);
    const rows = (j.data && j.data.rows) || [];
    const items = rows.map(r => ({
      id: String(r.id),
      title: r.title || '',
      year: r.publishTime ? String(new Date(r.publishTime).getFullYear()) : '',
      poster: r.coverVerticalImage || r.coverHorizontalImage || '',
      type: r.movieType === 1 ? 'series' : 'movie',
      subtitle: [r.movieTypeName, r.indiaResolutionLabel, (r.languages || []).slice(0, 3).join('/')].filter(Boolean).join(' · '),
      rating: r.score != null ? String(r.score) : '',
      description: r.briefIntroduction || '',
      extra: { movieType: r.movieType, publishTime: r.publishTime, languages: r.languages || [] },
    }));
    return { items, total: (j.data && j.data.total) || items.length };
  }

  async detail(id) {
    const d = await this._raw(id);
    const isSeries = d.movieType === 1;
    const seasons = [];
    if (isSeries) {
      const list = (d.seasons || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
      // Every season is its own movieId; fetch them in parallel so all episode
      // counts are real (the root response only carries the current season).
      const raws = await Promise.all(list.map(s =>
        (String(s.movieId) === String(id) ? Promise.resolve(d) : this._raw(s.movieId).catch(() => null))));
      list.forEach((s, i) => {
        const raw = raws[i] || (s.isCurrent ? d : null);
        const eps = raw ? (raw.episodes || []) : [];
        const sn = raw && raw.seasonNumber ? raw.seasonNumber : (s.number || 1);
        seasons.push({
          season: s.number || sn,
          movieId: String(s.movieId || id),
          name: s.description || `Season ${s.number}`,
          isCurrent: !!s.isCurrent,
          episodes: eps.map(e => this._ep(e, s.number || sn)),
          lazy: !s.isCurrent,
        });
      });
      if (!seasons.length) {
        seasons.push({
          season: d.seasonNumber || 1, movieId: String(id), name: 'Season 1',
          episodes: (d.episodes || []).map(e => this._ep(e, d.seasonNumber || 1)), lazy: false,
        });
      }
    } else {
      const e = (d.episodes || [])[0];
      seasons.push({
        season: 0,
        movieId: String(id),
        name: 'Movie',
        episodes: [{
          id: e ? String(e.id) : '0',
          number: 0,
          season: 0,
          title: d.title || '',
          duration: e ? e.duration : 0,
          tracks: e ? (e.tracks || []) : [],
          videos: e ? (e.videos || []) : [],
          playResolution: e ? e.playResolution : 0,
        }],
      });
    }
    return {
      id: String(d.id || id),
      title: d.title || '',
      year: d.publishTime ? String(new Date(d.publishTime).getFullYear()) : '',
      poster: d.coverVerticalImage || d.coverHorizontalImage || '',
      backdrop: d.coverHorizontalImage || '',
      plot: d.briefIntroduction || '',
      rating: d.score != null ? String(d.score) : '',
      type: isSeries ? 'series' : 'movie',
      tags: d.tags || [],
      languages: d.languages || [],
      qualities: [1080, 720, 480],
      seasons,
    };
  }

  _ep(e, season) {
    return {
      id: String(e.id),
      number: e.number != null ? e.number : 0,
      season: season || 0,
      title: e.title || `Episode ${e.number}`,
      duration: e.duration || 0,
      tracks: e.tracks || [],
      videos: e.videos || [],
      resolution: e.playResolution,
    };
  }

  async seasonEpisodes(movieId, season) {
    const d = await this.detail(movieId);
    const s = d.seasons.find(x => x.season === season);
    return s ? s.episodes : [];
  }

  async getVideo(movieId, episodeId, languageId, resolution = 1080) {
    const key = await this.securityKey();
    const langPart = languageId != null ? `"languageId":"${languageId}",` : '';
    const body = `{"mode":"1","appMarket":"GuanWang","clientType":"1","woolUser":"false","apkSignKey":"ED0955EB04E67A1D9F3305B95454FED485261475","androidVersion":"13",${langPart}"movieId":"${movieId}","episodeId":"${episodeId}","isNewUser":"true","resolution":"${resolution}","packageName":"com.external.castle"}`;
    const r = await request(`${HOST}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en-US`, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' },
      body,
    });
    if (!r.ok) throw new Error(`CastleTV getVideo2 HTTP ${r.status}`);
    const json = JSON.parse(decrypt(r.text, key));
    return json.data || null;
  }

  /* Turn a videoUrl into free (non-signed) HLS candidates, as the plugin does. */
  freeCandidates(videoUrl) {
    if (!videoUrl) return [];
    const clean = videoUrl.split('?')[0];
    const authFree = clean.replace(/^https?:\/\/img1\./, m => m.replace('img1.', 'img.'));
    const dir = authFree.slice(0, authFree.lastIndexOf('/'));
    const out = new Map();
    const guess = dir.match(/\/(\d{3,4})(?:ts)?$/) || dir.match(/_(\d{3,4})(?:ts)?$/);
    out.set(dir + '/index.m3u8', guess ? parseInt(guess[1], 10) : 720);
    const m = dir.match(/^(.*\/(?:hls|hls_mps)\/[^/]+)\/\d+$/);
    if (m) for (const q of [1080, 720, 480]) out.set(`${m[1]}/${q}/index.m3u8`, q);
    const m2 = dir.match(/^(.*\/)([A-Za-z]+)_(\d+)(ts)?$/);
    if (m2) {
      const [, pre, lang] = m2;
      out.set(`${pre}${lang}_1080/index.m3u8`, 1080);
      out.set(`${pre}${lang}_720ts/index.m3u8`, 720);
      out.set(`${pre}${lang}_480ts/index.m3u8`, 480);
    }
    return [...out.entries()].map(([url, quality]) => ({ url, quality }));
  }

  /* Resolution ladder for an episode: free tiers first (highest first), then premium. */
  _ladder(ep, quality) {
    const meta = new Map();
    for (const v of (ep && ep.videos) || []) {
      if (v && v.resolution) {
        meta.set(Number(v.resolution), {
          premium: !!v.premiumProPermission,
          label: v.resolutionDescription || '',
        });
      }
    }
    const avail = [...meta.entries()].sort((a, b) => b[0] - a[0]);
    const free = avail.filter(([, v]) => !v.premium).map(([r]) => r);
    const paid = avail.filter(([, v]) => v.premium).map(([r]) => r);
    let order = [...free, ...paid];
    if (!order.length) order = [1, 2, 3];
    if (Number(quality) > 0) {
      const q = Number(quality);
      const want = q >= 1080 ? 3 : q >= 720 ? 2 : q >= 480 ? 1 : 0;
      order = [...new Set([want, ...order])].filter(r => r > 0);
    }
    return { order, meta };
  }

  _qualityFor(res, meta) {
    const m = meta.get(Number(res));
    const hit = /(\d{3,4})\s*P/i.exec((m && m.label) || '');
    if (hit) return parseInt(hit[1], 10);
    return res === 3 ? 1080 : res === 2 ? 720 : 480;
  }

  async streams({ id, season, episode, movieId, episodeId, quality }) {
    const detail = await this.detail(movieId || id);
    let mid = String(movieId || id);
    let epId = episodeId;
    let langId;
    let ep = null;
    if (detail.type === 'series') {
      const s = detail.seasons.find(x => x.season === Number(season)) || detail.seasons[0];
      mid = s.movieId;
      let eps = s.episodes;
      if (!eps.length) eps = await this.seasonEpisodes(mid, s.season);
      ep = eps.find(e => e.number === Number(episode)) || eps[0];
      if (ep) { epId = ep.id; langId = ep.tracks && ep.tracks[0] ? ep.tracks[0].languageId : undefined; }
    } else {
      ep = detail.seasons[0].episodes[0];
      epId = epId || ep.id;
    }
    if (!epId) throw new Error('CastleTV: no episode id for this selection');

    const { order, meta } = this._ladder(ep, quality);
    const failures = [];
    for (const res of order) {
      try {
        const data = await this.getVideo(mid, epId, langId, res);
        if (data && data.videoUrl) {
          return [{
            url: data.videoUrl,
            quality: this._qualityFor(res, meta),
            resolution: res,
            format: 'hls',
            server: 'castle',
            note: data.isPreview ? 'preview' : '',
            headers: { 'user-agent': UA_DESKTOP, referer: 'https://www.castleapp.com/', origin: 'https://www.castleapp.com' },
          }];
        }
        failures.push(`res ${res}: ${data && data.permissionDenied ? 'premium only' : 'no url'}`);
      } catch (e) { failures.push(`res ${res}: ${e.message}`); }
    }
    throw new Error('CastleTV: no stream available (' + failures.slice(0, 3).join(' | ') + ')');
  }

  /* ---------- subtitles (emitTrack SubtitleFile port) ----------
     The details answer already carries every episode's subtitle list
     (episodes[].subtitles: {languageId, abbreviate, title, url, isDefault, isAI});
     getVideo2 (v2.0.1) is the fallback and only accepts the internal resolution
     codes 2/1 — "1080" answers permissionDenied. Files are .vtt on img1.*. */

  async _subtitlePool(movieId, ep) {
    const raw = await this._raw(movieId);
    const rawEp = ((raw && raw.episodes) || [])
      .find(e => String(e.id) === String(ep.id)) || ((raw && raw.episodes) || [])[0];
    let subs = (rawEp && rawEp.subtitles) || [];
    let source = 'details';
    if (!subs.length) {
      const langId = ((ep.tracks || [])[0] || {}).languageId;
      for (const res of [2, 1]) {
        try {
          const data = await this.getVideo(movieId, ep.id, langId, res);
          if (data && !data.permissionDenied && Array.isArray(data.subtitles) && data.subtitles.length) {
            subs = data.subtitles;
            source = `getVideo2:${res}`;
            break;
          }
        } catch { /* try the next resolution code */ }
      }
    }
    return { subs, source };
  }

  async listCaptions({ id, season = 0, episode = 0 } = {}) {
    const detail = await this.detail(String(id));
    const s = detail.seasons.find(x => x.season === Number(season)) || detail.seasons[0];
    if (!s) throw new Error('CastleTV: no seasons in detail');
    let eps = s.episodes && s.episodes.length ? s.episodes : await this.seasonEpisodes(s.movieId, s.season);
    const ep = eps.find(e => e.number === Number(episode)) || eps[0];
    if (!ep) throw new Error('CastleTV: no episode for this selection');
    const mid = s.movieId || String(id);
    const { subs, source } = await this._subtitlePool(mid, ep);
    const tracks = [];
    const seen = new Set();
    for (const t of subs) {
      const url = String((t && t.url) || '').trim();
      if (!url) continue;
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      const label = t.title || t.abbreviate || 'Unknown';
      tracks.push({
        lang: label, label, url, source,
        isDefault: !!t.isDefault, isAI: !!t.isAI,
        languageId: t.languageId, abbreviate: t.abbreviate || '',
      });
    }
    return {
      id: String(id), episode: ep.number, episodeId: ep.id,
      tracks, originalLanguage: ((ep.tracks || [])[0] || {}).languageName || null,
    };
  }

  /* Download one subtitle file and convert to the requested format. */
  async fetchCaptions({ id, season = 0, episode = 0, lang, out, format = 'srt' } = {}) {
    const { tracks } = await this.listCaptions({ id, season, episode });
    if (!tracks.length) throw new Error('CastleTV: no subtitle tracks for this title');
    const needle = String(lang || '').trim().toLowerCase();
    const pick = (needle
      && (tracks.find(t => String(t.lang || '').toLowerCase() === needle)
        || tracks.find(t => String(t.label || '').toLowerCase() === needle)
        || tracks.find(t => String(t.lang || '').toLowerCase().includes(needle))))
      || tracks.find(t => t.isDefault) || tracks[0];
    const r = await request(pick.url, { headers: HEADERS, timeout: 60000, retries: 1 });
    if (!r.ok) throw new Error(`CastleTV: subtitle download HTTP ${r.status}`);
    const text = r.text || '';
    const fmt = String(format || 'srt').toLowerCase() === 'vtt' ? 'vtt' : 'srt';
    const base = String(out || path.join(__dirname, '..', '..', '..', 'data', 'cache', 'subtitles'))
      .replace(/\.(srt|vtt)$/i, '');
    ensureDir(path.dirname(base));
    const file = `${base}.${fmt}`;
    fs.writeFileSync(file, convertSubtitle(text, fmt), 'utf8');
    return { file, lang: pick.lang, label: pick.label, source: pick.source, format: fmt };
  }

  /* Verify a stream actually plays; returns the first working URL. */
  async pickStream(args) {
    const candidates = await this.streams(args);
    for (const c of candidates) {
      try {
        const r = await request(c.url, { headers: c.headers, timeout: 20000, retries: 0 });
        if (r.status === 200 && r.buffer.length > 100) return c;
      } catch { /* try next */ }
    }
    return candidates[0] || null;
  }
}

module.exports = { CastleProvider, decrypt, deriveKey };
