/**
 * #960: ポーズ変更 A→B の B 読み込み待ち中に instant の show(C) が来たとき、遅れて届く B の
 * texture が C を上書きしないこと。最新の意図は C。
 * 技法は CharacterLayer.poseChangeRace.test.ts と同じ（ticker 停止・仮想時間・Assets.load 保留）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Assets, BufferImageSource, PerspectiveMesh, Sprite, Texture, Ticker } from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'
import { TimeController } from './TimeController'

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface StateLike {
  sprite: Sprite
  expression: string
  position: string
  snapshotHidden?: boolean
  attached?: boolean
  flipAnimation?: { role: 'out' | 'in'; startMs: number }
  fadeAnimation: { destroyOnComplete: boolean } | null
  animation: unknown
  poseNudge: unknown
}
interface Internals {
  characters: Map<string, StateLike>
  animTicker: { update: (t?: number) => void; lastTime: number; speed: number } | null
  elapsedMs: number
}
const internals = (l: CharacterLayer): Internals => l as unknown as Internals

function advance(layer: CharacterLayer, ms: number): void {
  const i = internals(layer)
  i.elapsedMs += ms
  const t = i.animTicker
  if (t) {
    t.speed = 0
    t.update(t.lastTime + 1)
  }
}

function makeTexture(): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(40 * 80 * 4), width: 40, height: 80 }),
  })
}

interface Gate {
  promise: Promise<Texture>
  resolve: () => void
  reject: () => void
}

/** 表情ごとに保留できる Assets.load。gate していない表情は即座に解決する。 */
function installLoader(): {
  hold: (expr: string) => Gate
  textures: Map<string, Texture>
} {
  const gates = new Map<string, Gate>()
  const textures = new Map<string, Texture>()
  const textureOf = (expr: string): Texture => {
    let t = textures.get(expr)
    if (!t) {
      t = makeTexture()
      textures.set(expr, t)
    }
    return t
  }
  vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
    const m = /images\/(.+?)\.(?:webp|png)$/.exec(String(url))
    const expr = m ? m[1] : String(url)
    const gate = gates.get(expr)
    if (gate) return gate.promise
    return textureOf(expr)
  }) as never)
  return {
    textures,
    hold(expr: string): Gate {
      let resolveFn!: (t: Texture) => void
      let rejectFn!: (e: unknown) => void
      const promise = new Promise<Texture>((res, rej) => {
        resolveFn = res
        rejectFn = rej
      })
      const gate: Gate = {
        promise,
        resolve: () => resolveFn(textureOf(expr)),
        reject: () => rejectFn(new Error('404')),
      }
      gates.set(expr, gate)
      return gate
    },
  }
}

const chars = (l: CharacterLayer): Map<string, StateLike> => internals(l).characters

async function settle(layer: CharacterLayer): Promise<void> {
  await flushPromises()
  for (let i = 0; i < 6; i++) advance(layer, 1000)
  await flushPromises()
}

describe.each(['Theater', 'Novel'] as const)('#960 instant show と遅着 texture [%s]', (mode) => {
  let loader: ReturnType<typeof installLoader>
  let layer: CharacterLayer

  beforeEach(() => {
    vi.spyOn(Ticker.prototype, 'start').mockImplementation(() => {})
    loader = installLoader()
    const time = new TimeController()
    time.setMode('virtual')
    layer = new CharacterLayer(800, 450, time)
    layer.setCharacterFadeMs(1000)
    layer.setCamera(mode, 'Front' as never, null)
  })
  afterEach(() => {
    layer.destroy({ children: true })
    vi.restoreAllMocks()
  })

  async function showA(): Promise<void> {
    layer.show('hero', 'a', '中央', '/assets', { instant: true })
    await flushPromises()
  }

  /** 画面に出ている（親に attach 済み）hero 系 sprite の texture 一覧。 */
  function nameOf(t: Texture): string {
    for (const [k, v] of loader.textures) if (v === t) return k
    return '(empty/unknown)'
  }
  function visibleTextures(): string[] {
    return layer.children
      .filter((c): c is Sprite => c instanceof Sprite)
      .map((s) => nameOf(s.texture))
  }

  it('B 読み込み中に instant C → B 到着。画面に出る hero は C の texture のまま', async () => {
    await showA()
    const slowB = loader.hold('b')
    layer.show('hero', 'b', '中央', '/assets', {})
    await flushPromises()
    layer.show('hero', 'c', '中央', '/assets', { instant: true })
    await flushPromises()
    expect(nameOf(chars(layer).get('hero')!.sprite.texture)).toBe('c')

    slowB.resolve()
    await settle(layer)

    const st = chars(layer).get('hero')!
    expect(st.expression).toBe('c')
    expect(nameOf(st.sprite.texture)).toBe('c')
    expect(visibleTextures()).toEqual(['c'])
  })

  it('C が通常フェードのとき: B 到着後も最終は C', async () => {
    await showA()
    const slowB = loader.hold('b')
    layer.show('hero', 'b', '中央', '/assets', {})
    await flushPromises()
    layer.show('hero', 'c', '中央', '/assets', {})
    await flushPromises()
    slowB.resolve()
    await settle(layer)

    const st = chars(layer).get('hero')!
    expect(st.expression).toBe('c')
    expect(nameOf(st.sprite.texture)).toBe('c')
    expect(visibleTextures()).toEqual(['c'])
  })

  it('instant C の後に B が失敗: 最終は C（A に巻き戻らない・C が消えない）', async () => {
    await showA()
    const slowB = loader.hold('b')
    layer.show('hero', 'b', '中央', '/assets', {})
    await flushPromises()
    layer.show('hero', 'c', '中央', '/assets', { instant: true })
    await flushPromises()
    slowB.reject()
    await settle(layer)

    const st = chars(layer).get('hero')
    expect(st?.expression).toBe('c')
    expect(st?.sprite.destroyed).toBe(false)
    expect(nameOf(st!.sprite.texture)).toBe('c')
    expect(visibleTextures()).toEqual(['c'])
  })
})
