const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { checksum, collect } = require('./release-assets.cjs')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}
function api(endpoint, args = []) {
  return JSON.parse(gh(['api', endpoint, ...args]))
}
function listReleases(endpoint) {
  return api(`${endpoint}/releases?per_page=100`, ['--paginate', '--slurp']).flat()
}
function versionFromTag(tag) {
  const match = /^desktop-v(\d+\.\d+\.\d+)$/u.exec(tag)
  if (!match) throw new Error('Use an immutable desktop-vMAJOR.MINOR.PATCH tag')
  return match[1]
}
function assertPromotion({ release, record, run, latest, tag, now = Date.now() }) {
  versionFromTag(tag)
  if (release.draft || !release.prerelease) throw new Error('Only a published prerelease can be promoted')
  if (!Number.isFinite(Date.parse(release.published_at)) || now - Date.parse(release.published_at) < 24 * 60 * 60 * 1000) {
    throw new Error('The prerelease needs at least 24 hours of observation')
  }
  if (record.schemaVersion !== 1 || !/^\d+$/u.test(record.runId)
    || record.tag !== tag || record.version !== versionFromTag(tag) || !/^[a-f0-9]{40}$/u.test(record.sha)
    || run.conclusion !== 'success' || run.head_sha !== record.sha || run.event !== 'push'
    || run.path !== '.github/workflows/desktop-release.yml') throw new Error('Release source or successful workflow provenance is missing')
  if (latest && latest.tag_name !== tag) {
    const previous = versionFromTag(latest.tag_name).split('.').map(Number)
    const next = record.version.split('.').map(Number)
    const firstDifference = next.findIndex((value, i) => value !== previous[i])
    if (firstDifference === -1 || next[firstDifference] < previous[firstDifference]) throw new Error('An older version cannot replace the latest release')
  }
}

async function main() {
  const mode = process.argv[2]
  const repo = process.env.GITHUB_REPOSITORY
  const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME
  const version = versionFromTag(tag)
  const endpoint = `repos/${repo}`
  if (mode === 'preflight') {
    if (require('../../pi-paper-desktop/package.json').version !== version) throw new Error('Tag and package version differ')
    const resolved = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
    if (resolved !== process.env.GITHUB_SHA) throw new Error('Tag does not resolve to this workflow commit')
    const branch = process.env.RELEASE_BRANCH
    execFileSync('git', ['merge-base', '--is-ancestor', resolved, `origin/${branch}`])
    return
  }
  if (mode === 'stage') {
    const expected = { sha: process.env.GITHUB_SHA, version, runId: process.env.GITHUB_RUN_ID }
    const files = await collect('artifacts', expected)
    const directory = path.resolve('.test-temp/publish')
    fs.mkdirSync(directory, { recursive: true })
    for (const file of files) fs.copyFileSync(file.source, path.join(directory, file.name))
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.name}`).sort().join('\n') + '\n')
    const record = { schemaVersion: 1, tag, version, sha: expected.sha, runId: expected.runId,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${expected.runId}`,
      files: files.map(({ name, sha256 }) => ({ name, sha256 })) }
    fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(record, null, 2) + '\n')
    const notes = path.join(directory, 'notes.md')
    fs.writeFileSync(notes, `## Preview ${version}\n\nSource commit \`${record.sha}\`. [Build and verification](${record.runUrl}).\n\nmacOS packages are signed and notarized. Windows packages currently have no Authenticode signing.\n\nBack up your project before opening it with a new version. Installer UI, OS trust, upgrade and uninstall acceptance must be recorded before stable promotion.\n`)
    const releases = listReleases(endpoint)
    const existing = releases.find(release => release.tag_name === tag)
    if (existing && (!existing.draft || existing.target_commitish !== expected.sha)) throw new Error('Refusing to overwrite an existing public or different-source release')
    if (!existing) gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--target', expected.sha, '--draft', '--prerelease', '--title', tag, '--notes-file', notes])
    gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...files.map(file => path.join(directory, file.name)), path.join(directory, 'SHA256SUMS.txt'), path.join(directory, 'release.json')])
    const uploaded = api(`${endpoint}/releases/tags/${tag}`)
    const assetNames = [...files.map(file => file.name), 'SHA256SUMS.txt', 'release.json'].sort()
    if (JSON.stringify(uploaded.assets.map(asset => asset.name).sort()) !== JSON.stringify(assetNames)) {
      throw new Error('Release upload is incomplete or contains unexpected assets')
    }
    // Publish only after every asset upload succeeds. Retry is safe while the release is a draft.
    gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease', '--latest=false'])
    return
  }
  if (mode === 'approval') {
    const environment = api(`${endpoint}/environments/desktop-production`)
    if (!environment.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length)) {
      throw new Error('Configure required reviewers on the desktop-production environment before stable promotion')
    }
    return
  }
  if (mode !== 'promote') throw new Error('Unknown release operation')
  const evidence = new URL(process.env.ACCEPTANCE_URL)
  if (evidence.protocol !== 'https:') throw new Error('Provide an HTTPS installer acceptance record')
  const release = api(`${endpoint}/releases/tags/${tag}`)
  const directory = path.resolve('.test-temp/promotion')
  fs.mkdirSync(directory, { recursive: true })
  gh(['release', 'download', tag, '--repo', repo, '--dir', directory])
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'))
  const run = api(`${endpoint}/actions/runs/${record.runId}`)
  // A latest release may not exist yet. Listing keeps authorization/network errors fatal.
  const stableReleases = listReleases(endpoint).filter(item => !item.draft && !item.prerelease && item.tag_name.startsWith('desktop-v'))
  assertPromotion({ release, record, run, tag })
  for (const latest of stableReleases) assertPromotion({ release, record, run, latest, tag })
  const resolved = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
  if (resolved !== record.sha) throw new Error('Release tag moved after the candidate was built')
  const seen = new Set()
  for (const file of record.files) {
    if (!/^[-a-zA-Z0-9.]+$/u.test(file.name) || seen.has(file.name)) throw new Error('Invalid or duplicate release asset')
    seen.add(file.name)
    if (await checksum(path.join(directory, file.name)) !== file.sha256) throw new Error(`Changed release asset: ${file.name}`)
  }
  const expectedChecksums = record.files.map(file => `${file.sha256}  ${file.name}`).sort().join('\n') + '\n'
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8') !== expectedChecksums) {
    throw new Error('Release checksum index changed')
  }
  // Re-validate all four manifests and their files without rebuilding any package.
  const staging = path.join(directory, 'verified')
  fs.mkdirSync(staging)
  for (const file of record.files.filter(file => file.name.startsWith('manifest-'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, file.name), 'utf8'))
    const folder = path.join(staging, file.name)
    fs.mkdirSync(folder)
    fs.copyFileSync(path.join(directory, file.name), path.join(folder, file.name))
    for (const asset of manifest.files) {
      if (!seen.has(asset.name)) throw new Error('Manifest asset is absent from release record')
      fs.linkSync(path.join(directory, asset.name), path.join(folder, asset.name))
    }
  }
  await collect(staging, { sha: record.sha, version, runId: record.runId })
  const notes = path.join(directory, 'promotion.md')
  fs.writeFileSync(notes, `${release.body || ''}\n\n## Stable promotion\n\n[Installer acceptance](${evidence.href}). Promoted by ${process.env.GITHUB_ACTOR} using workflow run ${process.env.GITHUB_RUN_ID}.\n`)
  gh(['release', 'edit', tag, '--repo', repo, '--prerelease=false', '--latest', '--notes-file', notes])
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { versionFromTag, assertPromotion }
