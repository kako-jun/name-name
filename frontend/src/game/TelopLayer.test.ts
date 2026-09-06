/**
 * TelopLayer（テロップレイヤー #674）の単体テスト。
 *
 * 検証方針（EventImageLayer.test.ts / ToastOverlay.test.ts と同じ流儀、CLAUDE.md ルール7）:
 *  - スライドイン/保持/フェードアウトの位相進行は `TimeController` を **virtual モードで注入**し、
 *    `tick()` で決定論的に進める（実 setInterval/setTimeout に乗らない）。
 *  - 位相・幾何（container.x/y, phase, textWidth 等）は private のため、internals キャストで読む
 *    （公開 API `show()`/`clear()`/`resize()` 経由で駆動した結果の観測に限定する）。
 *  - jsdom には canvas 2D context が無い（`src/test/setup.ts` が `getContext` を null 固定）ため、
 *    PixiJS Text の `.width` は常に例外を投げる。`measureTextWidth` のフォールバック経路
 *    （#25）はこの環境で自然に踏まれる（追加のモックは不要）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Graphics } from 'pixi.js'
import { TelopLayer, type TelopShowOptions } from './TelopLayer'
import { TimeController } from './TimeController'
import type { TelopPosition } from '../types'
import {
  TELOP_SLIDE_IN_MS,
  TELOP_FADE_OUT_MS,
  TELOP_FONT_SCALE,
  TELOP_MAX_STACK,
} from './novelLayout'

const SCREEN_W = 800
const SCREEN_H = 450

/** virtual モードの TimeController を 1 つ作る（実時計に乗らず tick() で進める）。 */
function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

function makeLayer(time: TimeController): TelopLayer {
  return new TelopLayer(SCREEN_W, SCREEN_H, time)
}

/** updateFrame の駆動 interval（TelopLayer 実装と同じ 16ms 刻み）。 */
const FRAME_MS = 16

/**
 * interval 駆動(16ms刻み)の量子化後、閾値 ms 以上に達する最初の仮想時刻を返す
 * （`updateFrame` は interval callback 内でしか elapsed を評価しないため、
 * 境界は実際にはこの量子化された時刻で発火する）。期待値を直書きせず、
 * `TELOP_SLIDE_IN_MS`/`TELOP_FADE_OUT_MS` など export 定数から算出する。
 */
function quantizedThreshold(ms: number): number {
  return Math.ceil(ms / FRAME_MS) * FRAME_MS
}

/** TelopShowOptions のデフォルト値を持つビルダー。テストごとに必要な値だけ上書きする。 */
function opts(
  text: string,
  overrides?: Partial<{
    position: TelopPosition
    seconds: number
    kind: string | null
    fontFamily: string
    fontSize: number
    accentColor: number
  }>
): TelopShowOptions {
  return {
    text,
    position: overrides?.position ?? 'BottomRight',
    seconds: overrides?.seconds ?? 4,
    kind: overrides?.kind,
    fontFamily: overrides?.fontFamily ?? 'sans-serif',
    fontSize: overrides?.fontSize ?? 24,
    accentColor: overrides?.accentColor ?? 0xffffff,
  }
}

/** private entries を読むための internals ビュー。 */
interface TelopEntryForTest {
  id: number
  position: TelopPosition
  phase: 'in' | 'hold' | 'out'
  accentColor: number
  targetX: number
  targetY: number
  slideFromX: number
  width: number
  height: number
  textWidth: number
  container: { x: number; y: number; alpha: number }
  textObj: { text: string }
  accent: Graphics
}
interface TelopLayerInternals {
  entries: TelopEntryForTest[]
}
function internals(layer: TelopLayer): TelopLayerInternals {
  return layer as unknown as TelopLayerInternals
}

describe('TelopLayer.show() 直後の初期状態', () => {
  // 14: show 直後は phase='in'、container.x はスライドイン開始位置 slideFromX に等しい。
  it('14: show 直後は phase="in"、container.x が slideFromX に等しい', () => {
    const layer = makeLayer(virtualTime())
    layer.show(opts('通知'))
    const entry = internals(layer).entries[0]
    expect(entry.phase).toBe('in')
    expect(entry.container.x).toBe(entry.slideFromX)
  })
})

