const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { classify } = require('./changes.cjs')
const { checksum, collect, validateManifest } = require('./release-assets.cjs')
const { versionFromTag, assertPromotion } = require('./release.cjs')
const { validateGate } = require('./gate.cjs')

const expected = { sha: 'a'.repeat(40), version: '1.2.3', runId: '42' }
function manifest(platform, arch, extensions) {
  return { schemaVersion: 1, ...expected, platform, arch, release: true, macNotarized: platform === 'mac',
    files: extensions.map(ext => ({ name: `Pi-Paper-1.2.3-${platform}-${arch}.${ext}`, sha256: 'b'.repeat(64) })) }
}
function promotion() {
  return { release: { draft: false, prerelease: true, published_at: '2026-11-01T00:00:00Z' },
    record: { schemaVersion: 1, ...expected, tag: 'desktop-v1.2.3' },
    run: { conclusion: 'success', head_sha: expected.sha, event: 'push', path: '.github/workflows/desktop-release.yml' },
    latest: { tag_name: 'desktop-v1.2.2' }, tag: 'desktop-v1.2.3', now: Date.parse('2026-11-03T00:00:00Z') }
}

test('docs-only commits keep the stable gate and avoid application builds', () => {
  assert.deepEqual(classify(['README.md', 'docs/plans/example.md']), { runtime: false, docker: false })
})
test('runtime paths include renderer dependencies, skills, lockfiles and marketplace content', () => {
  for (const file of ['pi-paper-web/pnpm-lock.yaml', 'pi-paper-desktop/src/main.cjs', 'pi-main/packages/ai/src/index.ts', 'skills/a.md', 'marketplace/index.json']) {
    assert.deepEqual(classify([file]), { runtime: true, docker: false })
  }
})
test('workflow changes and scheduled/release runs validate all paths', () => {
  assert.deepEqual(classify(['.github/workflows/ci.yml']), { runtime: true, docker: true })
  assert.deepEqual(classify([], true), { runtime: true, docker: true })
  assert.deepEqual(classify(['Dockerfile']), { runtime: false, docker: true })
})
test('release tags must match stable package version syntax', () => {
  assert.equal(versionFromTag('desktop-v1.2.3'), '1.2.3')
  for (const tag of ['v1.2.3', '--help', 'desktop-v1.2.3-rc1', '../x']) assert.throws(() => versionFromTag(tag))
})
test('quality gate distinguishes intentional skips from missing required checks', () => {
  const jobs = { changes: { result: 'success', outputs: { runtime: 'false' } }, workflow: { result: 'success' } }
  for (const name of ['pi-agent-service', 'web', 'desktop']) jobs[name] = { result: 'skipped' }
  assert.doesNotThrow(() => validateGate('quality', jobs))
  jobs.changes.outputs.runtime = 'true'
  assert.throws(() => validateGate('quality', jobs))
  for (const name of ['pi-agent-service', 'web', 'desktop']) jobs[name].result = 'success'
  assert.doesNotThrow(() => validateGate('quality', jobs))
  jobs.desktop.result = 'cancelled'
  assert.throws(() => validateGate('quality', jobs))
})
test('final gate requires the selected installers and Docker checks', () => {
  const jobs = { changes: { result: 'success', outputs: { docker: 'false' } }, quality: { result: 'success' },
    installers: { result: 'skipped' }, docker: { result: 'skipped' } }
  assert.doesNotThrow(() => validateGate('final', jobs))
  assert.throws(() => validateGate('final', jobs, true))
  jobs.installers.result = 'success'
  assert.doesNotThrow(() => validateGate('final', jobs, true))
  jobs.changes.outputs.docker = 'true'
  assert.throws(() => validateGate('final', jobs, true))
})
test('manifests reject unsigned, wrong-source and incomplete macOS packages', () => {
  const item = manifest('mac', 'arm64', ['dmg', 'zip'])
  assert.equal(validateManifest(item, expected), 'mac-arm64')
  for (const patch of [{ sha: 'c'.repeat(40) }, { runId: 'other' }, { release: false }, { macNotarized: false }, { files: item.files.slice(0, 1) }]) {
    assert.throws(() => validateManifest({ ...item, ...patch }, expected))
  }
})
test('promotion needs successful same-source CI, observation and increasing version', () => {
  assert.doesNotThrow(() => assertPromotion(promotion()))
  for (const patch of [{ now: Date.parse('2026-11-01T12:00:00Z') }, { latest: { tag_name: 'desktop-v1.3.0' } },
    { run: { ...promotion().run, conclusion: 'failure' } }, { run: { ...promotion().run, head_sha: 'c'.repeat(40) } },
    { release: { ...promotion().release, draft: true } }, { run: { ...promotion().run, event: 'pull_request' } }]) {
    assert.throws(() => assertPromotion({ ...promotion(), ...patch }))
  }
})
test('collection verifies actual bytes, all four targets and duplicate platforms', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paper-ci-artifacts-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packages = [manifest('win', 'x64', ['exe']), manifest('linux', 'x64', ['AppImage', 'deb']),
    manifest('mac', 'x64', ['dmg', 'zip']), manifest('mac', 'arm64', ['dmg', 'zip'])]
  for (const item of packages) {
    const folder = path.join(directory, `${item.platform}-${item.arch}`)
    fs.mkdirSync(folder)
    for (const file of item.files) {
      fs.writeFileSync(path.join(folder, file.name), 'installer fixture')
      file.sha256 = await checksum(path.join(folder, file.name))
    }
    fs.writeFileSync(path.join(folder, `manifest-${item.platform}-${item.arch}.json`), JSON.stringify(item))
  }
  assert.equal((await collect(directory, expected)).length, 11)
  const executable = path.join(directory, 'win-x64', packages[0].files[0].name)
  fs.writeFileSync(executable, 'tampered')
  await assert.rejects(collect(directory, expected), /Checksum mismatch/)
  fs.writeFileSync(executable, 'installer fixture')
  fs.cpSync(path.join(directory, 'win-x64'), path.join(directory, 'duplicate'), { recursive: true })
  await assert.rejects(collect(directory, expected), /Duplicate/)
  fs.rmSync(path.join(directory, 'duplicate'), { recursive: true })
  fs.rmSync(path.join(directory, 'mac-arm64'), { recursive: true })
  await assert.rejects(collect(directory, expected), /four/)
})
