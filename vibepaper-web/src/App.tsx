import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppRouter } from '@/app/router'
import { useEffect } from 'react'
import { useAuth } from '@/lib/auth'
import { ToastHost } from '@/components/ui/Toast'
import { isDesktopRuntime } from '@/features/canvas/canvasPort'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

function Bootstrap() {
  const load = useAuth((s) => s.load)
  useEffect(() => {
    if (!isDesktopRuntime()) void load()
  }, [load])
  return <AppRouter />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Bootstrap />
        <ToastHost />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
