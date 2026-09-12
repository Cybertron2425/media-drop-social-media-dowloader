# MediaDrop — Universal Media Downloader (Phase 1 + Phase 2)

Paste a public media URL, inspect available formats, and download.

## Status

### Phase 1 ✅
- Project scaffold (client + server)
- REST API structure (`/api/analyze`, `/api/download`, `/api/health`, `/api/platforms`)
- Direct media URL adapter (`.mp4`, `.mp3`, `.jpg`, etc.)
- Reddit adapter (public `.json` API) and Vimeo adapter (oEmbed metadata)
- SSRF protection, rate limiting, file-size limits, download tokens, structured logging
- Frontend: hero, URL input, loading states, media preview, format selector, FAQ, dark mode

### Phase 2 ✅
- **Deeper generic-site extraction** (`server/src/platforms/generic.js`):
  - JSON-LD (`schema.org` `VideoObject`/`ImageObject`/`AudioObject`) parsing
  - `og:video`, `og:video:url`, `og:audio` meta tags (in addition to `og:title`/`og:image`)
  - `<video>`/`<audio>`/`<source>` tag scraping
  - HLS/DASH manifest (`.m3u8`/`.mpd`) detection — labeled "Manifest (playlist, not a single
    file)" rather than pretending it's a normal downloadable video, since we do not fetch/merge
    adaptive-streaming segments
  - Image-page fallback: `srcset` largest-candidate parsing + heuristic `<img>` scraping when no
    video/audio is found
  - Deduplication of formats resolving to the same source URL
- **Real streaming download** (no JS buffering the whole file in memory):
  - New `GET /api/download/:downloadId` — a real browser navigation streams bytes straight to
    disk via the browser's own download handling
  - New `GET /api/download/:downloadId/validate` — lightweight, non-consuming check the frontend
    calls first, so a bad/expired link shows a proper in-app error instead of a silent failed
    navigation
  - Download tokens are now correctly single-use (fixed a bug where `consumeDownloadToken`
    wasn't actually deleting the token)
  - `POST /api/download` kept working for non-browser/API clients per the original contract
  - Frontend button now shows `Preparing… / Downloading… / Complete` stages instead of a
    byte-counted percentage (matches spec §14; true byte progress isn't observable once the
    browser owns the download)

### Still stubbed (honestly, not faked)
YouTube / Instagram / Facebook / TikTok / X / Pinterest / TeraBox — see
`server/src/platforms/stubAdapters.js`.

### Not yet built (Phases 3–5)
Docker, SEO landing pages (`/youtube-downloader` etc.), automated test suite, production
deployment config. See `HANDOFF.md` for the full remaining plan.

## Requirements

- Node.js 18+

## Setup

```bash
# from the project root
npm run install:all
cp .env.example server/.env
npm run dev
```

This starts the API on `http://localhost:5000` and the frontend on `http://localhost:5173`
(Vite proxies `/api` to the server).

Or run them separately:

```bash
npm run dev:server
npm run dev:client
```

## API

### `GET /api/health`
Returns `{ success: true, status: "ok" }`.

### `GET /api/platforms`
Lists registered adapters and their support status.

### `POST /api/analyze`
```json
{ "url": "https://example.com/video.mp4" }
```
Returns metadata and format options, each with a short-lived, single-use `downloadId`.

### `GET /api/download/:downloadId/validate`
Non-consuming check — confirms the token is still valid.

### `GET /api/download/:downloadId`
The real download. Point a browser navigation (`<a href>`, `window.location`) here — it streams
the file to disk natively, consuming the token.

### `POST /api/download`
```json
{ "downloadId": "..." }
```
Same streaming behavior, for API/programmatic clients that aren't a browser.

## Compliance

MediaDrop only processes publicly accessible media. It does not bypass logins, paywalls,
DRM, or other access controls, and blocks requests to localhost/private IP ranges to
prevent SSRF abuse. See `server/src/utils/urlSafety.js` and
`server/src/platforms/stubAdapters.js`.

## Project structure

```
media-downloader/
├── client/   React + Vite + Tailwind frontend
├── server/   Express REST API + platform adapters
└── .env.example
```

See `HANDOFF.md` for the full architecture reference, tech stack, and continuation plan.

