from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .models import CandidateRequest, PoiDetailRequest, PoiEnrichRequest, PoiSelectRequest, SessionConfigRequest
from .services import enrich_poi, fetch_overpass, select_pois, stream_detail
from .settings import get_settings

app = FastAPI(title="TravelGuide GenAI API")
settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve frontend static files if the dist directory exists (production Docker build)
_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/config/session")
async def config_session(payload: SessionConfigRequest) -> dict[str, str]:
    # V1 reads provider keys from the local backend environment for safer browser behavior.
    return {"status": "ok", "language": payload.language}


@app.post("/api/geo/candidates")
async def geo_candidates(payload: CandidateRequest):
    return await fetch_overpass(settings, payload.lat, payload.lng, payload.radiusMeters)


@app.post("/api/poi/select")
async def poi_select(payload: PoiSelectRequest):
    return await select_pois(settings, payload.candidates, payload.language)


@app.post("/api/poi/enrich")
async def poi_enrich(payload: PoiEnrichRequest):
    return await enrich_poi(settings, payload.poi, payload.language)


@app.post("/api/poi/detail/stream")
async def poi_detail_stream(payload: PoiDetailRequest):
    async def events():
        async for text in stream_detail(settings, payload.poi, payload.language):
            yield f"data: {text}\n\n"
        yield "event: done\ndata: done\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


# Catch-all: serve index.html for client-side routing (only in production with dist/)
if _dist.exists():
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file = _dist / full_path
        if file.is_file():
            return FileResponse(file)
        return FileResponse(_dist / "index.html")

