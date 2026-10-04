const assert = require('node:assert/strict')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const load = () => import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/official-audio-fish.ts')).href)

test('Fish S1 and S2 Pro use exact model headers and JSON speech, never inline cloning', async () => {
  const { generateFishAudio } = await load()
  for (const modelId of ['s1', 's2-pro']) {
    let requests = 0
    const result = await generateFishAudio({ providerId: 'fish-audio', modelId, modality: 'audio', operation: 'speech', prompt: 'hello', params: { speed: 1.2 } }, {
      apiKey: 'fixture-key', credentials: { voiceId: 'voice-fixture' }, fetch: async (url, init) => {
        requests++
        assert.equal(String(url), 'https://api.fish.audio/v1/tts')
        assert.equal(new Headers(init.headers).get('model'), modelId)
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-key')
        assert.deepEqual(JSON.parse(init.body), { text: 'hello', format: 'mp3', reference_id: 'voice-fixture', prosody: { speed: 1.2 } })
        return new Response(Buffer.from('ID3fixture-audio-bytes'), { headers: { 'content-type': 'audio/mpeg' } })
      },
    })
    assert.equal(requests, 1)
    assert.equal(result.outputs[0].mimeType, 'audio/mpeg')
  }
  const input = { providerId: 'fish-audio', modelId: 's1', modality: 'audio', prompt: 'hello' }
  const options = { apiKey: 'fixture-key', fetch: async () => { throw new Error('unexpected request') } }
  await assert.rejects(generateFishAudio({ ...input, references: [{ type: 'audio', base64: 'aGVsbG8=' }] }, options), (e) => e.code === 'REFERENCE_MEDIA_UNSUPPORTED')
  await assert.rejects(generateFishAudio({ ...input, params: { tone: 'happy' } }, options), (e) => e.code === 'UNSUPPORTED_AUDIO_PARAMETER')
  await assert.rejects(generateFishAudio({ ...input, modelId: 'unknown' }, options), (e) => e.code === 'UNSUPPORTED_MODEL')
  await assert.rejects(generateFishAudio({ ...input, params: { speed: 5 } }, options), (e) => e.code === 'INVALID_AUDIO_PARAMETER')
})

test('Fish errors redact credentials and do not accept HTML as audio', async () => {
  const { generateFishAudio } = await load()
  const input = { providerId: 'fish-audio', modelId: 's2-pro', modality: 'audio', prompt: 'hello' }
  await assert.rejects(generateFishAudio(input, { apiKey: 'fixture-key', fetch: async () => new Response('fixture-key invalid', { status: 401 }) }), (e) => !e.message.includes('fixture-key'))
  await assert.rejects(generateFishAudio(input, { apiKey: 'fixture-key', fetch: async () => new Response('<html>wrong response</html>', { headers: { 'content-type': 'text/html' } }) }), (e) => e.code === 'INVALID_PROVIDER_RESPONSE')
})
