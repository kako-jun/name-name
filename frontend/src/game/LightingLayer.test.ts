/**
 * LightingLayer（追うスポットライト #693）の単体テスト。
 *
 * `PropLayer.test.ts`/`BackgroundBoardLayer.test.ts` と同じ流儀（internals キャストで
 * private state を読む、`TimeController` を virtual モードで注入し `tick()` で決定論的に
 * ticker を進める）だが、LightingLayer は画像ロードではなく canvas 2D グラデーション生成
 * （`ambientEffects.buildDisplacementNoiseCanvas` と同じ方式）を使う点が異なる。
 *
 * このリポの jsdom 環境は `src/test/setup.ts` が `HTMLCanvasElement.prototype.getContext` を
 * 常に `null` を返すよう固定している（`ambientEffects.test.ts` が明記する既知の制約）ため、
 * `LightingLayer` 内部の `sprite` は本ファイルの全テストを通じて常に `null` になる。そのため
 * ここでは「sprite に反映された値」ではなく、`getState()`（settled state）・
 * `characterLayer.getCurrentPosition` への呼び出し内容・`document.createElement` の呼び出し
 * 回数・ticker(`tickerId`) の生存有無という、sprite が null でも観測できる契約を検証する
 * （CLAUDE.md doctrine: env-limit を盾にせず検証可能な範囲で確実に縛る）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LightingLayer, type SpotlightLayerState } from './LightingLayer'
import { TimeController } from './TimeController'
import { CharacterLayer } from './CharacterLayer'

const SCREEN_W = 800
const SCREEN_H = 450

/** virtual モードの TimeController を 1 つ作る（実時計に乗らず tick() で進める）。 */
function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

/** `getCurrentPosition` だけを持つ最小の CharacterLayer モック。 */
function mockCharacterLayer(
  getCurrentPosition: (name: string) => { x: number; y: number } | null = () => null
): CharacterLayer {
  return { getCurrentPosition: vi.fn(getCurrentPosition) } as unknown as CharacterLayer
}

interface LightingLayerInternals {
  sprite: { visible: boolean } | null
  state: SpotlightLayerState | null
  tickerId: number | null
}
function internals(layer: LightingLayer): LightingLayerInternals {
  return layer as unknown as LightingLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LightingLayer 基本 / jsdom 環境防御 (#693)', () => {
  it('jsdom（canvas 2D 未実装）でも例外を投げずに構築でき、sprite は null のまま state 管理は継続する', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    expect(internals(layer).sprite).toBeNull()

    expect(() => layer.set(null, '#ff0000', 0.3)).not.toThrow()
    expect(layer.getState()).toEqual({ target: null, color: '#ff0000', radius: 0.3 })
  })

  it('eventMode は none（誤タップで本文が進むのを防ぐ、他の演出レイヤーと同じ規律）', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    expect(layer.eventMode).toBe('none')
  })

  it('色変更時にテクスチャを再構築しない（constructor で1回だけ canvas 生成、set() のたびに作り直さない）', () => {
    const createElementSpy = vi.spyOn(document, 'createElement')
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    const canvasCallsAfterConstruct = createElementSpy.mock.calls.filter(
      ([tag]) => tag === 'canvas'
    ).length
    expect(canvasCallsAfterConstruct).toBe(1)

    layer.set(null, '#ff0000', 0.2)
    layer.set(null, '#00ff00', 0.3)
    layer.set('alice', '#0000ff', 0.4)

    const canvasCallsAfterSets = createElementSpy.mock.calls.filter(
      ([tag]) => tag === 'canvas'
    ).length
    expect(canvasCallsAfterSets).toBe(canvasCallsAfterConstruct)
  })
})

