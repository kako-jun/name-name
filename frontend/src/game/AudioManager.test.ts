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

type NodeSpy = {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

function nodeSpy(): NodeSpy {
  return { connect: vi.fn(), disconnect: vi.fn() }
}

function makeVoiceAudioContext() {
  const source = {
    ...nodeSpy(),
    buffer: null,
    onended: null as (() => void) | null,
    start: vi.fn(),
    stop: vi.fn(),
  }
  const filter = {
    ...nodeSpy(),
    type: 'allpass' as BiquadFilterType,
    frequency: { setValueAtTime: vi.fn() },
  }
  const panner = { ...nodeSpy(), pan: { setValueAtTime: vi.fn() } }
  const distanceGain = { ...nodeSpy(), gain: { value: 1, setValueAtTime: vi.fn() } }
  const bgmMaster = { ...nodeSpy(), gain: { value: 1, setValueAtTime: vi.fn() } }
  const seMaster = { ...nodeSpy(), gain: { value: 1, setValueAtTime: vi.fn() } }
  const videoMaster = { ...nodeSpy(), gain: { value: 1, setValueAtTime: vi.fn() } }
  const captureDestination = { stream: {} }
  const gains = [bgmMaster, seMaster, videoMaster, distanceGain]
  const context = {
    currentTime: 3,
    destination: nodeSpy(),
    createBufferSource: vi.fn(() => source),
    createBiquadFilter: vi.fn(() => filter),
    createStereoPanner: vi.fn(() => panner),
    createGain: vi.fn(() => gains.shift()),
    createMediaStreamDestination: vi.fn(() => captureDestination),
  }
  return { context, source, filter, panner, distanceGain, seMaster, captureDestination }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

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

  it('35: 2シーケンスが同時にgap待機中にcancelSeSequence()を1回呼ぶと両方止まる (#672 フォローアップ、セルフレビューS5)', async () => {
    // 34/34bは「単一シーケンスのキャンセル」「キャンセルしない場合の2シーケンス無干渉」を
    // それぞれ検証したが、「2シーケンスが同時にgap待機中の状態でcancelSeSequence()を1回
    // 呼んだら両方とも止まる」という、複数シーケンス+実際のキャンセルの組み合わせは
    // 未検証だった。cancelSeSequence()は世代を1つ進めるだけ（全シーケンス共有のカウンタ）
    // なので、並行中の全シーケンスに一律で効くはずであることを確認する。
    vi.useFakeTimers()
    const { manager, playSeSpy } = makeManagerWithSpy()

    const first = manager.playSeSequence(['a.mp3', 'b.mp3', 'c.mp3'], 100, 100, undefined)
    await Promise.resolve()
    const second = manager.playSeSequence(['x.mp3', 'y.mp3', 'z.mp3'], 100, 100, undefined)
    await Promise.resolve()

    // 両シーケンスとも1件目（a.mp3/x.mp3）は再生済みで、2件目に進む前のgap待機中のはず。
    expect(playSeSpy).toHaveBeenCalledTimes(2)

    manager.cancelSeSequence()
    await vi.advanceTimersByTimeAsync(1000)
    await first
    await second

    // どちらのシーケンスも1件目より後（b/c/y/z）は一切再生されない。
    expect(playSeSpy).toHaveBeenCalledTimes(2)
    expect(playSeSpy).toHaveBeenCalledWith('a.mp3', undefined)
    expect(playSeSpy).toHaveBeenCalledWith('x.mp3', undefined)
  })
})

