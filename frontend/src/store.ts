import { create } from 'zustand'
import type { GeoFix, PoiSummary } from './types'

type AppState = {
  language: string
  ttsProvider: 'browser' | 'minimax'
  configured: boolean
  theme: 'light' | 'dark'
  geo?: GeoFix
  pois: PoiSummary[]
  activePoi?: PoiSummary
  savedOpen: boolean
  setLanguage: (language: string) => void
  setTtsProvider: (provider: 'browser' | 'minimax') => void
  applyRuntimeConfig: (config: { configured: boolean; language: string; ttsProvider: 'browser' | 'minimax' }) => void
  setConfigured: (configured: boolean) => void
  toggleTheme: () => void
  setGeo: (geo: GeoFix) => void
  setPois: (pois: PoiSummary[]) => void
  setActivePoi: (poi?: PoiSummary) => void
  setSavedOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  language: localStorage.getItem('travelguide.language') ?? 'en',
  ttsProvider: localStorage.getItem('travelguide.ttsProvider') === 'browser' ? 'browser' : 'minimax',
  configured: localStorage.getItem('travelguide.configured') === 'true',
  theme: (localStorage.getItem('travelguide.theme') === 'dark' ? 'dark' : 'light'),
  pois: [],
  savedOpen: false,
  setLanguage: (language) => {
    localStorage.setItem('travelguide.language', language)
    set({ language })
  },
  setTtsProvider: (ttsProvider) => {
    localStorage.setItem('travelguide.ttsProvider', ttsProvider)
    set({ ttsProvider })
  },
  applyRuntimeConfig: ({ configured, language, ttsProvider }) => {
    if (configured) {
      localStorage.setItem('travelguide.language', language)
      localStorage.setItem('travelguide.ttsProvider', ttsProvider)
      localStorage.setItem('travelguide.configured', 'true')
      set({ configured: true, language, ttsProvider })
    }
  },
  setConfigured: (configured) => {
    localStorage.setItem('travelguide.configured', String(configured))
    set({ configured })
  },
  toggleTheme: () => set((state) => {
    const theme = state.theme === 'light' ? 'dark' : 'light'
    localStorage.setItem('travelguide.theme', theme)
    return { theme }
  }),
  setGeo: (geo) => set({ geo }),
  setPois: (pois) => set({ pois }),
  setActivePoi: (activePoi) => set({ activePoi }),
  setSavedOpen: (savedOpen) => set({ savedOpen })
}))