describe('追従対象の解決 (#693)', () => {
  it('target 省略時は画面中央固定になり、characterLayer.getCurrentPosition は一度も呼ばれない', () => {
    const getCurrentPosition = vi.fn(() => null)
    const characterLayer = mockCharacterLayer(getCurrentPosition)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set(null, '#ffffff', 0.2)
    time.tick(64) // ticker を複数回まわす

    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('target 指定・表示中は毎フレーム getCurrentPosition(target) に現在座標を問い合わせる', () => {
    const getCurrentPosition = vi.fn(() => ({ x: 123, y: 45 }))
    const characterLayer = mockCharacterLayer(getCurrentPosition)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set('alice', '#ffffff', 0.2)
    time.tick(48) // 16ms ticker を3回分進める

    expect(getCurrentPosition).toHaveBeenCalledWith('alice', { excludeExiting: true })
    expect(getCurrentPosition.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('target 指定だが現在未表示（getCurrentPosition が null を返す）でも例外を投げず稼働を継続する', () => {
    const characterLayer = mockCharacterLayer(() => null)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set('ghost', '#ffffff', 0.2)
    expect(() => time.tick(64)).not.toThrow()
    // state 自体は消えず点灯し続ける（フォールバックは座標だけの話、消灯はしない）。
    expect(layer.getState()).toEqual({ target: 'ghost', color: '#ffffff', radius: 0.2 })
  })

  it('表示中だったキャラが途中で退場（null 返却に切り替わる）しても例外を投げず稼働を継続する', () => {
    let visible = true
    const characterLayer = mockCharacterLayer(() => (visible ? { x: 10, y: 20 } : null))
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    visible = false // 退場完了で CharacterLayer の Map から削除された状態を模す
    expect(() => time.tick(32)).not.toThrow()
    expect(layer.getState()?.target).toBe('alice')
  })
})

describe('radius / color の境界値 (#693)', () => {
  it('radius の負値境界（-0.1→0 / 0 / 0.1）は Math.max(0, r) でクランプされる', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '#ffffff', -0.1)
    expect(layer.getState()?.radius).toBe(0)
    layer.set(null, '#ffffff', 0)
    expect(layer.getState()?.radius).toBe(0)
    layer.set(null, '#ffffff', 0.1)
    expect(layer.getState()?.radius).toBe(0.1)
  })

  it('radius の非有限値（NaN/Infinity）は 0 ではなく既定 0.2 にフォールバックする（0クランプと非対称）', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '#ffffff', NaN)
    expect(layer.getState()?.radius).toBe(0.2)
    layer.set(null, '#ffffff', Infinity)
    expect(layer.getState()?.radius).toBe(0.2)
  })

  it('color の空文字は白 (#ffffff) にフォールバックする', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '', 0.2)
    expect(layer.getState()?.color).toBe('#ffffff')
  })
})

describe('状態遷移・復元 / ticker 管理 (#693)', () => {
  it('clear() で getState() が null になり、ticker(tickerId) も停止する', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '#ffffff', 0.2)
    expect(internals(layer).tickerId).not.toBeNull()

    layer.clear()
    expect(layer.getState()).toBeNull()
    expect(internals(layer).tickerId).toBeNull()
  })

  it('restore(null) は消灯として、restore(state) は点灯として振る舞う（宣言的復元）', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.restore({ target: 'bob', color: '#123456', radius: 0.4 })
    expect(layer.getState()).toEqual({ target: 'bob', color: '#123456', radius: 0.4 })

    layer.restore(null)
    expect(layer.getState()).toBeNull()
    expect(internals(layer).tickerId).toBeNull()
  })

  it('点灯中に複数回 set() を呼んでも ticker は多重起動しない（同じ id のまま）', () => {
    const time = virtualTime()
    const setIntervalSpy = vi.spyOn(time, 'setInterval')
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), time)

    layer.set(null, '#ff0000', 0.2)
    const tickerIdAfterFirst = internals(layer).tickerId
    layer.set(null, '#00ff00', 0.3) // 既に点灯中 → ensureTicker は早期 return するはず
    layer.set('someone', '#0000ff', 0.4)

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(internals(layer).tickerId).toBe(tickerIdAfterFirst)
  })

  it('clear() 後に再び set() すると新しい ticker が起動する（消灯→再点灯で id が発行し直される）', () => {
    const time = virtualTime()
    const setIntervalSpy = vi.spyOn(time, 'setInterval')
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), time)

    layer.set(null, '#ffffff', 0.2)
    layer.clear()
    layer.set(null, '#ffffff', 0.2)

    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    expect(internals(layer).tickerId).not.toBeNull()
  })
})

