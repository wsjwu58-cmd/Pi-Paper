import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { canHydrateCanvasPage, canvasPageQueryOptions } from './canvasPageQuery'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('desktop canvas reopen', () => {
  it('waits for this mount to read the current version before allowing hydration', async () => {
    const qc = client()
    const read = deferred<{ version: number }>()
    const load = vi.fn(() => read.promise)
    const options = { ...canvasPageQueryOptions('canvas-1', true, load), retry: false }
    qc.setQueryData(options.queryKey, { version: 4 })
    const observer = new QueryObserver(qc, options)
    const unsubscribe = observer.subscribe(() => {})
    try {
      expect(load).toHaveBeenCalledOnce()
      expect(observer.getCurrentResult().data).toEqual({ version: 4 })
      expect(canHydrateCanvasPage(true, observer.getCurrentResult())).toBe(false)
      read.resolve({ version: 7 })
      await vi.waitFor(() => expect(canHydrateCanvasPage(true, observer.getCurrentResult())).toBe(true))
      expect(observer.getCurrentResult().data).toEqual({ version: 7 })

      // Subsequent authoritative changes on the existing key stay usable; a
      // version update does not send the page back into its initial gate.
      qc.setQueryData(options.queryKey, { version: 8 })
      expect(canHydrateCanvasPage(true, observer.getCurrentResult())).toBe(true)
      expect(observer.getCurrentResult().data).toEqual({ version: 8 })
    } finally {
      unsubscribe()
      qc.clear()
    }
  })

  it('does not reuse a previous page\'s in-flight read after it unmounts', async () => {
    const qc = client()
    const earlier = deferred<{ version: number }>()
    const current = deferred<{ version: number }>()
    const load = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(current.promise)
    const options = { ...canvasPageQueryOptions('canvas-1', true, load), retry: false }
    qc.setQueryData(options.queryKey, { version: 4 })
    const previousPage = new QueryObserver(qc, options)
    const disposePrevious = previousPage.subscribe(() => {})
    expect(load).toHaveBeenCalledTimes(1)
    disposePrevious()
    const reopenedPage = new QueryObserver(qc, options)
    const disposeReopened = reopenedPage.subscribe(() => {})
    try {
      expect(load).toHaveBeenCalledTimes(2)
      earlier.resolve({ version: 5 })
      await Promise.resolve()
      await Promise.resolve()
      expect(canHydrateCanvasPage(true, reopenedPage.getCurrentResult())).toBe(false)
      expect(reopenedPage.getCurrentResult().data).toEqual({ version: 4 })
      current.resolve({ version: 7 })
      await vi.waitFor(() => expect(canHydrateCanvasPage(true, reopenedPage.getCurrentResult())).toBe(true))
      expect(reopenedPage.getCurrentResult().data).toEqual({ version: 7 })
    } finally {
      disposeReopened()
      qc.clear()
    }
  })

  it('keeps a failed fresh desktop read closed and retains the Web cache contract', async () => {
    const qc = client()
    const read = deferred<{ version: number }>()
    const options = { ...canvasPageQueryOptions('canvas-1', true, () => read.promise), retry: false }
    qc.setQueryData(options.queryKey, { version: 4 })
    const observer = new QueryObserver(qc, options)
    const unsubscribe = observer.subscribe(() => {})
    try {
      read.reject(new Error('load failed'))
      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true))
      expect(canHydrateCanvasPage(true, observer.getCurrentResult())).toBe(false)
      const webOptions = canvasPageQueryOptions('canvas-1', false, async () => ({ version: 10 }))
      expect(webOptions.queryKey).toEqual(options.queryKey)
      expect(canHydrateCanvasPage(false, observer.getCurrentResult())).toBe(true)
      expect(qc.getQueryData(webOptions.queryKey)).toEqual({ version: 4 })
    } finally {
      unsubscribe()
      qc.clear()
    }
  })
})
