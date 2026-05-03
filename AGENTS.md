# AGENTS.md — TravelGuide quick-ramp for AI agents

## Architecture

Single Docker container. FastAPI backend (Python 3.13) serves both the REST API and the compiled React SPA from `frontend/dist/`. No separate frontend server in production.

- Port: **8000**
- The SPA catch-all route and static file mount are **only registered when `frontend/dist/` exists** (`_dist.exists()` check in `backend/main.py`). In local dev without a prior `npm run build` the backend starts but serves no frontend.
- All user data is client-side (IndexedDB via Dexie). No server-side database. No migrations.

## Dev commands

**Backend** — must run from repo root (not from inside `backend/`):
```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt          # requirements.txt is at REPO ROOT, not backend/
uvicorn backend.main:app --reload        # module path: backend.main:app
```
Running `uvicorn main:app` from inside `backend/` breaks relative imports.

**Frontend:**
```bash
cd frontend
npm install
npm run dev      # binds to 127.0.0.1:5173, proxies /api → 127.0.0.1:8000
```

**Build check (TypeScript + bundle):**
```bash
cd frontend && npm run build    # runs: tsc && vite build
```
There is no separate `lint` or `typecheck` script. `tsc` runs as part of `build`. TypeScript errors fail the Docker build at Stage 1.

**Tests:**
```bash
pytest tests/                   # backend — uses respx to mock httpx calls
cd frontend && npm test         # frontend — vitest run
```

**Docker (recommended for full-stack):**
```bash
docker compose up --build
```

## Environment variables

`.env` must live at **repo root** (where uvicorn/docker-compose runs). Copy `.env_sample` to get started.

| Variable | Required | Effect |
|---|---|---|
| `MINIMAX_API_KEY` | Yes | LLM + TTS. Without it POI selection/enrichment/streaming all fail. |
| `BRAVE_API_KEY` | Yes | Image search + web snippets for enrichment. |
| `TRAVELGUIDE_LANGUAGE` | No | Default `en`. Sets initial language for new users. |
| `TRAVELGUIDE_TTS_PROVIDER` | No | Default `browser`. Set `minimax` to use MiniMax TTS. |
| `MINIMAX_MODEL` | No | Default `MiniMax-M2.7` |
| `MINIMAX_TTS_MODEL` | No | Default `speech-2.8-hd` |

**Configured gate:** `GET /api/config/runtime` returns `"configured": true` only when both `MINIMAX_API_KEY` and `BRAVE_API_KEY` are non-empty. The frontend shows the onboarding screen if `configured: false`. API keys never reach the browser.

## IndexedDB / Dexie version bump rule

**This is the highest-risk gotcha.** File: `frontend/src/db.ts`.

- DB name: `'travelguide'`, currently at **version 2**.
- Version history: v1 (`savedPois`, `achievements`) → v2 (added `poiCache`, `poiDetailCache`).
- **Any addition, removal, or change to a table or index requires a new `db.version(N).stores({...})` block.** Never modify existing version blocks — Dexie throws `VersionError` for existing users.
- Old version blocks must be kept so existing users upgrade cleanly.
- `poiCache` key: `lat.toFixed(3),lng.toFixed(3)` (~111 m grid).
- `poiDetailCache` key: `"<poiId>|<language>"` — manually constructed composite, not a Dexie compound index.

## Key files

| Path | Role |
|---|---|
| `backend/main.py` | All FastAPI routes |
| `backend/services.py` | All AI/search logic (select, enrich, stream, TTS) |
| `backend/settings.py` | Pydantic-settings, reads `.env` |
| `backend/models.py` | Pydantic request/response models |
| `prompts/` | LLM prompt templates — required at runtime, copied into Docker image |
| `frontend/src/App.tsx` | Entire frontend: components, state, scan loop, DetailCard, animations |
| `frontend/src/store.ts` | Zustand store — language, pois, activePoi, savedOpen |
| `frontend/src/db.ts` | Dexie DB — savedPois, achievements, poiCache, poiDetailCache |
| `frontend/src/api.ts` | All fetch calls to the backend |
| `frontend/src/types.ts` | Shared TypeScript types |
| `requirements.txt` | **Repo root**, not `backend/`. All versions pinned exactly. |

## Actual API routes (README is outdated on these)

```
GET  /api/health
GET  /api/config/runtime          → { configured, language }
POST /api/config/session          → no-op v1
POST /api/geo/candidates          → Overpass raw geo results
POST /api/poi/select              → LLM-curated PoiSummary[]
POST /api/poi/enrich              → enriched PoiSummary (image, oneLiner, sourceRefs)
POST /api/poi/detail/stream       → SSE stream, terminates with event: done\ndata: done
```
SSE stream is **POST**, not GET. The README example showing `GET /api/detail/{poi_id}` is wrong.

## POI loading flow

`scan()` in `App.tsx`: geo candidates → LLM select → sort by distance → enrich each POI sequentially → write to `poiCache`. On repeat visit to same location, `poiCache` is served instantly, full pipeline skipped. Manual refresh button calls `clearCachedScan` first.

Detail text: `DetailCard` checks `poiDetailCache` before calling `streamDetail`. After streaming completes, result is written to `poiDetailCache` and (if POI is bookmarked) to `savedPois.detailText`.

## Deployment update script

`update.sh` at repo root — stops the running container, pulls latest image from GHCR, starts fresh with `.env`. See README for usage.

## GitHub Actions

Push to `main` → builds and pushes `ghcr.io/oliverruoff/travelguide:latest` automatically.
