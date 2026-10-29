/**
 * Nemo TV — Hybrid Dual Playback Engine & Automatic Failover Controller
 * Powered by Hls.js for HLS & Shaka Player for DASH with ClearKey DRM
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NemoPlayer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Robust atob polyfill ensuring padding for webOS Chromium
  if (typeof window !== 'undefined' && window.atob) {
    const _origAtob = window.atob;
    window.atob = function (str) {
      if (typeof str !== 'string') return '';
      let s = str.replace(/[\s\r\n]+/g, '');
      while (s.length % 4 !== 0) s += '=';
      return _origAtob.call(window, s);
    };
  }

  function base64UrlToHex(str) {
    if (!str) return '';
    const clean = str.trim();
    if (/^[0-9a-f]{32}$/i.test(clean)) {
      return clean.toLowerCase();
    }
    if (/^[0-9a-f-]{36}$/i.test(clean)) {
      return clean.replace(/-/g, '').toLowerCase();
    }
    try {
      let b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const bin = atob(b64);
      let hex = '';
      for (let i = 0; i < bin.length; i++) {
        hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
      }
      return hex.toLowerCase();
    } catch (_) {
      return clean.replace(/[^0-9a-f]/gi, '').toLowerCase();
    }
  }

  function formatProxyUrl(rawUrl, headers) {
    if (!rawUrl) return '';
    if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      if (rawUrl.includes(window.location.host) || rawUrl.startsWith('/proxy')) {
        return rawUrl;
      }
      const cookie = (headers && (headers['Cookie'] || headers['cookie'])) || '';
      const ua = (headers && (headers['User-Agent'] || headers['user-agent'])) || '';
      const ref = (headers && (headers['Referer'] || headers['referer'])) || '';
      const orig = (headers && (headers['Origin'] || headers['origin'])) || '';
      return `/proxy?url=${encodeURIComponent(rawUrl)}&cookie=${encodeURIComponent(cookie)}&ua=${encodeURIComponent(ua)}&referer=${encodeURIComponent(ref)}&origin=${encodeURIComponent(orig)}`;
    }
    return rawUrl;
  }

  class NemoPlayer {
    constructor(videoElement, hudElements) {
      this.video = videoElement;
      this.hud = hudElements || {};
      this.shakaPlayer = null;
      this.hlsPlayer = null;
      this.currentChannel = null;
      this.currentSourceIndex = 0;
      this.activeHeaders = {};
      this.isSwitching = false;
      this.isUnloading = false;
      this.stallTimeout = null;
      this.hudHideTimeout = null;

      this.initShaka();
      this.setupHudEvents();
    }

    async initShaka() {
      if (typeof shaka !== 'undefined') {
        shaka.polyfill.installAll();
        if (shaka.Player.isBrowserSupported()) {
          this.shakaPlayer = new shaka.Player(this.video);

          // Dynamic request filter: proxy remote segment URLs on localhost without double-proxying
          this.shakaPlayer.getNetworkingEngine().registerRequestFilter((type, request) => {
            if (!request.uris || request.uris.length === 0) return;

            // 1. Localhost proxy filter (ONLY for http/https)
            if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
              request.uris = request.uris.map(u => {
                if (u.startsWith('http://') || u.startsWith('https://')) {
                  if (!u.includes(window.location.host) && !u.startsWith('/proxy')) {
                    return formatProxyUrl(u, this.activeHeaders);
                  }
                }
                return u;
              });
            }

            // 2. Append Akamai CDN token from Cookie ONLY to HTTP/HTTPS URLs (NEVER data: or blob: URIs!)
            const cookie = (this.activeHeaders && (this.activeHeaders['Cookie'] || this.activeHeaders['cookie'])) || '';
            const hdneaMatch = cookie.match(/__hdnea__=[^;,\s]+/);
            if (hdneaMatch) {
              const tokenStr = hdneaMatch[0];
              request.uris = request.uris.map(u => {
                // CRITICAL: NEVER tamper with data: or blob: URIs (breaks ClearKey license decryption!)
                if (!u.startsWith('http://') && !u.startsWith('https://')) {
                  return u;
                }
                if (!u.includes('__hdnea__=')) {
                  const sep = u.includes('?') ? '&' : '?';
                  return u + sep + tokenStr;
                }
                return u;
              });
            }

            // 3. Set custom headers only for remote HTTP/HTTPS requests
            const isDataOrBlob = request.uris.some(u => u.startsWith('data:') || u.startsWith('blob:'));
            if (this.activeHeaders && !isDataOrBlob) {
              for (const [key, val] of Object.entries(this.activeHeaders)) {
                if (val && key.toLowerCase() !== 'cookie') {
                  request.headers[key] = val;
                }
              }
            }
          });

          this.shakaPlayer.addEventListener('error', (event) => {
            if (this.isUnloading) return;
            this.handlePlaybackError(event.detail);
          });
        }
      }

      this.video.addEventListener('error', () => {
        if (this.isUnloading) return;
        if (!this.video.src && !this.video.currentSrc) return;
        if (this.video.error) {
          // Ignore error code 4 if source is being unloaded
          if (this.video.error.code === 4 && this.isSwitching) return;
          this.handlePlaybackError({
            category: 'MEDIA',
            code: this.video.error.code,
            message: this.video.error.message || 'HTML5 Media Error'
          });
        }
      });

      this.video.addEventListener('playing', () => {
        this.clearStallTimer();
        this.hideStatusBanner();
        this.updateLoaderStatus('✓ Live Broadcast Ready');
        clearTimeout(this._loaderFadeTimeout);
        this._loaderFadeTimeout = setTimeout(() => {
          this.hideLoader();
        }, 350);
        this.updateTracksUI();
        try {
          this.video.muted = false;
          this.video.volume = 1.0;
        } catch (_) {}
      });

      this.video.addEventListener('timeupdate', () => {
        if (this.video.currentTime > 0) {
          if (this.video.muted) {
            try {
              this.video.muted = false;
              this.video.volume = 1.0;
            } catch (_) {}
          }
          if (this.hud.loader && !this.hud.loader.classList.contains('hidden')) {
            this.hideLoader();
          }
        }
      });

      console.log('[NemoPlayer] Dual playback engine initialized.');
    }

    showLoader(channel, statusText) {
      if (this.hud.loader) {
        if (this.hud.loaderLogo && channel) {
          this.hud.loaderLogo.src = channel.logo || 'icon.png';
        }
        if (this.hud.loaderTitle && channel) {
          this.hud.loaderTitle.textContent = channel.name || 'Nemo TV';
        }
        if (this.hud.loaderStatus) {
          this.hud.loaderStatus.textContent = statusText || 'Connecting to Live Broadcast...';
        }
        this.hud.loader.classList.remove('hidden');
      }
    }

    updateLoaderStatus(statusText) {
      if (this.hud.loaderStatus && statusText) {
        this.hud.loaderStatus.textContent = statusText;
      }
    }

    hideLoader() {
      if (this.hud.loader) {
        this.hud.loader.classList.add('hidden');
      }
    }

    setupHudEvents() {
      const showHud = () => {
        if (this.hud.container) {
          this.hud.container.classList.remove('hidden');
          this.resetHudTimer();
        }
      };

      window.addEventListener('mousemove', showHud);
      window.addEventListener('keydown', showHud);

      if (this.hud.btnPlayPause) {
        this.hud.btnPlayPause.addEventListener('click', () => {
          if (this.video.paused) {
            this.video.play();
            this.hud.btnPlayPause.innerHTML = '⏸ Pause';
          } else {
            this.video.pause();
            this.hud.btnPlayPause.innerHTML = '▶ Play';
          }
        });
      }

      if (this.hud.btnReload) {
        this.hud.btnReload.addEventListener('click', () => {
          if (this.currentChannel) {
            this.loadCurrentSource();
          }
        });
      }

      if (this.hud.btnNextSource) {
        this.hud.btnNextSource.addEventListener('click', () => {
          this.tryNextSource('Manual source switch');
        });
      }

      if (this.hud.btnBack) {
        this.hud.btnBack.addEventListener('click', () => {
          this.stopAndClose();
        });
      }
    }

    resetHudTimer() {
      clearTimeout(this.hudHideTimeout);
      this.hudHideTimeout = setTimeout(() => {
        if (this.hud.container && !this.video.paused) {
          this.hud.container.classList.add('hidden');
        }
      }, 4500);
    }

    async playChannel(channel) {
      if (!channel || !channel.sources || channel.sources.length === 0) {
        this.showStatusBanner('No available streams for this channel', 'error');
        return;
      }

      this.currentChannel = channel;
      this.currentSourceIndex = 0;
      this.isSwitching = false;
      this.openPlayerUI();
      try {
        this.video.muted = false;
        this.video.volume = 1.0;
      } catch (_) {}
      this.showLoader(channel, 'Connecting to ' + channel.name + '...');
      await this.loadCurrentSource();
    }

    openPlayerUI() {
      document.body.classList.add('player-mode');
      if (this.hud.playerView) {
        this.hud.playerView.classList.remove('hidden');
        this.hud.playerView.focus();
      }
      this.resetHudTimer();
    }

    stopAndClose() {
      this.clearStallTimer();
      clearTimeout(this.hudHideTimeout);
      this.isUnloading = true;

      if (this.hlsPlayer) {
        try { this.hlsPlayer.destroy(); } catch (_) {}
        this.hlsPlayer = null;
      }
      if (this.shakaPlayer) {
        try { this.shakaPlayer.unload().catch(() => {}); } catch (_) {}
      }

      try { this.video.pause(); } catch (_) {}
      this.video.removeAttribute('src');
      try { this.video.load(); } catch (_) {}
      this.isUnloading = false;

      this.hideLoader();
      document.body.classList.remove('player-mode');

      if (this.hud.playerView) {
        this.hud.playerView.classList.add('hidden');
      }
      this.currentChannel = null;
      if (typeof this.onCloseCallback === 'function') {
        this.onCloseCallback();
      }
    }

    onClose(cb) {
      this.onCloseCallback = cb;
    }

    async loadCurrentSource() {
      if (!this.currentChannel) return;
      const source = this.currentChannel.sources[this.currentSourceIndex];
      const totalSources = this.currentChannel.sources.length;

      this.clearStallTimer();
      this.updateHudMetadata(source, this.currentSourceIndex + 1, totalSources);
      this.showStatusBanner(`Connecting to Source ${this.currentSourceIndex + 1} of ${totalSources} (${source.playlistName})...`, 'info');
      this.showLoader(this.currentChannel, `Connecting to Source ${this.currentSourceIndex + 1} of ${totalSources} (${source.playlistName})...`);

      this.activeHeaders = Object.assign({}, source.headers || {});

      // Teardown previous active players safely
      this.isUnloading = true;
      if (this.hlsPlayer) {
        try { this.hlsPlayer.destroy(); } catch (_) {}
        this.hlsPlayer = null;
      }
      if (this.shakaPlayer) {
        try { await this.shakaPlayer.unload(); } catch (_) {}
      }
      this.isUnloading = false;

      let streamUrl = source.url.trim();
      const cookie = (source.headers && (source.headers['Cookie'] || source.headers['cookie'])) || '';
      const hdneaMatch = cookie.match(/__hdnea__=[^;,\s]+/);
      if (hdneaMatch && !streamUrl.includes('__hdnea__=')) {
        const sep = streamUrl.includes('?') ? '&' : '?';
        streamUrl = streamUrl + sep + hdneaMatch[0];
      }

      const isHls = streamUrl.includes('.m3u8') || source.manifestType === 'hls';
      const isProgressive = streamUrl.toLowerCase().includes('.mkv') ||
                            streamUrl.toLowerCase().includes('.mp4') ||
                            streamUrl.toLowerCase().includes('.webm');
      const hasDrm = !!source.drm;

      // Start stall watchdog (8.5s)
      this.startStallTimer();

      // Strategy 0: Direct HTML5 Media Engine for progressive files (.mkv, .mp4, .webm)
      if (isProgressive && !hasDrm) {
        console.log(`[NemoPlayer] ⚡ Engine: Direct HTML5 Media Engine for ${source.playlistName}`);
        try {
          if (this.shakaPlayer) {
            try { await this.shakaPlayer.unload(); } catch (_) {}
          }
          if (this.hlsPlayer) {
            this.hlsPlayer.destroy();
            this.hlsPlayer = null;
          }
          const playUrl = formatProxyUrl(streamUrl, this.activeHeaders);
          this.updateLoaderStatus('🎬 Starting Direct Media Playback...');
          this.video.src = playUrl;
          try {
            this.video.muted = false;
            this.video.volume = 1.0;
            await this.video.play();
          } catch (mediaErr) {
            console.warn('[NemoPlayer] Direct media unmuted blocked, playing muted and unmuting:', mediaErr);
            this.video.muted = true;
            await this.video.play();
            setTimeout(() => {
              try { this.video.muted = false; this.video.volume = 1.0; } catch (_) {}
            }, 150);
          }
          console.log(`[NemoPlayer] ✓ Playing direct media: ${playUrl}`);
          return;
        } catch (mediaErr) {
          console.warn(`[NemoPlayer] Direct media playback failed:`, mediaErr);
          this.handlePlaybackError(mediaErr);
          return;
        }
      }

      // Strategy 1: Hls.js for HLS streams without ClearKey DRM
      if (isHls && !hasDrm && typeof Hls !== 'undefined' && Hls.isSupported()) {
        console.log(`[NemoPlayer] ⚡ Engine: Hls.js for ${source.playlistName}`);
        try {
          this.hlsPlayer = new Hls({
            enableWorker: false,
            lowLatencyMode: false,
            backBufferLength: 30,
            maxBufferLength: 30,
            xhrSetup: (xhr, url) => {
              for (const [k, v] of Object.entries(this.activeHeaders)) {
                if (k.toLowerCase() !== 'cookie') {
                  try { xhr.setRequestHeader(k, v); } catch (_) {}
                }
              }
            }
          });

          this.updateLoaderStatus('📡 Buffering Live HLS Stream...');
          const playUrl = formatProxyUrl(streamUrl, this.activeHeaders);
          this.hlsPlayer.loadSource(playUrl);
          this.hlsPlayer.attachMedia(this.video);

          this.hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
            this.updateLoaderStatus('🎬 Starting Broadcast Stream...');
            this.video.muted = false;
            this.video.volume = 1.0;
            this.video.play().catch(e => {
              console.warn('[NemoPlayer] HLS unmuted play prevented, retrying muted:', e);
              this.video.muted = true;
              this.video.play().then(() => {
                setTimeout(() => {
                  try { this.video.muted = false; this.video.volume = 1.0; } catch (_) {}
                }, 150);
              }).catch(() => {});
            });
          });

          this.hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              console.warn('[NemoPlayer] Hls.js fatal error:', data.details);
              this.handlePlaybackError({ message: data.details || 'HLS stream error' });
            }
          });
          return;
        } catch (hlsErr) {
          console.warn('[NemoPlayer] Hls.js failed to initialize, falling back to Shaka:', hlsErr);
        }
      }

      // Strategy 2: Shaka Player for DASH (.mpd) and DRM Decryption
      if (this.shakaPlayer) {
        console.log(`[NemoPlayer] ⚡ Engine: Shaka Player (DASH / DRM) for ${source.playlistName}`);

        const config = {
          streaming: {
            bufferingGoal: 10,
            rebufferingGoal: 3,
            bufferBehind: 15,
            ignoreTextStreamFailures: true,
            alwaysStreamText: false,
            retryParameters: { maxAttempts: 3, baseDelay: 1000, backoffFactor: 2, timeout: 10000 }
          },
          manifest: {
            dash: {
              ignoreMinBufferTime: true,
              autoCorrectDrift: true
            },
            retryParameters: { maxAttempts: 3, baseDelay: 1000, backoffFactor: 2, timeout: 10000 }
          },
          drm: {}
        };

        if (source.drm) {
          if (source.drm.type === 'clearkey' && source.drm.key) {
            this.updateLoaderStatus('🔑 Authenticating Broadcast ClearKey License...');
            const keyStr = source.drm.key.trim();
            if (keyStr.startsWith('http://') || keyStr.startsWith('https://')) {
              try {
                const keyUrl = formatProxyUrl(keyStr, this.activeHeaders);
                const kResp = await fetch(keyUrl);
                const kData = await kResp.json();
                if (kData.keys && kData.keys.length > 0) {
                  const clearKeys = {};
                  kData.keys.forEach(kObj => {
                    const kidHex = base64UrlToHex(kObj.kid);
                    const kHex = base64UrlToHex(kObj.k);
                    if (kidHex && kHex) {
                      clearKeys[kidHex] = kHex;
                    }
                  });
                  if (Object.keys(clearKeys).length > 0) {
                    config.drm.clearKeys = clearKeys;
                    console.log('[NemoPlayer] Pre-fetched JWK ClearKeys:', clearKeys);
                  } else {
                    throw new Error('No valid hex keys extracted from key server');
                  }
                } else {
                  throw new Error('Key server returned empty keys');
                }
              } catch (jwkErr) {
                console.warn('[NemoPlayer] ClearKey fetch failed:', jwkErr.message);
                this.tryNextSource(jwkErr.message || 'Key license unavailable');
                return;
              }
            } else {
              const clearKeys = {};
              const pairs = keyStr.split(',');
              for (const p of pairs) {
                const [kid, k] = p.split(':');
                if (kid && k) {
                  const hexKid = base64UrlToHex(kid);
                  const hexK = base64UrlToHex(k);
                  if (hexKid && hexK) {
                    clearKeys[hexKid] = hexK;
                  }
                }
              }
              if (Object.keys(clearKeys).length > 0) {
                config.drm.clearKeys = clearKeys;
              }
            }
          } else if (source.drm.type === 'widevine' && source.drm.server) {
            config.drm.servers = { 'com.widevine.alpha': formatProxyUrl(source.drm.server, this.activeHeaders) };
          }
        }

        this.shakaPlayer.configure(config);

        try {
          this.updateLoaderStatus('📡 Buffering Live 1080p Stream...');
          const playUrl = formatProxyUrl(streamUrl, this.activeHeaders);
          await this.shakaPlayer.load(playUrl);
          this.updateLoaderStatus('🎬 Starting Audio & Video Streams...');
          try {
            this.video.muted = false;
            this.video.volume = 1.0;
            await this.video.play();
          } catch (e) {
            console.warn('[NemoPlayer] Autoplay prevented, retrying muted and unmuting:', e);
            this.video.muted = true;
            await this.video.play();
            setTimeout(() => {
              try {
                this.video.muted = false;
                this.video.volume = 1.0;
              } catch (_) {}
            }, 150);
          }
          console.log(`[NemoPlayer] ✓ Playing source ${this.currentSourceIndex + 1}: ${playUrl}`);
        } catch (shakaErr) {
          console.warn(`[NemoPlayer] Failed to load source ${this.currentSourceIndex + 1}:`, shakaErr);
          this.handlePlaybackError(shakaErr);
        }
      }
    }

    startStallTimer() {
      this.clearStallTimer();
      this.stallTimeout = setTimeout(() => {
        if (!this.video || this.video.currentTime > 0) return;
        if (this.video.paused || this.video.readyState < 2) {
          console.warn('[NemoPlayer] Stream startup stalled (> 12s). Triggering auto-failover.');
          this.tryNextSource('Startup timeout (> 12s)');
        }
      }, 12000);
    }

    clearStallTimer() {
      if (this.stallTimeout) {
        clearTimeout(this.stallTimeout);
        this.stallTimeout = null;
      }
    }

    handlePlaybackError(err) {
      if (this.isSwitching || this.isUnloading) return;
      // Filter out non-fatal / recoverable Shaka events (Severity 1)
      if (err && err.severity && err.severity !== 2) {
        console.log('[NemoPlayer] Recoverable event (severity ' + err.severity + '), allowing engine to auto-retry:', err.message || err.code);
        return;
      }
      // Ignore user-interrupted loads (Shaka code 7000 or abort)
      if (err && (err.code === 7000 || err.code === 7002 || (err.message && (err.message.includes('7000') || err.message.includes('interrupted') || err.message.includes('pause()'))))) {
        console.log('[NemoPlayer] Load interrupted, skipping failover');
        return;
      }
      const errorMsg = err.message || (err.code ? `Error code ${err.code}` : 'Playback error');
      console.warn(`[NemoPlayer] Stream failure on Source ${this.currentSourceIndex + 1}:`, errorMsg);
      this.tryNextSource(errorMsg);
    }

    tryNextSource(reason) {
      if (!this.currentChannel || this.isSwitching) return;
      this.isSwitching = true;
      this.clearStallTimer();

      const totalSources = this.currentChannel.sources.length;
      if (this.currentSourceIndex + 1 < totalSources) {
        this.currentSourceIndex++;
        const nextSource = this.currentChannel.sources[this.currentSourceIndex];
        this.showStatusBanner(
          `⚠️ Source ${this.currentSourceIndex} failed (${reason}). Switching to Backup Source ${this.currentSourceIndex + 1} (${nextSource.playlistName})...`,
          'warning'
        );

        setTimeout(async () => {
          this.isSwitching = false;
          await this.loadCurrentSource();
        }, 400);
      } else {
        this.isSwitching = false;
        this.showStatusBanner(`❌ All ${totalSources} stream sources failed for this channel. Please try another channel.`, 'error');
      }
    }

    updateHudMetadata(source, index, total) {
      if (this.hud.channelTitle) {
        this.hud.channelTitle.textContent = this.currentChannel.name;
      }
      if (this.hud.channelLogo) {
        this.hud.channelLogo.src = this.currentChannel.logo || 'icon.png';
      }
      if (this.hud.sourceBadge) {
        this.hud.sourceBadge.textContent = `Source ${index}/${total} • ${source.playlistName}`;
      }
    }

    showStatusBanner(message, type = 'info') {
      if (this.hud.loaderStatus) {
        this.hud.loaderStatus.textContent = message;
      }
      if (!this.hud.statusBanner) return;
      this.hud.statusBanner.textContent = message;
      this.hud.statusBanner.className = `status-banner ${type}`;
      this.hud.statusBanner.classList.remove('hidden');

      // Hold banner visible for 4.5 seconds so user can easily read it
      clearTimeout(this._statusBannerTimeout);
      this._statusBannerTimeout = setTimeout(() => {
        this.hideStatusBanner();
      }, 4500);
    }

    hideStatusBanner() {
      clearTimeout(this._statusBannerTimeout);
      if (this.hud.statusBanner) {
        this.hud.statusBanner.classList.add('hidden');
      }
    }

    updateTracksUI() {
      try {
        if (this.shakaPlayer && this.hud.qualitySelector) {
          const tracks = this.shakaPlayer.getVariantTracks();
          if (tracks && tracks.length > 0) {
            this.hud.qualitySelector.innerHTML = '<option value="-1">Auto Quality</option>';
            const seenHeights = new Set();

            tracks.forEach(t => {
              if (t.height && !seenHeights.has(t.height)) {
                seenHeights.add(t.height);
                const opt = document.createElement('option');
                opt.value = t.height;
                opt.textContent = `${t.height}p (${Math.round(t.bandwidth / 1000)} kbps)`;
                if (t.active) opt.selected = true;
                this.hud.qualitySelector.appendChild(opt);
              }
            });

            this.hud.qualitySelector.onchange = (e) => {
              const targetH = parseInt(e.target.value);
              if (targetH === -1) {
                this.shakaPlayer.configure({ abr: { enabled: true } });
              } else {
                this.shakaPlayer.configure({ abr: { enabled: false } });
                const chosen = tracks.find(t => t.height === targetH);
                if (chosen) this.shakaPlayer.selectVariantTrack(chosen, true);
              }
            };
          }
        }
        this.updateAudioUI();
      } catch (e) {
        console.warn('[NemoPlayer] Could not update tracks UI:', e);
      }
    }

    formatLanguageName(code) {
      if (!code) return 'Default';
      const c = code.toLowerCase().trim();
      const map = {
        'en': 'English',
        'eng': 'English',
        'ml': 'Malayalam',
        'mal': 'Malayalam',
        'hi': 'Hindi',
        'hin': 'Hindi',
        'ta': 'Tamil',
        'tam': 'Tamil',
        'te': 'Telugu',
        'tel': 'Telugu',
        'kn': 'Kannada',
        'kan': 'Kannada',
        'bn': 'Bengali',
        'ben': 'Bengali',
        'mr': 'Marathi',
        'mar': 'Marathi',
        'gu': 'Gujarati',
        'guj': 'Gujarati',
        'pa': 'Punjabi',
        'pan': 'Punjabi',
        'or': 'Odia',
        'ori': 'Odia',
        'ur': 'Urdu',
        'urd': 'Urdu',
        'und': 'Original Audio'
      };
      return map[c] || code.toUpperCase();
    }

    getAvailableAudioTracks() {
      if (this.shakaPlayer) {
        try {
          const languages = this.shakaPlayer.getAudioLanguages();
          if (!languages || languages.length === 0) return [];
          const currentTracks = this.shakaPlayer.getVariantTracks().filter(t => t.active);
          const currentLang = currentTracks.length > 0 ? currentTracks[0].language : languages[0];

          return languages.map(lang => ({
            id: lang,
            label: this.formatLanguageName(lang),
            lang: lang,
            active: lang === currentLang
          }));
        } catch (e) {
          console.warn('[NemoPlayer] Error getting Shaka audio tracks:', e);
        }
      } else if (this.hlsPlayer && this.hlsPlayer.audioTracks && this.hlsPlayer.audioTracks.length > 0) {
        try {
          return this.hlsPlayer.audioTracks.map((t, idx) => ({
            id: idx,
            label: t.name || this.formatLanguageName(t.lang),
            lang: t.lang || '',
            active: idx === this.hlsPlayer.audioTrack
          }));
        } catch (e) {}
      }
      return [];
    }

    selectAudioTrack(trackIdOrLang) {
      if (this.shakaPlayer) {
        try {
          this.shakaPlayer.selectAudioLanguage(trackIdOrLang);
          const label = this.formatLanguageName(trackIdOrLang);
          console.log(`[NemoPlayer] Switched Shaka audio to: ${label} (${trackIdOrLang})`);
          this.showStatusBanner(`🔊 Audio Feed: ${label}`, 'info');
          this.updateAudioUI();
          return true;
        } catch (e) {
          console.warn('[NemoPlayer] Failed to switch Shaka audio:', e);
        }
      } else if (this.hlsPlayer && (typeof trackIdOrLang === 'number' || !isNaN(parseInt(trackIdOrLang)))) {
        try {
          const idx = parseInt(trackIdOrLang);
          this.hlsPlayer.audioTrack = idx;
          const t = this.hlsPlayer.audioTracks[idx];
          const label = t ? (t.name || this.formatLanguageName(t.lang)) : `Track ${idx + 1}`;
          console.log(`[NemoPlayer] Switched HLS audio to: ${label}`);
          this.showStatusBanner(`🔊 Audio Feed: ${label}`, 'info');
          this.updateAudioUI();
          return true;
        } catch (e) {
          console.warn('[NemoPlayer] Failed to switch HLS audio:', e);
        }
      }
      return false;
    }

    cycleAudioTrack() {
      const tracks = this.getAvailableAudioTracks();
      if (!tracks || tracks.length <= 1) {
        this.showStatusBanner('ℹ️ Single Audio Track Active', 'info');
        return;
      }
      const curIdx = tracks.findIndex(t => t.active);
      const nextIdx = (curIdx + 1) % tracks.length;
      const nextTrack = tracks[nextIdx];
      this.selectAudioTrack(nextTrack.id);
    }

    updateAudioUI() {
      const tracks = this.getAvailableAudioTracks();
      const hasMultiAudio = tracks.length > 1;
      const activeTrack = tracks.find(t => t.active) || tracks[0];
      const activeLabel = activeTrack ? activeTrack.label : 'Stereo';

      // 1. Update STB banner audio badge
      const stbAudioBtn = document.getElementById('stb-audio-btn');
      if (stbAudioBtn) {
        if (hasMultiAudio) {
          stbAudioBtn.textContent = `🔊 ${activeLabel.toUpperCase()} [${tracks.length} FEEDS]`;
          stbAudioBtn.classList.add('has-multi');
        } else {
          stbAudioBtn.textContent = `🔊 ${activeLabel.toUpperCase()}`;
          stbAudioBtn.classList.remove('has-multi');
        }
      }

      // 2. Update Mini-EPG drawer audio button
      const miniEpgAudioBtn = document.getElementById('mini-epg-audio-btn');
      if (miniEpgAudioBtn) {
        if (hasMultiAudio) {
          miniEpgAudioBtn.classList.remove('hidden');
          miniEpgAudioBtn.textContent = `🔊 Audio: ${activeLabel} (${tracks.length} Feeds • Click/🟡 to Cycle)`;
        } else {
          miniEpgAudioBtn.classList.add('hidden');
        }
      }

      // 3. Update HUD dropdown
      if (this.hud.audioSelector) {
        if (hasMultiAudio) {
          this.hud.audioSelector.classList.remove('hidden');
          this.hud.audioSelector.innerHTML = '';
          tracks.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `🔊 ${t.label}`;
            if (t.active) opt.selected = true;
            this.hud.audioSelector.appendChild(opt);
          });
          this.hud.audioSelector.onchange = (e) => {
            this.selectAudioTrack(e.target.value);
          };
        } else {
          this.hud.audioSelector.classList.add('hidden');
        }
      }
    }

    setChannelList(channels) {
      this.channelList = channels || [];
    }

    nextChannel() {
      if (!this.channelList || this.channelList.length === 0 || !this.currentChannel) return;
      const idx = this.channelList.findIndex(c => c.id === this.currentChannel.id);
      const nextIdx = (idx + 1) % this.channelList.length;
      this.switchChannelWithDebounce(this.channelList[nextIdx]);
    }

    prevChannel() {
      if (!this.channelList || this.channelList.length === 0 || !this.currentChannel) return;
      const idx = this.channelList.findIndex(c => c.id === this.currentChannel.id);
      const prevIdx = (idx - 1 + this.channelList.length) % this.channelList.length;
      this.switchChannelWithDebounce(this.channelList[prevIdx]);
    }

    switchChannelWithDebounce(channel) {
      if (!channel) return;
      this.currentChannel = channel;
      this.currentSourceIndex = 0;
      this.isSwitching = false;

      // Pause old audio immediately so user hears instant transition
      try { this.video.pause(); } catch (_) {}

      // Show loader animation immediately
      this.showLoader(channel, 'Zapping to ' + channel.name + '...');

      // Update STB broadcast banner instantly for smooth UI feedback
      if (typeof window.showStbBanner === 'function') {
        window.showStbBanner(channel);
      }

      // Debounce the heavy manifest fetching by 300ms
      clearTimeout(this._zapDebounceTimer);
      this._zapDebounceTimer = setTimeout(async () => {
        await this.loadCurrentSource();
      }, 300);
    }
  }

  return NemoPlayer;
});
