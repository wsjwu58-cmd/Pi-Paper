const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const targets = ['linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']
const extensions = { 'linux-x64': ['AppImage', 'deb'], 'mac-arm64': ['dmg', 'zip'], 'mac-x64': ['dmg', 'zip'], 'win-x64': ['exe'] }

async function checksum(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function validateManifest(manifest, { sha, version, runId }) {
  const target = `${manifest.platform}-${manifest.arch}`
  if (manifest.schemaVersion !== 1 || !targets.includes(target) || manifest.sha !== sha
    || manifest.version !== version || manifest.runId !== runId || manifest.release !== true
    || (manifest.platform === 'mac' && manifest.macNotarized !== true)) throw new Error(`Unverified package: ${target}`)
  const expected = extensions[target].map(ext => `Pi-Paper-${version}-${manifest.platform}-${manifest.arch}.${ext}`).sort()
  // electron-builder expands ${os} to mac, win or linux.
  const actual = manifest.files.map(file => file.name).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Incomplete package files: ${target}`)
  for (const file of manifest.files) {
    if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid package checksum')
  }
  return target
}

async function collect(directory, expected) {
  const files = []
  const found = new Set()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = path.join(directory, entry.name)
    const manifests = fs.readdirSync(folder).filter(name => /^manifest-.*\.json$/u.test(name))
    if (manifests.length !== 1) throw new Error(`Expected one manifest in ${entry.name}`)
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, manifests[0]), 'utf8'))
    const target = validateManifest(manifest, expected)
    if (found.has(target)) throw new Error(`Duplicate package: ${target}`)
    found.add(target)
    for (const file of manifest.files) {
      const source = path.join(folder, file.name)
      if (await checksum(source) !== file.sha256) throw new Error(`Checksum mismatch: ${file.name}`)
      files.push({ ...file, source })
    }
    files.push({ name: manifests[0], source: path.join(folder, manifests[0]), sha256: await checksum(path.join(folder, manifests[0])) })
  }
  if (JSON.stringify([...found].sort()) !== JSON.stringify(targets)) throw new Error('All four platform/architecture packages are required')
  return files
}

module.exports = { checksum, validateManifest, collect }
