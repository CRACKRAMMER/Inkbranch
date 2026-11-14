export type ThemeMode = 'system' | 'light' | 'dark'
export type ReadingFont = 'sans' | 'serif'

const THEME_STORAGE_KEY = 'color-scheme'
const READING_FONT_KEY = 'inkbranch-reading-font'

export function getThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') {
      return stored
    }
  } catch {
    // Ignore storage access errors
  }
  return 'system'
}

export function setThemeMode(mode: ThemeMode): void {
  const apply = () => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
    if (meta) {
      meta.content = mode === 'system' ? 'light dark' : mode
    }
    try {
      if (mode === 'system') {
        localStorage.removeItem(THEME_STORAGE_KEY)
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, mode)
      }
    } catch {
      // Ignore storage access errors
    }
  }

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!reduced && typeof document.startViewTransition === 'function') {
    document.startViewTransition(apply)
  } else {
    apply()
  }
}

export function getReadingFont(): ReadingFont {
  try {
    const stored = localStorage.getItem(READING_FONT_KEY)
    if (stored === 'serif') return 'serif'
  } catch {
    // Ignore
  }
  return 'sans'
}

export function setReadingFont(font: ReadingFont): void {
  try {
    localStorage.setItem(READING_FONT_KEY, font)
  } catch {
    // Ignore
  }
}

export function ensureChromaStylesheet(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector('link[href="/api/chroma.css"]')
  if (existing) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/api/chroma.css'
  link.setAttribute('data-inkbranch-chroma', 'true')
  document.head.appendChild(link)
}
