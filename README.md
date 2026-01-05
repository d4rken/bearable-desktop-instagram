# Bearable Desktop Instagram

A Chrome extension that makes the Instagram web experience actually usable by adding proper video controls and fixing annoying UX issues.

## Features

### Custom Video Controls
- **Progress bar** - Seekable, so you can skip boring parts
- **Time display** - See current time and duration
- **Volume control** - Slider + mute button
- **Playback speed** - 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x

### Keyboard Shortcuts
- **Left arrow** - Rewind 10 seconds
- **Right arrow** - Skip forward 10 seconds

### Timestamp Persistence
When you click comments on a video post, the video normally restarts from the beginning in the modal. This extension remembers where you were and continues from that position.

### Mute State Persistence
If you unmute a video, subsequent videos will also be unmuted automatically.

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `instagram-extension` folder

## Configuration

Edit the `CONFIG` object in `src/content.js` to customize:

```javascript
const CONFIG = {
  DEBUG: false,                    // Enable console logging
  SEEK_SECONDS: 10,                // Arrow key skip duration
  SEEK_END_BUFFER: 0.5,            // Buffer from end when restoring timestamp
  SCAN_DEBOUNCE_MS: 100,           // Debounce for video detection
  NAVIGATION_SCAN_DELAY_MS: 500,   // Delay after navigation before scanning
};
```

## How It Works

- Uses a `MutationObserver` to detect new video elements as Instagram dynamically loads content
- Wraps videos in a container and overlays custom controls
- Stores timestamps in `chrome.storage.session` for persistence across navigation
- Cleans up event listeners properly using `AbortController` to prevent memory leaks

## License

GPL-3.0 - See [LICENSE](LICENSE) for details.
