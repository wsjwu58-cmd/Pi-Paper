const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..', '..')
const readProjectFile = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

test('canvas export is exposed as a project-scoped read-only desktop bridge operation', () => {
  const localCore = readProjectFile('vibepaper-desktop/src/local-core.cjs')
  const main = readProjectFile('vibepaper-desktop/src/main.cjs')
  const preload = readProjectFile('vibepaper-desktop/src/preload.cjs')
  const bridgeTypes = readProjectFile('vibepaper-web/src/desktop/desktop-bridge.d.ts')

  assert.match(localCore, /case 'canvas:export':\s+return store\.exportCanvas\(payload\?\.projectId, payload\?\.canvasId\)/u)
  assert.match(main, /ipcMain\.handle\('desktop:canvas:export',[\s\S]*assertTrustedSender\(event\)/u)
  assert.match(main, /localCore\.request\('canvas:export', \{ projectId, canvasId \}\)/u)
  assert.match(preload, /exportCanvas: \(projectId, canvasId\) => ipcRenderer\.invoke\('desktop:canvas:export', projectId, canvasId\)/u)
  assert.match(bridgeTypes, /exportCanvas\(projectId: string, canvasId: string\): Promise<DesktopCanvasExportDocument>/u)
  assert.match(bridgeTypes, /export interface DesktopCanvasExportDocument/u)
})
