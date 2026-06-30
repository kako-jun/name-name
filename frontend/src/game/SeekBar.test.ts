/**
 * SeekBar（シナリオスライダ）の active 状態・無操作タイマー・書き出し抑制の単体テスト (#350)。
 *
 * 検証方針（CLAUDE.md ルール7 / 設計に従う）:
 *  - jsdom で観測可能な状態のみ縛る: isActive() / alpha / shadow.visible / thumb.scale.x /
 *    thumb.y / thumb.visible / visible / onActiveChange の発火回数と引数。
 *  - 実 Pixi 描画・computed style・pointer-events 実効・EventSystem の DOM 先行発火の実 race は
 *    観測不能なので実ブラウザ（blink）に委ね、ここでは書かない。
 *  - タイマーは実 setTimeout / fake timers でなく **virtual モードの TimeController を注入**し、
 *    `tick()` で決定論的に進める。リークは `getPendingTimerCount()` で検証する。
 *  - 期待値は SeekBar / novelLayout の export 定数のみで組み、2800 や 0.5 を直書きしない。
 *  - shadow / thumb は private graphics なので internals キャストで読む（emit でなく公開メソッド・
 *    状態で駆動する設計どおり）。
 */
import { describe, it, expect, vi } from 'vitest'
import { SeekBar, ACTIVE_THUMB_SCALE, INACTIVE_ALPHA, INACTIVITY_MS } from './SeekBar'
import { TimeController } from './TimeController'
import { PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX } from './novelLayout'

const SCREEN_W = 450
const SCREEN_H = 800

/** virtual モードの TimeController を 1 つ作る（実時計に乗らず tick() で進める）。 */
function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

/** private graphics（shadow / thumb）を読むための internals ビュー。 */
interface SeekBarInternals {
  shadow: { visible: boolean }
  thumb: { visible: boolean; y: number; scale: { x: number } }
}
function internals(sb: SeekBar): SeekBarInternals {
  return sb as unknown as SeekBarInternals
}

