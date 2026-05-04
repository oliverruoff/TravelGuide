import asyncio
import json

from backend.models import PoiSummary, RawGeoCandidate
from backend.services import _detail_queries, enrich_poi, normalize_overpass, select_pois
from backend.settings import Settings


class FakeChatResponse:
    def __init__(self, content):
        self.content = content

    def json(self):
        return {"choices": [{"message": {"content": self.content}}]}


def test_normalize_overpass_dedupes_and_sorts():
    data = {
        "elements": [
            {"type": "node", "id": 1, "lat": 52.0, "lon": 13.0, "tags": {"name": "Museum", "tourism": "museum"}},
            {"type": "node", "id": 2, "lat": 52.0, "lon": 13.0, "tags": {"name": "Museum", "tourism": "museum"}},
            {"type": "way", "id": 3, "center": {"lat": 52.001, "lon": 13.001}, "tags": {"name": "Bridge", "bridge": "yes"}},
            {"type": "node", "id": 4, "lat": 52.5, "lon": 13.5, "tags": {"amenity": "cafe"}},
        ]
    }

    result = normalize_overpass(data, 52.0, 13.0)

    assert [item.name for item in result] == ["Museum", "Bridge"]
    assert result[0].id == "node/1"


def test_normalize_overpass_prefers_english_name_and_preserves_native_name():
    data = {
        "elements": [
            {
                "type": "node",
                "id": 1,
                "lat": 39.9163,
                "lon": 116.3972,
                "tags": {"name": "故宫博物院", "name:en": "Forbidden City", "tourism": "museum"},
            }
        ]
    }

    result = normalize_overpass(data, 39.916, 116.397)

    assert result[0].name == "Forbidden City"
    assert result[0].researchName == "Forbidden City"
    assert result[0].nativeName == "故宫博物院"


def test_normalize_overpass_falls_back_to_native_name_when_needed():
    data = {
        "elements": [
            {"type": "node", "id": 1, "lat": 39.9163, "lon": 116.3972, "tags": {"name": "景山公园", "leisure": "park"}}
        ]
    }

    result = normalize_overpass(data, 39.916, 116.397)

    assert result[0].name == "景山公园"
    assert result[0].researchName == "景山公园"
    assert result[0].nativeName is None


def test_detail_queries_use_research_name_and_english_terms_for_any_language():
    poi = PoiSummary(id="node/1", name="Cité interdite", researchName="Forbidden City", lat=39.916, lng=116.397)

    queries = _detail_queries(poi, language="de", city="Beijing")

    assert queries == [
        '"Forbidden City" "Beijing"',
        '"Forbidden City" "Beijing" history',
        '"Forbidden City" "Beijing" attraction visit',
    ]


def test_select_pois_accepts_localized_display_name_and_preserves_research_name(monkeypatch):
    async def fake_chat(settings, messages, stream=False):
        return FakeChatResponse(json.dumps([{
            "id": "node/1",
            "name": "Cité interdite",
            "lat": 39.916,
            "lng": 116.397,
            "category": "Musée historique",
            "oneLiner": "Un palais impérial au coeur de Pékin.",
            "confidence": 0.9,
        }]))

    monkeypatch.setattr("backend.services.minimax_chat", fake_chat)
    candidates = [
        RawGeoCandidate(
            id="node/1",
            name="Forbidden City",
            researchName="Forbidden City",
            nativeName="故宫博物院",
            lat=39.916,
            lng=116.397,
            tags={"tourism": "museum"},
            distanceMeters=25,
        )
    ]

    result = asyncio.run(select_pois(Settings(minimax_api_key="test"), candidates, "fr"))

    assert result[0].name == "Cité interdite"
    assert result[0].researchName == "Forbidden City"
    assert result[0].nativeName == "故宫博物院"
    assert result[0].category == "Musée historique"


def test_enrich_poi_uses_research_name_and_localizes_card_metadata(monkeypatch):
    calls = []

    async def fake_reverse(lat, lng):
        return "Beijing"

    async def fake_wikipedia(name, city, language):
        calls.append(("wiki", name, city, language))
        return None

    async def fake_brave(settings, query, image=False, count=5):
        calls.append(("brave", query, image))
        if image:
            return {"results": []}
        return {"web": {"results": [{"title": "Forbidden City", "description": "Imperial palace complex in Beijing.", "url": "https://example.test"}]}}

    async def fake_chat(settings, messages, stream=False):
        return FakeChatResponse(json.dumps({
            "name": "Cité interdite",
            "category": "Palais historique",
            "oneLiner": "Un palais impérial majeur au coeur de Pékin.",
        }))

    monkeypatch.setattr("backend.services._reverse_geocode_city", fake_reverse)
    monkeypatch.setattr("backend.services.wikipedia_data", fake_wikipedia)
    monkeypatch.setattr("backend.services.brave_search", fake_brave)
    monkeypatch.setattr("backend.services._pick_best_image", lambda results, poi: None)
    monkeypatch.setattr("backend.services.minimax_chat", fake_chat)

    poi = PoiSummary(id="node/1", name="Forbidden City", researchName="Forbidden City", lat=39.916, lng=116.397)
    result = asyncio.run(enrich_poi(Settings(minimax_api_key="test", brave_api_key="test"), poi, "fr"))

    assert result.name == "Cité interdite"
    assert result.researchName == "Forbidden City"
    assert result.category == "Palais historique"
    assert any(call == ("wiki", "Forbidden City", "Beijing", "fr") for call in calls)
    assert any(call[0] == "brave" and "Forbidden City" in call[1] for call in calls)
