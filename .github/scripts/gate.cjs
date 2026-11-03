const fs = require('node:fs')

function validateGate(phase, jobs, installersExpected = false) {
  const expected = { changes: 'success' }
  if (phase === 'quality') {
    expected.workflow = 'success'
    for (const name of ['pi-agent-service', 'web', 'desktop']) {
      expected[name] = jobs.changes?.outputs.runtime === 'true' ? 'success' : 'skipped'
    }
  } else if (phase === 'final') {
    expected.quality = 'success'
    expected.docker = jobs.changes?.outputs.docker === 'true' ? 'success' : 'skipped'
    expected.installers = installersExpected ? 'success' : 'skipped'
  } else {
    throw new Error('Unknown gate phase')
  }
  for (const [name, result] of Object.entries(expected)) {
    if (jobs[name]?.result !== result) throw new Error(`${name}: ${jobs[name]?.result}, expected ${result}`)
  }
}

if (require.main === module) {
  const jobs = JSON.parse(process.env.RESULTS)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## ${process.env.PHASE} gate\n\nCommit \`${process.env.GITHUB_SHA}\`\n\n`
    + Object.entries(jobs).map(([name, job]) => `- ${name} — ${job.result}\n`).join(''))
  validateGate(process.env.PHASE, jobs, process.env.INSTALLERS_EXPECTED === 'true')
}
module.exports = { validateGate }
