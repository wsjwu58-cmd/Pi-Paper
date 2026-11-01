'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  CODEX_QA_MODEL,
  CODEX_QA_REASONING_EFFORT,
  codexAppServerModelOverrides,
  codexExecBaseArguments,
  codexExecModelArguments,
} = require('../scripts/codex-qa-model.cjs')

test('Codex QA model and reasoning effort are pinned with no default-model fallback', () => {
  assert.equal(CODEX_QA_MODEL, 'gpt-6.1-terra')
  assert.equal(CODEX_QA_REASONING_EFFORT, 'max')
  assert.deepEqual(codexExecModelArguments(), [
    '--model', 'gpt-6.1-terra',
    '--config', 'model_reasoning_effort="max"',
  ])
  assert.deepEqual(codexAppServerModelOverrides(), [
    'model="gpt-6.1-terra"',
    'model_reasoning_effort="max"',
  ])
})

test('Codex exec QA base retains the isolated read-only policy and fixes Terra/max', () => {
  assert.deepEqual(codexExecBaseArguments(['mcp_servers.vibepaper={command="node"}']), [
    '--ask-for-approval', 'on-request',
    '--model', 'gpt-6.1-terra',
    '--config', 'model_reasoning_effort="max"',
    '-c', 'mcp_servers.vibepaper={command="node"}',
    'exec', '--ignore-user-config', '--ephemeral', '--disable', 'shell_tool',
    '--sandbox', 'read-only', '--json', '--skip-git-repo-check',
  ])
  assert.throws(() => codexExecBaseArguments(['']), { name: 'TypeError' })
})

test('each Codex exec/diagnostic runner uses the shared fixed-model arguments', () => {
  const scriptDirectory = path.join(__dirname, '..', 'scripts')
  for (const filename of ['smoke-mcp-clients.cjs', 'smoke-mcp-codex-agnes.cjs']) {
    const source = fs.readFileSync(path.join(scriptDirectory, filename), 'utf8')
    assert.match(source, /\.\.\.codexExecBaseArguments\(/u, `${filename} must use the fixed Codex QA model helper`)
  }
  const agnesSource = fs.readFileSync(path.join(scriptDirectory, 'smoke-mcp-codex-agnes.cjs'), 'utf8')
  assert.doesNotMatch(agnesSource, /useClientDefaultModel/u)
})