describe('対象不在時の光の位置 (#992)', () => {
  const CENTER = { x: SCREEN_W / 2, y: SCREEN_H / 2 }

  function setup(initial: { x: number; y: number } | null) {
    const ref = { pos: initial }
    const characterLayer = mockCharacterLayer(() => (ref.pos ? { ...ref.pos } : null))
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)
    return { ref, time, layer }
  }

  it('先に光: 対象が未登場の間は中央、登場したら追従を始める', () => {
    const { ref, time, layer } = setup(null)
    layer.set('alice', '#ffffff', 0.2)
    time.tick(32)
    expect(layer.getLightPosition()).toEqual(CENTER)
    ref.pos = { x: 100, y: 50 }
    time.tick(16)
    expect(layer.getLightPosition()).toEqual({ x: 100, y: 50 })
    ref.pos = { x: 120, y: 60 }
    time.tick(16)
    expect(layer.getLightPosition()).toEqual({ x: 120, y: 60 })
  })

  it('退場後: 最後にいた位置に光が残り、自動では消えない', () => {
    const { ref, time, layer } = setup({ x: 100, y: 50 })
    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    ref.pos = { x: 700, y: 40 }
    time.tick(16)
    ref.pos = null
    time.tick(160)
    expect(layer.getLightPosition()).toEqual({ x: 700, y: 40 })
    expect(layer.getState()).not.toBeNull()
  })

  it('再登場: 退場後に同じ対象が戻ると再び追従する', () => {
    const { ref, time, layer } = setup({ x: 100, y: 50 })
    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    ref.pos = null
    time.tick(32)
    ref.pos = { x: 300, y: 200 }
    time.tick(16)
    expect(layer.getLightPosition()).toEqual({ x: 300, y: 200 })
  })

  it('光だけ: 対象なしは中央固定', () => {
    const { time, layer } = setup({ x: 1, y: 2 })
    layer.set(null, '#ffffff', 0.2)
    time.tick(48)
    expect(layer.getLightPosition()).toEqual(CENTER)
  })

  it('消灯: clear() のみで消える（位置も null）', () => {
    const { ref, time, layer } = setup({ x: 100, y: 50 })
    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    ref.pos = null
    time.tick(32)
    layer.clear()
    expect(layer.getState()).toBeNull()
    expect(layer.getLightPosition()).toBeNull()
  })

  it('復元: 対象不在なら最後の位置は不明なので中央にフォールバックし、登場すれば追従する', () => {
    const { ref, time, layer } = setup(null)
    layer.restore({ target: 'alice', color: '#ffffff', radius: 0.2 })
    expect(layer.getLightPosition()).toEqual(CENTER)
    ref.pos = { x: 10, y: 20 }
    time.tick(16)
    expect(layer.getLightPosition()).toEqual({ x: 10, y: 20 })
  })

  it('別の [スポットライト:] で点け直すと、前の対象の最後の位置は引き継がない', () => {
    const { ref, time, layer } = setup({ x: 100, y: 50 })
    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    ref.pos = null
    time.tick(16)
    layer.set('bob', '#ffffff', 0.2)
    expect(layer.getLightPosition()).toEqual(CENTER)
  })
})

describe('点け直しでの最後の位置の扱い (#992)', () => {
  const CENTER = { x: SCREEN_W / 2, y: SCREEN_H / 2 }
  function remain() {
    const ref = { pos: { x: 100, y: 50 } as { x: number; y: number } | null }
    const time = virtualTime()
    const layer = new LightingLayer(
      SCREEN_W,
      SCREEN_H,
      mockCharacterLayer(() => ref.pos),
      time
    )
    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    ref.pos = null
    time.tick(32)
    return { layer, time, ref }
  }

  it('同じ対象のまま色・半径を書き直しても、残っている光の位置を保つ', () => {
    const { layer } = remain()
    layer.set('alice', '#ff0000', 0.4)
    expect(layer.getLightPosition()).toEqual({ x: 100, y: 50 })
  })

  it('消灯後の点け直しでは位置を破棄する（対象不在なら中央）', () => {
    const { layer } = remain()
    layer.clear()
    layer.set('alice', '#ffffff', 0.2)
    expect(layer.getLightPosition()).toEqual(CENTER)
  })

  it('対象を null（光だけ）に変えると位置を破棄して中央になる', () => {
    const { layer } = remain()
    layer.set(null, '#ffffff', 0.2)
    expect(layer.getLightPosition()).toEqual(CENTER)
  })

  it('restore() は同じ対象でも位置を引き継がず、対象不在なら中央にする', () => {
    const { layer } = remain()
    layer.restore({ target: 'alice', color: '#ffffff', radius: 0.2 })
    expect(layer.getLightPosition()).toEqual(CENTER)
  })
})

