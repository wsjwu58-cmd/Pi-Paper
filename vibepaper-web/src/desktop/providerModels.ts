import type { ModelInfo } from '@/lib/types'
import type { DesktopProviderConfiguration, DesktopProviderModel } from './desktop-bridge'

const OFFICIAL_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  minimax: 'MiniMax',
  xai: 'xAI',
  volcengine: '火山方舟',
  'volcengine-ark': '火山方舟',
}

export function desktopProviderLabel(providerId: string, catalogName: string): string {
  return OFFICIAL_PROVIDER_LABELS[providerId.toLowerCase()] || catalogName
}

export type DesktopModelInfo = Omit<ModelInfo, 'id'> & {
  id: string
  providerType: 'local' | 'cloud'
  providerId: string
  brandId: string
  operation?: string
  apiModelId: string
  inputModes: string[]
  toolCalling?: boolean
  constraints?: Record<string, unknown>
}

/** Convert the public IPC snapshot into only models that are safe to offer. */
export function toAvailableDesktopModels(
  configuration: DesktopProviderConfiguration,
  modelType?: string,
  requiredInputs: string[] = [],
): DesktopModelInfo[] {
  const configuredProviders = new Map(
    configuration.providers.filter((provider) => provider.configured).map((provider) => [provider.id, provider]),
  )

  return configuration.models
    .filter((model) => {
      const provider = configuredProviders.get(model.providerId)
      return Boolean(
        provider &&
        provider.enabledModelIds.includes(model.id) &&
        model.enabled &&
        model.implemented &&
        (!modelType || model.modelType === modelType) &&
        requiredInputs.every((input) => model.inputModes.includes(input)),
      )
    })
    .map((model) => toModelInfo(model, configuration))
}

export function toDesktopModelInfo(model: DesktopProviderModel, configuration: DesktopProviderConfiguration): DesktopModelInfo {
  return toModelInfo(model, configuration)
}

function toModelInfo(model: DesktopProviderModel, configuration: DesktopProviderConfiguration): DesktopModelInfo {
  const provider = configuration.providers.find((candidate) => candidate.id === model.providerId)
  const brandId = model.brandId || model.providerId
  return {
    id: model.id,
    // The stable binding ID is used by the task and Agent APIs. The provider
    // resolves apiModelId when sending the official request.
    name: model.id,
    modelType: model.modelType,
    displayName: model.displayName || model.name || model.apiModelId,
    // ModelPicker groups desktop models by the catalog's explicit brand. The
    // providerId remains separate and is used for routing generation calls.
    provider: brandId,
    providerId: model.providerId,
    brandId,
    operation: model.operation,
    providerType: model.providerType ?? provider?.providerType ?? 'cloud',
    apiModelId: model.apiModelId,
    inputModes: model.inputModes,
    toolCalling: model.toolCalling,
    constraints: model.constraints,
    enabled: model.enabled,
    basePrice: null as unknown as number,
    defaultParams: model.defaults,
    description: model.unavailableReason ?? undefined,
  }
}

export function desktopProviderNameMap(configuration: DesktopProviderConfiguration): Record<string, string> {
  const names: Record<string, string> = Object.fromEntries(configuration.providers.map((provider) => [
    provider.id,
    desktopProviderLabel(provider.id, provider.name),
  ]))
  for (const model of configuration.models) {
    if (!model.brandId) continue
    const provider = configuration.providers.find((candidate) => candidate.id === model.providerId)
    names[model.brandId] = model.brandName
      || OFFICIAL_PROVIDER_LABELS[model.brandId.toLowerCase()]
      || (model.brandId === model.providerId && provider ? desktopProviderLabel(provider.id, provider.name) : undefined)
      || (provider ? desktopProviderLabel(provider.id, provider.name) : undefined)
      || model.brandId
  }
  return names
}

export function defaultDesktopModelId(configuration: DesktopProviderConfiguration, modelType: string): string | undefined {
  for (const provider of configuration.providers) {
    const bindingId = provider.defaultModelIds?.[modelType]
    if (!bindingId) continue
    const available = toAvailableDesktopModels(configuration, modelType).some((model) => model.id === bindingId)
    if (available) return bindingId
  }
  const models = toAvailableDesktopModels(configuration, modelType)
  const recommended = { text: 'Claude Fable 5.1', image: 'Seedream 5.0 Pro', video: 'Seedance 2.5' }[modelType as 'text' | 'image' | 'video']
  return models.find((model) => model.displayName === recommended)?.id ?? models[0]?.id
}
