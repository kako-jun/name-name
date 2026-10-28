/**
 * CharacterLayer の同一人物ポーズ変更と読み込み待ち (#952) の回帰テスト。
 *
 * 設計: 新ポーズの state は show() 内で同期的に作る（キャラ名の state ＝ 最新の意図）。A→B→C と
 * 読み込み完了前に重ねると B の `.then` は最新でないため何も張らず、B が退避させた A に誰もフェード／
 * flip を張らなくなる（孤児）。最新の遷移の `.then` と `remove()` が、同キャラの孤児の旧ポーズを落とす。
 *
 * Assets.load を表情ごとに保留・解放・失敗できるモックにして、読み込みの速い/遅いを再現する。
 * 時間は boardFlip.test.ts と同じく Ticker.start を止め、advance で仮想時間だけを進める。
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
    let time: TimeController

    beforeEach(() => {
      vi.spyOn(Ticker.prototype, 'start').mockImplementation(() => {})
      loader = installLoader()
      // 読み込みリトライの待機を仮想時間で決定的に進める（実時間待ちを使わない）。
      time = new TimeController()
      time.setMode('virtual')
      layer = new CharacterLayer(800, 450, time)
      layer.setCharacterFadeMs(1000)
      layer.setCamera(mode, 'Front' as never, null)
    })
    afterEach(() => {
      layer.destroy({ children: true })
      vi.restoreAllMocks()
    })

    async function showA(expr = 'a', position = '中央'): Promise<StateLike> {
      layer.show('hero', expr, position, '/assets', { instant: true })
      await flushPromises()
      return chars(layer).get('hero')!
    }

    it('Issue 再現: a(instant) → 遅い b → c → b 解放。a が残らず最終的に c だけになる', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      // 新ポーズの state は同期で作る（キャラ名の state ＝ 最新の意図）。
      expect(chars(layer).get('hero')!.expression).toBe('b')
      expect(transitionKeys(layer)).toHaveLength(1)
      await flushPromises()
      expect(rb.count()).toBe(0)

      const rc = showCounted(layer, 'c')
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(rc.count()).toBe(1)
      // C の遷移が、B が張り損ねた旧ポーズ A を片付けた（A にフェード／flip が張られている）。
      expect(a.fadeAnimation !== null || a.flipAnimation !== undefined).toBe(true)

      slowB.resolve()
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(rb.count()).toBe(1)

      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('①: A→B→C の B/C の読み込み順の全パターンで最終的に C だけが残る', async () => {
      const a = await showA()
      // B 遅い・C 速い
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')

      // B 速い・C 遅い
      const slowD = loader.hold('d')
      const rb = showCounted(layer, 'e')
      await flushPromises()
      const e = chars(layer).get('hero')!
      const rd = showCounted(layer, 'd')
      advance(layer, 400)
      await flushPromises()
      slowD.resolve()
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('d')
      expect(rb.count()).toBe(1)
      expect(rd.count()).toBe(1)
      await settle(layer)
      expect(e.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'd')

      // B 遅い・C 遅い（C が先に届く / B が先に届く）
      for (const order of [
        ['y', 'z'],
        ['z', 'y'],
      ]) {
        const gy = loader.hold('y')
        const gz = loader.hold('z')
        const old = chars(layer).get('hero')!
        showCounted(layer, 'y')
        showCounted(layer, 'z')
        await flushPromises()
        for (const o of order) {
          ;(o === 'y' ? gy : gz).resolve()
          await flushPromises()
        }
        await settle(layer)
        expect(old.sprite.destroyed).toBe(true)
        expectSettledTo(layer, 'z')
      }
    })

    it('同一 tick の連続 show（[登場: hero/b] → [登場: hero/c]）で B は一度も現れず、最終は C だけ', async () => {
      const a = await showA()
      const rb = showCounted(layer, 'b')
      const rc = showCounted(layer, 'c')
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('c')
      expect(rb.count()).toBe(1)
      expect(rc.count()).toBe(1)
      if (mode === 'Theater') {
        expect(a.flipAnimation?.role).toBe('out')
        expect(chars(layer).get('hero')!.flipAnimation?.role).toBe('in')
      }
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('A が回っている最中に C が来ても、既に張られた A の遷移は掃除でやり直されない', async () => {
      const a = await showA()
      showCounted(layer, 'b')
      await flushPromises()
      advance(layer, 300)
      const before = a.flipAnimation?.startMs
      const fadeBefore = a.fadeAnimation
      showCounted(layer, 'c')
      await flushPromises()
      if (mode === 'Theater') expect(a.flipAnimation?.startMs).toBe(before)
      else expect(a.fadeAnimation).toBe(fadeBefore)
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('M1: show 直後（読み込み完了前）から getCharacterStates は新ポーズを返す（スナップショット・セーブが最新）', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      expect(layer.getCharacterStates().map((s) => s.expression)).toEqual(['b'])
      slowB.resolve()
      await settle(layer)
      expect(layer.getCharacterStates().map((s) => s.expression)).toEqual(['b'])
    })

    it('M2: 同一 tick の入れ替え [登場: hero/b, 中央] → [登場: x, 左]（hero/a が左）で hero と x の両方が残る', async () => {
      await showA('a', '左')
      showCounted(layer, 'b', { position: '中央' })
      showCounted(layer, 'x1', { position: '左', name: 'x' })
      await settle(layer)
      expect([...chars(layer).keys()].sort()).toEqual(['hero', 'x'])
      expect(chars(layer).get('hero')!.expression).toBe('b')
      expect(spriteCount(layer)).toBe(2)
    })

    it('M2b: 入れ替えで B の読み込みが遅くても hero は消えない', async () => {
      await showA('a', '左')
      const slowB = loader.hold('b')
      showCounted(layer, 'b', { position: '中央' })
      showCounted(layer, 'x1', { position: '左', name: 'x' })
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expect([...chars(layer).keys()].sort()).toEqual(['hero', 'x'])
    })

    it('S1: 同一 tick で hero/b を中央、x を中央に置くと、後勝ちで x が中央に残り hero は退場する（main と同じ）', async () => {
      await showA('a', '左')
      showCounted(layer, 'b', { position: '中央' })
      showCounted(layer, 'x1', { position: '中央', name: 'x' })
      await settle(layer)
      expect([...chars(layer).keys()]).toEqual(['x'])
    })

    it('M3: ポーズ変更直後の animate / nudgePose は新ポーズにかかる', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      layer.animate('hero', { dx: '+200', duration_ms: 500 })
      layer.nudgePose('hero')
      const h = chars(layer).get('hero')!
      expect(h.expression).toBe('b')
      expect(h.animation).not.toBeNull()
      expect(h.poseNudge).not.toBeNull()
      slowB.resolve()
      await settle(layer)
      expect(chars(layer).get('hero')).toBe(h)
    })

    it('②場面転換: 読み込み待ち中の clearForSceneTransition で新旧とも退場し、遅れて届いた B は復活しない', async () => {
      await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      layer.clearForSceneTransition()
      slowB.resolve()
      await flushPromises()
      expect(rb.count()).toBe(1)
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)

      layer.show('hero', 'c', '中央', '/assets')
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('②b: A→B(待ち)→C(待ち) の途中で場面転換しても何も残らず、転換後の新規登場も正常', async () => {
      await showA()
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      layer.clearForSceneTransition(0)
      gb.resolve()
      gc.resolve()
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)
      showCounted(layer, 'd', { instant: true })
      await settle(layer)
      expectSettledTo(layer, 'd')
    })

    it('③位置変更: A(左) → B(中央・遅い) → A と同じ姿で左。最終は左の A 相当 1 体だけ', async () => {
      await showA('a', '左')
      const slowB = loader.hold('b')
      showCounted(layer, 'b', { position: '中央' })
      showCounted(layer, 'a', { position: '左' })
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expectSettledTo(layer, 'a')
      expect(chars(layer).get('hero')!.position).toBe('left')
    })

    it('③b: A(左) → B(中央・遅い) → C(左) で、最終は左の C だけ（旧ポーズが残らない）', async () => {
      const a = await showA('a', '左')
      const slowB = loader.hold('b')
      showCounted(layer, 'b', { position: '中央' })
      showCounted(layer, 'c', { position: '左' })
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
      expect(chars(layer).get('hero')!.position).toBe('left')
    })

    it('④戻し: A → B(遅い) → A。最終は A の姿 1 体だけ', async () => {
      await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      const ra = showCounted(layer, 'a')
      await flushPromises()
      expect(ra.count()).toBe(1)
      slowB.resolve()
      await settle(layer)
      expect(rb.count()).toBe(1)
      expectSettledTo(layer, 'a')
    })

    it('⑤初登場の読み込み待ち中にポーズ変更: 遅れて届いた A は復活せず、最終は B だけ', async () => {
      const slowA = loader.hold('a')
      const ra = showCounted(layer, 'a')
      await flushPromises()
      const a = chars(layer).get('hero')!
      expect(a.sprite.parent).toBeNull()
      const rb = showCounted(layer, 'b')
      await flushPromises()
      expect(chars(layer).get('hero')!.expression).toBe('b')
      expect(rb.count()).toBe(1)
      slowA.resolve()
      await flushPromises()
      expect(ra.count()).toBe(1)
      expect(a.sprite.parent).toBeNull()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'b')
    })

    it('⑥a: 読み込み待ち中の [退場](instant) で新旧とも即消え、遅れて届いた B は現れない。再登場は新規', async () => {
      await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero', { instant: true })
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)
      slowB.resolve()
      await flushPromises()
      expect(rb.count()).toBe(1)
      expect(chars(layer).size).toBe(0)
      showCounted(layer, 'c')
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('⑥b: 読み込み待ち中の [退場](フェード) で旧ポーズが孤児として残らず、B が届いても復活しない', async () => {
      await showA()
      const slowB = loader.hold('b')
      const rb = showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero')
      slowB.resolve()
      await flushPromises()
      expect(rb.count()).toBe(1)
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)
      expect(meshCount(layer)).toBe(0)
    })

    it('⑥c: 読み込み待ち中の [退場](フェード) → 別ポーズで再登場すると、最終は C だけ', async () => {
      await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero')
      const rc = showCounted(layer, 'c')
      await flushPromises()
      expect(rc.count()).toBe(1)
      slowB.resolve()
      await settle(layer)
      expectSettledTo(layer, 'c')
    })

    it('⑥d: [退場](instant) → 再登場(新規・遅い) → 遅れて届いた古い B は新しい hero を置き換えない', async () => {
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

    it('⑥e: A→B(待ち)→C(待ち) の途中で [退場] しても旧ポーズが 1 体も残らない', async () => {
      await showA()
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      layer.remove('hero')
      gb.resolve()
      gc.resolve()
      await settle(layer)
      expect(chars(layer).size).toBe(0)
      expect(spriteCount(layer)).toBe(0)
    })

    it('⑦読み込み失敗: A が元の姿で戻り表示され続け、onReady は 1 回。孤児も残らない。その後のポーズ変更は通る', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rb = showCounted(layer, 'b')
      await flushPromises()
      slowB.reject()
      await flushPromises()
      // 全候補失敗後の瞬断リトライ待機（LOAD_RETRY_DELAY_MS）を仮想時間で越える。
      time.tick(1000)
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

    it('⑦b: A→B(待ち)→C(読み込み失敗) でも、ロールバックで孤児（A）が残らない', async () => {
      const a = await showA()
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      await flushPromises()
      gc.reject()
      await flushPromises()
      time.tick(1000)
      await flushPromises()
      // B の読み込み前: A は見え続け、退場演出は B の完了処理が始めるまで張られない。
      expect(a.sprite.visible).toBe(true)
      expect(a.sprite.alpha).toBe(1)
      expect(a.fadeAnimation).toBeNull()
      expect(a.flipAnimation).toBeUndefined()
      gb.resolve()
      await settle(layer)
      // 戻るのは C の旧 state（B）。A は落ちている。
      expect([...chars(layer).keys()]).toEqual(['hero'])
      expect(spriteCount(layer)).toBe(1)
      expect(meshCount(layer)).toBe(0)
    })

    it('⑧新規 show の未 attach state が読み込み待ち中に退場フェードへ入ったら、遅れて読み込みが終わっても復活しない', async () => {
      const slowA = loader.hold('a')
      const ra = showCounted(layer, 'a')
      await flushPromises()
      const s = chars(layer).get('hero')!
      expect(s.sprite.parent).toBeNull()
      layer.remove('hero')
      slowA.resolve()
      await flushPromises()
      expect(ra.count()).toBe(1)
      expect(s.sprite.parent).toBeNull()
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

    it('M1-1: 入場フェード中の A に hero/b(遅い) → hero/c を重ねても A が残らず、最終は C だけ', async () => {
      layer.show('hero', 'a', '中央', '/assets')
      await flushPromises()
      advance(layer, 200)
      const a = chars(layer).get('hero')!
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('M1-2: A→B(読み込み済み・遷移の入場中)→C(遅い)→D(速い) で B が残らず、最終は D だけ', async () => {
      await showA()
      showCounted(layer, 'b')
      await flushPromises()
      advance(layer, 100)
      const b = chars(layer).get('hero')!
      const slowC = loader.hold('c')
      showCounted(layer, 'c')
      showCounted(layer, 'd')
      await flushPromises()
      slowC.resolve()
      await settle(layer)
      expect(b.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'd')
    })

    it('M1-3: [退場] の途中で hero/b(遅い) → hero/c。revive の入場フェードを持つ A が残らない', async () => {
      const a = await showA()
      layer.remove('hero')
      advance(layer, 200)
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      await flushPromises()
      slowB.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'c')
    })

    it('N1: remove の durationMsOverride は孤児の退場演出にも反映される', async () => {
      const a = await showA()
      const slowB = loader.hold('b')
      showCounted(layer, 'b')
      await flushPromises()
      layer.remove('hero', { durationMsOverride: 300 })
      const d = (a.flipAnimation as { durationMs?: number } | undefined)?.durationMs
      const f = (a.fadeAnimation as { durationMs?: number } | null)?.durationMs
      expect(d ?? f).toBe(300)
      slowB.resolve()
      await settle(layer)
      expect(chars(layer).size).toBe(0)
    })

    it('M1-2b: B が in の後半（可視）で孤児になる場合も、現在角度から回って消え、最終は D だけ', async () => {
      await showA()
      showCounted(layer, 'b')
      await flushPromises()
      advance(layer, 600)
      const b = chars(layer).get('hero')!
      const slowC = loader.hold('c')
      showCounted(layer, 'c')
      showCounted(layer, 'd')
      await flushPromises()
      if (mode === 'Theater') expect(b.flipAnimation?.role).toBe('out')
      slowC.resolve()
      await settle(layer)
      expect(b.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'd')
    })

    it('S1: A→B(待ち)→C(失敗)。B が届くまで A は表示され続け（画面が空かない・A が回り直さない）、B 到着後に通常の遷移', async () => {
      const a = await showA()
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      gc.reject()
      await flushPromises()
      time.tick(1000)
      for (let i = 0; i < 10; i++) await flushPromises()
      advance(layer, 600)
      // B の読み込み前: A はまだ見え続け、退場演出は始まっていない（片付けは B の完了処理が行う）。
      expect(a.fadeAnimation).toBeNull()
      expect(a.flipAnimation).toBeUndefined()
      expect(a.sprite.alpha).toBe(1)
      expect(a.sprite.visible).toBe(true)
      gb.resolve()
      for (let i = 0; i < 10; i++) await flushPromises()
      // B 到着で A の退場が今始まる（開始時刻は現在）。
      if (mode === 'Theater') {
        expect(a.flipAnimation?.role).toBe('out')
        expect(a.flipAnimation?.startMs).toBe(internals(layer).elapsedMs)
      } else {
        expect(a.fadeAnimation?.destroyOnComplete).toBe(true)
      }
      expect(chars(layer).get('hero')!.expression).toBe('b')
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expectSettledTo(layer, 'b')
    })

    it('S1b: B の読み込みが先に終わって（早期 return 済み）から C が失敗した場合は、その時点で A を落とす', async () => {
      const a = await showA()
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      showCounted(layer, 'b')
      showCounted(layer, 'c')
      gb.resolve()
      await flushPromises()
      gc.reject()
      await flushPromises()
      time.tick(1000)
      for (let i = 0; i < 10; i++) await flushPromises()
      expect(a.fadeAnimation !== null || a.flipAnimation !== undefined).toBe(true)
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expect([...chars(layer).keys()]).toEqual(['hero'])
      expect(spriteCount(layer)).toBe(1)
    })

    it('S2: 見えない in の段階の旧 state を durationMsOverride 付きの remove で落としても、突然現れない', async () => {
      await showA()
      showCounted(layer, 'b')
      await flushPromises()
      advance(layer, 100)
      const slowC = loader.hold('c')
      showCounted(layer, 'c')
      layer.remove('hero', { durationMsOverride: 3000 })
      advance(layer, 16)
      const bs = [...chars(layer).values()].filter((st) => st.expression === 'b')
      for (const st of bs) {
        const mesh = (st.flipAnimation as { mesh?: { visible: boolean } } | undefined)?.mesh
        expect(mesh?.visible ?? false).toBe(false)
      }
      slowC.resolve()
      await settle(layer)
      expect(chars(layer).size).toBe(0)
    })

    it('Q1: 旧 state が読み込み待ちの間に別キャラの衝突退場で消えても、孤児が残らず最新のポーズが現れる', async () => {
      await showA('a', '左')
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      showCounted(layer, 'b', { position: '右' })
      showCounted(layer, 'c', { position: '中央' })
      showCounted(layer, 'x1', { position: '右', name: 'x' })
      advance(layer, 1100)
      gb.resolve()
      gc.resolve()
      await settle(layer)
      expect([...chars(layer).keys()].sort()).toEqual(['hero', 'x'])
      const h = chars(layer).get('hero')!
      expect(h.expression).toBe('c')
      expect(h.sprite.alpha).toBe(1)
      expect(h.sprite.visible).toBe(true)
      expect(spriteCount(layer)).toBe(2)
      expect(meshCount(layer)).toBe(0)
    })

    it('Q1b: 遷移が 1 段でも、旧 state（A）が衝突退場で消えたら C は旧無しで入場する', async () => {
      await showA('a', '左')
      const gc = loader.hold('c')
      showCounted(layer, 'c', { position: '中央' })
      showCounted(layer, 'x1', { position: '左', name: 'x' })
      advance(layer, 1100)
      gc.resolve()
      await settle(layer)
      expect([...chars(layer).keys()].sort()).toEqual(['hero', 'x'])
      expect(chars(layer).get('hero')!.sprite.alpha).toBe(1)
      expect(spriteCount(layer)).toBe(2)
    })

    it('Q1c: 旧 state が消え、かつ最新の読み込みも失敗したら hero は残らない', async () => {
      await showA('a', '左')
      const gc = loader.hold('c')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      showCounted(layer, 'c', { position: '中央' })
      showCounted(layer, 'x1', { position: '左', name: 'x' })
      advance(layer, 1100)
      gc.reject()
      await flushPromises()
      time.tick(1000)
      await settle(layer)
      expect([...chars(layer).keys()]).toEqual(['x'])
      expect(spriteCount(layer)).toBe(1)
    })

    it('A→B→C→D を矢継ぎ早に変えても最終的に D だけが残り、全 show の onReady が 1 回ずつ', async () => {
      const a = await showA()
      const gb = loader.hold('b')
      const gc = loader.hold('c')
      const reqs = [showCounted(layer, 'b'), showCounted(layer, 'c'), showCounted(layer, 'd')]
      await flushPromises()
      gc.resolve()
      gb.resolve()
      await settle(layer)
      expect(a.sprite.destroyed).toBe(true)
      expect(reqs.map((r) => r.count())).toEqual([1, 1, 1])
      expectSettledTo(layer, 'd')
    })
  }
)
