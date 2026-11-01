const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
test('preview diagnostics identify only bytes returned for read_task_output', async () => {
  const base = path.resolve(__dirname, '../../.test-temp')
  await fs.mkdir(base, { recursive: true })
  const run = await fs.mkdtemp(path.join(base, 'mcp-preview-observer-'))
  const out = path.join(run, 'wire.json'),
    spec = path.join(run, 'spec.json')
  const payload = Buffer.alloc(1700000, 0x61),
    encoded = payload.toString('base64')
  const req = (id, name) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: { prompt: 'not-for-telemetry' } },
    })
  const server = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{const {id}=JSON.parse(l);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{content:[{type:'resource',resource:{uri:'fixture:test',mimeType:'video/mp4',blob:Buffer.alloc(1700000,0x61).toString('base64')}}]}})+'\\n')});`
  await fs.writeFile(
    spec,
    JSON.stringify({
      command: process.execPath,
      args: ['-e', server],
      env: {},
      evidencePath: out,
      fingerprintMediaPreviews: true,
    }),
  )
  const p = spawn(process.execPath, [path.resolve(__dirname, '../scripts/observe-mcp-client.cjs'), spec], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let forwarded = 0
  p.stdout.on('data', (chunk) => {
    forwarded += chunk.length
  })
  p.stderr.resume()
  const closed = new Promise((resolve, reject) => {
    p.once('error', reject)
    p.once('close', resolve)
  })
  p.stdin.end(req(1, 'get_context') + '\n' + req(2, 'read_task_output') + '\n')
  assert.equal(await closed, 0)
  assert.ok(forwarded >= encoded.length * 2)
  const raw = await fs.readFile(out, 'utf8'),
    report = JSON.parse(raw)
  assert.ok(!raw.includes('not-for-telemetry') && !raw.includes(encoded.slice(0, 80)))
  const results = report.events.filter((e) => e.responseTo === 'tools/call')
  assert.equal(results.length, 2)
  assert.equal(results[0].preview, undefined)
  assert.deepEqual(results[1].preview, {
    mimeType: 'video/mp4',
    sizeBytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  })
  await Promise.all([fs.unlink(out), fs.unlink(spec)])
  await fs.rmdir(run)
})
