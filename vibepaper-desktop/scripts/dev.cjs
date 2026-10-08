const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const desktopRoot = path.resolve(__dirname, '..')
const webRoot = path.resolve(desktopRoot, '..', 'vibepaper-web')
const viteCli = path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const electronCli = path.join(desktopRoot, 'node_modules', 'electron', 'cli.js')
const rendererUrl = 'http://127.0.0.1:5173'

const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--strictPort'], {
  cwd: webRoot,
  env: process.env,
  stdio: 'inherit',
})

let electron = null
let stopping = false

function canReachRenderer() {
  return new Promise((resolve) => {
    const request = http.get(rendererUrl, (response) => {
      response.resume()
      resolve(response.statusCode !== undefined && response.statusCode < 500)
    })
    request.setTimeout(750, () => {
      request.destroy()
      resolve(false)
    })
    request.on('error', () => resolve(false))
  })
}

function stop(child) {
  if (child && child.exitCode === null && !child.killed) child.kill()
}

async function start() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (vite.exitCode !== null) throw new Error('Vite exited before the renderer became ready.')
    if (await canReachRenderer()) break
    if (attempt === 239) throw new Error('Timed out waiting for Vite at 127.0.0.1:5173.')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  electron = spawn(process.execPath, [electronCli, desktopRoot], {
    cwd: desktopRoot,
    env: { ...process.env, VITE_DEV_SERVER_URL: rendererUrl },
    stdio: 'inherit',
  })
  electron.on('close', (code) => {
    stop(vite)
    process.exitCode = code ?? 0
  })
}

function shutdown() {
  if (stopping) return
  stopping = true
  stop(electron)
  stop(vite)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
vite.on('close', (code) => {
  if (!stopping && code !== 0 && code !== null) {
    console.error(`Vite exited with code ${code}.`)
    shutdown()
    process.exitCode = code
  }
})

start().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Could not start the desktop app.')
  shutdown()
  process.exitCode = 1
})
