import { AnimatePresence, motion, useDragControls } from 'framer-motion'
import { Award, Bookmark, Compass, LocateFixed, MapPin, Moon, MousePointer2, Play, RefreshCw, Settings, Sparkles, Sun, Volume2, X } from 'lucide-react'
import maplibregl from 'maplibre-gl'
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { enrichPoi, getCandidates, selectPois, streamDetail } from './api'
import { db, markVisited, savePoi, unlockAchievement, type StoredPoi } from './db'
import { useAppStore } from './store'
import type { GeoFix, PoiSummary } from './types'

const fallbackBerlin: GeoFix = { latitude: 52.520008, longitude: 13.404954, accuracyMeters: 9999, timestamp: Date.now() }
const savedFakeGeoKey = 'travelguide.fakeGeo'
const poiSearchRadiusMeters = 500
const maxPoiListItems = 50
const movingRefreshDistanceMeters = 140

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

function poiNameKey(poi: PoiSummary) {
  return poi.name.trim().toLowerCase().replace(/\s+/g, ' ')
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

function searchRadiusFeature(geo: GeoFix) {
  const points: [number, number][] = []
  const earthRadius = 6371000
  const lat = geo.latitude * Math.PI / 180
  const lng = geo.longitude * Math.PI / 180
  const angularDistance = poiSearchRadiusMeters / earthRadius

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

function ensureSearchRadiusLayer(map: maplibregl.Map, geo: GeoFix) {
  const existing = map.getSource('poi-search-radius') as maplibregl.GeoJSONSource | undefined
  if (existing) {
    existing.setData(searchRadiusFeature(geo))
    return
  }
  map.addSource('poi-search-radius', {
    type: 'geojson',
    data: searchRadiusFeature(geo),
  })
  map.addLayer({
    id: 'poi-search-radius-fill',
    type: 'fill',
    source: 'poi-search-radius',
    paint: {
      'fill-color': '#2b7fff',
      'fill-opacity': 0.12,
    },
  })
  map.addLayer({
    id: 'poi-search-radius-line',
    type: 'line',
    source: 'poi-search-radius',
    paint: {
      'line-color': '#1f64d8',
      'line-width': 2,
      'line-opacity': 0.58,
    },
  })
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

function Onboarding() {
  const { language, setLanguage, setConfigured } = useAppStore()
  const [miniKey, setMiniKey] = useState('')
  const [braveKey, setBraveKey] = useState('')

  return (
    <main className="onboarding">
      <motion.section initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="onboarding-card">
        <div className="brand-mark"><Compass size={28} /></div>
        <h1>TravelGuide</h1>
        <p>Your AI travel cards for places around you.</p>
        <label>
          Language
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
          </select>
        </label>
        <label>
          MiniMax API key
          <input value={miniKey} onChange={(event) => setMiniKey(event.target.value)} type="password" placeholder="Stored on the Python backend for V1" />
        </label>
        <label>
          Brave Search API key
          <input value={braveKey} onChange={(event) => setBraveKey(event.target.value)} type="password" placeholder="Stored on the Python backend for V1" />
        </label>
        <button className="primary" onClick={() => setConfigured(true)}>
          <LocateFixed size={18} /> Start exploring
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
  theme,
  onToggleTheme,
  onLocationBadgeClick,
  onPickLocation,
  onSelect,
  onOpenPoi
}: {
  geo: GeoFix
  pois: PoiSummary[]
  activePoi?: PoiSummary
  locationLabel: string
  fakeLocationMode: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onLocationBadgeClick: () => void
  onPickLocation: (geo: GeoFix) => void
  onSelect: (poi: PoiSummary) => void
  onOpenPoi: (poi: PoiSummary) => void
}) {
  const mapNode = useRef<HTMLDivElement | null>(null)
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
      fitSearchRadius(map, geo, 0)
    })
  }, [geo.latitude, geo.longitude, theme])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.setStyle(rasterMapStyle(theme))
    map.once('style.load', () => {
      ensureSearchRadiusLayer(map, geo)
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
      node.innerHTML = `
        <span class="poi-pin-icon">
          <svg viewBox="0 0 32 44" aria-hidden="true">
            <path d="M16 42.2C11.2 34.9 4 27.9 4 16.1C4 8.4 9.4 2 16 2s12 6.4 12 14.1C28 27.9 20.8 34.9 16 42.2Z" />
            <circle cx="16" cy="16" r="5.2" />
          </svg>
        </span>
        <span>${poi.name.slice(0, 18)}</span>
      `
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
  const text = `${poi.name} ${poi.category}`.toLowerCase()
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
  return trimmed.toLowerCase().startsWith(poi.name.toLowerCase()) ? trimmed : `${poi.name}: ${trimmed}`
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
  active,
  imageLoading,
  onSelect,
  onOpen
}: {
  poi: PoiSummary
  index: number
  active: boolean
  imageLoading?: boolean
  onSelect: () => void
  onOpen: () => void
}) {
  return (
    <motion.article
      className={`poi-card ${active ? 'active' : ''}`}
      initial={{ opacity: 0, y: 16, rotateX: -8 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ delay: index * 0.045 }}
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
        <p>{cleanOneLiner(poi.oneLiner)}</p>
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
    </motion.article>
  )
}

