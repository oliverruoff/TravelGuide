export type GeoFix = {
  latitude: number
  longitude: number
  accuracyMeters?: number
  timestamp?: number
}

export type RawGeoCandidate = {
  id: string
  name: string
  lat: number
  lng: number
  tags: Record<string, string>
  distanceMeters: number
}

export type PoiSummary = {
  id: string
  name: string
  lat: number
  lng: number
  category: string
  oneLiner: string
  imageUrl?: string | null
  confidence: number
  sourceRefs: string[]
}

export type Achievement = {
  id: string
  title: string
  description: string
  unlockedAt: number
  relatedPoiId?: string
}

