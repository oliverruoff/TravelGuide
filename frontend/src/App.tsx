import { AnimatePresence, motion, useDragControls } from 'framer-motion'
import { Award, Bookmark, Compass, Filter, Info, LocateFixed, MapPin, Moon, MousePointer2, Pin, PinOff, Play, PlusCircle, RefreshCw, Sparkles, Sun, Volume2, X } from 'lucide-react'
import maplibregl from 'maplibre-gl'
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { enrichPoi, getCandidates, getRuntimeConfig, selectPois, streamDetail, verifyPassword } from './api'
import { db, markVisited, savePoi, deletePoi, unlockAchievement, getCachedScan, putCachedScan, clearCachedScan, getCachedDetail, putCachedDetail, updatePoiDetailText, type StoredPoi } from './db'
import { useAppStore } from './store'
import type { GeoFix, PoiSummary } from './types'

const fallbackBerlin: GeoFix = { latitude: 52.520008, longitude: 13.404954, accuracyMeters: 9999, timestamp: Date.now() }
const savedFakeGeoKey = 'travelguide.fakeGeo'
const poiSearchRadiusMeters = 500
const maxPoiListItems = 50
const movingRefreshDistanceMeters = 140
const categoryFilterStorageKey = 'travelguide.categoryFilters'

const CATEGORY_FILTER_GROUPS = [
  {
    title: 'Culture',
    items: [
      { id: 'museum', label: 'Museums & arts', color: '#8B5CF6', hint: 'Museums, galleries, libraries, archives, exhibitions, artworks, sculptures, theatres, cinemas, opera houses.' },
      { id: 'historic', label: 'Historic places', color: '#A78BFA', hint: 'Historic sites, archaeological sites, monuments, memorials, ruins, castles, palaces, forts, towers, bridges, squares, cemeteries, heritage places.' },
      { id: 'religious', label: 'Sacred sites', color: '#EC4899', hint: 'Churches, chapels, cathedrals, mosques, synagogues, temples, monasteries, abbeys, other places of worship.' },
    ],
  },
  {
    title: 'Outdoors',
    items: [
      { id: 'nature', label: 'Parks & nature', color: '#22C55E', hint: 'Parks, gardens, forests, reserves, wildlife areas, botanical places, hills, mountains, peaks, summits.' },
      { id: 'water', label: 'Water', color: '#3B82F6', hint: 'Rivers, lakes, streams, creeks, ponds, waterfalls, fountains, canals, harbours, marinas.' },
      { id: 'viewpoint', label: 'Views', color: '#06B6D4', hint: 'Viewpoints, panoramas, lookouts, observatories, scenic views, miradors.' },
      { id: 'trail', label: 'Trails', color: '#10B981', hint: 'Trails, paths, hiking routes, cycling routes, walking routes, footways.' },
    ],
  },
  {
    title: 'Local life',
    items: [
      { id: 'food', label: 'Food & markets', color: '#84CC16', hint: 'Restaurants, cafes, bars, pubs, breweries, wineries, bistros, food shops, markets.' },
      { id: 'civic', label: 'Civic & info', color: '#F59E0B', hint: 'Town halls, public buildings, community places, information boards, maps, village/local place markers.' },
    ],
  },
] as const

type CategoryFilterId = typeof CATEGORY_FILTER_GROUPS[number]['items'][number]['id']
const ALL_CATEGORY_FILTERS = CATEGORY_FILTER_GROUPS.flatMap((group) => group.items.map((item) => item.id)) as CategoryFilterId[]

const CATEGORY_FILTER_KEYWORDS: Record<CategoryFilterId, string[]> = {
  museum: ['museum', 'library', 'archive', 'gallery', 'galerie', 'artwork', 'sculpture', 'theatre', 'theater', 'cinema', 'opera', 'arts', 'kunst', 'arte', 'art'],
  historic: ['historic', 'historisch', 'historique', 'histórico', 'archaeological', 'archaeology', 'archaeological_site', 'archeological', 'archeology', 'monument', 'memorial', 'denkmal', 'ruin', 'tower', 'bridge', 'square', 'cemetery', 'graveyard', 'castle', 'burg', 'schloss', 'palace', 'fort', 'heritage'],
  religious: ['church', 'kirche', 'chapel', 'cathedral', 'mosque', 'synagogue', 'temple', 'sacred', 'religious', 'monastery', 'abbey', 'église', 'iglesia'],
  nature: ['park', 'garden', 'garten', 'nature', 'natural', 'forest', 'reserve', 'wildlife', 'botanical', 'hill', 'mountain', 'peak', 'summit', 'jardin', 'parque'],
  water: ['river', 'lake', 'water', 'fluss', 'see', 'stream', 'creek', 'pond', 'waterfall', 'fountain', 'canal', 'harbour', 'harbor', 'marina', 'rivière', 'lac', 'agua'],
  viewpoint: ['viewpoint', 'aussicht', 'view', 'panorama', 'observatory', 'lookout', 'mirador', 'vue'],
  food: ['restaurant', 'cafe', 'café', 'bar', 'pub', 'brewery', 'winery', 'bistro', 'shop', 'market', 'markt', 'mercado', 'marché', 'food'],
  trail: ['trail', 'radweg', 'path', 'hiking', 'cycling', 'route', 'walk', 'sentier', 'camino'],
  civic: ['town hall', 'townhall', 'hall', 'rathaus', 'community', 'public', 'information', 'board', 'map', 'village', 'place', 'civic', 'mairie'],
}

// Lightweight markdown renderer — supports ##/### headings, **bold**, - bullets, paragraphs
function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let listItems: React.ReactNode[] = []
  let key = 0

  function flushList() {
    if (listItems.length > 0) {
      elements.push(<ul key={key++}>{listItems}</ul>)
      listItems = []
    }
  }

  function renderInline(raw: string): React.ReactNode[] {
    // Split on **bold** markers
    const parts = raw.split(/(\*\*[^*]+\*\*)/)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>
      }
      return part
    })
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('### ')) {
      flushList()
      elements.push(<h3 key={key++}>{renderInline(trimmed.slice(4))}</h3>)
    } else if (trimmed.startsWith('## ')) {
      flushList()
      elements.push(<h2 key={key++}>{renderInline(trimmed.slice(3))}</h2>)
    } else if (trimmed.startsWith('# ')) {
      flushList()
      elements.push(<h1 key={key++}>{renderInline(trimmed.slice(2))}</h1>)
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      listItems.push(<li key={key++}>{renderInline(trimmed.slice(2))}</li>)
    } else if (trimmed === '') {
      flushList()
    } else {
      flushList()
      elements.push(<p key={key++}>{renderInline(trimmed)}</p>)
    }
  }
  flushList()

  return <>{elements}</>
}

function getCategoryColor(category: string): string {
  const lower = (category || '').toLowerCase()
  if (lower.includes('museum') || lower.includes('library') || lower.includes('archive')) return '#8B5CF6'
  if (lower.includes('church') || lower.includes('kirche') || lower.includes('chapel') || lower.includes('cathedral') || lower.includes('mosque') || lower.includes('synagogue') || lower.includes('temple')) return '#EC4899'
  if (lower.includes('monument') || lower.includes('memorial') || lower.includes('denkmal') || lower.includes('historic') || lower.includes('ruin') || lower.includes('tower') || lower.includes('bridge') || lower.includes('square') || lower.includes('cemetery') || lower.includes('graveyard')) return '#A78BFA'
  if (lower.includes('castle') || lower.includes('burg') || lower.includes('schloss') || lower.includes('palace') || lower.includes('fort')) return '#F59E0B'
  if (lower.includes('viewpoint') || lower.includes('aussicht') || lower.includes('hill') || lower.includes('mountain') || lower.includes('peak') || lower.includes('summit') || lower.includes('observatory')) return '#06B6D4'
  if (lower.includes('restaurant') || lower.includes('cafe') || lower.includes('bar') || lower.includes('pub') || lower.includes('brewery') || lower.includes('winery') || lower.includes('bistro') || lower.includes('shop') || lower.includes('market')) return '#84CC16'
  if (lower.includes('trail') || lower.includes('radweg') || lower.includes('path') || lower.includes('hiking') || lower.includes('cycling')) return '#10B981'
  if (lower.includes('river') || lower.includes('lake') || lower.includes('water') || lower.includes('fluss') || lower.includes('see') || lower.includes('stream') || lower.includes('creek') || lower.includes('pond') || lower.includes('waterfall') || lower.includes('fountain') || lower.includes('canal') || lower.includes('bay') || lower.includes('harbour') || lower.includes('harbor')) return '#3B82F6'
  if (lower.includes('artwork') || lower.includes('sculpture') || lower.includes('galerie') || lower.includes('gallery') || lower.includes('theatre') || lower.includes('theater') || lower.includes('cinema') || lower.includes('opera')) return '#D946EF'
  if (lower.includes('park') || lower.includes('garden') || lower.includes('garten') || lower.includes('nature') || lower.includes('forest') || lower.includes('reserve') || lower.includes('wildlife') || lower.includes('botanical')) return '#22C55E'
  return ''
}

