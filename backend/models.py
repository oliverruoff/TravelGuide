from pydantic import BaseModel, Field


class GeoFix(BaseModel):
    latitude: float
    longitude: float
    accuracyMeters: float | None = None
    timestamp: int | None = None


class CandidateRequest(BaseModel):
    lat: float
    lng: float
    radiusMeters: int = Field(default=500, ge=50, le=1500)


class RawGeoCandidate(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    tags: dict[str, str] = Field(default_factory=dict)
    distanceMeters: float


class PoiSummary(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    category: str = "Place"
    oneLiner: str = ""
    imageUrl: str | None = None
    confidence: float = 0.5
    sourceRefs: list[str] = Field(default_factory=list)


class PoiSelectRequest(BaseModel):
    language: str = "en"
    candidates: list[RawGeoCandidate]


class PoiEnrichRequest(BaseModel):
    language: str = "en"
    poi: PoiSummary


class PoiDetailRequest(BaseModel):
    language: str = "en"
    poi: PoiSummary


class TtsRequest(BaseModel):
    language: str = "en"
    text: str = Field(min_length=1, max_length=10000)


class SessionConfigRequest(BaseModel):
    language: str = "en"
    minimaxApiKey: str | None = None
    braveApiKey: str | None = None


class Achievement(BaseModel):
    id: str
    title: str
    description: str
    unlockedAt: int
    relatedPoiId: str | None = None