describe('TelopLayer 位相境界（スライドイン→保持→フェードアウト→破棄）', () => {
  // 15: in→hold の境界。interval は 16ms 刻みで駆動されるため、SLIDE_IN_MS(300ms) ちょうどの
  //     フレームではなく「300ms 以上に達する最初の16ms刻み(304ms)」で遷移する（実装と同じ量子化）。
  //     1刻み前（288ms）はまだ in のまま。
  it('15: in→hold の境界（TELOP_SLIDE_IN_MS 未満の最後の刻みはまだ in、閾値到達で hold に遷移し container.x が targetX にスナップする）', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知'))
    const entry = internals(layer).entries[0]

    const afterMs = quantizedThreshold(TELOP_SLIDE_IN_MS)
    const beforeMs = afterMs - FRAME_MS

    time.tick(beforeMs) // TELOP_SLIDE_IN_MS 未満の最後の刻み
    expect(entry.phase).toBe('in')

    time.tick(afterMs - beforeMs) // TELOP_SLIDE_IN_MS 以上に達する
    expect(entry.phase).toBe('hold')
    expect(entry.container.x).toBe(entry.targetX)
  })

  // 16: hold→out の境界（seconds=1）。holdTimer は setTimeout（interval と違い量子化されない）
  //     なので TELOP_SLIDE_IN_MS + 1000ms のちょうど1ms前/到達で厳密に検証できる。
  it('16: hold→out の境界（TELOP_SLIDE_IN_MS+1000ms の1ms前は hold、到達で out に遷移する・seconds=1）', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知', { seconds: 1 }))
    const entry = internals(layer).entries[0]

    time.tick(TELOP_SLIDE_IN_MS + 1000 - 1)
    expect(entry.phase).toBe('hold')

    time.tick(1)
    expect(entry.phase).toBe('out')
  })

  // 17: out→破棄の境界（seconds=1）。out 中の interval も16ms刻みで量子化されるため、
  //     FADE_OUT_MS(700ms) 未満の最後の刻み(688ms)ではまだ alpha>0 で entries に残り、
  //     700ms 以上に達する刻み(704ms)で entries から破棄される。
  it('17: out→破棄の境界（TELOP_FADE_OUT_MS 未満の最後の刻みは alpha>0 のまま残る、閾値到達で entries から破棄される）', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知', { seconds: 1 }))

    time.tick(TELOP_SLIDE_IN_MS + 1000) // out へ遷移した瞬間（phaseStartedAtMs がここにリセットされる）
    const entry = internals(layer).entries[0]
    expect(entry.phase).toBe('out')

    const afterMs = quantizedThreshold(TELOP_FADE_OUT_MS)
    const beforeMs = afterMs - FRAME_MS

    time.tick(beforeMs) // TELOP_FADE_OUT_MS 未満の最後の刻み
    expect(internals(layer).entries.length).toBe(1)
    expect(entry.container.alpha).toBeGreaterThan(0)

    time.tick(afterMs - beforeMs) // TELOP_FADE_OUT_MS 以上に達し破棄される
    expect(internals(layer).entries.length).toBe(0)
  })
})

