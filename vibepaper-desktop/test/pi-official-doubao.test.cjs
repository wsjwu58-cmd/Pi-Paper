const assert = require('node:assert/strict')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const load = () => import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/official-audio-doubao.ts')).href)
const input = { providerId: 'doubao-voice', modelId: 'seed-tts-2.0', modality: 'audio', operation: 'speech', prompt: 'hello', params: { speed: 1.2 } }
const options = { apiKey: 'fixture-key', credentials: { voiceId: 'speaker-fixture' } }
const audio = Buffer.from('ID3fixture-audio-bytes')
const sse = (events) => new Response(events.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

test('Doubao v2 uses speech credentials and joins complete SSE audio chunks', async () => {
  const { generateDoubaoSpeech } = await load()
  const result = await generateDoubaoSpeech(input, { ...options, fetch: async (url, init) => {
    assert.equal(String(url), 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse')
    assert.equal(new Headers(init.headers).get('X-Api-Resource-Id'), 'seed-tts-2.0')
    assert.equal(new Headers(init.headers).get('X-Api-Key'), 'fixture-key')
    assert.match(new Headers(init.headers).get('X-Api-Request-Id'), /^[a-f0-9-]{36}$/)
    assert.deepEqual(JSON.parse(init.body).req_params, { text: 'hello', speaker: 'speaker-fixture', audio_params: { format: 'mp3', speech_rate: 20 } })
    return sse([{ code: 0, data: audio.subarray(0, 8).toString('base64') }, { code: 0, data: audio.subarray(8).toString('base64') }, { code: 20000000, message: 'OK' }])
  } })
  assert.deepEqual(Buffer.from(result.outputs[0].base64, 'base64'), audio)
})

test('Doubao refuses partial streams, malformed envelopes, unsupported inputs and leaks', async () => {
  const { generateDoubaoSpeech } = await load()
  await assert.rejects(generateDoubaoSpeech(input, { ...options, fetch: async () => sse([{ code: 0, data: audio.toString('base64') }]) }), (e) => e.code === 'INCOMPLETE_PROVIDER_RESPONSE')
  await assert.rejects(generateDoubaoSpeech(input, { ...options, fetch: async () => sse([{ code: 45000000, message: 'fixture-key denied' }]) }), (e) => e.code === 'PROVIDER_GENERATION_FAILED' && !e.message.includes('fixture-key'))
  await assert.rejects(generateDoubaoSpeech(input, { ...options, fetch: async () => sse([{ data: audio.toString('base64') }]) }), (e) => e.code === 'PROVIDER_GENERATION_FAILED')
  await assert.rejects(generateDoubaoSpeech({ ...input, references: [{ type: 'audio' }] }, options), (e) => e.code === 'UNSUPPORTED_OPERATION')
  await assert.rejects(generateDoubaoSpeech({ ...input, params: { tone: 'happy' } }, options), (e) => e.code === 'UNSUPPORTED_AUDIO_PARAMETER')
})
