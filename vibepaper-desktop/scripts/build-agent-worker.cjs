const path = require('node:path')
const fs = require('node:fs/promises')
const { build } = require('esbuild')

const desktopRoot = path.resolve(__dirname, '..')
const piRoot = path.resolve(desktopRoot, '..', 'pi-main')
const desktopNodeModules = path.join(desktopRoot, 'node_modules')
const outputFile = path.join(desktopRoot, 'dist', 'agent-worker.cjs')
const mcpSource = path.join(desktopRoot, 'src')
const mcpOutput = path.join(desktopRoot, 'dist')

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
  await build({
    entryPoints: [path.join(piRoot, 'packages', 'ai', 'src', 'media', 'index.ts')],
    outfile: path.join(desktopRoot, 'dist', 'pi-official-media.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22.19',
    external: ['node:*'], nodePaths: [path.join(piRoot, 'node_modules')],
    legalComments: 'none', sourcemap: false,
  })
  // The installed app has no node_modules tree. Bundle the official MCP SDK into
  // the stdio entry and keep only the local launcher-to-stdio edge external.
  await build({
    entryPoints: [path.join(mcpSource, 'mcp-stdio.cjs')],
    outfile: path.join(mcpOutput, 'mcp-stdio.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.19',
    external: ['node:*'],
    nodePaths: [desktopNodeModules],
    legalComments: 'none',
    sourcemap: false,
  })
  await build({
    entryPoints: [path.join(mcpSource, 'mcp-launcher.cjs')],
    outfile: path.join(mcpOutput, 'mcp-launcher.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.19',
    external: ['node:*', './mcp-stdio.cjs'],
    nodePaths: [desktopNodeModules],
    legalComments: 'none',
    sourcemap: false,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '无法构建 Agent Worker。')
  process.exitCode = 1
})
