const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { normalizeUiLanguage, systemUiLanguage, createUiLanguageSettings } = require('../src/ui-language.cjs')

test('Chinese locales use Chinese; other and unknown locales fall back to English', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-TW', 'zh_Hans_CN.UTF-8', 'ZH_hk', 'zh_CN@pinyin']) assert.equal(normalizeUiLanguage(locale), 'zh')
  for (const locale of ['en-US', 'fr-FR', 'ja-JP', 'C', 'POSIX', '', undefined, 'zhuang']) assert.equal(normalizeUiLanguage(locale), 'en')
})

test('Linux respects LC_ALL, LC_MESSAGES and LANG precedence; other platforms use the host locale', () => {
  const linux = (env, locale = 'zh-CN') => systemUiLanguage({ env, locale, platform: 'linux' })
  assert.equal(linux({ LC_ALL: 'fr_FR.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'zh_CN' }), 'en')
  assert.equal(linux({ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US' }), 'zh')
  assert.equal(linux({ LANG: 'ja_JP.UTF-8' }), 'en')
  assert.equal(linux({ LANG: 'C' }), 'en')
  assert.equal(linux({}, 'zh-CN'), 'zh')
  assert.equal(systemUiLanguage({ platform: 'win32', locale: 'en-US', env: { LANG: 'zh_CN' } }), 'en')
})

test('manual preference survives restart and system mode uses the new system locale', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-paper-ui-language-'))
  const file = path.join(directory, 'ui-settings.json')
  const models = path.join(directory, 'settings.json')
  const modelSettings = '{"schemaVersion":1,"localTextModel":{"modelId":"user-model"}}'
  await fs.writeFile(models, modelSettings)
  const make = (locale) => createUiLanguageSettings({ file, locale, platform: 'win32' })
  const first = make('fr-FR')
  assert.deepEqual(await first.load(), { preference: 'system', language: 'en', systemLanguage: 'en' })
  await Promise.all([first.set('en'), first.set('zh')])
  const restarted = make('de-DE')
  assert.equal((await restarted.load()).language, 'zh')
  await restarted.set('system')
  assert.deepEqual(await make('zh-TW').load(), { preference: 'system', language: 'zh', systemLanguage: 'zh' })
  assert.equal(await fs.readFile(models, 'utf8'), modelSettings)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { schemaVersion: 1, language: 'system' })
  for (const value of ['fr', '', null, { language: 'zh' }]) await assert.rejects(first.set(value), /Unsupported/)
})

test('invalid or corrupt UI preferences use the system default', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-paper-ui-language-'))
  const file = path.join(directory, 'ui-settings.json')
  for (const content of ['not json', '{"schemaVersion":1,"language":"fr"}', '{"schemaVersion":2,"language":"zh"}']) {
    await fs.writeFile(file, content)
    const settings = createUiLanguageSettings({ file, locale: 'en-US', platform: 'win32' })
    assert.equal((await settings.load()).language, 'en')
  }
})
