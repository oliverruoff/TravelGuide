import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .models import CandidateRequest, PoiDetailRequest, PoiEnrichRequest, PoiSelectRequest, SessionConfigRequest
from .services import enrich_poi, fetch_overpass, select_pois, stream_detail
from .settings import get_settings

logger = logging.getLogger(__name__)

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


@app.get("/api/config/runtime")
async def runtime_config() -> dict[str, str | bool]:
    deployment_configured = bool(settings.minimax_api_key and settings.brave_api_key)
    return {
        "configured": deployment_configured,
        "language": settings.travelguide_language.strip().lower() or "en",
    }


@app.post("/api/config/session")
async def config_session(payload: SessionConfigRequest) -> dict[str, str]:
    # V1 reads provider keys from the local backend environment for safer browser behavior.
    return {"status": "ok", "language": payload.language}


@app.post("/api/geo/candidates")
async def geo_candidates(payload: CandidateRequest):
    try:
        return await fetch_overpass(settings, payload.lat, payload.lng, payload.radiusMeters)
    except Exception as e:
        logger.error(f"Error fetching candidates: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch candidates: {str(e)}")


@app.post("/api/poi/select")
async def poi_select(payload: PoiSelectRequest):
    try:
        return await select_pois(settings, payload.candidates, payload.language)
    except Exception as e:
        logger.error(f"Error selecting POIs: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to select POIs: {str(e)}")


@app.post("/api/poi/enrich")
async def poi_enrich(payload: PoiEnrichRequest):
    try:
        return await enrich_poi(settings, payload.poi, payload.language)
    except Exception as e:
        logger.error(f"Error enriching POI: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to enrich POI: {str(e)}")


@app.post("/api/poi/detail/stream")
async def poi_detail_stream(payload: PoiDetailRequest):
    try:
        async def events():
            async for text in stream_detail(settings, payload.poi, payload.language):
                yield f"data: {text}\n\n"
            yield "event: done\ndata: done\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")
    except Exception as e:
        logger.error(f"Error streaming detail: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to stream detail: {str(e)}")

# Catch-all: serve index.html for client-side routing (only in production with dist/)
if _dist.exists():
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file = _dist / full_path
        if file.is_file():
            return FileResponse(file)
        return FileResponse(_dist / "index.html")
