import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { isDesktopRuntime } from '@/features/canvas/canvasPort'

if (isDesktopRuntime()) document.title = 'Pi-Paper | 一张会创作的画布'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
