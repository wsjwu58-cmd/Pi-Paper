import { NavLink, useNavigate } from 'react-router-dom'
import { LayoutGrid, Clock, Compass, User, Building2, ShieldCheck, LogOut } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'

const items = [
  { to: '/workspace', label: '画布管理', icon: LayoutGrid },
  { to: '/history', label: '历史记录', icon: Clock },
  { to: '/gallery', label: '创意广场', icon: Compass },
  { to: '/profile', label: '个人中心', icon: User },
]

export function PillNav() {
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const navigate = useNavigate()
  const isAdmin = user && (user.role === 'ops_admin' || user.role === 'super_admin')

  if (window.vibepaperDesktop) {
    const desktopItems = [
      { to: '/workspace', label: '画布展示', icon: LayoutGrid },
      { to: '/history', label: '历史记录', icon: Clock },
    ]
    return (
      <nav className="mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-full border border-black/[0.05] bg-white px-1.5 py-1.5 shadow-[0_8px_28px_rgba(15,23,42,0.08)]">
        {desktopItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'inline-flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold transition',
                isActive
                  ? 'bg-[#111111] text-white [&_svg]:stroke-white'
                  : 'text-[#666] hover:bg-black/[0.04] hover:text-[#111]',
              )
            }
          >
            <item.icon size={16} strokeWidth={2.2} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    )
  }

  return (
    <nav className="mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-full border border-black/[0.05] bg-white px-1.5 py-1.5 shadow-[0_8px_28px_rgba(15,23,42,0.08)]">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) =>
            cn(
              'inline-flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold transition',
              isActive
                ? 'bg-[#111111] text-white [&_svg]:stroke-white'
                : 'text-[#666] hover:bg-black/[0.04] hover:text-[#111]',
            )
          }
        >
          <it.icon size={16} strokeWidth={2.2} />
          <span>{it.label}</span>
        </NavLink>
      ))}
      <NavLink
        to="/enterprise"
        className={({ isActive }) =>
          cn(
            'hidden h-10 items-center gap-2 rounded-full px-3 text-[13px] font-semibold transition lg:inline-flex',
            isActive
              ? 'bg-[#111111] text-white [&_svg]:stroke-white'
              : 'text-[#888] hover:bg-black/[0.04] hover:text-[#111]',
          )
        }
        title="企业中心"
      >
        <Building2 size={15} strokeWidth={2.2} />
      </NavLink>
      {isAdmin ? (
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            cn(
              'inline-flex h-10 items-center gap-2 rounded-full px-3 text-[13px] font-semibold transition',
              isActive
                ? 'bg-[#111111] text-white [&_svg]:stroke-white'
                : 'text-[#888] hover:bg-black/[0.04] hover:text-[#111]',
            )
          }
          title="后台管理"
        >
          <ShieldCheck size={15} strokeWidth={2.2} />
        </NavLink>
      ) : null}
      <button
        type="button"
        onClick={async () => {
          await logout()
          navigate('/login')
        }}
        className="ml-0.5 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#888] hover:bg-red-50 hover:text-red-600"
        title="退出登录"
      >
        <LogOut size={16} />
      </button>
    </nav>
  )
}
