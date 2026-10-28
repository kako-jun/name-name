/**
 * CharacterLayer のシアターモード板フリップ (#707) 配線テスト。
 *
 * 角度・四隅の数式は boardFlip.test.ts が担保済み。ここでは CharacterLayer 側の
 * 分岐（Theater 限定・instant/fadeMs=0 のフォールバック）、flipAnimation の寿命（out は state 破棄、
 * in は sprite 復帰 + mesh 破棄）、輪郭フィルタ追従、ロールバック、リークを縛る。
 *
 * PerspectiveMesh は実物を使う（WebGL なしでも生成・setCorners・destroy は動く）。
 * texture は実 Texture.WHITE を返す Assets.load モックで供給する（plain object だと mesh が作れない）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Assets, BufferImageSource, PerspectiveMesh, Texture, Ticker } from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'
import { computeBoardFlipCorners, computeBoardFlipFrame } from './boardFlip'

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface StateLike {
  sprite: {
    visible: boolean
    alpha: number
    filters: unknown[] | null
    destroyed: boolean
    x: number
    y: number
    scale: { x: number; y: number }
    texture: Texture
    parent: unknown
  }
  label?: { alpha: number }
  attached?: boolean
  flipAnimation?: {
    role: 'out' | 'in'
    mesh: PerspectiveMesh
    startMs: number
    durationMs: number
    fromAngleRad?: number
  }
  fadeAnimation: unknown
}
interface Internals {
  characters: Map<string, StateLike>
  animTicker: { update: (t?: number) => void; lastTime: number; speed: number } | null
  elapsedMs: number
}
const internals = (l: CharacterLayer): Internals => l as unknown as Internals

/**
 * 仮想時間を ms だけ進めて ticker を 1 回回す。
 * Ticker.start() を無効化しているので実時間の rAF は走らない（beforeEach）。さらに
 * `ticker.speed = 0` で ticker 自身の deltaMS を厳密に 0 に固定し（listener は `update(lastTime+1)` で
 * 呼ぶ。lastTime と同値だと listener が呼ばれない）、elapsedMs への上乗せを一切なくす
 * （混入すると角度の許容を超えて不安定になる）。時間の進みは `elapsedMs += ms` だけ。
 */
function advance(layer: CharacterLayer, ms: number): void {
  const i = internals(layer)
  i.elapsedMs += ms
  const t = i.animTicker
  if (t) {
    t.speed = 0
    t.update(t.lastTime + 1)
  }
}

function makeTexture(w: number, h: number): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(w * h * 4), width: w, height: h }),
  })
}
// 1x1 の WHITE だと四隅の検証が意味を持たないので、非正方形の実寸テクスチャを使う。
const TEX_A = makeTexture(40, 80)
const TEX_THIRD = makeTexture(60, 100)

function mockLoadOk(): void {
  vi.spyOn(Assets, 'load').mockImplementation((async (url: string) =>
    String(url).includes('third') ? TEX_THIRD : TEX_A) as never)
}

/** hero を normal で出し、load 完了まで進めてから surprised に変える。 */
async function setupPoseChange(
  mode: 'Theater' | 'Novel',
  fadeMs = 1000,
  instantSecond = false,
  opts: { position?: string; depth?: number; fit?: boolean } = {}
): Promise<{ layer: CharacterLayer; oldState: StateLike; newState: StateLike }> {
  mockLoadOk()
  const layer = new CharacterLayer(800, 450)
  layer.setCharacterFadeMs(fadeMs)
  layer.setCamera(mode, 'Front' as never, null)
  const position = opts.position ?? '中央'
  const base = { depth: opts.depth, fit: opts.fit }
  layer.show('hero', 'normal', position, '/assets', { instant: true, ...base })
  await flushPromises()
  const oldState = internals(layer).characters.get('hero')!
  layer.show('hero', 'surprised', position, '/assets', {
    ...(instantSecond ? { instant: true } : {}),
    ...base,
  })
  await flushPromises()
  const newState = internals(layer).characters.get('hero')!
  return { layer, oldState, newState }
}

function meshCount(layer: CharacterLayer): number {
  return layer.children.filter((c) => c instanceof PerspectiveMesh).length
}