describe('実 CharacterLayer との結合 (#992)', () => {
  it('即時退場: 退場直前の位置に光が残り、同じキャラが再登場すると追従を再開する', () => {
    const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    expect(layer.getLightPosition()).toEqual({ x: SCREEN_W / 2, y: SCREEN_H / 2 }) // 先に光（未登場）

    chars.show('hero', 'normal', '右', '/assets', { instant: true })
    time.tick(16)
    const onStage = chars.getCurrentPosition('hero')!
    expect(layer.getLightPosition()).toEqual(onStage)

    chars.remove('hero', { instant: true })
    time.tick(32)
    expect(chars.getCurrentPosition('hero')).toBeNull()
    expect(layer.getLightPosition()).toEqual(onStage) // 退場後も最後の位置

    chars.show('hero', 'normal', '左', '/assets', { instant: true })
    time.tick(16)
    const again = chars.getCurrentPosition('hero')!
    expect(again.x).not.toBe(onStage.x)
    expect(layer.getLightPosition()).toEqual(again)
  })

  it('フェード退場: 退場アニメ中は追従し、削除完了後はその最後の位置に残る', async () => {
    vi.useFakeTimers()
    try {
      const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
      const time = virtualTime()
      const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
      chars.show('hero', 'normal', '中央', '/assets', { instant: true })
      layer.set('hero', '#ffffff', 0.2)
      time.tick(16)
      const before = chars.getCurrentPosition('hero')!
      chars.remove('hero')
      await vi.advanceTimersByTimeAsync(5000)
      time.tick(32)
      expect(chars.getCurrentPosition('hero')).toBeNull() // 前提: 退場完了で Map から消えた
      expect(layer.getLightPosition()).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('歩行退場: 退場中は追従を更新せず、立っていた位置に残る（画面外に出ない・完了後も同じ）', () => {
    const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
    chars.show('hero', 'normal', '右', '/assets', { instant: true })
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    const standing = chars.getCurrentPosition('hero')!
    expect(layer.getLightPosition()).toEqual(standing)

    chars.remove('hero', { exitDirection: 'Shimote' })
    const internal = chars as unknown as {
      animTicker: { update: () => void } | null
      elapsedMs: number
    }
    const walked = (ms: number) => {
      internal.elapsedMs += ms
      internal.animTicker?.update()
      time.tick(16)
    }
    walked(700) // 歩行の途中: sprite は動いているが光は動かない
    expect(chars.getCurrentPosition('hero')!.x).not.toBe(standing.x)
    expect(layer.getLightPosition()).toEqual(standing)
    walked(2000) // 歩行完了（Map から削除）
    expect(chars.getCurrentPosition('hero')).toBeNull()
    const p = layer.getLightPosition()!
    expect(p).toEqual(standing)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x).toBeLessThanOrEqual(SCREEN_W)
  })

  describe('退場開始の位置を同期で確定する（スキップ相当・tick を回さない）', () => {
    it('同じ同期区間の「show → 即時 remove」でも、光は登場位置に残る（点灯時は未登場）', () => {
      const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
      const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, virtualTime())
      layer.set('hero', '#ffffff', 0.2) // 未登場 → 中央
      chars.show('hero', 'normal', '右', '/assets', { instant: true })
      const standing = chars.getCurrentPosition('hero')!
      chars.remove('hero', { instant: true })
      expect(layer.getLightPosition()).toEqual(standing)
      expect(standing.x).not.toBe(SCREEN_W / 2)
    })

    it('同じ同期区間の「位置変更 → 即時 remove」でも、光は変更後の位置に残る', () => {
      const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
      const time = virtualTime()
      const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
      chars.show('hero', 'normal', '左', '/assets', { instant: true })
      layer.set('hero', '#ffffff', 0.2)
      time.tick(16)
      const left = chars.getCurrentPosition('hero')!
      chars.show('hero', 'normal', '右', '/assets', { instant: true })
      const right = chars.getCurrentPosition('hero')!
      expect(right.x).not.toBe(left.x)
      chars.remove('hero', { instant: true }) // tick は回さない
      expect(layer.getLightPosition()).toEqual(right)
    })

    it('別のキャラの退場には反応しない', () => {
      const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
      const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, virtualTime())
      layer.set('hero', '#ffffff', 0.2)
      chars.show('other', 'normal', '右', '/assets', { instant: true })
      chars.remove('other', { instant: true })
      expect(layer.getLightPosition()).toEqual({ x: SCREEN_W / 2, y: SCREEN_H / 2 })
    })
  })

  it('入場の歩行中に方向未指定で退場しても、光は退場開始時点の位置に残る', () => {
    const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
    layer.set('hero', '#ffffff', 0.2)
    chars.show('hero', 'normal', '右', '/assets', { enterDirection: 'Kamite' })
    const internal = chars as unknown as {
      animTicker: { update: () => void } | null
      elapsedMs: number
    }
    internal.elapsedMs += 500
    internal.animTicker?.update()
    time.tick(16)
    const mid = chars.getCurrentPosition('hero')!
    chars.remove('hero') // 方向未指定 → フェード退場（x は凍結）
    time.tick(64)
    expect(layer.getLightPosition()).toEqual(mid)
  })

  it('退場フェード中に同じキャラが再 show されたら、追従を再開する', () => {
    const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
    chars.show('hero', 'normal', '左', '/assets', { instant: true })
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    const left = chars.getCurrentPosition('hero')!
    chars.remove('hero') // フェード退場開始（Map には残る）
    time.tick(32)
    expect(layer.getLightPosition()).toEqual(left)
    chars.show('hero', 'normal', '右', '/assets', { instant: true })
    time.tick(16)
    const right = chars.getCurrentPosition('hero')!
    expect(right.x).not.toBe(left.x)
    expect(layer.getLightPosition()).toEqual(right)
  })

  it('歩行退場の途中で再度 remove（即時）されても、光は最初の退場開始位置のまま', () => {
    const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
    chars.show('hero', 'normal', '右', '/assets', { instant: true })
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    const standing = chars.getCurrentPosition('hero')!
    chars.remove('hero', { exitDirection: 'Shimote' })
    const internal = chars as unknown as {
      animTicker: { update: () => void } | null
      elapsedMs: number
    }
    internal.elapsedMs += 700
    internal.animTicker?.update()
    expect(chars.getCurrentPosition('hero')!.x).not.toBe(standing.x)
    chars.remove('hero', { instant: true }) // 退場中の再 remove（スキップ等）
    expect(layer.getLightPosition()).toEqual(standing)
  })
})