describe('TelopLayer race: clear()/resize() の割り込み', () => {
  // 18: 'in' 中（スライドイン中）に clear() を呼ぶと、interval・holdTimer 両方が解除され
  //     entries が空になる（タイマーリークしない）。
  it('18: race — in 中の clear() でタイマーが全解除され entries が空になる', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知'))
    expect(time.getPendingTimerCount()).toBeGreaterThan(0)

    layer.clear()

    expect(internals(layer).entries.length).toBe(0)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  // 19: 'hold' 中（interval は既に停止済み、holdTimer だけ残る）に clear() を呼んでも同様。
  it('19: race — hold 中の clear() でもタイマーが全解除され entries が空になる', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知'))
    time.tick(quantizedThreshold(TELOP_SLIDE_IN_MS)) // in→hold 遷移後
    expect(internals(layer).entries[0].phase).toBe('hold')
    expect(time.getPendingTimerCount()).toBe(1) // holdTimer のみ残っている

    layer.clear()

    expect(internals(layer).entries.length).toBe(0)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  // 20: 'hold' 中の resize() は、補間ではなく新しい定位置へ即座にスナップする
  //     （relayout() は phase!=='in' のとき container.x を targetX に直接代入する）。
  it('20: race — hold 中の resize() は新しい target へ即座にスナップする（補間しない）', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知', { position: 'BottomRight' }))
    time.tick(quantizedThreshold(TELOP_SLIDE_IN_MS)) // hold へ
    const entry = internals(layer).entries[0]
    const oldTargetX = entry.targetX

    layer.resize(1600, 900)

    expect(entry.targetX).not.toBe(oldTargetX) // BottomRight は screenWidth に応じて target が変わる
    expect(entry.container.x).toBe(entry.targetX) // 即座にスナップ
  })

  // 21: 'in' 中（スライドイン補間中）の resize() は、進行中の container.x を書き換えない
  //     （relayout() は phase==='in' のとき container.x に触れない。次フレームの updateFrame が
  //     新しい target/slideFromX を使って補間を継続する）。
  it('21: race — in 中の resize() は補間中の container.x を壊さない（target だけ更新され、次フレームから反映される）', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('通知', { position: 'BottomRight' }))
    const entry = internals(layer).entries[0]
    time.tick(Math.floor(TELOP_SLIDE_IN_MS / 2)) // スライドイン半ば（まだ in）
    expect(entry.phase).toBe('in')
    const xBeforeResize = entry.container.x
    const oldTargetX = entry.targetX

    layer.resize(1600, 900)

    expect(entry.phase).toBe('in') // まだ in のまま
    expect(entry.container.x).toBe(xBeforeResize) // 補間中の位置は変えない
    expect(entry.targetX).not.toBe(oldTargetX) // 新しい定位置自体は更新されている
  })
})

describe('TelopLayer 「in」中の stackIndex 変化 (#674 セルフレビュー S3)', () => {
  // 26: 先発が 'in'（スライドイン中）のまま、同一 position へ後発の show() が入って
  //     stackIndex がずれ targetY が変わっても、Y は瞬間移動せず補間で新しい定位置へ追従する
  //     （X と同じ扱い。relayout() は 'in' 中の container.y に触れず、updateFrame が
  //     slideFromY→targetY を毎フレーム補間する）。
  it('26: in 中に後発の show() で stackIndex がずれても、先発の Y は瞬間移動せず補間で新しい targetY に収束する', () => {
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show(opts('先発', { position: 'BottomRight' }))
    const entry = internals(layer).entries[0]

    const halfMs = Math.floor(TELOP_SLIDE_IN_MS / 2)
    time.tick(halfMs)
    expect(entry.phase).toBe('in')
    const yBeforeStackShift = entry.container.y
    const targetYBeforeStackShift = entry.targetY

    layer.show(opts('後発', { position: 'BottomRight' })) // 先発を stackIndex 1 へ押し出す

    expect(entry.phase).toBe('in') // まだ in のまま
    expect(entry.targetY).not.toBe(targetYBeforeStackShift) // stackIndex がずれ target 自体は変わる
    expect(entry.container.y).toBe(yBeforeStackShift) // 直後は瞬間移動しない（relayout は in 中の container.y に触れない）

    const afterMs = quantizedThreshold(TELOP_SLIDE_IN_MS)
    time.tick(afterMs - halfMs) // スライドイン完了まで進める

    expect(entry.phase).toBe('hold')
    expect(entry.container.y).toBe(entry.targetY) // 新しい定位置へ補間で収束している
  })
})

