import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'

export function ThemeToggle() {
  const theme = useTheme((state) => state.theme)
  const toggleTheme = useTheme((state) => state.toggleTheme)
  const label = theme === 'light' ? '切换到深色模式' : '切换到浅色模式'
  return (
    <button type="button" onClick={toggleTheme} title={label} aria-label={label}
      aria-pressed={theme === 'dark'} className="vp-theme-toggle shrink-0">
      {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
    </button>
  )
}
