const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runOfficialTask } = require('../src/generation-worker.cjs')
const taskId = '99999999-9999-4999-8999-999999999999'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l0AAAAASUVORK5CYII=', 'base64')

async function jobFixture(t, modality) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-pi-output-'))
  const outputDirectory = path.join(root, 'generated', taskId)
  await fs.mkdir(outputDirectory, { recursive: true })
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, job: { taskId, providerId: 'openai', modality, apiModelId: 'fixture', prompt: 'test',
    parameters: {}, outputDirectory, apiKey: 'fixture-key' } }
}

test('Pi media bridge writes all indexed image outputs and retains validated references', async (t) => {
  const { root, job } = await jobFixture(t, 'image')
  const sourceUrl = `data:image/png;base64,${png.toString('base64')}`
  job.parameters = { referenceImages: [], sourceUrl, imageUrl: sourceUrl }
  const result = await runOfficialTask(job, { api: { executeOfficialGeneration: async (input, options) => {
    assert.equal(options.apiKey, 'fixture-key')
    assert.equal(input.references[0].mimeType, 'image/png')
    assert.equal(input.references.length, 1)
    return { outputs: [1, 2].map(() => ({ base64: png.toString('base64'), mimeType: 'image/png' })) }
  } } })
  assert.deepEqual(result.outputPaths, [`generated/${taskId}/result.png`, `generated/${taskId}/result-1.png`])
  for (const file of result.outputPaths) assert.deepEqual(await fs.readFile(path.join(root, file)), png)
})

test('Pi audio bridge validates and persists binary speech output', async (t) => {
  const { root, job } = await jobFixture(t, 'audio')
  const wav = Buffer.from('RIFF0000WAVEfmt fixture', 'ascii')
  const result = await runOfficialTask(job, { api: { executeOfficialGeneration: async () => ({ outputs: [
    { base64: wav.toString('base64'), mimeType: 'audio/wav' },
  ] }) } })
  assert.deepEqual(await fs.readFile(path.join(root, result.outputPath)), wav)
  await assert.rejects(runOfficialTask(job, { api: { executeOfficialGeneration: async () => ({ outputs: [
    { base64: Buffer.from('<html>').toString('base64'), mimeType: 'audio/wav' },
  ] }) } }), /格式|内容|signature/)
})

test('canvas controls normalize to provider params without losing user style or references', async (t) => {
  const { job } = await jobFixture(t, 'video')
  job.parameters = { prompt: 'test', resKey: '480P', size: '480p', resolution: '480p', ratio: '16:9', aspect: '16:9',
    style: 'ink', camera: 'pan', count: 1, referenceImages: [], referenceTexts: [], upstreamNodeIds: ['node-fixture'], duration: 5 }
  await runOfficialTask(job, { api: { executeOfficialGeneration: async (input) => {
    assert.deepEqual(input.params, { resolution: '480p', ratio: '16:9', duration: 5 })
    assert.equal(input.prompt, 'test\n\nStyle: ink\n\nCamera: pan')
    return { outputs: [{ base64: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]).toString('base64'), mimeType: 'video/mp4' }] }
  } } })
  job.parameters.aspect = '1:1'
  await assert.rejects(runOfficialTask(job, { api: {} }), (error) => error.code === 'CLOUD_INPUT_INVALID')
})

test('Pi asynchronous bridge waits for persisted submission before obtaining its output', async (t) => {
  const { job } = await jobFixture(t, 'video')
  const events = []
  const video = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
  await runOfficialTask(job, { checkpoint: async (value) => events.push(value.phase), api: {
    executeOfficialGeneration: async (_input, options) => {
      await options.onSubmitting()
      await options.onSubmitted('remote-42')
      assert.deepEqual(events, ['submitting', 'submitted'])
      return { outputs: [{ base64: video.toString('base64'), mimeType: 'video/mp4' }] }
    },
  } })
})

test('Pi asynchronous bridge refuses to submit without durable checkpoint storage', async (t) => {
  const { job } = await jobFixture(t, 'video')
  let submitted = false
  await assert.rejects(runOfficialTask(job, { api: {
    executeOfficialGeneration: async (_input, options) => {
      await options.onSubmitting()
      submitted = true
      return { outputs: [] }
    },
  } }), /检查点/)
  assert.equal(submitted, false)
})
