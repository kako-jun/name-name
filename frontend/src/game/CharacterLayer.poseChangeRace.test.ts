/**
 * CharacterLayer の同一人物ポーズ変更と読み込み待ち (#952) の回帰テスト。
 *
 * 設計: ポーズ変更の要求では texture の読み込みだけを行い、読み込み待ちの間は新ポーズの state を作らない。
 * 旧ポーズ A は `hero` キーのまま残り、読み込み完了時に「要求が最新」かつ「A が健在で退場中でない」場合
 * だけ同期的に旧→新の遷移（ノベルはクロスフェード #337 / シアターは板フリップ #707）を始める。
 *
 * Assets.load を表情ごとに保留・解放・失敗できるモックにして、読み込みの速い/遅いを再現する。
 * 時間は boardFlip.test.ts と同じく Ticker.start を止め、advance で仮想時間だけを進める。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Assets, BufferImageSource, PerspectiveMesh, Sprite, Texture, Ticker } from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface StateLike {
  sprite: Sprite
  expression: string
  position: string
  snapshotHidden?: boolean
  attached?: boolean
  flipAnimation?: { role: 'out' | 'in' }
  fadeAnimation: { destroyOnComplete: boolean } | null
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

function meshCount(layer: CharacterLayer): number {
  return layer.children.filter((c) => c instanceof PerspectiveMesh).length
}
function spriteCount(layer: CharacterLayer): number {
  return layer.children.filter((c) => c instanceof Sprite).length
}
function transitionKeys(layer: CharacterLayer): string[] {
  return [...internals(layer).characters.keys()].filter((k) => k.includes('__transition_'))
}
const chars = (l: CharacterLayer): Map<string, StateLike> => internals(l).characters

/** 時間を十分に進めて、遷移が全部終わった状態にする。 */
async function settle(layer: CharacterLayer): Promise<void> {
  await flushPromises()
  for (let i = 0; i < 6; i++) advance(layer, 1000)
  await flushPromises()
}

/** 最終状態: hero だけが可視・不透明・正面で、旧板も mesh も残っていない。 */
function expectSettledTo(layer: CharacterLayer, expr: string): void {
  expect([...chars(layer).keys()]).toEqual(['hero'])
  const st = chars(layer).get('hero')!
  expect(st.expression).toBe(expr)
  expect(st.sprite.visible).toBe(true)
  expect(st.sprite.alpha).toBe(1)
  expect(st.snapshotHidden).toBeFalsy()
  expect(st.sprite.parent).toBe(layer)
  expect(meshCount(layer)).toBe(0)
  expect(spriteCount(layer)).toBe(1)
}

/** show を呼び、その onReady 発火回数を数える。 */
function showCounted(
  layer: CharacterLayer,
  expr: string,
  opts: { position?: string; instant?: boolean; name?: string } = {}
): { count: () => number } {
  let n = 0
  layer.show(opts.name ?? 'hero', expr, opts.position ?? '中央', '/assets', {
    instant: opts.instant,
    onReady: () => {
      n += 1
    },
  })
  return { count: () => n }
}

