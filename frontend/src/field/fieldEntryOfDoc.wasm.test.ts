// 実 wasm(parseMarkdown)の実 md で fieldEntryOfDoc を確かめる (#1132)。中立 ID のみ。
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { fieldEntryOfDoc } from './fieldEntryOfDoc'

const head = ['---', 'engine: name-name', 'chapter: 1', 'title: t', '---', ''].join('\n')

describe('fieldEntryOfDoc: 実 parseMarkdown の md', () => {
  it('入口がフィールドの作品(設定・地図が先に並ぶ)', async () => {
    const doc = await parseMarkdown(
      [
        head,
        '## start:',
        '',
        '[フィールド設定 速度=260]',
        '[フィールドマップ 背景=a.webp マスク=a-mask.webp]',
        '[フィールド: a @120,340 向き=左]',
        '',
      ].join('\n')
    )
    expect(fieldEntryOfDoc(doc)).toEqual({ sceneId: 'a', x: 120, y: 340, facing: 'left' })
  })

  it('先頭が台詞のノベルで後ろに Field があっても null', async () => {
    const doc = await parseMarkdown(
      [head, '## start:', '', '**A**:', 'こんにちは', '', '[フィールド: a]', ''].join('\n')
    )
    expect(fieldEntryOfDoc(doc)).toBeNull()
  })

  it('Field の無い作品は null', async () => {
    const doc = await parseMarkdown([head, '## start:', '', '地の文です。', ''].join('\n'))
    expect(fieldEntryOfDoc(doc)).toBeNull()
  })
})
