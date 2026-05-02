# TravelGuide GenAI PWA Plan

## Summary

Build a mobile-first TravelGuide app as a portrait-oriented PWA with a Python FastAPI backend and a heavily GenAI-driven user experience. The app detects the user's current GPS position, finds nearby map objects through OSM/Overpass, asks MiniMax to select up to 10 travel-worthy POIs, enriches them through Brave Search, and presents them as polished, animated travel guide cards.

V1 should be web/PWA rather than native Android or iOS. GPS, maps, animation, streaming text, local storage, and fast iteration all work well in a PWA. A later native wrapper with Capacitor remains possible.

## Tech Stack

- Frontend: React, TypeScript, Vite, MapLibre GL, Framer Motion, TanStack Query, Zustand, Dexie/IndexedDB.
- Backend: Python, FastAPI, Pydantic, httpx, Server-Sent Events for streaming.
- Map: MapLibre with OSM-based tiles.
- Geo data: Overpass API for named OSM objects within a 500m radius.
- LLM: MiniMax-M2.7 through a MiniMax Token Plan/API key.
- Research: Brave Search API for web and image search.
- Storage: Local-first IndexedDB for saved POIs, visited POIs, achievements, and cached content.

## Core Flow

1. On first launch, the app asks for language, MiniMax API key, and Brave Search API key.
2. The app gets the current location through browser GPS and displays the accuracy in a small visible label, for example `GPS +/- 12 m`.
3. The backend calls Overpass with a 500m radius and normalizes named buildings, places, rivers, monuments, artworks, parks, bridges, viewpoints, and similar map objects.
4. MiniMax receives the candidate list and selects up to 10 travel-guide-worthy POIs.
5. The selected POIs appear as markers on the map and as cards in the list below.
6. For each POI, title, one-liner, category, and image candidates are enriched through Brave Search and MiniMax.
7. When the user taps a POI, an animated detail card opens with an image collage, streamed travel-guide text, save button, visited state, and text-to-speech.
8. Visited and saved POIs are stored locally and surfaced as lightweight achievements.

## Backend Architecture

FastAPI exposes these endpoints:

- `POST /api/config/session`: store or update language and provider keys for the current installation.
- `POST /api/geo/candidates`: receive GPS coordinates and return normalized Overpass candidates.
- `POST /api/poi/select`: ask MiniMax to select up to 10 POIs from raw candidates.
- `POST /api/poi/enrich`: use Brave and MiniMax to generate card metadata, one-liners, and images.
- `POST /api/poi/detail/stream`: stream researched travel-guide text through SSE.
- `POST /api/tts`: optional TTS proxy; V1 can start with browser SpeechSynthesis.

All LLM responses are validated server-side with Pydantic. If MiniMax returns invalid JSON, the backend should use a robust fallback strategy: attempt repair, retry with a stricter prompt, or fall back to heuristically sorted POIs based on OSM tags and distance.

## Data Model

Core types:

- `GeoFix`: latitude, longitude, accuracyMeters, timestamp.
- `RawGeoCandidate`: id, name, lat, lng, tags, distanceMeters.
- `PoiSummary`: id, name, lat, lng, category, oneLiner, imageUrl, confidence, sourceRefs.
- `PoiDetail`: summary plus longDescription, imageGallery, citations, saved, visited.
- `Achievement`: id, title, description, unlockedAt, optional relatedPoiId.

## Design Guide

The app should feel like a premium, slightly playful digital travel guide: elegant, tactile, animated, but not cartoonish. The reference direction is a physical collectible or game card, with a subtle Hearthstone-like sense of presence, but more mature, calm, and travel-oriented.

### Layout

- The primary layout is mobile portrait.
- Top third: interactive map with POI markers.
- Lower two thirds: POI list with individual cards.
- Desktop may render as a centered phone-width app shell, but mobile remains the leading experience.
- No landing page; after onboarding, the user should enter the actual travel guide experience directly.

