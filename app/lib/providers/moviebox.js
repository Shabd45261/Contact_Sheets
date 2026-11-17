'use strict';
/* MovieBox (aoneroom) API client — ported from the cloudstream MovieBoxProvider plugin.
   Handles visitor login, signed requests, search, details, seasons, play info. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../util');
const { convertSubtitle } = require('../subtitles');

const HOSTS = [
  'https://apig.inmoviebox.com', 'https://apii.inmoviebox.com',
  'https://api7.aoneroom.com', 'https://api6.aoneroom.com', 'https://api5.aoneroom.com',
  'https://api4.aoneroom.com', 'https://api4sg.aoneroom.com', 'https://api3.aoneroom.com',
];
const CLIENT_BUILDS = [
  '1790144723381916466.632cf3fe507b339bc757f117f85b4c4a',
  '1793366173719104383.d7a1fb415ac995ca890664b0f01e4099-1793366048368718383.dbf44f9f0efa9b445e4f194092a71f01',
];
// base64 text which itself is base64 of the real key
const SECRET_DEF = Buffer.from(Buffer.from('NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==', 'base64').toString(), 'base64');
/* App identity the API checks. Builds it considers outdated are answered with a ~20 s
   "this version is discontinued, please update" video instead of the real file, so keep
   these in step with the current MovieBox release (com.community.oneroom 4.0.03.1028.03,
   29 Oct 2026). VERSION_CODE is an estimate - override without editing code via the
   MB_VERSION_NAME / MB_VERSION_CODE environment variables (see scripts/probe_mb_update.js). */
const VERSION_NAME = process.env.MB_VERSION_NAME || '4.0.03.1028.03';
const VERSION_CODE = Number(process.env.MB_VERSION_CODE) || 50020135;
/* Anything this short is the update notice, not a film or episode. */
const NOTICE_MAX_SECONDS = 45;
const isNoticeClip = x => { const d = Number(x && x.duration) || 0; return d > 0 && d < NOTICE_MAX_SECONDS; };
const CLIENT_INFO_BASE = {
  package_name: 'com.community.oneroom', version_name: VERSION_NAME, version_code: VERSION_CODE,
  os: 'android', os_version: '14', install_store: 'official',
  gaid: '1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d', brand: 'Google', model: 'Pixel 8',
  system_language: 'en', net: 'NETWORK_WIFI', region: 'IN', timezone: 'Asia/Calcutta', sp_code: '',
};
const UA = `com.community.oneroom/${VERSION_CODE} (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)`;
const md5 = b => crypto.createHash('md5').update(b).digest('hex');

class MovieBox {
  constructor(opts = {}) {
    this.host = opts.host || HOSTS[0];
    this.token = null;
    this.tokenExp = 0;
    this.deviceId = crypto.randomBytes(16).toString('hex');
    this.clientInfo = JSON.stringify({ ...CLIENT_INFO_BASE, device_id: this.deviceId });
  }