describe('TelopLayer スタック eviction (#674 同時最大 TELOP_MAX_STACK 段)', () => {
  // 22: 同一 position のスタックが TELOP_MAX_STACK 件まで積み上がり、+1件目で最古が即座に
  //     破棄される（フェードなし）。破棄された段のタイマーも解放され、残りは3件のまま。
  it(`22: 同一 position のスタックが1〜${TELOP_MAX_STACK}件で積み上がり、${TELOP_MAX_STACK + 1}件目で最古が即座に破棄されタイマーも解放される`, () => {
    const time = virtualTime()
    const layer = makeLayer(time)

    for (let i = 1; i <= TELOP_MAX_STACK; i++) {
      layer.show(opts(String(i), { position: 'BottomRight' }))
      expect(internals(layer).entries.length).toBe(i)
    }

    const firstId = internals(layer).entries[0].id
    const pendingBeforeOverflow = time.getPendingTimerCount()

    layer.show(opts(String(TELOP_MAX_STACK + 1), { position: 'BottomRight' }))

    const entries = internals(layer).entries
    expect(entries.length).toBe(TELOP_MAX_STACK) // 超過しない
    expect(entries.find((e) => e.id === firstId)).toBeUndefined() // 最古が即座に破棄される
    expect(entries.map((e) => e.textObj.text)).toEqual(['2', '3', String(TELOP_MAX_STACK + 1)])
    // 破棄された段の2タイマー(interval+holdTimer)が解放され、新規段の2タイマーが追加されるため
    // 差し引き0（リークしない）。
    expect(time.getPendingTimerCount()).toBe(pendingBeforeOverflow)
  })

  // 23: eviction のカウントは position ごとに独立する。BottomRight 側の超過が TopLeft の段数に
  //     影響しない。
  it('23: 異なる position 間では eviction のカウントが独立する（BottomRight の超過が TopLeft に影響しない）', () => {
    const layer = makeLayer(virtualTime())
    layer.show(opts('br1', { position: 'BottomRight' }))
    layer.show(opts('br2', { position: 'BottomRight' }))
    layer.show(opts('br3', { position: 'BottomRight' }))
    layer.show(opts('tl1', { position: 'TopLeft' }))

    layer.show(opts('br4', { position: 'BottomRight' })) // BottomRight 側だけ4件目→evict

    const entries = internals(layer).entries
    expect(entries.filter((e) => e.position === 'BottomRight').length).toBe(TELOP_MAX_STACK)
    expect(entries.filter((e) => e.position === 'TopLeft').length).toBe(1) // 影響を受けない
    expect(entries.find((e) => e.textObj.text === 'tl1')).toBeDefined()
  })
})

describe('TelopLayer スタックの並び順（新しいものが視覚的に下）', () => {
  // 24: 下端アンカー(BottomRight)・上端アンカー(TopLeft)のどちらも、新しいものほど視覚的に
  //     「下」（BottomRight は y が大きい＝下端に近い、TopLeft は y が大きい＝上端から離れる）
  //     に来る（TelopLayer クラス doc 冒頭の意味論どおり）。
  it('24: BottomRight は新しいものほど y が大きい（下端に近い＝視覚的に下）', () => {
    const layer = makeLayer(virtualTime())
    layer.show(opts('br1', { position: 'BottomRight' }))
    layer.show(opts('br2', { position: 'BottomRight' }))
    layer.show(opts('br3', { position: 'BottomRight' }))
    const entries = internals(layer).entries
    const yOf = (t: string) => entries.find((e) => e.textObj.text === t)!.targetY

    expect(yOf('br3')).toBeGreaterThan(yOf('br2'))
    expect(yOf('br2')).toBeGreaterThan(yOf('br1'))
  })

  it('24b: TopLeft も新しいものほど y が大きい（上端から離れる＝視覚的に下）', () => {
    const layer = makeLayer(virtualTime())
    layer.show(opts('tl1', { position: 'TopLeft' }))
    layer.show(opts('tl2', { position: 'TopLeft' }))
    layer.show(opts('tl3', { position: 'TopLeft' }))
    const entries = internals(layer).entries
    const yOf = (t: string) => entries.find((e) => e.textObj.text === t)!.targetY

    expect(yOf('tl3')).toBeGreaterThan(yOf('tl2'))
    expect(yOf('tl2')).toBeGreaterThan(yOf('tl1'))
  })
})

