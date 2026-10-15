const fs = require('node:fs/promises')
const path = require('node:path')

async function main() {
  const desktopRoot = path.resolve(__dirname, '..')
  const dataDirectory = path.resolve(desktopRoot, '..', 'pi-main', 'packages', 'ai', 'src', 'providers', 'data')
  // Public provider/model metadata only; no credentials or project settings.
  const snapshot = JSON.parse(await fs.readFile(path.join(desktopRoot, 'assets', 'pi-model-data.snapshot.json'), 'utf8'))
  if (snapshot.schemaVersion !== 1 || !snapshot.files || typeof snapshot.files !== 'object') {
    throw new Error('Invalid Pi model catalog snapshot.')
  }
  const entries = Object.entries(snapshot.files)
  if (!entries.length || entries.some(([file, content]) =>
    !/^(?:[a-z0-9-]+\.json|\.manifest\.json)$/u.test(file) || typeof content !== 'string')) {
    throw new Error('Invalid Pi model catalog snapshot files.')
  }
  await fs.mkdir(dataDirectory, { recursive: true })
  for (const [file, content] of entries) {
    JSON.parse(content)
    await fs.writeFile(path.join(dataDirectory, file), content)
  }
  console.log(`Restored ${entries.length} public Pi model catalog files for offline packaging.`)
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
