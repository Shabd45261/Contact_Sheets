'use strict';
/* Provider registry: one runtime entry per approved CloudStream plugin.
   Approved target set (see data/targets.json):
     - phisher/MovieBoxProvider
     - cncverse/MovieBoxProvider
     - cncverse/MovieBoxProviderIN
     - cncverse/CastleTvProvider
   Everything else is intentionally out of scope.

   Removed 2026-11-10 after failing stream-resolution tests on every title:
     - phisher/FourKHDHub      -> "mediator did not reveal a HubCloud link"
     - cncverse/VegaMoviesProvider -> 404 / "no playable G-Direct link"
   Their modules are kept in ./fourkhdhub.js and ./vegamovies.js for reference.

   2026-11-11: added ./youtube.js — bridge-native (not a .cs3 plugin), for native
   YouTube content only: music videos, trailers, creator videos, UGC, Shorts.
   Never a film/series rip substitute (AGENTS.md rule 5). */
const path = require('path');
const { MovieBox } = require('./moviebox');
const { CastleProvider } = require('./castle');
const { YouTube } = require('./youtube');

const ROOT = path.join(__dirname, '..', '..', '..');

const ENTRIES = [
  // ---- MovieBox variants -------------------------------------------------
  { id: 'moviebox-phisher', kind: 'moviebox', name: 'MovieBox (Phisher)', short: 'MovieBox', repo: 'phisher', plugin: 'MovieBoxProvider', file: 'MovieBoxProvider.cs3', language: 'hi', region: 'IN', accent: '#f97316' },
  // Removed 2026-11-17: serves a ~23 s notice clip instead of the film on stream
// resolution ("client version outdated"). Kept out of ENTRIES; see AGENTS.md.
// { id: 'moviebox-cncverse', kind: 'moviebox', name: 'MovieBox (CNCVerse)', short: 'MovieBox', repo: 'cncverse', plugin: 'MovieBoxProvider', file: 'MovieBoxProvider.cs3', language: 'hi', region: 'IN', accent: '#f97316' },
  { id: 'moviebox-cncverse-in', kind: 'moviebox', name: 'MovieBox IN (CNCVerse)', short: 'MovieBox IN', repo: 'cncverse', plugin: 'MovieBoxProviderIN', file: 'MovieBoxProviderIN.cs3', language: 'hi', region: 'IN', accent: '#fb923c' },

  // ---- CastleTV ----------------------------------------------------------
  { id: 'castletv-cncverse', kind: 'castle', name: 'CastleTV (CNCVerse)', short: 'CastleTV', repo: 'cncverse', plugin: 'CastleTvProvider', file: 'CastleTvProvider.cs3', language: 'hi', region: 'IN', accent: '#6366f1' },

  // ---- YouTube (bridge-native, not a .cs3 plugin) ------------------------
  { id: 'youtube', kind: 'youtube', name: 'YouTube', short: 'YouTube', repo: 'youtube', plugin: 'YouTubeProvider', file: 'youtube.js', language: 'en', region: 'Global', accent: '#ff0000' },
];

const cache = new Map();

function createEntry(entry) {
  const meta = {
    id: entry.id, name: entry.name, repo: entry.repo,
    plugin: entry.plugin, pluginUrl: entry.file, language: entry.language,
  };
  switch (entry.kind) {
    case 'moviebox': return new MovieBox(meta);
    case 'castle': return new CastleProvider(meta);
    case 'youtube': return new YouTube(meta);
    case 'fourkhdhub': return new FourKHDHubProvider(meta);
    case 'vegamovies': return new VegaMoviesProvider(meta);
    default: throw new Error('unknown provider kind: ' + entry.kind);
  }
}

function list() {
  return ENTRIES.map(e => ({
    id: e.id, kind: e.kind, name: e.name, short: e.short, repo: e.repo,
    plugin: e.plugin, file: e.file, language: e.language, region: e.region || '',
    accent: e.accent,
    dir: path.join(ROOT, 'extensions', e.repo),
    script: path.join(ROOT, 'extensions', e.repo, `start-${e.id}.bat`),
  }));
}

function get(id) {
  const entry = ENTRIES.find(e => e.id === id);
  if (!entry) throw new Error(`Unknown provider "${id}"`);
  if (!cache.has(id)) cache.set(id, createEntry(entry));
  return cache.get(id);
}

function byKind(kind) { return ENTRIES.filter(e => e.kind === kind); }

module.exports = { list, get, byKind, ENTRIES, ROOT };