describe('AudioManager.playVoice spatial graph (#696)', () => {
  it('空間パラメータ指定時は lowpass・pan・距離 gain を SE master の手前に接続する', async () => {
    const manager = new AudioManager()
    const audio = makeVoiceAudioContext()
    const internals = manager as unknown as {
      ctx: AudioContext
      audioCache: Map<string, AudioBuffer>
    }
    internals.ctx = audio.context as unknown as AudioContext
    internals.audioCache.set('voice.ogg', {} as AudioBuffer)

    await manager.playVoice('voice.ogg', undefined, { pan: 0.25, gain: 0.5, lowpassHz: 8000 })

    expect(audio.source.connect).toHaveBeenCalledWith(audio.filter)
    expect(audio.filter.type).toBe('lowpass')
    expect(audio.filter.frequency.setValueAtTime).toHaveBeenCalledWith(8000, 3)
    expect(audio.filter.connect).toHaveBeenCalledWith(audio.panner)
    expect(audio.panner.pan.setValueAtTime).toHaveBeenCalledWith(0.25, 3)
    expect(audio.panner.connect).toHaveBeenCalledWith(audio.distanceGain)
    expect(audio.distanceGain.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 3)
    expect(audio.distanceGain.connect).toHaveBeenCalledWith(audio.seMaster)

    audio.source.onended?.()
    expect(audio.filter.disconnect).toHaveBeenCalledTimes(1)
    expect(audio.panner.disconnect).toHaveBeenCalledTimes(1)
    expect(audio.distanceGain.disconnect).toHaveBeenCalledTimes(1)
  })

  it('空間パラメータなしでは従来どおり source を SE master へ直結する', async () => {
    const manager = new AudioManager()
    const audio = makeVoiceAudioContext()
    const internals = manager as unknown as {
      ctx: AudioContext
      audioCache: Map<string, AudioBuffer>
    }
    internals.ctx = audio.context as unknown as AudioContext
    internals.audioCache.set('voice.ogg', {} as AudioBuffer)

    await manager.playVoice('voice.ogg')

    expect(audio.context.createBiquadFilter).not.toHaveBeenCalled()
    expect(audio.context.createStereoPanner).not.toHaveBeenCalled()
    expect(audio.source.connect).toHaveBeenCalledWith(audio.seMaster)
  })

  it('録画中も空間化ボイスは既存の SE master 経由で capture に流れる', async () => {
    const manager = new AudioManager()
    const audio = makeVoiceAudioContext()
    const internals = manager as unknown as {
      ctx: AudioContext
      audioCache: Map<string, AudioBuffer>
    }
    internals.ctx = audio.context as unknown as AudioContext
    internals.audioCache.set('voice.ogg', {} as AudioBuffer)

    manager.enableCapture()
    await manager.playVoice('voice.ogg', undefined, { pan: 0, gain: 1, lowpassHz: 20000 })

    expect(audio.distanceGain.connect).toHaveBeenCalledWith(audio.seMaster)
    expect(audio.seMaster.connect).toHaveBeenCalledWith(audio.captureDestination)
  })

  it('ロード順が逆転しても最後に要求したボイスだけを開始する', async () => {
    const manager = new AudioManager()
    const audio = makeVoiceAudioContext()
    const internals = manager as unknown as {
      ctx: AudioContext
      loadAudio: (url: string) => Promise<AudioBuffer>
    }
    internals.ctx = audio.context as unknown as AudioContext
    const first = deferred<AudioBuffer>()
    const second = deferred<AudioBuffer>()
    vi.spyOn(internals, 'loadAudio').mockImplementation((url) =>
      url === 'first.ogg' ? first.promise : second.promise
    )
    const firstEnded = vi.fn()
    const secondEnded = vi.fn()

    const firstRequest = manager.playVoice('first.ogg', firstEnded)
    const secondRequest = manager.playVoice('second.ogg', secondEnded)
    second.resolve({} as AudioBuffer)
    await secondRequest
    first.resolve({} as AudioBuffer)
    await firstRequest

    expect(audio.context.createBufferSource).toHaveBeenCalledTimes(1)
    expect(audio.source.start).toHaveBeenCalledTimes(1)
    expect(firstEnded).not.toHaveBeenCalled()
    audio.source.onended?.()
    expect(secondEnded).toHaveBeenCalledTimes(1)
  })

  it('停止済みの旧ボイスの遅延 onended は新ボイスの空間ノードを切断しない', async () => {
    const manager = new AudioManager()
    const audio = makeVoiceAudioContext()
    const secondSource = {
      ...nodeSpy(),
      buffer: null,
      onended: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
    }
    const secondFilter = {
      ...nodeSpy(),
      type: 'allpass' as BiquadFilterType,
      frequency: { setValueAtTime: vi.fn() },
    }
    const secondPanner = { ...nodeSpy(), pan: { setValueAtTime: vi.fn() } }
    const secondGain = { ...nodeSpy(), gain: { value: 1, setValueAtTime: vi.fn() } }
    const internals = manager as unknown as {
      ctx: AudioContext
      audioCache: Map<string, AudioBuffer>
    }
    internals.ctx = audio.context as unknown as AudioContext
    internals.audioCache.set('first.ogg', {} as AudioBuffer)
    internals.audioCache.set('second.ogg', {} as AudioBuffer)

    await manager.playVoice('first.ogg', undefined, { pan: -0.5, gain: 1, lowpassHz: 20000 })
    const staleOnEnded = audio.source.onended
    audio.context.createBufferSource.mockReturnValueOnce(secondSource)
    audio.context.createBiquadFilter.mockReturnValueOnce(secondFilter)
    audio.context.createStereoPanner.mockReturnValueOnce(secondPanner)
    audio.context.createGain.mockReturnValueOnce(secondGain)
    await manager.playVoice('second.ogg', undefined, { pan: 0.5, gain: 0.5, lowpassHz: 8000 })

    expect(audio.source.stop).toHaveBeenCalledTimes(1)
    expect(audio.filter.disconnect).toHaveBeenCalledTimes(1)
    // stopVoice は onended を外すが、既にキューされた旧 callback も安全であることを固定する。
    staleOnEnded?.()
    expect(secondFilter.disconnect).not.toHaveBeenCalled()
    expect(secondPanner.disconnect).not.toHaveBeenCalled()
    expect(secondGain.disconnect).not.toHaveBeenCalled()

    secondSource.onended?.()
    expect(secondFilter.disconnect).toHaveBeenCalledTimes(1)
    expect(secondPanner.disconnect).toHaveBeenCalledTimes(1)
    expect(secondGain.disconnect).toHaveBeenCalledTimes(1)
  })
})
