/**
 * NovelRenderer の無条件ジャンプ `[ジャンプ: シーンID]`（`Event::Jump`）のテスト (#725)。
 *
 * Jump は processDirective で `markCurrentSceneRead` → `jumpState = 'pending'`（armJump）→
 * `setTimeout(0)` 後に `jumpToScene` を呼ぶ。このため同期再入せず、tick(1) で初めて遷移する。
 * confinement（#386）・missingSceneResolver（#460）・intermission（#404）・先読み（#389）は
 * 既存の流儀（confinement/linearAndJumpIndex/intermission/preload の各テスト）に倣い、
 * PixiJS 実描画は対象外にして `render` を no-op 化、TimeController は virtual で駆動する。
 */
import { confineForTest } from '../test/confinement'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import * as bgPreload from './backgroundPreload'
import { defaultTimeController } from './TimeController'
import { SaveManager, SaveSlotData } from './SaveManager'
import type { Event, EventScene } from '../types'
import { internals, type RendererInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function dialog(character: string, expression: string, text: string): Event {
  return {
    Dialog: {
      character,
      expression,
      position: '中央',
      text: [text],
      voice_path: null,
      font_family: null,
    },
  }
}
function jump(target: string): Event {
  return { Jump: { target } }
}
function flag(name: string, value = true): Event {
  return { Flag: { name, value: { Bool: value } } }
}
function condition(f: string, events: Event[]): Event {
  return { Condition: { flag: f, events } }
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals extends RendererInternals {
  saveLoadOverlay: {
    showSave: (...args: unknown[]) => void
    showLoad: (...args: unknown[]) => void
  }
  dialogBox: { dialogText: { text: string } }
}
/** virtual time + render no-op + initialized。setScenes より前に呼ぶ。 */
function makeRenderer(scenes: EventScene[], opts: { docKey?: string } = {}): NovelRenderer {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  internals<Internals>(r).initialized = true
  vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
  if (opts.docKey) r.setDocKey(opts.docKey)
  r.setScenes(scenes)
  return r
}

function tick(r: NovelRenderer, ms = 1): void {
  r.getTimeController().tick(ms)
}

/** 現在表示中（Narration/Dialog）の本文を取得するため debugState を使う */
function text(r: NovelRenderer): string {
  return r.getDebugState().eventText ?? ''
}

describe('NovelRenderer 無条件ジャンプ [ジャンプ:] (#725)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  // ===== 基本: 到達・遷移 =====

  it('1: シーン末尾の Jump は advance で到達し、次 tick で遷移先へ移る（ドキュメント順の b は経由しない）', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('b', [narration('b1')]),
      scene('c', [narration('c1')]),
    ])
    expect(r.getCurrentSceneId()).toBe('a')

    r.advance()
    // 同期再入しない: Jump 到達直後はまだ a、遷移予約中（jumpState: pending）
    expect(r.getCurrentSceneId()).toBe('a')
    expect(internals<Internals>(r).jumpState).toBe('pending')
    expect(internals<Internals>(r).waitingForWait).toBe(false) // [待機] 用ゲートとは独立 (#733)

    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(text(r)).toContain('c1')
    expect(internals<Internals>(r).jumpState).toBe('idle')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('2: Jump より後ろのイベントは再生されない（a2 は一度も現れない）', () => {
    const seen: string[] = []
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c'), narration('a2')]),
      scene('c', [narration('c1')]),
    ])
    seen.push(text(r))
    r.advance()
    seen.push(text(r))
    tick(r)
    seen.push(text(r))
    expect(seen.some((s) => s.includes('a2'))).toBe(false)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  it('3: Jump 到達後〜遷移前の advance() は no-op（Jump を飛び越して終劇に落ちない・二重遷移しない）', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.advance()
    const idx = internals<Internals>(r).eventIndex
    r.advance()
    r.advance()
    expect(internals<Internals>(r).eventIndex).toBe(idx)
    expect(r.getSnapshot().storyEnded).toBe(false)
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('4: シーン先頭が Jump のみの中継シーンも、setScenes 直後に予約中（pending）→ tick で遷移する', () => {
    const r = makeRenderer([scene('a', [jump('c')]), scene('c', [narration('c1')])])
    expect(r.getCurrentSceneId()).toBe('a')
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  it('5: Jump 到達でそのシーンが既読になる（Choice 到達時と同じ #366）', () => {
    const r = makeRenderer(
      [scene('a', [narration('a1'), jump('c')]), scene('c', [narration('c1')])],
      { docKey: 'doc-725-read' }
    )
    expect(internals<Internals>(r).readSceneProgress.has('a')).toBe(false)
    r.advance()
    expect(internals<Internals>(r).readSceneProgress.has('a')).toBe(true)
    expect(internals<Internals>(r).readSceneProgress.has('c')).toBe(false)
  })

  // ===== 遷移先不在 =====

  it('6: 遷移先が存在せず resolver も無い → 警告のみで a の位置に停止（終劇にならない・例外なし）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    r.advance()
    expect(() => tick(r)).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('nowhere')
    expect(r.getCurrentSceneId()).toBe('a')
    expect(r.getSnapshot().storyEnded).toBe(false)
    // 以降の advance も Jump を飛び越して終劇に落ちない（何度でも停止し続ける）
    for (let i = 0; i < 3; i++) {
      r.advance()
      tick(r)
      expect(r.getSnapshot().storyEnded).toBe(false)
      expect(r.getCurrentSceneId()).toBe('a')
    }
    // 予約は stalled へ移っている: goBack 等を塞いで詰まない (S1)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
  })

  it('6b: 遷移先不在で停止中でも goBack / quickLoad は使える（stalled で詰まない）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('n1'), narration('n2'), jump('nowhere')])], {
      docKey: 'doc-725-stall',
    })
    expect(r.quickSave()).toBe(true) // n1 で保存
    r.advance() // n2
    r.advance() // Jump 到達
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    r.goBack() // 停止中: 画面の n2 を復元し直す（n1 まで飛ばさない）
    expect(text(r)).toContain('n2')
    r.advance() // Jump 再発火
    tick(r) // 再び停止
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    r.goBack()
    r.goBack() // 通常の goBack: n2 → n1
    expect(text(r)).toContain('n1')
    r.advance() // n2
    r.advance() // 再び Jump（停止）
    tick(r)
    expect(await r.quickLoad()).not.toBeNull()
    expect(text(r)).toContain('n1')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('6e: 本文 1 行のシーンの Jump 停止中でも goBack で本文へ戻れ、advance で Jump が再発火する', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('only'), jump('nowhere')])])
    r.advance()
    tick(r)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    r.goBack()
    expect(internals<Internals>(r).jumpState).toBe('idle')
    expect(text(r)).toContain('only')
    r.advance()
    tick(r)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('6f: スキップ中に停止した Jump へ着いたらスキップが解除される', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    r.setSkipMode(true)
    r.advance()
    tick(r, 100)
    expect(internals<Internals>(r).skipMode).toBe(false)
  })

  it('6c: resolver が null を返す・例外を投げる・lazy load 後も不在 → いずれも予約を stalled へ移して停止', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: Array<() => Promise<EventScene[] | null>> = [
      () => Promise.resolve(null),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve([scene('a', [narration('a1'), jump('far')])]),
    ]
    for (const resolverImpl of cases) {
      const r = makeRenderer([scene('a', [narration('a1'), jump('far')])])
      r.setMissingSceneResolver(resolverImpl)
      r.advance()
      tick(r)
      await new Promise((res) => setTimeout(res, 0))
      expect(internals<Internals>(r).jumpState).toBe('stalled')
      expect(r.getCurrentSceneId()).toBe('a')
      // いずれの失敗経路でも警告が 1 回以上出て、対象シーンIDを含む
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('far'))).toBe(true)
      warnSpy.mockClear()
      r.advance()
      expect(r.getSnapshot().storyEnded).toBe(false)
    }
  })

  it('6d: Jump 待機中（遅延ロード往復中を含む）・停止中はセーブメニューもクイックセーブも開けない (S2)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])], {
      docKey: 'doc-725-save',
    })
    const showSave = vi
      .spyOn(internals<Internals>(r).saveLoadOverlay, 'showSave')
      .mockImplementation(() => {})
    r.advance() // Jump 到達（待機中）
    internals<Internals>(r).openSaveMenu()
    expect(r.quickSave()).toBe(false)
    tick(r) // 遷移失敗 → 停止
    internals<Internals>(r).openSaveMenu()
    expect(r.quickSave()).toBe(false)
    expect(showSave).not.toHaveBeenCalled()
  })

  it('7: missingSceneResolver 経由で未ロード MD へ遷移し、ロード中の advance で終劇に落ちない', async () => {
    const entry = [scene('a', [narration('a1'), jump('far')])]
    const far = scene('far', [narration('far1')])
    let resolve!: (s: EventScene[]) => void
    const resolver = vi.fn(
      () =>
        new Promise<EventScene[]>((res) => {
          resolve = res
        })
    )
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(resolver)

    r.advance()
    tick(r)
    expect(resolver).toHaveBeenCalledWith('far')

    // ロード中に連打しても終劇に落ちない・位置は a のまま
    r.advance()
    r.advance()
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(r.getCurrentSceneId()).toBe('a')

    resolve([...entry, far])
    await new Promise((res) => setTimeout(res, 0))
    expect(r.getCurrentSceneId()).toBe('far')
    expect(text(r)).toContain('far1')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== confinement (#386) =====

  it('8: ?scene= confinement 外への Jump は終劇になる（遷移しない）', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('out')]),
      scene('out', [narration('outside')]),
    ])
    confineForTest(r, ['a'])
    r.advance()
    tick(r)
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(r.getCurrentSceneId()).toBe('a')
  })

  it('9: confinement 内（在圏）への Jump は通常遷移する', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('in')]),
      scene('in', [narration('inside')]),
    ])
    confineForTest(r, ['a', 'in'])
    r.advance()
    tick(r)
    expect(r.getCurrentSceneId()).toBe('in')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== [条件:] / Flag =====

  it('10: [条件:] 内の Jump はフラグ真のときだけ遷移する', () => {
    const build = (v: boolean) => [
      scene('a', [flag('f', v), narration('a1'), condition('f', [jump('c')]), narration('a2')]),
      scene('c', [narration('c1')]),
    ]

    const rTrue = makeRenderer(build(true))
    rTrue.advance()
    tick(rTrue)
    expect(rTrue.getCurrentSceneId()).toBe('c')

    const rFalse = makeRenderer(build(false))
    rFalse.advance()
    tick(rFalse)
    expect(rFalse.getCurrentSceneId()).toBe('a')
    expect(text(rFalse)).toContain('a2')
  })

  it('11: 先行する [フラグ:] で真になる [条件:] 内の Jump は、入場時評価で展開列に入り、到達時に遷移する (#799)', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), flag('f'), condition('f', [jump('c')]), narration('a2')]),
      scene('c', [narration('c1')]),
    ])
    // 入場時に元列を先頭から走査する: f 未設定でも、先行する Flag が f を真にするので Jump は展開列に入る
    expect(
      internals<Internals>(r).resolvedEvents.some((e) => typeof e === 'object' && 'Jump' in e)
    ).toBe(true)
    r.advance() // a1 → Flag 処理 → Jump 到達
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  // ===== 自己ジャンプ・循環 =====

  it('12: 自己ジャンプは同一シーンの先頭へ戻る（同期ループで固まらず、tick ごとに1回）', () => {
    const r = makeRenderer([scene('a', [narration('a1'), jump('a')])])
    for (let i = 0; i < 3; i++) {
      r.advance()
      tick(r)
      expect(r.getCurrentSceneId()).toBe('a')
      expect(internals<Internals>(r).eventIndex).toBe(0)
      expect(text(r)).toContain('a1')
    }
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('13: Jump のみのシーンの循環（a → b → a）は連続 100 回で警告して停止する (S3)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    internals<Internals>(r).initialized = true
    vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
    const onScene = vi.fn()
    r.setOnSceneChange(onScene)
    r.setScenes([scene('a', [jump('b')]), scene('b', [jump('a')])])
    // virtual TimeController は tick 内で連鎖する 0ms タイマーを全て消化する
    tick(r, 10)
    expect(onScene.mock.calls.length).toBeGreaterThanOrEqual(100)
    expect(onScene.mock.calls.length).toBeLessThanOrEqual(103)
    const loopWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('循環'))
    expect(loopWarns.length).toBe(1)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(r.getSnapshot().storyEnded).toBe(false)
    // 停止後は何も進まない
    const n = onScene.mock.calls.length
    tick(r, 100)
    r.advance()
    tick(r, 100)
    expect(onScene.mock.calls.length).toBe(n)
  })

  it('13b: 本文を挟む周回（a1 → Jump → a）は連続カウントがリセットされ制限されない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('a')])])
    for (let i = 0; i < 150; i++) {
      r.advance()
      tick(r)
    }
    expect(warnSpy).not.toHaveBeenCalled()
    expect(text(r)).toContain('a1')
  })

  it('13d: playScript は Jump のみの中継シーンを挟んでも（複数 hop）遷移を待ち切る', async () => {
    const r = new NovelRenderer()
    internals<Internals>(r).initialized = true
    vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
    r.setScenes([
      scene('a', [narration('a1'), jump('r')]),
      scene('r', [jump('c')]),
      scene('c', [narration('c1'), narration('c2')]),
    ])
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(r.getCurrentSceneId()).toBe('c')
    expect(text(r)).toContain('c2')
  })

  it('13c: playScript は Jump 直後の advance ステップを捨てず、遷移を待ってから進める (N3)', async () => {
    const r = new NovelRenderer()
    internals<Internals>(r).initialized = true
    vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
    r.setScenes([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1'), narration('c2')]),
    ])
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(r.getCurrentSceneId()).toBe('c')
    expect(text(r)).toContain('c2')
  })

  // ===== skip / auto =====

  it('14: オートモード中に Jump へ到達しても遷移先へ進む（autoWait 経過で advance → Jump → 遷移）', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.setAutoMode(true)
    // auto の advance タイマー（autoWaitMs）→ Jump 到達 → setTimeout(0) → 遷移
    tick(r, 60000)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('15: スキップモード中に Jump へ到達しても遷移先へ進み、終劇に落ちない', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.setSkipMode(true)
    r.advance()
    tick(r, 100)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  // ===== 破棄 =====

  it('16: 遷移タイマー待機中に destroy 相当（initialized=false）になっても例外なく遷移しない', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.advance()
    internals<Internals>(r).initialized = false
    expect(() => tick(r)).not.toThrow()
    expect(r.getCurrentSceneId()).toBe('a')
  })
})

