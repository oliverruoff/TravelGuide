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
    researchName: str | None = None
    nativeName: str | None = None
    lat: float
    lng: float
    tags: dict[str, str] = Field(default_factory=dict)
    distanceMeters: float


class PoiSummary(BaseModel):
    id: str
    name: str
    researchName: str | None = None
    nativeName: str | None = None
    lat: float
    lng: float
    category: str = "Place"
    oneLiner: str = ""
    imageUrl: str | None = None
    confidence: float = 0.5
    sourceRefs: list[str] = Field(default_factory=list)


class PoiSelectRequest(BaseModel):
    language: str = "en"
    categoryFilters: list[str] = Field(default_factory=list)
    candidates: list[RawGeoCandidate]
    excludeNames: list[str] = Field(default_factory=list)


class PoiEnrichRequest(BaseModel):
    language: str = "en"
    poi: PoiSummary


class PoiDetailRequest(BaseModel):
    language: str = "en"
    poi: PoiSummary


class TtsRequest(BaseModel):
    language: str = "en"
    text: str = Field(min_length=1, max_length=10000)


class PasswordCheckRequest(BaseModel):
    password: str


class Achievement(BaseModel):
    id: str
    title: str
    description: str
    unlockedAt: int
    relatedPoiId: str | None = None
