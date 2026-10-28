/**
 * 大道具 (PropLayer) と背景板 (BackgroundBoardLayer) の面の切り替え (#704) の配線テスト。
 * 両レイヤーは同じ API・同じ規約なので describe.each で同じ観点を縛る。
 *
 * 観点:
 *  - シアターのみ板の Y 軸回転（旧面 mesh→新面 mesh→新面 sprite）。ノベル・スキップ・書き出し・
 *    prefers-reduced-motion・時間 0 は即時切替（同じ最終状態）
 *  - settled state (`getState()`) は差し替え直後から新しい面で、回転途中の値を持たない（ADR 0002）
 *  - 競合: ロード待ち中・回転中の再差し替え / 撤去 / カメラ変更 / 書き出し開始 / 復元でも旧面が残らず、
 *    最後に指定した面だけが残る。タイマー・mesh のリークなし
 *
 * テクスチャは実 Texture（PerspectiveMesh が必要とする）。Assets.load は URL で出し分け、
 * 競合テストでは deferred で解決順を制御する。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Assets, BufferImageSource, PerspectiveMesh, Sprite, Texture } from 'pixi.js'
import { BackgroundBoardLayer } from './BackgroundBoardLayer'
import { PropLayer } from './PropLayer'
import { TimeController } from './TimeController'
import { computeCameraProjection } from './cameraProjection'
import { computeBoardPlacement } from './novelLayout'

const W = 800
const H = 450

function tex(w = W, h = H): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(4), width: w, height: h }),
  })
}

// 旧面と新面の取り違え（寸法・位置）を検出できるよう、A/B/C は寸法を変えておく。
const SIZES: Record<string, [number, number]> = {
  'A.png': [800, 450],
  'B.png': [400, 800],
  'C.png': [1600, 450],
}
const TEXTURES: Record<string, Texture> = {}
function texFor(path: string): Texture {
  const [w, h] = SIZES[path] ?? [W, H]
  return (TEXTURES[path] ??= tex(w, h))
}

const mq = { matches: false }
beforeAll(() => {
  // prefersReducedMotion() は最初の呼び出しで MediaQueryList を掴んで以後 .matches を読む。
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => mq,
  })
})

interface Deferred {
  resolve: (t: Texture) => void
  reject: (e: unknown) => void
}

/** Assets.load を URL（末尾のファイル名）で出し分ける。`defer` に入れた名前は手動で解決する。 */
function mockLoad(defer: string[] = []): Record<string, Deferred> {
  const deferred: Record<string, Deferred> = {}
  vi.spyOn(Assets, 'load').mockImplementation(((url: string) => {
    const name = String(url).split('/').pop()!
    if (defer.includes(name)) {
      return new Promise<Texture>((resolve, reject) => {
        deferred[name] = { resolve, reject }
      })
    }
    return Promise.resolve(texFor(name))
  }) as never)
  return deferred
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
  mq.matches = false
})

type AnyLayer = PropLayer | BackgroundBoardLayer
interface Entry {
  path: string
  depth: number
  sprite: Sprite | null
  run: { oldMesh: PerspectiveMesh; newMesh: PerspectiveMesh } | null
  pendingOld: Sprite | null
  interval: number | null
  flipInterval: number | null
}
const entriesOf = (l: AnyLayer): Entry[] => (l as unknown as { entries: Entry[] }).entries
const timersOf = (t: TimeController): unknown[] => (t as unknown as { timers: unknown[] }).timers
const kinds = (l: AnyLayer): string[] =>
  l.children.map((c) =>
    c instanceof PerspectiveMesh ? 'mesh' : c instanceof Sprite ? 'sprite' : '?'
  )

