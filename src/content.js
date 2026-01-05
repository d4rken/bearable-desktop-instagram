// Bearable Desktop Instagram - Content Script
// Adds custom video controls and timestamp persistence for comment navigation

(function() {
  'use strict';

  // ============================================================
  // CONFIGURATION
  // ============================================================
  const CONFIG = {
    DEBUG: false,                    // Set to true to enable console logging
    SEEK_SECONDS: 10,                // Seconds to skip with arrow keys
    SEEK_END_BUFFER: 0.5,            // Buffer from end when restoring timestamp
    CONTAINER_SEARCH_MAX_DEPTH: 10,  // Max parent levels to search for video container
    SCAN_DEBOUNCE_MS: 100,           // Debounce delay for video scanning
    NAVIGATION_SCAN_DELAY_MS: 500,   // Delay before scanning after navigation
  };

  function debug(...args) {
    if (CONFIG.DEBUG) {
      console.log('[IG Enhancer]', ...args);
    }
  }

  // ============================================================
  // TIMESTAMP STORE - Persists video position for comment navigation
  // ============================================================
  const TimestampStore = {
    timestamps: new Map(),

    save(postId, currentTime) {
      if (postId && currentTime > 0) {
        this.timestamps.set(postId, currentTime);
        // Also save to session storage for cross-navigation persistence
        try {
          chrome.storage.session.set({ [`ts_${postId}`]: currentTime });
        } catch (e) {
          // Fallback if session storage unavailable
          sessionStorage.setItem(`ig_ts_${postId}`, currentTime.toString());
        }
        debug('Saved timestamp for', postId, ':', currentTime);
      }
    },

    async get(postId) {
      if (!postId) return null;

      // Check memory first
      if (this.timestamps.has(postId)) {
        const time = this.timestamps.get(postId);
        this.timestamps.delete(postId);
        debug('Restored timestamp for', postId, ':', time);
        return time;
      }

      // Check chrome storage
      try {
        const result = await chrome.storage.session.get(`ts_${postId}`);
        if (result[`ts_${postId}`]) {
          chrome.storage.session.remove(`ts_${postId}`);
          debug('Restored timestamp from storage for', postId, ':', result[`ts_${postId}`]);
          return result[`ts_${postId}`];
        }
      } catch (e) {
        // Fallback to sessionStorage
        const time = sessionStorage.getItem(`ig_ts_${postId}`);
        if (time) {
          sessionStorage.removeItem(`ig_ts_${postId}`);
          return parseFloat(time);
        }
      }

      return null;
    },

    clear(postId) {
      this.timestamps.delete(postId);
      try {
        chrome.storage.session.remove(`ts_${postId}`);
      } catch (e) {
        sessionStorage.removeItem(`ig_ts_${postId}`);
      }
    }
  };

  // ============================================================
  // PREFERENCES - Persists user preferences like mute state
  // ============================================================
  const Preferences = {
    _muted: true, // Instagram default is muted
    _volume: 1,

    get muted() {
      return this._muted;
    },

    set muted(value) {
      this._muted = value;
      try {
        sessionStorage.setItem('ig_enhancer_muted', value.toString());
      } catch (e) {}
    },

    get volume() {
      return this._volume;
    },

    set volume(value) {
      this._volume = value;
      try {
        sessionStorage.setItem('ig_enhancer_volume', value.toString());
      } catch (e) {}
    },

    load() {
      try {
        const muted = sessionStorage.getItem('ig_enhancer_muted');
        const volume = sessionStorage.getItem('ig_enhancer_volume');
        if (muted !== null) this._muted = muted === 'true';
        if (volume !== null) this._volume = parseFloat(volume);
      } catch (e) {}
    }
  };

  // Load preferences on init
  Preferences.load();

  // ============================================================
  // UTILITY FUNCTIONS
  // ============================================================

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function getPostId(element) {
    // Try to find post ID from various sources

    // Check URL first (works in modals and direct post pages)
    const urlMatch = window.location.pathname.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (urlMatch) return urlMatch[2];

    // Look for link in article
    const article = element.closest('article');
    if (article) {
      const link = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (link) {
        const match = link.href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (match) return match[2];
      }
    }

    // Try to find in any parent with a link
    let parent = element;
    while (parent && parent !== document.body) {
      const link = parent.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (link) {
        const match = link.href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
        if (match) return match[2];
      }
      parent = parent.parentElement;
    }

    return null;
  }

  function getVideoContainer(video) {
    // Check if we already wrapped this video
    if (video.parentElement?.classList.contains('ig-enhancer-wrapper')) {
      return video.parentElement;
    }

    // Create our own wrapper to avoid mutating Instagram's DOM
    const wrapper = document.createElement('div');
    wrapper.className = 'ig-enhancer-wrapper';
    wrapper.style.cssText = 'position: relative; width: 100%; height: 100%;';

    // Insert wrapper around video
    video.parentElement.insertBefore(wrapper, video);
    wrapper.appendChild(video);

    debug('Wrapped video in container');
    return wrapper;
  }

  // ============================================================
  // CONTROLS UI - Custom video controls overlay
  // ============================================================

  function createControlsOverlay(video) {
    const overlay = document.createElement('div');
    overlay.className = 'ig-enhancer-controls';
    overlay.innerHTML = `
      <div class="ig-enhancer-controls-inner">
        <button class="ig-enhancer-play-btn" aria-label="Play/Pause">
          <svg class="play-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
          <svg class="pause-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
        </button>
        <span class="ig-enhancer-time current">0:00</span>
        <div class="ig-enhancer-progress-container">
          <input type="range" class="ig-enhancer-progress" min="0" max="100" value="0" step="0.1">
          <div class="ig-enhancer-progress-bar">
            <div class="ig-enhancer-progress-filled"></div>
            <div class="ig-enhancer-progress-buffered"></div>
          </div>
        </div>
        <span class="ig-enhancer-time duration">0:00</span>
        <div class="ig-enhancer-volume-container">
          <button class="ig-enhancer-mute-btn" aria-label="Mute/Unmute">
            <svg class="volume-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
            <svg class="muted-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            </svg>
          </button>
          <input type="range" class="ig-enhancer-volume" min="0" max="1" value="1" step="0.05">
        </div>
        <div class="ig-enhancer-speed-container">
          <select class="ig-enhancer-speed">
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
        </div>
      </div>
    `;

    // Get elements
    const playBtn = overlay.querySelector('.ig-enhancer-play-btn');
    const progressInput = overlay.querySelector('.ig-enhancer-progress');
    const progressFilled = overlay.querySelector('.ig-enhancer-progress-filled');
    const currentTimeEl = overlay.querySelector('.ig-enhancer-time.current');
    const durationEl = overlay.querySelector('.ig-enhancer-time.duration');
    const muteBtn = overlay.querySelector('.ig-enhancer-mute-btn');
    const volumeInput = overlay.querySelector('.ig-enhancer-volume');
    const speedSelect = overlay.querySelector('.ig-enhancer-speed');

    // AbortController for cleanup of all event listeners
    const abortController = new AbortController();
    const { signal } = abortController;

    let isDragging = false;

    // Update play/pause button state
    function updatePlayState() {
      overlay.classList.toggle('is-playing', !video.paused);
    }

    // Update progress bar
    function updateProgress() {
      if (!isDragging && video.duration) {
        const percent = (video.currentTime / video.duration) * 100;
        progressInput.value = percent;
        progressFilled.style.width = `${percent}%`;
        currentTimeEl.textContent = formatTime(video.currentTime);
      }
    }

    // Update duration display
    function updateDuration() {
      durationEl.textContent = formatTime(video.duration);
      progressInput.max = 100;
    }

    // Update volume state
    function updateVolumeState() {
      overlay.classList.toggle('is-muted', video.muted || video.volume === 0);
      volumeInput.value = video.muted ? 0 : video.volume;
    }

    // Event listeners for video (with signal for cleanup)
    video.addEventListener('play', updatePlayState, { signal });
    video.addEventListener('pause', updatePlayState, { signal });
    video.addEventListener('timeupdate', updateProgress, { signal });
    video.addEventListener('loadedmetadata', updateDuration, { signal });
    video.addEventListener('durationchange', updateDuration, { signal });
    video.addEventListener('volumechange', updateVolumeState, { signal });

    // Play/pause button
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    }, { signal });

    // Progress bar
    progressInput.addEventListener('input', (e) => {
      isDragging = true;
      const percent = parseFloat(e.target.value);
      progressFilled.style.width = `${percent}%`;
      currentTimeEl.textContent = formatTime((percent / 100) * video.duration);
    }, { signal });

    progressInput.addEventListener('change', (e) => {
      const percent = parseFloat(e.target.value);
      video.currentTime = (percent / 100) * video.duration;
      isDragging = false;
    }, { signal });

    progressInput.addEventListener('mousedown', () => {
      isDragging = true;
    }, { signal });

    progressInput.addEventListener('mouseup', () => {
      isDragging = false;
    }, { signal });

    // Mute button
    muteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      video.muted = !video.muted;
      Preferences.muted = video.muted;
    }, { signal });

    // Volume slider
    volumeInput.addEventListener('input', (e) => {
      video.volume = parseFloat(e.target.value);
      video.muted = video.volume === 0;
      Preferences.volume = video.volume;
      Preferences.muted = video.muted;
    }, { signal });

    // Speed selector
    speedSelect.addEventListener('change', (e) => {
      video.playbackRate = parseFloat(e.target.value);
    }, { signal });

    // Prevent clicks from propagating to Instagram's handlers
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
    }, { signal });

    // Initial state
    updatePlayState();
    updateVolumeState();
    if (video.duration) updateDuration();

    // Attach abort controller to overlay for cleanup
    overlay._abortController = abortController;

    return overlay;
  }

  // ============================================================
  // VIDEO ENHANCER - Detects and enhances videos
  // ============================================================

  function enhanceVideo(video) {
    // Skip if already enhanced
    if (video.dataset.igEnhanced) return;
    video.dataset.igEnhanced = 'true';

    const container = getVideoContainer(video);
    if (!container) return;

    // Create and attach controls
    const controls = createControlsOverlay(video);
    container.appendChild(controls);

    // Apply saved preferences (mute state)
    if (!Preferences.muted) {
      // User previously unmuted, so unmute this video too
      video.muted = false;
      video.volume = Preferences.volume;
    }

    // Check for saved timestamp
    const postId = getPostId(video);
    debug('Enhancing video, postId:', postId);
    if (postId) {
      TimestampStore.get(postId).then(savedTime => {
        debug('Retrieved saved time for', postId, ':', savedTime);
        if (savedTime && savedTime > 0) {
          // Wait for video to be ready
          const seekToSaved = () => {
            if (video.readyState >= 1 && video.duration) {
              debug('Seeking to saved time:', savedTime);
              video.currentTime = Math.min(savedTime, video.duration - CONFIG.SEEK_END_BUFFER);
            } else {
              debug('Video not ready, waiting for loadedmetadata');
              video.addEventListener('loadedmetadata', () => {
                debug('Metadata loaded, seeking to:', savedTime);
                video.currentTime = Math.min(savedTime, video.duration - CONFIG.SEEK_END_BUFFER);
              }, { once: true });
            }
          };
          seekToSaved();
        }
      });
    }

    // Store cleanup function
    video._igEnhancerCleanup = () => {
      // Abort all event listeners
      if (controls._abortController) {
        controls._abortController.abort();
      }
      // Remove controls
      if (controls.parentNode) {
        controls.parentNode.removeChild(controls);
      }
      // Unwrap video from our wrapper
      const wrapper = video.parentElement;
      if (wrapper?.classList.contains('ig-enhancer-wrapper')) {
        wrapper.parentElement.insertBefore(video, wrapper);
        wrapper.remove();
      }
    };
  }

  function scanForVideos() {
    const videos = document.querySelectorAll('video:not([data-ig-enhanced])');
    videos.forEach(enhanceVideo);
  }

  // ============================================================
  // TIMESTAMP SAVING - Only save on actual navigation events
  // ============================================================

  // Debounce to avoid multiple saves
  let saveDebounceTimer = null;

  function saveAllVideoTimestamps() {
    // Debounce rapid calls
    if (saveDebounceTimer) return;
    saveDebounceTimer = setTimeout(() => {
      saveDebounceTimer = null;
    }, 500);

    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
      if (video.currentTime > 0) {
        const postId = getPostId(video);
        if (postId) {
          TimestampStore.save(postId, video.currentTime);
        }
      }
    });
  }

  function handleLinkClick(event) {
    const target = event.target;

    // Save timestamps when clicking a link that navigates to a post
    const link = target.closest('a[href*="/p/"], a[href*="/reel/"]');
    if (link) {
      debug('Link click detected, saving timestamps');
      saveAllVideoTimestamps();
      return;
    }

    // Also save when clicking in the action bar area of a post (likes, comments, share, save)
    // These buttons can trigger navigation to the post modal
    const article = target.closest('article');
    if (article?.querySelector('video')) {
      // Check if clicking on action buttons (comment icon, etc.)
      const isActionButton = target.closest('svg, button, [role="button"]');
      // Check for comment-related aria-labels
      const commentButton = target.closest('[aria-label*="Comment" i], [aria-label*="comment" i]');

      if (commentButton || isActionButton) {
        debug('Action button click in video post, saving timestamps');
        saveAllVideoTimestamps();
      }
    }
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  function init() {
    // Initial scan
    scanForVideos();

    // Single MutationObserver for both video detection and URL changes
    let lastUrl = location.href;
    const observer = new MutationObserver((mutations) => {
      // Check for URL change (SPA navigation)
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(scanForVideos, CONFIG.NAVIGATION_SCAN_DELAY_MS);
        return; // URL change will trigger a full scan, skip video detection
      }

      // Check for new video elements
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'VIDEO' || node.querySelector?.('video')) {
                shouldScan = true;
                break;
              }
            }
          }
        }
        if (shouldScan) break;
      }

      if (shouldScan) {
        // Debounce the scan
        clearTimeout(observer._scanTimeout);
        observer._scanTimeout = setTimeout(scanForVideos, CONFIG.SCAN_DEBOUNCE_MS);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Listen for link clicks that navigate to a post
    document.addEventListener('click', handleLinkClick, true);

    // Also listen to popstate for back/forward navigation
    window.addEventListener('popstate', () => {
      saveAllVideoTimestamps();
      setTimeout(scanForVideos, CONFIG.NAVIGATION_SCAN_DELAY_MS);
    });

    // Save timestamps before page unload
    window.addEventListener('beforeunload', saveAllVideoTimestamps);

    // Keyboard controls for video seeking
    document.addEventListener('keydown', (e) => {
      // Don't interfere with typing
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Find visible/playing video
        const videos = document.querySelectorAll('video');
        let activeVideo = null;

        for (const video of videos) {
          const rect = video.getBoundingClientRect();
          const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
          if (isVisible && !video.paused) {
            activeVideo = video;
            break;
          }
        }

        // Fallback: any visible video
        if (!activeVideo) {
          for (const video of videos) {
            const rect = video.getBoundingClientRect();
            const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
            if (isVisible) {
              activeVideo = video;
              break;
            }
          }
        }

        if (activeVideo && activeVideo.duration) {
          e.preventDefault();
          const skip = e.key === 'ArrowRight' ? CONFIG.SEEK_SECONDS : -CONFIG.SEEK_SECONDS;
          activeVideo.currentTime = Math.max(0, Math.min(activeVideo.duration, activeVideo.currentTime + skip));
        }
      }
    });
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