function DetailCard({ poi, onClose }: { poi: PoiSummary; onClose: () => void }) {
  const { language } = useAppStore()
  const dragControls = useDragControls()
  const [text, setText] = useState('')
  const [displayedText, setDisplayedText] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [exitY, setExitY] = useState<'105%' | '-105%'>('105%')
  const draftTextRef = useRef('')
  const displayIndexRef = useRef(0)
  const animationIdRef = useRef<number | null>(null)

  // Smooth character-by-character animation
  useEffect(() => {
    if (!text || displayedText.length === text.length) return

    const scheduleNextChar = () => {
      displayIndexRef.current += 1
      setDisplayedText(text.slice(0, displayIndexRef.current))
      
      if (displayIndexRef.current < text.length) {
        // Variable delay for natural typing: 20-60ms between chars, longer after punctuation
        const nextChar = text[displayIndexRef.current]
        const delay = ['.', '!', '?', '\n'].includes(nextChar) ? 40 : Math.random() * 40 + 20
        animationIdRef.current = window.setTimeout(scheduleNextChar, delay)
      }
    }

    const initialDelay = window.setTimeout(scheduleNextChar, 50)
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
    setLoading(true)
    setFailed(false)
    
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
      controller.signal
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
    return () => controller.abort()
  }, [poi, language])

  function speak() {
    if (speaking) {
      speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text || poi.oneLiner)
    utterance.lang = language === 'de' ? 'de-DE' : 'en-US'
    utterance.onend = () => setSpeaking(false)
    setSpeaking(true)
    speechSynthesis.speak(utterance)
  }

  function closeWithDirection(direction: 'up' | 'down' = 'down') {
    setExitY(direction === 'up' ? '-105%' : '105%')
    window.requestAnimationFrame(onClose)
  }

  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.article
        className="detail-card"
        initial={{ y: '100%', rotateX: -16, scale: 0.92 }}
        animate={{ y: 0, rotateX: 0, scale: 1 }}
        exit={{ y: exitY, opacity: 0, scale: 0.94 }}
        transition={{ type: 'spring', damping: 22, stiffness: 190 }}
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
        <button className="icon close" onClick={() => closeWithDirection('down')} aria-label="Close"><X size={20} /></button>
        <div
          className="collage drag-handle"
          onPointerDown={(event) => dragControls.start(event.nativeEvent)}
        >
          <PoiVisual poi={poi} large />
          <div className="collage-shine" />
        </div>
        <div className="detail-body">
          <span className="category">{poi.category}</span>
          <h2>{poi.name}</h2>
          {loading ? (
            <div className="guide-loading">
              <strong>Researching guide text...</strong>
              <div className="text-skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : !text ? (
            <p className="guide-text muted">{failed ? 'No guide text could be loaded right now.' : 'No guide text available yet.'}</p>
          ) : (
            <motion.p 
              className="guide-text"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              {displayedText}
              {displayedText.length < text.length && <span className="typing-cursor" />}
            </motion.p>
          )}
          {!loading && text && poi.sourceRefs.length > 0 && (
            <details>
              <summary>Sources</summary>
              {poi.sourceRefs.slice(0, 4).map((source) => <a href={source} target="_blank" key={source}>{source}</a>)}
            </details>
          )}
        </div>
        <div className="detail-actions">
          <button onClick={() => savePoi(poi)}><Bookmark size={18} /> Save</button>
          <button onClick={speak}><Volume2 size={18} /> {speaking ? 'Stop' : 'Listen'}</button>
        </div>
      </motion.article>
    </motion.div>
  )
}

