import Dexie, { type EntityTable } from 'dexie'
import type { Achievement, PoiSummary } from './types'

export type StoredPoi = PoiSummary & {
  savedAt: number
  visitedAt?: number
  detailText?: string
}

export const db = new Dexie('travelguide') as Dexie & {
  savedPois: EntityTable<StoredPoi, 'id'>
  achievements: EntityTable<Achievement, 'id'>
}

db.version(1).stores({
  savedPois: 'id, savedAt, visitedAt',
  achievements: 'id, unlockedAt, relatedPoiId'
})

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

