/**
 * NovelRenderer の confinement（在圏）判定 + 終劇（endStory）のテスト (#386)。
 *
 * `?scene=` ディープリンク単独埋め込みで `setConfinedSceneIds` が設定されているとき、
 * `jumpToScene` がその集合の外への遷移を通常のシーン遷移ではなく終劇として扱う挙動を検証する。
 * `startFrom.test.ts` / `backgroundCrossfade.test.ts` と同じく
 * `new NovelRenderer()` → `setScenes(...)` の最小構成で行い、PixiJS 実描画は対象外
 * （CLAUDE.md ルール7 の実機 golden path に委ねる）。
 *
 * 背景/立ち絵の非同期アセット読込を伴う状態は `loadFromSaveData.test.ts` と同じ理由で
 * jsdom 検証の対象外とする（実機 golden path に委ねる）。backgroundPath/backgroundColor は
 * アセット読込を経由せず同期的に確定するフィールドなので、これらだけを対象に
 * 「endStory 後は全部クリアされる」ことを検証する（video/characters は既定値のまま据え置き、
 * 純粋な状態遷移の検証として弱いが doctrine 通りの割り切り）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene } from '../types'

// --- fixture helpers（startFrom.test.ts と同じスタイル） ---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** confinement 検証用の内部アクセサ */
interface RendererInternals {
  setBackground(
    path: string,
    fade?: unknown,
    brightness?: number | null,
    opts?: { instant?: boolean }
  ): void
  setBackgroundColor(color: string): void
  initialized: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

// entry: 在圏に含める / in-scene: 在圏に含める / out-scene: allScenes には実在するが圏外
const SCENES: EventScene[] = [
  scene('entry', [narration('start')]),
  scene('in-scene', [narration('inside')]),
  scene('out-scene', [narration('outside but exists in allScenes')]),
]

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

describe('NovelRenderer confinement / endStory (#386)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
  })

  // ===== A. 後方互換: confinement 未設定 =====

  it('17: confinement 未設定（既定 null）時、圏外相当の sceneId でも jumpToScene は通常遷移する（後方互換の核）', () => {
    const r = makeRenderer(SCENES)
    r.jumpToScene('out-scene')
    expect(r.getCurrentSceneId()).toBe('out-scene')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== B. 在圏ジャンプは通常遷移 =====

  it('18: confinement 設定後、在圏 scene への jumpToScene は通常遷移する', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('in-scene')
    expect(r.getCurrentSceneId()).toBe('in-scene')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== C. 圏外ジャンプ（allScenes に実在）は終劇 =====

  it('19: confinement 設定後、圏外（allScenes に実在）sceneId への jumpToScene は storyEnded=true にする', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene')
    expect(r.getSnapshot().storyEnded).toBe(true)
  })

  it('20: 圏外ジャンプで console.warn は呼ばれない（シーン未発見扱いにしない）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('21: 圏外かつ allScenes に存在しない sceneId への jumpToScene も終劇になり、missingSceneResolver は呼ばれない', () => {
    const resolver = vi.fn().mockResolvedValue(null)
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.setMissingSceneResolver(resolver)
    r.jumpToScene('totally-unknown-scene')
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('24: 終劇後も currentSceneId は変化しない（endStory は startScene を経由しない）', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene')
    expect(r.getCurrentSceneId()).toBe('entry')
  })

  // ===== D. 終劇後の入力無効化 =====

  it('22: 終劇後、advance() を呼んでも eventIndex/textIndex 等のスナップショットは変化しない', () => {
    const r = makeRenderer(SCENES)
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    const before = r.getSnapshot()
    r.advance()
    r.advance()
    expect(r.getSnapshot()).toEqual(before)
  })

  // ===== E. 終劇後の宣言的終端状態 =====

  it('23: 終劇後、getSnapshot() の backgroundPath/backgroundColor が null にクリアされる', () => {
    const r = makeRenderer(SCENES)
    // アセット読込を経由しない同期フィールドだけを事前に非 null にしておく
    // （実際のテクスチャロードは jsdom 検証対象外・loadFromSaveData.test.ts と同じ割り切り）。
    internals(r).setBackground('bg.png')
    internals(r).setBackgroundColor('#112233')
    expect(r.getSnapshot().backgroundPath).toBe('bg.png')
    expect(r.getSnapshot().backgroundColor).toBe('#112233')

    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')

    const s = r.getSnapshot()
    expect(s.backgroundPath).toBeNull()
    expect(s.backgroundColor).toBeNull()
    // video/characters はアセット読込を経由するため事前に非 null 化していないが、
    // 終劇後に「なし」であることは変わらず確認できる。
    expect(s.video).toBeNull()
    expect(s.characters).toEqual([])
  })

  // ===== F. 二重発火防止 =====

  it('25: 終劇トリガーを2回連続しても、onStoryEndedChange コールバックは1回しか発火しない', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out-scene')
    r.jumpToScene('out-scene') // 2回目（二重発火防止で早期 return するはず）
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(true)
  })

  // ===== G. 終劇からの復帰（startScene の安全弁） =====

  it('26: 終劇後に在圏 scene へ jumpToScene すると storyEnded=false に戻り、callback が false で発火する', () => {
    const cb = vi.fn()
    const r = makeRenderer(SCENES)
    r.setOnStoryEndedChange(cb)
    r.setConfinedSceneIds(['entry', 'in-scene'])
    r.jumpToScene('out-scene') // 圏外 → 終劇（storyEnded=true, cb(true)）
    expect(r.getSnapshot().storyEnded).toBe(true)
    cb.mockClear()

    r.jumpToScene('in-scene') // 在圏 → 通常遷移。startScene の安全弁で false に戻る
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(r.getCurrentSceneId()).toBe('in-scene')
    expect(cb).toHaveBeenCalledWith(false)
  })

  // ===== H. race: 背景ロード中の endStory =====

  it('27: setBackground の非同期ロード中に endStory() が発火しても、後で元 promise が resolve しても backgroundPath は null のまま', async () => {
    const r = makeRenderer(SCENES)
    r.setAssetBaseUrl('/assets')
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    r.setConfinedSceneIds(['entry'])

    let resolveLoad!: (texture: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((resolve) => {
        resolveLoad = resolve
      }) as never
    )

    // アセットキャッシュに無い背景 → Assets.load が pending のまま bgLoadToken を確保する。
    internals(r).setBackground('pending.png')
    expect(r.getSnapshot().backgroundPath).toBe('pending.png')

    // 圏外ジャンプで endStory() が発火。bgLoadToken を進めて古いロードを無効化し、
    // backgroundPath を即座に null に確定する。
    r.jumpToScene('out-scene')
    expect(r.getSnapshot().backgroundPath).toBeNull()

    // 古い pending.png の読み込みが後から解決しても、endStory 後の状態を上書きしない。
    resolveLoad(Texture.WHITE)
    await Promise.resolve()
    expect(r.getSnapshot().backgroundPath).toBeNull()
  })
})
