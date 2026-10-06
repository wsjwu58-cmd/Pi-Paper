const assert = require('node:assert/strict')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const importSource = (name) => import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media', name)).href)

test('official text catalog resolves exact provider protocol and reasoning metadata', async () => {
  const { OFFICIAL_TEXT_MODELS } = await importSource('official-text-models.ts')
  const { resolveOfficialTextModel } = await importSource('official-text.ts')
  const { getOfficialProviderCatalog } = await importSource('catalog.ts')
  assert.equal(OFFICIAL_TEXT_MODELS.length, 19)
  for (const entry of OFFICIAL_TEXT_MODELS) {
    const { model } = resolveOfficialTextModel({ providerId: entry.providerId, modelId: entry.apiModelId }, { apiKey: 'fixture-key' })
    assert.equal(model.api, entry.api)
    assert.equal(model.reasoning, entry.reasoning)
    assert.equal(model.contextWindow, entry.contextWindow)
    const registered = getOfficialProviderCatalog().models.find((m) => m.name === entry.name)
    assert.equal(registered.apiModelId, entry.apiModelId)
    assert.equal(registered.implemented, true)
    assert.equal(registered.enabled, false)
  }
  const kimi = getOfficialProviderCatalog().models.find((m) => m.name === 'Kimi K2.5')
  assert.equal(kimi.implemented, false)
})

test('DeepSeek streams text through Pi and returns real usage', async () => {
  const { generateOfficialText } = await importSource('official-text.ts')
  let requests = 0
  const result = await generateOfficialText({ providerId: 'deepseek', modelId: 'deepseek-flash', modality: 'text', prompt: 'hello' }, {
    apiKey: 'fixture-key', fetch: async (_url, init) => {
      requests++
      assert.equal(JSON.parse(init.body).model, 'deepseek-flash')
      const chunks = [{ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
        { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }]
      return new Response(chunks.map((v) => `data: ${JSON.stringify(v)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  assert.equal(requests, 1)
  assert.equal(result.text, 'hello')
  assert.equal(result.usage.total, 4)
})

test('Claude adaptive thinking rejects temperature overrides before sending', async () => {
  const { generateOfficialText } = await importSource('official-text.ts')
  let requested = false
  await assert.rejects(generateOfficialText({ providerId: 'anthropic', modelId: 'claude-fable-5-1', modality: 'text', prompt: 'hello', params: { temperature: 0.5 } }, {
    apiKey: 'fixture-key', fetch: async () => { requested = true; throw new Error('unexpected') },
  }), (error) => error.code === 'UNSUPPORTED_PARAMETER')
  assert.equal(requested, false)
})

test('each verified text family sends its exact model ID over the expected Pi protocol', async () => {
  const { OFFICIAL_TEXT_MODELS } = await importSource('official-text-models.ts')
  const { generateOfficialText } = await importSource('official-text.ts')
  for (const entry of OFFICIAL_TEXT_MODELS) {
    let requests = 0
    const originalFetch = globalThis.fetch
    const googleFetch = async (url, init) => {
      requests++
      assert.match(String(url), new RegExp(`${entry.apiModelId}:streamGenerateContent`))
      assert.ok(JSON.parse(init.body).contents)
      return new Response(JSON.stringify({ error: { message: 'Rejected fixture-key' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    if (entry.providerId === 'google') globalThis.fetch = googleFetch
    try {
    await assert.rejects(generateOfficialText({ providerId: entry.providerId, modelId: entry.apiModelId, modality: 'text', prompt: 'hello' }, {
      apiKey: 'fixture-key', fetch: entry.providerId === 'google' ? googleFetch : async (url, init) => {
        requests++
        const body = JSON.parse(init.body)
        if (entry.providerId === 'google') {
          assert.match(String(url), new RegExp(`${entry.apiModelId}:streamGenerateContent`))
          assert.ok(body.contents)
        } else {
          assert.equal(body.model, entry.apiModelId)
          assert.match(String(url), entry.api === 'anthropic-messages' ? /\/messages$/ : entry.api === 'openai-responses' ? /\/responses$/ : /\/chat\/completions$/)
        }
        if (entry.providerId === 'anthropic' && !entry.apiModelId.includes('haiku')) {
          assert.equal(body.thinking.type, 'adaptive')
          assert.equal(body.temperature, undefined)
        }
        return new Response(JSON.stringify({ error: { message: 'Rejected fixture-key', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      },
    }), (error) => error.code === 'PROVIDER_REQUEST_FAILED' && !error.message.includes('fixture-key'))
    } finally { globalThis.fetch = originalFetch }
    assert.equal(requests, 1, entry.name)
  }
})
