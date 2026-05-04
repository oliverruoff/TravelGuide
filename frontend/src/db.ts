import Dexie, { type EntityTable } from 'dexie'
import type { Achievement, PoiSummary } from './types'

export type StoredPoi = PoiSummary & {
  savedAt: number
  visitedAt?: number
  detailText?: string
}

export type CachedScan = {
  locationKey: string
  language?: string
  pois: PoiSummary[]
  cachedAt: number
}

export type CachedDetail = {
  /** Composite key: "<poiId>|<language>" */
  key: string
  poiId: string
  language: string
  detailText: string
  cachedAt: number
}

export const db = new Dexie('travelguide') as Dexie & {
  savedPois: EntityTable<StoredPoi, 'id'>
  achievements: EntityTable<Achievement, 'id'>
  poiCache: EntityTable<CachedScan, 'locationKey'>
  poiDetailCache: EntityTable<CachedDetail, 'key'>
}

db.version(1).stores({
  savedPois: 'id, savedAt, visitedAt',
  achievements: 'id, unlockedAt, relatedPoiId'
})

db.version(2).stores({
  savedPois: 'id, savedAt, visitedAt',
  achievements: 'id, unlockedAt, relatedPoiId',
  poiCache: 'locationKey, cachedAt',
  poiDetailCache: 'key, poiId, language, cachedAt'
})

db.version(3).stores({
  savedPois: 'id, savedAt, visitedAt',
  achievements: 'id, unlockedAt, relatedPoiId',
  poiCache: 'locationKey, language, cachedAt',
  poiDetailCache: 'key, poiId, language, cachedAt'
})

// ---------------------------------------------------------------------------
// Geo rounding helpers
// ---------------------------------------------------------------------------

/** Round to 3 decimal places (~111 m grid). */
export function roundGeo(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`
}

function scanKey(lat: number, lng: number, language: string): string {
  return `${roundGeo(lat, lng)}|${language}`
}

// ---------------------------------------------------------------------------
// Scan cache helpers
// ---------------------------------------------------------------------------

export async function getCachedScan(lat: number, lng: number, language: string): Promise<CachedScan | undefined> {
  return db.poiCache.get(scanKey(lat, lng, language))
}

export async function putCachedScan(lat: number, lng: number, language: string, pois: PoiSummary[]): Promise<void> {
  await db.poiCache.put({ locationKey: scanKey(lat, lng, language), language, pois, cachedAt: Date.now() })
}

export async function clearCachedScan(lat: number, lng: number, language?: string): Promise<void> {
  if (language) {
    await db.poiCache.delete(scanKey(lat, lng, language))
    return
  }
  const prefix = `${roundGeo(lat, lng)}|`
  const entries = await db.poiCache.toArray()
  await db.poiCache.bulkDelete(entries.filter((entry) => entry.locationKey === roundGeo(lat, lng) || entry.locationKey.startsWith(prefix)).map((entry) => entry.locationKey))
}

// ---------------------------------------------------------------------------
// Detail text cache helpers
// ---------------------------------------------------------------------------

function detailKey(poiId: string, language: string): string {
  return `${poiId}|${language}`
}

export async function getCachedDetail(poiId: string, language: string): Promise<string | undefined> {
  const entry = await db.poiDetailCache.get(detailKey(poiId, language))
  return entry?.detailText
}

export async function putCachedDetail(poiId: string, language: string, detailText: string): Promise<void> {
  await db.poiDetailCache.put({
    key: detailKey(poiId, language),
    poiId,
    language,
    detailText,
    cachedAt: Date.now()
  })
}

// ---------------------------------------------------------------------------
// Saved POI helpers
// ---------------------------------------------------------------------------

export async function savePoi(poi: PoiSummary) {
  await db.savedPois.put({ ...poi, savedAt: Date.now() })
  await unlockAchievement({
    id: 'first-save',
    title: 'First keepsake',
    description: 'Saved your first POI.',
    unlockedAt: Date.now(),
    relatedPoiId: poi.id
  })
}

export async function updatePoiDetailText(poiId: string, detailText: string): Promise<void> {
  await db.savedPois.where('id').equals(poiId).modify({ detailText })
}

export async function markVisited(poi: PoiSummary) {
  const existing = await db.savedPois.get(poi.id)
  await db.savedPois.put({ ...(existing ?? poi), ...poi, savedAt: existing?.savedAt ?? Date.now(), visitedAt: Date.now() })
  await unlockAchievement({
    id: 'first-visit',
    title: 'First discovery',
    description: 'Marked your first POI as visited.',
    unlockedAt: Date.now(),
    relatedPoiId: poi.id
  })
}

export async function unlockAchievement(achievement: Achievement) {
  const existing = await db.achievements.get(achievement.id)
  if (!existing) await db.achievements.put(achievement)
}

export async function deletePoi(poiId: string) {
  await db.savedPois.delete(poiId)
}