describe('SeekBar 初期状態・active 遷移 (#350 B 群)', () => {
  // B-1: 控えめ常時表示の回帰固定。初期は inactive で alpha=INACTIVE_ALPHA・影なし・つまみ等倍・可視。
  it('B-1: 初期は inactive（alpha=INACTIVE_ALPHA・影なし・つまみ等倍・常時可視）', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    expect(sb.isActive()).toBe(false)
    expect(sb.alpha).toBe(INACTIVE_ALPHA)
    expect(internals(sb).shadow.visible).toBe(false)
    expect(internals(sb).thumb.scale.x).toBe(1)
    expect(sb.visible).toBe(true)
  })

  // B-2: activate で active 見た目（alpha=1・影表示・つまみ拡大）になり onActiveChange(true) を 1 回呼ぶ。
  it('B-2: activate で active 見た目になり onActiveChange(true) を 1 回呼ぶ', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    expect(sb.isActive()).toBe(true)
    expect(sb.alpha).toBe(1)
    expect(internals(sb).shadow.visible).toBe(true)
    expect(internals(sb).thumb.scale.x).toBe(ACTIVE_THUMB_SCALE)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(true)
  })

  // B-3: 連続 activate でも状態変化は 1 回だけ。onActiveChange(true) は重複発火しない。
  it('B-3: activate を 3 回呼んでも onActiveChange(true) は 1 回だけ', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    sb.activate()
    sb.activate()
    expect(sb.isActive()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  // B-4: deactivate で inactive 見た目に戻り onActiveChange(false) を 1 回呼ぶ。
  it('B-4: deactivate で inactive 見た目へ戻り onActiveChange(false) を呼ぶ', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    cb.mockClear()
    sb.deactivate()
    expect(sb.isActive()).toBe(false)
    expect(sb.alpha).toBe(INACTIVE_ALPHA)
    expect(internals(sb).shadow.visible).toBe(false)
    expect(internals(sb).thumb.scale.x).toBe(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(false)
  })

  // B-5: 未 active で deactivate は同値 no-op（onActiveChange を呼ばない）。
  it('B-5: 未 active での deactivate は onActiveChange を呼ばない（同値 no-op）', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.deactivate()
    expect(sb.isActive()).toBe(false)
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('SeekBar 無操作タイマー（virtual・境界） (#350 B 群)', () => {
  // B-6: INACTIVITY_MS-1 ではまだ active。発火していないので onActiveChange(true) は 1 回のまま。
  it('B-6: activate→tick(INACTIVITY_MS-1) ではまだ active（true は 1 回だけ）', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    time.tick(INACTIVITY_MS - 1)
    expect(sb.isActive()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenLastCalledWith(true)
  })

  // B-7: ちょうど INACTIVITY_MS で inactive へ落ち onActiveChange(false) が発火する（計 true1/false1）。
  it('B-7: activate→tick(INACTIVITY_MS) で inactive へ落ち onActiveChange(false) を呼ぶ', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    time.tick(INACTIVITY_MS)
    expect(sb.isActive()).toBe(false)
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenNthCalledWith(1, true)
    expect(cb).toHaveBeenNthCalledWith(2, false)
  })

  // B-8: 操作のたびにタイマーを延長（再アーム）する。途中で activate し直すと旧期限を過ぎても active。
  it('B-8: tick 途中の再 activate でタイマーが延長され、旧期限を越えても active のまま', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    sb.activate()
    time.tick(1000) // 旧タイマーは firesAt=INACTIVITY_MS のまま
    sb.activate() // 再アーム（firesAt=1000+INACTIVITY_MS）
    time.tick(INACTIVITY_MS - 999) // 累積 1001+? → 旧期限(INACTIVITY_MS)は越えるが新期限未満
    // 延長されていなければ旧タイマーが発火して inactive になっていたはず。
    expect(sb.isActive()).toBe(true)
  })

  // B-9: onActiveChange 未設定でも activate/deactivate は例外を投げない（?. の安全性）。
  it('B-9: onActiveChange 未設定でも activate/deactivate は例外を投げない', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    expect(() => {
      sb.activate()
      sb.deactivate()
    }).not.toThrow()
  })
})