function readStoredCategoryFilters(): CategoryFilterId[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(categoryFilterStorageKey) || 'null')
    if (!Array.isArray(parsed)) return ALL_CATEGORY_FILTERS
    const valid = parsed.filter((item): item is CategoryFilterId => ALL_CATEGORY_FILTERS.includes(item))
    return valid
  } catch {
    return ALL_CATEGORY_FILTERS
  }
}

function categoryFilterSignature(filters: CategoryFilterId[]): string {
  return filters.slice().sort().join('-') || 'none'
}

function poiMatchesCategoryFilters(poi: PoiSummary, filters: CategoryFilterId[]): boolean {
  if (filters.length === 0) return false
  if (filters.length === ALL_CATEGORY_FILTERS.length) return true
  const text = `${poi.category} ${poi.name} ${poi.researchName ?? ''} ${poi.nativeName ?? ''}`.toLowerCase()
  return filters.some((filter) => CATEGORY_FILTER_KEYWORDS[filter].some((keyword) => text.includes(keyword)))
}

function distanceMeters(a: GeoFix, b: GeoFix) {
  const radius = 6371000
  const lat1 = a.latitude * Math.PI / 180
  const lat2 = b.latitude * Math.PI / 180
  const dLat = (b.latitude - a.latitude) * Math.PI / 180
  const dLng = (b.longitude - a.longitude) * Math.PI / 180
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`
  }
  return `${(meters / 1000).toFixed(1)}km`
}

function poiNameKey(poi: PoiSummary) {
  return (poi.researchName ?? poi.name).trim().toLowerCase().replace(/\s+/g, ' ')
}

function mergeIncomingPois(current: PoiSummary[], incoming: PoiSummary[]) {
  const seen = new Set<string>()
  const merged: PoiSummary[] = []
  for (const poi of [...incoming, ...current]) {
    const key = poiNameKey(poi)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(poi)
    if (merged.length >= maxPoiListItems) break
  }
  return merged
}

function radiusFeature(geo: GeoFix, radiusMeters: number) {
  const points: [number, number][] = []
  const earthRadius = 6371000
  const lat = geo.latitude * Math.PI / 180
  const lng = geo.longitude * Math.PI / 180
  const angularDistance = radiusMeters / earthRadius

  for (let i = 0; i <= 96; i += 1) {
    const bearing = (i / 96) * 2 * Math.PI
    const pointLat = Math.asin(
      Math.sin(lat) * Math.cos(angularDistance) +
      Math.cos(lat) * Math.sin(angularDistance) * Math.cos(bearing)
    )
    const pointLng = lng + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat),
      Math.cos(angularDistance) - Math.sin(lat) * Math.sin(pointLat)
    )
    points.push([pointLng * 180 / Math.PI, pointLat * 180 / Math.PI])
  }

  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'Polygon' as const,
      coordinates: [points],
    },
  }
}

function searchRadiusFeature(geo: GeoFix) {
  return radiusFeature(geo, poiSearchRadiusMeters)
}

function searchFallbackRadiusFeature(geo: GeoFix) {
  return radiusFeature(geo, 1000)
}

function rasterMapStyle(theme: 'light' | 'dark'): maplibregl.StyleSpecification {
  const isDark = theme === 'dark'
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [
          isDark
            ? 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
            : 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [{
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: {
        'raster-saturation': isDark ? -0.18 : -0.1,
        'raster-contrast': isDark ? 0.1 : 0,
      },
    }],
  }
}

function searchRadiusBounds(geo: GeoFix): [[number, number], [number, number]] {
  const latOffset = poiSearchRadiusMeters / 111320
  const lngOffset = poiSearchRadiusMeters / (111320 * Math.cos(geo.latitude * Math.PI / 180))
  return [
    [geo.longitude - lngOffset, geo.latitude - latOffset],
    [geo.longitude + lngOffset, geo.latitude + latOffset],
  ]
}

function updateSearchRadiusOverlay(map: maplibregl.Map, geo: GeoFix, overlay: HTMLDivElement | null) {
  if (!overlay) return
  const center = map.project([geo.longitude, geo.latitude])
  const lngOffset = poiSearchRadiusMeters / (111320 * Math.cos(geo.latitude * Math.PI / 180))
  const latOffset = poiSearchRadiusMeters / 111320
  const east = map.project([geo.longitude + lngOffset, geo.latitude])
  const north = map.project([geo.longitude, geo.latitude + latOffset])
  const radius = Math.max(Math.abs(east.x - center.x), Math.abs(center.y - north.y))
  overlay.style.width = `${radius * 2}px`
  overlay.style.height = `${radius * 2}px`
  overlay.style.transform = `translate(${center.x - radius}px, ${center.y - radius}px)`
}

function ensureSearchRadiusLayer(map: maplibregl.Map, geo: GeoFix) {
  // 500 m primary circle
  const existing = map.getSource('poi-search-radius') as maplibregl.GeoJSONSource | undefined
  if (existing) {
    existing.setData(searchRadiusFeature(geo))
  } else {
    map.addSource('poi-search-radius', {
      type: 'geojson',
      data: searchRadiusFeature(geo),
    })
    map.addLayer({
      id: 'poi-search-radius-fill',
      type: 'fill',
      source: 'poi-search-radius',
      paint: {
        'fill-color': '#ffffff',
        'fill-opacity': 0,
      },
    })
    map.addLayer({
      id: 'poi-search-radius-line',
      type: 'line',
      source: 'poi-search-radius',
      paint: {
        'line-color': '#7facff',
        'line-width': 2,
        'line-opacity': 0.32,
      },
    })
  }

  // 1000 m fallback circle (dashed, more subtle)
  const existingFallback = map.getSource('poi-fallback-radius') as maplibregl.GeoJSONSource | undefined
  if (existingFallback) {
    existingFallback.setData(searchFallbackRadiusFeature(geo))
  } else {
    map.addSource('poi-fallback-radius', {
      type: 'geojson',
      data: searchFallbackRadiusFeature(geo),
    })
    map.addLayer({
      id: 'poi-fallback-radius-line',
      type: 'line',
      source: 'poi-fallback-radius',
      paint: {
        'line-color': '#7facff',
        'line-width': 1.5,
        'line-opacity': 0.22,
        'line-dasharray': [4, 5],
      },
    })
  }
}

function fitSearchRadius(map: maplibregl.Map, geo: GeoFix, duration = 900) {
  map.fitBounds(searchRadiusBounds(geo), {
    padding: { top: 44, right: 42, bottom: 42, left: 42 },
    maxZoom: 16,
    duration,
    essential: false,
  })
}

function uniquePoisByName(pois: PoiSummary[]) {
  const seen = new Set<string>()
  return pois.filter((poi) => {
    const key = poiNameKey(poi)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readSavedFakeGeo(): GeoFix | undefined {
  try {
    const raw = localStorage.getItem(savedFakeGeoKey)
    return raw ? JSON.parse(raw) as GeoFix : undefined
  } catch {
    return undefined
  }
}

function PasswordGate() {
  const setToken = useAppStore((state) => state.setToken)
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    if (!password.trim()) return
    setLoading(true)
    setError(false)
    const token = await verifyPassword(password)
    setLoading(false)
    if (token) {
      setToken(token)
    } else {
      setError(true)
      setPassword('')
    }
  }

  return (
    <main className="onboarding">
      <motion.section initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="onboarding-card">
        <div className="brand-mark"><Compass size={28} /></div>
        <h1>TravelGuide</h1>
        <p>Your AI travel cards for places around you.</p>
        <label>
          Access password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            type="password"
            placeholder="Enter access password"
            autoFocus
          />
        </label>
        {error && <p className="onboarding-error">Incorrect password. Please try again.</p>}
        <button className="primary" onClick={handleSubmit} disabled={loading || !password.trim()}>
          <LocateFixed size={18} /> {loading ? 'Checking…' : 'Start exploring'}
        </button>
      </motion.section>
    </main>
  )
}

function MapPanel({
  geo,
  pois,
  activePoi,
  locationLabel,
  fakeLocationMode,
  locationInfoOpen,
  theme,
  onToggleTheme,
  onLocationBadgeClick,
  onLocationInfoClose,
  onPickLocation,
  onSelect,
  onOpenPoi
}: {
  geo: GeoFix
  pois: PoiSummary[]
  activePoi?: PoiSummary
  locationLabel: string
  fakeLocationMode: boolean
  locationInfoOpen: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onLocationBadgeClick: () => void
  onLocationInfoClose: () => void
  onPickLocation: (geo: GeoFix) => void
  onSelect: (poi: PoiSummary) => void
  onOpenPoi: (poi: PoiSummary) => void
}) {
  const mapNode = useRef<HTMLDivElement | null>(null)
  const radiusOverlayNode = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const markerNodes = useRef<Map<string, HTMLButtonElement>>(new Map())
  const userMarker = useRef<maplibregl.Marker | null>(null)

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return
    mapRef.current = new maplibregl.Map({
      container: mapNode.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors'
          }
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      },
      center: [geo.longitude, geo.latitude],
      zoom: 16,
      attributionControl: false
    })
    mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    mapRef.current.on('load', () => {
      const map = mapRef.current
      if (!map) return
      map.resize()
      ensureSearchRadiusLayer(map, geo)
      updateSearchRadiusOverlay(map, geo, radiusOverlayNode.current)
      fitSearchRadius(map, geo, 0)
    })
  }, [geo.latitude, geo.longitude, theme])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.setStyle(rasterMapStyle(theme))
    map.once('style.load', () => {
      ensureSearchRadiusLayer(map, geo)
      updateSearchRadiusOverlay(map, geo, radiusOverlayNode.current)
      fitSearchRadius(map, geo, 0)
    })
    // The basemap style should only be swapped for light/dark mode.
    // Location changes update the radius source in the geo effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  useEffect(() => {
    if (!mapRef.current) return
    const map = mapRef.current
    const updateRadius = () => {
      ensureSearchRadiusLayer(map, geo)
      updateSearchRadiusOverlay(map, geo, radiusOverlayNode.current)
      fitSearchRadius(map, geo)
    }
    if (map.loaded()) {
      updateRadius()
    } else {
      map.once('load', updateRadius)
    }
    if (!userMarker.current) {
      const node = document.createElement('div')
      node.className = 'user-marker'
      node.innerHTML = `
        <svg viewBox="0 0 32 44" aria-hidden="true">
          <path d="M16 42C11.2 34.3 4 27.4 4 16.4C4 9.5 9.4 4 16 4s12 5.5 12 12.4C28 27.4 20.8 34.3 16 42Z" />
          <circle cx="16" cy="16" r="5.3" />
        </svg>
      `
      userMarker.current = new maplibregl.Marker({ element: node, anchor: 'bottom' }).setLngLat([geo.longitude, geo.latitude]).addTo(mapRef.current)
    } else {
      userMarker.current.setLngLat([geo.longitude, geo.latitude])
    }
  }, [geo.latitude, geo.longitude])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const updateOverlay = () => updateSearchRadiusOverlay(map, geo, radiusOverlayNode.current)
    updateOverlay()
    map.on('move', updateOverlay)
    map.on('zoom', updateOverlay)
    map.on('resize', updateOverlay)
    return () => {
      map.off('move', updateOverlay)
      map.off('zoom', updateOverlay)
      map.off('resize', updateOverlay)
    }
  }, [geo.latitude, geo.longitude])

  useEffect(() => {
    if (!mapRef.current || !activePoi) return
    mapRef.current.flyTo({
      center: [activePoi.lng, activePoi.lat],
      zoom: Math.max(mapRef.current.getZoom(), 17),
      speed: 0.9,
      curve: 1.25,
      essential: true,
    })
  }, [activePoi?.id, activePoi?.lat, activePoi?.lng])

  useEffect(() => {
    markers.current.forEach((marker) => marker.remove())
    markers.current = []
    markerNodes.current.clear()
    pois.forEach((poi) => {
      const anchor = document.createElement('div')
      anchor.className = 'poi-marker-anchor'
      const node = document.createElement('button')
      node.type = 'button'
      node.className = 'poi-pin'
      node.title = poi.name
      node.style.setProperty('--cat-color', getCategoryColor(poi.category) || 'var(--accent)')
      node.innerHTML = `
        <span class="poi-pin-icon">
          <svg viewBox="0 0 32 44" aria-hidden="true">
            <path d="M16 42.2C11.2 34.9 4 27.9 4 16.1C4 8.4 9.4 2 16 2s12 6.4 12 14.1C28 27.9 20.8 34.9 16 42.2Z" />
            <circle cx="16" cy="16" r="5.2" />
          </svg>
        </span>
      `
      const label = document.createElement('span')
      label.className = 'poi-pin-label'
      const labelText = document.createElement('span')
      labelText.className = 'poi-pin-label-text'
      labelText.textContent = poi.name
      label.appendChild(labelText)
      node.appendChild(label)
      const openMarkerPoi = (event: MouseEvent | PointerEvent | TouchEvent) => {
        event.preventDefault()
        event.stopPropagation()
        onSelect(poi)
        onOpenPoi(poi)
      }
      node.addEventListener('click', openMarkerPoi)
      node.addEventListener('pointerup', openMarkerPoi)
      node.addEventListener('touchend', openMarkerPoi)
      anchor.appendChild(node)
      const marker = new maplibregl.Marker({ element: anchor, anchor: 'center', offset: [0, 0] }).setLngLat([poi.lng, poi.lat]).addTo(mapRef.current!)
      window.requestAnimationFrame(() => {
        const overflow = labelText.scrollWidth - label.clientWidth
        if (overflow > 2) {
          labelText.style.setProperty('--label-overflow', `${overflow}px`)
          labelText.classList.add('scrolling')
        }
      })
      markers.current.push(marker)
      markerNodes.current.set(poi.id, node)
    })
  }, [pois, onSelect, onOpenPoi])

  useEffect(() => {
    markerNodes.current.forEach((node, id) => {
      node.classList.toggle('active', activePoi?.id === id)
    })
  }, [activePoi?.id])

  useEffect(() => {
    if (!mapRef.current) return
    const map = mapRef.current
    const handlePick = (event: maplibregl.MapMouseEvent) => {
      if (!fakeLocationMode) return
      onPickLocation({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
        accuracyMeters: 5,
        timestamp: Date.now()
      })
    }
    map.on('click', handlePick)
    return () => {
      map.off('click', handlePick)
    }
  }, [fakeLocationMode, onPickLocation])

  function pickFromPointer(event: PointerEvent<HTMLButtonElement>) {
    if (!fakeLocationMode || !mapRef.current || !mapNode.current) return
    const rect = mapNode.current.getBoundingClientRect()
    const point: [number, number] = [event.clientX - rect.left, event.clientY - rect.top]
    const lngLat = mapRef.current.unproject(point)
    onPickLocation({
      latitude: lngLat.lat,
      longitude: lngLat.lng,
      accuracyMeters: 5,
      timestamp: Date.now()
    })
  }

  function recenterToPosition() {
    if (!mapRef.current) return
    fitSearchRadius(mapRef.current, geo, 700)
  }

  return (
    <section className={`map-shell ${fakeLocationMode ? 'picking-location' : ''}`}>
      <div ref={mapNode} className="map" />
      <div ref={radiusOverlayNode} className="search-radius-gradient" aria-hidden="true" />
      <button className="icon map-theme-toggle" onClick={onToggleTheme} aria-label="Toggle color theme">
        {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
      </button>
      {fakeLocationMode && <button className="fake-location-layer" onPointerDown={pickFromPointer} aria-label="Place fake location on map" />}
      <button className="accuracy" onClick={onLocationBadgeClick} aria-label="Choose location mode">
        <LocateFixed size={13} /> {locationLabel}
      </button>
      <button className="recenter-button" onClick={recenterToPosition} aria-label="Move map to my position">
        <LocateFixed size={17} />
      </button>
      <div className="radius-badge">AI search {poiSearchRadiusMeters} m</div>
      <AnimatePresence>
        {locationInfoOpen && (
          <motion.div
            className="location-info-card"
            style={{ x: '-50%', y: '-50%' }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.18 }}
          >
            <button className="location-info-close" onClick={onLocationInfoClose} aria-label="Close info"><X size={13} /></button>
            <p className="location-info-title"><Info size={13} /> How POIs are found</p>
            <p>Your position is scanned within a <strong>500 m radius</strong>. If fewer than 8 points of interest are found, the search automatically expands to <strong>1,000 m</strong> — shown as the dashed circle on the map.</p>
            <p>The scan updates when you move more than <strong>50 m</strong> from your last scan point. Use the refresh button to force a new scan immediately.</p>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {fakeLocationMode && (
          <motion.div className="pick-location-hint" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}>
            <MousePointer2 size={15} /> Tap the map to place yourself
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

function cleanOneLiner(text: string) {
  const node = document.createElement('textarea')
  node.innerHTML = text
  return node.value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

function fallbackImageForPoi(poi: PoiSummary) {
  const text = `${poi.researchName ?? poi.name} ${poi.name} ${poi.category}`.toLowerCase()
  if (text.includes('river') || text.includes('water') || text.includes('fluss') || text.includes('kocher')) {
    return 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=70'
  }
  if (text.includes('church') || text.includes('kirche') || text.includes('chapel')) {
    return 'https://images.unsplash.com/photo-1548625149-fc4a29cf7092?auto=format&fit=crop&w=640&q=70'
  }
  if (text.includes('restaurant') || text.includes('pizzeria') || text.includes('gastronomie') || text.includes('cafe')) {
    return 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=640&q=70'
  }
  if (text.includes('park') || text.includes('garden') || text.includes('natur') || text.includes('trail') || text.includes('radweg')) {
    return 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=640&q=70'
  }
  if (text.includes('historic') || text.includes('historisch') || text.includes('denkmal') || text.includes('museum')) {
    return 'https://images.unsplash.com/photo-1566127444979-b3d2b654e3d7?auto=format&fit=crop&w=640&q=70'
  }
  if (text.includes('hall') || text.includes('rathaus') || text.includes('gemeinde') || text.includes('square') || text.includes('platz')) {
    return 'https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=640&q=70'
  }
  return 'https://images.unsplash.com/photo-1473959383416-7d6c84d75c0e?auto=format&fit=crop&w=640&q=70'
}

function ensureGuideStartsWithName(poi: PoiSummary, text: string) {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed
}

function PoiVisual({ poi, loading, large = false }: { poi: PoiSummary; loading?: boolean; large?: boolean }) {
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setBroken(false)
  }, [poi.imageUrl])

  if (loading) {
    return <span className="image-spinner" />
  }

  return <img src={!broken && poi.imageUrl ? poi.imageUrl : fallbackImageForPoi(poi)} alt="" onError={() => setBroken(true)} />
}

function PoiCard({
  poi,
  index,
  centeredIndex,
  active,
  imageLoading,
  listRef,
  onSelect,
  onOpen,
  onRefresh,
  onVisible,
}: {
  poi: PoiSummary
  index: number
  centeredIndex: number
  active: boolean
  imageLoading?: boolean
  listRef: React.RefObject<HTMLDivElement | null>
  onSelect: () => void
  onOpen: () => void
  onRefresh?: () => void
  onVisible: (index: number) => void
}) {
  const cardRef = useRef<HTMLElement>(null)

  // IntersectionObserver: fires only when visibility crosses threshold.
  // No continuous scroll reading → no feedback loop possible.
  useEffect(() => {
    const el = cardRef.current
    const root = listRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onVisible(index) },
      { root, threshold: 0.5 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [index, listRef, onVisible])

  // Determine position relative to the currently centered card
  const position = index < centeredIndex ? 'above' : index > centeredIndex ? 'below' : 'centered'

  return (
    <article
      ref={cardRef}
      className={`poi-card ${active ? 'active' : ''} ${position}`}
      style={{ '--cat-color': getCategoryColor(poi.category) } as React.CSSProperties}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="thumb">
        <PoiVisual poi={poi} loading={imageLoading} />
      </div>
      <div className="poi-copy">
        <span>{poi.category}</span>
        <strong>{poi.name}</strong>
        {cleanOneLiner(poi.oneLiner) && <p>{cleanOneLiner(poi.oneLiner)}</p>}
      </div>
      <button
        className="card-detail-button"
        onClick={(event) => {
          event.stopPropagation()
          onOpen()
        }}
        aria-label={`Open details for ${poi.name}`}
      >
        <Sparkles size={16} /> Guide
      </button>
      {onRefresh && (
        <button
          className="card-refresh-button"
          onClick={(event) => {
            event.stopPropagation()
            onRefresh()
          }}
          aria-label={`Refresh ${poi.name}`}
          title="Re-research this POI"
        >
          <RefreshCw size={11} />
        </button>
      )}
    </article>
  )
}

function DetailCard({ poi, userGeo, onClose }: { poi: PoiSummary; userGeo?: GeoFix; onClose: () => void }) {
  const { language, floatingEnabled, toggleFloating } = useAppStore()
  const dragControls = useDragControls()
  const [text, setText] = useState('')
  const [displayedText, setDisplayedText] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [floatSettled, setFloatSettled] = useState(false)
  const [exitY, setExitY] = useState<'105%' | '-105%'>('105%')
  const [saveAnimationKey, setSaveAnimationKey] = useState<string | null>(null)
  const draftTextRef = useRef('')
  const displayIndexRef = useRef(0)
  const animationIdRef = useRef<number | null>(null)
  const fromCacheRef = useRef(false)

  useEffect(() => {
    setFloatSettled(false)
    const settleTimer = window.setTimeout(() => setFloatSettled(true), 1000)
    return () => clearTimeout(settleTimer)
  }, [poi.id])

  // Smooth character-by-character animation
  useEffect(() => {
    if (!text || displayedText.length === text.length) return

    const fast = fromCacheRef.current
    const scheduleNextChar = () => {
      displayIndexRef.current += 1
      setDisplayedText(text.slice(0, displayIndexRef.current))
      
      if (displayIndexRef.current < text.length) {
        // Variable delay for natural typing: 20-60ms between chars, longer after punctuation
        // When serving from cache, run 3× faster
        const nextChar = text[displayIndexRef.current]
        const delay = fast
          ? (['.', '!', '?', '\n'].includes(nextChar) ? 13 : Math.random() * 13 + 7)
          : (['.', '!', '?', '\n'].includes(nextChar) ? 40 : Math.random() * 40 + 20)
        animationIdRef.current = window.setTimeout(scheduleNextChar, delay)
      }
    }

    const initialDelay = window.setTimeout(scheduleNextChar, fast ? 17 : 50)
    return () => {
      clearTimeout(initialDelay)
      if (animationIdRef.current) clearTimeout(animationIdRef.current)
    }
  }, [text])

  useEffect(() => {
    const controller = new AbortController()
    draftTextRef.current = ''
    setText('')
    setDisplayedText('')
    displayIndexRef.current = 0
    fromCacheRef.current = false
    setLoading(true)
    setFailed(false)

    // Try to load from cache first
    getCachedDetail(poi.id, language).then((cached) => {
      if (cached) {
        fromCacheRef.current = true
        setText(cached)
        setLoading(false)
        return
      }

      streamDetail(
        poi,
        language,
        (chunk) => {
          draftTextRef.current += chunk
          // Update the full text (animation will handle display)
          const fullText = ensureGuideStartsWithName(poi, draftTextRef.current)
          setText(fullText)
          // Clear loading state once we have content
          if (fullText && loading) {
            setLoading(false)
          }
        },
        controller.signal,
        async () => {
          // Stream completed — persist to caches
          const finalText = ensureGuideStartsWithName(poi, draftTextRef.current)
          if (finalText) {
            await putCachedDetail(poi.id, language, finalText)
            // If this POI is user-saved, also update its stored detailText
            const saved = await db.savedPois.get(poi.id)
            if (saved) await updatePoiDetailText(poi.id, finalText)
          }
        }
      )
        .then(() => {
          const finalText = ensureGuideStartsWithName(poi, draftTextRef.current)
          setText(finalText)
          setFailed(!finalText)
          setLoading(false)
        })
        .catch(() => {
          setText('')
          setDisplayedText('')
          setLoading(false)
          setFailed(true)
        })
    })

    return () => {
      controller.abort()
      speechSynthesis.cancel()
      setSpeaking(false)
    }
  }, [poi, language])

  function playBrowserSpeech(speechText: string) {
    const utterance = new SpeechSynthesisUtterance(speechText)
    utterance.lang = language === 'de' ? 'de-DE' : 'en-US'
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    setSpeaking(true)
    speechSynthesis.speak(utterance)
  }

  async function speak() {
    if (speaking) {
      speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    const speechText = text || poi.oneLiner
    if (!speechText.trim()) return
    playBrowserSpeech(speechText)
  }

  function closeWithDirection(direction: 'up' | 'down' = 'down') {
    setExitY(direction === 'up' ? '-105%' : '105%')
    window.requestAnimationFrame(onClose)
  }

  function handleSave() {
    savePoi(poi)
    // Trigger the copy animation
    setSaveAnimationKey(Date.now().toString())
    // Reset after animation completes
    setTimeout(() => setSaveAnimationKey(null), 700)
  }

  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="mtg-card-container"
        style={{ '--cat-color': getCategoryColor(poi.category) } as React.CSSProperties}
        initial={{ y: '110%', rotateX: -12, scale: 0.9 }}
        animate={{ y: 0, rotateX: 0, scale: 1 }}
        exit={{ y: exitY, opacity: 0, scale: 0.92 }}
        transition={{ type: 'spring', damping: 24, stiffness: 200 }}
        drag="y"
        dragControls={dragControls}
        dragListener={false}
        dragElastic={0.18}
        dragConstraints={{ top: 0, bottom: 0 }}
        onDragEnd={(_, info) => {
          if (Math.abs(info.offset.y) > 120 || Math.abs(info.velocity.y) > 650) {
            closeWithDirection(info.offset.y < 0 || info.velocity.y < 0 ? 'up' : 'down')
          }
        }}
      >
        {/* Outer card frame */}
        <motion.div
          className="mtg-card"
          animate={!floatingEnabled ? { y: 0, rotateX: 0, rotateY: 0 } : floatSettled ? {
            y: [0, -8, -5, -9, -4, -8, 0],
            rotateX: [0, 1.5, 3, 1, 2.5, 0.5, 0],
            rotateY: [0, -2, 0.5, 2.5, -1, 1.5, 0],
          } : { y: [0, -7, 3, 0] }}
          transition={!floatingEnabled ? { duration: 0.3 } : floatSettled ? {
            duration: 7,
            ease: 'easeInOut',
            repeat: Infinity,
            repeatType: 'mirror',
          } : { duration: 1, ease: 'easeInOut', times: [0, 0.35, 0.72, 1] }}
          style={{ transformStyle: 'preserve-3d' }}
        >

          {/* Close button — floats above the card */}
          <button className="mtg-close" onClick={() => closeWithDirection('down')} aria-label="Close"><X size={18} /></button>

          {/* Inner coloured frame */}
          <div className="mtg-frame">

            {/* ── Title bar ── */}
            <div className="mtg-title-bar">
              <span className="mtg-name">{poi.name}</span>
              {userGeo && (
                <span className="mtg-cost"
                  title="Distance from you">
                  <MapPin size={11} />
                  {formatDistance(distanceMeters(userGeo, { latitude: poi.lat, longitude: poi.lng }))}
                </span>
              )}
            </div>

            {/* ── Art box ── */}
            <div
              className="mtg-art drag-handle"
              onPointerDown={(event) => dragControls.start(event.nativeEvent)}
            >
              <PoiVisual poi={poi} large />
              <div className="mtg-art-shine" />
              {/* drag handle pill */}
              <div className="mtg-drag-pill" />
            </div>

            {/* ── Type line ── */}
            <div className="mtg-type-line">
              <span className="mtg-type-text">Landmark — {poi.category}</span>
              <button
                className={`mtg-float-toggle ${floatingEnabled ? 'floating' : 'pinned'}`}
                onClick={toggleFloating}
                title={floatingEnabled ? 'Pin card (stop floating)' : 'Unpin card (enable floating)'}
                aria-label={floatingEnabled ? 'Pin card' : 'Unpin card'}
              >
                {floatingEnabled ? <Pin size={13} /> : <PinOff size={13} />}
              </button>
            </div>

            {/* ── Text box (parchment) ── */}
            <div className="mtg-textbox">
              {!text ? (
                <div className="guide-loading">
                  <strong>Researching guide text…</strong>
                  <div className="text-skeleton" aria-hidden="true">
                    <span /><span /><span /><span /><span />
                  </div>
                </div>
              ) : (
                <motion.div
                  className="mtg-flavor"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <SimpleMarkdown text={displayedText} />
                  {displayedText.length < text.length && <span className="typing-cursor" />}
                </motion.div>
              )}

              {!loading && text && poi.sourceRefs.length > 0 && (
                <details className="mtg-sources">
                  <summary>Sources</summary>
                  {poi.sourceRefs.slice(0, 4).map((source) => (
                    <a href={source} target="_blank" rel="noreferrer" key={source}>{source}</a>
                  ))}
                </details>
              )}
            </div>

            {/* ── Bottom bar: actions + P/T box ── */}
            <div className="mtg-bottom-bar">
              <div className="mtg-actions">
                <button className="mtg-btn save" onClick={handleSave}><Bookmark size={15} /> Collect</button>
                <button className="mtg-btn listen" onClick={speak}><Volume2 size={15} /> {speaking ? 'Stop' : 'Audio'}</button>
              </div>
              <div className="mtg-pt-box" title="Confidence score">
                {Math.round(poi.confidence * 100)}<span>/100</span>
              </div>
            </div>

          </div>{/* end .mtg-frame */}
        </motion.div>{/* end .mtg-card */}
      </motion.div>

      {/* Save animation */}
      <AnimatePresence>
        {saveAnimationKey && (
          <motion.div
            key={saveAnimationKey}
            className="save-copy-card"
            initial={{ scale: 1, x: 0, y: 0, opacity: 1 }}
            animate={{ scale: 0.08, x: 'calc(100% - 50px)', y: -100, opacity: 0 }}
            transition={{ duration: 0.7, ease: 'easeInOut' }}
            style={{ position: 'absolute', pointerEvents: 'none', originX: 0.5, originY: 0.5 }}
          >
            <div className="save-copy-inner">
              <PoiCard poi={poi} active={false} onSelect={() => {}} onOpen={() => {}} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function ConfirmDialog({ title, message, onConfirm, onCancel }: { title: string; message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div className="confirm-dialog-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel}>
      <motion.div className="confirm-dialog" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>Cancel</button>
          <button className="confirm-delete" onClick={onConfirm}>Delete</button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function SavedDrawer({ onClose, onOpenGuide }: { onClose: () => void; onOpenGuide: (poi: PoiSummary) => void }) {
  const [items, setItems] = useState<StoredPoi[]>([])
  const [deleteConfirm, setDeleteConfirm] = useState<string | undefined>()
  
  useEffect(() => {
    db.savedPois.orderBy('savedAt').reverse().toArray().then(setItems)
  }, [])
  
  const handleOpenGuide = (item: PoiSummary) => {
    onOpenGuide(item)
    onClose()
  }

  const handleDeletePoi = async (poiId: string) => {
    await deletePoi(poiId)
    setItems((prev) => prev.filter((item) => item.id !== poiId))
    setDeleteConfirm(undefined)
  }
  
  return (
    <>
      <motion.aside className="saved-drawer" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}>
        <button className="icon close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <h2>Deck of Cards</h2>
        {items.length === 0 ? (
          <p>No saved cards yet.</p>
        ) : (
          <div className="saved-pois-list">
            {items.map((item) => (
              <div key={item.id} className="saved-poi-wrapper">
                <PoiCard 
                  poi={item} 
                  active={false} 
                  onSelect={() => undefined} 
                  onOpen={() => handleOpenGuide(item)}
                />
                <button
                  className="delete-poi-btn"
                  onClick={() => setDeleteConfirm(item.id)}
                  aria-label={`Delete ${item.name}`}
                  title={`Delete ${item.name}`}
                >
                  <X size={18} />
                </button>
              </div>
            ))}
          </div>
        )}
      </motion.aside>
      <AnimatePresence>
        {deleteConfirm && (
          <ConfirmDialog
            title="Delete Saved POI?"
            message={`Are you sure you want to remove "${items.find((i) => i.id === deleteConfirm)?.name || 'this POI'}" from your saved list?`}
            onConfirm={() => handleDeletePoi(deleteConfirm)}
            onCancel={() => setDeleteConfirm(undefined)}
          />
        )}
      </AnimatePresence>
    </>
  )
}

const LANGUAGES = ['en', 'de', 'es', 'fr'] as const

function LanguagePicker({ language, onChange }: { language: string; onChange: (lang: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="lang-picker" ref={ref}>
      <button className="lang-trigger" onClick={() => setOpen((o) => !o)} aria-label="Language">
        {language}
      </button>
      {open && (
        <div className="lang-dropdown">
          {LANGUAGES.filter((l) => l !== language).map((l) => (
            <button key={l} className="lang-option" onClick={() => { onChange(l); setOpen(false) }}>
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryFilterPicker({
  selected,
  open,
  onOpenChange,
}: {
  selected: CategoryFilterId[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <div className="filter-picker">
      <button className={`icon filter-trigger ${selected.length > 0 ? 'filled' : ''}`} onClick={() => onOpenChange(!open)} aria-label="Filter POI categories">
        <Filter size={18} />
      </button>
    </div>
  )
}

function CategoryFilterModal({
  selected,
  onChange,
  onClose,
}: {
  selected: CategoryFilterId[]
  onChange: (filters: CategoryFilterId[]) => void
  onClose: () => void
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const allSelected = selected.length === ALL_CATEGORY_FILTERS.length
  const [openInfo, setOpenInfo] = useState<CategoryFilterId | null>(null)

  function setFilters(next: CategoryFilterId[]) {
    localStorage.setItem(categoryFilterStorageKey, JSON.stringify(next))
    onChange(next)
  }

  function toggleFilter(id: CategoryFilterId) {
    const next = selectedSet.has(id)
      ? selected.filter((item) => item !== id)
      : [...selected, id]
    setFilters(next)
  }

  return (
    <motion.div className="detail-backdrop filter-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="filter-popover"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.16 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="filter-popover-head">
          <strong>Categories</strong>
          <button onClick={() => setFilters(allSelected ? [] : ALL_CATEGORY_FILTERS)}>
            {allSelected ? 'Clear' : 'All'}
          </button>
        </div>
        {CATEGORY_FILTER_GROUPS.map((group) => (
          <section key={group.title} className="filter-group">
            <p>{group.title}</p>
            <div className="filter-options">
              {group.items.map((item) => (
                <div key={item.id} className="filter-option-wrap" style={{ '--filter-color': item.color } as React.CSSProperties}>
                  <label className="filter-option">
                    <input
                      type="checkbox"
                      checked={selectedSet.has(item.id)}
                      onChange={() => toggleFilter(item.id)}
                    />
                    <span className="filter-check" aria-hidden="true" />
                    <span className="filter-option-label">{item.label}</span>
                  </label>
                  <button
                    className="filter-info"
                    type="button"
                    onClick={() => setOpenInfo((current) => current === item.id ? null : item.id)}
                    aria-expanded={openInfo === item.id}
                    aria-label={`Show included sub-categories for ${item.label}`}
                  >
                    <Info size={11} />
                  </button>
                  {openInfo === item.id && <p className="filter-info-panel">{item.hint}</p>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </motion.div>
    </motion.div>
  )
}

function MainExperience() {
  const { geo, setGeo, pois, setPois, activePoi, setActivePoi, language, setLanguage, savedOpen, setSavedOpen, theme } = useAppStore()
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const [detailPoi, setDetailPoi] = useState<PoiSummary | undefined>()
  const [status, setStatus] = useState('Finding your location...')
  const [loading, setLoading] = useState(false)
  const [imageLoadingIds, setImageLoadingIds] = useState<Set<string>>(new Set())
  const [locationMenuOpen, setLocationMenuOpen] = useState(false)
  const [locationInfoOpen, setLocationInfoOpen] = useState(false)
  const [rescanConfirmOpen, setRescanConfirmOpen] = useState(false)
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false)
  const [fakeLocationMode, setFakeLocationMode] = useState(false)
  const [categoryFilters, setCategoryFilters] = useState<CategoryFilterId[]>(readStoredCategoryFilters)
  const [locationSource, setLocationSource] = useState<'gps' | 'demo' | 'fake'>(() => readSavedFakeGeo() ? 'fake' : 'demo')
  const [findMoreMsg, setFindMoreMsg] = useState<string | null>(null)
  const locationSourceRef = useRef(locationSource)
  const watchIdRef = useRef<number | undefined>(undefined)
  const lastScanGeoRef = useRef<GeoFix | undefined>(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const [centeredIndex, setCenteredIndex] = useState(0)

  // Stable callback — useCallback so PoiCard's useEffect deps don't change every render
  const handleCardVisible = useCallback((index: number) => setCenteredIndex(index), [])

  useEffect(() => {
    locationSourceRef.current = locationSource
  }, [locationSource])

  const selectedGeo = geo ?? fallbackBerlin
  const filterSignature = categoryFilterSignature(categoryFilters)
  const scanCacheLanguage = `${language}|${filterSignature}`
  const visiblePois = useMemo(() => pois.filter((poi) => poiMatchesCategoryFilters(poi, categoryFilters)), [pois, categoryFilters])

  function setLocationSourceNow(source: 'gps' | 'demo' | 'fake') {
    locationSourceRef.current = source
    setLocationSource(source)
  }

  function requestLocation() {
    const replacingTeleport = locationSourceRef.current === 'fake'
    setFakeLocationMode(false)
    setLocationMenuOpen(false)
    localStorage.removeItem(savedFakeGeoKey)
    if (watchIdRef.current !== undefined) {
      navigator.geolocation?.clearWatch(watchIdRef.current)
      watchIdRef.current = undefined
    }
    setLocationSourceNow('gps')
    setStatus('Requesting precise location...')
    if (!navigator.geolocation) {
      setGeo(fallbackBerlin)
      if (replacingTeleport) {
        setPois([])
        setActivePoi(undefined)
        lastScanGeoRef.current = undefined
      }
      setLocationSourceNow('demo')
      setStatus('GPS unavailable. Showing Berlin demo area.')
      return
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (locationSourceRef.current === 'fake') return
        if (replacingTeleport) {
          setPois([])
          setActivePoi(undefined)
          lastScanGeoRef.current = undefined
        }
        setGeo({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          timestamp: position.timestamp
        })
        setLocationSourceNow('gps')
        setStatus('Location ready.')
      },
      () => {
        if (locationSourceRef.current === 'fake') return
        if (replacingTeleport) {
          setPois([])
          setActivePoi(undefined)
          lastScanGeoRef.current = undefined
        }
        setGeo(fallbackBerlin)
        setLocationSourceNow('demo')
        setStatus('GPS denied. Showing Berlin demo area.')
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 15000 }
    )
    watchIdRef.current = watchId
    window.setTimeout(() => {
      navigator.geolocation.clearWatch(watchId)
      if (watchIdRef.current === watchId) watchIdRef.current = undefined
    }, 30000)
  }

  function startFakeLocation() {
    if (watchIdRef.current !== undefined) {
      navigator.geolocation?.clearWatch(watchIdRef.current)
      watchIdRef.current = undefined
    }
    setLocationMenuOpen(false)
    setFakeLocationMode(true)
    setStatus('Tap anywhere on the map to set a fake location.')
  }

  function pickFakeLocation(nextGeo: GeoFix) {
    localStorage.setItem(savedFakeGeoKey, JSON.stringify(nextGeo))
    setGeo(nextGeo)
    setLocationSourceNow('fake')
    setFakeLocationMode(false)
    setStatus(useAppStore.getState().pois.length === 0 ? 'Teleported. Scanning nearby POIs...' : 'Teleported. Checking for new POIs...')
  }

  async function confirmRescan() {
    setRescanConfirmOpen(false)
    await clearCachedScan(selectedGeo.latitude, selectedGeo.longitude, scanCacheLanguage)
    scan('replace', selectedGeo)
  }

  async function findMorePois() {
    setLoading(true)
    setStatus('Searching for more...')
    try {
      const currentPois = useAppStore.getState().pois
      const excludeNames = currentPois.map((p) => p.researchName ?? p.name)
      const candidates = await getCandidates(selectedGeo.latitude, selectedGeo.longitude)
      const selected = uniquePoisByName(await selectPois(candidates, language, categoryFilters, excludeNames))
      const existingIds = new Set(currentPois.map((p) => p.id))
      const incoming = selected.filter((poi) => !existingIds.has(poi.id))
      if (incoming.length === 0) {
        setFindMoreMsg('No further places found')
        setTimeout(() => setFindMoreMsg(null), 3000)
        setStatus('Ready.')
        return
      }
      setStatus(`Loading ${incoming.length} more cards...`)
      const CONCURRENCY = 3
      const loadedIncoming: PoiSummary[] = [...incoming]
      for (const poi of incoming) {
        setPois([...useAppStore.getState().pois, poi].slice(0, maxPoiListItems))
        setImageLoadingIds((ids) => new Set(ids).add(poi.id))
      }
      for (let i = 0; i < incoming.length; i += CONCURRENCY) {
        await Promise.all(
          incoming.slice(i, i + CONCURRENCY).map(async (poi) => {
            try {
              const enriched = await enrichPoi(poi, language)
              const idx = loadedIncoming.findIndex((p) => p.id === enriched.id)
              if (idx >= 0) loadedIncoming[idx] = enriched
              setPois(useAppStore.getState().pois.map((p) => p.id === enriched.id ? enriched : p).slice(0, maxPoiListItems))
              if (useAppStore.getState().activePoi?.id === enriched.id) setActivePoi(enriched)
              setDetailPoi((current) => current?.id === enriched.id ? enriched : current)
            } finally {
              setImageLoadingIds((ids) => { const next = new Set(ids); next.delete(poi.id); return next })
            }
          })
        )
      }
      setStatus('Ready.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const savedFakeGeo = readSavedFakeGeo()
    if (savedFakeGeo) {
      setGeo(savedFakeGeo)
      setLocationSourceNow('fake')
      setStatus('Teleport location restored.')
      return
    }
    requestLocation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setGeo])

  async function scan(mode: 'replace' | 'prepend-new' = 'replace', scanGeo: GeoFix = selectedGeo) {
    setLoading(true)
    setStatus(mode === 'replace' ? 'Scanning...' : 'Checking nearby...')
    try {
      if (mode === 'replace') {
        // Check scan cache before hitting the backend
        const cached = await getCachedScan(scanGeo.latitude, scanGeo.longitude, scanCacheLanguage)
        if (cached) {
          setPois(cached.pois)
          if (cached.pois.length > 0) setActivePoi(cached.pois[0])
          lastScanGeoRef.current = scanGeo
          setStatus('Ready.')
          return
        }
        setPois([])
        setActivePoi(undefined)
      }
      const existingNames = new Set(useAppStore.getState().pois.map(poiNameKey))
      const candidates = await getCandidates(scanGeo.latitude, scanGeo.longitude)
      setStatus(`Researching ${candidates.length} spots...`)
      const byDistance = (a: PoiSummary, b: PoiSummary) =>
        distanceMeters({ latitude: a.lat, longitude: a.lng }, { latitude: scanGeo.latitude, longitude: scanGeo.longitude }) -
        distanceMeters({ latitude: b.lat, longitude: b.lng }, { latitude: scanGeo.latitude, longitude: scanGeo.longitude })
      const selected = uniquePoisByName(await selectPois(candidates, language, categoryFilters)).sort(byDistance)
      const incoming = selected.filter((poi) => !existingNames.has(poiNameKey(poi)))
      if (mode === 'prepend-new' && incoming.length === 0) {
        setStatus('No new spots yet.')
        lastScanGeoRef.current = scanGeo
        return
      }
      unlockAchievement({ id: 'first-discovery', title: 'First scan', description: 'Discovered your first nearby POIs.', unlockedAt: Date.now() })
      const poisToLoad = mode === 'replace' ? selected : incoming
      const loadedIncoming: PoiSummary[] = []
      setStatus(mode === 'replace' ? `Loading ${poisToLoad.length} cards...` : `Loading ${poisToLoad.length} new cards...`)

      // Concurrency-limited enrichment: push stub + start enriching immediately,
      // up to CONCURRENCY in-flight at once. For replace mode this means the
      // nearest POI appears and is fully enriched before further stubs are added.
      const CONCURRENCY = 3
      const enrichOne = async (poi: PoiSummary) => {
        try {
          const enriched = await enrichPoi(poi, language)
          if (mode === 'prepend-new') {
            const index = loadedIncoming.findIndex((current) => current.id === enriched.id)
            if (index >= 0) loadedIncoming[index] = enriched
          }
          setPois(useAppStore.getState().pois.map((current) => current.id === enriched.id ? enriched : current).slice(0, maxPoiListItems))
          if (useAppStore.getState().activePoi?.id === enriched.id) setActivePoi(enriched)
          setDetailPoi((current) => current?.id === enriched.id ? enriched : current)
        } finally {
          setImageLoadingIds((ids) => { const next = new Set(ids); next.delete(poi.id); return next })
        }
      }

      // Push stub + fire enrichment for each POI as soon as a concurrency slot is free.
      // For prepend-new mode we still push all stubs first (existing behaviour).
      if (mode === 'prepend-new') {
        for (const poi of poisToLoad) {
          loadedIncoming.push(poi)
          setPois(mergeIncomingPois(useAppStore.getState().pois, loadedIncoming))
          if (!useAppStore.getState().activePoi) setActivePoi(poi)
          setImageLoadingIds((ids) => new Set(ids).add(poi.id))
        }
        for (let i = 0; i < poisToLoad.length; i += CONCURRENCY) {
          await Promise.all(poisToLoad.slice(i, i + CONCURRENCY).map(enrichOne))
        }
      } else {
        // replace mode: nearest-first — push one stub, enrich it, then next
        const inFlight: Promise<void>[] = []
        for (const poi of poisToLoad) {
          // Push stub immediately so user sees the card skeleton
          setPois([...useAppStore.getState().pois, poi])
          if (!useAppStore.getState().activePoi) setActivePoi(poi)
          setImageLoadingIds((ids) => new Set(ids).add(poi.id))

          // Wait for a free slot before firing the next enrichment
          if (inFlight.length >= CONCURRENCY) await inFlight.shift()!
          inFlight.push(enrichOne(poi))
        }
        // Drain remaining in-flight enrichments
        await Promise.all(inFlight)
      }
      // Persist the final enriched POI list to the scan cache
      const finalPois = useAppStore.getState().pois
      if (finalPois.length > 0) {
        const mergedForCache = mode === 'prepend-new'
          ? [...loadedIncoming, ...useAppStore.getState().pois].filter(
              (p, i, arr) => arr.findIndex((q) => q.id === p.id) === i
            ).slice(0, maxPoiListItems)
          : finalPois
        await putCachedScan(scanGeo.latitude, scanGeo.longitude, scanCacheLanguage, mergedForCache)
      }
      lastScanGeoRef.current = scanGeo
      setStatus('Ready.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }

  async function refreshPoi(poi: PoiSummary) {
    // Clear cached detail text and cached scan entry so both reload fresh
    await clearCachedScan(selectedGeo.latitude, selectedGeo.longitude, scanCacheLanguage)
    await putCachedDetail(poi.id, language, '')  // overwrite with empty so DetailCard won't serve stale text
    // Also clear from savedPois detailText if bookmarked
    const saved = await db.savedPois.get(poi.id)
    if (saved) await updatePoiDetailText(poi.id, '')
    // If this POI is open in the detail card, close it so it reloads fresh when reopened
    setDetailPoi((current) => current?.id === poi.id ? undefined : current)
    // Re-enrich the POI (new image + oneLiner)
    setImageLoadingIds((ids) => new Set(ids).add(poi.id))
    try {
      const enriched = await enrichPoi(poi, language)
      setPois(useAppStore.getState().pois.map((p) => p.id === enriched.id ? enriched : p))
      if (useAppStore.getState().activePoi?.id === enriched.id) setActivePoi(enriched)
      // Write updated scan cache with the refreshed POI
      const updatedPois = useAppStore.getState().pois
      await putCachedScan(selectedGeo.latitude, selectedGeo.longitude, scanCacheLanguage, updatedPois)
    } finally {
      setImageLoadingIds((ids) => {
        const next = new Set(ids)
        next.delete(poi.id)
        return next
      })
    }
  }

  useEffect(() => {
    if (geo && pois.length === 0 && !loading) scan('replace', geo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo])

  useEffect(() => {
    if (!geo || loading || pois.length === 0) return
    const lastScanGeo = lastScanGeoRef.current
    if (!lastScanGeo) {
      lastScanGeoRef.current = geo
      return
    }
    if (distanceMeters(lastScanGeo, geo) < movingRefreshDistanceMeters) return
    scan('prepend-new', geo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo?.latitude, geo?.longitude, loading, pois.length])

  useEffect(() => {
    if (activePoi && !visiblePois.some((poi) => poi.id === activePoi.id)) {
      setActivePoi(visiblePois[0])
    }
  }, [activePoi?.id, visiblePois, setActivePoi])

  const active = useMemo(() => {
    if (activePoi && visiblePois.some((poi) => poi.id === activePoi.id)) return activePoi
    return visiblePois[0]
  }, [activePoi, visiblePois])
  const locationLabel = locationSource === 'fake'
    ? 'Teleport'
    : selectedGeo.accuracyMeters && selectedGeo.accuracyMeters < 1000
      ? `GPS +/- ${Math.round(selectedGeo.accuracyMeters)} m`
      : 'Demo location'

  return (
    <main className={`app-shell ${theme}`}>
      <MapPanel
        geo={selectedGeo}
        pois={visiblePois}
        activePoi={active}
        locationLabel={locationLabel}
        fakeLocationMode={fakeLocationMode}
        locationInfoOpen={locationInfoOpen}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLocationBadgeClick={() => setLocationMenuOpen((open) => !open)}
        onLocationInfoClose={() => setLocationInfoOpen(false)}
        onPickLocation={pickFakeLocation}
        onSelect={setActivePoi}
        onOpenPoi={(poi) => {
          setActivePoi(poi)
          setDetailPoi(poi)
        }}
      />
      <section className="content-panel">
        <header className="toolbar">
          <div>
            <span>Nearby</span>
            <strong>{status}</strong>
          </div>
          <CategoryFilterPicker selected={categoryFilters} open={categoryFilterOpen} onOpenChange={setCategoryFilterOpen} />
          <LanguagePicker language={language} onChange={setLanguage} />
          <div className="location-control">
            <button className={`icon ${fakeLocationMode ? 'active' : ''}`} onClick={() => setLocationMenuOpen((open) => !open)} aria-label="Choose location mode"><LocateFixed size={19} /></button>
            <AnimatePresence>
              {locationMenuOpen && (
                <motion.div className="location-menu" initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.96 }}>
                  <button onClick={requestLocation}><LocateFixed size={16} /> Use GPS</button>
                  <button onClick={startFakeLocation}><MousePointer2 size={16} /> Teleport</button>
                  <button onClick={() => { setLocationInfoOpen(o => !o); setLocationMenuOpen(false) }}><Info size={16} /> How it works</button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button className="icon find-more-btn" onClick={findMorePois} disabled={loading} aria-label="Find more places"><PlusCircle size={17} /></button>
          <button className="icon" onClick={() => setRescanConfirmOpen(true)} disabled={loading} aria-label="Refresh scan"><RefreshCw className={loading ? 'spin' : ''} size={19} /></button>
          <button className="icon" onClick={() => setSavedOpen(true)} aria-label="Saved POIs"><Bookmark size={19} /></button>
        </header>
            <div className="poi-list" ref={listRef}>
            {visiblePois.length === 0 && (
              <div className="empty-state">
                <Play size={24} />
                <p>{loading ? 'Building your first travel cards...' : pois.length > 0 ? 'No POIs match the selected filters.' : 'Tap refresh to scan nearby POIs.'}</p>
                {loading && (
                  <div className="skeleton-card">
                    <div className="skeleton-thumb" />
                    <div className="skeleton-content">
                      <div className="skeleton-category" />
                      <div className="skeleton-title" />
                      <div className="skeleton-text" />
                    </div>
                  </div>
                )}
              </div>
            )}
            {visiblePois.map((poi, index) => (
              <PoiCard
                key={poi.id}
                poi={poi}
                index={index}
                centeredIndex={centeredIndex}
                active={active?.id === poi.id}
                imageLoading={imageLoadingIds.has(poi.id)}
                listRef={listRef}
                onSelect={() => setActivePoi(poi)}
                onOpen={() => {
                  setActivePoi(poi)
                  setDetailPoi(poi)
                }}
                onRefresh={() => refreshPoi(poi)}
                onVisible={handleCardVisible}
              />
            ))}
          </div>
      </section>
      <AnimatePresence>{detailPoi && <DetailCard poi={detailPoi} userGeo={selectedGeo} onClose={() => setDetailPoi(undefined)} />}</AnimatePresence>
      <AnimatePresence>{categoryFilterOpen && <CategoryFilterModal selected={categoryFilters} onChange={setCategoryFilters} onClose={() => setCategoryFilterOpen(false)} />}</AnimatePresence>
      <AnimatePresence>{savedOpen && <SavedDrawer onClose={() => setSavedOpen(false)} onOpenGuide={setDetailPoi} />}</AnimatePresence>
      <AnimatePresence>
        {findMoreMsg && (
          <motion.div
            className="find-more-toast"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {findMoreMsg}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {rescanConfirmOpen && (
          <>
            <motion.div
              className="rescan-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setRescanConfirmOpen(false)}
            />
            <motion.div
              className="rescan-confirm-card"
              style={{ x: '-50%', y: '-50%' }}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.16 }}
            >
              <p className="rescan-confirm-title"><RefreshCw size={13} /> Rescan this area?</p>
              <p className="rescan-confirm-body">This will clear all current cards and re-research every nearby point of interest from scratch. It may take up to a minute to reload.</p>
              <div className="rescan-confirm-actions">
                <button className="rescan-btn-cancel" onClick={() => setRescanConfirmOpen(false)}>Cancel</button>
                <button className="rescan-btn-confirm" onClick={confirmRescan}><RefreshCw size={13} /> Rescan</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </main>
  )
}

export function App() {
  const token = useAppStore((state) => state.token)
  const setToken = useAppStore((state) => state.setToken)
  const applyRuntimeConfig = useAppStore((state) => state.applyRuntimeConfig)
  const [runtimeReady, setRuntimeReady] = useState(false)

  useEffect(() => {
    getRuntimeConfig()
      .then(applyRuntimeConfig)
      .catch(() => undefined)
      .finally(() => setRuntimeReady(true))
  }, [applyRuntimeConfig])

  // Drop back to password gate whenever any API call returns 401
  useEffect(() => {
    const handler = () => setToken(null)
    window.addEventListener('travelguide:unauthorized', handler)
    return () => window.removeEventListener('travelguide:unauthorized', handler)
  }, [setToken])

  if (!runtimeReady) return null
  return token ? <MainExperience /> : <PasswordGate />
}
