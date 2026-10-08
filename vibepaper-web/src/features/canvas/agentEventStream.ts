const MIN_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5000

export function getEventStreamReconnectDelay(retryMs: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.max(MIN_RECONNECT_DELAY_MS, retryMs))
}

export function shouldReloadSessionAfterStream(events: readonly { type?: unknown }[]): boolean {
  return events.some((event) => event.type === 'confirmation_required' || event.type === 'confirm_required')
}

export function scrollChatToBottom(element: HTMLElement): void {
  element.scrollTo({ top: element.scrollHeight, behavior: 'auto' })
}
