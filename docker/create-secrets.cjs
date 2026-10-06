const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const directory = path.join(__dirname, 'secrets')
fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
function create(name, value) {
  const file = path.join(directory, name)
  try { fs.writeFileSync(file, value + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return fs.readFileSync(file, 'utf8').trim()
}
const password = create('vnc-password.txt', randomBytes(6).toString('base64url'))
create('keyring-password.txt', randomBytes(32).toString('base64url'))
if (!process.argv.includes('--quiet')) {
  console.log('noVNC password: ' + password)
  console.log('Existing secrets were preserved. Keep docker/secrets/ with your backups.')
}
