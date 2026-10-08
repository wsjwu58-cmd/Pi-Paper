const fs = require('node:fs/promises')
const path = require('node:path')

function normalizeUiLanguage(locale) {
  return /^zh(?:[-_.@]|$)/i.test(String(locale || '').trim()) ? 'zh' : 'en'
}

function systemUiLanguage({ locale, env = process.env, platform = process.platform } = {}) {
  const systemLocale = platform === 'linux'
    ? env.LC_ALL || env.LC_MESSAGES || env.LANG || locale
    : locale
  return normalizeUiLanguage(systemLocale)
}

function createUiLanguageSettings({ file, locale, env, platform }) {
  const systemLanguage = systemUiLanguage({ locale, env, platform })
  let preference = 'system'
  let pending = Promise.resolve()
  const snapshot = () => ({ preference, language: preference === 'system' ? systemLanguage : preference, systemLanguage })
  return {
    async load() {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'))
        if (saved && saved.schemaVersion === 1 && ['system', 'zh', 'en'].includes(saved.language)) preference = saved.language
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      return snapshot()
    },
    get: snapshot,
    set(language) {
      if (!['system', 'zh', 'en'].includes(language)) return Promise.reject(new Error('Unsupported interface language'))
      const write = pending.then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const temporary = `${file}.tmp`
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, language }) + '\n', 'utf8')
        await fs.rename(temporary, file)
        preference = language
        return snapshot()
      })
      pending = write.catch(() => {})
      return write
    },
  }
}

module.exports = { normalizeUiLanguage, systemUiLanguage, createUiLanguageSettings }
