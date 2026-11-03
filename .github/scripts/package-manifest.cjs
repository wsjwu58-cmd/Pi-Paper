const fs = require('node:fs')
const path = require('node:path')

const directory = path.resolve('pi-paper-desktop/release')
const platform = process.env.PACKAGE_PLATFORM
const arch = process.env.PACKAGE_ARCH
const sha = process.env.GITHUB_SHA
if (!['win', 'mac', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || !/^[a-f0-9]{40}$/u.test(sha)) {
  throw new Error('Invalid package provenance')
}
const checksums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')
const files = checksums.map(line => {
  const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line)
  if (!match) throw new Error('Invalid checksum entry')
  return { name: match[2], sha256: match[1] }
})
const manifest = {
  schemaVersion: 1,
  version: require('../../pi-paper-desktop/package.json').version,
  sha, platform, arch,
  release: process.env.RELEASE_BUILD === 'true',
  macNotarized: platform === 'mac' && process.env.RELEASE_BUILD === 'true',
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  files,
}
fs.writeFileSync(path.join(directory, `manifest-${platform}-${arch}.json`), JSON.stringify(manifest, null, 2) + '\n')
