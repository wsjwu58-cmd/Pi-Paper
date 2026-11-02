const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } = require('@modelcontextprotocol/sdk/client/stdio.js')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const MAX_MESSAGE = 512 * 1024
const MAX_TEXT = 20_000
const MAX_RESULT = 40_000
const TIMEOUT = 12_000
const permittedName = /^[A-Za-z0-9_.-]{1,128}$/u

// Only a text argument is exposed to the user. A server may of course perform
// side effects despite its schema: executable trust is the user's decision.
function supportsTextTool(tool) {
  const schema = tool?.inputSchema
  const properties = schema?.properties
  const text = properties?.text
  return typeof tool?.name === 'string' && permittedName.test(tool.name)
    && schema?.type === 'object' && properties && typeof properties === 'object' && !Array.isArray(properties)
    && Object.keys(properties).length === 1 && text && text.type === 'string'
    && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'text'
    && Object.keys(schema).every((key) => ['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'].includes(key))
    && (schema.additionalProperties === undefined || schema.additionalProperties === false)
    && Object.keys(text).every((key) => ['type', 'title', 'description'].includes(key))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

async function withClient(executable, operation) {
  // The SDK otherwise inherits HOME, USER, SHELL and other environment fields.
  // Keep only the program lookup and platform loader essentials; never forward
  // application credentials, arbitrary environment variables or package values.
  const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, undefined]))
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name]
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-local-mcp-'))
  const transport = new StdioClientTransport({ command: executable, args: [], env, cwd, stderr: 'ignore', maxBufferSize: MAX_MESSAGE })
  const client = new Client({ name: 'vibepaper-local-tool', version: '1.0.0' }, { capabilities: {} })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT)
  // SDK initialization starts a close without awaiting it after failure. Share
  // that promise so the request does not finish while its child is still alive.
  const start = transport.start.bind(transport)
  const close = transport.close.bind(transport)
  let pid = null
  let closing
  transport.start = async () => { await start(); pid = transport.pid }
  transport.close = () => { closing ??= close(); return closing }
  try {
    await client.connect(transport, { timeout: TIMEOUT, signal: abort.signal })
    return await operation(client, abort.signal)
  } catch (error) {
    if (typeof error?.message === 'string' && (/^LOCAL_MCP_[A-Z_]+$/u.test(error.message)
      || ['MARKETPLACE_COMPONENT_NOT_AVAILABLE', 'MARKETPLACE_PACKAGE_INVALID', 'AGENT_PROJECT_CHANGED'].includes(error.message))) throw error
    // Remote errors and child stderr are untrusted and may contain secrets.
    throw new Error('LOCAL_MCP_CONNECTION_FAILED')
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    // close() sends SIGKILL as a last resort but does not wait for the process
    // exit notification after that signal.
    let stopped = !pid
    if (pid) {
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline) {
        try { process.kill(pid, 0) } catch (error) { stopped = error?.code === 'ESRCH'; break }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
    if (!stopped) throw new Error('LOCAL_MCP_PROCESS_TERMINATION_FAILED')
  }
}

async function list(client, signal) {
  const tools = []
  let cursor
  for (let page = 0; page < 4; page++) {
    const response = await client.listTools(cursor ? { cursor } : {}, { timeout: TIMEOUT, signal })
    if (!Array.isArray(response.tools) || response.tools.length > 100) throw new Error('LOCAL_MCP_TOOLS_INVALID')
    for (const tool of response.tools) {
      if (!supportsTextTool(tool)) continue
      if (tools.some((item) => item.name === tool.name)) throw new Error('LOCAL_MCP_TOOLS_INVALID')
      tools.push({ name: tool.name, description: String(tool.description ?? '').slice(0, 500),
        schema: JSON.stringify(canonical(tool.inputSchema)) })
      if (tools.length > 100) throw new Error('LOCAL_MCP_TOOLS_INVALID')
    }
    if (!response.nextCursor) return tools
    if (response.nextCursor === cursor || typeof response.nextCursor !== 'string' || response.nextCursor.length > 1024) throw new Error('LOCAL_MCP_TOOLS_INVALID')
    cursor = response.nextCursor
  }
  throw new Error('LOCAL_MCP_TOOLS_INVALID')
}

async function discoverLocalTools(executable) {
  return withClient(executable, list)
}

async function callLocalTool(executable, selection, input, beforeCall) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_TEXT) throw new Error('LOCAL_MCP_TEXT_INVALID')
  return withClient(executable, async (client, signal) => {
    const tools = await list(client, signal)
    const selected = tools.find((tool) => tool.name === selection.name && tool.schema === selection.schema)
    if (!selected) throw new Error('LOCAL_MCP_TOOL_CHANGED')
    await beforeCall()
    if (signal.aborted) throw new Error('LOCAL_MCP_CONNECTION_FAILED')
    const result = await client.callTool({ name: selected.name, arguments: { text: input } }, undefined, { timeout: TIMEOUT, signal })
    if (result.isError) throw new Error('LOCAL_MCP_TOOL_FAILED')
    if (!Array.isArray(result.content) || !result.content.length || result.content.some((item) => item.type !== 'text' || typeof item.text !== 'string')) {
      throw new Error('LOCAL_MCP_RESULT_UNSUPPORTED')
    }
    const output = result.content.map((item) => item.text).join('\n')
    if (output.length > MAX_RESULT) throw new Error('LOCAL_MCP_RESULT_TOO_LARGE')
    return output
  })
}
module.exports = { supportsTextTool, discoverLocalTools, callLocalTool }
