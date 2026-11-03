// Internal CI payloads only. Public releases use electron-builder.cjs unchanged.
const config = require('./electron-builder.cjs')

module.exports = {
  ...config,
  mac: { ...config.mac, identity: '-', forceCodeSigning: false, notarize: false },
  dmg: { ...config.dmg, sign: false },
  afterSign: undefined,
}
