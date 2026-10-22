// Explicitly authorized account test, separate from MCP/client acceptance.
// One creation POST only. Credential is no-echo stdin and is never persisted.
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { runVideoTask, postJson, getAgnesResponse } = require('../src/generation-worker.cjs')
const root = path.resolve(__dirname, '../..')

async function verifyVideo(outputPath) {
  const ffmpegPath = require('../src/compose-provider.cjs').resolveFfmpegPath()
  if (!ffmpegPath) throw new Error('ffmpeg_unavailable')
  const ffprobePath = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  const bytes = await fs.readFile(outputPath)
  const probe = spawnSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration:format=duration', '-of', 'json', outputPath], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const decode = spawnSync(ffmpegPath, ['-v', 'error', '-xerror', '-i', outputPath, '-f', 'null', '-'], { windowsHide: true, timeout: 30000 })
  if (probe.status !== 0 || decode.status !== 0) throw new Error('video_decode_failed')
  const metadata = JSON.parse(probe.stdout)
  const width = metadata.streams?.[0]?.width
  const height = metadata.streams?.[0]?.height
  const duration = Number(metadata.format?.duration)
  if (width !== 1280 || ![704, 720].includes(height) || !(duration >= 3.5 && duration <= 5)) throw new Error('video_specification_mismatch')
  const result = { path: outputPath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    width, height, duration, fullDecodePassed: true }
  bytes.fill(0)
  return result
}

async function verifyExisting() {
  const outputPath = path.resolve(process.argv[process.argv.indexOf('--verify-existing') + 1] || '')
  const relative = path.relative(path.join(root, '.test-temp'), outputPath)
  if (!/^agnes-direct-video-[^/\\]+[/\\]generated[/\\][a-f0-9-]{36}[/\\]result\.mp4$/iu.test(relative)
    || path.relative(outputPath, await fs.realpath(outputPath)) !== '') throw new Error('unsafe_existing_video')
  const report = { schemaVersion: 1, testType: 'read-only-direct-Agnes-video-output-verification',
    success: true, cloudRequestsMade: false, credentialAccessed: false,
    output: await verifyVideo(outputPath), verifiedAt: new Date().toISOString() }
  const reportPath = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance', `agnes-direct-video-output-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(`Evidence: ${reportPath}`)
  console.log(JSON.stringify(report, null, 2))
}

