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
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, PerspectiveMesh, Texture } from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface StateLike {
  sprite: { visible: boolean; alpha: number; filters: unknown[] | null; destroyed: boolean }
  flipAnimation?: { role: 'out' | 'in'; mesh: PerspectiveMesh; durationMs: number }
  fadeAnimation: unknown
}
interface Internals {
  characters: Map<string, StateLike>
  animTicker: { update: () => void } | null
  elapsedMs: number
}
const internals = (l: CharacterLayer): Internals => l as unknown as Internals

function advance(layer: CharacterLayer, ms: number): void {
  const i = internals(layer)
  i.elapsedMs += ms
  i.animTicker?.update()
}

function mockLoadOk(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
}

/** hero を normal で出し、load 完了まで進めてから surprised に変える。 */
async function setupPoseChange(
  mode: 'Theater' | 'Novel',
  fadeMs = 1000,
  instantSecond = false
): Promise<{ layer: CharacterLayer; oldState: StateLike; newState: StateLike }> {
  mockLoadOk()
  const layer = new CharacterLayer(800, 450)
  layer.setCharacterFadeMs(fadeMs)
  layer.setCamera(mode, 'Front' as never, null)
  layer.show('hero', 'normal', '中央', '/assets', { instant: true })
  await flushPromises()
  const oldState = internals(layer).characters.get('hero')!
  layer.show('hero', 'surprised', '中央', '/assets', instantSecond ? { instant: true } : {})
  await flushPromises()
  const newState = internals(layer).characters.get('hero')!
  return { layer, oldState, newState }
}

function meshCount(layer: CharacterLayer): number {
  return layer.children.filter((c) => c instanceof PerspectiveMesh).length
}

describe('CharacterLayer シアターモード板フリップ (#707)', () => {
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
})
