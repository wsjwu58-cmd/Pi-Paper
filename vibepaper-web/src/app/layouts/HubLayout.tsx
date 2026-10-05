import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ArrowLeft, Clock, LayoutGrid, Settings2 } from 'lucide-react'
import { PillNav } from '@/components/ui/PillNav'
import { isDesktopRuntime } from '@/features/canvas/canvasPort'

export function HubLayout() {
  const location = useLocation()
  if (isDesktopRuntime() && location.pathname === '/settings/providers') {
    return (
      <div className="min-h-screen bg-[#f6f8fb] text-[#172238]">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-[#e4e9f1] bg-[#f9fbfd] px-5 lg:px-8">
          <NavLink to="/workspace" className="flex items-center gap-3 text-lg font-bold tracking-tight"><LayoutGrid size={23} />Pi-Paper</NavLink>
          <NavLink to="/workspace" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[#647086] hover:bg-[#edf1f7]"><ArrowLeft size={16} />返回画布管理</NavLink>
        </header>
        <div className="flex min-h-[calc(100vh-4rem)]">
          <aside className="hidden w-[220px] shrink-0 border-r border-[#e4e9f1] px-4 py-7 lg:flex lg:flex-col xl:w-[232px]">
            <p className="mb-6 px-3 text-lg font-bold">创作工作区</p>
            <nav aria-label="工作区导航" className="space-y-2">
              {[
                { to: '/workspace', label: '画布管理', icon: LayoutGrid },
                { to: '/history', label: '历史记录', icon: Clock },
                { to: '/settings/providers', label: 'API 配置', icon: Settings2 },
              ].map((item) => <NavLink key={item.to} to={item.to} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] transition ${isActive ? 'bg-[#e9eef7] font-semibold text-[#173f85]' : 'text-[#526079] hover:bg-[#edf1f7]'}`}><item.icon size={20} />{item.label}</NavLink>)}
            </nav>
            <p className="mt-auto px-3 pt-10 text-xs leading-5 text-[#8490a3]">本地项目 · 官方模型连接</p>
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
