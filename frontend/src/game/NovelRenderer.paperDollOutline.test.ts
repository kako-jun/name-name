/**
 * NovelRenderer 紙人形風輪郭 (#699) の配線統合テスト。
 *
 * `CharacterLayer`/`PropLayer` 側の実フィルタ適用（`applySpriteFilters` デシジョンテーブル）は
 * CharacterLayer.paperDollOutline.test.ts でカバー済み。ここでは
 * `NovelRenderer.cameraMode.test.ts`/`NovelRenderer.spotlight.test.ts` と同じ
 * 「isBlackout と同種の宣言的 settled state」としての配線を検証するが、cameraMode/spotlight とは
 * 対照的に **場面転換（同一エントリ文書内のシーン間ジャンプ）では持続し、新しいエントリ文書の
 * 開始（setEvents() の再呼び出し）・restart() でだけ解除される**、という #699 固有のスコープを
 * 縛るのが最重要（GameState.paperDollOutline / NovelRenderer.paperDollOutline の JSDoc 参照）。
 */
import { describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import {
  DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
  DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS,
} from './outlineFilter'
import type { Event, EventScene } from '../types'

// --- fixture helpers（NovelRenderer.cameraMode.test.ts / spotlight.test.ts と同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function paperDollOutline(enabled: boolean, color?: string, thickness?: number): Event {
  return { PaperDollOutline: { enabled, color, thickness } } as Event
}

function spotlight(target: string | undefined, color: string, radius: number): Event {
  return { Spotlight: { target, color, radius } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

interface RendererInternals {
  characterLayer: { setPaperDollOutline: (...args: unknown[]) => void }
  propLayer: { setPaperDollOutline: (...args: unknown[]) => void }
  processDirective(event: Event): void
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

describe('NovelRenderer 紙人形風輪郭配線 (#699)', () => {
  it('1: [紙人形輪郭: オン] 実行で getSnapshot().paperDollOutline に color/thickness が反映される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true, '#123456', 4), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().paperDollOutline).toBeNull()

    await r.playScript([{ type: 'advance' }]) // one -> paperDollOutline(directive処理) -> two

    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#123456', thickness: 4 })
  })

  // 最重要ペア: 同一エントリ文書内のシーン間ジャンプでは持続し、別文書を setEvents() で
  // 読み込み直すと解除される。片方だけだと壊れても気付けないため必ずペアで確認する。
  it('2（持続/解除ペア）: 同一文書内の jumpToScene では持続し、setEvents() での別文書読み込みで解除される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true, '#000000', 3), narration('two')]),
      scene('b', [narration('three')]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }]) // one -> paperDollOutline(on) -> two
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#000000', thickness: 3 })

    // 同文書内シーン間ジャンプ（resetAndStartEvents の preserveBackgroundForTransition=true 経路）
    // では cameraMode/spotlight と異なり自動クリアしない。
    r.jumpToScene('b')
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#000000', thickness: 3 })

    // 別文書 B の読み込み（setEvents() の再呼び出し、preserve なし）では解除される。
    r.setEvents([narration('doc B start')])
    expect(r.getSnapshot().paperDollOutline).toBeNull()
  })

  it('3: restart() 実行時も紙人形輪郭が解除される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true, '#ffffff', 2), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().paperDollOutline).not.toBeNull()

    r.restart()

    expect(r.getSnapshot().paperDollOutline).toBeNull()
  })

  // endStory() は spotlight を消灯させる（既存 #693 仕様）が、紙人形輪郭は持続する——対比を
  // 1テストの中に両方書くことで差分を明確にする。
  it('4（対比）: endStory()（confinement圏外遷移経由）でスポットライトは消灯するが紙人形輪郭は持続する', async () => {
    const r = makeRenderer([
      scene('entry', [
        narration('one'),
        spotlight('alice', '#ffffff', 0.2),
        paperDollOutline(true, '#ff00ff', 5),
        narration('two'),
      ]),
      scene('out-scene', [narration('outside')]),
    ])
    r.setConfinedSceneIds(['entry'])
    r.startFrom({ sceneId: 'entry' })

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().spotlight).not.toBeNull()
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#ff00ff', thickness: 5 })

    r.jumpToScene('out-scene') // 圏外 → endStory() 経由

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(r.getSnapshot().spotlight).toBeNull() // 消灯（対比）
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#ff00ff', thickness: 5 }) // 持続（対比）
  })

  it('5: processDirective で enabled:true かつ color/thickness が undefined のとき既定値にフォールバックする', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }])

    expect(r.getSnapshot().paperDollOutline).toEqual({
      color: DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
      thickness: DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS,
    })
  })

  it('6: processDirective で enabled:false 受信時、characterLayer/propLayer 両方に null が伝播する', () => {
    const r = new NovelRenderer()
    const clSpy = vi.spyOn(internals(r).characterLayer, 'setPaperDollOutline')
    const plSpy = vi.spyOn(internals(r).propLayer, 'setPaperDollOutline')

    internals(r).processDirective(paperDollOutline(false))

    expect(clSpy).toHaveBeenCalledWith(null)
    expect(plSpy).toHaveBeenCalledWith(null)
    expect(r.getSnapshot().paperDollOutline).toBeNull()
  })

  it('7: quickSave → quickLoad で紙人形輪郭が復元される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true, '#123456', 3), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#123456', thickness: 3 })

    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    expect(r.quickSave()).toBe(true)

    const r2 = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true, '#123456', 3), narration('two')]),
    ])
    vi.spyOn(r2.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    expect(r2.quickLoad()).toBe(true)
    expect(r2.getSnapshot().paperDollOutline).toEqual({ color: '#123456', thickness: 3 })
  })

  it('8: カメラモード（Novel/Theater）非依存で紙人形輪郭が機能する（Novelモードのままでも settled state に反映される）', async () => {
    // #699 の輪郭はシアターモードの演出として導入されたが、GameState.paperDollOutline 自体は
    // cameraMode を条件にしない宣言的 settled state（parser/emitter/NovelRenderer のいずれも
    // cameraMode 分岐を持たない）。Novel モードのまま（カメラ切り替え無し）でも設定できることを
    // 確認する。
    const r = makeRenderer([
      scene('a', [narration('one'), paperDollOutline(true, '#00ff00', 6), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().cameraMode).toBe('Novel')

    await r.playScript([{ type: 'advance' }])

    expect(r.getSnapshot().cameraMode).toBe('Novel') // カメラモードは変化していない
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#00ff00', thickness: 6 })
  })
})