describe('NovelRenderer Jump × 先読み preloadUpcomingAssets (#725)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
  })

  it('17: 先読みは Jump で打ち切る（Jump 以降の立ち絵は積まない）', () => {
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
    const bgSpy = vi.spyOn(bgPreload, 'backgroundPreload').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.setAssetBaseUrl('/assets')
    vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
    internals<Internals>(r).initialized = true
    r.setScenes([
      scene('s', [dialog('a', 'aa/happy', 'x'), jump('t'), dialog('b', 'bb/sad', 'y')]),
      scene('t', [narration('t')]),
    ])
    const urls = bgSpy.mock.calls.flatMap((c) => c[0] as string[])
    expect(urls.some((u) => u.includes('aa/happy'))).toBe(true)
    expect(urls.some((u) => u.includes('bb/sad'))).toBe(false)
  })
})

describe('NovelRenderer Jump × intermission.md (#725)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
  })

  it('18: intermission.md 内の Jump は無視され（dev warn）、前後の narration は継続する', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('entry', [narration('start')]), scene('out', [narration('o')])])
    r.setIntermissionScene([narration('前'), jump('entry'), narration('後')], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    confineForTest(r, ['entry'])
    r.jumpToScene('out') // 圏外 → 終劇 → intermission タブロー
    expect(() => tick(r, 10)).not.toThrow()

    const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('intermission.md'))
    expect(warns.length).toBe(1)
    expect(internals<Internals>(r).dialogBox.dialogText.text).toBe('後')
    // Jump は実行されず、終劇のまま・シーンも変わらない
    tick(r, 100)
    expect(r.getSnapshot().storyEnded).toBe(true)
  })
})

