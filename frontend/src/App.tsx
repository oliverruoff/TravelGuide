import { AnimatePresence, motion } from 'framer-motion'
import { Award, Bookmark, Compass, LocateFixed, MapPin, MousePointer2, Play, RefreshCw, Sparkles, Volume2, X } from 'lucide-react'
import maplibregl from 'maplibre-gl'
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { enrichPoi, getCandidates, selectPois, streamDetail } from './api'
import { db, markVisited, savePoi, unlockAchievement, type StoredPoi } from './db'
import { useAppStore } from './store'
import type { GeoFix, PoiSummary } from './types'

const fallbackBerlin: GeoFix = { latitude: 52.520008, longitude: 13.404954, accuracyMeters: 9999, timestamp: Date.now() }
const savedFakeGeoKey = 'travelguide.fakeGeo'

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
  onLocationBadgeClick: () => void
  onPickLocation: (geo: GeoFix) => void
  onSelect: (poi: PoiSummary) => void
  onOpenPoi: (poi: PoiSummary) => void
}) {
  const mapNode = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
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
    mapRef.current.on('load', () => mapRef.current?.resize())
  }, [geo.latitude, geo.longitude])

  useEffect(() => {
    mapRef.current?.flyTo({ center: [geo.longitude, geo.latitude], zoom: 16, essential: false })
    if (!mapRef.current) return
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
    markers.current.forEach((marker) => marker.remove())
    markers.current = []
    pois.forEach((poi) => {
      const node = document.createElement('button')
      node.className = `poi-pin ${activePoi?.id === poi.id ? 'active' : ''}`
      node.title = poi.name
      node.innerHTML = `
        <svg viewBox="0 0 32 44" aria-hidden="true">
          <path d="M16 42C11.2 34.3 4 27.4 4 16.4C4 9.5 9.4 4 16 4s12 5.5 12 12.4C28 27.4 20.8 34.3 16 42Z" />
          <circle cx="16" cy="16" r="5.2" />
        </svg>
        <span>${poi.name.slice(0, 18)}</span>
      `
      node.onclick = () => {
        onSelect(poi)
        onOpenPoi(poi)
      }
      const marker = new maplibregl.Marker({ element: node, anchor: 'bottom' }).setLngLat([poi.lng, poi.lat]).addTo(mapRef.current!)
      markers.current.push(marker)
    })
  }, [pois, activePoi, onSelect, onOpenPoi])

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

  return (
    <section className={`map-shell ${fakeLocationMode ? 'picking-location' : ''}`}>
      <div ref={mapNode} className="map" />
      {fakeLocationMode && <button className="fake-location-layer" onPointerDown={pickFromPointer} aria-label="Place fake location on map" />}
      <button className="accuracy" onClick={onLocationBadgeClick} aria-label="Choose location mode">
        <LocateFixed size={13} /> {locationLabel}
      </button>
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
        {poi.imageUrl ? <img src={poi.imageUrl} alt="" /> : imageLoading ? <span className="image-spinner" /> : <MapPin size={24} />}
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
  const [text, setText] = useState('')
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setText('')
    streamDetail(poi, language, (chunk) => setText((value) => value + chunk), controller.signal).catch(() => {
      setText(`${poi.name} is worth a closer look. Take a moment to observe its details, surroundings, and the way it shapes the local walk.`)
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

  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.article
        className="detail-card"
        initial={{ y: 160, rotateX: -24, scale: 0.86 }}
        animate={{ y: 0, rotateX: 0, scale: 1 }}
        exit={{ y: 120, opacity: 0, scale: 0.9 }}
        transition={{ type: 'spring', damping: 22, stiffness: 190 }}
      >
        <button className="icon close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <div className="collage">
          {poi.imageUrl ? <img src={poi.imageUrl} alt="" /> : <div className="image-fallback"><MapPin size={38} /></div>}
          <div className="collage-shine" />
        </div>
        <div className="detail-body">
          <span className="category">{poi.category}</span>
          <h2>{poi.name}</h2>
          <p className="guide-text">{text || 'Researching the story of this place...'}</p>
          {poi.sourceRefs.length > 0 && (
            <details>
              <summary>Sources</summary>
              {poi.sourceRefs.slice(0, 4).map((source) => <a href={source} target="_blank" key={source}>{source}</a>)}
            </details>
          )}
        </div>
        <div className="detail-actions">
          <button onClick={() => savePoi(poi)}><Bookmark size={18} /> Save</button>
          <button onClick={() => markVisited(poi)}><Award size={18} /> Visited</button>
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
  const { geo, setGeo, pois, setPois, activePoi, setActivePoi, language, savedOpen, setSavedOpen } = useAppStore()
  const [detailPoi, setDetailPoi] = useState<PoiSummary | undefined>()
  const [status, setStatus] = useState('Finding your location...')
  const [loading, setLoading] = useState(false)
  const [imageLoadingIds, setImageLoadingIds] = useState<Set<string>>(new Set())
  const [locationMenuOpen, setLocationMenuOpen] = useState(false)
  const [fakeLocationMode, setFakeLocationMode] = useState(false)
  const [locationSource, setLocationSource] = useState<'gps' | 'demo' | 'fake'>(() => readSavedFakeGeo() ? 'fake' : 'demo')
  const locationSourceRef = useRef(locationSource)
  const watchIdRef = useRef<number | undefined>(undefined)

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
    setPois([])
    setActivePoi(undefined)
    setDetailPoi(undefined)
    setStatus('Fake location set. Scanning nearby POIs...')
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

  async function scan() {
    setLoading(true)
    setStatus('Scanning the nearby map...')
    try {
      const candidates = await getCandidates(selectedGeo.latitude, selectedGeo.longitude)
      setStatus(`Found ${candidates.length} named map objects. Asking AI to curate...`)
      const selected = await selectPois(candidates, language)
      setPois(selected)
      setActivePoi(selected[0])
      unlockAchievement({ id: 'first-discovery', title: 'First scan', description: 'Discovered your first nearby POIs.', unlockedAt: Date.now() })
      setImageLoadingIds(new Set(selected.map((poi) => poi.id)))
      setStatus('Loading POI images and quick guide notes...')
      selected.forEach((poi) => {
        enrichPoi(poi, language)
          .then((enriched) => {
            setPois(useAppStore.getState().pois.map((current) => current.id === enriched.id ? enriched : current))
            if (useAppStore.getState().activePoi?.id === enriched.id) {
              setActivePoi(enriched)
            }
            setDetailPoi((current) => current?.id === enriched.id ? enriched : current)
          })
          .finally(() => {
            setImageLoadingIds((ids) => {
              const next = new Set(ids)
              next.delete(poi.id)
              return next
            })
          })
      })
      setStatus('Ready to explore.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (geo && pois.length === 0 && !loading) scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo])

  const active = useMemo(() => activePoi ?? pois[0], [activePoi, pois])
  const locationLabel = locationSource === 'fake'
    ? 'Fake location'
    : selectedGeo.accuracyMeters && selectedGeo.accuracyMeters < 1000
      ? `GPS +/- ${Math.round(selectedGeo.accuracyMeters)} m`
      : 'Demo location'

  return (
    <main className="app-shell">
      <MapPanel
        geo={selectedGeo}
        pois={pois}
        activePoi={active}
        locationLabel={locationLabel}
        fakeLocationMode={fakeLocationMode}
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
          <button className="icon" onClick={scan} disabled={loading} aria-label="Refresh scan"><RefreshCw className={loading ? 'spin' : ''} size={19} /></button>
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
