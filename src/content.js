// Instagram Video Enhancer - Content Script
// Adds custom video controls and timestamp persistence for comment navigation

(function() {
  'use strict';

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
        console.log('[IG Enhancer] Saved timestamp for', postId, ':', currentTime);
      }
    },

    async get(postId) {
      if (!postId) return null;

      // Check memory first
      if (this.timestamps.has(postId)) {
        const time = this.timestamps.get(postId);
        this.timestamps.delete(postId);
        console.log('[IG Enhancer] Restored timestamp for', postId, ':', time);
        return time;
      }

      // Check chrome storage
      try {
        const result = await chrome.storage.session.get(`ts_${postId}`);
        if (result[`ts_${postId}`]) {
          chrome.storage.session.remove(`ts_${postId}`);
          console.log('[IG Enhancer] Restored timestamp from storage for', postId, ':', result[`ts_${postId}`]);
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
    // Find the appropriate container to attach controls to
    let container = video.parentElement;
    let iterations = 0;
    const maxIterations = 10;

    while (container && iterations < maxIterations) {
      const style = window.getComputedStyle(container);
      const hasSize = container.offsetWidth > 100 && container.offsetHeight > 100;
      const isPositioned = style.position !== 'static';

      if (hasSize && (isPositioned || container.tagName === 'DIV')) {
        // Check if this container is suitable
        const rect = container.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();

        // Container should roughly match video size
        if (Math.abs(rect.width - videoRect.width) < 50 &&
            Math.abs(rect.height - videoRect.height) < 100) {
          break;
        }
      }

      container = container.parentElement;
      iterations++;
    }

    // Ensure container has relative positioning for overlay
    if (container && container !== document.body) {
      const style = window.getComputedStyle(container);
      if (style.position === 'static') {
        container.style.position = 'relative';
      }
      return container;
    }

    return video.parentElement;
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

    // Event listeners for video
    video.addEventListener('play', updatePlayState);
    video.addEventListener('pause', updatePlayState);
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('loadedmetadata', updateDuration);
    video.addEventListener('durationchange', updateDuration);
    video.addEventListener('volumechange', updateVolumeState);

    // Play/pause button
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    });

    // Progress bar
    progressInput.addEventListener('input', (e) => {
      isDragging = true;
      const percent = parseFloat(e.target.value);
      progressFilled.style.width = `${percent}%`;
      currentTimeEl.textContent = formatTime((percent / 100) * video.duration);
    });

    progressInput.addEventListener('change', (e) => {
      const percent = parseFloat(e.target.value);
      video.currentTime = (percent / 100) * video.duration;
      isDragging = false;
    });

    progressInput.addEventListener('mousedown', () => {
      isDragging = true;
    });

    progressInput.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Mute button
    muteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      video.muted = !video.muted;
      Preferences.muted = video.muted;
    });

    // Volume slider
    volumeInput.addEventListener('input', (e) => {
      video.volume = parseFloat(e.target.value);
      video.muted = video.volume === 0;
      Preferences.volume = video.volume;
      Preferences.muted = video.muted;
    });

    // Speed selector
    speedSelect.addEventListener('change', (e) => {
      video.playbackRate = parseFloat(e.target.value);
    });

    // Prevent clicks from propagating to Instagram's handlers
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Initial state
    updatePlayState();
    updateVolumeState();
    if (video.duration) updateDuration();

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
    if (postId) {
      TimestampStore.get(postId).then(savedTime => {
        if (savedTime && savedTime > 0) {
          // Wait for video to be ready
          const seekToSaved = () => {
            if (video.readyState >= 1 && video.duration) {
              video.currentTime = Math.min(savedTime, video.duration - 0.5);
            } else {
              video.addEventListener('loadedmetadata', () => {
                video.currentTime = Math.min(savedTime, video.duration - 0.5);
              }, { once: true });
            }
          };
          seekToSaved();
        }
      });
    }

    // Store cleanup function
    video._igEnhancerCleanup = () => {
      if (controls.parentNode) {
        controls.parentNode.removeChild(controls);
      }
    };
  }

  function scanForVideos() {
    const videos = document.querySelectorAll('video:not([data-ig-enhanced])');
    videos.forEach(enhanceVideo);
  }

  // ============================================================
  // COMMENT CLICK HANDLER - Saves timestamp before navigation
  // ============================================================

  function handlePotentialNavigation(event) {
    const target = event.target;

    // Check if clicking on a link that goes to a post
    const link = target.closest('a[href*="/p/"], a[href*="/reel/"]');

    // Check for comment-related elements (various ways Instagram marks them)
    const isCommentClick = target.closest('[aria-label*="Comment" i], [aria-label*="comment" i], svg');

    // Check for any interactive element in the post that might open a modal
    const isInteractiveClick = target.closest('article button, article svg, article [role="button"]');

    if (!link && !isCommentClick && !isInteractiveClick) return;

    // Find any playing videos in the viewport and save their timestamps
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
      if (!video.paused && video.currentTime > 0) {
        const postId = getPostId(video);
        if (postId) {
          TimestampStore.save(postId, video.currentTime);
        }
      }
    });
  }

  // Also save timestamps before any navigation
  function saveAllVideoTimestamps() {
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

  // ============================================================
  // INITIALIZATION
  // ============================================================

  function init() {
    // Initial scan
    scanForVideos();

    // Watch for new videos
    const observer = new MutationObserver((mutations) => {
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
        observer._scanTimeout = setTimeout(scanForVideos, 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Listen for clicks that might navigate to a post
    document.addEventListener('click', handlePotentialNavigation, true);

    // Handle SPA navigation
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Re-scan after navigation
        setTimeout(scanForVideos, 500);
      }
    });

    urlObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Also listen to popstate for back/forward navigation
    window.addEventListener('popstate', () => {
      saveAllVideoTimestamps();
      setTimeout(scanForVideos, 500);
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
          const skip = e.key === 'ArrowRight' ? 10 : -10;
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
