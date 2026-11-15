'use strict';
/* 4KHDHub provider — search + detail scrape, JS mediator -> hubcloud -> direct CDN link.
   Ported from phisher/FourKHDHub and verified against the live site. */
const {
  request, UA_DESKTOP, decodeEntities, stripTags, absolute, titleFromSlug,
  sanitizeName, sleep,
} = require('../util');
const { getBrowser } = require('../browser');

const HOSTS = ['https://4khdhub.dad', 'https://4khdhub.one'];
const HDRS = { referer: 'https://4khdhub.dad/' };

function cleanHost(host) { return String(host || HOSTS[0]).replace(/\/+$/, ''); }

async function fetchOk(url, opts = {}) {
  const r = await request(url, { ...opts, headers: { ...HDRS, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`4KHDHub HTTP ${r.status} for ${url}`);
  return r;
}

function blocks(html, startRe) {
  const starts = [...html.matchAll(startRe)].map(m => m.index);
  return starts.map((s, i) => html.slice(s, i + 1 < starts.length ? starts[i + 1] : html.length));
}

function anchors(seg) {
  const out = [];
  for (const m of seg.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decodeEntities(m[1]);
    const label = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (/greenmotors\.|hubcloud\.|hubdrive\.|gofile\.|pixeldrain\.|gamerxyt\./.test(url) || /download/i.test(label)) {
      out.push({ label, url });
    }
  }
  return out;
}

class FourKHDHubProvider {
  constructor(meta = {}) {
    this.id = meta.id || 'fourkhdhub';
    this.name = meta.name || '4KHDHub';
    this.repo = meta.repo || 'phisher';
    this.plugin = meta.plugin || 'FourKHDHub';
    this.pluginUrl = meta.pluginUrl || '';
    this.host = cleanHost(meta.host);
    this.language = meta.language || 'en';
    this._cache = new Map();
    this._detailCache = new Map();
  }

  async search(query) {
    const url = `${this.host}/?s=${encodeURIComponent(query)}`;
    const r = await fetchOk(url);
    const cards = [...r.text.matchAll(/<a href="([^"]+)" class="movie-card"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const items = cards.map(c => {
      const formats = [...c[3].matchAll(/<span class="movie-card-format">([^<]+)<\/span>/g)].map(x => decodeEntities(x[1]));
      const posterM = c[3].match(/<img[^>]+src="([^"]+)"/i);
      const year = (c[2].match(/\((19|20)\d{2}\)/) || [])[0] || (formats.join(' ').match(/(19|20)\d{2}/) || [])[0] || '';
      return {
        id: absolute(this.host, c[1]),
        title: sanitizeName(decodeEntities(c[2]).replace(/\s*details$/i, ''), 120),
        year: year.replace(/[()]/g, ''),
        poster: posterM ? absolute(this.host, decodeEntities(posterM[1])) : '',
        type: /series/i.test(formats.join(' ')) || /series/.test(c[1]) ? 'series' : 'movie',
        subtitle: formats.filter(f => !/^(series|movies)$/i.test(f)).slice(0, 4).join(' · '),
        description: '',
        extra: { formats },
      };
    });
    return { items, total: items.length, source: url };
  }

  async detail(idOrUrl) {
    const url = /^https?:/i.test(idOrUrl) ? idOrUrl : absolute(this.host, idOrUrl);
    if (this._detailCache.has(url)) return this._detailCache.get(url);
    const r = await fetchOk(url);
    const h = r.text;
    const titleRaw = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const title = sanitizeName(stripTags(titleRaw).replace(/\s*[-|]\s*4K-?HDHub.*$/i, '').replace(/\s*\((\d{4})\).*$/, ''), 120)
      || titleFromSlug(decodeURIComponent(url).split('/').filter(Boolean).pop() || '');
    const year = (stripTags(titleRaw).match(/(19|20)\d{2}/) || [])[0] || '';
    const poster = (h.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || '';
    const plot = (h.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) || [])[1] || '';
    const isSeries = /season-item episode-item|episodes-list/i.test(h);
    const groups = isSeries ? this._seriesGroups(h, url) : this._movieGroups(h, url);
    const doc = {
      id: url, title, year, poster: poster ? absolute(this.host, decodeEntities(poster)) : '',
      backdrop: poster ? absolute(this.host, decodeEntities(poster)) : '', plot: decodeEntities(plot),
      type: isSeries ? 'series' : 'movie',
      qualities: [...new Set(groups.map(g => g.quality).filter(Boolean))].sort((a, b) => b - a),
      groups,
      seasons: [],
      source: url,
      extra: { host: this.host },
    };
    if (isSeries) {
      const bySeason = new Map();
      for (const g of groups) for (const it of g.items) {
        const s = it.season || 1;
        if (!bySeason.has(s)) bySeason.set(s, new Map());
        const m = bySeason.get(s);
        if (!m.has(it.episode)) m.set(it.episode, { number: it.episode, season: s, title: `Episode ${it.episode}`, qualities: [] });
        const ep = m.get(it.episode);
        if (!ep.qualities.includes(g.quality)) ep.qualities.push(g.quality);
      }
      doc.seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([season, m]) => ({
        season,
        name: `Season ${season}`,
        episodes: [...m.values()].sort((a, b) => a.number - b.number),
      }));
      if (!doc.seasons.length) doc.seasons = [{ season: 1, name: 'Season 1', episodes: [{ number: 1, season: 1, title: 'Episode 1' }] }];
    } else {
      doc.seasons = [{ season: 0, name: 'Movie', episodes: [{ number: 0, season: 0, title: 'Movie' }] }];
    }
    this._detailCache.set(url, doc);
    return doc;
  }

  _qualityOf(text) {
    const m = String(text || '').match(/\b(2160|1080|720|480|360)p\b/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  _movieGroups(h, base) {
    const groups = [];
    for (const seg of blocks(h, /<div class="download-item[^"]*">/g)) {
      const header = (seg.match(/<div class="download-header[\s\S]*?<\/div>\s*<svg/i) || [])[0] || '';
      const headerText = stripTags(header).replace(/\s+/g, ' ').trim();
      const fileTitle = stripTags((seg.match(/<div class="file-title[^"]*">([\s\S]*?)<\/div>/i) || [])[1] || '').trim();
      const q = this._qualityOf(headerText) || this._qualityOf(fileTitle);
      const links = anchors(seg).filter(l => l.url && !/^#/.test(l.url));
      if (!links.length) continue;
      const size = (headerText.match(/([\d.]+\s*(?:GB|MB|TB))/i) || [])[1] || '';
      groups.push({
        quality: q, label: headerText, items: [{
          episode: 0, season: 0, filename: fileTitle || headerText, size, links,
        }],
      });
    }
    return groups;
  }

  _seriesGroups(h, base) {
    const groups = [];
    for (const seg of blocks(h, /<div class="season-item episode-item[^"]*">/g)) {
      const label = stripTags((seg.match(/<h3 class="episode-title"[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
      const q = this._qualityOf(label);
      const items = [];
      for (const itemSeg of blocks(seg, /<div class="episode-download-item">/g).slice(0)) {
        if (!/episode-file-title/i.test(itemSeg)) continue;
        const filename = stripTags((itemSeg.match(/<div class="episode-file-title"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
        const info = stripTags((itemSeg.match(/<div class="episode-file-info"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
        const size = (info.match(/([\d.]+\s*(?:GB|MB|TB))/i) || [])[1] || '';
        const links = anchors(itemSeg).filter(l => l.url && !/^#/.test(l.url));
        if (!links.length) continue;
        const sm = filename.match(/S(\d{1,2})E(\d{1,3})/i) || filename.match(/(?:Season[ .-]*)(\d{1,2}).*?Episode[ .-]*(\d{1,3})/i);
        const em = info.match(/Episode[-\s]*(\d{1,3})/i);
        const season = sm ? parseInt(sm[1], 10) : 1;
        const episode = sm ? parseInt(sm[2], 10) : (em ? parseInt(em[1], 10) : items.length + 1);
        items.push({ episode, season, filename, size, links });
      }
      if (items.length) groups.push({ quality: q, label, items });
    }
    return groups;
  }

  _pickGroup(doc, wantedQuality) {
    const qs = [...new Set(doc.groups.map(g => g.quality))].sort((a, b) => b - a);
    const q = wantedQuality && qs.includes(Number(wantedQuality)) ? Number(wantedQuality)
      : (qs.includes(1080) ? 1080 : qs.includes(2160) ? 2160 : qs[0]);
    return doc.groups.find(g => g.quality === q) || doc.groups[0];
  }

  async _hubcloudDrive(mediatorUrl) {
    const cached = this._cache.get(mediatorUrl);
    if (cached && Date.now() - cached.at < 15 * 60 * 1000) return cached;
    const found = await getBrowser().mediator(mediatorUrl, { waitLink: /hubcloud\.(pw|cx|fans)\/drive\//i });
    const drive = found && found.url;
    if (!drive) throw new Error('4KHDHub: mediator did not reveal a HubCloud link');
    const rec = { at: Date.now(), drive };
    this._cache.set(mediatorUrl, rec);
    return rec;
  }

  async _driveLinks(driveUrl, mediatorUrl) {
    const page = await fetchOk(driveUrl, { headers: { referer: mediatorUrl } });
    const out = [];
    for (const m of page.text.matchAll(/href="([^"]*gamerxyt\.com\/hubcloud\.php[^"]*)"/gi)) {
      out.push(decodeEntities(m[1]));
    }
    if (!out.length) {
      const m = page.text.match(/https?:\/\/gamerxyt\.com\/hubcloud\.php[^"'<\s]+/i);
      if (m) out.push(decodeEntities(m[0]));
    }
    return [...new Set(out)];
  }

  async _finalLinks(phpUrl, referer) {
    const page = await fetchOk(phpUrl, { headers: { referer } });
    const urls = new Set();
    for (const m of page.text.matchAll(/(https?:\/\/[^"'<>\s]+)/g)) {
      const u = decodeEntities(m[1]).replace(/&amp;/g, '&');
      if (/r2\.cloudflarestorage\.com|pixeldrain\.(dev|com)\/(u|api\/file)\//i.test(u)) urls.add(u);
    }
    const list = [...urls];
    const r2 = list.filter(u => /r2\.cloudflarestorage\.com/i.test(u));
    const px = list.filter(u => /pixeldrain\./i.test(u)).map(u => {
      const m = u.match(/pixeldrain\.(?:dev|com)\/u\/([A-Za-z0-9]+)/);
      return m ? `https://pixeldrain.dev/api/file/${m[1]}?download` : u;
    });
    return [...r2, ...px];
  }

  async resolveItem(item, quality, mediatorRef) {
    const preferred = item.links.slice().sort((a, b) => (/hubcloud/i.test(b.label) ? 1 : 0) - (/hubcloud/i.test(a.label) ? 1 : 0));
    const errors = [];
    for (const link of preferred) {
      const url = link.url;
      try {
        if (/greenmotors\./i.test(url)) {
          const rec = await this._hubcloudDrive(url);
          const phps = await this._driveLinks(rec.drive, url);
          for (const php of phps) {
            const finals = await this._finalLinks(php, rec.drive);
            if (finals.length) {
              return finals.map(u => ({
                url: u, quality, format: /\.(mp4|m3u8)(\?|$)/i.test(u) ? (/(m3u8)/i.test(u) ? 'hls' : 'mp4') : 'file',
                server: 'HubCloud', filename: item.filename, size: item.size,
                headers: { 'user-agent': UA_DESKTOP, referer: rec.drive },
              }));
            }
          }
        } else if (/gamerxyt\.com\/hubcloud\.php/i.test(url)) {
          const finals = await this._finalLinks(url, mediatorRef || this.host + '/');
          if (finals.length) return finals.map(u => ({ url: u, quality, format: 'file', server: 'HubCloud', filename: item.filename, size: item.size }));
        }
      } catch (e) { errors.push(e.message); }
    }
    throw new Error('4KHDHub: could not resolve a direct link' + (errors.length ? ` (${errors[0]})` : ''));
  }

  async streams({ id, season = 1, episode = 0, quality } = {}) {
    const doc = await this.detail(id);
    const group = this._pickGroup(doc, quality);
    if (!group) throw new Error('4KHDHub: no download groups');
    let item;
    if (doc.type === 'series') {
      const s = doc.seasons.find(x => x.season === Number(season)) || doc.seasons[0];
      const epNum = Number(episode || 1);
      item = group.items.find(x => (x.season === s.season && x.episode === epNum))
        || group.items.find(x => x.episode === epNum) || group.items[0];
    } else {
      item = group.items[0];
    }
    if (!item) throw new Error('4KHDHub: no item for that episode/quality');
    return this.resolveItem(item, group.quality || 0);
  }

  async pickStream(args) {
    const list = await this.streams(args);
    return list[0] || null;
  }
}

module.exports = { FourKHDHubProvider, HOSTS };

if (require.main === module) {
  (async () => {
    const p = new FourKHDHubProvider();
    const s = await p.search('leopard');
    console.log('search', s.items.length, s.items.slice(0, 3));
    if (s.items[0]) {
      const d = await p.detail(s.items[0].id);
      console.log('detail', d.title, d.type, d.seasons.map(x => `${x.name}:${x.episodes.length}`).join(' '));
      console.log('groups', d.groups.map(g => g.quality + 'p:' + g.items.length).join(' '));
      if (d.groups[0]) {
        const st = await p.streams({ id: s.items[0].id, season: 1, episode: 1, quality: d.groups[0].quality });
        console.log('streams', st.map(x => x.url.slice(0, 120)));
      }
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
