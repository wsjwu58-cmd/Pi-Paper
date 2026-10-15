import { create } from 'zustand'

export type AppTheme = 'light' | 'dark'
const storageKey = 'vibepaper:appearance'

function storedTheme(): AppTheme {
  try {
    return window.localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export const useTheme = create<{
  theme: AppTheme
  toggleTheme: () => void
}>((set, get) => ({
  theme: storedTheme(),
  toggleTheme() {
    const theme = get().theme === 'light' ? 'dark' : 'light'
    applyTheme(theme)
    set({ theme })
    try {
      window.localStorage.setItem(storageKey, theme)
    } catch {
      // Keep the current session usable when persistent storage is unavailable.
    }
  },
}))

/** Apply the saved desktop appearance before the first React render. */
export function initializeTheme() {
  applyTheme(useTheme.getState().theme)
}
