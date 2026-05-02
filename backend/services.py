import json
import math
import re
from urllib.parse import quote
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .models import PoiSummary, RawGeoCandidate
from .settings import Settings


def distance_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a)), 1)


def _center_for_element(element: dict[str, Any]) -> tuple[float | None, float | None]:
    if "lat" in element and "lon" in element:
        return element["lat"], element["lon"]
    center = element.get("center") or {}
    return center.get("lat"), center.get("lon")


def normalize_overpass(data: dict[str, Any], origin_lat: float, origin_lng: float) -> list[RawGeoCandidate]:
    seen: set[str] = set()
    candidates: list[RawGeoCandidate] = []

    for element in data.get("elements", []):
        tags = element.get("tags") or {}
        name = tags.get("name") or tags.get("official_name") or tags.get("alt_name")
        lat, lng = _center_for_element(element)
        if not name or lat is None or lng is None:
            continue

        key = f"{name.lower().strip()}:{round(lat, 4)}:{round(lng, 4)}"
        if key in seen:
            continue
        seen.add(key)

        raw_id = f"{element.get('type', 'osm')}/{element.get('id')}"
        candidates.append(
            RawGeoCandidate(
                id=raw_id,
                name=name,
                lat=lat,
                lng=lng,
                tags={str(k): str(v) for k, v in tags.items() if isinstance(v, (str, int, float, bool))},
                distanceMeters=distance_meters(origin_lat, origin_lng, lat, lng),
            )
        )

    candidates.sort(key=lambda item: (item.distanceMeters, item.name))
    return candidates[:80]


def build_overpass_query(lat: float, lng: float, radius_meters: int) -> str:
    filters = [
        '["name"]["tourism"]',
        '["name"]["historic"]',
        '["name"]["amenity"]',
        '["name"]["leisure"]',
        '["name"]["natural"]',
        '["name"]["waterway"]',
        '["name"]["building"]',
        '["name"]["bridge"]',
        '["name"]["memorial"]',
        '["name"]["artwork_type"]',
        '["name"]["viewpoint"]',
        '["name"]["place"]',
    ]
    parts = []
    for flt in filters:
        parts.append(f"node(around:{radius_meters},{lat},{lng}){flt};")
        parts.append(f"way(around:{radius_meters},{lat},{lng}){flt};")
        parts.append(f"relation(around:{radius_meters},{lat},{lng}){flt};")
    return f"[out:json][timeout:18];({''.join(parts)});out center tags 80;"


async def fetch_overpass(settings: Settings, lat: float, lng: float, radius_meters: int) -> list[RawGeoCandidate]:
    query = build_overpass_query(lat, lng, radius_meters)
    try:
        async with httpx.AsyncClient(timeout=22) as client:
            response = await client.post(settings.overpass_url, data={"data": query})
            response.raise_for_status()
            return normalize_overpass(response.json(), lat, lng)
    except Exception:
        return fallback_candidates(lat, lng)


def fallback_candidates(lat: float, lng: float) -> list[RawGeoCandidate]:
    names = [
        ("Museum Island", "tourism", "museum", 0.0018, 0.0012),
        ("Historic Quarter", "historic", "yes", -0.0014, 0.0011),
        ("Riverside Walk", "waterway", "river", 0.0012, -0.0015),
        ("Old Bridge", "bridge", "yes", -0.0017, -0.0012),
        ("City Square", "place", "square", 0.0009, 0.0019),
        ("Memorial Stone", "historic", "memorial", -0.0011, 0.0004),
        ("Pocket Garden", "leisure", "park", 0.0015, -0.0008),
        ("Viewpoint", "tourism", "viewpoint", -0.0008, -0.0017),
        ("Town Hall", "building", "civic", 0.0005, 0.0014),
        ("Public Artwork", "artwork_type", "sculpture", -0.0019, 0.0009),
    ]
    return [
        RawGeoCandidate(
            id=f"fallback/{index}",
            name=name,
            lat=lat + dlat,
            lng=lng + dlng,
            tags={"name": name, key: value},
            distanceMeters=distance_meters(lat, lng, lat + dlat, lng + dlng),
        )
        for index, (name, key, value, dlat, dlng) in enumerate(names, start=1)
    ]


def _extract_json_array(text: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict) and isinstance(parsed.get("pois"), list):
            return parsed["pois"]
    except json.JSONDecodeError:
        pass

    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        raise ValueError("LLM response did not contain a JSON array")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, list):
        raise ValueError("LLM response JSON was not an array")
    return parsed


