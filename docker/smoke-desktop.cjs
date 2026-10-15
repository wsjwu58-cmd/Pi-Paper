const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require('playwright')
const root = path.resolve(__dirname, '..')
function compose(...args) {
  const result = spawnSync('docker', ['compose', ...args], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Docker Compose command failed')
}
async function main() {
  for (const script of ['smoke-package.cjs', 'smoke-agent-worker.cjs']) {
    compose('exec', '-T', '-e', 'ELECTRON_RUN_AS_NODE=1', 'pi-paper', '/opt/pi-paper/pi-paper', '/opt/pi-paper/smoke/' + script, '/opt/pi-paper/resources/app')
  }
  const base = 'http://127.0.0.1:' + (process.env.PI_PAPER_PORT || '8080')
  const password = (await fs.readFile(path.join(__dirname, 'secrets/vnc-password.txt'), 'utf8')).trim()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.goto(base + '/vnc.html')
    await page.evaluate(async ({ password }) => {
      const { default: RFB } = await import('/core/rfb.js')
      const screen = document.createElement('div')
      screen.style.cssText = 'position:fixed;inset:0;background:#222'
      document.body.replaceChildren(screen)
      const connection = new RFB(screen, location.origin.replace('http', 'ws') + '/websockify', { credentials: { password } })
      connection.scaleViewport = true
      connection.addEventListener('connect', () => { window.desktopConnected = true })
      connection.addEventListener('securityfailure', () => { window.desktopSecurityFailed = true })
      window.desktopConnection = connection
    }, { password })
    await page.waitForFunction(() => window.desktopConnected === true, { timeout: 30000 })
    assert.equal(await page.evaluate(() => window.desktopSecurityFailed === true), false)
    await page.locator('canvas').waitFor({ state: 'visible' })
    await page.waitForTimeout(2000)
    await fs.mkdir(path.join(root, '.test-temp'), { recursive: true })
    await page.screenshot({ path: path.join(root, '.test-temp/docker-desktop.png') })
    console.log('Authenticated noVNC browser connection and desktop screenshot passed.')
  } finally { await browser.close() }
  compose('exec', '-T', 'pi-paper', 'bash', '-c', 'printf "persisted" > /projects/.docker-smoke-persistence')
  compose('restart', 'pi-paper')
  compose('up', '-d', '--wait', '--wait-timeout', '180')
  compose('exec', '-T', 'pi-paper', 'bash', '-c', 'test "$(cat /projects/.docker-smoke-persistence)" = persisted && rm /projects/.docker-smoke-persistence')
  console.log('Container restart and project-volume persistence passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
