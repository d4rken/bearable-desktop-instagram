# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that enhances Instagram web with custom video controls and UX improvements. No build system - vanilla JS loaded directly by Chrome.

## Development

**Load extension in Chrome:**
1. Go to `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" → select this folder
4. Reload extension after changes (click refresh icon)

**Enable debug logging:** Set `CONFIG.DEBUG = true` in `src/content.js`

## Architecture

Single content script (`src/content.js`) injected on instagram.com pages. All code in one IIFE with these modules:

- **CONFIG** - Tunable constants (seek time, debounce delays)
- **TimestampStore** - Saves/restores video position using `chrome.storage.session` with `sessionStorage` fallback
- **Preferences** - Persists mute/volume state across videos
- **getVideoContainer()** - Wraps videos in our own container for overlay positioning
- **createControlsOverlay()** - Builds the custom controls UI, uses `AbortController` for listener cleanup
- **enhanceVideo()** - Entry point that enhances a video element
- **scanForVideos()** - Finds and enhances unprocessed videos
- **init()** - Sets up `MutationObserver` for dynamic content and keyboard handlers

Videos are marked with `data-ig-enhanced` attribute to avoid double-processing.

## Key Patterns

- Event listeners use `{ signal }` from `AbortController` for proper cleanup
- Video detection uses `MutationObserver` watching `document.body` for both new videos and URL changes (Instagram is a SPA)
- Post IDs extracted from URL (`/p/{id}/` or `/reel/{id}/`) or article links
