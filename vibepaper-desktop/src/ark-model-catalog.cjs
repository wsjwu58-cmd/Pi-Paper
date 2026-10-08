const ARK_PROVIDER_ID = 'volcengine-ark'
const ARK_PROVIDER_TYPE = 'cloud'
const ARK_API_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_VIDEO_MODEL_ID = 'doubao-seedance-2-5-260628'
const ARK_MODELS = Object.freeze({ video: ARK_VIDEO_MODEL_ID })

function getArkModelCatalog(apiKeyConfigured) {
  return {
    providerId: ARK_PROVIDER_ID,
    providerType: ARK_PROVIDER_TYPE,
    apiBaseUrl: ARK_API_BASE_URL,
    models: { ...ARK_MODELS },
    apiKeyConfigured: apiKeyConfigured === true,
    modalities: ['video'],
    inputModes: { video: ['text', 'image', 'video', 'audio'] },
    toolCalling: false,
    streaming: false,
    cancellation: false,
  }
}

function resolveArkVideoModelConfig({ providerId, modality, modelId, apiKey }) {
  if (providerId !== ARK_PROVIDER_ID || modality !== 'video' || modelId !== ARK_VIDEO_MODEL_ID) {
    const error = new Error('火山方舟模型配置与任务类型不匹配。')
    error.code = 'CLOUD_MODEL_CONFIGURATION_INVALID'
    throw error
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    const error = new Error('尚未配置火山方舟 API Key。')
    error.code = 'CLOUD_CREDENTIAL_MISSING'
    throw error
  }
  return {
    providerId: ARK_PROVIDER_ID,
    providerType: ARK_PROVIDER_TYPE,
    endpoint: ARK_API_BASE_URL,
    modelId: ARK_VIDEO_MODEL_ID,
    apiKey,
  }
}

module.exports = {
  ARK_API_BASE_URL,
  ARK_MODELS,
  ARK_PROVIDER_ID,
  ARK_PROVIDER_TYPE,
  ARK_VIDEO_MODEL_ID,
  getArkModelCatalog,
  resolveArkVideoModelConfig,
}
