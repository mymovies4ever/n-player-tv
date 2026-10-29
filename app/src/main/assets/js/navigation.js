/**
 * Nemo TV — Spatial Navigation & LG Remote Controller
 * Structured Zone Navigation (Header, Categories, Languages, Channel Grid, Player/STB)
 * Completely eliminates erratic diagonal "zip zap" jumps.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NavigationManager = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const KEY_LEFT = 37;
  const KEY_UP = 38;
  const KEY_RIGHT = 39;
  const KEY_DOWN = 40;
  const KEY_ENTER = 13;
  const KEY_BACK = 461;    // webOS remote Back
  const KEY_ESC = 27;      // PC browser escape
  const KEY_BACKSPACE = 8; // PC / Keyboard Backspace
  const KEY_TIZEN_BACK = 10009; // Alternative Return key
  const KEY_CH_UP = 33;    // PageUp / webOS Channel Up
  const KEY_CH_DOWN = 34;  // PageDown / webOS Channel Down
  const KEY_WEBOS_CH_UP = 427;   // Dedicated LG webOS Channel Up
  const KEY_WEBOS_CH_DOWN = 428; // Dedicated LG webOS Channel Down
  const KEY_RED = 403;
  const KEY_GREEN = 404;
  const KEY_YELLOW = 405;
  const KEY_BLUE = 406;
  const KEY_A = 65;

  class NavigationManager {
    constructor() {
      this.currentFocusElement = null;
      this.lastFocusedCard = null;
      this.onBackCallbacks = [];
      this.onChannelChangeCallback = null;
      this.onToggleOsdCallback = null;
      this.onDirectChannelTuneCallback = null;
      this.channelDigitBuffer = '';
      this.channelDigitTimer = null;
      this._lastBackPressTime = 0;
      this._backPressCount = 0;
      this._exitToastTimer = null;
      this.setupGlobalKeyListeners();
    }

    onBack(callback) {
      if (typeof callback === 'function') {
        this.onBackCallbacks.push(callback);
      }
    }

    onChannelChange(callback) {
      this.onChannelChangeCallback = callback;
    }

    onToggleOsd(callback) {
      this.onToggleOsdCallback = callback;
    }

    onDirectChannelTune(callback) {
      this.onDirectChannelTuneCallback = callback;
    }

    isChannelDigitInputActive() {
      return this.channelDigitBuffer.length > 0;
    }

    handleChannelDigitInput(digit) {
      if (this.channelDigitBuffer.length >= 4) {
        this.channelDigitBuffer = '';
      }
      this.channelDigitBuffer += String(digit);
      this.showChannelDigitOsd();

      clearTimeout(this.channelDigitTimer);
      this.channelDigitTimer = setTimeout(() => {
        this.commitChannelDigitInput();
      }, 1400);
    }

    showChannelDigitOsd() {
      const osd = document.getElementById('channel-number-osd');
      const elDisplay = document.getElementById('channel-digit-display');
      const elMatch = document.getElementById('channel-digit-match');
      if (!osd || !elDisplay || !elMatch) return;

      const num = parseInt(this.channelDigitBuffer, 10);
      elDisplay.textContent = this.channelDigitBuffer;

      // Real-time fleet lookup
      const channels = (window.channelManager && window.channelManager.channels) || [];
      const match = channels.find(c => c.channelNumber === num);
      if (match) {
        elMatch.textContent = match.name;
        elMatch.classList.remove('not-found');
      } else {
        elMatch.textContent = `Tuning to #${num}...`;
        elMatch.classList.remove('not-found');
      }

      osd.classList.remove('hidden');
    }

    commitChannelDigitInput() {
      clearTimeout(this.channelDigitTimer);
      if (!this.channelDigitBuffer) return;

      const num = parseInt(this.channelDigitBuffer, 10);
      const osd = document.getElementById('channel-number-osd');
      const elMatch = document.getElementById('channel-digit-match');

      const channels = (window.channelManager && window.channelManager.channels) || [];
      const match = channels.find(c => c.channelNumber === num);

      this.channelDigitBuffer = '';

      if (match) {
        if (osd) osd.classList.add('hidden');
        if (this.onDirectChannelTuneCallback) {
          this.onDirectChannelTuneCallback(match);
        }
      } else {
        if (elMatch) {
          elMatch.textContent = `⚠️ Channel #${num} not found`;
          elMatch.classList.add('not-found');
        }
        setTimeout(() => {
          if (osd) osd.classList.add('hidden');
        }, 1200);
      }
    }

    cancelChannelDigitInput() {
      clearTimeout(this.channelDigitTimer);
      this.channelDigitBuffer = '';
      const osd = document.getElementById('channel-number-osd');
      if (osd) osd.classList.add('hidden');
    }

    isPlayerOpen() {
      const playerView = document.getElementById('player-view');
      return (playerView && !playerView.classList.contains('hidden')) || document.body.classList.contains('player-mode');
    }

    showExitToast() {
      let toast = document.getElementById('exit-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'exit-toast';
        toast.className = 'exit-toast';
        toast.innerHTML = '<span>Press <b>Back</b> again to exit Nemo TV</span>';
        document.body.appendChild(toast);
      }
      toast.classList.add('show');
      clearTimeout(this._exitToastTimer);
      this._exitToastTimer = setTimeout(() => {
        toast.classList.remove('show');
        this._backPressCount = 0;
      }, 2500);
    }

    setupGlobalKeyListeners() {
      window.addEventListener('keydown', (e) => {
        const keyCode = e.keyCode || e.which;

        // 0. Direct Channel Number Keypad Input (0-9: standard 48-57, numpad 96-105)
        const isDigit = (keyCode >= 48 && keyCode <= 57) || (keyCode >= 96 && keyCode <= 105);
        if (isDigit) {
          e.preventDefault();
          const digit = keyCode >= 96 ? (keyCode - 96) : (keyCode - 48);
          this.handleChannelDigitInput(digit);
          return;
        }

        // If actively typing channel number and user presses OK/Enter: commit immediately!
        if (this.isChannelDigitInputActive() && keyCode === KEY_ENTER) {
          e.preventDefault();
          this.commitChannelDigitInput();
          return;
        }

        // If actively typing channel number and user presses Back/Esc: cancel!
        if (this.isChannelDigitInputActive() && (keyCode === KEY_BACK || keyCode === KEY_ESC || keyCode === KEY_BACKSPACE || keyCode === KEY_TIZEN_BACK)) {
          e.preventDefault();
          this.cancelChannelDigitInput();
          return;
        }

        // 1. Back button handling (webOS 461, Esc 27, Backspace 8, Return 10009)
        if (keyCode === KEY_BACK || keyCode === KEY_ESC || keyCode === KEY_BACKSPACE || keyCode === KEY_TIZEN_BACK) {
          e.preventDefault();
          e.stopPropagation();
          let handled = false;
          for (const cb of this.onBackCallbacks) {
            if (cb()) {
              handled = true;
              break;
            }
          }
          if (!handled) {
            // Home screen: double-press Back within 2.5s cleanly closes the app (NEVER reloads!)
            const now = Date.now();
            if (this._backPressCount === 1 && (now - this._lastBackPressTime < 2500)) {
              if (window.AndroidNative && typeof window.AndroidNative.exitApp === 'function') {
                window.AndroidNative.exitApp();
                return;
              }
              if (window.close) {
                window.close();
              }
              return;
            }
            this._backPressCount = 1;
            this._lastBackPressTime = now;
            this.showExitToast();
          }
          return;
        }

        // 2. Player-Dedicated Mode (When fullscreen video / player is active)
        if (this.isPlayerOpen()) {
          this.handlePlayerKeys(keyCode, e);
          return;
        }

        // 3. Grid / Menu D-Pad Directional Navigation
        if ([KEY_LEFT, KEY_UP, KEY_RIGHT, KEY_DOWN].includes(keyCode)) {
          this.handleDirectionalMove(keyCode, e);
          return;
        }

        // 4. OK / Enter selection
        if (keyCode === KEY_ENTER) {
          if (this.currentFocusElement) {
            e.preventDefault();
            this.currentFocusElement.click();
          }
        }
      });
    }

    handlePlayerKeys(keyCode, e) {
      const miniDrawer = document.getElementById('mini-epg-drawer');
      const isMiniEpgOpen = miniDrawer && !miniDrawer.classList.contains('hidden');

      // 1. Next Channel (Dedicated CH ▲ or D-Pad UP arrow when drawer closed)
      if (keyCode === KEY_CH_UP || keyCode === KEY_WEBOS_CH_UP || (!isMiniEpgOpen && keyCode === KEY_UP)) {
        e.preventDefault();
        if (this.onChannelChangeCallback) {
          this.onChannelChangeCallback('next');
        }
        return;
      }

      // 2. Previous Channel (Dedicated CH ▼ or D-Pad DOWN arrow when drawer closed)
      if (keyCode === KEY_CH_DOWN || keyCode === KEY_WEBOS_CH_DOWN || (!isMiniEpgOpen && keyCode === KEY_DOWN)) {
        e.preventDefault();
        if (this.onChannelChangeCallback) {
          this.onChannelChangeCallback('prev');
        }
        return;
      }

      // 3. When Mini-EPG drawer is open: UP or DOWN closes the drawer cleanly
      if (isMiniEpgOpen && (keyCode === KEY_UP || keyCode === KEY_DOWN)) {
        e.preventDefault();
        if (typeof window.toggleMiniEpg === 'function') {
          window.toggleMiniEpg(false);
        }
        return;
      }

      // 4. Left Arrow (37) & Right Arrow (39)
      if (keyCode === KEY_LEFT || keyCode === KEY_RIGHT) {
        e.preventDefault();
        if (isMiniEpgOpen) {
          const items = Array.from(miniDrawer.querySelectorAll('.mini-epg-item'));
          const curIdx = items.findIndex(el => el.classList.contains('tv-focused') || el === document.activeElement);
          if (items.length > 0) {
            let nextIdx = curIdx >= 0 ? curIdx : 0;
            if (keyCode === KEY_LEFT) nextIdx = Math.max(0, curIdx - 1);
            if (keyCode === KEY_RIGHT) nextIdx = Math.min(items.length - 1, curIdx + 1);
            if (items[nextIdx]) {
              this.setFocus(items[nextIdx]);
              items[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              if (items[nextIdx]._channelData && typeof window.updateMiniEpgFocusPreview === 'function') {
                window.updateMiniEpgFocusPreview(items[nextIdx]._channelData, items[nextIdx]);
              }
            }
          }
        } else {
          // Open Mini-EPG channel drawer for visual horizontal browsing
          if (typeof window.toggleMiniEpg === 'function') {
            window.toggleMiniEpg(true);
          }
        }
        return;
      }

      // 5. OK / Enter Button (13):
      if (keyCode === KEY_ENTER) {
        e.preventDefault();
        if (isMiniEpgOpen) {
          const focused = miniDrawer.querySelector('.mini-epg-item.tv-focused') ||
                          (document.activeElement && document.activeElement.classList.contains('mini-epg-item') ? document.activeElement : null);
          if (focused) {
            focused.click();
            return;
          }
        } else {
          // Live playback: OK button opens the quick channel selector drawer!
          if (typeof window.toggleMiniEpg === 'function') {
            window.toggleMiniEpg(true);
            return;
          }
        }
        return;
      }

      // 6. Audio Track Cycling (Remote Yellow 405, Blue 406, or Keyboard 'A' 65)
      if (keyCode === KEY_YELLOW || keyCode === KEY_BLUE || keyCode === KEY_A) {
        e.preventDefault();
        if (window.nemoPlayer && typeof window.nemoPlayer.cycleAudioTrack === 'function') {
          window.nemoPlayer.cycleAudioTrack();
        }
        return;
      }

      // 7. Red Key (403) toggles STB info banner
      if (keyCode === KEY_RED) {
        e.preventDefault();
        if (typeof window.toggleStbBanner === 'function') {
          window.toggleStbBanner();
        }
        return;
      }
    }

    setFocus(element) {
      if (!element) return;
      if (this.currentFocusElement && this.currentFocusElement !== element) {
        this.currentFocusElement.classList.remove('tv-focused');
      }
      this.currentFocusElement = element;
      element.classList.add('tv-focused');
      element.focus();

      // Zero-latency instant scroll on webOS TV hardware
      element.scrollIntoView({ behavior: 'auto', block: 'nearest' });

      if (element.classList.contains('channel-card')) {
        this.lastFocusedCard = element;
      }
    }

    restoreLastCardFocus() {
      if (this.lastFocusedCard && document.body.contains(this.lastFocusedCard)) {
        this.setFocus(this.lastFocusedCard);
      } else {
        const first = document.querySelector('.channel-card');
        if (first) this.setFocus(first);
      }
    }

    handleDirectionalMove(keyCode, e) {
      if (!this.currentFocusElement || !document.body.contains(this.currentFocusElement)) {
        const firstCard = document.querySelector('.channel-card') || document.querySelector('.category-chip');
        if (firstCard) this.setFocus(firstCard);
        return;
      }

      const cur = this.currentFocusElement;

      // =========================================================================
      // ZONE 1: Category Chips Bar (Horizontal Scroll)
      // =========================================================================
      if (cur.classList.contains('category-chip')) {
        const chips = Array.from(document.querySelectorAll('.category-chip'));
        const idx = chips.indexOf(cur);

        if (keyCode === KEY_LEFT) {
          e.preventDefault();
          if (idx > 0) this.setFocus(chips[idx - 1]);
          return;
        }
        if (keyCode === KEY_RIGHT) {
          e.preventDefault();
          if (idx < chips.length - 1) this.setFocus(chips[idx + 1]);
          return;
        }
        if (keyCode === KEY_DOWN) {
          e.preventDefault();
          // Move down to active language chip or first language chip
          const lang = document.querySelector('.language-chip.active') || document.querySelector('.language-chip');
          if (lang) {
            this.setFocus(lang);
          } else {
            const firstCard = document.querySelector('.channel-card');
            if (firstCard) this.setFocus(firstCard);
          }
          return;
        }
        if (keyCode === KEY_UP) {
          e.preventDefault();
          // Move up to section switcher
          const activeSec = document.querySelector('.section-btn.active') || document.querySelector('.section-btn');
          if (activeSec) this.setFocus(activeSec);
          return;
        }
      }

      // =========================================================================
      // ZONE 2: Language Chips Bar (Horizontal Scroll)
      // =========================================================================
      if (cur.classList.contains('language-chip')) {
        const chips = Array.from(document.querySelectorAll('.language-chip'));
        const idx = chips.indexOf(cur);

        if (keyCode === KEY_LEFT) {
          e.preventDefault();
          if (idx > 0) this.setFocus(chips[idx - 1]);
          return;
        }
        if (keyCode === KEY_RIGHT) {
          e.preventDefault();
          if (idx < chips.length - 1) this.setFocus(chips[idx + 1]);
          return;
        }
        if (keyCode === KEY_UP) {
          e.preventDefault();
          // Move up to active category chip
          const cat = document.querySelector('.category-chip.active') || document.querySelector('.category-chip');
          if (cat) this.setFocus(cat);
          return;
        }
        if (keyCode === KEY_DOWN) {
          e.preventDefault();
          // Move down to channel grid
          const firstCard = document.querySelector('.channel-card');
          if (firstCard) this.setFocus(firstCard);
          return;
        }
      }

      // =========================================================================
      // ZONE 3: Channel Cards Grid (Strict Grid Matrix: 5 columns live, 6 columns VOD)
      // =========================================================================
      if (cur.classList.contains('channel-card')) {
        const cards = Array.from(document.querySelectorAll('.channel-card'));
        const idx = cards.indexOf(cur);
        if (idx === -1) return;

        // Detect number of columns dynamically (default 5 for live TV, 6 for VOD)
        const isVod = document.getElementById('channel-grid').classList.contains('vod-mode');
        const cols = isVod ? 6 : 5;

        if (keyCode === KEY_LEFT) {
          e.preventDefault();
          if (idx > 0) {
            this.setFocus(cards[idx - 1]);
          }
          return;
        }
        if (keyCode === KEY_RIGHT) {
          e.preventDefault();
          if (idx >= cards.length - 4 && typeof window.loadMoreCards === 'function') {
            window.loadMoreCards();
          }
          const updatedCards = Array.from(document.querySelectorAll('.channel-card'));
          if (idx < updatedCards.length - 1) {
            this.setFocus(updatedCards[idx + 1]);
          }
          return;
        }
        if (keyCode === KEY_UP) {
          e.preventDefault();
          if (idx >= cols) {
            // Move up one exact row
            this.setFocus(cards[idx - cols]);
          } else {
            // Move up from top row into Language bar
            const lang = document.querySelector('.language-chip.active') || document.querySelector('.language-chip');
            if (lang) {
              this.setFocus(lang);
            } else {
              const cat = document.querySelector('.category-chip.active') || document.querySelector('.category-chip');
              if (cat) this.setFocus(cat);
            }
          }
          return;
        }
        if (keyCode === KEY_DOWN) {
          e.preventDefault();
          // Load next batch if approaching bottom of rendered cards
          if (idx + cols >= cards.length - 8 && typeof window.loadMoreCards === 'function') {
            window.loadMoreCards();
          }
          const updatedCards = Array.from(document.querySelectorAll('.channel-card'));
          if (idx + cols < updatedCards.length) {
            // Move down one exact row
            this.setFocus(updatedCards[idx + cols]);
          } else if (idx < updatedCards.length - 1) {
            // Focus last card if in final partial row
            this.setFocus(updatedCards[updatedCards.length - 1]);
          }
          return;
        }
      }

      // =========================================================================
      // ZONE 0: Header Controls (Section Switcher, Search, Sync)
      // =========================================================================
      if (cur.classList.contains('section-btn')) {
        const secBtns = Array.from(document.querySelectorAll('.section-btn'));
        const idx = secBtns.indexOf(cur);

        if (keyCode === KEY_LEFT) {
          e.preventDefault();
          if (idx > 0) this.setFocus(secBtns[idx - 1]);
          return;
        }
        if (keyCode === KEY_RIGHT) {
          e.preventDefault();
          if (idx < secBtns.length - 1) {
            this.setFocus(secBtns[idx + 1]);
          } else {
            const search = document.getElementById('search-input');
            if (search) this.setFocus(search);
          }
          return;
        }
        if (keyCode === KEY_DOWN) {
          e.preventDefault();
          const cat = document.querySelector('.category-chip.active') || document.querySelector('.category-chip');
          if (cat) this.setFocus(cat);
          return;
        }
      }

      if (cur.id === 'search-input') {
        if (keyCode === KEY_LEFT) {
          e.preventDefault();
          const secBtns = Array.from(document.querySelectorAll('.section-btn'));
          if (secBtns.length > 0) this.setFocus(secBtns[secBtns.length - 1]);
          return;
        }
        if (keyCode === KEY_RIGHT) {
          e.preventDefault();
          const btnSync = document.getElementById('btn-sync');
          if (btnSync) this.setFocus(btnSync);
          return;
        }
        if (keyCode === KEY_DOWN) {
          e.preventDefault();
          const cat = document.querySelector('.category-chip.active') || document.querySelector('.category-chip');
          if (cat) this.setFocus(cat);
          return;
        }
      }

      if (cur.id === 'btn-sync') {
        if (keyCode === KEY_LEFT) {
          e.preventDefault();
          const search = document.getElementById('search-input');
          if (search) this.setFocus(search);
          return;
        }
        if (keyCode === KEY_DOWN) {
          e.preventDefault();
          const cat = document.querySelector('.category-chip.active') || document.querySelector('.category-chip');
          if (cat) this.setFocus(cat);
          return;
        }
      }
    }
  }

  return NavigationManager;
});