describe.each([
  ['PropLayer', (t: TimeController) => new PropLayer(W, H, t)],
  ['BackgroundBoardLayer', (t: TimeController) => new BackgroundBoardLayer(W, H, t)],
] as const)('%s の面の切り替え (#704)', (_name, make) => {
  async function setup(
    mode: 'Theater' | 'Novel' = 'Theater',
    defer: string[] = []
  ): Promise<{ layer: AnyLayer; time: TimeController; deferred: Record<string, Deferred> }> {
    const deferred = mockLoad(defer)
    const time = new TimeController()
    time.setMode('virtual')
    const layer = make(time)
    layer.setCamera(mode, 'Audience', null)
    return { layer, time, deferred }
  }

  /** 表 (A) を復元用の即時配置で置いてロード完了まで進める。 */
  async function withFront(
    mode: 'Theater' | 'Novel' = 'Theater',
    defer: string[] = []
  ): Promise<{ layer: AnyLayer; time: TimeController; deferred: Record<string, Deferred> }> {
    const s = await setup(mode, defer)
    s.layer.add('A.png', 0, '/a', { instant: true })
    await flush()
    return s
  }

  describe('シアター: 板の回転', () => {
    it('差し替え直後から getState は新しい面。ロード完了まで旧面が残り、完了で旧→新の mesh が回る', async () => {
      const { layer, time } = await withFront()
      expect(kinds(layer)).toEqual(['sprite'])
      const oldSprite = layer.children[0] as Sprite
      layer.replace('B.png', 0, 'A.png', '/a')
      expect(layer.getState()).toEqual([{ path: 'B.png', depth: 0 }])
      await flush()
      expect(kinds(layer)).toEqual(['mesh', 'mesh'])
      expect(oldSprite.destroyed).toBe(true)
      const run = entriesOf(layer)[0].run!
      expect(run.oldMesh.texture).toBe(texFor('A.png'))
      expect(run.newMesh.texture).toBe(texFor('B.png'))
      // 前半: 旧面だけ見える。
      time.tick(160)
      expect(run.oldMesh.visible).toBe(true)
      expect(run.newMesh.visible).toBe(false)
      // 後半: 新面だけ見える。
      time.tick(320)
      expect(run.oldMesh.visible).toBe(false)
      expect(run.newMesh.visible).toBe(true)
      // 回転が終わると新面の sprite だけになり、mesh は破棄される。
      time.tick(400)
      expect(kinds(layer)).toEqual(['sprite'])
      expect(run.oldMesh.destroyed).toBe(true)
      expect(run.newMesh.destroyed).toBe(true)
      expect(entriesOf(layer)[0].run).toBeNull()
      expect(timersOf(time)).toHaveLength(0)
    })

    it('回転中も getState は path/depth だけ（途中の値を持たない）', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(300)
      expect(layer.getState()).toEqual([{ path: 'B.png', depth: 0 }])
    })

    it('時間は flipMs で上書きでき、未指定は setFlipDefaultMs の値', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a', { flipMs: 200 })
      await flush()
      time.tick(190)
      expect(kinds(layer)).toEqual(['mesh', 'mesh'])
      time.tick(20)
      expect(kinds(layer)).toEqual(['sprite'])

      layer.setFlipDefaultMs(300)
      layer.replace('C.png', 0, 'B.png', '/a')
      await flush()
      time.tick(290)
      expect(kinds(layer)).toEqual(['mesh', 'mesh'])
      time.tick(20)
      expect(kinds(layer)).toEqual(['sprite'])
    })

    it('depth が違う板が複数あっても、同じ depth の板だけが回り、描画順(depth 降順)は保たれる', async () => {
      const { layer, time } = await setup()
      layer.add('far.png', 5, '/a', { instant: true })
      layer.add('A.png', 0, '/a', { instant: true })
      await flush()
      layer.replace('B.png', 5, 'far.png', '/a')
      await flush()
      // depth 大（奥）が先: [mesh, mesh (depth5 の回転), sprite (depth0)]
      expect(kinds(layer)).toEqual(['mesh', 'mesh', 'sprite'])
      time.tick(1000)
      expect(kinds(layer)).toEqual(['sprite', 'sprite'])
      expect(layer.getState().map((s) => s.path)).toEqual(['B.png', 'A.png'])
    })

    it('同じ path・depth が複数あるときは最後のものを差し替える', async () => {
      const { layer } = await setup()
      layer.add('A.png', 0, '/a', { instant: true })
      layer.add('A.png', 0, '/a', { instant: true })
      await flush()
      layer.replace('B.png', 0, 'A.png', '/a')
      expect(layer.getState().map((s) => s.path)).toEqual(['A.png', 'B.png'])
    })
  })

  describe('即時切替になる条件（同じ最終状態）', () => {
    async function expectInstant(
      prep: (s: Awaited<ReturnType<typeof setup>>) => void,
      mode: 'Theater' | 'Novel' = 'Theater',
      opts: { flipMs?: number | null; skip?: boolean } = {}
    ): Promise<void> {
      const s = await withFront(mode)
      prep(s)
      const oldSprite = s.layer.children[0] as Sprite
      s.layer.replace('B.png', 0, 'A.png', '/a', opts)
      expect(s.layer.getState()).toEqual([{ path: 'B.png', depth: 0 }])
      await flush()
      expect(kinds(s.layer)).toEqual(['sprite'])
      expect(oldSprite.destroyed).toBe(true)
      expect(entriesOf(s.layer)[0].run).toBeNull()
      // 即時切替はスライドインも回転もしないので、タイマーは残らない。
      expect(timersOf(s.time)).toHaveLength(0)
      const sprite = s.layer.children[0] as Sprite
      expect(sprite.texture).toBe(texFor('B.png'))
      expect(sprite.y).toBe(H / 2)
    }

    it('ノベル', () => expectInstant(() => {}, 'Novel'))
    it('スキップ中に受けた差し替え', () => expectInstant(() => {}, 'Theater', { skip: true }))
    it('動画書き出し中', () => expectInstant((s) => s.layer.setExporting(true)))
    it('prefers-reduced-motion', () =>
      expectInstant(() => {
        mq.matches = true
      }))
    it('時間 0', () => expectInstant(() => {}, 'Theater', { flipMs: 0 }))

    it('ノベルでも差し替え自体は起きる（旧面は残らず、状態はシアターと同じ）', async () => {
      const novel = await withFront('Novel')
      novel.layer.replace('B.png', 0, 'A.png', '/a')
      const theater = await withFront('Theater')
      theater.layer.replace('B.png', 0, 'A.png', '/a')
      expect(novel.layer.getState()).toEqual(theater.layer.getState())
    })
  })

  describe('該当する板が無いとき', () => {
    it('path が合わなければ通常の追加（加算 + スライドイン）', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'ghost.png', '/a')
      await flush()
      expect(layer.getState().map((s) => s.path)).toEqual(['A.png', 'B.png'])
      expect(entriesOf(layer)[1].interval).not.toBeNull()
      expect(entriesOf(layer)[1].run).toBeNull()
      time.tick(2000)
      expect(timersOf(time)).toHaveLength(0)
    })

    it('depth が合わなければ通常の追加', async () => {
      const { layer } = await withFront()
      layer.replace('B.png', 3, 'A.png', '/a')
      expect(layer.getState()).toEqual([
        { path: 'A.png', depth: 0 },
        { path: 'B.png', depth: 3 },
      ])
    })
  })

  describe('競合', () => {
    it('ロード待ち中にさらに差し替えると、最後の面だけが残る（旧面は新面の準備ができるまで残る）', async () => {
      const { layer, time, deferred } = await withFront('Theater', ['B.png', 'C.png'])
      const sprA = layer.children[0] as Sprite
      layer.replace('B.png', 0, 'A.png', '/a')
      layer.replace('C.png', 0, 'B.png', '/a')
      expect(layer.getState()).toEqual([{ path: 'C.png', depth: 0 }])
      await flush()
      // どちらもまだ読めていない間は A が見え続ける。
      expect(kinds(layer)).toEqual(['sprite'])
      expect(layer.children[0]).toBe(sprA)
      // 取り消された B が後から読めても何も起きない。
      deferred['B.png'].resolve(texFor('B.png'))
      await flush()
      expect(kinds(layer)).toEqual(['sprite'])
      expect(layer.children[0]).toBe(sprA)
      // 取り消された面のスライドインなどのタイマーも立てない。
      expect(timersOf(time)).toHaveLength(0)
      deferred['C.png'].resolve(texFor('C.png'))
      await flush()
      // A→C の回転。B は一度も現れない。
      const run = entriesOf(layer)[0].run!
      expect(run.oldMesh.texture).toBe(texFor('A.png'))
      expect(run.newMesh.texture).toBe(texFor('C.png'))
      time.tick(1000)
      expect(kinds(layer)).toEqual(['sprite'])
      expect((layer.children[0] as Sprite).texture).toBe(texFor('C.png'))
      expect(timersOf(time)).toHaveLength(0)
    })

    it('新しい面が先に読めてから取り消された面が読めても、取り消された面は出ない', async () => {
      const { layer, deferred } = await withFront('Theater', ['B.png', 'C.png'])
      layer.replace('B.png', 0, 'A.png', '/a')
      layer.replace('C.png', 0, 'B.png', '/a')
      deferred['C.png'].resolve(texFor('C.png'))
      await flush()
      deferred['B.png'].resolve(texFor('B.png'))
      await flush()
      expect(entriesOf(layer)).toHaveLength(1)
      expect(entriesOf(layer)[0].path).toBe('C.png')
      expect(entriesOf(layer)[0].run!.newMesh.texture).toBe(texFor('C.png'))
    })

    it('回転中にさらに差し替えると、いまの回転を畳んで新面の B から C へ回し直す。mesh は残らない', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(160)
      const firstRun = entriesOf(layer)[0].run!
      layer.replace('C.png', 0, 'B.png', '/a')
      await flush()
      expect(firstRun.oldMesh.destroyed).toBe(true)
      expect(firstRun.newMesh.destroyed).toBe(true)
      const run = entriesOf(layer)[0].run!
      expect(run).not.toBe(firstRun)
      expect(run.oldMesh.texture).toBe(texFor('B.png'))
      expect(run.newMesh.texture).toBe(texFor('C.png'))
      expect(kinds(layer)).toEqual(['mesh', 'mesh'])
      expect(layer.getState()).toEqual([{ path: 'C.png', depth: 0 }])
      time.tick(1000)
      expect(kinds(layer)).toEqual(['sprite'])
      expect(timersOf(time)).toHaveLength(0)
    })

    it('回転中の撤去 (clear) で mesh・旧面・タイマーがすべて消える', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(100)
      const run = entriesOf(layer)[0].run!
      layer.clear()
      expect(layer.children).toHaveLength(0)
      expect(run.oldMesh.destroyed).toBe(true)
      expect(run.newMesh.destroyed).toBe(true)
      expect(layer.getState()).toEqual([])
      expect(timersOf(time)).toHaveLength(0)
      expect(() => time.tick(2000)).not.toThrow()
    })

    it('ロード待ち中の撤去 (clear) で旧面も消え、後からロードが終わっても何も出ない', async () => {
      const { layer, time, deferred } = await withFront('Theater', ['B.png'])
      const sprA = layer.children[0] as Sprite
      layer.replace('B.png', 0, 'A.png', '/a')
      layer.clear()
      expect(sprA.destroyed).toBe(true)
      expect(layer.children).toHaveLength(0)
      deferred['B.png'].resolve(texFor('B.png'))
      await flush()
      expect(layer.children).toHaveLength(0)
      expect(layer.getState()).toEqual([])
      expect(timersOf(time)).toHaveLength(0)
    })

    it('新しい面の読み込みに失敗したら旧面も残さない（宣言は新しい面）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { layer, deferred } = await withFront('Theater', ['B.png'])
      const sprA = layer.children[0] as Sprite
      layer.replace('B.png', 0, 'A.png', '/a')
      deferred['B.png'].reject(new Error('404'))
      await flush()
      expect(sprA.destroyed).toBe(true)
      expect(layer.children).toHaveLength(0)
      expect(layer.getState()).toEqual([{ path: 'B.png', depth: 0 }])
      expect(warn).toHaveBeenCalled()
    })

    it('回転中にカメラが変わると回転を畳んで最終状態になる', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(100)
      layer.setCamera('Novel', 'Audience', null)
      expect(kinds(layer)).toEqual(['sprite'])
      expect(entriesOf(layer)[0].run).toBeNull()
      expect(timersOf(time)).toHaveLength(0)
    })

    it('回転中に書き出しが始まると最終状態へ即時', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(100)
      layer.setExporting(true)
      expect(kinds(layer)).toEqual(['sprite'])
      expect(timersOf(time)).toHaveLength(0)
    })

    it('復元 (restore) は回転せず最終状態を即時に積む', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(100)
      layer.restore([{ path: 'B.png', depth: 0 }], '/a')
      await flush()
      expect(kinds(layer)).toEqual(['sprite'])
      expect(entriesOf(layer)[0].run).toBeNull()
      expect(layer.getState()).toEqual([{ path: 'B.png', depth: 0 }])
      expect(timersOf(time)).toHaveLength(0)
    })

    it('旧面がスライドイン中でも差し替えられる（旧面のタイマーは止まる）', async () => {
      const { layer, time } = await setup()
      layer.add('A.png', 0, '/a')
      await flush()
      expect(entriesOf(layer)[0].interval).not.toBeNull()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      expect(kinds(layer)).toEqual(['mesh', 'mesh'])
      time.tick(2000)
      expect(kinds(layer)).toEqual(['sprite'])
      expect(timersOf(time)).toHaveLength(0)
    })

    it('旧面がまだロード中のうちに差し替えると、旧面なしの通常追加と同じ（スライドイン）', async () => {
      const { layer, time, deferred } = await setup('Theater', ['A.png'])
      layer.add('A.png', 0, '/a')
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      expect(kinds(layer)).toEqual(['sprite'])
      expect(entriesOf(layer)[0].interval).not.toBeNull()
      deferred['A.png'].resolve(texFor('A.png'))
      await flush()
      expect(kinds(layer)).toEqual(['sprite'])
      time.tick(2000)
      expect(timersOf(time)).toHaveLength(0)
    })
  })
  describe('回転の幾何（旧面・新面の取り違えを検出）', () => {
    const corners = (m: PerspectiveMesh): number[] =>
      Array.from((m.geometry as unknown as { corners: ArrayLike<number> }).corners)
    const bounds = (s: Sprite): number[] => [
      s.x - s.width / 2,
      s.y - s.height / 2,
      s.x + s.width / 2,
      s.y - s.height / 2,
      s.x + s.width / 2,
      s.y + s.height / 2,
      s.x - s.width / 2,
      s.y + s.height / 2,
    ]

    it('開始直後は旧 sprite の bounds、終了直前は最終 sprite の bounds（depth あり・寸法違い）', async () => {
      const { layer, time } = await setup()
      layer.add('A.png', 5, '/a', { instant: true })
      await flush()
      const oldBounds = bounds(layer.children[0] as Sprite)
      layer.replace('B.png', 5, 'A.png', '/a', { flipMs: 1000 })
      await flush()
      const entry = entriesOf(layer)[0]
      const run = entry.run!
      const finalBounds = bounds(entry.sprite!)
      // 旧面と新面の配置は実際に違う（違わないとこのテストは取り違えを検出できない）。
      expect(finalBounds[5] - finalBounds[1]).not.toBeCloseTo(oldBounds[5] - oldBounds[1], 0)
      const c0 = corners(run.oldMesh)
      for (let i = 0; i < 8; i++) expect(Math.abs(c0[i] - oldBounds[i])).toBeLessThan(0.5)
      time.tick(980)
      const c1 = corners(run.newMesh)
      for (let i = 0; i < 8; i++) expect(Math.abs(c1[i] - finalBounds[i])).toBeLessThan(2)
    })

    it('スライドイン中の旧面を差し替えても、旧面は最終配置へスナップされて回る', async () => {
      const { layer } = await setup()
      layer.add('A.png', 5, '/a')
      await flush()
      const entryA = entriesOf(layer)[0]
      expect(entryA.interval).not.toBeNull()
      const sprA = entryA.sprite!
      const target = { y: (entryA as unknown as { targetY: number }).targetY }
      const halfH = sprA.height / 2
      expect(sprA.y).not.toBe(target.y)
      layer.replace('B.png', 5, 'A.png', '/a', { flipMs: 1000 })
      // ロード待ちの間も旧面は最終位置にある。
      expect(sprA.y).toBe(target.y)
      await flush()
      const run = entriesOf(layer)[0].run!
      const c0 = corners(run.oldMesh)
      expect(Math.abs(c0[1] - (target.y - halfH))).toBeLessThan(0.5)
      expect(Math.abs(c0[5] - (target.y + halfH))).toBeLessThan(0.5)
    })
  })

  describe('スナップの対象', () => {
    it('スライドイン中にカメラで target が動いても、差し替えで x・幅・高さ・y が新しい target へスナップされる', async () => {
      const { layer } = await setup()
      layer.add('A.png', 5, '/a')
      await flush()
      const entryA = entriesOf(layer)[0]
      const sprA = entryA.sprite!
      expect(entryA.interval).not.toBeNull()
      // Novel は scale=1 なので、シアター depth 5 の縮小した配置とは x/幅/高さ/y が変わる。
      layer.setCamera('Novel', 'Audience', null)
      const t = entryA as unknown as {
        targetX: number
        targetY: number
        targetWidth: number
        targetHeight: number
      }
      expect(sprA.width).not.toBeCloseTo(t.targetWidth, 1)
      // x はカメラが変わっても中央で動かないので、ずれた状態を作ってスナップを確かめる。
      sprA.x = 123
      layer.replace('B.png', 5, 'A.png', '/a')
      expect(sprA.x).toBe(t.targetX)
      expect(sprA.y).toBe(t.targetY)
      expect(sprA.width).toBe(t.targetWidth)
      expect(sprA.height).toBe(t.targetHeight)
    })
  })

  describe('カメラ変更', () => {
    it('ロード待ち中にカメラが変わると、旧面は新しいカメラの位置へ置き直される', async () => {
      const { layer, deferred } = await setup('Theater', ['B.png'])
      layer.add('A.png', 5, '/a', { instant: true })
      await flush()
      const sprA = layer.children[0] as Sprite
      const before = sprA.y
      layer.replace('B.png', 5, 'A.png', '/a')
      layer.setCamera('Theater', 'Audience', 'LookUp')
      const expected = computeBoardPlacement(
        800,
        450,
        W,
        H,
        computeCameraProjection('Theater', 'Audience', 'LookUp', 5)
      )
      expect(sprA.y).toBeCloseTo(expected.y, 3)
      expect(sprA.width).toBeCloseTo(expected.width, 3)
      expect(sprA.y).not.toBeCloseTo(before, 1)
      deferred['B.png'].resolve(texFor('B.png'))
      await flush()
      expect(entriesOf(layer).find((e) => e.run)).toBeDefined()
    })

    it('B・C ともロード待ちの A→B→C でも、旧面 A は A の寸法で新しいカメラの位置へ置き直される', async () => {
      const { layer } = await setup('Theater', ['B.png', 'C.png'])
      layer.add('A.png', 5, '/a', { instant: true })
      await flush()
      const sprA = layer.children[0] as Sprite
      layer.replace('B.png', 5, 'A.png', '/a')
      layer.replace('C.png', 5, 'B.png', '/a')
      layer.setCamera('Theater', 'Audience', 'LookUp')
      const expected = computeBoardPlacement(
        800,
        450,
        W,
        H,
        computeCameraProjection('Theater', 'Audience', 'LookUp', 5)
      )
      expect(sprA.y).toBeCloseTo(expected.y, 3)
      expect(sprA.width).toBeCloseTo(expected.width, 3)
      expect(sprA.height).toBeCloseTo(expected.height, 3)
    })

    it('回転中に同じ mode・向き・仰角で setCamera（ズームだけの変更）しても回転は続く', async () => {
      const { layer, time } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      time.tick(100)
      const run = entriesOf(layer)[0].run
      layer.setCamera('Theater', 'Audience', null)
      expect(entriesOf(layer)[0].run).toBe(run)
      expect(kinds(layer)).toEqual(['mesh', 'mesh'])
      time.tick(2000)
      expect(kinds(layer)).toEqual(['sprite'])
    })

    it.each([
      ['mode', 'Novel', 'Audience', null],
      ['向き', 'Theater', 'Stage', null],
      ['仰角', 'Theater', 'Audience', 'LookUp'],
    ] as const)('%s が変わると回転は打ち切られる', async (_n, mode, orient, elev) => {
      const { layer } = await withFront()
      layer.replace('B.png', 0, 'A.png', '/a')
      await flush()
      layer.setCamera(mode, orient, elev)
      expect(entriesOf(layer)[0].run).toBeNull()
      expect(kinds(layer)).toEqual(['sprite'])
    })
  })
})

