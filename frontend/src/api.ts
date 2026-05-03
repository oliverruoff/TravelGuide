import type { PoiSummary, RawGeoCandidate } from './types'

export type RuntimeConfig = {
  configured: boolean
  language: string
  ttsProvider: 'browser' | 'minimax'
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const response = await fetch('/api/config/runtime')
  if (!response.ok) throw new Error('Could not load runtime config')
  return response.json()
}

export async function getCandidates(lat: number, lng: number): Promise<RawGeoCandidate[]> {
  const response = await fetch('/api/geo/candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, radiusMeters: 500 })
  })
  if (!response.ok) throw new Error('Could not load nearby map objects')
  return response.json()
}

export async function selectPois(candidates: RawGeoCandidate[], language: string): Promise<PoiSummary[]> {
  const response = await fetch('/api/poi/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidates, language })
  })
  if (!response.ok) throw new Error('Could not select POIs')
  return response.json()
}

export async function enrichPoi(poi: PoiSummary, language: string): Promise<PoiSummary> {
  const response = await fetch('/api/poi/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poi, language })
  })
  if (!response.ok) return poi
  return response.json()
}

export async function streamDetail(
  poi: PoiSummary,
  language: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
) {
  const response = await fetch('/api/poi/detail/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poi, language }),
    signal
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
        if (line.startsWith('data: ') && line !== 'data: done') {
          onChunk(line.slice(6))
        }
      }
    }
  }
}

export async function synthesizeSpeech(text: string, language: string): Promise<Blob> {
  const response = await fetch('/api/audio/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language })
  })
  if (!response.ok) {
    const errorText = await response.text()
    try {
      const errorJson = JSON.parse(errorText) as { detail?: string }
      throw new Error(errorJson.detail || 'Could not generate audio')
    } catch {
      throw new Error(errorText || 'Could not generate audio')
    }
  }
  return response.blob()
}