function SavedDrawer({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<StoredPoi[]>([])
  useEffect(() => {
    db.savedPois.orderBy('savedAt').reverse().toArray().then(setItems)
  }, [])
  return (
    <motion.aside className="saved-drawer" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}>
      <button className="icon close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      <h2>Saved POIs</h2>
      {items.length === 0 ? <p>No saved cards yet.</p> : items.map((item) => (
        <PoiCard key={item.id} poi={item} index={0} active={false} onSelect={() => undefined} onOpen={() => undefined} />
      ))}
    </motion.aside>
  )
}

function MainExperience() {
  const { geo, setGeo, pois, setPois, activePoi, setActivePoi, language, savedOpen, setSavedOpen, setConfigured, theme } = useAppStore()
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const [detailPoi, setDetailPoi] = useState<PoiSummary | undefined>()
  const [status, setStatus] = useState('Finding your location...')
  const [loading, setLoading] = useState(false)
  const [imageLoadingIds, setImageLoadingIds] = useState<Set<string>>(new Set())
  const [locationMenuOpen, setLocationMenuOpen] = useState(false)
  const [fakeLocationMode, setFakeLocationMode] = useState(false)
  const [locationSource, setLocationSource] = useState<'gps' | 'demo' | 'fake'>(() => readSavedFakeGeo() ? 'fake' : 'demo')
  const locationSourceRef = useRef(locationSource)
  const watchIdRef = useRef<number | undefined>(undefined)
  const lastScanGeoRef = useRef<GeoFix | undefined>(undefined)

  useEffect(() => {
    locationSourceRef.current = locationSource
  }, [locationSource])

  const selectedGeo = geo ?? fallbackBerlin

  function requestLocation() {
    setFakeLocationMode(false)
    setLocationMenuOpen(false)
    localStorage.removeItem(savedFakeGeoKey)
    if (watchIdRef.current !== undefined) {
      navigator.geolocation?.clearWatch(watchIdRef.current)
      watchIdRef.current = undefined
    }
    setStatus('Requesting precise location...')
    if (!navigator.geolocation) {
      setGeo(fallbackBerlin)
      setLocationSource('demo')
      setStatus('GPS unavailable. Showing Berlin demo area.')
      return
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (locationSourceRef.current === 'fake') return
        setGeo({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          timestamp: position.timestamp
        })
        setLocationSource('gps')
        setStatus('Location ready.')
      },
      () => {
        if (locationSourceRef.current === 'fake') return
        setGeo(fallbackBerlin)
        setLocationSource('demo')
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
    setLocationSource('fake')
    setFakeLocationMode(false)
    setStatus(useAppStore.getState().pois.length === 0 ? 'Fake location set. Scanning nearby POIs...' : 'Fake location moved. Checking for new POIs...')
  }

  useEffect(() => {
    const savedFakeGeo = readSavedFakeGeo()
    if (savedFakeGeo) {
      setGeo(savedFakeGeo)
      setLocationSource('fake')
      setStatus('Fake location restored.')
      return
    }
    requestLocation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setGeo])

  async function scan(mode: 'replace' | 'prepend-new' = 'replace', scanGeo: GeoFix = selectedGeo) {
    setLoading(true)
    setStatus(mode === 'replace' ? 'Scanning the nearby map...' : 'Checking for new nearby POIs...')
    try {
      if (mode === 'replace') {
        setPois([])
        setActivePoi(undefined)
      }
      const existingNames = new Set(useAppStore.getState().pois.map(poiNameKey))
      const candidates = await getCandidates(scanGeo.latitude, scanGeo.longitude)
      setStatus(`Found ${candidates.length} interesting spots nearby. Researching now...`)
      const selected = uniquePoisByName(await selectPois(candidates, language))
      const incoming = selected.filter((poi) => !existingNames.has(poiNameKey(poi)))
      if (mode === 'prepend-new' && incoming.length === 0) {
        setStatus('No new POIs nearby yet.')
        lastScanGeoRef.current = scanGeo
        return
      }
      unlockAchievement({ id: 'first-discovery', title: 'First scan', description: 'Discovered your first nearby POIs.', unlockedAt: Date.now() })
      const poisToLoad = mode === 'replace' ? selected : incoming
      const loadedIncoming: PoiSummary[] = []
      setStatus(mode === 'replace' ? `Curated ${poisToLoad.length} nearby POIs. Loading cards...` : `Found ${poisToLoad.length} new POIs. Loading them...`)
      for (const poi of poisToLoad) {
        if (mode === 'replace') {
          setPois([...useAppStore.getState().pois, poi])
        } else {
          loadedIncoming.push(poi)
          setPois(mergeIncomingPois(useAppStore.getState().pois, loadedIncoming))
        }
        if (!useAppStore.getState().activePoi) {
          setActivePoi(poi)
        }
        setImageLoadingIds((ids) => new Set(ids).add(poi.id))
        setStatus(`Loading ${poi.name}...`)
        try {
          const enriched = await enrichPoi(poi, language)
          if (mode === 'prepend-new') {
            const index = loadedIncoming.findIndex((current) => current.id === enriched.id)
            if (index >= 0) loadedIncoming[index] = enriched
          }
          setPois(useAppStore.getState().pois.map((current) => current.id === enriched.id ? enriched : current).slice(0, maxPoiListItems))
          if (useAppStore.getState().activePoi?.id === enriched.id) {
            setActivePoi(enriched)
          }
          setDetailPoi((current) => current?.id === enriched.id ? enriched : current)
        } finally {
          setImageLoadingIds((ids) => {
            const next = new Set(ids)
            next.delete(poi.id)
            return next
          })
        }
      }
      lastScanGeoRef.current = scanGeo
      setStatus('Ready to explore.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan failed')
    } finally {
      setLoading(false)
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

  const active = useMemo(() => activePoi ?? pois[0], [activePoi, pois])
  const locationLabel = locationSource === 'fake'
    ? 'Fake location'
    : selectedGeo.accuracyMeters && selectedGeo.accuracyMeters < 1000
      ? `GPS +/- ${Math.round(selectedGeo.accuracyMeters)} m`
      : 'Demo location'

  return (
    <main className={`app-shell ${theme}`}>
      <MapPanel
        geo={selectedGeo}
        pois={pois}
        activePoi={active}
        locationLabel={locationLabel}
        fakeLocationMode={fakeLocationMode}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLocationBadgeClick={() => setLocationMenuOpen((open) => !open)}
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
            <span>Nearby guide</span>
            <strong>{status}</strong>
          </div>
          <button className="icon" onClick={() => setConfigured(false)} aria-label="Open settings"><Settings size={19} /></button>
          <div className="location-control">
            <button className={`icon ${fakeLocationMode ? 'active' : ''}`} onClick={() => setLocationMenuOpen((open) => !open)} aria-label="Choose location mode"><LocateFixed size={19} /></button>
            <AnimatePresence>
              {locationMenuOpen && (
                <motion.div className="location-menu" initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.96 }}>
                  <button onClick={requestLocation}><LocateFixed size={16} /> Use GPS</button>
                  <button onClick={startFakeLocation}><MousePointer2 size={16} /> Fake location</button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button className="icon" onClick={() => scan('replace', selectedGeo)} disabled={loading} aria-label="Refresh scan"><RefreshCw className={loading ? 'spin' : ''} size={19} /></button>
          <button className="icon" onClick={() => setSavedOpen(true)} aria-label="Saved POIs"><Bookmark size={19} /></button>
        </header>
        <div className="poi-list">
          {pois.length === 0 && (
            <div className="empty-state">
              <Play size={24} />
              <p>{loading ? 'Building your first travel cards...' : 'Tap refresh to scan nearby POIs.'}</p>
            </div>
          )}
          {pois.map((poi, index) => (
            <PoiCard
              key={poi.id}
              poi={poi}
              index={index}
              active={active?.id === poi.id}
              imageLoading={imageLoadingIds.has(poi.id)}
              onSelect={() => setActivePoi(poi)}
              onOpen={() => {
                setActivePoi(poi)
                setDetailPoi(poi)
              }}
            />
          ))}
        </div>
      </section>
      <AnimatePresence>{detailPoi && <DetailCard poi={detailPoi} onClose={() => setDetailPoi(undefined)} />}</AnimatePresence>
      <AnimatePresence>{savedOpen && <SavedDrawer onClose={() => setSavedOpen(false)} />}</AnimatePresence>
    </main>
  )
}

export function App() {
  const configured = useAppStore((state) => state.configured)
  return configured ? <MainExperience /> : <Onboarding />
}