  _headers(method, url, body, ct, accept) {
    const ts = Date.now();
    const u = new URL(url);
    const q = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`).join('&');
    const canonicalUrl = u.pathname + (q ? '?' + q : '');
    const bb = body != null ? Buffer.from(body, 'utf8') : null;
    const canonical = [method.toUpperCase(), accept || '', ct || '', bb ? String(bb.length) : '',
      ts, bb ? md5(bb.subarray(0, 102400)) : '', canonicalUrl].join('\n');
    const signature = ts + '|2|' + crypto.createHmac('md5', SECRET_DEF).update(canonical).digest('base64');
    const h = {
      'user-agent': UA, accept, 'content-type': ct, connection: 'keep-alive',
      'x-client-token': ts + ',' + md5(Buffer.from(String(ts).split('').reverse().join(''))),
      'x-tr-signature': signature,
      'x-client-info': this.clientInfo,
      'x-client-status': '0',
      'x-client-build': CLIENT_BUILDS[0],
    };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  }

  async _req(method, path, body, opts = {}) {
    let lastErr;
    for (const host of [this.host, ...HOSTS.filter(h => h !== this.host)]) {
      const url = host + path;
      const ct = opts.ct ?? 'application/json; charset=utf-8';
      const accept = opts.accept ?? 'application/json';
      const headers = this._headers(method, url, body ?? null, ct, accept);
      if (opts.noAuth) delete headers.Authorization;
      try {
        const r = await fetch(url, {
          method, headers, body: body ?? undefined,
          signal: AbortSignal.timeout(opts.timeout || 30000),
        });
        const text = await r.text();
        let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
        if (r.status === 441 && !opts.noAuth && !opts._retried) {
          await this.login(true);
          return this._req(method, path, body, { ...opts, _retried: true });
        }
        if (r.status >= 500) { lastErr = new Error(`HTTP ${r.status} ${text.slice(0, 120)}`); continue; }
        this.host = host;
        return json;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('moviebox: no host reachable');
  }

  async login(force = false) {
    if (!force && this.token && Date.now() < this.tokenExp) return this.token;
    const r = await this._req('POST', '/wefeed-mobile-bff/user-api/visitor-login', '{}',
      { noAuth: true, accept: 'application/json', ct: 'application/json' });
    const tok = r && r.data && r.data.token;
    if (!tok) throw new Error('moviebox login failed: ' + JSON.stringify(r).slice(0, 200));
    this.token = tok;
    try {
      const payload = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
      this.tokenExp = payload.exp ? payload.exp * 1000 - 5 * 60 * 1000 : Date.now() + 3600e3;
    } catch { this.tokenExp = Date.now() + 3600e3; }
    return tok;
  }

  async search(keyword, page = 1) {
    await this.login();
    const body = JSON.stringify({ page, perPage: 20, keyword, restrictKid: 0 });
    const r = await this._req('POST', '/wefeed-mobile-bff/subject-api/search/v2', body);
    const out = [];
    for (const group of (r.data && r.data.results) || []) {
      for (const s of group.subjects || []) out.push(normalizeSubject(s));
    }
    return { items: out, hasMore: !!(r.data && r.data.pager && r.data.pager.hasMore), raw: r };
  }

  async detail(subjectId) {
    await this.login();
    const r = await this._req('GET', `/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`);
    const d = r.data || null;
    return d ? normalizeDetail(d) : null;
  }

  /* Normalised detail: seasons/episodes for series, single Movie entry otherwise. */
  async fullDetail(subjectId) {
    await this.login();
    const d = await this.detail(subjectId);
    if (!d) return null;
    if (d.type !== 'series') {
      d.seasons = [{ season: 0, name: 'Movie', episodes: [{ number: 0, season: 0, title: d.title }] }];
      d.qualities = d.qualities || [];
      return d;
    }
    let si = null;
    try { si = await this.seasonInfo(String(subjectId), 0); } catch {}
    const seasons = ((si && si.seasons) || []).map(s => ({
      season: s.se,
      name: `Season ${s.se}`,
      maxEp: s.maxEp || 0,
      qualities: (s.resolutions || []).map(x => x.resolution).sort((a, b) => b - a),
      episodes: Array.from({ length: s.maxEp || 0 }, (_, i) => ({
        number: i + 1, season: s.se, title: `Episode ${i + 1}`,
      })),
    }));
    if (!seasons.length) {
      seasons.push({ season: d.seNum || 1, name: `Season ${d.seNum || 1}`, episodes: [] });
    }
    d.seasons = seasons;
    d.qualities = [...new Set(seasons.flatMap(s => s.qualities || []))].sort((a, b) => b - a);
    return d;
  }

  async seasonInfo(subjectId, season = 0) {
    await this.login();
    const r = await this._req('GET', `/wefeed-mobile-bff/subject-api/season-info?subjectId=${subjectId}&season=${season}`);
    return r.data || null;
  }

  async playInfo(subjectId) {
    await this.login();
    const r = await this._req('GET', `/wefeed-mobile-bff/subject-api/play-info?subjectId=${subjectId}`);
    return r.data || null;
  }

  async resource(subjectId, resourceId = '', season = 0, episode = 0) {
    await this.login();
    let p = `/wefeed-mobile-bff/subject-api/resource?subjectId=${subjectId}`;
    if (resourceId) p += `&resourceId=${encodeURIComponent(resourceId)}`;
    if (season) p += `&season=${season}`;
    if (episode) p += `&episode=${episode}`;
    const r = await this._req('GET', p);
    return r.data || null;
  }

  /* Every resource page for a subject (series episodes are paged, 10 per page). */
  async allResources(subjectId) {
    await this.login();
    const list = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this._req('GET', `/wefeed-mobile-bff/subject-api/resource?subjectId=${subjectId}&page=${page}`);
      const d = r.data || {};
      list.push(...(d.list || []));
      if (!d.pager || !d.pager.hasMore) break;
    }
    return list;
  }

  /* Playable candidates for a movie or one episode of a series. */
  async streams({ id, season = 1, episode = 0, quality } = {}) {
    await this.login();
    const detail = await this.fullDetail(String(id));
    const isSeries = detail && detail.type === 'series';
    let items = [];
    if (isSeries) {
      const all = await this.allResources(String(id));
      const se = Number(season || 1);
      const ep = Number(episode || 1);
      items = all.filter(x => Number(x.se) === se && Number(x.ep) === ep);
      if (!items.length) items = all.filter(x => Number(x.ep) === ep);
      if (!items.length) items = all.slice(0, 1);
    } else {
      const r = await this.resource(String(id));
      items = (r && r.list) || [];
    }
    const q = quality ? Number(quality) : 0;
    let pool = items.filter(x => x.resourceLink);
    if (q) {
      const exact = pool.filter(x => Number(x.resolution) === q);
      if (exact.length) pool = exact;
    }
    pool.sort((a, b) => (Number(b.resolution) || 0) - (Number(a.resolution) || 0));
    const notices = pool.filter(isNoticeClip);
    pool = pool.filter(x => !isNoticeClip(x));
    const expected = !isSeries ? Number(detail && detail.durationSeconds) || 0 : 0;
    const seen = new Set();
    const out = [];
    for (const x of pool) {
      if (!x.resourceLink || seen.has(x.resourceLink)) continue;
      seen.add(x.resourceLink);
      out.push({
        url: x.resourceLink,
        quality: Number(x.resolution) || 0,
        format: 'mp4',
        server: 'MovieBox CDN',
        size: x.size || '',
        filename: x.title || '',
        duration: Number(x.duration) || 0,
        expected,
        headers: { 'user-agent': UA },
      });
    }
    // Fall back to the DASH manifest from play-info for movies.
    if (!out.length && !isSeries) {
      const pi = await this.playInfo(String(id));
      for (const s of (pi && pi.streams) || []) {
        if (!s.url) continue;
        out.push({
          url: s.url,
          quality: parseInt(s.resolutions, 10) || 0,
          format: /\.mpd$/i.test(s.url) ? 'dash' : 'hls',
          server: 'MovieBox play-info',
          duration: Number(s.duration) || 0,
          expected,
          headers: { 'user-agent': UA, ...(s.signCookie ? { cookie: s.signCookie } : {}) },
        });
      }
    }
    if (!out.length && notices.length) {
      throw new Error(`MovieBox returned only a ${Math.round(notices[0].duration)} s notice clip (the "version discontinued, please update" video). `
        + `The client version (${VERSION_NAME} / ${VERSION_CODE}) is outdated: set MB_VERSION_NAME / MB_VERSION_CODE to the current release.`);
    }
    return out;
  }

  async pickStream(args) { const list = await this.streams(args); return list[0] || null; }

  /* ---------- subtitles (MovieBoxProvider.loadCaptions port) ----------
     Two endpoints, same signed auth headers as the streams:
       GET /wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=..&streamId=..
       GET /wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=..&resourceId=..&episode=0
     Both answer data.extCaptions = [{url, lanName?/language?/lan?}].
     streamId = play-info stream id, resource item id, then "se|ep" fallback. */

  async captionStreamIds(id, season = 0, episode = 0) {
    const ids = [];
    const push = v => { const s = String(v == null ? '' : v); if (s && !ids.includes(s)) ids.push(s); };
    const se = Number(season) || 0, ep = Number(episode) || 0;
    const res = await this.resource(String(id)).catch(() => null);
    const items = (res && res.list) || [];
    // Series: only the resource ids of the requested episode (a season can have
    // hundreds — calling both caption endpoints for each would be slow).
    let candidates = items;
    if (se || ep) candidates = items.filter(x => Number(x.se) === se && Number(x.ep) === ep);
    if (!candidates.length && ep) candidates = items.filter(x => Number(x.ep) === ep);
    for (const x of candidates.slice(0, 12)) push(x.resourceId || x.id);
    try {
      const pi = await this.playInfo(String(id));
      for (const s of (pi && pi.streams) || []) push(s.id);
    } catch { /* play-info is optional */ }
    push(`${se}|${ep}`);
    this._inlineCaptions = candidates.flatMap(x => Array.isArray(x.extCaptions) ? x.extCaptions : []);
    return ids;
  }

  async _captionItems(pathAndQuery) {
    const r = await this._req('GET', pathAndQuery);
    const ext = (r && r.data && r.data.extCaptions);
    return Array.isArray(ext) ? ext : [];
  }

  async listCaptions({ id, season = 0, episode = 0 } = {}) {
    await this.login();
    const tracks = [];
    const seen = new Set();
    const addTrack = (c, endpoint, streamId) => {
      const url = String((c && c.url) || '').trim();
      if (!url) return;
      // signed CDN urls (cacdn) re-sign per request — dedup on the path, not the
      // full url, so the same subtitle file is not listed twice.
      const base = url.split('?')[0];
      if (seen.has(base)) return;
      seen.add(base);
      const raw = String(c.lanName || c.language || c.lan || '').trim();
      const name = tagToEnglish(raw) || tagToEnglish(raw.split('-')[0]) || raw || 'Unknown';
      tracks.push({ lang: name, label: name, url, endpoint, streamId: streamId || '' });
    };
    for (const streamId of await this.captionStreamIds(id, season, episode)) {
      const qs = encodeURIComponent(streamId);
      for (const [endpoint, p] of [
        ['stream-captions', `/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=${id}&streamId=${qs}`],
        ['ext-captions', `/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=${id}&resourceId=${qs}&episode=0`],
      ]) {
        const items = await this._captionItems(p).catch(() => []); // the "se|ep" fallback may 400
        for (const c of items) addTrack(c, endpoint, streamId);
      }
    }
    // resource items can carry extCaptions inline — same objects the endpoints return
    for (const c of this._inlineCaptions || []) addTrack(c, 'inline', '');
    this._inlineCaptions = null;
    return { id: String(id), tracks };
  }

  /* Download one caption track (SRT files on cacdn/pacdn) and convert to the
     requested format. `out` is a base path; the extension is chosen here. */
  async fetchCaptions({ id, season = 0, episode = 0, lang, out, format = 'srt' } = {}) {
    const { tracks } = await this.listCaptions({ id, season, episode });
    if (!tracks.length) throw new Error('MovieBox: no caption tracks for this title');
    const pick = pickSubtitleTrack(tracks, lang);
    const r = await fetch(pick.url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`MovieBox: caption download HTTP ${r.status}`);
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    const fmt = String(format || 'srt').toLowerCase() === 'vtt' ? 'vtt' : 'srt';
    const base = String(out || path.join(ROOT_CACHE(), 'captions')).replace(/\.(srt|vtt)$/i, '');
    ensureDir(path.dirname(base));
    const file = `${base}.${fmt}`;
    fs.writeFileSync(file, convertSubtitle(text, fmt), 'utf8');
    return { file, lang: pick.lang, label: pick.label, source: pick.endpoint, format: fmt };
  }
}

function ROOT_CACHE() { return path.join(__dirname, '..', '..', '..', 'data', 'cache'); }

/* Shared pick: exact lang match, then substring on lang/label, then English,
   then the first track. */
function pickSubtitleTrack(tracks, lang) {
  const needle = String(lang || '').trim().toLowerCase();
  if (needle) {
    const hit = tracks.find(t => String(t.lang || '').toLowerCase() === needle)
      || tracks.find(t => String(t.label || '').toLowerCase() === needle)
      || tracks.find(t => String(t.lang || '').toLowerCase().includes(needle))
      || tracks.find(t => String(t.label || '').toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return tracks.find(t => String(t.lang || '').toLowerCase() === 'english')
    || tracks.find(t => t.isDefault) || tracks[0];
}

/* Compact port of SubtitleHelper.fromTagToEnglishLanguageName — the caption
   language codes the MovieBox API returns ("en", "hi", "ta", …). */
const LANG_TAGS = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati',
  ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  it: 'Italian', tr: 'Turkish', id: 'Indonesian', th: 'Thai', vi: 'Vietnamese',
  ms: 'Malay', fa: 'Persian', pl: 'Polish', nl: 'Dutch', sv: 'Swedish',
};
function tagToEnglish(tag) {
  return LANG_TAGS[String(tag || '').trim().toLowerCase()] || '';
}

function normalizeSubject(s) {
  return {
    id: String(s.subjectId || s.id || ''),
    title: s.title || s.name || '',
    description: s.description || '',
    year: (s.releaseDate || '').slice(0, 4),
    duration: s.duration || '',
    durationSeconds: s.durationSeconds || 0,
    rating: s.imdbRatingValue || '',
    genres: (s.genre || '').split(',').map(x => x.trim()).filter(Boolean),
    country: s.countryName || '',
    language: s.language || '',
    type: s.subjectType === 2 ? 'series' : (s.subjectType === 1 ? 'movie' : 'unknown'),
    poster: (s.cover && s.cover.url) || '',
    still: (s.stills && s.stills.url) || '',
    hasResource: s.hasResource !== false,
  };
}

function normalizeDetail(d) {
  const type = d.subjectType === 2 ? 'series' : 'movie';
  return {
    id: String(d.subjectId || d.id || ''),
    title: d.title || '',
    year: String(d.releaseDate || '').slice(0, 4),
    poster: (d.cover && d.cover.url) || '',
    backdrop: (d.stills && d.stills.url) || '',
    plot: d.description || '',
    rating: d.imdbRatingValue != null ? String(d.imdbRatingValue) : '',
    type,
    tags: String(d.genre || '').split(',').map(x => x.trim()).filter(Boolean),
    languages: String(d.language || '').split(',').map(x => x.trim()).filter(Boolean),
    durationSeconds: d.durationSeconds || 0,
    seNum: d.seNum || 0,
    subjectType: d.subjectType,
    qualities: [],
    seasons: [],
    source: d.subjectId ? `subjectId=${d.subjectId}` : '',
    raw: d,
  };
}

module.exports = { MovieBox, HOSTS, normalizeSubject, normalizeDetail };

if (require.main === module) {
  (async () => {
    const mb = new MovieBox();
    console.log('login', (await mb.login()).slice(0, 30));
    const s = await mb.search('Inception');
    console.log('search', s.items.length, s.items[0]);
    const sid = s.items[0].id;
    const d = await mb.detail(sid);
    console.log('detail keys', Object.keys(d || {}));
    const seasons = d?.seasons || d?.seasonList || [];
    console.log('seasons', JSON.stringify(seasons).slice(0, 800));
    const pi = await mb.playInfo(sid);
    console.log('play-info', JSON.stringify(pi).slice(0, 1500));
    const rs = await mb.resource(sid);
    console.log('resource', JSON.stringify(rs).slice(0, 1500));
    require('fs').writeFileSync('data/intel/mb_detail.json', JSON.stringify(d, null, 1));
    require('fs').writeFileSync('data/intel/mb_playinfo.json', JSON.stringify(pi, null, 1));
    require('fs').writeFileSync('data/intel/mb_resource.json', JSON.stringify(rs, null, 1));
  })().catch(e => { console.error(e); process.exit(1); });
}
