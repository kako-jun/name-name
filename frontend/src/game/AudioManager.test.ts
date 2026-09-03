/**
 * `AudioManager.playSeSequence`（SE 複数候補プールのランダム間隔順次再生、#672）のテスト。
 *
 * `playSe` 自体（AudioContext/fetch/decodeAudioData を伴う）は jsdom 検証対象外
 * （CLAUDE.md ルール7 の実機 golden path に委ねる、既存の `NovelRenderer.*.test.ts` 群と同じ
 * 割り切り）。ここでは `playSe` を spy で差し替え、`playSeSequence` の呼び出し順序・
 * 引数・タイミング（gap 待機）だけを検証する。gap は `randomGapMs(min, max)` で
 * `min === max` を渡すことで乱数に依存せず決定的な値に固定する（`seSelection.test.ts` の
 * `randomGapMs` 単体テストで別途境界値を確認済み）。
 *
 * タイマー検証は `NovelRenderer.playScript.test.ts` と同じ `vi.useFakeTimers()` +
 * `vi.advanceTimersByTimeAsync()` パターンを使う（`AudioManager` の `TimeController` は
 * 既定で live モード = `window.setTimeout` を使うため、fake timers がそのまま効く）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AudioManager } from './AudioManager'

function makeManagerWithSpy(): { manager: AudioManager; playSeSpy: ReturnType<typeof vi.fn> } {
  const manager = new AudioManager()
  const playSeSpy = vi.spyOn(manager, 'playSe').mockResolvedValue(undefined)
  return { manager, playSeSpy: playSeSpy as unknown as ReturnType<typeof vi.fn> }
}

describe('AudioManager.playSeSequence (#672)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('27: urlsが1件のとき間隔計算をせずplaySeを即座に1回だけ呼ぶ', async () => {
    vi.useFakeTimers()
    const { manager, playSeSpy } = makeManagerWithSpy()

    await manager.playSeSequence(['a.mp3'], 50, 200, undefined)

    expect(playSeSpy).toHaveBeenCalledTimes(1)
    expect(playSeSpy).toHaveBeenCalledWith('a.mp3', undefined)
    // 間隔を挟む相手がいないため、タイマーは1つも仕込まれていないはず。
    expect(vi.getTimerCount()).toBe(0)
  })

  it('28: urlsが複数のとき各再生の間にrandomGapMs分のsetTimeoutを挟む', async () => {
    vi.useFakeTimers()
    const { manager, playSeSpy } = makeManagerWithSpy()

    // min=max=100 に固定し、gap を乱数に依存せず決定的にする。
    const done = manager.playSeSequence(['a.mp3', 'b.mp3', 'c.mp3'], 100, 100, undefined)

    // 最初の再生は同期的に（gap 待機の前に）発火する。
    await Promise.resolve()
    expect(playSeSpy).toHaveBeenCalledTimes(1)

    // gap 未満では次の再生は起きない。
    await vi.advanceTimersByTimeAsync(99)
    expect(playSeSpy).toHaveBeenCalledTimes(1)

    // gap ちょうどで2件目が発火する。
    await vi.advanceTimersByTimeAsync(1)
    expect(playSeSpy).toHaveBeenCalledTimes(2)

    // 3件目も同じ gap を挟んで発火する。
    await vi.advanceTimersByTimeAsync(100)
    expect(playSeSpy).toHaveBeenCalledTimes(3)

    await done
  })

  it('29: 各urlに同じfadeInMsを適用する', async () => {
    vi.useFakeTimers()
    const { manager, playSeSpy } = makeManagerWithSpy()

    const done = manager.playSeSequence(['a.mp3', 'b.mp3', 'c.mp3'], 10, 10, 250)
    await vi.advanceTimersByTimeAsync(20)
    await done

    expect(playSeSpy).toHaveBeenCalledTimes(3)
    for (const call of playSeSpy.mock.calls) {
      expect(call[1]).toBe(250)
    }
  })

  it('30: 各playSe呼び出しはfire-and-forgetで完了を待たない', async () => {
    vi.useFakeTimers()
    const manager = new AudioManager()
    // playSe が「絶対に解決しない Promise」を返しても、playSeSequence がそれを await して
    // 止まってしまわないこと（= 完了を待たずに次の gap 待機へ進むこと）を確認する。
    const playSeSpy = vi.spyOn(manager, 'playSe').mockImplementation(() => new Promise(() => {}))

    const done = manager.playSeSequence(['a.mp3', 'b.mp3'], 10, 10, undefined)
    await vi.advanceTimersByTimeAsync(10)
    await done

    // playSe の Promise が一度も解決していないにもかかわらず、シーケンス全体が完了し
    // 2件とも呼ばれている＝playSe の完了を待っていない証拠。
    expect(playSeSpy).toHaveBeenCalledTimes(2)
  })

  it('34: cancelSeSequence() を呼ぶと、待機中のgap後の再生がキャンセルされる (#672 フォローアップ)', async () => {
    vi.useFakeTimers()
    const { manager, playSeSpy } = makeManagerWithSpy()

    const done = manager.playSeSequence(['a.mp3', 'b.mp3', 'c.mp3'], 100, 100, undefined)
    await Promise.resolve()
    expect(playSeSpy).toHaveBeenCalledTimes(1)

    // gap 待機中（2件目に進む前）にキャンセルする。
    manager.cancelSeSequence()
    await vi.advanceTimersByTimeAsync(1000)
    await done

    // キャンセル時点で既に鳴った1件目より後は一切再生されない。
    expect(playSeSpy).toHaveBeenCalledTimes(1)
  })

  it('34b: 並行して発火した別のplaySeSequenceはcancelSeSequence()の影響を受けない (#672 フォローアップ)', async () => {
    // processDirective が同一フレームで複数の [SE: 複数候補] を連続処理すると、1つの
    // AudioManager に対して playSeSequence が並行 in-flight になりうる。cancelSeSequence()
    // が「新しい呼び出しの開始」だけで誤発火しない（=世代が playSeSequence 開始時ではなく
    // cancelSeSequence 呼び出し時にだけ進む）ことを確認する回帰テスト。
    vi.useFakeTimers()
    const { manager, playSeSpy } = makeManagerWithSpy()

    const first = manager.playSeSequence(['a.mp3', 'b.mp3'], 100, 100, undefined)
    await Promise.resolve()
    // 1件目の gap 待機中に、2件目の独立した SE シーケンスが発火する。
    const second = manager.playSeSequence(['x.mp3', 'y.mp3'], 100, 100, undefined)
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(100)
    await first
    await second

    // 後発の second が先発の first を巻き込んでキャンセルしていなければ、
    // 両方とも2件ずつ最後まで再生されているはず。
    expect(playSeSpy).toHaveBeenCalledWith('a.mp3', undefined)
    expect(playSeSpy).toHaveBeenCalledWith('b.mp3', undefined)
    expect(playSeSpy).toHaveBeenCalledWith('x.mp3', undefined)
    expect(playSeSpy).toHaveBeenCalledWith('y.mp3', undefined)
    expect(playSeSpy).toHaveBeenCalledTimes(4)
  })
})