describe('CharacterLayer シアターモード板フリップ (#707)', () => {
  beforeEach(() => {
    // 実時間の rAF 駆動を止める（advance で仮想時間だけを進める）。
    vi.spyOn(Ticker.prototype, 'start').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Theater のポーズ変更は load 完了後に out/in の flipAnimation を張り sprite を不可視にする', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    expect(oldState.flipAnimation?.role).toBe('out')
    expect(newState.flipAnimation?.role).toBe('in')
    expect(oldState.sprite.visible).toBe(false)
    expect(newState.sprite.visible).toBe(false)
    expect(oldState.fadeAnimation).toBeNull()
    expect(newState.fadeAnimation).toBeNull()
    expect(meshCount(layer)).toBe(2)
  })

  it('Novel のポーズ変更は従来のクロスフェード（flip されない）', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Novel')
    expect(oldState.flipAnimation).toBeUndefined()
    expect(newState.flipAnimation).toBeUndefined()
    expect(oldState.fadeAnimation).not.toBeNull()
    expect(newState.fadeAnimation).not.toBeNull()
    expect(meshCount(layer)).toBe(0)
  })

  it('Theater でも characterFadeMs=0 は即時差し替えで flip しない', async () => {
    const { layer, newState } = await setupPoseChange('Theater', 0)
    expect(newState.flipAnimation).toBeUndefined()
    expect(meshCount(layer)).toBe(0)
  })

  it('Theater でも instant の再 show では flipAnimation を張らない', async () => {
    const { layer, newState } = await setupPoseChange('Theater', 1000, true)
    expect(newState.flipAnimation).toBeUndefined()
    expect(newState.sprite.visible).toBe(true)
    expect(meshCount(layer)).toBe(0)
  })

  it('out 完了で旧 state が characters から消え、in 完了で sprite が可視に戻り mesh が破棄される', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    const oldMesh = oldState.flipAnimation!.mesh
    const newMesh = newState.flipAnimation!.mesh

    // 途中: out は前半だけ可視、in は後半だけ可視。
    advance(layer, 250)
    expect(oldMesh.visible).toBe(true)
    expect(newMesh.visible).toBe(false)
    advance(layer, 500) // 750ms
    expect(oldMesh.visible).toBe(false)
    expect(newMesh.visible).toBe(true)

    advance(layer, 300) // 1050ms: 完了
    expect(oldMesh.destroyed).toBe(true)
    expect(oldState.sprite.destroyed).toBe(true)
    expect([...internals(layer).characters.values()]).not.toContain(oldState)
    expect(internals(layer).characters.size).toBe(1)

    expect(newState.flipAnimation).toBeUndefined()
    expect(newMesh.destroyed).toBe(true)
    expect(newState.sprite.visible).toBe(true)
    expect(newState.sprite.alpha).toBe(1)
    expect(meshCount(layer)).toBe(0)
  })

  it('回転中に setPaperDollOutline を呼ぶと mesh のフィルタも更新され、解除で外れる', async () => {
    const { layer, newState } = await setupPoseChange('Theater')
    const mesh = newState.flipAnimation!.mesh
    expect(mesh.filters ?? null).toBeNull()

    layer.setPaperDollOutline({ color: '#000000', thickness: 3 })
    const applied = newState.sprite.filters
    expect(applied).not.toBeNull()
    expect(mesh.filters).toEqual(applied)

    layer.setPaperDollOutline(null)
    expect(mesh.filters ?? null).toBeNull()
  })

  it('ロード失敗は従来どおりロールバックされ、flip も mesh も残らない', async () => {
    mockLoadOk()
    const layer = new CharacterLayer(800, 450)
    layer.setCharacterFadeMs(1000)
    layer.setCamera('Theater', 'Front' as never, null)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const oldState = internals(layer).characters.get('hero')!

    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    layer.show('hero', 'surprised', '中央', '/assets')
    // 全候補失敗後の瞬断リトライ待機（LOAD_RETRY_DELAY_MS=300）を実時間で待つ。
    await new Promise((resolve) => setTimeout(resolve, 450))
    await flushPromises()

    expect(internals(layer).characters.get('hero')).toBe(oldState)
    expect(internals(layer).characters.size).toBe(1)
    expect(oldState.flipAnimation).toBeUndefined()
    expect(oldState.sprite.visible).toBe(true)
    expect(oldState.sprite.alpha).toBe(1)
    expect(meshCount(layer)).toBe(0)
  })

  it('hasActivePortraitTransition は回転中 true、完了後 false', async () => {
    const { layer } = await setupPoseChange('Theater')
    expect(layer.hasActivePortraitTransition()).toBe(true)
    expect(layer.hasActiveAnimation()).toBe(true)
    advance(layer, 1100)
    expect(layer.hasActivePortraitTransition()).toBe(false)
  })

  it('回転中の remove(instant) で mesh がリークしない', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    const mesh = newState.flipAnimation!.mesh
    const oldMesh = oldState.flipAnimation!.mesh
    layer.remove('hero', { instant: true })
    advance(layer, 10)
    expect(mesh.destroyed).toBe(true)
    // 旧ポーズの out 板は remove 対象外（スナップショット）。予定どおり回り切って自分で消える。
    advance(layer, 1000)
    expect(oldMesh.destroyed).toBe(true)
    expect(meshCount(layer)).toBe(0)
  })

  it('回転中の clear() で out/in 両方の mesh が破棄される', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    const m1 = oldState.flipAnimation!.mesh
    const m2 = newState.flipAnimation!.mesh
    layer.clear()
    expect(m1.destroyed).toBe(true)
    expect(m2.destroyed).toBe(true)
    expect(meshCount(layer)).toBe(0)
  })

  it('S4-1: 角度0の板の四隅が sprite の実範囲（depth>0 の縮尺・verticalOffset・fit 含む）と一致する', async () => {
    for (const opts of [{ depth: 10 }, { depth: 10, fit: true }, {}]) {
      const { layer, oldState } = await setupPoseChange('Theater', 1000, false, opts)
      const sp = oldState.sprite
      const w = sp.texture.width * Math.abs(sp.scale.x)
      const h = sp.texture.height * Math.abs(sp.scale.y)
      // depth>0 の Theater では縮小される（射影が実際に効いている前提の確認）。
      if (opts.depth) expect(sp.scale.y).toBeLessThan(1)
      const expected = computeBoardFlipCorners(sp.x, sp.y, w, h, 0)
      const c = oldState.flipAnimation!.mesh.geometry.corners
      expect(c[0]).toBeCloseTo(sp.x - w / 2, 3)
      expect(c[1]).toBeCloseTo(sp.y - h, 3)
      expect(c[2]).toBeCloseTo(sp.x + w / 2, 3)
      expect(c[3]).toBeCloseTo(sp.y - h, 3)
      expect(c[4]).toBeCloseTo(sp.x + w / 2, 3)
      expect(c[5]).toBeCloseTo(sp.y, 3)
      expect(c[6]).toBeCloseTo(sp.x - w / 2, 3)
      expect(c[7]).toBeCloseTo(sp.y, 3)
      expect(c[0]).toBeCloseTo(expected.x0, 3)
      layer.clear()
    }
  })

  it('S2: 回転中の全フレームで mesh の頂点が有限値（half ちょうど・MAX 角を含む）', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    // 累計 250 / 500（half ちょうど）/ 501 / 750 / 1000（完了）を必ず踏む。
    const steps = [250, 250, 1, 249, 250]
    for (const ms of steps) {
      advance(layer, ms)
      for (const st of [oldState, newState]) {
        const mesh = st.flipAnimation?.mesh
        if (!mesh || mesh.destroyed) continue
        for (const v of mesh.geometry.positions) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('M1: 旧ポーズの板が回っている最中に同じ位置へ別キャラを通常速度で出しても、そのキャラが表示される', async () => {
    const { layer } = await setupPoseChange('Theater')
    const hero = internals(layer)
    const oldBoard = [...hero.characters.values()].find((st) => st.flipAnimation?.role === 'out')!
    layer.show('villain', 'normal', '中央', '/assets', {})
    await flushPromises()
    // 回り去る旧板は退場対象にならず、退場フェードも重ならない。
    expect(oldBoard.fadeAnimation).toBeNull()
    for (let i = 0; i < 12; i++) {
      advance(layer, 250)
      await flushPromises()
    }
    const villain = internals(layer).characters.get('villain')
    expect(villain).toBeDefined()
    expect(villain!.attached).toBe(true)
    expect(villain!.sprite.parent).toBe(layer)
    expect(villain!.sprite.alpha).toBe(1)
    expect(meshCount(layer)).toBe(0)
  })

  it('M1: 旧板の out が退場フェードの完了より先に終わっても、フェードの onComplete が呼ばれる', async () => {
    const { layer, oldState } = await setupPoseChange('Theater')
    // 回転中の旧板に退場フェードを直接張る（evict 以外の経路: clearForSceneTransition 等を模す）。
    let called = 0
    ;(layer as unknown as { startFade: (...a: unknown[]) => void }).startFade(
      oldState,
      1,
      0,
      true,
      () => called++,
      5000
    )
    advance(layer, 1100) // out の回転(1000ms)が退場フェード(5000ms)より先に完了して破棄される
    expect(called).toBe(1)
    expect(oldState.sprite.destroyed).toBe(true)
  })

  it('M2: オフスクリーン位置の名前ラベルは回転の段階に合わせて旧が消え新が現れる', async () => {
    // jsdom には canvas が無く Text の幅計測が落ちるため、ラベル幅合わせだけ無効化する。
    vi.spyOn(CharacterLayer.prototype as never, 'fitLabelToSprite').mockImplementation(() => {})
    const { layer, oldState, newState } = await setupPoseChange('Theater', 1000, false, {
      position: 'off_right',
    })
    expect(oldState.label).toBeDefined()
    expect(newState.label).toBeDefined()
    expect(oldState.label!.alpha).toBe(1)
    expect(newState.label!.alpha).toBe(0)
    advance(layer, 300)
    expect(oldState.label!.alpha).toBe(1)
    expect(newState.label!.alpha).toBe(0)
    advance(layer, 300) // 600ms: 後半
    expect(oldState.label!.alpha).toBe(0)
    expect(newState.label!.alpha).toBe(1)
    advance(layer, 500) // 完了
    expect(newState.label!.alpha).toBe(1)
  })

  it('S1: 回転中の通常速度 remove で mesh の alpha が sprite の alpha に追従する', async () => {
    const { layer, newState } = await setupPoseChange('Theater')
    layer.remove('hero')
    advance(layer, 600)
    const mesh = newState.flipAnimation!.mesh
    expect(newState.sprite.alpha).toBeLessThan(1)
    expect(newState.sprite.alpha).toBeGreaterThan(0)
    expect(mesh.alpha).toBeCloseTo(newState.sprite.alpha, 6)
  })

  it('S4-4/S5: A→B→C の連続変更で B は現在角度から回し続け、最終的に C だけが残る', async () => {
    const { layer, newState: b } = await setupPoseChange('Theater')
    advance(layer, 750) // B は in の後半で可視
    const angleB = computeBoardFlipFrame('in', 750, 1000).angleRad
    expect(angleB).toBeLessThan(0)
    layer.show('hero', 'third', '中央', '/assets', {})
    await flushPromises()
    const c = internals(layer).characters.get('hero')!
    expect(c).not.toBe(b)
    expect(b.flipAnimation?.role).toBe('out')
    expect(b.flipAnimation?.fromAngleRad).toBeCloseTo(angleB, 12)
    // out 開始直後の B の四隅は B の現在角（angleB）の板と一致する（0° に跳ばない）。
    const sp = b.sprite
    const exp = computeBoardFlipCorners(
      sp.x,
      sp.y,
      sp.texture.width * sp.scale.x,
      sp.texture.height * sp.scale.y,
      angleB
    )
    const cc = b.flipAnimation!.mesh.geometry.corners
    expect(cc[0]).toBeCloseTo(exp.x0, 3)
    expect(cc[2]).toBeCloseTo(exp.x1, 3)
    for (let i = 0; i < 8; i++) {
      advance(layer, 400)
      await flushPromises()
    }
    expect(internals(layer).characters.size).toBe(1)
    expect(internals(layer).characters.get('hero')).toBe(c)
    expect(c.sprite.visible).toBe(true)
    expect(b.sprite.destroyed).toBe(true)
    expect(meshCount(layer)).toBe(0)
  })

  it('S5: まだ見えていない B（in の前半）は C への変更で回さず即破棄される', async () => {
    const { layer, newState: b } = await setupPoseChange('Theater')
    advance(layer, 200)
    layer.show('hero', 'third', '中央', '/assets', {})
    await flushPromises()
    advance(layer, 16)
    expect(b.sprite.destroyed).toBe(true)
    expect(b.flipAnimation).toBeUndefined()
  })

  it('S5: 回転中の instant で表情が変わると mesh の texture も追従する', async () => {
    const { layer, newState } = await setupPoseChange('Theater')
    layer.show('hero', 'third', '中央', '/assets', { instant: true })
    await flushPromises()
    advance(layer, 600)
    expect(newState.sprite.texture).toBe(TEX_THIRD)
    expect(newState.flipAnimation!.mesh.texture).toBe(TEX_THIRD)
  })

  it('S4-6: mesh は対応する sprite の直前（同じ z-order）に入る', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    for (const st of [oldState, newState]) {
      const mesh = st.flipAnimation!.mesh
      const i = layer.children.indexOf(mesh)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(layer.children.indexOf(st.sprite as never)).toBe(i + 1)
    }
  })

  it('N3: 衝突退場待ちで未 attach の旧 state は回さない（最前面に突然現れない）', async () => {
    mockLoadOk()
    const layer = new CharacterLayer(800, 450)
    layer.setCharacterFadeMs(1000)
    layer.setCamera('Theater', 'Front' as never, null)
    layer.show('villain', 'normal', '右', '/assets', { instant: true })
    await flushPromises()
    layer.show('hero', 'normal', '右', '/assets', {})
    await flushPromises()
    const oldHero = internals(layer).characters.get('hero')!
    expect(oldHero.attached).toBeFalsy() // villain の退場待ちで未 attach
    layer.show('hero', 'surprised', '右', '/assets', {})
    await flushPromises()
    expect(oldHero.flipAnimation).toBeUndefined()
    expect(meshCount(layer)).toBe(1) // 新板の in だけ
  })

  it('N2: 完了した板の geometry も破棄される（mesh.destroy() だけでは残る）', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    const spies = [oldState, newState].map((st) =>
      vi.spyOn(st.flipAnimation!.mesh.geometry, 'destroy')
    )
    advance(layer, 1100)
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1)
  })

  it('S4-1: 縦横の拡大率が違う sprite でも四隅の高さ・幅は scale.y / scale.x を別々に反映する', async () => {
    const { layer, oldState } = await setupPoseChange('Theater')
    const sp = oldState.sprite
    sp.scale.x = 1.5
    sp.scale.y = 2.5
    advance(layer, 1) // 回転角はほぼ 0
    const c = oldState.flipAnimation!.mesh.geometry.corners
    expect(c[2] - c[0]).toBeCloseTo(sp.texture.width * 1.5, 0)
    expect(c[7] - c[1]).toBeCloseTo(sp.texture.height * 2.5, 0)
  })

  it('S2(空白解消): B が不可視の間に C へ変えると、A が消える瞬間に C が現れる（空白フレームなし）', async () => {
    const { layer, oldState: a, newState: b } = await setupPoseChange('Theater')
    advance(layer, 200) // B は in の前半（不可視）
    layer.show('hero', 'third', '中央', '/assets', {})
    await flushPromises()
    const c = internals(layer).characters.get('hero')!
    expect(c).not.toBe(b)
    // C の in は B の in の開始時刻（= A の out の開始時刻）を引き継ぐ。
    expect(c.flipAnimation!.startMs).toBe(a.flipAnimation!.startMs)
    const visibleAt = (st: StateLike): boolean => st.flipAnimation?.mesh.visible === true
    let sawBlank = false
    let handoffMs = -1
    for (let t = 200; t <= 1000; t += 10) {
      advance(layer, t === 200 ? 0 : 10)
      const aVisible = a.sprite.destroyed ? false : visibleAt(a)
      const cVisible = visibleAt(c)
      if (!aVisible && !cVisible && t < 1000) sawBlank = true
      if (!aVisible && handoffMs < 0) handoffMs = t
      // A が消えたフレームでは C がすでに見えている。
      if (!aVisible && t >= 500) expect(cVisible || t === 1000).toBe(true)
    }
    expect(sawBlank).toBe(false)
    expect(handoffMs).toBeGreaterThanOrEqual(500)
    expect(b.sprite.destroyed).toBe(true)
    advance(layer, 100)
    expect(meshCount(layer)).toBe(0)
    expect(internals(layer).characters.get('hero')!.sprite.visible).toBe(true)
  })

  it('nit-1: 板の四隅は同フレームの poseNudge 適用後の sprite.y に追従する（1 フレーム遅れない）', async () => {
    const { layer, oldState } = await setupPoseChange('Theater')
    const sp = oldState.sprite
    ;(oldState as unknown as { poseNudge: unknown }).poseNudge = {
      startMs: internals(layer).elapsedMs,
      durationMs: 1000,
      baseY: sp.y,
      liftPx: 50,
    }
    advance(layer, 250)
    const flip = oldState.flipAnimation!
    const frame = computeBoardFlipFrame(
      'out',
      internals(layer).elapsedMs - flip.startMs,
      flip.durationMs,
      flip.fromAngleRad
    )
    const exp = computeBoardFlipCorners(
      sp.x,
      sp.y, // nudge で持ち上がった後の y
      sp.texture.width * sp.scale.x,
      sp.texture.height * sp.scale.y,
      frame.angleRad
    )
    expect(sp.y).toBeLessThan(450) // nudge が実際に効いている
    const c = flip.mesh.geometry.corners
    expect(c[1]).toBeCloseTo(exp.y0, 3)
    expect(c[7]).toBeCloseTo(exp.y3, 3)
  })

  it('question: 回転中の clearForSceneTransition は旧・新の板が一緒にフェードアウトして mesh を残さない', async () => {
    const { layer, newState } = await setupPoseChange('Theater')
    advance(layer, 600)
    layer.clearForSceneTransition()
    advance(layer, 200)
    const mesh = newState.flipAnimation!.mesh
    expect(mesh.alpha).toBeCloseTo(newState.sprite.alpha, 6)
    expect(mesh.alpha).toBeLessThan(1)
    for (let i = 0; i < 6; i++) advance(layer, 250)
    expect(internals(layer).characters.size).toBe(0)
    expect(meshCount(layer)).toBe(0)
  })

  it('S-1: 経過がちょうど half の瞬間も、旧板が消えて新板が現れ、空白フレームにならない', async () => {
    const { layer, oldState, newState } = await setupPoseChange('Theater')
    advance(layer, 500) // 厳密に half（ticker の上乗せは 0）
    expect(internals(layer).elapsedMs).toBe(500)
    expect(oldState.flipAnimation!.mesh.visible).toBe(false)
    expect(newState.flipAnimation!.mesh.visible).toBe(true)
    for (const v of newState.flipAnimation!.mesh.geometry.positions) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  describe('#952: 読み込み待ちの B をはさむ A→B→C（実ゲームの連続 [登場]）', () => {
    /** 'slowB' の読み込みだけ release() まで保留する。 */
    function mockLoadGated(): { release: () => void } {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
        if (String(url).includes('slowB')) await gate
        return String(url).includes('third') ? TEX_THIRD : TEX_A
      }) as never)
      return { release }
    }
    type Anim = StateLike & { snapshotHidden?: boolean; expression: string }
    const keysOf = (layer: CharacterLayer): string[] => [...internals(layer).characters.keys()]

    async function setupAbc(
      mode: 'Theater' | 'Novel',
      gated: boolean,
      fadeMs = 2000
    ): Promise<{ layer: CharacterLayer; a: Anim; release: () => void }> {
      const gate = gated ? mockLoadGated() : { release: () => {} }
      if (!gated) mockLoadOk()
      const layer = new CharacterLayer(800, 450)
      layer.setCharacterFadeMs(fadeMs)
      layer.setCamera(mode, 'Front' as never, null)
      layer.show('hero', 'a', '中央', '/assets', { instant: true })
      await flushPromises()
      const a = internals(layer).characters.get('hero') as Anim
      layer.show('hero', gated ? 'slowB' : 'b', '中央', '/assets', {})
      layer.show('hero', 'third', '中央', '/assets', {}) // B の読み込み完了前に C
      await flushPromises()
      return { layer, a, release: gate.release }
    }

    it.each(['Theater', 'Novel'] as const)(
      '%s: B の読み込みが C より遅くても A は退場し、C だけが残る',
      async (mode) => {
        const { layer, a, release } = await setupAbc(mode, true)
        release()
        await flushPromises()
        await flushPromises()
        for (let i = 0; i < 12; i++) {
          advance(layer, 250)
          await flushPromises()
        }
        expect(keysOf(layer)).toEqual(['hero'])
        expect(a.sprite.destroyed).toBe(true)
        const c = internals(layer).characters.get('hero') as Anim
        expect(c.expression).toBe('third')
        expect(c.sprite.alpha).toBe(1)
        expect(c.sprite.visible).toBe(true)
        expect(meshCount(layer)).toBe(0)
      }
    )

    it('Theater: A が回って消え、C が回って現れる（A は正面のまま残らない）', async () => {
      const { layer, a } = await setupAbc('Theater', false)
      // B は捨てられ、A が直接 out、C が in になる。
      expect(keysOf(layer).sort()).toEqual(['hero', 'hero__transition_1'])
      expect(a.flipAnimation?.role).toBe('out')
      expect(a.fadeAnimation).toBeNull() // B の読み込み完了が A を巻き込んでフェードさせない
      const c = internals(layer).characters.get('hero')!
      expect(c.flipAnimation?.role).toBe('in')
      advance(layer, 400)
      expect(a.flipAnimation!.mesh.visible).toBe(true) // A は回転中（正面の静止絵ではない）
      expect(a.sprite.visible).toBe(false)
      const ac = a.flipAnimation!.mesh.geometry.corners
      expect(ac[0]).not.toBeCloseTo(a.sprite.x - (a.sprite.texture.width * a.sprite.scale.x) / 2, 1)
      expect(c.flipAnimation!.mesh.visible).toBe(false)
      advance(layer, 700) // 1100ms: A の板は見えなくなり、C は現れて回っている
      expect(a.flipAnimation!.mesh.visible).toBe(false)
      expect(c.flipAnimation!.mesh.visible).toBe(true)
      advance(layer, 1000)
      expect(keysOf(layer)).toEqual(['hero'])
      expect(a.sprite.destroyed).toBe(true)
      expect(c.sprite.visible).toBe(true)
      expect(meshCount(layer)).toBe(0)
    })

    it('Novel: A はクロスフェードで消え、C だけが残る', async () => {
      const { layer, a } = await setupAbc('Novel', false)
      expect(keysOf(layer).sort()).toEqual(['hero', 'hero__transition_1']) // B は捨てられる
      expect(a.fadeAnimation).not.toBeNull()
      for (let i = 0; i < 10; i++) advance(layer, 250)
      expect(keysOf(layer)).toEqual(['hero'])
      expect(a.sprite.destroyed).toBe(true)
    })

    /** 表情名に含まれる gate 名（slowB / slowC）の読み込みだけを release(name) まで保留する。 */
    function mockLoadGates(): { release: (name: 'slowB' | 'slowC') => void } {
      const gates: Record<string, { p: Promise<void>; r: () => void }> = {}
      for (const n of ['slowB', 'slowC']) {
        let r: () => void = () => {}
        const p = new Promise<void>((resolve) => (r = resolve))
        gates[n] = { p, r }
      }
      vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
        for (const n of Object.keys(gates)) if (String(url).includes(n)) await gates[n].p
        return TEX_A
      }) as never)
      return { release: (name) => gates[name].r() }
    }
    const settle = async (layer: CharacterLayer, ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 250) {
        advance(layer, 250)
        await flushPromises()
      }
    }
    const newLayer = (mode: 'Theater' | 'Novel'): CharacterLayer => {
      const layer = new CharacterLayer(800, 450)
      layer.setCharacterFadeMs(1000)
      layer.setCamera(mode, 'Front' as never, null)
      return layer
    }

    describe.each(['Theater', 'Novel'] as const)('%s: 引き継ぎ・安全網の状態遷移', (mode) => {
      it('場面転換で A が退場中でも、あとから読み込み完了した C は出る（引き継がない）', async () => {
        const g = mockLoadGates()
        const layer = newLayer(mode)
        layer.show('hero', 'a', '中央', '/assets', { instant: true })
        await flushPromises()
        layer.show('hero', 'slowB', '中央', '/assets', {})
        layer.clearForSceneTransition()
        layer.show('hero', 'slowC', '中央', '/assets', {})
        await settle(layer, 1250) // A の退場フェードが完了
        g.release('slowB')
        g.release('slowC')
        await flushPromises()
        await flushPromises()
        await settle(layer, 3000)
        expect(keysOf(layer)).toEqual(['hero'])
        const c = internals(layer).characters.get('hero') as Anim
        expect(c.expression).toBe('slowC')
        expect(c.sprite.alpha).toBe(1)
        expect(c.sprite.visible).toBe(true)
        expect(meshCount(layer)).toBe(0)
      })

      it.each([
        ['C の読み込みが fade より速い', 0],
        ['C の読み込みが fade より遅い', 1500],
      ])('位置変更で A が衝突退場に巻き込まれない（%s）', async (_n, delay) => {
        const g = mockLoadGates()
        const layer = newLayer(mode)
        layer.show('hero', 'a', '左', '/assets', { instant: true })
        await flushPromises()
        const a = internals(layer).characters.get('hero') as Anim
        layer.show('hero', 'slowB', '中央', '/assets', {})
        layer.show('hero', 'slowC', '左', '/assets', {})
        expect(a.fadeAnimation).toBeNull() // 自分自身の旧ポーズは位置の衝突退場の対象外
        await settle(layer, delay)
        g.release('slowB')
        g.release('slowC')
        await flushPromises()
        await flushPromises()
        await settle(layer, 3000)
        expect(keysOf(layer)).toEqual(['hero'])
        const c = internals(layer).characters.get('hero') as Anim
        expect(c.expression).toBe('slowC')
        expect(c.sprite.alpha).toBe(1)
        expect(c.sprite.visible).toBe(true)
        expect(a.sprite.destroyed).toBe(true)
        expect(meshCount(layer)).toBe(0)
      })

      it('A 左→B 中央→C 左（位置を戻す連続変更）で A→C に直接つながる', async () => {
        mockLoadOk()
        const layer = newLayer(mode)
        layer.show('hero', 'a', '左', '/assets', { instant: true })
        await flushPromises()
        const a = internals(layer).characters.get('hero') as Anim
        layer.show('hero', 'b', '中央', '/assets', {})
        layer.show('hero', 'third', '左', '/assets', {})
        await flushPromises()
        expect(keysOf(layer).sort()).toEqual(['hero', 'hero__transition_1'])
        if (mode === 'Theater') {
          expect(a.flipAnimation?.role).toBe('out')
          expect(a.fadeAnimation).toBeNull()
        } else {
          expect(a.fadeAnimation).not.toBeNull()
        }
        await settle(layer, 3000)
        expect(keysOf(layer)).toEqual(['hero'])
        const c = internals(layer).characters.get('hero') as Anim
        expect(c.expression).toBe('third')
        expect(c.sprite.alpha).toBe(1)
        expect(meshCount(layer)).toBe(0)
      })

      it('A→B(読み込み待ち)→A に戻すと遷移せず A がそのまま残る', async () => {
        mockLoadGates()
        const layer = newLayer(mode)
        layer.show('hero', 'a', '中央', '/assets', { instant: true })
        await flushPromises()
        const a = internals(layer).characters.get('hero') as Anim
        layer.show('hero', 'slowB', '中央', '/assets', {})
        const b = internals(layer).characters.get('hero') as Anim
        layer.show('hero', 'a', '中央', '/assets', {})
        await flushPromises()
        expect(keysOf(layer)).toEqual(['hero'])
        expect(internals(layer).characters.get('hero')).toBe(a)
        expect(a.snapshotHidden).toBe(false)
        expect(a.flipAnimation).toBeUndefined()
        expect(a.fadeAnimation).toBeNull()
        expect(a.sprite.visible).toBe(true)
        expect(b.sprite.destroyed).toBe(true)
        expect(meshCount(layer)).toBe(0)
      })

      it('読み込み待ちの間に nextState が退場中になっても、読み込み完了で復活しない', async () => {
        const g = mockLoadGates()
        const layer = newLayer(mode)
        layer.show('hero', 'a', '中央', '/assets', { instant: true })
        await flushPromises()
        layer.show('hero', 'slowB', '中央', '/assets', {})
        layer.clearForSceneTransition()
        await settle(layer, 250)
        g.release('slowB')
        await flushPromises()
        await flushPromises()
        await settle(layer, 3000)
        expect(keysOf(layer)).toEqual([])
        expect(meshCount(layer)).toBe(0)
      })

      it('安全網は旧ポーズ A 自身の退場フェード（onComplete 付き）を上書きしない', async () => {
        const g = mockLoadGates()
        const layer = newLayer(mode)
        layer.show('hero', 'a', '中央', '/assets', { instant: true })
        await flushPromises()
        const a = internals(layer).characters.get('hero') as Anim
        layer.show('hero', 'slowB', '中央', '/assets', {})
        let done = 0
        ;(layer as unknown as { startFade: (...x: unknown[]) => void }).startFade(
          a,
          1,
          0,
          true,
          () => done++,
          3000
        )
        const fade = a.fadeAnimation
        layer.remove('hero', { instant: true }) // B が消える
        g.release('slowB')
        await flushPromises()
        await flushPromises()
        expect(a.fadeAnimation).toBe(fade)
        await settle(layer, 3250)
        expect(done).toBe(1)
        expect(keysOf(layer)).toEqual([])
      })
    })

    it('読み込み待ちの間に即時 [退場] されても、旧ポーズ A は残らず退場する', async () => {
      const { release } = mockLoadGated()
      const layer = new CharacterLayer(800, 450)
      layer.setCharacterFadeMs(1000)
      layer.setCamera('Theater', 'Front' as never, null)
      layer.show('hero', 'a', '中央', '/assets', { instant: true })
      await flushPromises()
      const a = internals(layer).characters.get('hero') as Anim
      layer.show('hero', 'slowB', '中央', '/assets', {})
      layer.remove('hero', { instant: true })
      expect(keysOf(layer)).toEqual(['hero__transition_1'])
      release()
      await flushPromises()
      await flushPromises()
      for (let i = 0; i < 6; i++) {
        advance(layer, 250)
        await flushPromises()
      }
      expect(keysOf(layer)).toEqual([])
      expect(a.sprite.destroyed).toBe(true)
    })
  })
})
