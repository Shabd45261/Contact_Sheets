'use strict';
/* VegaMovies provider — sitemap search, post parsing, nexdrive -> fastdl -> G-Drive mp4.
   Ported from csx/VegaMoviesProvider + verified against the live site. */
const fs = require('fs');
const path = require('path');
const {
  request, UA_DESKTOP, decodeEntities, stripTags, absolute, titleFromSlug,
  sanitizeName, ensureDir, sleep,
} = require('../util');

const HOSTS = ['https://vegamovies.lease', 'https://new1.vegamovies.lease'];
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'vegamovies-posts.json');
const CACHE_TTL = 12 * 60 * 60 * 1000;
const HDRS = { referer: HOSTS[0] + '/', 'accept-language': 'en-US,en;q=0.9' };

let memIndex = null;

function cleanHost(host) {
  return String(host || HOSTS[0]).replace(/\/+$/, '');
}

async function fetchOk(url, opts = {}) {
  const r = await request(url, { ...opts, headers: { ...HDRS, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`VegaMovies HTTP ${r.status} for ${url}`);
  return r;
}

async function loadIndex(host, { force = false } = {}) {
  if (!force && memIndex && Date.now() - memIndex.at < CACHE_TTL) return memIndex;
  if (!force) {
    try {
      const disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (disk && disk.at && Date.now() - disk.at < CACHE_TTL && Array.isArray(disk.posts) && disk.posts.length) {
        memIndex = disk;
        return disk;
      }
    } catch { /* no cache */ }
  }
  const base = cleanHost(host);
  const idx = await fetchOk(`${base}/sitemap_index.xml`);
  const maps = [...idx.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map(m => m[1]).filter(u => /post-sitemap\d*\.xml$/i.test(u));
  const urls = new Set();
  let done = 0;
  for (const map of maps) {
    try {
      const r = await fetchOk(map);
      for (const m of r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        // The site now emits post URLs with a trailing slash; normalise it away.
        const u = decodeEntities(m[1]).trim().replace(/\/+$/, '');
        if (u && /^https?:\/\//i.test(u) && !/^https?:\/\/[^/]+$/i.test(u)) urls.add(u);
      }
    } catch { /* skip broken sitemap */ }
    done++;
    if (done % 5 === 0) await sleep(150);
  }
  const posts = [...urls].map(u => {
    const slug = decodeURIComponent(u.split('/').pop() || '');
    return { url: u, slug, title: titleFromSlug(slug) };
  });
  if (!posts.length) throw new Error('VegaMovies: sitemap index yielded no posts (site changed or blocked)');
  memIndex = { at: Date.now(), host: base, posts };
  try {
    ensureDir(CACHE_DIR);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(memIndex));
  } catch { /* cache is best-effort */ }
  return memIndex;
}

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

class VegaMoviesProvider {
  constructor(meta = {}) {
    this.id = meta.id || 'vegamovies';
    this.name = meta.name || 'VegaMovies';
    this.repo = meta.repo || 'csx';
    this.plugin = meta.plugin || 'VegaMovies';
    this.pluginUrl = meta.pluginUrl || '';
    this.host = meta.host || HOSTS[0];
    this.language = meta.language || 'hi';
    this._detailCache = new Map();
  }

  async indexStatus() {
    const idx = await loadIndex(this.host);
    return { count: idx.posts.length, at: idx.at, host: idx.host };
  }

  async search(query) {
    const idx = await loadIndex(this.host);
    const want = tokens(query);
    const scored = [];
    for (const p of idx.posts) {
      const hay = p.slug.toLowerCase();
      let score = 0;
      let hit = 0;
      for (const t of want) {
        if (hay.includes(t)) { hit++; score += t.length; }
      }
      if (!hit) continue;
      if (hit === want.length) score += 30;
      // whole-phrase bonus
      if (hay.includes(want.join('-'))) score += 25;
      // newer slugs tend to contain years
      const y = (p.slug.match(/(19|20)\d{2}/) || [])[0];
      if (y) score += 2;
      scored.push({ p, score, y });
    }
    scored.sort((a, b) => b.score - a.score || b.p.slug.length - a.p.slug.length);
    return {
      items: scored.slice(0, 40).map(({ p, y }) => ({
        id: p.url,
        title: p.title,
        year: y || '',
        poster: '',
        type: /season|series|episode|s\d{2}/i.test(p.slug) ? 'series' : 'movie',
        subtitle: p.slug.replace(/^download-/, '').replace(/-(480p|720p|1080p|2160p).*$/i, ''),
        description: '',
        extra: { slug: p.slug },
      })),
      total: idx.posts.length,
      source: 'sitemap',
    };
  }

  async detail(urlOrId) {
    const url = /^https?:/i.test(urlOrId) ? urlOrId : absolute(this.host, urlOrId);
    if (this._detailCache.has(url)) return this._detailCache.get(url);
    const r = await fetchOk(url);
    const h = r.text;
    const title = this._title(h, url);
    const plain = stripTags(h);
    const type = (/Series Name\s*:/i.test(plain)
      || /\bSeason\s*:\s*\d/i.test(plain)
      || /\bEpisode\s*:\s*\d/i.test(plain)
      || /Complete Season|All Episodes/i.test(plain)
      || /(^|[-_/])season-\d+/i.test(decodeURIComponent(url))
      || /-series[-_/]|series-season/i.test(decodeURIComponent(url))) ? 'series' : 'movie';
    const groups = this._groups(h, url);
    const episodes = await this._episodes(groups);
    const doc = {
      id: url,
      title,
      year: (this._meta(h, 'og:title') || '').match(/(19|20)\d{2}/)?.[0] || (decodeURIComponent(url).match(/(19|20)\d{2}/)?.[0] || ''),
      poster: this._meta(h, 'og:image') || this._firstImage(h),
      backdrop: this._meta(h, 'og:image') || '',
      plot: this._meta(h, 'og:description') || this._meta(h, 'description') || '',
      type,
      qualities: groups.map(g => g.quality).filter(Boolean),
      groups,
      seasons: type === 'series' ? [{
        season: 1,
        name: 'Season 1',
        episodes: episodes.length ? episodes : [{ number: 1, title: 'Episode 1', season: 1 }],
      }] : [{ season: 0, name: 'Movie', episodes: [{ number: 0, title: 'Movie', season: 0 }] }],
      source: url,
      extra: { host: this.host },
    };
    this._detailCache.set(url, doc);
    return doc;
  }

  _meta(h, prop) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'),
    ];
    for (const re of patterns) {
      const m = h.match(re);
      if (m) return decodeEntities(m[1]).trim();
    }
    return '';
  }

  _title(h, url) {
    const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    let t = h1 ? stripTags(h1[1]) : '';
    if (!t) t = this._meta(h, 'og:title') || '';
    if (!t) t = titleFromSlug(decodeURIComponent(url).split('/').filter(Boolean).pop() || '');
    t = t.replace(/^download\s+/i, '').replace(/\s*[~|]\s*(VegaMovies?|Vega Movies).*$/i, '').trim();
    // Prefer "Name (Year)" at the start of the post title.
    const y = t.match(/^(.+?)\s*\(((?:19|20)\d{2})\)/);
    if (y) return sanitizeName(`${y[1].trim()} (${y[2]})`, 120);
    // Otherwise cut the promotional tail after a quality/format marker.
    const cut = t.search(/\s+(480p|720p|1080p|2160p|4K|WEB-DL|WEBRip|BluRay|HDRip|HDTS)\b/i);
    if (cut > 0) t = t.slice(0, cut);
    return sanitizeName(t, 120);
  }

  _firstImage(h) {
    const m = h.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/i);
    return m ? decodeEntities(m[1]) : '';
  }

  /* Walk the post body in document order: quality heading -> nexdrive links. */
  _groups(h, base) {
    const groups = [];
    const re = /<h([1-6])[^>]*>([\s\S]{0,400}?)<\/h\1>|<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
    let cur = null;
    for (const m of h.matchAll(re)) {
      if (m[1]) {
        const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
        const all = [...text.matchAll(/\b(2160|1080|720|480|360)p\b/gi)].map(x => parseInt(x[1], 10));
        const uniq = [...new Set(all)];
        if (uniq.length === 1 && !/^download\b/i.test(text)) {
          cur = { quality: uniq[0], heading: text, servers: [] };
          groups.push(cur);
        } else if (uniq.length > 1) {
          // Page title listing several qualities — not a section header.
          cur = null;
        }
        continue;
      }
      const href = decodeEntities(m[3] || '');
      const label = stripTags(m[4] || '').replace(/\s+/g, ' ').trim();
      if (!/nexdrive\.|fastdl\.|vcloud\.|vegadrive\.|filebee\.|filepress\.|hubcloud\./i.test(href)) continue;
      if (!cur) { cur = { quality: 0, heading: 'Download', servers: [] }; groups.push(cur); }
      if (/zip|pack|complete/i.test(label)) cur.pack = true;
      cur.servers.push({ label, url: absolute(base, href) });
    }
    // de-dupe servers per group
    for (const g of groups) {
      const seen = new Set();
      g.servers = g.servers.filter(s => (seen.has(s.url) ? false : (seen.add(s.url), true)));
    }
    return groups.filter(g => g.servers.length);
  }

  /* Open each nexdrive page and read its episode list (labels like "-:Episode: 3:-"). */
  async _episodes(groups) {
    const byNum = new Map();
    const seenPages = new Set();
    for (const g of groups) {
      for (const srv of g.servers) {
        if (!/nexdrive\./i.test(srv.url) || seenPages.has(srv.url)) continue;
        seenPages.add(srv.url);
        let page;
        try { page = (await fetchOk(srv.url)).text; } catch { continue; }
        const label = this._pageTitle(page) || srv.label;
        const blocks = this._episodeBlocks(page);
        for (const b of blocks) {
          const num = b.episode || 0;
          const key = num;
          const prev = byNum.get(key) || { number: num, season: b.season || 1, title: b.title || (num ? `Episode ${num}` : label), servers: [] };
          for (const link of b.links) {
            if (!prev.servers.some(x => x.url === link.url)) prev.servers.push({ ...link, quality: g.quality, group: g.heading });
          }
          byNum.set(key, prev);
        }
      }
    }
    const out = [...byNum.values()].sort((a, b) => (a.season - b.season) || (a.number - b.number));
    for (const e of out) e.servers = e.servers.filter(s => /fastdl\./i.test(s.url));
    return out.filter(e => e.servers.length);
  }

  _pageTitle(h) {
    const m = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? stripTags(m[1]).replace(/\s*[-|]\s*Nexdrive.*$/i, '').trim() : '';
  }

  _episodeBlocks(h) {
    const marker = /-:\s*Episode\s*:?\s*(\d+)\s*:-/gi;
    const found = [...h.matchAll(marker)];
    const linksOf = seg => {
      const links = [];
      for (const m of seg.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = decodeEntities(m[1]);
        const label = stripTags(m[2]).replace(/\s+/g, ' ').trim();
        if (/fastdl\.|vcloud\.|vegadrive\.|filebee\.|filepress\.|hubcloud\./i.test(url)) links.push({ label, url });
      }
      return links;
    };
    if (!found.length) {
      const links = linksOf(h).filter(l => /fastdl\./i.test(l.url));
      return links.length ? [{ episode: 0, season: 0, title: 'Complete', links }] : [];
    }
    const out = [];
    for (let i = 0; i < found.length; i++) {
      const start = found[i].index;
      const end = i + 1 < found.length ? found[i + 1].index : h.length;
      const seg = h.slice(start, end);
      const links = linksOf(seg);
      if (links.length) out.push({ episode: parseInt(found[i][1], 10), season: 0, title: `Episode ${found[i][1]}`, links });
    }
    return out;
  }

  /* fastdl embed -> dl.php?link=<googleusercontent> -> direct mp4 */
  async resolveFastdl(embedUrl) {
    const e = await fetchOk(embedUrl);
    const m = e.text.match(/var\s+reurl\s*=\s*["']([^"']+)["']/i);
    let next = m ? decodeEntities(m[1]) : '';
    if (!next) {
      const direct = e.text.match(/https:\/\/video-downloads\.googleusercontent\.com\/[^"'<\s]+/i);
      if (direct) return { url: direct[0], format: 'mp4', referer: embedUrl };
      throw new Error('VegaMovies: fastdl redirect not found');
    }
    const dl = await fetchOk(next, { headers: { referer: embedUrl } });
    const direct = dl.text.match(/href="(https:\/\/video-downloads\.googleusercontent\.com\/[^"]+)"/i)
      || dl.text.match(/(https:\/\/video-downloads\.googleusercontent\.com\/[^"'<\s]+)/i);
    if (!direct) throw new Error('VegaMovies: googleusercontent link not found');
    return { url: decodeEntities(direct[1]), format: 'mp4', referer: next };
  }

  _pickQuality(groups, want) {
    const sorted = groups.slice().sort((a, b) => (b.quality || 0) - (a.quality || 0));
    if (want) {
      const hit = sorted.find(g => g.quality === Number(want));
      if (hit) return hit;
    }
    return sorted.find(g => g.quality === 1080) || sorted.find(g => g.quality === 720)
      || sorted.find(g => g.quality === 480) || sorted[0];
  }

  async streams({ id, episode = 0, episodeId, quality } = {}) {
    const doc = await this.detail(id);
    const group = this._pickQuality(doc.groups, quality);
    if (!group) throw new Error('VegaMovies: no download groups on this page');
    const epNum = episodeId != null ? Number(episodeId) : Number(episode || 0);
    let ep = null;
    if (doc.type === 'series') {
      const eps = doc.seasons[0].episodes;
      ep = eps.find(e => e.number === epNum) || eps[0];
      if (!ep) throw new Error('VegaMovies: episode not found');
    }
    const servers = ep ? ep.servers : group.servers;
    const ordered = servers.slice().sort((a, b) => (/fastdl/i.test(b.url) ? 1 : 0) - (/fastdl/i.test(a.url) ? 1 : 0));
    const out = [];
    for (const srv of ordered) {
      if (!/fastdl\./i.test(srv.url)) continue;
      try {
        const r = await this.resolveFastdl(srv.url);
        out.push({
          url: r.url, quality: srv.quality || group.quality || 0, format: 'mp4',
          label: srv.label || `G-Direct ${srv.quality || ''}p`,
          headers: { 'user-agent': UA_DESKTOP, referer: r.referer || srv.url },
          size: srv.size || '', server: 'G-Direct',
        });
      } catch (e) { /* next server */ }
      if (out.length) break;
    }
    if (!out.length) throw new Error('VegaMovies: no playable G-Direct link');
    return out;
  }

  async pickStream(args) {
    const list = await this.streams(args);
    return list[0] || null;
  }
}

module.exports = { VegaMoviesProvider, loadIndex, HOSTS };
