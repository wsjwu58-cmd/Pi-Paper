import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { isDesktopRuntime } from '@/features/canvas/canvasPort'
import { initializeTheme } from '@/lib/theme'
import { initializeUiLanguage } from '@/lib/i18n'

if (isDesktopRuntime()) {
  initializeTheme()
  await initializeUiLanguage()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
