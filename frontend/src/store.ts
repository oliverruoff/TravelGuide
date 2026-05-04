import { create } from 'zustand'
import { getStoredToken, storeToken, clearToken } from './api'
import type { GeoFix, PoiSummary } from './types'

type AppState = {
  /** Signed HMAC token issued by the backend on successful password entry. */
  token: string | null
  language: string
  theme: 'light' | 'dark'
  geo?: GeoFix
  pois: PoiSummary[]
  activePoi?: PoiSummary
  savedOpen: boolean
  floatingEnabled: boolean
  setToken: (token: string | null) => void
  setLanguage: (language: string) => void
  applyRuntimeConfig: (config: { language: string }) => void
  toggleTheme: () => void
  setGeo: (geo: GeoFix) => void
  setPois: (pois: PoiSummary[]) => void
  setActivePoi: (poi?: PoiSummary) => void
  setSavedOpen: (open: boolean) => void
  toggleFloating: () => void
}

export const useAppStore = create<AppState>((set) => ({
  token: getStoredToken(),
  language: localStorage.getItem('travelguide.language') ?? 'en',
  theme: (localStorage.getItem('travelguide.theme') === 'dark' ? 'dark' : 'light'),
  floatingEnabled: localStorage.getItem('travelguide.floatingEnabled') !== 'false',
  pois: [],
  savedOpen: false,
  setToken: (token) => {
    if (token) {
      storeToken(token)
    } else {
      clearToken()
    }
    set({ token })
  },
  setLanguage: (language) => {
    localStorage.setItem('travelguide.language', language)
    set({ language })
  },
  applyRuntimeConfig: ({ language }) => {
    // Only apply BE language if the user hasn't already set a preference
    if (!localStorage.getItem('travelguide.language')) {
      localStorage.setItem('travelguide.language', language)
      set({ language })
    }
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
