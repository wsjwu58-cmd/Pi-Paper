/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import english from '@/locales/en.json'
import { getUiLanguage, initializeUiLanguage, normalizeUiLanguage, setUiLanguage, t } from './i18n'
import { LanguagePicker } from '@/components/ui/LanguagePicker'
import { CanvasWelcome } from '@/features/canvas/CanvasWelcome'

describe('desktop interface language', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    vi.stubGlobal('document', { documentElement: { lang: '' }, title: '' })
    vi.stubGlobal('window', { vibepaperDesktop: {
      getUiLanguage: async () => ({ preference: 'system', language: 'en', systemLanguage: 'en' }),
      setUiLanguage: async (preference: 'system' | 'zh' | 'en') => ({ preference, language: preference === 'system' ? 'en' : preference, systemLanguage: 'en' }),
    } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('initializes English before rendering and updates document language and title', async () => {
    await initializeUiLanguage()
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Pi-Paper | A canvas that creates')
    expect(t('新建本地项目')).toBe('New local project')
    expect(renderToStaticMarkup(createElement(LanguagePicker))).toContain('Interface language')
    expect(renderToStaticMarkup(createElement(CanvasWelcome, { onCreate: () => {} }))).toContain('What would you like to create today?')
  })

  it('switches between Chinese, English and system preference without changing interpolated content', async () => {
    await initializeUiLanguage()
    const userContent = '用户的图片 {0} & <world>'
    expect(t('确定删除「{0}」吗？此操作不可恢复。', { 0: userContent })).toContain(userContent)
    expect(t(userContent)).toBe(userContent)
    await setUiLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(t('新建本地项目')).toBe('新建本地项目')
    await setUiLanguage('system')
    expect(getUiLanguage()).toEqual({ preference: 'system', language: 'en', systemLanguage: 'en' })
  })

  it('falls back to the browser locale if an older desktop bridge has no language method', async () => {
    vi.stubGlobal('window', { vibepaperDesktop: {} })
    for (const locale of ['en-US', 'fr-FR', 'ja-JP', 'zh-CN', 'zh-TW']) {
      vi.stubGlobal('navigator', { language: locale })
      await initializeUiLanguage()
      expect(getUiLanguage().language).toBe(normalizeUiLanguage(locale))
    }
  })

  it('keeps the current preference if persistence fails', async () => {
    await initializeUiLanguage()
    window.vibepaperDesktop!.setUiLanguage = async () => { throw new Error('disk unavailable') }
    await expect(setUiLanguage('zh')).rejects.toThrow('disk unavailable')
    expect(getUiLanguage().language).toBe('en')
  })
})

it('all UI translation calls have English entries and preserve interpolation placeholders', () => {
  const catalog: Record<string, string> = english
  const tokens = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort()
  for (const [source, translated] of Object.entries(catalog)) {
    expect(translated, source).toBeTruthy()
    expect(tokens(translated), source).toEqual(tokens(source))
  }
  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  }
  for (const file of walk(join(import.meta.dirname, '..')).filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file))) {
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ['uiText', 't'].includes(node.expression.getText(ast))) {
        const source = node.arguments[0]
        if (source && ts.isStringLiteral(source) && /[\u3400-\u9fff]/.test(source.text)) expect(catalog[source.text.trim()], `${file}: ${source.text}`).toBeTruthy()
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
})
