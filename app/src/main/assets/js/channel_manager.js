/**
 * Nemo TV — Channel Manager & Multi-Playlist Aggregator
 * Fetches multiple playlists in parallel, deduplicates channels into a superset,
 * and maintains redundant stream sources for seamless failover.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./m3u_parser'));
  } else {
    root.ChannelManager = factory(root.M3UParser);
  }
})(typeof self !== 'undefined' ? self : this, function (M3UParser) {

  const DEFAULT_PLAYLISTS = [
    { name: "Terminal JioTV MPD (High Priority Direct DRM)", url: "https://m3u8playlistterminal-jiotv.lovable.app/api/playlist", enabled: true },
    { name: "AllInOne Reborn ClearKey", url: "https://allinonereborn2.online/jiotv-m3u/jtv25.m3u8", enabled: true },
    { name: "StreamFlex JioTV HLS", url: "https://jiomv5cdn20.zonmp.net/", enabled: true }
  ];

  const CACHE_KEY_CHANNELS = 'nemotv_cached_channels_v11';
  const CACHE_KEY_TIMESTAMP = 'nemotv_cache_timestamp_v11';
  const PLAYLISTS_KEY = 'nemotv_user_playlists_v11';

  const DEAD_DOMAINS = [
    'bq32.short.gy',
    'vodep39240327',
    'player.mrfooll.xyz',
    'fast1.mrfooll.xyz',
    'madflixmovies.online',
    'premiumplug.fun',
    'app.ashokadigital.net',
    'play.applelive.in',
    'live.skystream.in',
    'streamflexsmm.in/keylicense',
    'example.com'
  ];

  function getSourceScore(source) {
    let score = 0;
    const u = (source.url || '').toLowerCase();
    const drmKey = (source.drm && source.drm.key ? source.drm.key : '').toLowerCase();

    // Dead / Broken domains or dead key servers get immediate elimination penalty
    if (DEAD_DOMAINS.some(d => u.includes(d) || drmKey.includes(d))) {
      return -1000;
    }

    // 1. Direct Akamai Jio CDN endpoints are genuine, official, high-bandwidth (top priority)
    if (u.includes('cdn.jio.com')) {
      score += 200;
    } else if (u.includes('sunnxt.com')) {
      score += 120;
    } else if (u.includes('jiotv')) {
      score += 30;
    }

    // 2. Direct embedded ClearKey hex key gets boost (no remote key server roundtrip)
    if (source.drm && source.drm.key) {
      if (!source.drm.key.startsWith('http')) {
        score += 150;
      } else {
        score += 10; // Remote worker key server URL (may be rate-limited or return empty keys)
      }
    }

    if (u.includes('workers.dev')) {
      score -= 20;
    }

    // 3. Token expiration inspection in URL and headers
    const cookie = (source.headers && (source.headers['Cookie'] || source.headers['cookie'])) || '';
    const tokenStr = cookie + ' ' + u;
    const match = tokenStr.match(/exp=(\d+)/);
    if (match) {
      const expTime = parseInt(match[1]);
      const nowSec = Math.floor(Date.now() / 1000);
      if (expTime < nowSec) {
        score -= 250; // Expired token: deprioritize
      } else {
        score += 40; // Valid active token
      }
    }
    return score;
  }

  function cleanMovieMetadata(raw) {
    if (!raw) return { name: '', year: '', rating: '' };
    let clean = raw.trim();
    // 1. Remove broken image prefix fragments e.g. "0,720,1080_.jpg" ,
    clean = clean.replace(/^["\s\d,._]*\.jpe?g["\s,]*/i, '');
    // 2. Remove group prefix e.g. VT 🎬| or #
    clean = clean.replace(/^(?:VT\s*🎬\s*\|?|#)\s*/i, '');
    // 3. Extract pure movie name before (IMDb ... Director ...) or (2024 ...)
    const match = clean.match(/^([^(|]+)/);
    let name = match ? match[1].trim() : clean;
    // Strip trailing resolution tags
    name = name.replace(/\s*(?:True\s*HD|1080p|720p|Atmos|WEB-DL|HEVC|x264|x265|HQ|HD).*$/i, '').trim();

    // Extract year if present
    const yearMatch = clean.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : '';

    // Extract rating if present
    const ratingMatch = clean.match(/(?:IMDb|𝗜𝗠𝗗𝗯)\s*([\d.]+)/i);
    const rating = ratingMatch ? ratingMatch[1] : '';

    return { name: name || raw, year, rating };
  }

  class ChannelManager {
    constructor() {
      this.channels = [];
      this.categories = [];
      this.languages = [];
      this.languagePriority = [
        'Tamil',
        'Malayalam',
        'Telugu',
        'Kannada',
        'Hindi',
        'English',
        'Bengali',
        'Marathi',
        'Punjabi',
        'Gujarati',
        'Odia',
        'General'
      ];
      // Clean up any legacy cache versions from older builds
      if (typeof localStorage !== 'undefined') {
        for (let v = 1; v <= 9; v++) {
          try {
            localStorage.removeItem(`nemotv_cached_channels_v${v}`);
            localStorage.removeItem(`nemotv_cache_timestamp_v${v}`);
            localStorage.removeItem(`nemotv_user_playlists_v${v}`);
          } catch (_) {}
        }
      }

      this.playlists = this.loadPlaylists();
      this.listeners = [];
      this.isSyncing = false;
    }

    loadPlaylists() {
      if (typeof localStorage === 'undefined') return DEFAULT_PLAYLISTS;
      try {
        const stored = localStorage.getItem(PLAYLISTS_KEY);
        if (stored) {
          const list = JSON.parse(stored);
          if (list && Array.isArray(list)) {
            // Purge any dead or decommissioned providers
            const cleaned = list.filter(p =>
              p.url &&
              !p.url.includes('workers.dev') &&
              !p.url.includes('short.gy') &&
              !p.url.includes('vodep') &&
              !p.url.includes('jtv.m3u8')
            );
            if (cleaned.length > 0) return cleaned;
          }
        }
      } catch (e) {
        console.warn('[NemoTV] Could not read user playlists:', e);
      }
      return DEFAULT_PLAYLISTS;
    }

    savePlaylists(playlists) {
      this.playlists = playlists;
      try {
        localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
      } catch (e) {}
    }

    addListener(fn) {
      if (typeof fn === 'function') this.listeners.push(fn);
    }

    notify(event, data) {
      this.listeners.forEach(fn => fn(event, data));
    }

    normalizeKey(str) {
      if (!str) return '';
      return str
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
    }

    categorize(rawGroup, name) {
      const normalizedGroup = (rawGroup || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      const g = (normalizedGroup + ' ' + (name || '')).toLowerCase();

      // 1. Bigg Boss 24/7 Priority
      if (g.includes('bigg boss') || g.includes('bigboss') || g.includes('big boss')) {
        return 'Bigg Boss 24/7';
      }

      // 2. Web Series & OTT Shows Priority
      if (g.includes('web series') || g.includes('series') || g.includes('vt') && g.includes('movies')) {
        return 'Movies';
      }
      if (g.includes('web series') || g.includes('series')) {
        return 'Web Series';
      }
      if (g.includes('ott') || g.includes('cooku with comali') || g.includes('adhu idhu yedhu')) {
        return 'OTT & Shows';
      }

      // 3. Events & Extra Specials
      if (g.includes('extra') || g.includes('event') || g.includes('special')) {
        return 'Events & Specials';
      }

      // 4. Standard Categories
      if (g.includes('sport') || g.includes('cricket') || g.includes('football') || g.includes('fifa') || g.includes('wwe')) return 'Sports';
      if (g.includes('movie') || g.includes('cinema') || g.includes('film')) return 'Movies';
      if (g.includes('news') || g.includes('aaj tak') || g.includes('abp') || g.includes('ndtv') || g.includes('cnn') || g.includes('business')) return 'News';
      if (g.includes('music') || g.includes('song') || g.includes('mtv') || g.includes('zoom') || g.includes('b4u music')) return 'Music';
      if (g.includes('kid') || g.includes('cartoon') || g.includes('nick') || g.includes('pogo') || g.includes('disney') || g.includes('sonic')) return 'Kids';
      if (g.includes('infotain') || g.includes('discovery') || g.includes('nat geo') || g.includes('history') || g.includes('animal planet') || g.includes('science') || g.includes('lifestyle')) return 'Infotainment';
      if (g.includes('tamil') || g.includes('telugu') || g.includes('malayalam') || g.includes('kannada') || g.includes('bengali') || g.includes('marathi') || g.includes('punjabi') || g.includes('gujarati') || g.includes('bhojpuri') || g.includes('odia') || g.includes('assamese')) return 'Regional';
      if (g.includes('devotion') || g.includes('bhakti') || g.includes('spiritual') || g.includes('aastha') || g.includes('sadhna')) return 'Devotional';
      return 'Entertainment';
    }

    detectLanguage(rawGroup, name, existingLang) {
      if (existingLang && existingLang.length > 2 && existingLang.toLowerCase() !== 'unknown') {
        const l = existingLang.toLowerCase();
        if (l.includes('tamil')) return 'Tamil';
        if (l.includes('malayalam') || l.includes('malyalam')) return 'Malayalam';
        if (l.includes('telugu')) return 'Telugu';
        if (l.includes('kannada')) return 'Kannada';
        if (l.includes('hindi')) return 'Hindi';
        if (l.includes('english')) return 'English';
        if (l.includes('bengali') || l.includes('bangla')) return 'Bengali';
        if (l.includes('marathi')) return 'Marathi';
        if (l.includes('punjabi')) return 'Punjabi';
        if (l.includes('gujarati')) return 'Gujarati';
        if (l.includes('odia')) return 'Odia';
      }

      const normalized = ((rawGroup || '') + ' ' + (name || '')).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      const str = normalized.toLowerCase();

      if (str.includes('tamil') || str.includes('sun tv') || str.includes('vijay') || str.includes('kalaignar') || str.includes('jaya') || str.includes('polimer') || str.includes('raj tv') || str.includes('captain') || str.includes('vasanth') || str.includes('sirippoli') || str.includes('adithya') || str.includes('kalignar') || str.includes('chithiram') || str.includes('murasu')) return 'Tamil';
      if (str.includes('malayalam') || str.includes('malyalam') || str.includes('asianet') || str.includes('surya') || str.includes('manorama') || str.includes('mathrubhumi') || str.includes('kairali') || str.includes('amrita') || str.includes('mazhavil') || str.includes('kaumudy') || str.includes('safari tv') || str.includes('kerala')) return 'Malayalam';
      if (str.includes('telugu') || str.includes('etv') || str.includes('gemini') || str.includes('maa') || str.includes('sakshi') || str.includes('tv9 telugu') || str.includes('abn') || str.includes('v6 news') || str.includes('ntv telugu') || str.includes('t news')) return 'Telugu';
      if (str.includes('kannada') || str.includes('udaya') || str.includes('colors kannada') || str.includes('tv9 kannada') || str.includes('suvarna') || str.includes('public tv') || str.includes('kasthuri')) return 'Kannada';
      if (str.includes('bengali') || str.includes('bangla') || str.includes('zee bangla') || str.includes('star jalsha') || str.includes('colors bangla') || str.includes('abp ananda')) return 'Bengali';
      if (str.includes('marathi') || str.includes('zee 24 taas') || str.includes('colors marathi') || str.includes('star pravah') || str.includes('abp majha') || str.includes('saam tv')) return 'Marathi';
      if (str.includes('punjabi') || str.includes('ptc') || str.includes('zee punjabi') || str.includes('mh1')) return 'Punjabi';
      if (str.includes('gujarati') || str.includes('colors gujarati') || str.includes('sandesh') || str.includes('tv9 gujarati') || str.includes('vtv gujarati')) return 'Gujarati';
      if (str.includes('odia') || str.includes('tarang') || str.includes('prarthana') || str.includes('otv') || str.includes('zee sarthak') || str.includes('kalinga')) return 'Odia';
      if (str.includes('hindi') || str.includes('aaj tak') || str.includes('zee news') || str.includes('star plus') || str.includes('colors hd') || str.includes('set max') || str.includes('sony sab') || str.includes('star gold') || str.includes('zee cinema') || str.includes('india tv') || str.includes('abp news') || str.includes('news18 india') || str.includes('sony tv') || str.includes('colors rishtey')) return 'Hindi';
      if (str.includes('english') || str.includes('cnn') || str.includes('bbc') || str.includes('hbo') || str.includes('history') || str.includes('discovery') || str.includes('nat geo') || str.includes('animal planet') || str.includes('al jazeera') || str.includes('euro news')) return 'English';

      return 'General';
    }

    async fetchPlaylistWithTimeout(playlist, timeoutMs = 28000) {
      // 1. Android TV Native Bridge (bypasses WebView CORS and restrictions)
      if (typeof window !== 'undefined' && window.AndroidNative && typeof window.AndroidNative.fetchUrl === 'function') {
        try {
          console.log(`[NemoTV] 🌐 Fetching via AndroidNative: ${playlist.name}`);
          const nativeText = window.AndroidNative.fetchUrl(playlist.url);
          if (nativeText && (nativeText.includes('#EXTM3U') || nativeText.includes('#EXTINF'))) {
            const items = M3UParser.parse(nativeText, playlist.name);
            console.log(`[NemoTV] ✓ ${playlist.name}: parsed ${items.length} stream entries via native`);
            return { name: playlist.name, items, success: true };
          }
        } catch (nativeErr) {
          console.warn(`[NemoTV] AndroidNative fetch failed for ${playlist.name}:`, nativeErr);
        }
      }

      // 2. Browser fetch fallback
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);

      try {
        console.log(`[NemoTV] Fetching playlist: ${playlist.name} (${playlist.url})`);
        let resp;
        try {
          resp = await fetch(playlist.url, {
            signal: controller.signal,
            headers: {
              'Accept': '*/*'
            }
          });
        } catch (fetchErr) {
          // If direct fetch fails (e.g. CORS in desktop browser preview), try local preview server proxy
          if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
            console.log(`[NemoTV] Direct fetch blocked (${fetchErr.message}), falling back to dev proxy for ${playlist.name}`);
            resp = await fetch(`/proxy?url=${encodeURIComponent(playlist.url)}`, { signal: controller.signal });
          } else {
            throw fetchErr;
          }
        }
        clearTimeout(id);

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        const text = await resp.text();
        if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
          throw new Error('Response does not contain valid M3U playlist headers');
        }

        const items = M3UParser.parse(text, playlist.name);
        console.log(`[NemoTV] ✓ ${playlist.name}: parsed ${items.length} stream entries`);
        return { name: playlist.name, items, success: true };
      } catch (err) {
        clearTimeout(id);
        console.warn(`[NemoTV] ✕ Failed fetching ${playlist.name}:`, err.message);
        return { name: playlist.name, items: [], success: false, error: err.message };
      }
    }

    loadCachedChannels() {
      // 1. Try local storage cache
      if (typeof localStorage !== 'undefined') {
        try {
          const cached = localStorage.getItem(CACHE_KEY_CHANNELS);
          if (cached) {
            const list = JSON.parse(cached);
            if (list && list.length > 0) {
              this.channels = list;
              this.channels.forEach((ch, idx) => {
                if (!ch.channelNumber) ch.channelNumber = idx + 1;
              });
              this.extractCategories();
              this.extractLanguages();
              console.log(`[NemoTV] Restored ${this.channels.length} channels from offline cache`);
              return true;
            }
          }
        } catch (e) {
          console.warn('[NemoTV] Cache restoration failed:', e);
        }
      }

      // 2. Try Android native bundled master channels (instant zero-network cold start)
      if (typeof window !== 'undefined' && window.AndroidNative && typeof window.AndroidNative.loadBundledChannels === 'function') {
        try {
          const bundled = window.AndroidNative.loadBundledChannels();
          if (bundled) {
            const list = JSON.parse(bundled);
            if (list && list.length > 0) {
              this.channels = list;
              this.channels.forEach((ch, idx) => {
                if (!ch.channelNumber) ch.channelNumber = idx + 1;
              });
              this.extractCategories();
              this.extractLanguages();
              console.log(`[NemoTV] 🚀 Loaded ${this.channels.length} channels from Android APK bundle`);
              return true;
            }
          }
        } catch (e) {
          console.warn('[NemoTV] Bundled APK channel loading failed:', e);
        }
      }

      return false;
    }

    extractCategories(section = 'live') {
      const channels = this.channels.filter(ch => section === 'vod' ? ch.isMovie : !ch.isMovie);
      const existing = new Set(channels.map(ch => ch.category).filter(Boolean));
      existing.delete('Movies');

      const priority = section === 'vod'
        ? ['All Movies', 'Action', 'Comedy', 'Drama', 'Thriller', 'Romance', 'Family']
        : [
            'All Channels',
            'Bigg Boss 24/7',
            'Sports',
            'Web Series',
            'Entertainment',
            'News',
            'Kids',
            'Infotainment',
            'Music',
            'Regional',
            'Devotional'
          ];
      const sorted = [];
      priority.forEach(p => {
        if (p === 'All Channels' || p === 'All Movies' || existing.has(p)) {
          sorted.push(p);
          existing.delete(p);
        }
      });
      existing.forEach(e => sorted.push(e));
      if (section === 'live') {
        this.categories = sorted;
      }
      return sorted;
    }

    extractLanguages(section = 'live') {
      const channels = this.channels.filter(ch => section === 'vod' ? ch.isMovie : !ch.isMovie);
      const langCounts = {};
      channels.forEach(ch => {
        const l = ch.language || 'General';
        langCounts[l] = (langCounts[l] || 0) + 1;
      });

      const sorted = ['All Languages'];
      this.languagePriority.forEach(p => {
        if (langCounts[p]) {
          sorted.push(p);
          delete langCounts[p];
        }
      });
      Object.keys(langCounts).sort().forEach(other => {
        if (other !== 'General') sorted.push(other);
      });
      if (langCounts['General'] && !sorted.includes('General')) {
        sorted.push('General');
      }

      if (section === 'live') {
        this.languages = sorted;
        this.languageCounts = langCounts;
      }
      return sorted;
    }

    getCategories(section = 'live') {
      return this.extractCategories(section);
    }

    getLanguages(section = 'live') {
      return this.extractLanguages(section);
    }

    sortChannelsByPriority(channels) {
      if (!channels || channels.length === 0) return [];
      const priorityMap = new Map();
      this.languagePriority.forEach((lang, idx) => priorityMap.set(lang, idx));

      return [...channels].sort((a, b) => {
        // 1. LIVE TV CHANNELS ALWAYS COME FIRST BEFORE VOD MOVIES!
        const isMovieA = a.isMovie ? 1 : 0;
        const isMovieB = b.isMovie ? 1 : 0;
        if (isMovieA !== isMovieB) {
          return isMovieA - isMovieB; // Live TV (0) comes before Movies (1)
        }

        // 2. Language Priority
        const langA = a.language || 'General';
        const langB = b.language || 'General';

        const pA = priorityMap.has(langA) ? priorityMap.get(langA) : 999;
        const pB = priorityMap.has(langB) ? priorityMap.get(langB) : 999;

        if (pA !== pB) {
          return pA - pB;
        }

        return a.name.localeCompare(b.name);
      });
    }

    async syncAllPlaylists() {
      if (this.isSyncing) return;
      this.isSyncing = true;
      this.notify('sync_start', { count: this.playlists.length });

      const activePlaylists = this.playlists.filter(p => p.enabled !== false);
      const channelMap = new Map();

      // If existing channels exist in memory, populate map
      if (this.channels && this.channels.length > 0) {
        this.channels.forEach(ch => channelMap.set(ch.id, ch));
      }

      const mergePlaylistItems = (items, playlistName) => {
        if (!items || items.length === 0) return;
        items.forEach(item => {
          // Filter out fake, dead, spam, or broken stream sources
          if (!item.url || !item.url.startsWith('http')) return;
          const uLower = item.url.toLowerCase();
          const keyLower = (item.drm && item.drm.key ? item.drm.key : '').toLowerCase();
          if (DEAD_DOMAINS.some(d => uLower.includes(d) || keyLower.includes(d))) {
            return;
          }

          const detectedLang = this.detectLanguage(item.group, item.name, item.language);
          const gLower = (item.group || '').toLowerCase();
          const nLower = (item.name || item.title || '').toLowerCase();
          const hasYear = /\((?:19|20)\d{2}\)/.test(nLower) || /\b(?:19|20)\d{2}\b/.test(nLower);
          const isVodGroup = gLower.includes('vod') || gLower.includes('vt 🎬') ||
                             /tamil\s*movies/i.test(gLower) || /hindi\s*movies/i.test(gLower) ||
                             /telugu\s*movies/i.test(gLower) || /malayalam\s*movies/i.test(gLower);
          const isMovie = isVodGroup || hasYear;
          const category = isMovie ? 'Movies' : this.categorize(item.group, item.name);

          let displayName = item.name || item.title;
          let movieMeta = null;
          if (isMovie) {
            movieMeta = cleanMovieMetadata(displayName);
            displayName = movieMeta.name;
          }

          const normName = this.normalizeKey(displayName);
          const normTvg = this.normalizeKey(item.tvgId);
          // Keep HD and SD channels distinct so Asianet and Asianet HD have their own accurate 3-source failovers
          const key = isMovie ? `vod_${normName}` : ((normTvg && normTvg.length > 2 && !/^\d+$/.test(normTvg)) ? `id_${normTvg}` : `name_${normName}`);

          if (!key || key.length <= 3) return;

          const sourcePlaylistName = item.sourcePlaylist || playlistName;
          const sourceEntry = {
            url: item.url,
            manifestType: item.manifestType,
            drm: item.drm,
            headers: item.headers,
            playlistName: sourcePlaylistName
          };

          if (channelMap.has(key)) {
            const existing = channelMap.get(key);
            const cleanUrl = item.url.split('?')[0];

            // Avoid duplicate sources from background syncs: check if we already have this playlist or base URL
            const existingIdx = existing.sources.findIndex(s =>
              s.playlistName === sourcePlaylistName || s.url.split('?')[0] === cleanUrl
            );

            if (existingIdx >= 0) {
              // Update with fresher token from new sync instead of piling duplicate streams
              existing.sources[existingIdx] = sourceEntry;
            } else if (existing.sources.length < 3) {
              // Cap at exactly 3 sources (1 per enabled playlist)
              existing.sources.push(sourceEntry);
            }

            // Sort sources so Direct ClearKey hex DRM & Akamai CDN are always Source 1
            existing.sources.sort((a, b) => getSourceScore(b) - getSourceScore(a));

            // Prefer HD name over SD name for display
            if (/\bhd\b/i.test(item.name || item.title || '') && !/\bhd\b/i.test(existing.name)) {
              existing.name = displayName;
              existing.title = existing.name;
            }

            if ((!existing.logo || existing.logo.includes('default') || existing.logo === 'icon.png') && item.logo) {
              existing.logo = item.logo;
            }
            if ((!existing.language || existing.language === 'General') && detectedLang !== 'General') {
              existing.language = detectedLang;
            }
            if ((existing.category === 'Entertainment' || existing.category === 'General') && category !== 'Entertainment') {
              existing.category = category;
            }
            if (isMovie) {
              existing.isMovie = true;
              if (movieMeta && movieMeta.year) existing.year = movieMeta.year;
              if (movieMeta && movieMeta.rating) existing.rating = movieMeta.rating;
            }
          } else {
            channelMap.set(key, {
              id: key,
              name: displayName,
              title: displayName,
              tvgId: item.tvgId,
              logo: item.logo,
              group: item.group,
              category: category,
              language: detectedLang,
              isMovie: isMovie,
              year: movieMeta ? movieMeta.year : null,
              rating: movieMeta ? movieMeta.rating : null,
              sources: [sourceEntry]
            });
          }
        });

        this.channels = this.sortChannelsByPriority(
          Array.from(channelMap.values()).filter(ch => ch.sources && ch.sources.length > 0)
        );
        this.channels.forEach((ch, idx) => {
          ch.channelNumber = idx + 1;
        });
        this.extractCategories();
        this.extractLanguages();
        this.notify('sync_progress', {
          playlistName: playlistName,
          channelCount: this.channels.length,
          sourcesCount: this.channels.reduce((sum, ch) => sum + ch.sources.length, 0)
        });
      };

      // 1. Fetch primary fast playlist first (Terminal JioTV MPD) for instantaneous initial display
      const primaryPlaylist = activePlaylists[0];
      const backgroundPlaylists = activePlaylists.slice(1);

      console.log(`[NemoTV] ⚡ Phase 1: Fast initial load from ${primaryPlaylist.name}...`);
      const firstRes = await this.fetchPlaylistWithTimeout(primaryPlaylist);
      if (firstRes.success) {
        mergePlaylistItems(firstRes.items, firstRes.name);
      }

      // 2. Concurrently fetch all background playlists and progressively stream into view
      console.log(`[NemoTV] 🔄 Phase 2: Progressively merging ${backgroundPlaylists.length} remaining playlists in background...`);
      await Promise.all(backgroundPlaylists.map(async p => {
        const res = await this.fetchPlaylistWithTimeout(p);
        if (res.success) {
          mergePlaylistItems(res.items, res.name);
        }
      }));

      this.isSyncing = false;
      try {
        localStorage.setItem(CACHE_KEY_CHANNELS, JSON.stringify(this.channels));
        localStorage.setItem(CACHE_KEY_TIMESTAMP, Date.now().toString());
      } catch (e) {}

      this.notify('sync_complete', {
        channelCount: this.channels.length,
        sourcesCount: this.channels.reduce((sum, ch) => sum + ch.sources.length, 0)
      });

      return this.channels;
    }

    getFilteredChannels({ section = 'live', category = 'All Channels', language = 'All Languages', query = '' } = {}) {
      let result = this.channels.filter(ch => section === 'vod' ? ch.isMovie : !ch.isMovie);

      if (category && category !== 'All Channels' && category !== 'All Movies') {
        result = result.filter(ch => ch.category === category);
      }

      if (language && language !== 'All Languages') {
        result = result.filter(ch => (ch.language || 'General') === language);
      }

      if (query && query.trim()) {
        const q = query.trim().toLowerCase();
        result = result.filter(ch =>
          ch.name.toLowerCase().includes(q) ||
          (ch.category && ch.category.toLowerCase().includes(q)) ||
          (ch.language && ch.language.toLowerCase().includes(q))
        );
      }

      if (language === 'All Languages') {
        return this.sortChannelsByPriority(result);
      }

      return result.sort((a, b) => a.name.localeCompare(b.name));
    }

    getChannelsByCategory(category) {
      return this.getFilteredChannels({ category });
    }

    searchChannels(query) {
      return this.getFilteredChannels({ query });
    }
  }

  return ChannelManager;
});
