import { create } from 'zustand'
import type { GeoFix, PoiSummary } from './types'

type AppState = {
  language: string
  configured: boolean
  geo?: GeoFix
  pois: PoiSummary[]
  activePoi?: PoiSummary
  savedOpen: boolean
  setLanguage: (language: string) => void
  setConfigured: (configured: boolean) => void
  setGeo: (geo: GeoFix) => void
  setPois: (pois: PoiSummary[]) => void
  setActivePoi: (poi?: PoiSummary) => void
  setSavedOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  language: localStorage.getItem('travelguide.language') ?? 'en',
  configured: localStorage.getItem('travelguide.configured') === 'true',
  pois: [],
  savedOpen: false,
  setLanguage: (language) => {
    localStorage.setItem('travelguide.language', language)
    set({ language })
  },
  setConfigured: (configured) => {
    localStorage.setItem('travelguide.configured', String(configured))
    set({ configured })
  },
  setGeo: (geo) => set({ geo }),
  setPois: (pois) => set({ pois }),
  setActivePoi: (activePoi) => set({ activePoi }),
  setSavedOpen: (savedOpen) => set({ savedOpen })
}))

