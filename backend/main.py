import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .models import CandidateRequest, PasswordCheckRequest, PoiDetailRequest, PoiEnrichRequest, PoiSelectRequest
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

# ---------------------------------------------------------------------------
# Token helpers  (stateless HMAC — no database required)
# ---------------------------------------------------------------------------
_TOKEN_LIFETIME = 365 * 24 * 3600  # 1 year in seconds


def _sign(payload: dict) -> str:
    """Encode payload as base64 JSON and append an HMAC-SHA256 signature."""
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode()
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode()
    sig = hmac.new(settings.app_secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _verify_token(token: str) -> bool:
    """Return True iff the token has a valid signature and has not expired."""
    try:
        payload_b64, sig = token.rsplit(".", 1)
        expected = hmac.new(settings.app_secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not secrets.compare_digest(sig, expected):
            return False
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return time.time() < payload["exp"]
    except Exception:
        return False


def _issue_token() -> str:
    now = int(time.time())
    return _sign({"iat": now, "exp": now + _TOKEN_LIFETIME})


# ---------------------------------------------------------------------------
# Auth dependency — injected into every protected route
# ---------------------------------------------------------------------------

def require_auth(authorization: str = Header(default="")) -> None:
    """FastAPI dependency: validates Bearer token on every protected request.

    When TRAVELGUIDE_ACCESS_PASSWORD is empty (dev mode) auth is skipped.
    """
    if not settings.travelguide_access_password:
        return  # dev mode — no password configured, allow all
    token = authorization.removeprefix("Bearer ").strip()
    if not token or not _verify_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# Public routes (no auth required)
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config/runtime")
async def runtime_config() -> dict[str, str]:
    """Return server-side defaults. Never exposes API keys."""
    return {"language": settings.travelguide_language.strip().lower() or "en"}


@app.post("/api/auth/verify")
async def auth_verify(payload: PasswordCheckRequest) -> dict[str, str]:
    """Validate access password and return a signed token on success."""
    if not settings.travelguide_access_password:
        # Dev mode: any password accepted — still issue a real token
        return {"token": _issue_token()}
    if not secrets.compare_digest(payload.password, settings.travelguide_access_password):
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"token": _issue_token()}


# ---------------------------------------------------------------------------
# Protected routes
# ---------------------------------------------------------------------------

@app.post("/api/geo/candidates")
async def geo_candidates(payload: CandidateRequest, _: None = Depends(require_auth)):
    try:
        return await fetch_overpass(settings, payload.lat, payload.lng, payload.radiusMeters)
    except Exception as e:
        logger.error(f"Error fetching candidates: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch candidates: {str(e)}")


@app.post("/api/poi/select")
async def poi_select(payload: PoiSelectRequest, _: None = Depends(require_auth)):
    try:
        return await select_pois(settings, payload.candidates, payload.language, payload.categoryFilters, payload.excludeNames)
    except Exception as e:
        logger.error(f"Error selecting POIs: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to select POIs: {str(e)}")


@app.post("/api/poi/enrich")
async def poi_enrich(payload: PoiEnrichRequest, _: None = Depends(require_auth)):
    try:
        return await enrich_poi(settings, payload.poi, payload.language)
    except Exception as e:
        logger.error(f"Error enriching POI: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to enrich POI: {str(e)}")


@app.post("/api/poi/detail/stream")
async def poi_detail_stream(payload: PoiDetailRequest, _: None = Depends(require_auth)):
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
