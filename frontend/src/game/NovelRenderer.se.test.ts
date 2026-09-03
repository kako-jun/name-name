/**
 * NovelRenderer の `[SE: ...]` ディレクティブ処理（#672 SE複数候補プールのランダム抽出+
 * シャッフル+ランダム間隔再生）の統合テスト。
 *
 * `new NovelRenderer()` → `setScenes(...)` の最小構成で行い、PixiJS 実描画は対象外
 * （CLAUDE.md ルール7 の実機 golden path に委ねる、`NovelRenderer.confinement.test.ts` /
 * `NovelRenderer.startFrom.test.ts` と同じ割り切り）。`Se` ディレクティブは冒頭（最初の
 * テキストイベントより前）に置くことで `setScenes()` の `processUntilNextTextEvent()` から
 * 自動的に処理される（`startFrom.test.ts` の `bgm()` fixture と同じパターン）。
 *
 * `AudioManager.playSeSequence` 自体（AudioContext を伴う）は jsdom 検証対象外のため、
 * `NovelRenderer.confinement.test.ts` の `vi.spyOn(r.getAudioManager(), 'stopBgm')` と同じ
 * スタイルで spy に差し替え、NovelRenderer 側が渡す引数（urls/gapMinMs/gapMaxMs）だけを
 * 検証する。spy は `setScenes()`（Se directive を自動処理する）より前に仕込む必要がある
 * ため、共通の `makeRenderer` ヘルパーは使わず個別に構築する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function se(
  paths: string[],
  opts?: {
    fade_ms?: number | null
    count?: number | null
    gap_min_ms?: number | null
    gap_max_ms?: number | null
  }
): Event {
  return {
    Se: {
      paths,
      fade_ms: opts?.fade_ms ?? null,
      count: opts?.count ?? null,
      gap_min_ms: opts?.gap_min_ms ?? null,
      gap_max_ms: opts?.gap_max_ms ?? null,
    },
  } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** setScenes() が自動処理する Se directive を spy で捕まえてから流し込む。 */
function makeRendererWithSeSpy(scenes: EventScene[]): {
  r: NovelRenderer
  playSeSequenceSpy: ReturnType<typeof vi.fn>
} {
  const r = new NovelRenderer()
  const playSeSequenceSpy = vi
    .spyOn(r.getAudioManager(), 'playSeSequence')
    .mockImplementation(() => Promise.resolve())
  r.setScenes(scenes)
  return { r, playSeSequenceSpy: playSeSequenceSpy as unknown as ReturnType<typeof vi.fn> }
}

describe('NovelRenderer [SE: ...] ディレクティブ処理 (#672)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('31: pathsが1件のとき、従来通り単発URL配列でplaySeSequenceが呼ばれる（後方互換の統合確認）', () => {
    const { playSeSequenceSpy } = makeRendererWithSeSpy([
      scene('entry', [se(['click.wav']), narration('本文')]),
    ])

    expect(playSeSequenceSpy).toHaveBeenCalledTimes(1)
    const [urls] = playSeSequenceSpy.mock.calls[0]
    expect(urls).toHaveLength(1)
    expect((urls as string[])[0]).toContain('click.wav')
  })

  it('32: 選択数/間隔省略時はランタイム既定 50-200ms がplaySeSequenceに渡される', () => {
    const { playSeSequenceSpy } = makeRendererWithSeSpy([
      scene('entry', [se(['a.wav', 'b.wav']), narration('本文')]),
    ])

    expect(playSeSequenceSpy).toHaveBeenCalledTimes(1)
    const [, gapMinMs, gapMaxMs] = playSeSequenceSpy.mock.calls[0]
    expect(gapMinMs).toBe(50)
    expect(gapMaxMs).toBe(200)
  })

  it('33: 選択数=0のとき、playSeSequenceは空のURL配列で呼ばれ何も再生されない', () => {
    const { playSeSequenceSpy } = makeRendererWithSeSpy([
      scene('entry', [se(['a.wav', 'b.wav'], { count: 0 }), narration('本文')]),
    ])

    expect(playSeSequenceSpy).toHaveBeenCalledTimes(1)
    const [urls] = playSeSequenceSpy.mock.calls[0]
    expect(urls).toEqual([])
  })
})

