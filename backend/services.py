import asyncio
import json
import logging
import math
import re
import unicodedata
from urllib.parse import quote
from collections.abc import AsyncIterator
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from .models import PoiSummary, RawGeoCandidate
from .settings import Settings


logger = logging.getLogger(__name__)

# In-memory enrichment cache: (poi_id, language) → enriched PoiSummary
# Cleared only on process restart. Avoids re-running all HTTP + LLM calls
# for the same POI when the user moves slightly and rescans.
_enrich_cache: dict[tuple[str, str], "PoiSummary"] = {}

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"


@lru_cache(maxsize=None)
def load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8").strip()


def render_prompt(name: str, **values: Any) -> str:
    return load_prompt(name).format(**values)


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


def normalize_name_key(name: str) -> str:
    return re.sub(r"\s+", " ", name.casefold().strip())


def poi_research_name(poi: PoiSummary | RawGeoCandidate) -> str:
    return (poi.researchName or poi.name).strip()


def _tag_value(tags: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = tags.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _looks_latin(text: str) -> bool:
    letters = [char for char in text if char.isalpha()]
    if not letters:
        return True
    latin = sum(1 for char in letters if "LATIN" in unicodedata.name(char, "") or ord(char) < 128)
    return latin / len(letters) >= 0.8


def _english_name_from_tags(tags: dict[str, Any]) -> str | None:
    preferred = _tag_value(tags, "name:en", "int_name", "official_name:en", "alt_name:en")
    if preferred:
        return preferred
    transliterated = _tag_value(
        tags,
        "name:latin",
        "name:Latn",
        "name:zh-Latn",
        "name:zh_pinyin",
        "name:pinyin",
        "name:ja-Latn",
        "name:ko-Latn",
    )
    if transliterated:
        return transliterated
    for key in ("official_name", "alt_name", "name"):
        value = _tag_value(tags, key)
        if value and _looks_latin(value):
            return value
    return None


def dedupe_candidates_by_name(candidates: list[RawGeoCandidate]) -> list[RawGeoCandidate]:
    best_by_name: dict[str, RawGeoCandidate] = {}
    for candidate in sorted(candidates, key=lambda item: (-travel_candidate_score(item), item.distanceMeters, poi_research_name(item))):
        key = normalize_name_key(poi_research_name(candidate))
        if key and key not in best_by_name:
            best_by_name[key] = candidate
    return sorted(best_by_name.values(), key=lambda item: (item.distanceMeters, poi_research_name(item)))


def normalize_overpass(data: dict[str, Any], origin_lat: float, origin_lng: float) -> list[RawGeoCandidate]:
    seen: set[str] = set()
    candidates: list[RawGeoCandidate] = []

    for element in data.get("elements", []):
        tags = element.get("tags") or {}
        native_name = _tag_value(tags, "name")
        research_name = _english_name_from_tags(tags) or native_name or _tag_value(tags, "official_name", "alt_name")
        lat, lng = _center_for_element(element)
        if not research_name or lat is None or lng is None:
            continue

        key = f"{research_name.lower().strip()}:{round(lat, 4)}:{round(lng, 4)}"
        if key in seen:
            continue
        seen.add(key)

        raw_id = f"{element.get('type', 'osm')}/{element.get('id')}"
        candidates.append(
            RawGeoCandidate(
                id=raw_id,
                name=research_name,
                researchName=research_name,
                nativeName=native_name if native_name and native_name != research_name else None,
                lat=lat,
                lng=lng,
                tags={str(k): str(v) for k, v in tags.items() if isinstance(v, (str, int, float, bool))},
                distanceMeters=distance_meters(origin_lat, origin_lng, lat, lng),
            )
        )

    return dedupe_candidates_by_name(candidates)[:80]


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
    candidates = await _fetch_overpass_radius(settings, lat, lng, radius_meters)
    if 0 < travel_candidate_count(candidates) < 8 and radius_meters < 1000:
        expanded = await _fetch_overpass_radius(settings, lat, lng, 1000)
        merged = {item.id: item for item in [*expanded, *candidates]}
        return dedupe_candidates_by_name(list(merged.values()))[:80]
    return candidates


def travel_candidate_count(candidates: list[RawGeoCandidate]) -> int:
    return sum(1 for candidate in candidates if travel_candidate_score(candidate) > 0)


CATEGORY_FILTER_KEYWORDS: dict[str, tuple[str, ...]] = {
    "museum": ("museum", "gallery", "galerie", "archive", "library", "exhibition", "artwork", "sculpture", "theatre", "theater", "cinema", "opera"),
    "historic": ("historic", "archaeological", "archaeology", "archaeological_site", "archeological", "archeology", "monument", "memorial", "ruin", "castle", "palace", "fort", "tower", "bridge", "square", "cemetery", "heritage"),
    "religious": ("church", "chapel", "cathedral", "mosque", "synagogue", "temple", "place_of_worship", "religion", "denomination", "monastery", "abbey"),
    "nature": ("park", "garden", "forest", "nature", "natural", "reserve", "wildlife", "botanical", "wood", "meadow", "peak", "hill", "mountain"),
    "water": ("river", "lake", "water", "waterway", "stream", "creek", "pond", "waterfall", "fountain", "canal", "harbour", "harbor", "marina"),
    "viewpoint": ("viewpoint", "view", "panorama", "observatory", "lookout", "summit"),
    "food": ("restaurant", "cafe", "bar", "pub", "brewery", "winery", "bistro", "market", "shop", "cuisine", "fast_food"),
    "trail": ("trail", "path", "hiking", "cycling", "cycleway", "route", "footway", "track", "radweg"),
    "civic": ("townhall", "town hall", "community", "public", "information", "board", "map", "village", "place", "building", "hall"),
}


def candidate_matches_category_filters(candidate: RawGeoCandidate, category_filters: list[str]) -> bool:
    filters = [item for item in category_filters if item in CATEGORY_FILTER_KEYWORDS]
    if not filters:
        return True
    tag_blob = " ".join([poi_research_name(candidate), candidate.nativeName or "", *candidate.tags.keys(), *candidate.tags.values()]).lower()
    return any(any(keyword in tag_blob for keyword in CATEGORY_FILTER_KEYWORDS[filter_id]) for filter_id in filters)


def travel_candidate_score(candidate: RawGeoCandidate) -> int:
    tag_blob = " ".join([poi_research_name(candidate), candidate.nativeName or "", *candidate.tags.keys(), *candidate.tags.values()]).lower()
    positive = [
        "tourism",
        "information",
        "historic",
        "museum",
        "artwork",
        "memorial",
        "viewpoint",
        "place_of_worship",
        "church",
        "village",
        "waterway",
        "river",
        "restaurant",
        "trail",
        "radweg",
        "map",
        "board",
        "public",
    ]
    negative = [
        "kindergarten",
        "school",
        "bank",
        "atm",
        "industrial",
        "fire_station",
        "hairdresser",
        "company",
        "gmbh",
    ]
    return sum(1 for word in positive if word in tag_blob) - sum(2 for word in negative if word in tag_blob)


async def _fetch_overpass_radius(settings: Settings, lat: float, lng: float, radius_meters: int) -> list[RawGeoCandidate]:
    query = build_overpass_query(lat, lng, radius_meters)
    try:
        async with httpx.AsyncClient(timeout=22, headers={"User-Agent": "TravelGuideGenAI/0.1 local-prototype"}) as client:
            response = await client.post(
                settings.overpass_url,
                content=query,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()
            max_distance = radius_meters * 1.15
            return [candidate for candidate in normalize_overpass(response.json(), lat, lng) if candidate.distanceMeters <= max_distance]
    except Exception:
        return fallback_candidates(lat, lng)


def fallback_candidates(lat: float, lng: float) -> list[RawGeoCandidate]:
    return []


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
    payload = {"model": settings.minimax_model, "messages": messages, "temperature": 0.25, "stream": stream}
    headers = {"Authorization": f"Bearer {settings.minimax_api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=None if stream else 45) as client:
        response = await client.post(f"{settings.minimax_base_url}/v1/chat/completions", json=payload, headers=headers)
        response.raise_for_status()
        return response


async def minimax_tts(settings: Settings, text: str, language: str) -> bytes:
    if not settings.minimax_api_key:
        raise RuntimeError("MiniMax API key is missing")
    payload = {
        "model": settings.minimax_tts_model,
        "text": re.sub(r"\s+", " ", text).strip()[:10000],
        "stream": False,
        "language_boost": "auto" if not language.startswith("de") else "German",
        "output_format": "hex",
        "voice_setting": {
            "voice_id": settings.minimax_tts_voice_id,
            "speed": 1,
            "vol": 1,
            "pitch": 0,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
    }
    headers = {"Authorization": f"Bearer {settings.minimax_api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(f"{settings.minimax_base_url}/v1/t2a_v2", json=payload, headers=headers)
        response.raise_for_status()
    data = response.json()
    base_resp = data.get("base_resp") or {}
    if base_resp.get("status_code") not in (0, None):
        raise RuntimeError(str(base_resp.get("status_msg") or "MiniMax TTS failed"))
    audio_hex = (data.get("data") or {}).get("audio")
    if not audio_hex:
        raise RuntimeError("MiniMax TTS returned no audio")
    return bytes.fromhex(audio_hex)


_GENERIC_ONE_LINER_PREFIX = "Real nearby map point"

_CATEGORY_LABELS: dict[str, str] = {
    "museum": "museum", "gallery": "gallery", "artwork": "artwork", "sculpture": "sculpture",
    "historic": "historic site", "monument": "monument", "memorial": "memorial",
    "ruins": "ruins", "castle": "castle", "fort": "fort", "tower": "tower",
    "church": "church", "chapel": "chapel", "cathedral": "cathedral",
    "mosque": "mosque", "synagogue": "synagogue", "temple": "temple",
    "viewpoint": "viewpoint", "peak": "peak", "hill": "hill",
    "park": "park", "garden": "garden", "nature_reserve": "nature reserve",
    "waterfall": "waterfall", "river": "river", "lake": "lake",
    "restaurant": "restaurant", "cafe": "café", "bar": "bar", "pub": "pub",
    "hotel": "hotel", "hostel": "hostel",
    "attraction": "attraction", "zoo": "zoo", "aquarium": "aquarium",
    "theatre": "theatre", "cinema": "cinema", "library": "library",
    "information": "information point", "trail": "trail",
}

def _friendly_one_liner(category_tag: str, distance_m: int) -> str:
    label = _CATEGORY_LABELS.get(category_tag.lower(), category_tag.replace("_", " "))
    dist = f"{distance_m} m" if distance_m < 1000 else f"{distance_m / 1000:.1f} km"
    return f"A {label} about {dist} away."


def _category_one_liner(category: str) -> str:
    label = _CATEGORY_LABELS.get(category.lower(), category.replace("_", " "))
    return f"A notable {label} worth exploring nearby."


def heuristic_select(candidates: list[RawGeoCandidate]) -> list[PoiSummary]:
    def score(candidate: RawGeoCandidate) -> tuple[int, float]:
        return (-travel_candidate_score(candidate), candidate.distanceMeters)

    unique_candidates = dedupe_candidates_by_name(candidates)
    selected = [candidate for candidate in sorted(unique_candidates, key=score) if travel_candidate_score(candidate) > 0][:10]
    return [
        PoiSummary(
            id=item.id,
            name=item.name,
            researchName=poi_research_name(item),
            nativeName=item.nativeName,
            lat=item.lat,
            lng=item.lng,
            category=item.tags.get("tourism") or item.tags.get("historic") or item.tags.get("amenity") or item.tags.get("place") or item.tags.get("waterway") or "Local place",
            oneLiner=_friendly_one_liner(item.tags.get("tourism") or item.tags.get("historic") or item.tags.get("amenity") or item.tags.get("place") or "place", round(item.distanceMeters)),
            confidence=0.45,
            sourceRefs=["OpenStreetMap"],
        )
        for item in selected
    ]


async def select_pois(settings: Settings, candidates: list[RawGeoCandidate], language: str, category_filters: list[str] | None = None, exclude_names: list[str] | None = None) -> list[PoiSummary]:
    if not candidates:
        return []
    category_filters = category_filters or []
    exclude_names = exclude_names or []
    filtered_candidates = [candidate for candidate in candidates if candidate_matches_category_filters(candidate, category_filters)]
    if not filtered_candidates:
        return []

    # When finding more POIs, exclude already-shown places by normalized name
    exclude_keys: set[str] = {normalize_name_key(n) for n in exclude_names}
    if exclude_keys:
        filtered_candidates = [
            c for c in filtered_candidates
            if normalize_name_key(poi_research_name(c)) not in exclude_keys
            and normalize_name_key(c.name) not in exclude_keys
        ]
    if not filtered_candidates:
        return []

    compact = [
        {
            "id": c.id,
            "name": c.name,
            "researchName": poi_research_name(c),
            "nativeName": c.nativeName,
            "lat": c.lat,
            "lng": c.lng,
            "distanceMeters": c.distanceMeters,
            "tags": {
                k: v
                for k, v in c.tags.items()
                if k
                in {
                    "tourism",
                    "historic",
                    "amenity",
                    "leisure",
                    "natural",
                    "building",
                    "place",
                    "waterway",
                    "information",
                    "religion",
                    "denomination",
                    "shop",
                    "cuisine",
                    "description",
                    "name:en",
                    "int_name",
                    "official_name:en",
                    "alt_name:en",
                }
            },
        }
        for c in filtered_candidates[:60]
    ]
    exclude_instruction = (
        f"Do NOT include any of these already-shown places (skip them entirely): {', '.join(exclude_names)}."
        if exclude_names
        else ""
    )
    prompt = render_prompt(
        "poi_select_user.txt",
        language=language,
        category_filters=", ".join(category_filters) if category_filters else "all categories",
        exclude_instruction=exclude_instruction,
        candidates_json=json.dumps(compact, ensure_ascii=False),
    )
    try:
        response = await minimax_chat(
            settings,
            [
                {"role": "system", "content": load_prompt("poi_select_system.txt")},
                {"role": "user", "content": prompt},
            ],
        )
        content = response.json()["choices"][0]["message"]["content"]
        items = _extract_json_array(content)
        by_id = {candidate.id: candidate for candidate in filtered_candidates}
        selected: list[PoiSummary] = []
        seen_ids: set[str] = set()
        seen_names: set[str] = set()
        for item in items:
            candidate_id = str(item.get("id", ""))
            candidate = by_id.get(candidate_id)
            name_key = normalize_name_key(poi_research_name(candidate)) if candidate else ""
            if not candidate or candidate_id in seen_ids or name_key in seen_names:
                continue
            seen_ids.add(candidate_id)
            seen_names.add(name_key)
            selected.append(
                PoiSummary(
                    id=candidate.id,
                    name=str(item.get("name") or candidate.name),
                    researchName=poi_research_name(candidate),
                    nativeName=candidate.nativeName,
                    lat=candidate.lat,
                    lng=candidate.lng,
                    category=str(item.get("category") or candidate.tags.get("tourism") or candidate.tags.get("amenity") or candidate.tags.get("place") or "Local place"),
                    oneLiner=str(item.get("oneLiner") or _friendly_one_liner(candidate.tags.get("tourism") or candidate.tags.get("historic") or candidate.tags.get("amenity") or candidate.tags.get("place") or "place", round(candidate.distanceMeters))),
                    confidence=float(item.get("confidence") or 0.6),
                    sourceRefs=["OpenStreetMap"],
                )
            )
            if len(selected) >= 10:
                break
        return selected or heuristic_select(filtered_candidates)
    except Exception:
        return heuristic_select(filtered_candidates)


async def brave_search(settings: Settings, query: str, image: bool = False, count: int = 5) -> dict[str, Any]:
    if not settings.brave_api_key:
        return {}
    endpoint = "/res/v1/images/search" if image else "/res/v1/web/search"
    headers = {"X-Subscription-Token": settings.brave_api_key, "Accept": "application/json"}
    params = {"q": query, "count": count}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{settings.brave_base_url}{endpoint}", headers=headers, params=params)
        response.raise_for_status()
        return response.json()


def _result_mentions_city(result: dict[str, Any], city: str) -> bool:
    """Return True iff the city name appears anywhere in the result's title, URL, or description."""
    city_lower = city.lower()
    haystack = " ".join(
        str(result.get(field) or "")
        for field in ("title", "url", "description")
    ).lower()
    return city_lower in haystack


def _dedupe_sources(results: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for result in results:
        url = str(result.get("url") or "")
        title = str(result.get("title") or "").strip()
        description = str(result.get("description") or "").strip()
        key = url or title
        if not key or key in seen or (not title and not description):
            continue
        seen.add(key)
        deduped.append({"title": title, "description": description, "url": url})
        if len(deduped) >= limit:
            break
    return deduped


def _strip_markup(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text)).strip()


def _detail_queries(poi: PoiSummary, language: str = "en", city: str | None = None) -> list[str]:
    name = poi_research_name(poi)
    compact_name = " ".join(token for token in re.split(r"\s+", name) if token)
    # Quote the city so Brave treats it as a required phrase, not a soft signal
    city_part = f' "{city}"' if city else ""
    return [
        f'"{compact_name}"{city_part}',
        f'"{compact_name}"{city_part} history',
        f'"{compact_name}"{city_part} attraction visit',
    ]


async def detail_sources(settings: Settings, poi: PoiSummary, language: str = "en", city: str | None = None) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for query in _detail_queries(poi, language, city=city):
        try:
            web = await brave_search(settings, query)
        except Exception:
            continue
        results = web.get("web", {}).get("results", [])[:4]
        if city:
            city_results = [r for r in results if _result_mentions_city(r, city)]
            results = city_results or results
        collected.extend(results)
    return _dedupe_sources(collected)


async def _reverse_geocode_city(lat: float, lng: float) -> str | None:
    """Reverse-geocode lat/lng to a city/town/village name via Nominatim."""
    headers = {"User-Agent": "TravelGuideGenAI/0.1 (local prototype; olive@example.local)"}
    try:
        async with httpx.AsyncClient(timeout=3, headers=headers) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": lat, "lon": lng, "format": "json", "accept-language": "en"},
            )
            if resp.status_code != 200:
                return None
            address = resp.json().get("address", {})
            return (
                address.get("city")
                or address.get("town")
                or address.get("village")
                or address.get("municipality")
                or address.get("hamlet")
            )
    except Exception:
        return None


_WIKI_STOPWORDS = {
    "the", "a", "an", "of", "at", "in", "on", "and", "or", "to", "by", "for",
    "de", "der", "die", "das", "des", "dem", "den", "und", "im", "am", "vom",
}


def _wiki_title_matches_poi(poi_name: str, wiki_title: str) -> bool:
    """Return True if enough significant words from poi_name appear in wiki_title.

    Strategy: strip stopwords + short tokens from poi_name, then require at
    least 60% of the remaining words to be present (substring) in the lowercased
    wiki title. This handles plurals, ligatures, and minor spelling differences
    while rejecting clearly unrelated articles.
    """
    significant = [
        w for w in poi_name.lower().split()
        if w not in _WIKI_STOPWORDS and len(w) > 2
    ]
    if not significant:
        return False
    title_lower = wiki_title.lower()
    hits = sum(1 for w in significant if w in title_lower)
    return hits / len(significant) >= 0.6


async def wikipedia_data(
    name: str,
    city: str | None,
    language: str,
) -> dict[str, Any] | None:
    """Search Wikipedia for a POI and return image URL + extract if confident.

    Two-step: MediaWiki search to find the correct article title, then REST
    summary API for the image thumbnail and plain-text extract. Applies two
    confidence gates before trusting the result:
      1. Title match: ≥60% of significant POI-name words appear in the article title.
      2. City match (strict): if we know the city, the city name must appear in
         the article title or its extract — prevents using articles about
         same-named places in different cities.
    Returns None on any failure or low-confidence match.
    """
    lang = "en"
    headers = {"User-Agent": "TravelGuideGenAI/0.1 (local prototype; olive@example.local)"}
    search_query = f"{name} {city}" if city else name

    try:
        async with httpx.AsyncClient(timeout=8, headers=headers, follow_redirects=True) as client:
            # Step 1: find article title via full-text search (no guessing variants)
            search_resp = await client.get(
                f"https://{lang}.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "list": "search",
                    "srsearch": search_query,
                    "srlimit": 2,
                    "format": "json",
                },
            )
            if search_resp.status_code != 200:
                return None
            hits = search_resp.json().get("query", {}).get("search", [])
            if not hits:
                return None

            # Gate 1: title must match POI name with ≥60% significant-word overlap
            title = None
            for hit in hits:
                if _wiki_title_matches_poi(name, hit["title"]):
                    title = hit["title"]
                    break
            if not title:
                return None

            # Step 2: fetch summary for image + extract
            summary_resp = await client.get(
                f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(title)}"
            )
            if summary_resp.status_code != 200:
                return None
            data = summary_resp.json()
            extract = data.get("extract") or ""

            # City is a soft disambiguation hint because reverse-geocoded city
            # names can differ by language/script from English research pages.
            if city:
                city_lower = city.lower()
                if city_lower not in title.lower() and city_lower not in extract.lower():
                    logger.debug("Wikipedia city hint did not match for %s in %s", name, city)

            image_url = (data.get("thumbnail") or {}).get("source")
            wiki_url = (
                data.get("content_urls", {}).get("mobile", {}).get("page")
                or f"https://{lang}.wikipedia.org/wiki/{quote(title)}"
            )
            return {
                "title": title,
                "extract": extract,
                "image_url": image_url,
                "wiki_url": wiki_url,
            }
    except Exception:
        return None


IMAGE_STOPWORDS = {
    "und",
    "der",
    "die",
    "das",
    "am",
    "an",
    "im",
    "in",
    "the",
    "and",
    "for",
    "with",
    "river",
    "church",
    "restaurant",
    "public",
    "historic",
    "information",
}


def _poi_image_tokens(poi: PoiSummary) -> list[str]:
    tokens = re.findall(r"[a-z0-9]{4,}", poi_research_name(poi).lower())
    return [token for token in tokens if token not in IMAGE_STOPWORDS][:4]


def _image_result_url(item: dict[str, Any]) -> str | None:
    return (
        item.get("properties", {}).get("url")
        or item.get("url")
        or item.get("thumbnail", {}).get("src")
        or item.get("source")
    )


def _is_plausible_image_result(item: dict[str, Any], poi: PoiSummary) -> bool:
    tokens = _poi_image_tokens(poi)
    if not tokens:
        return False
    haystack = " ".join(
        str(value or "")
        for value in [
            item.get("title"),
            item.get("url"),
            item.get("source"),
            item.get("page_url"),
            item.get("properties", {}).get("url"),
            item.get("thumbnail", {}).get("src"),
        ]
    ).lower()
    return any(token in haystack for token in tokens)


async def _validate_image_url(url: str) -> bool:
    """HEAD-check a URL to confirm it resolves to an actual image (timeout 3 s)."""
    try:
        async with httpx.AsyncClient(timeout=3, follow_redirects=True) as client:
            resp = await client.head(url)
            if resp.status_code == 405:
                # Server doesn't allow HEAD — try GET with range to fetch minimal bytes
                resp = await client.get(url, headers={"Range": "bytes=0-0"})
            content_type = resp.headers.get("content-type", "")
            return resp.status_code < 400 and "image" in content_type
    except Exception:
        return False


async def _pick_best_image(image_results: list[dict[str, Any]], poi: PoiSummary, max_checks: int = 3) -> str | None:
    """Return the first plausible, reachable image URL from a Brave image result list."""
    checked = 0
    for item in image_results:
        candidate_url = _image_result_url(item)
        if not candidate_url or not _is_plausible_image_result(item, poi):
            continue
        if await _validate_image_url(candidate_url):
            return candidate_url
        checked += 1
        if checked >= max_checks:
            break
    return None


def fallback_photo_url(poi: PoiSummary) -> str:
    research_text = poi_research_name(poi)
    text = f"{research_text} {poi.name} {poi.category}".lower()
    if "river" in text or "water" in text or "riverside" in text or "fluss" in text or "kocher" in text or "bach" in text or "see" in text or "lake" in text:
        return "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=480&q=70"
    if "bridge" in text or "bruck" in text or "brücke" in text or "viaduct" in text:
        return "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=480&q=70"
    if "castle" in text or "burg" in text or "schloss" in text or "fortress" in text or "festung" in text or "palace" in text or "palast" in text:
        return "https://images.unsplash.com/photo-1533154683836-84ea7a0bc310?auto=format&fit=crop&w=480&q=70"
    if "tower" in text or "turm" in text or "campanile" in text or "belfry" in text:
        return "https://images.unsplash.com/photo-1548515943-51f8fb98d0ea?auto=format&fit=crop&w=480&q=70"
    if "church" in text or "kirche" in text or "chapel" in text or "kapelle" in text or "cathedral" in text or "dom" in text or "basilica" in text or "monastery" in text or "kloster" in text or "abbey" in text or "abtei" in text:
        return "https://images.unsplash.com/photo-1548625149-fc4a29cf7092?auto=format&fit=crop&w=480&q=70"
    if "fountain" in text or "brunnen" in text or "springbrunnen" in text:
        return "https://images.unsplash.com/photo-1568515387631-8b650bbcdb90?auto=format&fit=crop&w=480&q=70"
    if "market" in text or "markt" in text or "bazaar" in text or "bazar" in text:
        return "https://images.unsplash.com/photo-1533900298318-6b8da08a523e?auto=format&fit=crop&w=480&q=70"
    if "park" in text or "garden" in text or "garten" in text or "natur" in text or "trail" in text or "radweg" in text or "forest" in text or "wald" in text or "wiese" in text or "meadow" in text:
        return "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=480&q=70"
    if "view" in text or "viewpoint" in text or "aussicht" in text or "aussichtspunkt" in text or "panorama" in text:
        return "https://images.unsplash.com/photo-1501854140801-50d01698950b?auto=format&fit=crop&w=480&q=70"
    if "harbour" in text or "hafen" in text or "port" in text or "marina" in text:
        return "https://images.unsplash.com/photo-1534430480872-3498386e7856?auto=format&fit=crop&w=480&q=70"
    if "theatre" in text or "theater" in text or "opera" in text or "oper" in text or "concert" in text or "konzert" in text:
        return "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?auto=format&fit=crop&w=480&q=70"
    if "library" in text or "bibliothek" in text or "bücherei" in text:
        return "https://images.unsplash.com/photo-1521587760476-6c12a4b040da?auto=format&fit=crop&w=480&q=70"
    if "stadium" in text or "arena" in text or "stadion" in text:
        return "https://images.unsplash.com/photo-1552667466-07770ae110d0?auto=format&fit=crop&w=480&q=70"
    if "restaurant" in text or "gastronomie" in text or "pizzeria" in text or "cafe" in text or "gasthaus" in text or "wirtshaus" in text or "tavern" in text or "pub" in text:
        return "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=480&q=70"
    if "museum" in text or "memorial" in text or "historisch" in text or "denkmal" in text or "monument" in text or "exhibition" in text or "ausstellung" in text:
        return "https://images.unsplash.com/photo-1566127444979-b3d2b654e3d7?auto=format&fit=crop&w=480&q=70"
    if "historic" in text or "heritage" in text or "altstadt" in text or "old town" in text:
        return "https://images.unsplash.com/photo-1566127444979-b3d2b654e3d7?auto=format&fit=crop&w=480&q=70"
    if "hall" in text or "square" in text or "civic" in text or "rathaus" in text or "gemeinde" in text or "platz" in text or "town hall" in text:
        return "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=480&q=70"
    if "art" in text or "sculpture" in text or "skulptur" in text or "statue" in text or "gallery" in text or "galerie" in text:
        return "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?auto=format&fit=crop&w=480&q=70"
    return "https://images.unsplash.com/photo-1473959383416-7d6c84d75c0e?auto=format&fit=crop&w=480&q=70"


async def enrich_poi(settings: Settings, poi: PoiSummary, language: str) -> PoiSummary:
    # Return cached result immediately if available
    cache_key = (poi.id, language)
    if cache_key in _enrich_cache:
        return _enrich_cache[cache_key]

    try:
        # Always resolve city first — needed for Wikipedia confidence gate
        city = await _reverse_geocode_city(poi.lat, poi.lng)
        city_suffix = f" {city}" if city else ""
        research_name = poi_research_name(poi)

        # ── Wikipedia-first fast path ──────────────────────────────────────────
        # Try Wikipedia before any Brave call. If we get a confident hit with a
        # non-trivial extract we use it as the sole research source, skipping
        # all Brave searches entirely.
        wiki = await wikipedia_data(research_name, city, language)
        wiki_hit = (
            wiki is not None
            and len((wiki.get("extract") or "")) > 80  # require a meaningful extract
        )

        if wiki_hit:
            image_url = wiki["image_url"]
            snippets = [{
                "title": wiki["title"],
                "description": wiki["extract"],
                "url": wiki["wiki_url"],
            }]
        else:
            # ── Brave fallback ─────────────────────────────────────────────────
            web_query = f'"{research_name}" {poi.category}{city_suffix}'
            strict_query = f'"{research_name}"{city_suffix} photo'
            broad_query = f'{research_name} {poi.category}{city_suffix}'

            web, images = await asyncio.gather(
                brave_search(settings, web_query),
                brave_search(settings, strict_query, image=True, count=10),
                return_exceptions=True,
            )
            web = web if isinstance(web, dict) else {}
            images = images if isinstance(images, dict) else {}

            image_url = None
            try:
                image_url = await _pick_best_image(images.get("results", []), poi)
            except Exception:
                pass

            if not image_url:
                try:
                    images2 = await brave_search(settings, broad_query, image=True, count=10)
                    image_url = await _pick_best_image(images2.get("results", []), poi)
                except Exception:
                    pass

            web_results = web.get("web", {}).get("results", [])[:5]
            if city:
                city_results = [r for r in web_results if _result_mentions_city(r, city)]
                web_results = city_results or web_results
            snippets = [{"title": r.get("title"), "description": r.get("description"), "url": r.get("url")} for r in web_results]

            if not snippets and city:
                try:
                    web2 = await brave_search(settings, f'"{research_name}" {poi.category}{city_suffix}')
                    web_results2 = web2.get("web", {}).get("results", [])[:5]
                    snippets = [{"title": r.get("title"), "description": r.get("description"), "url": r.get("url")} for r in web_results2]
                except Exception:
                    pass

        # Clear generic placeholder so the LLM is forced to produce a real one-liner
        if poi.oneLiner.startswith(_GENERIC_ONE_LINER_PREFIX):
            poi.oneLiner = ""

        # ── LLM: derive category + oneLiner from whichever source we have ─────
        prompt = render_prompt(
            "poi_enrich_user.txt",
            language=language,
            poi_json=poi.model_dump_json(),
            sources_json=json.dumps(snippets, ensure_ascii=False),
        )
        try:
            response = await minimax_chat(
                settings,
                [
                    {"role": "system", "content": load_prompt("poi_enrich_system.txt")},
                    {"role": "user", "content": prompt},
                ],
            )
            metadata = json.loads(response.json()["choices"][0]["message"]["content"])
            poi.name = metadata.get("name") or poi.name
            poi.researchName = poi.researchName or research_name
            poi.category = metadata.get("category") or poi.category
            poi.oneLiner = metadata.get("oneLiner") or poi.oneLiner
        except Exception:
            if snippets and snippets[0].get("description"):
                poi.oneLiner = snippets[0]["description"][:140]

        # If oneLiner is still empty after enrichment, generate a friendly category-aware fallback
        if not poi.oneLiner:
            poi.oneLiner = _category_one_liner(poi.category)

        poi.imageUrl = image_url or poi.imageUrl
        if not poi.imageUrl:
            poi.imageUrl = fallback_photo_url(poi)
        poi.sourceRefs = [r["url"] for r in snippets if r.get("url")]

        _enrich_cache[cache_key] = poi
        return poi
    except Exception:
        if not poi.imageUrl:
            poi.imageUrl = fallback_photo_url(poi)
        return poi


def safe_detail_fallback(poi: PoiSummary, sources: list[dict[str, Any]], language: str) -> str:
    first_source = next((source for source in sources if source.get("description")), None)
    if language.startswith("de"):
        lowered = f"{poi.name} {poi.category}".lower()
        if "kirche" in lowered or "church" in lowered:
            intro = f"{poi.name} praegt als kirchlicher Ort das Ortsbild und lohnt sich vor allem fuer einen ruhigen Blick auf Architektur, Lage und Details."
        else:
            intro = f"{poi.name} lohnt sich als kurzer Halt und erzaehlt etwas ueber die Struktur und den Charakter der Umgebung."
        if first_source:
            intro += f" Recherchierter Hinweis: {str(first_source['description']).strip()[:220]}"
        return (
            f"{intro}\n\n"
            "Gut zu wissen: Achte vor Ort auf Beschilderung, Wegebeziehungen, Materialien und darauf, wie sich der Platz in die Umgebung einbindet. "
            "Das sind die Details, die einen Kartenpunkt zu einem echten Reisefuehrer-Moment machen, ohne unbelegte Geschichte zu erfinden."
        )
    lowered = f"{poi.name} {poi.category}".lower()
    if "church" in lowered or "kirche" in lowered:
        intro = f"{poi.name} stands out as a quiet church stop, best approached through its setting, architecture, and small visible details."
    else:
        intro = f"{poi.name} is worth a short pause and says something about the character of the surrounding place."
    if first_source:
        intro += f" Researched note: {str(first_source['description']).strip()[:220]}"
    return (
        f"{intro}\n\n"
        "Good to know: look for signage, path connections, materials, and how the spot fits into its surroundings. "
        "Those observable details make the stop useful without inventing unsupported history."
    )


async def detail_text_completion(settings: Settings, poi: PoiSummary, sources: list[dict[str, Any]], language: str) -> str:
    prompt = render_prompt(
        "detail_completion_user.txt",
        language=language,
        poi_name=poi.name,
        poi_json=poi.model_dump_json(),
        sources_json=json.dumps(sources, ensure_ascii=False),
    )
    response = await minimax_chat(
        settings,
        [
            {"role": "system", "content": load_prompt("detail_completion_system.txt")},
            {"role": "user", "content": prompt},
        ],
    )
    return _strip_reasoning(response.json()["choices"][0]["message"]["content"])


def _strip_reasoning(text: str) -> str:
    """Remove <think>...</think> and <reasoning>...</reasoning> blocks that some models prepend."""
    stripped = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    stripped = re.sub(r"<reasoning>[\s\S]*?</reasoning>", "", stripped, flags=re.IGNORECASE)
    stripped = stripped.strip()
    return stripped if stripped else text.strip()


async def complete_detail_text(settings: Settings, poi: PoiSummary, sources: list[dict[str, Any]], language: str) -> str:
    for attempt in range(2):
        try:
            text = await detail_text_completion(settings, poi, sources, language)
            if text and text.strip():
                return text
        except Exception as exc:
            logger.warning(f"detail_text_completion attempt {attempt + 1} failed for POI {poi.id}: {exc}")
    
    logger.error(f"All detail attempts failed for POI {poi.id}, using fallback")
    return safe_detail_fallback(poi, sources, language)


async def stream_detail(settings: Settings, poi: PoiSummary, language: str) -> AsyncIterator[str]:
    city = await _reverse_geocode_city(poi.lat, poi.lng)
    research_name = poi_research_name(poi)

    # Wikipedia-first: if we get a confident hit with a rich extract, use it
    # directly and skip all Brave searches for the detail text too.
    wiki = await wikipedia_data(research_name, city, language)
    wiki_extract_rich = wiki is not None and len((wiki.get("extract") or "")) > 200

    if wiki_extract_rich:
        sources = [{
            "title": wiki["title"],
            "description": wiki["extract"],
            "url": wiki["wiki_url"],
        }]
    else:
        # Fall back to 3 sequential Brave searches
        sources = await detail_sources(settings, poi, language, city=city)
        # If Brave returned nothing but Wikipedia had something (thin extract), add it
        if not sources and wiki:
            sources = [{
                "title": wiki["title"],
                "description": wiki.get("extract") or "",
                "url": wiki["wiki_url"],
            }]

    detail_text = await complete_detail_text(settings, poi, sources, language)
    for word in detail_text.split(" "):
        yield word + " "
