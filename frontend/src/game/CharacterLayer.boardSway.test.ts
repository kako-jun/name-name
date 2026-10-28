/**
 * CharacterLayer の板の揺らぎ配線 (#701) のテスト。
 * 上手/下手の歩行 tween 中だけ sprite.skew.x が揺れ、シアター限定・書き出し・reduced-motion・
 * 移動終了/取り消し/破棄後は 0 に戻ることを縛る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Assets } from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'
import { BOARD_SWAY_MAX_SKEW_RAD, BOARD_SWAY_PERIOD_MS } from './boardSway'

interface Internals {
  characters: Map<
    string,
    {
      sprite: { skew: { x: number }; x: number; destroyed: boolean; filters: unknown }
      stageMotion?: unknown
    }
  >
  animTicker: { update: () => void } | null
  elapsedMs: number
}

const internals = (l: CharacterLayer) => l as unknown as Internals
const skewOf = (l: CharacterLayer) => internals(l).characters.get('hero')!.sprite.skew.x

/** 揺れが出る時刻（四半周期）まで進めて 1 フレーム更新する。 */
function advanceTo(layer: CharacterLayer, ms: number): void {
  const i = internals(layer)
  i.elapsedMs = ms
  i.animTicker?.update()
}

function mockTexture(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue({
    width: 200,
    height: 400,
    source: { scaleMode: 'linear' },
  } as never)
}

async function enterWalking(theater: boolean): Promise<CharacterLayer> {
  mockTexture()
  const layer = new CharacterLayer(800, 450)
  if (theater) layer.setCamera('Theater', 'Audience', null)
  layer.show('hero', 'normal', '中央', '/assets', { enterDirection: 'Kamite' })
  await new Promise((r) => setTimeout(r, 0))
  expect(internals(layer).characters.get('hero')!.stageMotion).toBeTruthy()
  return layer
}

const QUARTER = BOARD_SWAY_PERIOD_MS / 4

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CharacterLayer 板の揺らぎ (#701)', () => {
  it('シアター: 入場walk中は skew.x が揺れ、上限を超えない', async () => {
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    let seen = 0
    for (let t = 50; t < 1400; t += 50) {
      advanceTo(layer, base + t)
      const v = skewOf(layer)
      expect(Math.abs(v)).toBeLessThanOrEqual(BOARD_SWAY_MAX_SKEW_RAD + 1e-12)
      seen = Math.max(seen, Math.abs(v))
    }
    expect(seen).toBeGreaterThan(0.01)
  })

  it('シアター: 入場walkが終わると skew.x は 0 に戻り最終位置に静止する', async () => {
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    advanceTo(layer, base + 1500)
    const st = internals(layer).characters.get('hero')!
    expect(st.stageMotion).toBeNull()
    expect(st.sprite.skew.x).toBe(0)
    expect(st.sprite.x).toBe(400)
  })

  it('シアター: 退場walk中も揺れ、完了で state ごと消える', async () => {
    mockTexture()
    const layer = new CharacterLayer(800, 450)
    layer.setCamera('Theater', 'Audience', null)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.remove('hero', { exitDirection: 'Shimote' })
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    advanceTo(layer, base + 1500)
    expect(internals(layer).characters.has('hero')).toBe(false)
  })

  it('ノベル: 入場walk中も skew.x は常に 0（後方互換）', async () => {
    const layer = await enterWalking(false)
    const base = internals(layer).elapsedMs
    for (let t = 50; t < 1400; t += 50) {
      advanceTo(layer, base + t)
      expect(skewOf(layer)).toBe(0)
    }
  })

  it('シアター→ノベルに戻すと以後は揺れない', async () => {
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    layer.setCamera('Novel', 'Audience', null)
    advanceTo(layer, base + 700 + QUARTER * 3)
    expect(skewOf(layer)).toBe(0)
  })

  it('書き出し中は揺れない（始まる前の揺れも 0 に戻す）', async () => {
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    layer.setExporting(true)
    expect(skewOf(layer)).toBe(0)
    advanceTo(layer, base + 700 + QUARTER * 3)
    expect(skewOf(layer)).toBe(0)
    layer.setExporting(false)
    advanceTo(layer, base + 700 + QUARTER * 5)
    expect(skewOf(layer)).not.toBe(0)
  })

  it('prefers-reduced-motion: reduce では揺れない', async () => {
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({ matches: q.includes('prefers-reduced-motion') }),
    })
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    for (let t = 50; t < 1400; t += 50) {
      advanceTo(layer, base + t)
      expect(skewOf(layer)).toBe(0)
    }
  })

  it('instant（スキップ・復元）の登場は stageMotion 自体が無く揺れない', () => {
    mockTexture()
    const layer = new CharacterLayer(800, 450)
    layer.setCamera('Theater', 'Audience', null)
    layer.show('hero', 'normal', '中央', '/assets', {
      instant: true,
      enterDirection: 'Kamite',
    })
    const st = internals(layer).characters.get('hero')!
    expect(st.stageMotion).toBeFalsy()
    expect(st.sprite.skew.x).toBe(0)
  })

  it('walk中に同キャラが再 show されて tween が取り消されたら skew.x は 0', async () => {
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    const old = internals(layer).characters.get('hero')!
    layer.show('hero', 'normal', '左', '/assets') // 位置が変わる再 show は歩行をスナップして取り消す
    expect(old.sprite.skew.x).toBe(0)
    expect(skewOf(layer)).toBe(0)
  })

  it('walk中に方向未指定の退場（フェード）へ切り替わったら skew.x は 0', async () => {
    const layer = await enterWalking(true)
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    layer.remove('hero')
    expect(skewOf(layer)).toBe(0)
  })

  it('紙人形輪郭フィルタと共存する（揺れ中も filters が保たれる）', async () => {
    const layer = await enterWalking(true)
    layer.setPaperDollOutline({ color: 0xffffff, thickness: 4 } as never)
    const before = internals(layer).characters.get('hero')!.sprite.filters
    expect(before).toBeTruthy()
    const base = internals(layer).elapsedMs
    advanceTo(layer, base + 700 + QUARTER)
    expect(skewOf(layer)).not.toBe(0)
    expect(internals(layer).characters.get('hero')!.sprite.filters).toBe(before)
  })
})
