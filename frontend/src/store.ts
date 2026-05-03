import { create } from 'zustand'
import type { GeoFix, PoiSummary } from './types'

type AppState = {
  language: string
  configured: boolean
  theme: 'light' | 'dark'
  geo?: GeoFix
  pois: PoiSummary[]
  activePoi?: PoiSummary
  savedOpen: boolean
  floatingEnabled: boolean
  setLanguage: (language: string) => void
  applyRuntimeConfig: (config: { configured: boolean; language: string }) => void
  setConfigured: (configured: boolean) => void
  toggleTheme: () => void
  setGeo: (geo: GeoFix) => void
  setPois: (pois: PoiSummary[]) => void
  setActivePoi: (poi?: PoiSummary) => void
  setSavedOpen: (open: boolean) => void
  toggleFloating: () => void
}

export const useAppStore = create<AppState>((set) => ({
  language: localStorage.getItem('travelguide.language') ?? 'en',
  configured: localStorage.getItem('travelguide.configured') === 'true',
  theme: (localStorage.getItem('travelguide.theme') === 'dark' ? 'dark' : 'light'),
  floatingEnabled: localStorage.getItem('travelguide.floatingEnabled') !== 'false',
  pois: [],
  savedOpen: false,
  setLanguage: (language) => {
    localStorage.setItem('travelguide.language', language)
    set({ language })
  },
  applyRuntimeConfig: ({ configured, language }) => {
    if (configured) {
      localStorage.setItem('travelguide.language', language)
      localStorage.setItem('travelguide.configured', 'true')
      set({ configured: true, language })
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
  setSavedOpen: (savedOpen) => set({ savedOpen }),
  toggleFloating: () => set((state) => {
    const floatingEnabled = !state.floatingEnabled
    localStorage.setItem('travelguide.floatingEnabled', String(floatingEnabled))
    return { floatingEnabled }
  }),
}))