function secretFromStdin() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) return reject(new Error('tty_required'))
    let input = ''
    const finish = error => {
      process.stdin.off('data', receive)
      process.stdin.pause()
      process.stdin.setRawMode(false)
      if (error) reject(error)
      else resolve(input.trim())
    }
    const receive = bytes => {
      for (const character of bytes.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('operator_cancelled'))
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') input = input.slice(0, -1)
        else input += character
        if (input.length > 1024) return finish(new Error('credential_invalid'))
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.on('data', receive)
    process.stdin.resume()
  })
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/gu, '-')
  const runRoot = path.join(root, '.test-temp', `agnes-direct-video-${runId}-${randomUUID()}`)
  const taskId = randomUUID()
  const outputDirectory = path.join(runRoot, 'generated', taskId)
  await fs.mkdir(outputDirectory, { recursive: true })
  const report = { schemaVersion: 1, testType: 'direct-authorized-Agnes-video-account-test',
    startedAt: new Date().toISOString(), provider: 'agnes', model: 'agnes-video-2.5-flash',
    requested: { count: 1, seconds: 4, size: '720P', aspectRatio: '16:9', referenceMedia: false },
    success: false, mcpClientAcceptance: false, nativeConfirmationAcceptance: false,
    creationPostCalls: 0, statusGetCalls: 0, httpStatusCodes: [], providerStatuses: [],
    checkpointPhases: [], apiKeySaved: false, rawResponseSaved: false }
  console.log('DIRECT_VIDEO_KEY_STDIN_READY (no echo)')
  let secret = await secretFromStdin()
  const needle = Buffer.from(secret)
  const job = { taskId, outputDirectory, providerType: 'cloud', providerId: 'agnes',
    endpoint: 'https://apihub.agnes-ai.com/v1', modelId: 'agnes-video-2.5-flash', apiKey: secret,
    prompt: '蓝色陶瓷方块在白色影棚中缓慢旋转，固定镜头，柔和自然阴影，无文字。',
    parameters: { mode: 'text', duration: 4, resolution: '720P', ratio: '16:9' } }
  secret = ''
  require('../src/worker-network.cjs').initializeWorkerProxy()
  const tick = setInterval(() => console.log(`VIDEO_WAITING: post=${report.creationPostCalls}, query=${report.statusGetCalls}, status=${report.providerStatuses.at(-1) || 'unknown'}`), 45000)
  try {
    const result = await runVideoTask(job, {
      checkpoint: async checkpoint => {
        const temporary = path.join(runRoot, 'checkpoint.tmp')
        await fs.writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 })
        await fs.rename(temporary, path.join(runRoot, 'checkpoint.json'))
        report.checkpointPhases.push(checkpoint.phase)
      },
      postJson: async (...args) => {
        if (++report.creationPostCalls !== 1) throw new Error('duplicate_creation_blocked')
        console.log('VIDEO_CREATE_ONCE')
        const result = await postJson(...args)
        report.creationResponseIdentifiers = {
          videoIdPresent: typeof result?.video_id === 'string' || typeof result?.video_id === 'number',
          idPresent: typeof result?.id === 'string', taskIdPresent: typeof result?.task_id === 'string',
        }
        return result
      },
      getAgnesResponse: async (...args) => {
        report.statusGetCalls++
        const response = await getAgnesResponse(...args)
        if (!report.httpStatusCodes.includes(response.statusCode)) report.httpStatusCodes.push(response.statusCode)
        const chunks = []
        let length = 0
        response.on('data', chunk => { length += chunk.length; if (length <= 16384) chunks.push(Buffer.from(chunk)) })
        response.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const status = payload?.status
            if (['queued', 'pending', 'running', 'processing', 'completed', 'succeeded', 'failed', 'error', 'cancelled'].includes(status)
              && report.providerStatuses.at(-1) !== status) report.providerStatuses.push(status)
          } catch { /* No raw upstream body is retained. */ }
          for (const chunk of chunks) chunk.fill(0)
        })
        return response
      },
    })
    const outputPath = path.resolve(runRoot, result.outputPath)
    if (path.dirname(outputPath) !== outputDirectory) throw new Error('unexpected_output_path')
    report.output = await verifyVideo(outputPath)
    report.success = true
  } catch (error) {
    report.errorCode = /^[A-Z0-9_]{1,100}$/u.test(error?.code || '') ? error.code : 'DIRECT_VIDEO_TEST_FAILED'
    report.errorHttpStatus = Number.isInteger(error?.statusCode) ? error.statusCode : null
    report.queueFull = /队列.*满|queue.*full/iu.test(error?.message || '')
    report.notFound = /not found|不存在/iu.test(error?.message || '')
  } finally {
    clearInterval(tick)
    job.apiKey = ''
    report.completedAt = new Date().toISOString()
    report.checkpointContainsPlaintextKey = (await fs.readFile(path.join(runRoot, 'checkpoint.json')).catch(() => Buffer.alloc(0))).includes(needle)
    const evidencePath = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance', `agnes-direct-video-${runId}.json`)
    const encodedReport = JSON.stringify(report, null, 2)
    if (encodedReport.includes(needle.toString('utf8'))) throw new Error('secret_in_report_blocked')
    needle.fill(0)
    await fs.writeFile(evidencePath, encodedReport)
    console.log(`Evidence: ${evidencePath}`)
    console.log(encodedReport)
    if (!report.success) process.exitCode = 1
  }
}

;(process.argv.includes('--verify-existing') ? verifyExisting() : main())
  .catch(() => { console.error('DIRECT_VIDEO_QA_FAILED'); process.exitCode = 1 })
