const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

async function main() {
  const directory = path.resolve(__dirname, '..', 'release')
  const files = (await fs.readdir(directory)).filter((file) => /\.(exe|dmg|zip|AppImage|deb|tar\.gz)$/u.test(file)).sort()
  if (!files.length) throw new Error('No desktop packages found.')
  const lines = []
  for (const file of files) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path.join(directory, file))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${file}`)
  }
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
  console.log(`Generated SHA256 checksums for ${files.length} packages.`)
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