describe('NovelRenderer Jump 位置からの復元・任意局面起動 (#733)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  it('1: startFrom の eventIndex が Jump を指しても、遷移が再予約されて先へ進む', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    expect(r.getCurrentSceneId()).toBe('a')
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(text(r)).toContain('c1')
    expect(internals<Internals>(r).jumpState).toBe('idle')
  })

  it('2: 遷移先不在の Jump へ startFrom すると警告して停止し、goBack / advance で行き止まりにならない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('nowhere'))).toBe(true)
    expect(r.getSnapshot().storyEnded).toBe(false)
    r.advance()
    expect(r.getSnapshot().storyEnded).toBe(false)
    // 停止状態は復元をまたいで持ち越さない: 再度 startFrom すれば再試行して再び停止する
    warnSpy.mockClear()
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // 復元起点（history[0]）が Jump 位置で直前の本文が無いため、goBack は再試行になる（再予約・再警告・再停止）
    warnSpy.mockClear()
    r.goBack()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('3: stalled からの復元（goBack）で idle に戻り、本文位置では再予約しない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('only'), jump('nowhere')])])
    r.advance()
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    r.goBack()
    expect(internals<Internals>(r).jumpState).toBe('idle')
    expect(text(r)).toContain('only')
  })

  it('4: [条件:] 内の Jump は、復元後のフラグが真のときだけ再予約される', () => {
    const scenes = [
      scene('a', [narration('a1'), condition('f', [jump('c')]), narration('a2')]),
      scene('c', [narration('c1')]),
    ]
    const t = makeRenderer(scenes)
    t.startFrom({ sceneId: 'a', eventIndex: 1, flags: { f: { Bool: true } } })
    expect(internals<Internals>(t).jumpState).toBe('pending')
    tick(t)
    expect(t.getCurrentSceneId()).toBe('c')

    const f = makeRenderer(scenes)
    f.startFrom({ sceneId: 'a', eventIndex: 1, flags: { f: { Bool: false } } })
    expect(internals<Internals>(f).jumpState).toBe('idle')
    tick(f)
    expect(f.getCurrentSceneId()).toBe('a')
    expect(text(f)).toContain('a2')
  })

  it('5: Jump 予約中は [待機] 用の waitingForWait を立てない（2 役の分離）', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.advance()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    expect(internals<Internals>(r).waitingForWait).toBe(false)
    expect(r.getDebugState().jumpState).toBe('pending')
  })
})