describe('PropLayer: 紙人形輪郭は回転中の mesh にも付く', () => {
  it('輪郭あり→mesh に付き、解除すると mesh からも外れる', async () => {
    mockLoad()
    const time = new TimeController()
    time.setMode('virtual')
    const layer = new PropLayer(W, H, time)
    layer.setCamera('Theater', 'Audience', null)
    layer.setPaperDollOutline({ color: '#111111', thickness: 2 })
    layer.add('A.png', 0, '/a', { instant: true })
    await flush()
    layer.replace('B.png', 0, 'A.png', '/a')
    await flush()
    const run = entriesOf(layer)[0].run!
    expect(run.oldMesh.filters).toHaveLength(1)
    expect(run.newMesh.filters).toHaveLength(1)
    layer.setPaperDollOutline(null)
    expect(run.oldMesh.filters).toBeNull()
    expect(run.newMesh.filters).toBeNull()
    time.tick(1000)
    expect(kinds(layer)).toEqual(['sprite'])
  })

  it('ロード待ち中の旧面にも輪郭の変更が追従する', async () => {
    const deferred = mockLoad(['B.png'])
    const time = new TimeController()
    time.setMode('virtual')
    const layer = new PropLayer(W, H, time)
    layer.setCamera('Theater', 'Audience', null)
    layer.add('A.png', 0, '/a', { instant: true })
    await flush()
    layer.replace('B.png', 0, 'A.png', '/a')
    layer.setPaperDollOutline({ color: '#111111', thickness: 2 })
    expect(entriesOf(layer)[0].pendingOld!.filters).toHaveLength(1)
    deferred['B.png'].resolve(texFor('B.png'))
    await flush()
    expect(entriesOf(layer)[0].run!.oldMesh.filters).toHaveLength(1)
  })
})
