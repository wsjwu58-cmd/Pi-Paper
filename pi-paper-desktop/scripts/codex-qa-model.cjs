'use strict'

const CODEX_QA_MODEL = 'gpt-6.1-terra'
const CODEX_QA_REASONING_EFFORT = 'max'

function codexExecModelArguments() {
  return [
    '--model', CODEX_QA_MODEL,
    '--config', `model_reasoning_effort=${JSON.stringify(CODEX_QA_REASONING_EFFORT)}`,
  ]
}

function codexExecBaseArguments(configOverrides = []) {
  if (!Array.isArray(configOverrides) || configOverrides.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError('Codex QA config overrides must be non-empty strings')
  }
  return [
    '--ask-for-approval', 'on-request',
    ...codexExecModelArguments(),
    ...configOverrides.flatMap((entry) => ['-c', entry]),
    'exec', '--ignore-user-config', '--ephemeral', '--disable', 'shell_tool',
    '--sandbox', 'read-only', '--json', '--skip-git-repo-check',
  ]
}

function codexAppServerModelOverrides() {
  return [
    `model=${JSON.stringify(CODEX_QA_MODEL)}`,
    `model_reasoning_effort=${JSON.stringify(CODEX_QA_REASONING_EFFORT)}`,
  ]
}

module.exports = {
  CODEX_QA_MODEL,
  CODEX_QA_REASONING_EFFORT,
  codexAppServerModelOverrides,
  codexExecBaseArguments,
  codexExecModelArguments,
}