// ===== #733 追加: startFrom 以外の復元経路・状態分離・世代 =====

/** ensureContext の jsdom 制約回避（loadFromSaveData / restoreSnapshot が呼ぶ）。 */
function muteAudio(r: NovelRenderer): void {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

function craftSave(over: Partial<SaveSlotData>): SaveSlotData {
  return {
    slot: -1,
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: new Date().toISOString(),
    sceneName: null,
    ...over,
  }
}

describe('NovelRenderer Jump 復元経路・状態分離 追加 (#733)', () => {
  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  const TWO = (): EventScene[] => [
    scene('a', [narration('a1'), jump('c')]),
    scene('c', [narration('c1')]),
  ]

  it('6: quickLoad で Jump を指すセーブを復元 → 遷移が再予約され先へ進む', async () => {
    new SaveManager().quickSave(craftSave({ sceneId: 'a', eventIndex: 1 }))
    const r = makeRenderer(TWO())
    muteAudio(r)
    expect(await r.quickLoad()).not.toBeNull()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    expect(r.getCurrentSceneId()).toBe('a')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(internals<Internals>(r).jumpState).toBe('idle')
  })

  it('7: [条件:] 内 Jump の真偽が quickLoad 経由でも効く', () => {
    const scenes = [
      scene('a', [narration('a1'), condition('f', [jump('c')]), narration('a2')]),
      scene('c', [narration('c1')]),
    ]
    new SaveManager().quickSave(craftSave({ eventIndex: 1, flags: { f: { Bool: true } } }))
    const t = makeRenderer(scenes)
    muteAudio(t)
    t.quickLoad()
    expect(internals<Internals>(t).jumpState).toBe('pending')
    tick(t)
    expect(t.getCurrentSceneId()).toBe('c')

    new SaveManager().quickSave(craftSave({ eventIndex: 1, flags: { f: { Bool: false } } }))
    const f = makeRenderer(scenes)
    muteAudio(f)
    f.quickLoad()
    expect(internals<Internals>(f).jumpState).toBe('idle')
    tick(f)
    expect(f.getCurrentSceneId()).toBe('a')
    expect(text(f)).toContain('a2')
  })

  it('8: restoreSnapshot で Jump を指す状態を復元 → 遷移する', () => {
    const src = makeRenderer(TWO())
    const snap = { ...src.getSnapshot(), sceneId: 'a', eventIndex: 1 }
    const r = makeRenderer(TWO())
    muteAudio(r)
    r.restoreSnapshot(snap)
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  it('9: 復元で Jump に着き循環していても consecutiveJumps 上限で止まる（復元で無限ループしない）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [jump('b')]), scene('b', [jump('a')])])
    tick(r, 1000)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('循環')).length).toBe(1)
    // 復元しても再び上限で止まる（新規 100 hop）
    warnSpy.mockClear()
    const cur = r.getCurrentSceneId()!
    r.startFrom({ sceneId: cur, eventIndex: 0 })
    tick(r, 1000)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('循環')).length).toBe(1)
  })

  it('10: pending 中は seekTo / goBack / quickLoad / quickSave / openSaveMenu を受け付けない', async () => {
    new SaveManager().quickSave(craftSave({ sceneId: 'a', eventIndex: 0 }))
    const r = makeRenderer(TWO(), { docKey: 'doc-733-pending' })
    muteAudio(r)
    const showSave = vi
      .spyOn(internals<Internals>(r).saveLoadOverlay, 'showSave')
      .mockImplementation(() => {})
    r.advance()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    r.goBack()
    r.seekTo(0)
    expect(internals<Internals>(r).jumpState).toBe('pending')
    expect(await r.quickLoad()).toBeNull()
    expect(r.quickSave()).toBe(false)
    internals<Internals>(r).openSaveMenu()
    expect(showSave).not.toHaveBeenCalled()
    expect(r.getCurrentSceneId()).toBe('a')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  it('11: stalled 中は quickLoad / seekTo / goBack は使えて、セーブ・advance は不可', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    new SaveManager().quickSave(craftSave({ sceneId: 'a', eventIndex: 0 }))
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    muteAudio(r)
    const showSave = vi
      .spyOn(internals<Internals>(r).saveLoadOverlay, 'showSave')
      .mockImplementation(() => {})
    r.advance()
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(r.quickSave()).toBe(false)
    internals<Internals>(r).openSaveMenu()
    expect(showSave).not.toHaveBeenCalled()
    r.advance()
    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    // quickLoad は使える: idle に戻り本文位置
    expect(await r.quickLoad()).not.toBeNull()
    expect(internals<Internals>(r).jumpState).toBe('idle')
    expect(text(r)).toContain('a1')
    // seekTo も使える
    r.advance()
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    r.seekTo(0)
    expect(internals<Internals>(r).jumpState).toBe('idle')
  })

  it('12: stalled の持ち越しなし: stalled 中に別の Jump 位置を復元しても再試行する', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(TWO().concat([scene('d', [narration('d1'), jump('nowhere')])]))
    r.startFrom({ sceneId: 'd', eventIndex: 1 })
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  it('13: 遅延ロード中に startFrom で別位置へ移ると、古い失敗(null)で stallJump しない（no-op）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolve!: (s: EventScene[] | null) => void
    const entry = [scene('a', [narration('a1'), jump('far')]), scene('b', [narration('b1')])]
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[] | null>((res) => {
          resolve = res
        })
    )
    r.advance()
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('pending')
    r.startFrom({ sceneId: 'b', eventIndex: 0 })
    expect(internals<Internals>(r).jumpState).toBe('idle')
    resolve(null)
    await new Promise((res) => setTimeout(res, 0))
    expect(internals<Internals>(r).jumpState).toBe('idle')
    expect(r.getCurrentSceneId()).toBe('b')
  })

  // 遅延ロード往復の世代ガード (#733): await 中に別位置へ移ったら、古い解決は成功・失敗とも破棄される。
  it('13b: 遅延ロード中に startFrom で別位置へ移ったあと、古い解決が成功しても遷移しない（世代ガード）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolve!: (s: EventScene[]) => void
    const entry = [scene('a', [narration('a1'), jump('far')]), scene('b', [narration('b1')])]
    const far = scene('far', [narration('far1')])
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[]>((res) => {
          resolve = res
        })
    )
    r.advance()
    tick(r)
    r.startFrom({ sceneId: 'b', eventIndex: 0 })
    resolve([...entry, far])
    await new Promise((res) => setTimeout(res, 0))
    expect(r.getCurrentSceneId()).toBe('b')
  })

  // 世代ガード (#733): jumpState の pending 判定だけでは世代を区別できないので、失敗側も破棄する。
  it('13c: 遅延ロード中に startFrom → 新しい Jump が pending のとき、古い失敗が新しい予約を stalled にしない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolve!: (s: EventScene[] | null) => void
    const entry = [
      scene('a', [narration('a1'), jump('far')]),
      scene('b', [narration('b1'), jump('c')]),
      scene('c', [narration('c1')]),
    ]
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[] | null>((res) => {
          resolve = res
        })
    )
    r.advance()
    tick(r)
    r.startFrom({ sceneId: 'b', eventIndex: 1 }) // 新しい Jump(c) を pending で予約
    expect(internals<Internals>(r).jumpState).toBe('pending')
    resolve(null) // 古い解決が失敗
    await new Promise((res) => setTimeout(res, 0))
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  // 同じ遷移先の解決中に同じ Jump へ戻ると、その解決を共有して待つ（予約が宙に浮かない）。
  it('13d: 遅延ロード中に startFrom で同じ Jump(far) 位置へ戻る → tick → resolve 成功で far へ遷移する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolve!: (s: EventScene[]) => void
    const calls = vi.fn()
    const entry = [scene('a', [narration('a1'), jump('far')])]
    const far = scene('far', [narration('far1')])
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(() => {
      calls()
      return new Promise<EventScene[]>((res) => {
        resolve = res
      })
    })
    r.advance()
    tick(r)
    r.startFrom({ sceneId: 'a', eventIndex: 1 }) // 世代が進み、同じ Jump を再予約
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r) // 再度 jumpToScene('far') → 進行中の解決を共有
    expect(calls).toHaveBeenCalledTimes(1)
    resolve([...entry, far])
    await new Promise((res) => setTimeout(res, 0))
    expect(r.getCurrentSceneId()).toBe('far')
    expect(internals<Internals>(r).jumpState).toBe('idle')
  })

  it('13e: 同上で resolve 失敗(null) → 新しい予約が stalled になる（pending が永久に残らない）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolve!: (s: EventScene[] | null) => void
    const entry = [scene('a', [narration('a1'), jump('far')])]
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[] | null>((res) => {
          resolve = res
        })
    )
    r.advance()
    tick(r)
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    tick(r)
    resolve(null)
    await new Promise((res) => setTimeout(res, 0))
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(r.getCurrentSceneId()).toBe('a')
  })

  it('13f: 選択肢経由の遷移でも、遅延ロード中に goBack → 同じ遷移先を再選択 → resolve で遷移する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolve!: (s: EventScene[]) => void
    const entry = [scene('a', [narration('a1'), narration('a2')])]
    const far = scene('far', [narration('far1')])
    const r = makeRenderer(entry)
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[]>((res) => {
          resolve = res
        })
    )
    r.advance()
    r.jumpToScene('far') // 選択肢確定相当（遅延ロード開始）
    r.goBack() // 世代を進める
    r.jumpToScene('far') // 再選択: 進行中の解決を共有
    resolve([...entry, far])
    await new Promise((res) => setTimeout(res, 0))
    expect(r.getCurrentSceneId()).toBe('far')
  })

  it('13g: Jump 予約中は openLoadMenu も開かない（quickLoad と同じ）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    const showLoad = vi
      .spyOn(internals<Internals>(r).saveLoadOverlay, 'showLoad')
      .mockImplementation(() => {})
    r.advance()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    internals<Internals>(r).openLoadMenu()
    expect(showLoad).not.toHaveBeenCalled()
    tick(r) // stalled
    internals<Internals>(r).openLoadMenu()
    expect(showLoad).toHaveBeenCalledTimes(1)
  })

  it('14: playScript で startFrom 直後に advance しても、復元で予約された遷移を消化する', async () => {
    const r = new NovelRenderer()
    internals<Internals>(r).initialized = true
    vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
    r.setScenes([
      scene('a', [narration('a1'), jump('c')]),
      scene('c', [narration('c1'), narration('c2')]),
    ])
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(r.getCurrentSceneId()).toBe('c')
    expect(text(r)).toContain('c2')
  })

  it('15: auto モードで Jump 位置へ復元されても、pending 中は auto が advance せず遷移で進む', () => {
    const r = makeRenderer(TWO())
    r.setAutoMode(true)
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('16: skip 中に復元で着いた遷移先不在 Jump → stalled でスキップ解除', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    r.setSkipMode(true)
    r.startFrom({ sceneId: 'a', eventIndex: 1 })
    tick(r, 100)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(internals<Internals>(r).skipMode).toBe(false)
  })

  it('17: クイックロードで復元して idle に戻したあと、二重予約されない', () => {
    new SaveManager().quickSave(craftSave({ sceneId: 'a', eventIndex: 1 }))
    const r = makeRenderer(TWO())
    muteAudio(r)
    r.quickLoad()
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    tick(r, 1000)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(internals<Internals>(r).jumpState).toBe('idle')
  })

  it('18: [待機] 中は jumpState が変わらず、Jump pending 中は waitingForWait が false', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), { Wait: { ms: 500 } } as Event, narration('a2'), jump('c')]),
      scene('c', [narration('c1')]),
    ])
    r.advance()
    expect(internals<Internals>(r).waitingForWait).toBe(true)
    expect(internals<Internals>(r).jumpState).toBe('idle')
    tick(r, 600)
    expect(internals<Internals>(r).waitingForWait).toBe(false)
    r.advance()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    expect(internals<Internals>(r).waitingForWait).toBe(false)
  })
})