/**
 * ===== GUIタイマーキャンセル機構の実装ギャップ是正の回帰テスト (#672 フォローアップ) =====
 *
 * `NovelRenderer` の他の全タイマー（wait/auto/skip/shake/toast/intermission 等）は
 * `this.time.clearTimeout` で一元管理され、シーン遷移（`resetAndStartEvents`）・終劇
 * （`endStory`）・状態復元（`applyState`）・dispose 時にキャンセルされるのに対し、
 * `AudioManager.playSeSequence` 内の gap 待機タイマーだけがこの規律から漏れていた
 * （テスト設計フェーズで発見）。`AudioManager.playSeSequence` を `this.time` 経由に
 * 統合し `cancelSeSequence()` を追加した上で、`resetAndStartEvents`/`endStory`/`applyState`/
 * `AudioManager.destroy()`（NovelRenderer.destroy() 経由）の4箇所に呼び出しを配線した
 * （`AudioManager.cancelSeSequence` のdoc comment参照）。
 *
 * ここでは「他タイマーと同じ規律の呼び出しが実際に配線されているか」を
 * `cancelSeSequence` spy で確認する（実際に後続再生が止まることのメカニズム自体は
 * `AudioManager.test.ts` の34/34bで decisive に検証済み）。
 */
/** destroy() の appInitialized ガード（PixiJS 実 init 未完了時の early-return・React StrictMode
 *  対策）を満たすための最小スタブ（`NovelRenderer.eventImage.test.ts` の
 *  `stubDestroyableApp` と同じ割り切り。jsdom には実 WebGL/canvas init が無いため
 *  ここだけ最小限に差し替える）。 */
interface DestroyableAppInternals {
  appInitialized: boolean
  app: { canvas: unknown; destroy: (...args: unknown[]) => void }
}
function stubDestroyableApp(r: NovelRenderer): void {
  const appInternals = r as unknown as DestroyableAppInternals
  appInternals.appInitialized = true
  Object.defineProperty(appInternals.app, 'canvas', {
    configurable: true,
    value: { removeEventListener: () => {} },
  })
  appInternals.app.destroy = () => {}
}

describe('NovelRenderer: SEシーケンスのキャンセル配線 (#672 フォローアップ)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('34: シーン遷移（jumpToScene→resetAndStartEvents）でSEシーケンスの待機中タイマーがキャンセルされる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('entry', [narration('start')]), scene('next', [narration('next')])])
    const cancelSpy = vi.spyOn(r.getAudioManager(), 'cancelSeSequence')

    r.jumpToScene('next')

    expect(cancelSpy).toHaveBeenCalled()
  })

  it('35: 終劇（endStory、圏外へのjumpToScene）でもSEシーケンスの待機中タイマーがキャンセルされる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('entry', [narration('start')]), scene('out-scene', [narration('outside')])])
    r.setConfinedSceneIds(['entry'])
    const cancelSpy = vi.spyOn(r.getAudioManager(), 'cancelSeSequence')

    r.jumpToScene('out-scene')

    expect(cancelSpy).toHaveBeenCalled()
  })

  it('36: 状態復元（seekTo→applyState）でもSEシーケンスの待機中タイマーがキャンセルされる（セルフレビューS4）', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('entry', [narration('p0'), narration('p1'), narration('p2')])])
    // history[0]=p0, history[1]=p1 まで進める（seekTo(0) で history[0] へ applyState() 経由で戻る）。
    await r.playScript([{ type: 'advance' }])
    await r.playScript([{ type: 'advance' }])
    // history 構築（playScript による通常 advance）は applyState を経由しないため、
    // spy はここで初めて仕込んでも直前の advance を誤って拾わない。
    const cancelSpy = vi.spyOn(r.getAudioManager(), 'cancelSeSequence')

    r.seekTo(0)

    expect(cancelSpy).toHaveBeenCalled()
  })

  it('37: dispose（destroy）でもSEシーケンスの待機中タイマーがキャンセルされる（AudioManager.destroy()経由、セルフレビューS4）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('entry', [narration('start')])])
    stubDestroyableApp(r)
    const cancelSpy = vi.spyOn(r.getAudioManager(), 'cancelSeSequence')

    r.destroy()

    expect(cancelSpy).toHaveBeenCalled()
  })
})