describe('split_layout との位置の一致 (#1000)', () => {
  const REGION = { x: 0, y: 0, width: SCREEN_W / 2, height: SCREEN_H }
  /** split の変換（`p' = s*p + t`）を独立に再計算する期待値。 */
  const expected = (local: { x: number; y: number }) => {
    const s = Math.min(REGION.width / SCREEN_W, REGION.height / SCREEN_H)
    const tx = REGION.x + (REGION.width - SCREEN_W * s) / 2
    const ty = REGION.y + (REGION.height - SCREEN_H * s) / 2
    return { x: s * local.x + tx, y: s * local.y + ty }
  }
  function setup() {
    const chars = new CharacterLayer(SCREEN_W, SCREEN_H)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, chars, time)
    chars.show('hero', 'normal', '右', '/assets', { instant: true })
    return { chars, time, layer }
  }

  it('split 無効なら従来どおりローカル座標のまま、有効なら立ち絵の stage 座標（split 変換後）に一致する', () => {
    const { chars, time, layer } = setup()
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    const local = chars.getCurrentPosition('hero')!
    expect(layer.getLightPosition()).toEqual(local)

    chars.setSplitLayoutRegion(REGION)
    time.tick(16)
    const pos = layer.getLightPosition()!
    expect(pos).toEqual(expected(local))
    expect(pos.x).not.toBe(local.x) // 変換が実際に効いている
    // 立ち絵の実位置（Container の scale/position を掛けた stage 座標）とも一致する
    const st = (
      chars as unknown as {
        characters: Map<string, { sprite: { x: number; y: number; height: number } }>
      }
    ).characters.get('hero')!
    const g = chars.toGlobal({ x: st.sprite.x, y: st.sprite.y - st.sprite.height / 2 })
    expect(pos.x).toBeCloseTo(g.x)
    expect(pos.y).toBeCloseTo(g.y)
  })

  it('ズーム（Container の scale/position）が掛かっても、光に渡す座標はズーム適用前の stage 座標（光自身の Container がズームを掛ける）', () => {
    const { chars, time, layer } = setup()
    chars.setSplitLayoutRegion(REGION)
    chars.setZoomPose({ scale: 2, x: -50, y: -20 })
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    expect(layer.getLightPosition()).toEqual(expected(chars.getCurrentPosition('hero')!))
  })

  it('対象が退場しても、最後の位置は split の切替・一時解除に追従して立ち絵の最後の位置に残る', () => {
    const { chars, time, layer } = setup()
    chars.setSplitLayoutRegion(REGION)
    layer.set('hero', '#ffffff', 0.2)
    time.tick(16)
    const local = chars.getCurrentPosition('hero')!
    chars.remove('hero', { instant: true })
    time.tick(32)
    expect(layer.getLightPosition()).toEqual(expected(local))

    chars.setSplitLayoutRegion(null) // タイトル画面での一時解除 (#982) / 動的な無効化
    expect(layer.getLightPosition()).toEqual(local)
    chars.setSplitLayoutRegion(REGION) // 復帰
    expect(layer.getLightPosition()).toEqual(expected(local))
  })

  it('対象不在の中央フォールバックは split 変換を受けない（従来どおり画面中央）', () => {
    const { chars, time, layer } = setup()
    chars.setSplitLayoutRegion(REGION)
    layer.set(null, '#ffffff', 0.2)
    time.tick(16)
    expect(layer.getLightPosition()).toEqual({ x: SCREEN_W / 2, y: SCREEN_H / 2 })
  })
})
