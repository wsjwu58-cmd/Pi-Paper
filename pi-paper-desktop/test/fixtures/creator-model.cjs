const http = require('node:http')

const draft = { name: '商品三视图', description: '', components: [{ id: 'three-views', type: 'template', name: '三视图', description: '', data: {
  nodes: ['front', 'side', 'back'].flatMap((name, index) => [
    { id: `${name}-text`, type: 'text', x: 0, y: index * 300, params: { content: `${name} shooting requirements` } },
    { id: `${name}-image`, type: 'image', x: 350, y: index * 300, params: {} },
  ]), edges: ['front', 'side', 'back'].map((name) => ({ source: `${name}-text`, target: `${name}-image` })),
} }] }

async function startCreatorModelFixture() {
  const calls = [], seenSchemas = []
  let step = 0, draftDigest, packageId, packageDigest
  const respond = async (req, res) => {
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    const request = JSON.parse(Buffer.concat(parts).toString())
    seenSchemas.push((request.tools ?? []).map((tool) => tool.function?.name))
    const lastTool = [...request.messages].reverse().find((message) => message.role === 'tool')
    let last = null
    if (lastTool) {
      try { last = JSON.parse(lastTool.content) } catch { throw new Error(`Fixture tool result was not JSON: ${lastTool.content}`) }
    }
    let name, args
    if (step === 0) { name = 'marketplace_inspect'; args = { componentType: 'template' } }
    else if (step === 1) { name = 'creator_validate'; args = { draft } }
    else if (step === 2) { draftDigest = last.draftDigest; name = 'creator_save'; args = { draft, draftDigest } }
    else if (step === 3) { packageId = last.packageId; packageDigest = last.digest; name = 'creator_install'; args = { packageId, digest: packageDigest, componentIds: ['three-views'] } }
    else if (step === 4) { name = 'creator_enable'; args = { packageId, digest: packageDigest, componentId: 'three-views', enabled: true } }
    else if (step === 5) { name = 'marketplace_apply'; args = { packageId, digest: packageDigest, componentId: 'three-views' } }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const chunk = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
    if (name) {
      calls.push(name)
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      chunk({}, 'tool_calls')
    } else { chunk({ role: 'assistant', content: '已保存商品三视图并插入画布，尚未生成图片。' }); chunk({}, 'stop') }
    step += 1
    res.end('data: [DONE]\n\n')
  }
  const server = http.createServer((req, res) => {
    respond(req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { calls, seenSchemas, server, get packageId() { return packageId } }
}

module.exports = { startCreatorModelFixture }
