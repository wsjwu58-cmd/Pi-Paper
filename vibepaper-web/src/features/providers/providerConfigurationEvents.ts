import type { DesktopMcpEvent } from '@/desktop/desktop-bridge'

export interface ProviderConfigurationDraft {
  providerId: string
  baseUrl: string
  timeoutSeconds: number
  credentials: Record<string, string>
  enabledModelIds: string[]
  defaultModelIds: Record<string, string>
  modelDefaults: Record<string, Record<string, unknown>>
}

export type ProviderConfigurationDraftBaseline = Omit<ProviderConfigurationDraft, 'credentials'>

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function hasUnsavedProviderConfigurationDraft(
  current: ProviderConfigurationDraft,
  baseline: ProviderConfigurationDraftBaseline | null,
): boolean {
  if (!baseline || current.providerId !== baseline.providerId) return true
  if (Object.values(current.credentials).some((value) => value.length > 0)) return true
  return stableJson({
    baseUrl: current.baseUrl,
    timeoutSeconds: current.timeoutSeconds,
    enabledModelIds: current.enabledModelIds,
    defaultModelIds: current.defaultModelIds,
    modelDefaults: current.modelDefaults,
  }) !== stableJson({
    baseUrl: baseline.baseUrl,
    timeoutSeconds: baseline.timeoutSeconds,
    enabledModelIds: baseline.enabledModelIds,
    defaultModelIds: baseline.defaultModelIds,
    modelDefaults: baseline.modelDefaults,
  })
}

export function providerConfigurationRefreshQueryKeys(
  event: DesktopMcpEvent,
  knownRevision?: number,
): readonly (readonly string[])[] {
  if (event.type !== 'provider.configuration.changed'
    || !Number.isSafeInteger(event.revision) || event.revision < 0
    || knownRevision !== undefined && event.revision < knownRevision) return []
  return [['models'], ['desktop-provider-configuration']] as const
}

export function shouldAdoptProviderDraftAfterRefresh(
  event: DesktopMcpEvent,
  knownRevision: number | undefined,
  hasUnsavedDraft: boolean,
): boolean {
  return event.type === 'provider.configuration.changed'
    && Number.isSafeInteger(event.revision)
    && event.revision >= 0
    && (knownRevision === undefined || event.revision > knownRevision)
    && !hasUnsavedDraft
}