describe('TelopLayer measureTextWidth フォールバック (#674)', () => {
  // 25: jsdom には canvas 2D context が無い（src/test/setup.ts が getContext を null 固定）ため、
  //     PixiJS Text の `.width` は常に例外を投げる。measureTextWidth はこれを catch し、
  //     `文字数 × fontSize×TELOP_FONT_SCALE×0.95` の近似値にフォールバックする
  //     （実装コメントの式どおり）。追加のモックなしでこの環境で自然に踏まれる経路。
  it('25: textObj.width が例外を投げる環境(jsdom)では、文字数×fontSize×TELOP_FONT_SCALE×0.95 のフォールバック値になる', () => {
    const layer = makeLayer(virtualTime())
    const text = '実績解除'
    const fontSize = 24
    layer.show(opts(text, { fontSize }))
    const entry = internals(layer).entries[0]

    const expected = text.length * (fontSize * TELOP_FONT_SCALE * 0.95)
    expect(entry.textWidth).toBe(expected)
  })
})

describe('TelopLayer.setAccentColor (#674 セルフレビュー2巡目 S-1)', () => {
  const NEW_COLOR = 0x00ff00

  // 27: 表示中の複数段（同一 position の複数段・別 position の段の両方）が、全て新色で
  //     再描画される（accentColor が更新され、accent Graphics の clear/fill が呼ばれる）。
  it('27: 表示中の複数段（同一 position・別 position）が全て新色で再描画される', () => {
    const layer = makeLayer(virtualTime())
    layer.show(opts('br1', { position: 'BottomRight' }))
    layer.show(opts('br2', { position: 'BottomRight' }))
    layer.show(opts('tl1', { position: 'TopLeft' }))
    const entries = internals(layer).entries
    const clearSpies = entries.map((e) => vi.spyOn(e.accent, 'clear'))
    const fillSpies = entries.map((e) => vi.spyOn(e.accent, 'fill'))

    layer.setAccentColor(NEW_COLOR)

    entries.forEach((entry, i) => {
      expect(entry.accentColor).toBe(NEW_COLOR)
      expect(clearSpies[i]).toHaveBeenCalled()
      expect(fillSpies[i]).toHaveBeenCalled()
    })
  })

  // 28: entries が空（一度も show() していない）なら no-op — 例外を投げない。
  it('28: entries が空なら no-op（例外を投げない）', () => {
    const layer = makeLayer(virtualTime())
    expect(() => layer.setAccentColor(NEW_COLOR)).not.toThrow()
    expect(internals(layer).entries.length).toBe(0)
  })

  // 29: phase が 'in'/'hold'/'out' のどれであっても accentColor が更新され再描画される
  //     （phase 自体は setAccentColor で変化しない）。
  it.each(['in', 'hold', 'out'] as const)(
    '29: phase="%s" でも accentColor が更新され再描画される',
    (targetPhase) => {
      const time = virtualTime()
      const layer = makeLayer(time)
      layer.show(opts('通知', { seconds: 1 }))
      const entry = internals(layer).entries[0]

      if (targetPhase === 'hold' || targetPhase === 'out') {
        time.tick(quantizedThreshold(TELOP_SLIDE_IN_MS)) // in→hold
      }
      if (targetPhase === 'out') {
        time.tick(1000) // hold(seconds=1)ぶん経過 → out へ（破棄はまだ）
      }
      expect(entry.phase).toBe(targetPhase)

      const clearSpy = vi.spyOn(entry.accent, 'clear')
      const fillSpy = vi.spyOn(entry.accent, 'fill')

      layer.setAccentColor(NEW_COLOR)

      expect(entry.accentColor).toBe(NEW_COLOR)
      expect(clearSpy).toHaveBeenCalled()
      expect(fillSpy).toHaveBeenCalled()
      expect(entry.phase).toBe(targetPhase) // phase 自体は変えない
    }
  )

  // 30: 更新後に別の show() が入り relayout() が走っても、新色は上書きされず保持される。
  it('30: 更新後に別の show() で relayout が走っても新色が保持される', () => {
    const layer = makeLayer(virtualTime())
    layer.show(opts('先発', { position: 'BottomRight' }))
    const entry = internals(layer).entries[0]

    layer.setAccentColor(NEW_COLOR)
    expect(entry.accentColor).toBe(NEW_COLOR)

    layer.show(opts('後発', { position: 'BottomRight' })) // relayout() が再度 redrawEntryBackground を呼ぶ

    expect(entry.accentColor).toBe(NEW_COLOR) // 古い色に戻らない
  })
})
