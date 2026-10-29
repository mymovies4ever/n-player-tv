/**
 * Nemo TV — High-Performance M3U/M3U8 Parser
 * Supports IPTV metadata: #EXTINF, #KODIPROP, #EXTVLCOPT, #EXTHTTP, DRM, and Header injection
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.M3UParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  function parseAttributes(attrString) {
    const attrs = {};
    const regex = /([a-zA-Z0-9_-]+)=["']([^"']*)["']|([a-zA-Z0-9_-]+)=([^ "']+)/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
      const key = (match[1] || match[3] || '').toLowerCase();
      const val = match[2] || match[4] || '';
      attrs[key] = val.trim();
    }
    return attrs;
  }

  function parseM3U(content, sourcePlaylistName) {
    if (!content || typeof content !== 'string') return [];

    const lines = content.split(/\r?\n/);
    const channels = [];

    let currentChannel = null;
    let currentKodiProps = {};
    let currentVlcOpts = {};
    let currentHttp = {};

    function resetCurrentProps() {
      currentChannel = null;
      currentKodiProps = {};
      currentVlcOpts = {};
      currentHttp = {};
    }

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        // Parse #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",Channel Name
        const commaIdx = line.indexOf(',');
        let metaPart = line.substring(8);
        let title = '';

        if (commaIdx !== -1) {
          metaPart = line.substring(8, commaIdx).trim();
          title = line.substring(commaIdx + 1).trim();
        }

        const attrs = parseAttributes(metaPart);
        const name = attrs['tvg-name'] || title || 'Unknown Channel';
        const tvgId = attrs['tvg-id'] || attrs['tvg-name'] || name;
        const logo = attrs['tvg-logo'] || '';
        const group = attrs['group-title'] || attrs['group'] || 'General';
        const language = attrs['tvg-language'] || '';

        currentChannel = {
          name: name.replace(/\s+/g, ' ').trim(),
          title: title || name,
          tvgId: tvgId.trim(),
          logo: logo.trim(),
          group: group.trim() || 'General',
          language: language.trim(),
          sourcePlaylist: sourcePlaylistName || 'Default'
        };
      } else if (line.startsWith('#KODIPROP:')) {
        const propStr = line.substring(10).trim();
        const eqIdx = propStr.indexOf('=');
        if (eqIdx !== -1) {
          const propKey = propStr.substring(0, eqIdx).trim();
          const propVal = propStr.substring(eqIdx + 1).trim();
          currentKodiProps[propKey] = propVal;
        }
      } else if (line.startsWith('#EXTVLCOPT:')) {
        const optStr = line.substring(11).trim();
        const eqIdx = optStr.indexOf('=');
        if (eqIdx !== -1) {
          const optKey = optStr.substring(0, eqIdx).trim().toLowerCase();
          const optVal = optStr.substring(eqIdx + 1).trim();
          currentVlcOpts[optKey] = optVal;
        }
      } else if (line.startsWith('#EXTHTTP:')) {
        const jsonStr = line.substring(9).trim();
        try {
          const parsed = JSON.parse(jsonStr);
          Object.assign(currentHttp, parsed);
        } catch (e) {
          // ignore malformed json
        }
      } else if (!line.startsWith('#')) {
        // Stream URL line: only accept genuine HTTP/HTTPS stream URLs
        if (currentChannel) {
          let streamUrl = line.trim();

          // Reject corrupt HTML lines, script tags, or non-HTTP entries
          if (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://')) {
            continue;
          }
          if (streamUrl.startsWith('<') || streamUrl.includes('<script') || streamUrl.includes('pastefy.app')) {
            continue;
          }

          const headers = {};

          // Extract pipe syntax headers if present (e.g. url|User-Agent=...&Cookie=...)
          const pipeIdx = streamUrl.indexOf('|');
          if (pipeIdx !== -1) {
            const rawHeaders = streamUrl.substring(pipeIdx + 1);
            streamUrl = streamUrl.substring(0, pipeIdx);
            const pairs = rawHeaders.split('&');
            for (const pair of pairs) {
              const eq = pair.indexOf('=');
              if (eq !== -1) {
                const hName = pair.substring(0, eq).trim();
                const hVal = pair.substring(eq + 1).trim();
                headers[hName] = hVal;
              }
            }
          }
          streamUrl = streamUrl.replace(/[?&]$/, '').trim();

          // Merge VLC opts
          if (currentVlcOpts['http-user-agent']) {
            headers['User-Agent'] = currentVlcOpts['http-user-agent'];
          }
          if (currentVlcOpts['http-referrer']) {
            headers['Referer'] = currentVlcOpts['http-referrer'];
          }

          // Merge #EXTHTTP opts
          if (currentHttp['User-Agent'] || currentHttp['user-agent']) {
            headers['User-Agent'] = currentHttp['User-Agent'] || currentHttp['user-agent'];
          }
          if (currentHttp['Referer'] || currentHttp['referer']) {
            headers['Referer'] = currentHttp['Referer'] || currentHttp['referer'];
          }
          if (currentHttp['Origin'] || currentHttp['origin']) {
            headers['Origin'] = currentHttp['Origin'] || currentHttp['origin'];
          }
          if (currentHttp['Cookie'] || currentHttp['cookie']) {
            headers['Cookie'] = currentHttp['Cookie'] || currentHttp['cookie'];
          }

          // DRM Resolution
          let drm = null;
          const licenseType = (currentKodiProps['inputstream.adaptive.license_type'] || '').toLowerCase();
          const licenseKey = currentKodiProps['inputstream.adaptive.license_key'] || '';

          if (licenseType === 'clearkey' || licenseKey) {
            drm = {
              type: 'clearkey',
              key: licenseKey
            };
          } else if (licenseType === 'widevine') {
            drm = {
              type: 'widevine',
              server: licenseKey
            };
          }

          // Manifest Type
          let manifestType = (currentKodiProps['inputstream.adaptive.manifest_type'] || '').toLowerCase();
          if (!manifestType) {
            const cleanUrl = streamUrl.toLowerCase().split('?')[0];
            if (cleanUrl.endsWith('.mpd')) {
              manifestType = 'mpd';
            } else if (cleanUrl.endsWith('.m3u8')) {
              manifestType = 'hls';
            }
          }

          // Ensure Akamai CDN token from Cookie is in query string for CORS compatibility
          const cookieVal = headers['Cookie'] || headers['cookie'] || '';
          if (cookieVal && cookieVal.includes('__hdnea__=') && !streamUrl.includes('__hdnea__=')) {
            const m = cookieVal.match(/__hdnea__=[^;,\s]+/);
            if (m) {
              const sep = streamUrl.includes('?') ? '&' : '?';
              streamUrl = streamUrl + sep + m[0];
            }
          }

          currentChannel.url = streamUrl;
          currentChannel.manifestType = manifestType || 'auto';
          currentChannel.drm = drm;
          currentChannel.headers = headers;

          channels.push(currentChannel);
          resetCurrentProps();
        }
      }
    }

    return channels;
  }

  return {
    parse: parseM3U
  };
});
