/**
 * NovelRenderer の無条件ジャンプ `[ジャンプ: シーンID]`（`Event::Jump`）のテスト (#725)。
 *
 * Jump は processDirective で `markCurrentSceneRead` → `waitingForWait` ゲート →
 * `setTimeout(0)` 後に `jumpToScene` を呼ぶ。このため同期再入せず、tick(1) で初めて遷移する。
 * confinement（#386）・missingSceneResolver（#460）・intermission（#404）・先読み（#389）は
 * 既存の流儀（confinement/linearAndJumpIndex/intermission/preload の各テスト）に倣い、
 * PixiJS 実描画は対象外にして `render` を no-op 化、TimeController は virtual で駆動する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene } from '../types'

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

interface Internals {
  initialized: boolean
  skipMode: boolean
  isAtJump(): boolean
  openSaveMenu(): void
  saveLoadOverlay: { showSave: (...args: unknown[]) => void }
  eventIndex: number
  waitingForWait: boolean
  waitTimer: number | null
  storyEnded: boolean
  readSceneProgress: Set<string>
  resolvedEvents: Event[]
  render(): void
  preloadUpcomingAssets(): void
  dialogBox: { dialogText: { text: string } }
}
function internals(r: NovelRenderer): Internals {
  return r as unknown as Internals
}

/** virtual time + render no-op + initialized。setScenes より前に呼ぶ。 */
function makeRenderer(scenes: EventScene[], opts: { docKey?: string } = {}): NovelRenderer {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  internals(r).initialized = true
  vi.spyOn(internals(r), 'render').mockImplementation(() => {})
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
    // 同期再入しない: Jump 到達直後はまだ a、停止ゲートが立っている
    expect(r.getCurrentSceneId()).toBe('a')
    expect(internals(r).waitingForWait).toBe(true)

    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(text(r)).toContain('c1')
    expect(internals(r).waitingForWait).toBe(false)
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
    const idx = internals(r).eventIndex
    r.advance()
    r.advance()
    expect(internals(r).eventIndex).toBe(idx)
    expect(r.getSnapshot().storyEnded).toBe(false)
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('4: シーン先頭が Jump のみの中継シーンも、setScenes 直後に停止ゲート → tick で遷移する', () => {
    const r = makeRenderer([scene('a', [jump('c')]), scene('c', [narration('c1')])])
    expect(r.getCurrentSceneId()).toBe('a')
    expect(internals(r).waitingForWait).toBe(true)
    tick(r)
    expect(r.getCurrentSceneId()).toBe('c')
  })

  it('5: Jump 到達でそのシーンが既読になる（Choice 到達時と同じ #366）', () => {
    const r = makeRenderer(
      [scene('a', [narration('a1'), jump('c')]), scene('c', [narration('c1')])],
      { docKey: 'doc-725-read' }
    )
    expect(internals(r).readSceneProgress.has('a')).toBe(false)
    r.advance()
    expect(internals(r).readSceneProgress.has('a')).toBe(true)
    expect(internals(r).readSceneProgress.has('c')).toBe(false)
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
    // 停止ゲート（waitingForWait）は下りている: goBack 等を塞いで詰まない (S1)
    expect(internals(r).waitingForWait).toBe(false)
  })

  it('6b: 遷移先不在で停止中でも goBack / quickLoad は使える（waitingForWait で詰まない）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('n1'), narration('n2'), jump('nowhere')])], {
      docKey: 'doc-725-stall',
    })
    expect(r.quickSave()).toBe(true) // n1 で保存
    r.advance() // n2
    r.advance() // Jump 到達
    tick(r)
    expect(internals(r).waitingForWait).toBe(false)
    r.goBack() // 停止中: 画面の n2 を復元し直す（n1 まで飛ばさない）
    expect(text(r)).toContain('n2')
    r.advance() // Jump 再発火
    tick(r) // 再び停止
    expect(internals(r).waitingForWait).toBe(false)
    r.goBack()
    r.goBack() // 通常の goBack: n2 → n1
    expect(text(r)).toContain('n1')
    r.advance() // n2
    r.advance() // 再び Jump（停止）
    tick(r)
    expect(r.quickLoad()).toBe(true)
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
    expect(internals(r).isAtJump()).toBe(false)
    expect(text(r)).toContain('only')
    r.advance()
    tick(r)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(internals(r).isAtJump()).toBe(true)
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('6f: スキップ中に停止した Jump へ着いたらスキップが解除される', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [narration('a1'), jump('nowhere')])])
    r.setSkipMode(true)
    r.advance()
    tick(r, 100)
    expect(internals(r).skipMode).toBe(false)
  })

  it('6c: resolver が null を返す・例外を投げる・lazy load 後も不在 → いずれも停止ゲートを下ろして停止', async () => {
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
      expect(internals(r).waitingForWait).toBe(false)
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
    const showSave = vi.spyOn(internals(r).saveLoadOverlay, 'showSave').mockImplementation(() => {})
    r.advance() // Jump 到達（待機中）
    internals(r).openSaveMenu()
    expect(r.quickSave()).toBe(false)
    tick(r) // 遷移失敗 → 停止
    internals(r).openSaveMenu()
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
    r.setConfinedSceneIds(['a'])
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
    r.setConfinedSceneIds(['a', 'in'])
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

  it('11: Flag 後の reResolveEvents 再展開で現れた Jump も正しく遷移する（最初は偽で展開されない）', () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), flag('f'), condition('f', [jump('c')]), narration('a2')]),
      scene('c', [narration('c1')]),
    ])
    // 初期 resolve 時点では f 未設定 → Jump は resolvedEvents に居ない
    expect(internals(r).resolvedEvents.some((e) => typeof e === 'object' && 'Jump' in e)).toBe(
      false
    )
    r.advance() // a1 → Flag 処理 → reResolve → Jump 到達
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
      expect(internals(r).eventIndex).toBe(0)
      expect(text(r)).toContain('a1')
    }
    expect(r.getSnapshot().storyEnded).toBe(false)
  })

  it('13: Jump のみのシーンの循環（a → b → a）は連続 100 回で警告して停止する (S3)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    vi.spyOn(internals(r), 'render').mockImplementation(() => {})
    const onScene = vi.fn()
    r.setOnSceneChange(onScene)
    r.setScenes([scene('a', [jump('b')]), scene('b', [jump('a')])])
    // virtual TimeController は tick 内で連鎖する 0ms タイマーを全て消化する
    tick(r, 10)
    expect(onScene.mock.calls.length).toBeGreaterThanOrEqual(100)
    expect(onScene.mock.calls.length).toBeLessThanOrEqual(103)
    const loopWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('循環'))
    expect(loopWarns.length).toBe(1)
    expect(internals(r).waitingForWait).toBe(false)
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
    internals(r).initialized = true
    vi.spyOn(internals(r), 'render').mockImplementation(() => {})
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
    internals(r).initialized = true
    vi.spyOn(internals(r), 'render').mockImplementation(() => {})
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
    internals(r).initialized = false
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
    const bgSpy = vi.spyOn(Assets, 'backgroundLoad').mockResolvedValue(undefined as never)
    const r = new NovelRenderer()
    r.setAssetBaseUrl('/assets')
    vi.spyOn(internals(r), 'render').mockImplementation(() => {})
    internals(r).initialized = true
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
    r.setConfinedSceneIds(['entry'])
    r.jumpToScene('out') // 圏外 → 終劇 → intermission タブロー
    expect(() => tick(r, 10)).not.toThrow()

    const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('intermission.md'))
    expect(warns.length).toBe(1)
    expect(internals(r).dialogBox.dialogText.text).toBe('後')
    // Jump は実行されず、終劇のまま・シーンも変わらない
    tick(r, 100)
    expect(r.getSnapshot().storyEnded).toBe(true)
  })
})
