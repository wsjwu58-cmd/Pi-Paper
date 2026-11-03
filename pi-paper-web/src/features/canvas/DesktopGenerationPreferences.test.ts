import { describe, expect, it } from 'vitest'
import type { DesktopProviderConfiguration } from '@/desktop/desktop-bridge'
import { desktopGenerationDefaults } from './DesktopGenerationPreferences'

describe('desktop generation preferences', () => {
  it('lists each usable provider default without inventing a global default', () => {
    const configuration = {
      providers: [
        { id: 'first', name: 'First', configured: true, enabledModelIds: ['first-image'], defaultModelIds: { image: 'first-image' } },
        { id: 'second', name: 'Second', configured: true, enabledModelIds: ['second-image'], defaultModelIds: { image: 'second-image' } },
        { id: 'disabled', name: 'Disabled', configured: true, enabledModelIds: [], defaultModelIds: { image: 'disabled-image' } },
        { id: 'unconfigured', name: 'Unconfigured', configured: false, enabledModelIds: ['unconfigured-image'], defaultModelIds: { image: 'unconfigured-image' } },
      ],
      models: [
        { id: 'first-image', displayName: 'First image', providerId: 'first', modelType: 'image', enabled: true, implemented: true, inputModes: ['text'], defaults: { size: '1K' } },
        { id: 'second-image', displayName: 'Second image', providerId: 'second', modelType: 'image', enabled: true, implemented: true, inputModes: ['text'], defaults: { resolution: '720p' } },
        { id: 'disabled-image', displayName: 'Disabled image', providerId: 'disabled', modelType: 'image', enabled: true, implemented: true, inputModes: ['text'] },
        { id: 'unconfigured-image', displayName: 'Unconfigured image', providerId: 'unconfigured', modelType: 'image', enabled: true, implemented: true, inputModes: ['text'] },
      ],
    } as unknown as DesktopProviderConfiguration

    expect(desktopGenerationDefaults(configuration, 'image')).toEqual([
      { providerId: 'first', providerName: 'First', name: 'First image', resolution: '1K' },
      { providerId: 'second', providerName: 'Second', name: 'Second image', resolution: '720p' },
    ])
    expect(desktopGenerationDefaults(configuration, 'video')).toEqual([])
  })
})
