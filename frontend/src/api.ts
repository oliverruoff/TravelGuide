/// <reference types="vite/client" />
import type { PoiSummary, RawGeoCandidate } from './types'

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

const TOKEN_KEY = 'travelguide.token'

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** Build auth headers for protected requests. */
function authHeaders(): Record<string, string> {
  const token = getStoredToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Wrapper around fetch that automatically attaches the auth token and
 * dispatches a custom "travelguide:unauthorized" event on 401 so the
 * app can drop back to the password gate without every call site needing
 * to handle it explicitly.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...(init.headers as Record<string, string> | undefined ?? {}),
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (response.status === 401) {
    clearToken()
    window.dispatchEvent(new Event('travelguide:unauthorized'))
  }
  return response
}

export type RuntimeConfig = {
  language: string
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const response = await fetch(`${API_BASE}/api/config/runtime`)
  if (!response.ok) throw new Error('Could not load runtime config')
  return response.json()
}

/**
 * Submit access password. Returns the signed token on success or null on failure.
 */
export async function verifyPassword(password: string): Promise<string | null> {
  const response = await fetch(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) return null
  const data = await response.json()
  return data.token ?? null
}

export async function getCandidates(lat: number, lng: number): Promise<RawGeoCandidate[]> {
  const response = await apiFetch('/api/geo/candidates', {
    method: 'POST',
    body: JSON.stringify({ lat, lng, radiusMeters: 500 }),
  })
  if (!response.ok) throw new Error('Could not load nearby map objects')
  return response.json()
}

export async function selectPois(candidates: RawGeoCandidate[], language: string): Promise<PoiSummary[]> {
  const response = await apiFetch('/api/poi/select', {
    method: 'POST',
    body: JSON.stringify({ candidates, language }),
  })
  if (!response.ok) throw new Error('Could not select POIs')
  return response.json()
}

export async function enrichPoi(poi: PoiSummary, language: string): Promise<PoiSummary> {
  const response = await apiFetch('/api/poi/enrich', {
    method: 'POST',
    body: JSON.stringify({ poi, language }),
  })
  if (!response.ok) return poi
  return response.json()
}

export async function streamDetail(
  poi: PoiSummary,
  language: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  onDone?: () => void
) {
  const response = await apiFetch('/api/poi/detail/stream', {
    method: 'POST',
    body: JSON.stringify({ poi, language }),
    signal,
  })
  if (!response.ok || !response.body) throw new Error('Could not stream detail')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (line === 'data: done') {
          onDone?.()
        } else if (line.startsWith('data: ')) {
          onChunk(line.slice(6))
        }
      }
    }
  }
  // Fallback: if the stream ends without a `data: done` event, still fire onDone
  onDone?.()
}