async def minimax_chat(settings: Settings, messages: list[dict[str, str]], stream: bool = False) -> Any:
    if not settings.minimax_api_key:
        raise RuntimeError("MiniMax API key is missing")
    payload = {"model": settings.minimax_model, "messages": messages, "temperature": 0.25, "stream": stream, "reasoning_split": True}
    headers = {"Authorization": f"Bearer {settings.minimax_api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=None if stream else 45) as client:
        response = await client.post(f"{settings.minimax_base_url}/v1/chat/completions", json=payload, headers=headers)
        response.raise_for_status()
        return response


def heuristic_select(candidates: list[RawGeoCandidate]) -> list[PoiSummary]:
    weights = ["tourism", "historic", "museum", "artwork_type", "memorial", "viewpoint", "leisure", "natural", "amenity"]

    def score(candidate: RawGeoCandidate) -> tuple[int, float]:
        tag_blob = " ".join([*candidate.tags.keys(), *candidate.tags.values()]).lower()
        rank = sum(1 for word in weights if word in tag_blob)
        return (-rank, candidate.distanceMeters)

    selected = sorted(candidates, key=score)[:10]
    return [
        PoiSummary(
            id=item.id,
            name=item.name,
            lat=item.lat,
            lng=item.lng,
            category=item.tags.get("tourism") or item.tags.get("historic") or item.tags.get("amenity") or "Place",
            oneLiner=f"A nearby place worth a closer look, about {round(item.distanceMeters)} m away.",
            confidence=0.45,
            sourceRefs=["OpenStreetMap"],
        )
        for item in selected
    ]


async def select_pois(settings: Settings, candidates: list[RawGeoCandidate], language: str) -> list[PoiSummary]:
    if not candidates:
        return []

    compact = [
        {
            "id": c.id,
            "name": c.name,
            "lat": c.lat,
            "lng": c.lng,
            "distanceMeters": c.distanceMeters,
            "tags": {k: v for k, v in c.tags.items() if k in {"tourism", "historic", "amenity", "leisure", "natural", "building", "place", "waterway"}},
        }
        for c in candidates[:60]
    ]
    prompt = (
        "Select up to 10 POIs for a polished mobile travel guide. "
        "Return ONLY a JSON array. Each item must contain id, name, lat, lng, category, oneLiner, confidence. "
        f"Use language: {language}. Prefer culturally interesting, scenic, historic, unusual, or locally meaningful places."
    )
    try:
        response = await minimax_chat(
            settings,
            [
                {"role": "system", "content": "You are a precise travel guide POI curator. You only output valid JSON."},
                {"role": "user", "content": f"{prompt}\nCandidates:\n{json.dumps(compact, ensure_ascii=False)}"},
            ],
        )
        content = response.json()["choices"][0]["message"]["content"]
        items = _extract_json_array(content)
        return [PoiSummary(**item) for item in items[:10]]
    except Exception:
        return heuristic_select(candidates)


async def brave_search(settings: Settings, query: str, image: bool = False) -> dict[str, Any]:
    if not settings.brave_api_key:
        return {}
    endpoint = "/res/v1/images/search" if image else "/res/v1/web/search"
    headers = {"X-Subscription-Token": settings.brave_api_key, "Accept": "application/json"}
    params = {"q": query, "count": 5}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{settings.brave_base_url}{endpoint}", headers=headers, params=params)
        response.raise_for_status()
        return response.json()


async def wikipedia_image(query: str, language: str = "en") -> str | None:
    lang = "de" if language.startswith("de") else "en"
    headers = {"User-Agent": "TravelGuideGenAI/0.1 (local prototype; olive@example.local)"}
    async with httpx.AsyncClient(timeout=15, headers=headers, follow_redirects=True) as client:
        variants = [query, query.replace(" ", "_")]
        if lang == "de":
            variants.append(f"{query}_(Berlin)")
        for title in variants:
            summary = await client.get(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(title)}")
            if summary.status_code != 200:
                continue
            data = summary.json()
            image_url = (data.get("thumbnail") or {}).get("source") or (data.get("originalimage") or {}).get("source")
            if image_url:
                return image_url
    return None


def fallback_photo_url(poi: PoiSummary) -> str:
    text = f"{poi.name} {poi.category}".lower()
    if "river" in text or "water" in text or "riverside" in text:
        return "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=480&q=70"
    if "bridge" in text:
        return "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=480&q=70"
    if "park" in text or "garden" in text or "view" in text:
        return "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=480&q=70"
    if "museum" in text or "historic" in text or "memorial" in text:
        return "https://images.unsplash.com/photo-1566127444979-b3d2b654e3d7?auto=format&fit=crop&w=480&q=70"
    if "hall" in text or "square" in text or "civic" in text:
        return "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=480&q=70"
    if "art" in text or "sculpture" in text:
        return "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?auto=format&fit=crop&w=480&q=70"
    return "https://images.unsplash.com/photo-1473959383416-7d6c84d75c0e?auto=format&fit=crop&w=480&q=70"


async def enrich_poi(settings: Settings, poi: PoiSummary, language: str) -> PoiSummary:
    query = f"{poi.name} travel guide landmark"
    try:
        web = await brave_search(settings, query)
        try:
            images = await brave_search(settings, query, image=True)
        except Exception:
            images = {}
        results = web.get("web", {}).get("results", [])[:5]
        image_results = images.get("results", [])[:5]
        image_url = None
        for item in image_results:
            image_url = item.get("thumbnail", {}).get("src") or item.get("properties", {}).get("url") or item.get("url")
            if image_url:
                break
        if not image_url:
            try:
                image_url = await wikipedia_image(poi.name, language)
            except Exception:
                image_url = None
        snippets = [{"title": r.get("title"), "description": r.get("description"), "url": r.get("url")} for r in results]
        prompt = (
            "Create compact card metadata for this POI. Return ONLY JSON with category and oneLiner. "
            f"Language: {language}. One-liner max 110 characters.\nPOI: {poi.model_dump_json()}\nSources: {json.dumps(snippets, ensure_ascii=False)}"
        )
        try:
            response = await minimax_chat(
                settings,
                [
                    {"role": "system", "content": "You write concise, accurate travel guide card copy. Only valid JSON."},
                    {"role": "user", "content": prompt},
                ],
            )
            metadata = json.loads(response.json()["choices"][0]["message"]["content"])
            poi.category = metadata.get("category") or poi.category
            poi.oneLiner = metadata.get("oneLiner") or poi.oneLiner
        except Exception:
            if snippets and snippets[0].get("description"):
                poi.oneLiner = snippets[0]["description"][:140]
        poi.imageUrl = image_url or poi.imageUrl
        if not poi.imageUrl:
            poi.imageUrl = fallback_photo_url(poi)
        poi.sourceRefs = [r["url"] for r in snippets if r.get("url")]
        return poi
    except Exception:
        if not poi.imageUrl:
            poi.imageUrl = fallback_photo_url(poi)
        return poi


async def stream_detail(settings: Settings, poi: PoiSummary, language: str) -> AsyncIterator[str]:
    sources = []
    try:
        web = await brave_search(settings, f"{poi.name} history travel guide")
        sources = web.get("web", {}).get("results", [])[:5]
    except Exception:
        sources = []

    prompt = (
        f"Write a beautiful, well-researched mobile travel guide entry in {language}. "
        "Tone: vivid, concise, useful, premium guidebook. Mention why it matters, what to notice, and a tiny exploration tip. "
        "Avoid unsupported claims. Length: 3-5 short paragraphs.\n"
        f"POI: {poi.model_dump_json()}\nSources: {json.dumps(sources, ensure_ascii=False)}"
    )
    headers = {"Authorization": f"Bearer {settings.minimax_api_key}", "Content-Type": "application/json"}
    payload = {
        "model": settings.minimax_model,
        "messages": [
            {"role": "system", "content": "You are an excellent travel guide writer."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.45,
        "stream": True,
        "reasoning_split": True,
    }
    try:
        in_thinking = False
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{settings.minimax_base_url}/v1/chat/completions", json=payload, headers=headers) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:]
                    if raw == "[DONE]":
                        break
                    try:
                        chunk = json.loads(raw)
                        text = chunk["choices"][0].get("delta", {}).get("content")
                        if text:
                            visible = text
                            while visible:
                                if in_thinking:
                                    end = visible.find("</think>")
                                    if end == -1:
                                        visible = ""
                                    else:
                                        visible = visible[end + len("</think>") :]
                                        in_thinking = False
                                else:
                                    start = visible.find("<think>")
                                    if start == -1:
                                        yield visible
                                        visible = ""
                                    else:
                                        if start > 0:
                                            yield visible[:start]
                                        visible = visible[start + len("<think>") :]
                                        in_thinking = True
                    except Exception:
                        continue
    except Exception:
        fallback = (
            f"{poi.name} is one of the nearby places worth slowing down for. "
            "The available map and search signals suggest it may add local texture to your walk. "
            "Take a moment to look at the surroundings, the building details, and how people use the space today."
        )
        for word in fallback.split(" "):
            yield word + " "
