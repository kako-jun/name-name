/**
 * 時間源の抽象化レイヤー。
 *
 * 通常実行 (live モード) では `window.setTimeout` 等をそのまま使う。
 * 動画エクスポート (virtual モード) では `tick(dt)` で仮想時刻を進め、
 * 期限到達したタイマーを順次発火させる。これにより rAF や実時計に
 * 依存せず、決定論的に N ms 進めて 1 フレーム描画 → キャプチャ
 * というループでビデオを書き出せる。
 *
 * 現状の関心領域:
 * - `setTimeout` / `clearTimeout`: NovelRenderer の Wait / autoAdvance / skip
 * - `setInterval` / `clearInterval`: CharacterLayer の 2 コマ idle
 * - `now()`: CharacterLayer の elapsedMs と同等の参照時刻
 *
 * 未統合 (今後動画化が本実装に進んだ際に対応):
 * - Pixi の Ticker (NovelRenderer.shakeTimer / effectTimer、CharacterLayer.animTicker、
 *   DialogBox.ticker)
 * - AudioManager の voice/SE/BGM 同期
 *
 * 各 NovelRenderer インスタンスがひとつ持つ。React 経由でも `renderer.getTimeController()`
 * から触れる。
 */

type TimerCallback = () => void

interface VirtualTimer {
  id: number
  firesAt: number
  cb: TimerCallback
  /** undefined なら one-shot, 数値なら interval (ms) */
  interval?: number
}

export type TimeMode = 'live' | 'virtual'

export class TimeController {
  private mode: TimeMode = 'live'
  /** virtual モードの現在時刻 (ms 起点 0) */
  private virtualNow = 0
  /** virtual モード下の保留タイマー */
  private timers: VirtualTimer[] = []
  /** virtual interval callback 内で clearInterval された id。callback 後の再登録を抑止する。 */
  private clearedIntervals = new Set<number>()
  /** 現在 callback 実行中の virtual interval id。clearInterval の再登録抑止判定に使う。 */
  private firingIntervals = new Set<number>()
  private nextId = 1

  getMode(): TimeMode {
    return this.mode
  }

  /**
   * モード切替。virtual → live の切替で実時計に戻すときも、
   * 保留中の virtual タイマーは破棄される (caller 側でゲーム状態をリセットすべき)。
   */
  setMode(mode: TimeMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.virtualNow = 0
    this.timers = []
    this.clearedIntervals.clear()
    this.firingIntervals.clear()
  }

  /** 現在時刻 (ms)。live モードでは performance.now()、virtual モードでは累積仮想時刻 */
  now(): number {
    return this.mode === 'live' ? performance.now() : this.virtualNow
  }

  setTimeout(cb: TimerCallback, ms: number): number {
    if (this.mode === 'live') {
      return window.setTimeout(cb, ms) as unknown as number
    }
    const id = this.nextId++
    this.timers.push({ id, firesAt: this.virtualNow + Math.max(0, ms), cb })
    return id
  }

  clearTimeout(id: number | null | undefined): void {
    if (id == null) return
    if (this.mode === 'live') {
      window.clearTimeout(id)
      return
    }
    this.timers = this.timers.filter((t) => t.id !== id)
  }

  setInterval(cb: TimerCallback, ms: number): number {
    if (this.mode === 'live') {
      return window.setInterval(cb, ms) as unknown as number
    }
    const id = this.nextId++
    const safeMs = Math.max(1, ms)
    this.timers.push({ id, firesAt: this.virtualNow + safeMs, cb, interval: safeMs })
    return id
  }

  clearInterval(id: number | null | undefined): void {
    if (id == null) return
    if (this.mode === 'live') {
      window.clearInterval(id)
      return
    }
    this.timers = this.timers.filter((t) => t.id !== id)
    if (this.firingIntervals.has(id)) this.clearedIntervals.add(id)
  }

  /**
   * virtual モード専用: 仮想時刻を dt ms 進める。
   * 期限が来たタイマーを発火順に呼び出す。callback 内で新規 setTimeout
   * された場合も、まだ targetTime 以内ならそのフレームで発火する。
   * live モードでは何もしない。
   */
  tick(dt: number): void {
    if (this.mode !== 'virtual') return
    const target = this.virtualNow + Math.max(0, dt)
    // 安全弁: 1 回の tick で 100k 個以上の callback が発火しないようにする
    let safety = 100_000
    while (safety-- > 0) {
      if (this.timers.length === 0) break
      // 最も早い期限のタイマーを探す
      let minIdx = 0
      for (let i = 1; i < this.timers.length; i++) {
        if (this.timers[i].firesAt < this.timers[minIdx].firesAt) minIdx = i
      }
      const next = this.timers[minIdx]
      if (next.firesAt > target) break
      this.virtualNow = next.firesAt
      // 先に Map から外す (interval の再登録より前)
      this.timers.splice(minIdx, 1)
      try {
        if (next.interval !== undefined) this.firingIntervals.add(next.id)
        next.cb()
      } catch (err) {
        console.warn('[TimeController] virtual timer callback threw', err)
      } finally {
        if (next.interval !== undefined) this.firingIntervals.delete(next.id)
      }
      if (next.interval !== undefined) {
        if (this.clearedIntervals.delete(next.id)) continue
        this.timers.push({
          id: next.id,
          firesAt: this.virtualNow + next.interval,
          cb: next.cb,
          interval: next.interval,
        })
      }
    }
    this.virtualNow = target
  }

  /** virtual モード専用: 保留中タイマーの状態をデバッグ用に返す */
  getPendingTimerCount(): number {
    return this.mode === 'virtual' ? this.timers.length : -1
  }
}

/** 既定 (共有) インスタンス。NovelRenderer / CharacterLayer のデフォルト引数として使う。 */
export const defaultTimeController = new TimeController()
