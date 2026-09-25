import { Navigate, Route, Routes } from 'react-router-dom'
import { HubLayout } from '@/app/layouts/HubLayout'
import { useAuth } from '@/lib/auth'
import { LoginPage } from '@/features/auth/LoginPage'
import { RegisterPage } from '@/features/auth/RegisterPage'
import { WorkspacePage } from '@/features/workspace/WorkspacePage'
import { HistoryPage } from '@/features/history/HistoryPage'
import { GalleryPage } from '@/features/gallery/GalleryPage'
import { ProfilePage } from '@/features/profile/ProfilePage'
import { EnterprisePage } from '@/features/enterprise/EnterprisePage'
import { SubscriptionsPage } from '@/features/subscriptions/SubscriptionsPage'
import { RewardsPage } from '@/features/rewards/RewardsPage'
import { InvitesPage } from '@/features/invites/InvitesPage'
import { AnnouncementsPage } from '@/features/announcements/AnnouncementsPage'
import { AdminPage } from '@/features/admin/AdminPage'
import { CanvasPage } from '@/features/canvas/CanvasPage'
import { Spinner } from '@/components/ui/Spinner'

function Protected({ children }: { children: React.ReactNode }) {
  const ready = useAuth((s) => s.ready)
  const user = useAuth((s) => s.user)
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user)
  if (user && (user.role === 'ops_admin' || user.role === 'super_admin')) return <>{children}</>
  return <Navigate to="/workspace" replace />
}

export function AppRouter() {
  if (window.vibepaperDesktop) {
    return (
      <Routes>
        <Route path="/" element={<Navigate to="/workspace" replace />} />
        <Route element={<HubLayout />}>
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/history" element={<HistoryPage />} />
        </Route>
        <Route path="/canvas/:canvasId" element={<CanvasPage />} />
        <Route path="*" element={<Navigate to="/workspace" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <Protected>
            <HubLayout />
          </Protected>
        }
      >
        <Route path="/" element={<Navigate to="/workspace" replace />} />
        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/gallery" element={<GalleryPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        {/* 订阅/奖励/邀请/公告入口在画布右上角账户菜单；保留路由便于深链 */}
        <Route path="/subscriptions" element={<SubscriptionsPage />} />
        <Route path="/rewards" element={<RewardsPage />} />
        <Route path="/invites" element={<InvitesPage />} />
        <Route path="/announcements" element={<AnnouncementsPage />} />
        <Route path="/enterprise" element={<EnterprisePage />} />
        <Route
          path="/admin"
          element={
            <AdminGuard>
              <AdminPage />
            </AdminGuard>
          }
        />
      </Route>
      <Route
        path="/canvas/:id"
        element={
          <Protected>
            <CanvasPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/workspace" replace />} />
    </Routes>
  )
}
