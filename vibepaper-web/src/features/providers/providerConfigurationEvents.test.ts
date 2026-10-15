import { describe, expect, it } from 'vitest'
import {
  hasUnsavedProviderConfigurationDraft,
  providerConfigurationRefreshQueryKeys,
  shouldAdoptProviderDraftAfterRefresh,
} from './providerConfigurationEvents'

const baseline = {
  providerId: 'fixture-provider',
  baseUrl: 'https://api.example.test',
  timeoutSeconds: 120,
  enabledModelIds: ['image-model'],
  defaultModelIds: { image: 'image-model' },
  modelDefaults: { 'image-model': { size: '1024' } },
}

const cleanDraft = { ...baseline, credentials: {} }

describe('provider configuration refresh events', () => {
  it('ignores canvas and general connection state events', () => {
    expect(providerConfigurationRefreshQueryKeys({ type: 'state.changed' }, 1)).toEqual([])
    expect(providerConfigurationRefreshQueryKeys({
      type: 'canvas.changed', projectId: 'project', canvasId: 'canvas', version: 2,
      operationId: 'operation', source: 'external_mcp',
    }, 1)).toEqual([])
  })

  it('refreshes model queries for newer configuration and same-revision probe events', () => {
    expect(providerConfigurationRefreshQueryKeys({
      type: 'provider.configuration.changed', providerId: 'fixture-provider', revision: 2,
    }, 1)).toEqual([['models'], ['desktop-provider-configuration']])
    expect(providerConfigurationRefreshQueryKeys({
      type: 'provider.configuration.changed', providerId: 'fixture-provider', revision: 2,
    }, 2)).toEqual([['models'], ['desktop-provider-configuration']])
  })

  it('keeps the current draft and connection-test notice on same-revision probe refresh', () => {
    const probeResult = { type: 'provider.configuration.changed', providerId: 'fixture-provider', revision: 2 } as const
    expect(providerConfigurationRefreshQueryKeys(probeResult, 2)).toEqual([['models'], ['desktop-provider-configuration']])
    expect(shouldAdoptProviderDraftAfterRefresh(probeResult, 2, false)).toBe(false)
    expect(shouldAdoptProviderDraftAfterRefresh({ ...probeResult, revision: 3 }, 2, false)).toBe(true)
    expect(shouldAdoptProviderDraftAfterRefresh({ ...probeResult, revision: 3 }, 2, true)).toBe(false)
  })

  it('treats a typed credential or public setting change as a draft to preserve', () => {
    expect(hasUnsavedProviderConfigurationDraft(cleanDraft, baseline)).toBe(false)
    expect(hasUnsavedProviderConfigurationDraft({ ...cleanDraft, credentials: { apiKey: 'entered-secret' } }, baseline)).toBe(true)
    expect(hasUnsavedProviderConfigurationDraft({ ...cleanDraft, baseUrl: 'https://custom.example.test' }, baseline)).toBe(true)
    expect(hasUnsavedProviderConfigurationDraft({ ...cleanDraft, timeoutSeconds: 121 }, baseline)).toBe(true)
  })
})