### Visual Style

- Cards should feel premium and physical: light depth, clean edges, refined shadows, and a subtle highlight or light rim.
- Border radius should be moderate rather than overly rounded.
- Avoid overloaded comic colors.
- The palette should feel warm, high-quality, and travel-inspired, but not monotonously beige or brown.
- Accent colors can indicate categories, active markers, and achievements.
- Typography should be modern and readable, with concise titles and comfortable body text.
- POI cards need an image on the left, with title and one-liner on the right.
- The detail card uses an image collage at the top and streamed text below.

### Motion

- The POI detail view opens like a physical card:
  - Tap on list card.
  - Card lifts slightly.
  - Transition expands into a fullscreen detail card.
  - 3D shadow and subtle rotation, flip, or unfold motion.
- Markers and list cards should appear smoothly when new POIs are discovered.
- Streaming text should appear elegantly rather than popping in harshly.
- Achievements can use small, brief unlock animations.
- `prefers-reduced-motion` must be respected.

### Map UX

- Markers show the POI name or a short label variant.
- The active POI is highlighted both on the map and in the list.
- GPS accuracy is small but visible.
- Poor location accuracy should not block the UI; it should show a friendly warning.
- Refresh/rescan should be easy to reach.

### Detail Card UX

- The detail view should feel like a special travel guide card.
- Top: image collage from researched images.
- Middle: title, category, distance, and optionally subtle confidence or "AI selected" metadata.
- Body: streamed guide text with a polished travel-guide tone.
- Bottom or sticky action area: save, TTS play/pause, mark visited, and close.
- Sources/citations should be available in a compact expandable area so the card stays beautiful.

### Gamification

- Visited POIs are stored as achievements.
- Initial V1 achievements:
  - First POI discovered.
  - First POI saved.
  - First POI visited.
  - Three POIs visited in one area.
  - Ten POIs discovered overall.
- Achievements should motivate exploration without dominating the travel-guide experience.

## Privacy And Key Handling

- API keys should not be permanently used directly from the frontend.
- V1 uses a Python backend proxy for MiniMax, Brave, and Overpass.
- The browser should not store provider keys in plaintext except for local development demos.
- Production later needs account-based or encrypted key management.
- Location data is used for the current POI search and stored locally only where needed for visited POIs.

## Error And Fallback States

- GPS denied: show manual location search or a clear prompt to enable location access.
- GPS inaccurate: show accuracy and still load POIs, but disable automatic visit detection.
- Overpass empty or slow: retry, optionally plan a larger radius later, and show a friendly empty state.
- MiniMax error: fall back to heuristic POI selection based on OSM tags.
- Brave error: show the POI without an image or with a generic category image.
- Offline: saved POIs and cached details remain available.

## Test Plan

Backend tests with pytest:

- Normalize Overpass responses.
- Deduplicate candidates.
- Validate MiniMax JSON and handle invalid output.
- Parse Brave Web Search and Image Search responses.
- Test SSE streaming.

Frontend tests:

- Onboarding flow.
- Mobile portrait main view.
- POI map/list synchronization.
- Detail card animation state.
- Saved POIs view.
- GPS denied, low accuracy, and no-candidates states.

Manual acceptance:

- User can enter language and API keys.
- User can see GPS accuracy.
- User receives up to 10 POIs nearby.
- POIs appear on the map and in the list.
- Detail card opens with animation.
- Travel-guide text streams visibly.
- TTS reads the text aloud.
- POI can be saved and reopened.
- Visited POIs are stored as achievements.

## Assumptions

- V1 is a PWA, not a native app.
- Backend is Python FastAPI.
- MiniMax-M2.7 is the default model.
- Brave Search is the primary research and image source.
- MapLibre, OSM, and Overpass are the map and POI data stack.
- Custom personal voice TTS is planned later; V1 starts with generic speech output.
- Storage is local-first without user accounts.
