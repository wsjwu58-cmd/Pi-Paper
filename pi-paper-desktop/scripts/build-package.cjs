const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')

const desktopRoot = path.resolve(__dirname, '..')
const webRoot = path.resolve(desktopRoot, '..', 'pi-paper-web')
const piRoot = path.resolve(desktopRoot, '..', 'pi-main')
const appRoot = path.join(desktopRoot, 'dist', 'app')

function run(script, cwd, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Build failed: ${script}`)
}

async function main() {
  // Use Node entry points so no shell quoting or global npm executable is required.
  run(path.join(webRoot, 'node_modules', 'typescript', 'bin', 'tsc'), webRoot, ['-b'])
  const vite = spawnSync(process.execPath, [path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: webRoot, stdio: 'inherit',
  })
  if (vite.error) throw vite.error
  if (vite.status !== 0) throw new Error('Renderer build failed.')
  run(path.join(__dirname, 'build-agent-worker.cjs'), desktopRoot)
  run(path.join(__dirname, 'smoke-agent-worker.cjs'), desktopRoot)

  // Only this known, generated staging directory is replaced; no project data is copied.
  if (path.relative(desktopRoot, appRoot) !== path.join('dist', 'app')) throw new Error('Invalid staging directory.')
  await fs.rm(appRoot, { recursive: true, force: true })
  await fs.mkdir(path.join(appRoot, 'src'), { recursive: true })
  for (const entry of await fs.readdir(path.join(desktopRoot, 'src'))) {
    if (entry.endsWith('.cjs') && entry !== 'agent-worker.cjs' && entry !== 'project-agent-skills.cjs') {
      await fs.copyFile(path.join(desktopRoot, 'src', entry), path.join(appRoot, 'src', entry))
    }
  }
  await build({
    entryPoints: [path.join(desktopRoot, 'src', 'project-agent-skills.cjs')],
    outfile: path.join(appRoot, 'src', 'project-agent-skills.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22.19',
    external: ['node:*'], nodePaths: [path.join(piRoot, 'node_modules')],
    legalComments: 'none', sourcemap: false,
  })
  await fs.mkdir(path.join(appRoot, 'dist'), { recursive: true })
  for (const filename of ['agent-worker.cjs', 'pi-official-media.cjs']) {
    await fs.copyFile(path.join(desktopRoot, 'dist', filename), path.join(appRoot, 'dist', filename))
  }
  await fs.cp(path.join(webRoot, 'dist'), path.join(appRoot, 'renderer'), { recursive: true })
  await fs.cp(path.join(desktopRoot, 'assets'), path.join(appRoot, 'assets'), { recursive: true })
  const { name, version, productName, description, main: entrypoint } = require('../package.json')
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
    name, version, productName, description, main: entrypoint,
    author: 'Pi-Paper Contributors', license: 'UNLICENSED',
    homepage: 'https://github.com/wsjwu58-cmd/Pi-Paper',
  }, null, 2) + '\n')
  console.log(`Standalone desktop application staged at ${appRoot}`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
