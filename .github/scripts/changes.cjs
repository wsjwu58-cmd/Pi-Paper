const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

function classify(paths, full = false) {
  const automation = paths.some(file => file.startsWith('.github/') || file === 'AGENTS.md')
  const runtime = full || automation || paths.some(file => /^(pi-main|pi-paper-web|pi-paper-desktop|marketplace|skills)\//u.test(file))
  const docker = full || automation || paths.some(file => /^(docker\/|Dockerfile$|docker-compose\.yml$|\.dockerignore$)/u.test(file))
  return { runtime, docker }
}

if (require.main === module) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const full = process.env.FULL === 'true' || ['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)
    || process.env.GITHUB_REF.startsWith('refs/tags/')
  let paths = []
  const base = event.pull_request?.base.sha || event.before
  if (!full && base && !/^0+$/u.test(base)) {
    // A missing force-push base falls back to full validation.
    try {
      const range = event.pull_request ? `${base}...HEAD` : base
      paths = execFileSync('git', ['diff', '--name-only', '-z', range, ...(event.pull_request ? [] : ['HEAD'])], { encoding: 'utf8' }).split('\0').filter(Boolean)
    } catch {
      paths = ['.github/unknown-base']
    }
  }
  const result = classify(paths, full || !base || /^0+$/u.test(base))
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''))
  console.log(JSON.stringify(result))
}

module.exports = { classify }
