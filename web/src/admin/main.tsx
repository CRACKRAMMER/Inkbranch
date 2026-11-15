import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ensureChromaStylesheet, getThemeMode } from '../lib/theme'
import '../styles.css'
import AdminApp from './AdminApp'

const initialTheme = getThemeMode()
if (initialTheme !== 'system') {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (meta) {
    meta.content = initialTheme
  }
}
ensureChromaStylesheet()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="flex min-h-screen flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <main id="main-content" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <AdminApp />
      </main>
    </div>
  </StrictMode>,
)
