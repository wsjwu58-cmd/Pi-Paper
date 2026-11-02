import type { QueryFunctionContext } from '@tanstack/react-query'

export function canvasPageQueryOptions<T>(canvasId: string, desktop: boolean, load: (id: string) => Promise<T>) {
  return {
    queryKey: ['canvas', canvasId] as const,
    queryFn: async (context: QueryFunctionContext<readonly ['canvas', string]>) => {
      if (!desktop) return load(canvasId)
      // Consume the signal so an in-flight read from the previous page is
      // cancelled on unmount and cannot satisfy this page's fresh query.
      const signal = context.signal
      const snapshot = await load(canvasId)
      if (signal.aborted) throw new DOMException('Canvas load cancelled', 'AbortError')
      return snapshot
    },
    retry: 1,
    ...(desktop ? { refetchOnMount: 'always' as const } : {}),
  }
}

export function canHydrateCanvasPage(desktop: boolean, state: { isFetchedAfterMount: boolean; isSuccess: boolean }) {
  return !desktop || (state.isFetchedAfterMount && state.isSuccess)
}
