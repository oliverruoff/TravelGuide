from backend.services import normalize_overpass


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
