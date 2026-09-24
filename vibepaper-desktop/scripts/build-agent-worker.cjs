const path = require('node:path')
const fs = require('node:fs/promises')
const { build } = require('esbuild')

const desktopRoot = path.resolve(__dirname, '..')
const piRoot = path.resolve(desktopRoot, '..', 'pi-main')
const outputFile = path.join(desktopRoot, 'dist', 'agent-worker.cjs')

async function main() {
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await build({
    entryPoints: [path.join(desktopRoot, 'src', 'agent-worker.cjs')],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.19',
    external: ['node:*'],
    nodePaths: [path.join(piRoot, 'node_modules')],
    legalComments: 'none',
    sourcemap: false,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '无法构建 Agent Worker。')
  process.exitCode = 1
})