// 遅延ロード中の復元と Jump の遷移状態 (#759)
describe('NovelRenderer 遅延ロード中の復元と Jump の遷移状態 (#759)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  function deferred(): {
    promise: Promise<EventScene[] | null>
    resolve: (v: EventScene[] | null) => void
    reject: (e: unknown) => void
  } {
    let resolve!: (v: EventScene[] | null) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<EventScene[] | null>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const ENTRY = [scene('a', [narration('a1'), jump('far')]), scene('b', [narration('b1')])]
  const FAR = scene('far', [narration('far1')])
  const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0))

  it('M1a: Jump の解決中に復元が失敗しても pending が残らず、Jump の遷移は最終的に完了する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const far = deferred()
    const r = makeRenderer(ENTRY)
    r.setMissingSceneResolver((id) => (id === 'far' ? far.promise : Promise.resolve(null)))
    r.advance()
    tick(r)
    expect(internals<Internals>(r).jumpState).toBe('pending')

    r.restoreSnapshot({ ...r.getSnapshot(), sceneId: 'ghost', flags: { x: { Bool: true } } })
    await flush()
    // 復元は失敗（flags も適用しない #765）。位置は Jump のままなので遷移を位置から再導出する。
    expect(internals<Internals>(r).jumpState).toBe('pending')
    tick(r)
    far.resolve([...ENTRY, FAR])
    await flush()
    expect(r.getCurrentSceneId()).toBe('far')
    expect(internals<Internals>(r).jumpState).toBe('idle')
  })

  it('M1b: Jump 予約中にロードメニューのコールバックが呼ばれても復元しない（確定時の再確認）', () => {
    const r = makeRenderer(ENTRY, { docKey: 'doc-759-load' })
    let onLoad!: (d: SaveSlotData) => void
    vi.spyOn(internals<Internals>(r).saveLoadOverlay, 'showLoad').mockImplementation(((
      cb: (d: SaveSlotData) => void
    ) => {
      onLoad = cb
    }) as never)
    internals<Internals>(r).openLoadMenu() // idle のうちに開く
    r.advance() // 裏で Jump が予約される
    expect(internals<Internals>(r).jumpState).toBe('pending')
    const snap = r.getSnapshot()
    onLoad({
      slot: 1,
      ...snap,
      sceneId: 'b',
      eventIndex: 0,
      textIndex: 0,
      sentenceIndex: 0,
      savedAt: '2026-01-01T00:00:00.000Z',
      sceneName: 'b',
    } as SaveSlotData)
    expect(r.getCurrentSceneId()).toBe('a')
    expect(internals<Internals>(r).jumpState).toBe('pending')
  })

  it('M1c: Jump 予約中にセーブメニューのコールバックが呼ばれても保存しない', () => {
    const r = makeRenderer(ENTRY, { docKey: 'doc-759-save' })
    let onSave!: (slot: number) => void
    vi.spyOn(internals<Internals>(r).saveLoadOverlay, 'showSave').mockImplementation(((
      cb: (slot: number) => void
    ) => {
      onSave = cb
    }) as never)
    internals<Internals>(r).openSaveMenu()
    r.advance()
    expect(internals<Internals>(r).jumpState).toBe('pending')
    onSave(1)
    expect(Object.keys(localStorage).filter((k) => k.startsWith('name-name-save-'))).toEqual([])
  })

  it('M2: 冒頭が Jump のエントリへ未ロードシーンの restoreSnapshot をしても、Jump タイマーに潰されず snapshot が勝つ', async () => {
    const far = deferred()
    const r = makeRenderer([scene('entry', [jump('b')]), scene('b', [narration('b1')])])
    r.setMissingSceneResolver(() => far.promise)
    r.restoreSnapshot({ ...r.getSnapshot(), sceneId: 'far', eventIndex: 0, flags: {} })
    tick(r) // 修正前: ここで冒頭 Jump が発火して b へ遷移し、復元が破棄される
    far.resolve([scene('entry', [jump('b')]), scene('b', [narration('b1')]), FAR])
    await flush()
    expect(r.getCurrentSceneId()).toBe('far')
  })

  it('M1d: Jump の解決中に成功する復元が入ると、古い Jump の解決は後から当たらない', async () => {
    const far = deferred()
    const ghost = scene('ghost', [narration('g1')])
    const r = makeRenderer(ENTRY)
    r.setMissingSceneResolver((id) =>
      id === 'far' ? far.promise : Promise.resolve([...ENTRY, ghost])
    )
    r.advance()
    tick(r)
    r.restoreSnapshot({ ...r.getSnapshot(), sceneId: 'ghost', eventIndex: 0, flags: {} })
    await flush()
    expect(r.getCurrentSceneId()).toBe('ghost')
    far.resolve([...ENTRY, FAR])
    await flush()
    expect(r.getCurrentSceneId()).toBe('ghost')
  })

  // ロード中（遅延ロード往復中）も Jump のゲートは保たれ、失敗しても Jump が消えない (#759 N1/N2)
  describe.each([
    ['quickLoad', 'stalled'],
    ['restoreSnapshot', 'pending'],
    ['restoreSnapshot', 'stalled'],
  ] as const)('%s 中（開始時 %s）', (via, initial) => {
    it.each(['null', 'missing', 'reject'] as const)(
      '解決が %s で失敗 → ロード中は advance/セーブ拒否・jumpState と位置は不変・pending なら Jump を再試行',
      async (outcome) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        new SaveManager().deleteQuickSave()
        const ghost = deferred()
        const farCalls: string[] = []
        const r = makeRenderer(ENTRY)
        r.setMissingSceneResolver((id) => {
          if (id === 'far') {
            farCalls.push(id)
            return Promise.resolve(null)
          }
          return id === 'ghost' ? ghost.promise : Promise.resolve(null)
        })
        r.advance() // a1 → Jump 到達（pending）
        if (initial === 'stalled') {
          tick(r)
          await flush()
          expect(internals<Internals>(r).jumpState).toBe('stalled')
          farCalls.length = 0
        }
        const at = r.getSnapshot()
        let loading: Promise<unknown>
        if (via === 'quickLoad') {
          new SaveManager().quickSave({
            ...(at as unknown as SaveSlotData),
            slot: -1,
            sceneId: 'ghost',
            eventIndex: 0,
            savedAt: '2026-01-01T00:00:00.000Z',
            sceneName: null,
          })
          loading = r.quickLoad()
        } else {
          loading = r.restoreSnapshot({ ...at, sceneId: 'ghost', eventIndex: 0 })
        }

        // ロード中: ゲートは外れない（Jump を飛び越せず、Jump 位置でセーブもできない）
        expect(internals<Internals>(r).jumpState).toBe(initial)
        r.advance()
        expect(r.getSnapshot().eventIndex).toBe(at.eventIndex)
        expect(r.quickSave()).toBe(false)

        if (outcome === 'null') ghost.resolve(null)
        else if (outcome === 'missing') ghost.resolve([...ENTRY])
        else ghost.reject(new Error('boom'))
        await loading
        await flush()

        expect(r.getCurrentSceneId()).toBe('a')
        expect(r.getSnapshot().eventIndex).toBe(at.eventIndex)
        expect(internals<Internals>(r).jumpState).toBe(initial)
        tick(r)
        await flush()
        if (initial === 'pending') {
          // 再予約された Jump が遷移を試み（遷移先不在）停止する
          expect(farCalls).toEqual(['far'])
          expect(internals<Internals>(r).jumpState).toBe('stalled')
        } else {
          expect(farCalls).toEqual([])
          expect(internals<Internals>(r).jumpState).toBe('stalled')
        }
        new SaveManager().deleteQuickSave()
      }
    )
  })

  it('N3: 予約中のロード/セーブ確定の拒否はトーストで通知される', () => {
    const r = makeRenderer(ENTRY, { docKey: 'doc-759-toast' })
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    let onLoad!: (d: SaveSlotData) => void
    let onSave!: (slot: number) => void
    vi.spyOn(internals<Internals>(r).saveLoadOverlay, 'showLoad').mockImplementation(((
      cb: (d: SaveSlotData) => void
    ) => {
      onLoad = cb
    }) as never)
    vi.spyOn(internals<Internals>(r).saveLoadOverlay, 'showSave').mockImplementation(((
      cb: (slot: number) => void
    ) => {
      onSave = cb
    }) as never)
    internals<Internals>(r).openLoadMenu()
    internals<Internals>(r).openSaveMenu()
    r.advance()
    onSave(1)
    expect(toast).toHaveBeenLastCalledWith('場面転換中のためセーブできません')
    onLoad({} as SaveSlotData)
    expect(toast).toHaveBeenLastCalledWith('場面転換中のためロードできません')
  })
})
