const { AGNES_MODELS, AGNES_PROVIDER_ID } = require('./agnes-model-catalog.cjs')

function buildDesktopAgentModelDirectory(agnes, localTextModel, localAudioModel) {
  const models = []
  const cloudDefinitions = [
    ['text', AGNES_MODELS.text, ['text']],
    ['image', AGNES_MODELS.image, ['text']],
    ['video', AGNES_MODELS.video, ['text']],
  ]

  for (const [modelType, name, inputModes] of cloudDefinitions) {
    models.push({
      name,
      displayName: name,
      modelType,
      providerId: AGNES_PROVIDER_ID,
      providerType: 'cloud',
      enabled: agnes?.apiKeyConfigured === true,
      modalities: [modelType],
      inputModes,
      toolCalling: false,
      streaming: false,
      cancellation: false,
    })
  }

  if (localTextModel && typeof localTextModel.modelId === 'string' && localTextModel.modelId.trim()) {
    models.push({
      name: localTextModel.modelId,
      displayName: localTextModel.modelId,
      modelType: 'text',
      providerId: 'local-openai-compatible',
      providerType: 'local',
      enabled: true,
      modalities: ['text'],
      inputModes: ['text'],
      toolCalling: false,
      streaming: false,
      cancellation: false,
    })
  }

  if (localAudioModel && typeof localAudioModel.modelId === 'string' && localAudioModel.modelId.trim()) {
    models.push({
      name: localAudioModel.modelId,
      displayName: 'Windows SAPI 语音合成',
      modelType: 'audio',
      providerId: localAudioModel.providerId,
      providerType: 'local',
      enabled: localAudioModel.available === true,
      modalities: ['audio'],
      inputModes: ['text'],
      toolCalling: false,
      streaming: false,
      cancellation: false,
      ...(typeof localAudioModel.unavailableReason === 'string' && localAudioModel.unavailableReason
        ? { unavailableReason: localAudioModel.unavailableReason }
        : {}),
    })
  }
  return models
}

function isDesktopAgentGenerationTarget(node, modality) {
  return Boolean(node && typeof node === 'object' && !Array.isArray(node)
    && ['text', 'image', 'video', 'audio'].includes(modality) && node.type === modality)
}

module.exports = { buildDesktopAgentModelDirectory, isDesktopAgentGenerationTarget }
