import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __setDocumentForTest,
  ensureFontLoaded,
  extractPrimaryFamily,
  resetFontLoaderCache,
} from './FontLoader'

describe('extractPrimaryFamily', () => {
  it('カンマ区切りの先頭フェイス名を返す', () => {
    expect(extractPrimaryFamily('Klee One, cursive')).toBe('Klee One')
    expect(extractPrimaryFamily('Hina Mincho, serif')).toBe('Hina Mincho')
  })

  it('単一フェイス名はそのまま返す', () => {
    expect(extractPrimaryFamily('Noto Sans JP')).toBe('Noto Sans JP')
  })

  it('引用符を取り除く', () => {
    expect(extractPrimaryFamily(`'Klee One', cursive`)).toBe('Klee One')
    expect(extractPrimaryFamily(`"Klee One"`)).toBe('Klee One')
  })

  it('空文字は null', () => {
    expect(extractPrimaryFamily('')).toBeNull()
    expect(extractPrimaryFamily('   ')).toBeNull()
  })
})

// 軽量な document モック。<link> 要素の作成と head への append のみを記録する。
// onload/onerror は手動で発火する。
function createMockDocument() {
  const links: Array<{
    href: string
    rel: string
    onload: (() => void) | null
    onerror: ((err: unknown) => void) | null
    attributes: Record<string, string>
  }> = []
  const head = {
    appendChild(el: { onload?: (() => void) | null }) {
      // onload を即発火（テスト都合で同期）
      queueMicrotask(() => {
        if (el.onload) el.onload()
      })
      return el
    },
  }
  const doc = {
    createElement(_tag: string) {
      const link = {
        rel: '',
        href: '',
        onload: null as (() => void) | null,
        onerror: null as ((err: unknown) => void) | null,
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          this.attributes[name] = value
        },
      }
      links.push(link)
      return link
    },
    head,
    // document.fonts は省略（FontLoader は無くても resolve するパスを持つ）
  }
  return { doc: doc as unknown as Document, links }
}

describe('ensureFontLoaded', () => {
  beforeEach(() => {
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  it('document が無ければ no-op で resolve する', async () => {
    __setDocumentForTest(null)
    await expect(ensureFontLoaded('Klee One, cursive')).resolves.toBeUndefined()
  })

  it('<link rel="stylesheet"> を head に注入し Google Fonts URL を含む', async () => {
    const { doc, links } = createMockDocument()
    __setDocumentForTest(doc)

    await ensureFontLoaded('Klee One, cursive')

    expect(links.length).toBe(1)
    expect(links[0].rel).toBe('stylesheet')
    expect(links[0].href).toContain('fonts.googleapis.com/css2')
    expect(links[0].href).toContain('Klee+One')
    expect(links[0].attributes['data-name-name-font']).toBe('Klee One')
  })

  it('同じ family を 2 回呼んでも <link> は 1 個だけ', async () => {
    const { doc, links } = createMockDocument()
    __setDocumentForTest(doc)

    await ensureFontLoaded('Klee One, cursive')
    await ensureFontLoaded('Klee One, cursive')
    await ensureFontLoaded(`'Klee One', cursive`)

    expect(links.length).toBe(1)
  })

  it('異なる family は別の <link> として注入される', async () => {
    const { doc, links } = createMockDocument()
    __setDocumentForTest(doc)

    await ensureFontLoaded('Klee One, cursive')
    await ensureFontLoaded('Hina Mincho, serif')

    expect(links.length).toBe(2)
    expect(links[0].attributes['data-name-name-font']).toBe('Klee One')
    expect(links[1].attributes['data-name-name-font']).toBe('Hina Mincho')
  })

  it('空 family は何もしない', async () => {
    const { doc, links } = createMockDocument()
    __setDocumentForTest(doc)

    await ensureFontLoaded('')
    await ensureFontLoaded('   ')

    expect(links.length).toBe(0)
  })
})