describe.each(['Theater', 'Novel'] as const)(
  'CharacterLayer ポーズ変更と読み込み待ち (#952) [%s]',
  (mode) => {
    let loader: ReturnType<typeof installLoader>
    let layer: CharacterLayer

    beforeEach(() => {
      vi.spyOn(Ticker.prototype, 'start').mockImplementation(() => {})
      loader = installLoader()
      layer = new CharacterLayer(800, 450)
      layer.setCharacterFadeMs(1000)
      layer.setCamera(mode, 'Front' as never, null)
    })
    afterEach(() => {
      layer.destroy({ children: true })
      vi.restoreAllMocks()
    })

    async function showA(expr = 'a'): Promise<StateLike> {
      layer.show('hero', expr, '中央', '/assets', { instant: true })
      await flushPromises()
      return chars(layer).get('hero')!
    }

    it('Issue 再現: a(instant) → 遅い b → c → b 解放。b の読み込み完了で a が残らず、最終的に c だけになる', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      await flushPromises()
      // 読み込み待ちの間は state を作らない。A は hero のまま見えている。
      expect(chars(layer).get('hero')).toBe(a)
      expect(transitionKeys(layer)).toEqual([])
      expect(a.sprite.visible).toBe(true)
      expect(a.snapshotHidden).toBeFalsy()
      expect(rb.count()).toBe(0)

      const rc = showCounted(layer, 'c')
      await flushPromises()
      // c は読み込み済みなので A→C の遷移が始まる。
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(transitionKeys(layer)).toHaveLength(1)
      expect(rc.count()).toBe(1)

      slowB.resolve()
      await flushPromises()
      // b の結果は捨てられる（遷移が増えない・hero が c のまま）。onReady は 1 回。
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(transitionKeys(layer)).toHaveLength(1)
      expect(rb.count()).toBe(1)

      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('①a: A→B(遅い)→C(速い) と ①b: A→B(速い)→C(遅い) のどちらも最終的に C だけが残り、A も B も正面に残らない', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')

      // ①b: B が先に遷移を始め、C の読み込みが遅い。
      const slowD = loader.hold('d')
      const rb = showCounted(layer, 'e')
      await flushPromises()
      const e = chars(layer).get('hero')!
      expect(e.expression).toBe('e')
      const rd = showCounted(layer, 'd')
      await flushPromises()
      // d 待ちの間も e が hero のまま（旧 c は遷移中のスナップショット）。
      expect(chars(layer).get('hero')).toBe(e)
      advance(layer, 400)
      slowD.resolve()
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('d')
      expect(rb.count()).toBe(1)
      expect(rd.count()).toBe(1)
      await settle(layer)
      expect(e.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'd')
    })

    it('同一 tick の連続 show（[登場: hero/b] → [登場: hero/c]）で A→C の遷移が 1 回だけ起き、B は一度も現れない', async () => {
      const a = await showA()
      const rb = showCounted(layer, 'b')
      const rc = showCounted(layer, 'c')
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(transitionKeys(layer)).toHaveLength(1)
      expect(chars(layer).get(transitionKeys(layer)[0])).toBe(a)
      if (mode === 'Theater') {
        expect(a.flipAnimation?.role).toBe('out')
        expect(chars(layer).get('hero')!.flipAnimation?.role).toBe('in')
        expect(meshCount(layer)).toBe(2)
      }
      expect(rb.count()).toBe(1)
      expect(rc.count()).toBe(1)
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('②場面転換: 読み込み待ち中の clearForSceneTransition は A に作用し、遅れて届いた B は捨てられる。次の場面の show は新規登場', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      await flushPromises()
      layer.clearForSceneTransition()
      expect(a.fadeAnimation?.destroyOnComplete).toBe(true)
      slowB.resolve()
      await flushPromises()
      // B は退場中の A には適用されない。
      expect(chars(layer).get('hero')).toBe(a)
      expect(transitionKeys(layer)).toEqual([])
      expect(rb.count()).toBe(1)
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)

      // 次の場面での登場は新規。
      layer.show('hero', 'c', '中央', '/assets')
      await flushPromises()
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('②b: 場面転換をはさんでも、転換前の遅い B が転換後の新規登場 C を上書きしない', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      layer.clearForSceneTransition(0)
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      showCounted(layer, 'c', { instant: true })
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('③位置変更: A(左) → B(中央・遅い) → A と同じ姿で左 は no-op で、B は捨てられ A が左のまま残る', async () => {
      layer.show('hero', 'a', '左', '/assets', { instant: true })
      await flushPromises()
      const a = chars(layer).get('hero')!
      const x0 = a.sprite.x
      const slowB = loader.hold('b')
      showCounted(layer, 'b', { position: '中央' })
      const back = showCounted(layer, 'a', { position: '左' })
      expect(back.count()).toBe(1)
      slowB.resolve()
      await flushPromises()
      expect(chars(layer).get('hero')).toBe(a)
      expect(transitionKeys(layer)).toEqual([])
      expect(a.sprite.x).toBe(x0)
      await settle(layer)
      expect(chars(layer).get('hero')).toBe(a)
      expect(a.sprite.visible).toBe(true)
      expect(a.sprite.alpha).toBe(1)
      expect(meshCount(layer)).toBe(0)
    })

    it('③b: A(左) と別キャラ X(中央) がいて、hero が B(中央・遅い) → C(左) と変えても X は退場させられず、A→C だけが起きる', async () => {
      layer.show('hero', 'a', '左', '/assets', { instant: true })
      layer.show('x', 'x1', '中央', '/assets', { instant: true })
      await flushPromises()
      const x = chars(layer).get('x')!
      const slowB = loader.hold('b')
      showCounted(layer, 'b', { position: '中央' })
      showCounted(layer, 'c', { position: '左' })
      await flushPromises()
      slowB.resolve()
      await flushPromises()
      // B は現れなかったので、中央の X を押しのけない。
      expect(chars(layer).get('x')).toBe(x)
      expect(x.fadeAnimation).toBeNull()
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(chars(layer).get('hero')!.position).toBe('left')
      await settle(layer)
      expect([...chars(layer).keys()].sort()).toEqual(['hero', 'x'])
    })

    it('③c: 自キャラの旧ポーズは衝突退場の対象にならない（A(左) → B(中央) が現れる遷移でも A は遷移の旧板として扱われる）', async () => {
      layer.show('hero', 'a', '中央', '/assets', { instant: true })
      await flushPromises()
      const a = chars(layer).get('hero')!
      showCounted(layer, 'b', { position: '中央' })
      await flushPromises()
      expect(chars(layer).get(transitionKeys(layer)[0])).toBe(a)
      await settle(layer)
      expectSettledTo(layer, 'b')
    })

    it('④戻し: A → B(遅い) → A。B の読み込み完了で A が回ったり消えたりせず、A のまま', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      const ra = showCounted(layer, 'a')
      expect(ra.count()).toBe(1)
      slowB.resolve()
      await flushPromises()
      expect(rb.count()).toBe(1)
      expect(chars(layer).get('hero')).toBe(a)
      expect(transitionKeys(layer)).toEqual([])
      expect(meshCount(layer)).toBe(0)
      expect(a.sprite.visible).toBe(true)
      await settle(layer)
      expect(chars(layer).get('hero')).toBe(a)
      expectSettledTo(layer, 'a')
    })

    it('⑤初登場の読み込み待ち中にポーズ変更: A 未表示のまま B が現れ、遅れて届いた A は復活せず、最終的に B だけになる', async () => {
      const slowA = loader.hold('a')
      const ra = showCounted(layer, 'a')
      await flushPromises()
      const a = chars(layer).get('hero')!
      expect(a.sprite.parent).toBeNull() // 未 attach
      const rb = showCounted(layer, 'b')
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('b')
      expect(rb.count()).toBe(1)
      slowA.resolve()
      await flushPromises()
      expect(ra.count()).toBe(1)
      expect(a.sprite.parent).toBeNull() // 入場フェードで復活していない
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'b')
    })

    it('⑥a: 読み込み待ち中の [退場](instant) で A が消え、遅れて届いた B は現れない。その後の再登場は新規', async () => {
      await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero', { instant: true })
      expect(chars(layer).size).toBe(0)
      slowB.resolve()
      await flushPromises()
      expect(rb.count()).toBe(1)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)

      showCounted(layer, 'c')
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('⑥b: 読み込み待ち中の [退場](フェード) 中に B が届いても、退場中の A は B に置き換わらずそのまま消える', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero')
      expect(a.fadeAnimation?.destroyOnComplete).toBe(true)
      slowB.resolve()
      await flushPromises()
      expect(rb.count()).toBe(1)
      expect(transitionKeys(layer)).toEqual([])
      expect(chars(layer).get('hero')).toBe(a)
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)
    })

    it('⑥c: 読み込み待ち中の [退場](フェード) → 同ポーズ以外で再登場すると、退場が取り消され A→C の遷移で C だけが残る', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero')
      const rc = showCounted(layer, 'c')
      await flushPromises()
      expect(rc.count()).toBe(1)
      expect(chars(layer).get('hero')!.expression).toBe('c')
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('⑥d: 読み込み待ち中の [退場](instant) → 再登場(新規・遅い) → 遅れて届いた古い B は新しい hero を置き換えない', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero', { instant: true })
      const slowC = loader.hold('c')
      showCounted(layer, 'c')
      slowB.resolve()
      await flushPromises()
      const c = chars(layer).get('hero')!
      expect(c.expression).toBe('c')
      slowC.resolve()
      await settle(layer)
      expect(chars(layer).get('hero')).toBe(c)
      expectSettledTo(layer, 'c')
    })

    it('⑦読み込み失敗: A はそのまま表示され続け、onReady は 1 回。その後のポーズ変更は通常どおり通る', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rb = showCounted(layer, 'b')
      await flushPromises()
      slowB.reject()
      // 全候補失敗後の瞬断リトライ待機（LOAD_RETRY_DELAY_MS=300）を実時間で待つ。
      await new Promise((resolve) => setTimeout(resolve, 450))
      await flushPromises()
      expect(rb.count()).toBe(1)
      expect(chars(layer).get('hero')).toBe(a)
      expect(transitionKeys(layer)).toEqual([])
      expect(a.sprite.visible).toBe(true)
      expect(a.sprite.alpha).toBe(1)
      expect(meshCount(layer)).toBe(0)

      showCounted(layer, 'c')
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('⑦b: B の読み込み失敗が C の遷移後に確定しても、C には影響しない', async () => {
      await showA()
      const slowB = loader.hold('b')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rb = showCounted(layer, 'b')
      showCounted(layer, 'c')
      await flushPromises()
      slowB.reject()
      await new Promise((resolve) => setTimeout(resolve, 450))
      await settle(layer)
      expect(rb.count()).toBe(1)
      expectSettledTo(layer, 'c')
    })

    it('⑧新規 show の未 attach state が読み込み待ち中に退場フェードへ入ったら、遅れて読み込みが終わっても入場フェードで復活しない', async () => {
      const slowA = loader.hold('a')
      const ra = showCounted(layer, 'a')
      await flushPromises()
      const s = chars(layer).get('hero')!
      expect(s.sprite.parent).toBeNull()
      layer.remove('hero')
      expect(s.fadeAnimation?.destroyOnComplete).toBe(true)
      slowA.resolve()
      await flushPromises()
      expect(ra.count()).toBe(1)
      expect(s.sprite.parent).toBeNull()
      expect(s.fadeAnimation?.destroyOnComplete).toBe(true)
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)
    })

    it('⑧b: 未 attach の退場中 state を同じ姿で再 show すると退場が取り消され、通常どおり登場する', async () => {
      const slowA = loader.hold('a')
      showCounted(layer, 'a')
      await flushPromises()
      layer.remove('hero')
      showCounted(layer, 'a')
      slowA.resolve()
      await settle(layer)
      expectSettledTo(layer, 'a')
    })

    it('読み込み待ちの間も getCharacterStates は旧ポーズ A を返す（セーブが A に作用する）', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      expect(layer.getCharacterStates().map((s) => s.expression)).toEqual(['a'])
      slowB.resolve()
      await flushPromises()
      expect(layer.getCharacterStates().map((s) => s.expression)).toEqual(['b'])
      await settle(layer)
    })

    it('読み込み待ちの間は hasPendingVisualTransition が true（待機判定が読み込みを待つ）', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      expect(layer.hasPendingVisualTransition()).toBe(true)
      slowB.resolve()
      await settle(layer)
      expect(layer.hasPendingVisualTransition()).toBe(false)
    })

    it('instant の再 show(skip/復元) は読み込み待ちの古いポーズ変更を捨てる', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      showCounted(layer, 'c', { instant: true })
      slowB.resolve()
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('A→B(遅い)→C→D を矢継ぎ早に変えても最終的に D だけが残る', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      const slowC = loader.hold('c')
      const reqs = [showCounted(layer, 'b'), showCounted(layer, 'c'), showCounted(layer, 'd')]
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('d')
      slowC.resolve()
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expect(reqs.map((r) => r.count())).toEqual([1, 1, 1])
      expectSettledTo(layer, 'd')
    })
  }
)
