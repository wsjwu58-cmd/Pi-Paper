const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8')

for (const provider of ['Agnes', 'Ark']) {
  test(`${provider}: absent legacy key allows catalog reads without a vault; existing keys remain protected`, async () => {
    const name = `get${provider}ApiKey`
    const declaration = mainSource.match(new RegExp(`async function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]
    let vaultChecks = 0
    let exists = false
    let decrypted = false
    const context = vm.createContext({
      agnesCredentialFile: '/isolated/agnes.bin', arkCredentialFile: '/isolated/ark.bin',
      fs: { readFile: async () => { if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return Buffer.from('encrypted fixture') } },
      assertCredentialVaultAvailable: async () => { vaultChecks++; throw new Error('SECURE_STORAGE_UNAVAILABLE') },
      safeStorage: { decryptStringAsync: async () => { decrypted = true; return { result: 'fixture' } } },
    })
    const read = vm.runInContext(`${declaration}\n${name}`, context)
    assert.equal(await read(), null)
    assert.equal(vaultChecks, 0)
    exists = true
    await assert.rejects(read(), /SECURE_STORAGE_UNAVAILABLE/)
    assert.equal(vaultChecks, 1)
    assert.equal(decrypted, false)
  })
}
