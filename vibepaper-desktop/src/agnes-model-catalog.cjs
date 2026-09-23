const AGNES_PROVIDER_ID = 'agnes'
const AGNES_PROVIDER_TYPE = 'cloud'
const AGNES_API_BASE_URL = 'https://apihub.agnes-ai.com/v1'

const AGNES_MODELS = Object.freeze({
  text: 'agnes-2.5-flash',
  image: 'agnes-image-2.5-flash',
  video: 'agnes-video-2.5-flash',
})

function getAgnesModelCatalog(apiKeyConfigured) {
  return {
    providerId: AGNES_PROVIDER_ID,
    providerType: AGNES_PROVIDER_TYPE,
    apiBaseUrl: AGNES_API_BASE_URL,
    models: { ...AGNES_MODELS },
    apiKeyConfigured: apiKeyConfigured === true,
    modalities: ['text', 'image', 'video'],
    inputModes: { text: ['text'], image: ['text'], video: ['text'] },
    toolCalling: false,
    streaming: false,
    cancellation: false,
  }
}

module.exports = { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID, getAgnesModelCatalog }