describe('SeekBar つまみ表示・位置・後始末 (#350 B 群)', () => {
  // B-10: total=0 ではつまみ非表示、total>0 で表示（位置計算が成立する範囲のみ出す）。
  it('B-10: update(0,0) でつまみ非表示・update(2,5) で表示', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    sb.update(0, 0)
    expect(internals(sb).thumb.visible).toBe(false)
    sb.update(2, 5)
    expect(internals(sb).thumb.visible).toBe(true)
  })

  // B-11: つまみ中心 Y は下部丸ボタン中央（画面下端 - 中央オフセット）に固定（export 定数のみで）。
  it('B-11: thumb.y === screenHeight - PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    expect(internals(sb).thumb.y).toBe(SCREEN_H - PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX)
  })

  // B-12: destroy で無操作タイマーを解放しリークさせない（getPendingTimerCount が 0 に戻る）。
  // jsdom で Pixi Container.destroy() が落ちないことを確認済みなので、設計の spy 縮退は不要。
  it('B-12: activate でタイマー 1 本 → destroy で 0 本（タイマーリークなし）', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    sb.activate()
    expect(time.getPendingTimerCount()).toBe(1)
    sb.destroy()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  // B-13: ライフサイクル全域で console.error / console.warn を出さない（静かに動く）。
  it('B-13: 一連のライフサイクルで console.error/warn を呼ばない', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    sb.setOnActiveChange(vi.fn())
    sb.activate()
    sb.update(3, 10)
    time.tick(INACTIVITY_MS)
    sb.activate()
    sb.deactivate()
    sb.destroy()
    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('SeekBar setExportSuppressed（書き出し抑制） (#350 C 群)', () => {
  // C-1: active 中に書き出し開始すると非表示・active 解除・onActiveChange(false)・タイマー解除。
  it('C-1: active 中の setExportSuppressed(true) で非表示・active 解除・タイマー 0', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    expect(time.getPendingTimerCount()).toBe(1)
    cb.mockClear()
    sb.setExportSuppressed(true)
    expect(sb.visible).toBe(false)
    expect(sb.isActive()).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(false)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  // C-2: 書き出し中（suppressed）は activate が no-op。active にならず非表示維持・発火なし・タイマーなし。
  it('C-2: setExportSuppressed(true) 後の activate は no-op（active にならない）', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.setExportSuppressed(true)
    sb.activate()
    expect(sb.isActive()).toBe(false)
    expect(sb.visible).toBe(false)
    expect(cb).not.toHaveBeenCalled()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  // C-3: 書き出し終了で再表示するが、勝手に再 active しない（_active は false のまま）。
  it('C-3: setExportSuppressed(false) で再表示するが自動再 active しない', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    sb.setExportSuppressed(true) // 非表示・active 解除
    cb.mockClear()
    sb.setExportSuppressed(false)
    expect(sb.visible).toBe(true)
    expect(sb.isActive()).toBe(false)
    expect(cb).not.toHaveBeenCalled()
  })

  // C-4: 同値連続呼び出しは早期 return（2 回目以降は visible も onActiveChange も変えない）。
  it('C-4: 冪等（false→false / true,true 連続）で 2 回目以降は変化なし', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    // false→false: 既定 false に同値再設定 → 早期 return（表示・発火に変化なし）。
    sb.setExportSuppressed(false)
    expect(sb.visible).toBe(true)
    expect(cb).not.toHaveBeenCalled()
    // true 1 回目: 抑制が効いて非表示。
    sb.setExportSuppressed(true)
    expect(sb.visible).toBe(false)
    // true 2 回目: 同値 → 早期 return。非表示維持・追加発火なし。
    sb.setExportSuppressed(true)
    expect(sb.visible).toBe(false)
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('SeekBar setBlackoutHidden（暗転中の非表示） (#350 C 群)', () => {
  // C-5: 暗転中は非表示、暗転解除で表示が復帰する（exportSuppressed が無ければ visible は blackout に従う）。
  it('C-5: setBlackoutHidden(true) で非表示・(false) で表示復帰', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    sb.setBlackoutHidden(true)
    expect(sb.visible).toBe(false)
    sb.setBlackoutHidden(false)
    expect(sb.visible).toBe(true)
  })

  // C-6: 暗転に入ると active も解除する（暗転中にスライダ操作 active が残らない）。
  it('C-6: active 中の setBlackoutHidden(true) で非表示かつ active 解除・onActiveChange(false)', () => {
    const time = virtualTime()
    const sb = new SeekBar(SCREEN_W, SCREEN_H, time)
    const cb = vi.fn()
    sb.setOnActiveChange(cb)
    sb.activate()
    cb.mockClear()
    sb.setBlackoutHidden(true)
    expect(sb.visible).toBe(false)
    expect(sb.isActive()).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(false)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  // C-7: exportSuppressed と blackout の両ゲート: 片方でも true なら非表示・両方 false で初めて表示。
  it('C-7: export/blackout のどちらか true で非表示・両方 false で表示', () => {
    const sb = new SeekBar(SCREEN_W, SCREEN_H, virtualTime())
    // 両方 true → 非表示。
    sb.setExportSuppressed(true)
    sb.setBlackoutHidden(true)
    expect(sb.visible).toBe(false)
    // export だけ解除（blackout はまだ true）→ なお非表示。
    sb.setExportSuppressed(false)
    expect(sb.visible).toBe(false)
    // blackout も解除 → 両方 false で表示。
    sb.setBlackoutHidden(false)
    expect(sb.visible).toBe(true)
  })
})
