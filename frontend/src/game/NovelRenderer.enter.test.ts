/**
 * `[登場:]` 無言立ち絵ディレクティブ (#401) のエンジンテスト。
 *
 * **実パーサ（wasm）経由**でスクリプトを parse → NovelRenderer に流し → startFrom で再生し、
 * getSnapshot().characters に立ち絵が載ることを検証する。CharacterLayer.show を setter 直呼び
 * するハーネスは wasm を迂回して偽陽性になる（CLAUDE.md / session752 の character_scale 事故の教訓）
 * ため、必ず parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通す。
 *
 * PixiJS 実描画は対象外。CharacterLayer.show は sprite を同期生成して Map に登録するため
 * （テクスチャ実ロードは待たない）、getSnapshot().characters は init/WebGL なしで確定する
 * （startFrom.test.ts #399 と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { parseMarkdown } from '../wasm/parser'
import type { EventScene } from '../types'

/** 実 wasm parse → NovelRenderer に流せる EventScene[] を作る。 */
async function scenesFromMarkdown(md: string): Promise<EventScene[]> {
  const doc = await parseMarkdown(md)
  return doc.chapters.flatMap((c) => c.scenes)
}

function novelScript(body: string): string {
  return [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## stage: 登場テスト',
    '',
    body,
    '',
  ].join('\n')
}

describe('[登場:] 無言立ち絵ディレクティブ (#401)', () => {
  it('T1: 冒頭の複数 [登場:] が startFrom 直後（最初のテキスト前）に characters へ載る', async () => {
    // せお（左）＋ スピノ（右）を無言で立て、その後に立ち絵なしのナレーションが来る。
    // processUntilNextTextEvent が 2 つの Enter を実行してから Narration（テキスト）で止まる。
    const scenes = await scenesFromMarkdown(
      novelScript(
        [
          '[登場: せお (theo/normal, 左)]',
          '[登場: スピノ (spino/normal, 右)]',
          '',
          '> 幕が上がる。',
        ].join('\n')
      )
    )
    const r = new NovelRenderer()
    r.setScenes(scenes)
    r.startFrom({ sceneId: 'stage' })

    const s = r.getSnapshot()
    // 最初のテキスト（Narration）はまだ advance していない。Enter だけが冒頭実行され立ち絵が立つ。
    expect(s.eventIndex).toBe(2) // Enter, Enter を越えて Narration(index 2) で停止
    const chars = s.characters
    expect(chars).toHaveLength(2)
    expect(chars).toContainEqual({ name: 'せお', expression: 'theo/normal', position: 'left' })
    expect(chars).toContainEqual({ name: 'スピノ', expression: 'spino/normal', position: 'right' })
  })

  it('T2: 同一状態の [登場:] を二連で書いても 1 体のまま（冪等）', async () => {
    const scenes = await scenesFromMarkdown(
      novelScript(
        [
          '[登場: せお (theo/normal, 左)]',
          '[登場: せお (theo/normal, 左)]',
          '',
          '> 幕が上がる。',
        ].join('\n')
      )
    )
    const r = new NovelRenderer()
    r.setScenes(scenes)
    r.startFrom({ sceneId: 'stage' })

    const chars = r.getSnapshot().characters
    // 2 度目の show は CharacterLayer.show の no-op ガードで無効。せお 1 体のまま。
    expect(chars).toHaveLength(1)
    expect(chars[0]).toMatchObject({ name: 'せお', expression: 'theo/normal', position: 'left' })
  })

  it('T3: 実 wasm parse が [登場:] を Enter イベントとして出す（setter 迂回でない根拠）', async () => {
    // wasm を経由して Enter variant が生成されることを直接確認する（偽陽性防止の要）。
    const scenes = await scenesFromMarkdown(novelScript('[登場: せお (theo/normal, 左)]'))
    const events = scenes.flatMap((s) => s.events)
    const enter = events.find((e) => typeof e === 'object' && e !== null && 'Enter' in e)
    expect(enter).toBeDefined()
    expect(enter && 'Enter' in enter && enter.Enter).toMatchObject({
      character: 'せお',
      expression: 'theo/normal',
      position: '左',
    })
  })

  it('T4: [登場:] の立ち絵は後続の話者付き Dialog（別キャラ）と共存する', async () => {
    // 無言登場（せお・左）の後に、別位置（右）の話者付き Dialog が来ると 2 体になる。
    // startFrom の fresh-start は最初のテキスト（Dialog）の立ち絵も showCharacterThenRender で載せる。
    const scenes = await scenesFromMarkdown(
      novelScript(
        ['[登場: せお (theo/normal, 左)]', '', '**スピノ** (spino/warai, 右):', 'やあ。'].join('\n')
      )
    )
    const r = new NovelRenderer()
    r.setScenes(scenes)
    r.startFrom({ sceneId: 'stage' })

    const chars = r.getSnapshot().characters
    expect(chars).toHaveLength(2)
    expect(chars).toContainEqual({ name: 'せお', expression: 'theo/normal', position: 'left' })
    expect(chars).toContainEqual({ name: 'スピノ', expression: 'spino/warai', position: 'right' })
  })
})
