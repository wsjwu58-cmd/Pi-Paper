import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, Clock, LayoutGrid, Settings2 } from 'lucide-react'
import { PillNav } from '@/components/ui/PillNav'
import { isDesktopRuntime } from '@/features/canvas/canvasPort'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { LanguagePicker } from '@/components/ui/LanguagePicker'

export function HubLayout() {
  useUiLanguage()
  const location = useLocation()
  const navigate = useNavigate()
  const desktop = isDesktopRuntime()
  useEffect(() => {
    if (!desktop) return
    const bridge = window.vibepaperDesktop
    if (!bridge) return
    let disposed = false
    const unsubscribe = bridge.subscribeMcpProviderInput((request) => {
      if (disposed || location.pathname === '/settings/providers') return
      void bridge.getActiveProject().then((active) => {
        // The project lookup is asynchronous. A user can navigate while it is
        // pending, so do not let an old provider request steal the new route.
        if (disposed || location.pathname === '/settings/providers') return
        if (active?.projectId !== request.projectId || active.canvasId !== request.canvasId) return
        navigate('/settings/providers', {
          state: { returnTo: location.pathname, mcpProviderInput: request },
        })
      }).catch(() => undefined)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [desktop, location.pathname, navigate])

  if (desktop && location.pathname.startsWith('/settings/')) {
    return (
      <div className="min-h-screen bg-[#f6f8fb] text-[#172238]">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-[#e4e9f1] bg-[#f9fbfd] px-5 lg:px-8">
          <NavLink to="/workspace" className="flex items-center gap-3 text-lg font-bold tracking-tight"><LayoutGrid size={23} />Pi-Paper</NavLink>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LanguagePicker />
            <NavLink to="/workspace" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[#647086] hover:bg-[#edf1f7]"><ArrowLeft size={16} />{uiText("返回画布管理")}</NavLink>
          </div>
        </header>
        <div className="flex min-h-[calc(100vh-4rem)]">
          <aside className="hidden w-[220px] shrink-0 border-r border-[#e4e9f1] px-4 py-7 lg:flex lg:flex-col xl:w-[232px]">
            <p className="mb-6 px-3 text-lg font-bold">{uiText("创作工作区")}</p>
            <nav aria-label={uiText("工作区导航")} className="space-y-2">
              {[
                { to: '/workspace', label: uiText("画布管理"), icon: LayoutGrid },
                { to: '/history', label: uiText("历史记录"), icon: Clock },
                { to: '/settings/providers', label: uiText("API 配置"), icon: Settings2 },
                { to: '/settings/mcp', label: uiText("外部 Agent"), icon: Bot },
              ].map((item) => <NavLink key={item.to} to={item.to} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] transition ${isActive ? 'bg-[#e9eef7] font-semibold text-[#173f85]' : 'text-[#526079] hover:bg-[#edf1f7]'}`}><item.icon size={20} />{item.label}</NavLink>)}
            </nav>
            <p className="mt-auto px-3 pt-10 text-xs leading-5 text-[#8490a3]">{uiText("本地项目 · 官方模型连接")}</p>
          </aside>
          <main className="min-w-0 flex-1 px-4 py-6 md:px-7 xl:px-8 xl:py-7"><Outlet /></main>
        </div>
      </div>
    )
  }
  return (
    <div className="vp-hub-shell">
      <div className="pointer-events-none sticky top-0 z-40 px-3 pt-5 pb-1">
        <div className="pointer-events-auto">
          <PillNav />
        </div>
      </div>
      <main className="w-full px-5 pb-20 pt-10 md:px-8 lg:px-10">
        <Outlet />
      </main>
    </div>
  )
}
