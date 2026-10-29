/**
 * 回転舞台 `[舞台回転]` (#704 第2弾) の配線テスト: `StageTurnController` と実物の 4 レイヤー
 * （壁・背景板・床・大道具）を組み合わせ、
 *  - 裏側の指定の収集範囲（範囲外はためない・閉じたら捨てる・空なら警告）
 *  - シアターでは旧面全体が一斉に退場し、新面全体が一斉に登場（全板が同じ角度）
 *  - 保存状態（getState）は回転の前から最終状態
 *  - ノベル・スキップ・書き出し・reduced-motion・時間 0 は即時
 *  - 割り込み（再指定・clear・復元・書き出し・カメラ変更/ズームのみ）
 *  - 新面ロード待ち中は旧面を残す・ロード失敗
 *  - 第1弾の `回転:`（個別の面の切り替え）との共存
 *  - 動画の壁は回さず回転の中間で入れ替わる
 * を縛る。テクスチャは実 Texture（PerspectiveMesh が必要とする）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Assets, BufferImageSource, Container, PerspectiveMesh, Sprite, Texture } from 'pixi.js'
import { BackgroundBoardLayer } from './BackgroundBoardLayer'
import { FloorLayer } from './FloorLayer'
import { PropLayer } from './PropLayer'
import { VideoLayer } from './VideoLayer'
import { WallLayer } from './WallLayer'
import { TimeController } from './TimeController'
import {
  STAGE_TURN_MAX_WAIT_MS,
  StageTurnController,
  StageTurnRun,
  computeStageTurnCorners,
  computeStageTurnView,
} from './stageTurn'
import { computeStageTurnAngles } from './stageTurn'

const W = 800
const H = 450

function tex(w: number, h: number): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(4), width: w, height: h }),
  })
}

// 旧面と新面の取り違えを検出できるよう、寸法を変えておく。
const SIZES: Record<string, [number, number]> = {
  'A.png': [800, 450],
  'B.png': [400, 800],
  'C.png': [1600, 450],
  'D.png': [300, 300],
}
const TEXTURES: Record<string, Texture> = {}
const texFor = (name: string): Texture => {
  const [w, h] = SIZES[name] ?? [W, H]
  return (TEXTURES[name] ??= tex(w, h))
}

const mq = { matches: false }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => mq })
})
afterEach(() => {
  vi.restoreAllMocks()
  mq.matches = false
})

interface Deferred {
  resolve: (t: Texture) => void
  reject: (e: unknown) => void
}
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

const meshesIn = (host: Container | undefined): PerspectiveMesh[] =>
  (host?.children ?? []).filter((c): c is PerspectiveMesh => c instanceof PerspectiveMesh)
/** レイヤー内の回転用 host（`sortableChildren` を持つ Container）。無ければ undefined。 */
const hostOf = (layer: Container): Container | undefined =>
  layer.children.find((c) => c instanceof Container && c.sortableChildren) as Container | undefined
const sprites = (layer: Container): Sprite[] =>
  layer.children.filter((c): c is Sprite => c instanceof Sprite)
const corners = (m: PerspectiveMesh): number[] =>
  Array.from((m.geometry as unknown as { corners: ArrayLike<number> }).corners)

type Mode = 'Theater' | 'Novel'

async function setup(opts: { mode?: Mode; defer?: string[]; oldStage?: boolean } = {}) {
  const mode = opts.mode ?? 'Theater'
  const deferred = mockLoad(opts.defer)
  const time = new TimeController()
  time.setMode('virtual')
  const prop = new PropLayer(W, H, time)
  const board = new BackgroundBoardLayer(W, H, time)
  const wall = new WallLayer(W, H)
  const floor = new FloorLayer(W, H)
  prop.setCamera(mode, 'Audience', null)
  board.setCamera(mode, 'Audience', null)
  const flags = { theater: mode === 'Theater', skip: false, exporting: false, defaultMs: 1000 }
  const ctrl = new StageTurnController(
    {
      layers: () => ({ wall, backgroundBoard: board, floor, prop }),
      isTheater: () => flags.theater,
      isSkip: () => flags.skip,
      isExporting: () => flags.exporting,
      defaultMs: () => flags.defaultMs,
      screenSize: () => ({ width: W, height: H }),
    },
    time
  )
  if (opts.oldStage !== false) {
    prop.add('A.png', 2, '/a', { instant: true })
    board.add('A.png', 3, '/a', { instant: true })
    wall.show('A.png', {}, '/a')
    floor.show('A.png', 0.25, '/a')
    await flush()
  }
  const back = (name = 'B.png'): void => {
    ctrl.defer(() => wall.show(name, {}, '/a'))
    ctrl.defer(() => board.add(name, 3, '/a'))
    ctrl.defer(() => prop.add(name, 2, '/a'))
    ctrl.defer(() => floor.show(name, 0.25, '/a'))
  }
  /** `[舞台回転]` + 裏側 4 種 + 範囲の終わり。 */
  const turn = async (ms: number | null = 1000, name = 'B.png'): Promise<void> => {
    ctrl.begin(ms)
    back(name)
    ctrl.flush()
    await flush()
  }
  return { time, prop, board, wall, floor, ctrl, flags, deferred, back, turn }
}
type Stage = Awaited<ReturnType<typeof setup>>
const hosts = (s: Stage): Array<Container | undefined> => [
  hostOf(s.wall),
  hostOf(s.board),
  hostOf(s.floor),
  hostOf(s.prop),
]
const stateOf = (s: Stage) => ({
  prop: s.prop.getState(),
  board: s.board.getState(),
  wall: s.wall.getState(),
  floor: s.floor.getState(),
})
const NEW_STATE = {
  prop: [{ path: 'B.png', depth: 2 }],
  board: [{ path: 'B.png', depth: 3 }],
  wall: { path: 'B.png', loop: true, mute: true },
  floor: { path: 'B.png', height: 0.25 },
}

describe('裏側の指定の収集範囲', () => {
  it('[舞台回転] が無ければためない（defer は false）。範囲を閉じたあともためない', async () => {
    const s = await setup()
    const fn = vi.fn()
    expect(s.ctrl.defer(fn)).toBe(false)
    s.ctrl.begin(500)
    expect(s.ctrl.isOpen).toBe(true)
    expect(s.ctrl.defer(fn)).toBe(true)
    expect(fn).not.toHaveBeenCalled()
    s.ctrl.flush()
    expect(s.ctrl.isOpen).toBe(false)
    expect(s.ctrl.defer(fn)).toBe(false)
  })

  it('範囲の間は実行されず、閉じたときに書いた順に流し込まれる', async () => {
    const s = await setup()
    const order: string[] = []
    s.ctrl.begin(500)
    s.ctrl.defer(() => order.push('wall'))
    s.ctrl.defer(() => order.push('board'))
    s.ctrl.defer(() => order.push('prop'))
    expect(order).toEqual([])
    s.ctrl.flush()
    expect(order).toEqual(['wall', 'board', 'prop'])
  })

  it('裏側の指定が 1 つも無いなら何も回さず警告する（旧面は残る）', async () => {
    const s = await setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = stateOf(s)
    s.ctrl.begin(500)
    s.ctrl.flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(stateOf(s)).toEqual(before)
    expect(sprites(s.prop)).toHaveLength(1)
  })

  it('cancel は範囲ごと捨てる（ためた指定は流し込まれず、警告も出ない）', async () => {
    const s = await setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fn = vi.fn()
    s.ctrl.begin(500)
    s.ctrl.defer(fn)
    s.ctrl.cancel()
    s.ctrl.flush()
    expect(fn).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('連続する [舞台回転] は後勝ち（所要時間は最後の指定、省略なら既定）', async () => {
    const s = await setup()
    s.ctrl.begin(300)
    s.ctrl.begin(1200)
    s.back()
    s.ctrl.flush()
    expect(s.ctrl.run?.durationMs).toBe(1200)
    await flush()
    s.ctrl.begin(300)
    s.ctrl.begin(null)
    s.back('C.png')
    s.ctrl.flush()
    expect(s.ctrl.run?.durationMs).toBe(1000) // 既定 = character_fade_ms
  })

  it('所要時間は 0〜5000 にクランプされる', async () => {
    const s = await setup()
    s.ctrl.begin(99999)
    s.back()
    s.ctrl.flush()
    expect(s.ctrl.run?.durationMs).toBe(5000)
  })
})

describe('シアター: 舞台全体が一斉に回る', () => {
  it('保存状態は回転の前から最終状態（新しい壁・背景板・大道具・床）', async () => {
    const s = await setup()
    await s.turn()
    expect(stateOf(s)).toEqual(NEW_STATE)
    s.time.tick(300)
    expect(stateOf(s)).toEqual(NEW_STATE)
    s.time.tick(2000)
    expect(stateOf(s)).toEqual(NEW_STATE)
  })

  it('開始直後は 4 レイヤーとも旧面 mesh が見え、新面 mesh は隠れている。個別の sprite は載っていない', async () => {
    const s = await setup()
    await s.turn()
    expect(s.ctrl.run?.started).toBe(true)
    for (const h of hosts(s)) {
      const m = meshesIn(h)
      expect(m).toHaveLength(2)
      expect(m.filter((x) => x.visible)).toHaveLength(1)
    }
    for (const layer of [s.wall, s.board, s.floor, s.prop]) {
      expect(sprites(layer)).toHaveLength(0)
      expect(layer.children.some((c) => c.constructor.name === 'TilingSprite')).toBe(false)
    }
  })

  it('前半は旧面が全レイヤーで見え、中間で全レイヤーが同時に新面へ切り替わり、終わると sprite になる', async () => {
    const s = await setup()
    await s.turn(1000)
    const visibleRoles = (): string[] =>
      hosts(s).map((h) => {
        const m = meshesIn(h)
        // 旧面は先に追加される（addOld が resolveNew より前）。
        return `${m[0].visible ? 'old' : '-'}/${m[1].visible ? 'new' : '-'}`
      })
    s.time.tick(100)
    expect(visibleRoles()).toEqual(Array(4).fill('old/-'))
    s.time.tick(300) // 400ms
    expect(visibleRoles()).toEqual(Array(4).fill('old/-'))
    s.time.tick(150) // 550ms: 中間を越えた
    expect(visibleRoles()).toEqual(Array(4).fill('-/new'))
    s.time.tick(100)
    expect(visibleRoles()).toEqual(Array(4).fill('-/new'))
    s.time.tick(500) // 1150ms: 終了
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(sprites(s.prop).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(sprites(s.board).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(sprites(s.wall).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(s.floor.hasImage()).toBe(true)
  })

  it('全板が同じ軸（画面中央）・同じ角度で回る: 各 mesh の四隅は共通の view と角度から求めた値と一致する', async () => {
    const s = await setup()
    // 旧大道具（A.png・depth 2）の静止時の配置を回転の前に控える。
    const e = (
      s.prop as unknown as {
        entries: Array<{
          targetX: number
          targetY: number
          targetWidth: number
          targetHeight: number
        }>
      }
    ).entries[0]
    const geom = { x: e.targetX, y: e.targetY, width: e.targetWidth, height: e.targetHeight }
    await s.turn(1000)
    const view = computeStageTurnView(W, H)
    // 描画は 16ms 刻みのタイマーで進むので、16 の倍数に満たない分は切り捨てられる（250 → 240）。
    s.time.tick(250)
    const angleOld = computeStageTurnAngles(240, 1000).old.angleRad
    expect(angleOld).toBeGreaterThan(0.1) // 実際に回っている
    const c = corners(meshesIn(hostOf(s.prop))[0])
    const exp = computeStageTurnCorners(geom, angleOld, view)
    const arr = [exp.x0, exp.y0, exp.x1, exp.y1, exp.x2, exp.y2, exp.x3, exp.y3]
    for (let i = 0; i < 8; i++) expect(Math.abs(c[i] - arr[i])).toBeLessThan(0.5)
    // 全レイヤーの旧面 mesh は同じ向きに回っている（正の角度では右辺が奥 = 右辺のほうが縦に小さい）。
    for (const h of hosts(s)) {
      const k = corners(meshesIn(h)[0])
      const leftH = k[7] - k[1]
      const rightH = k[5] - k[3]
      expect(rightH).toBeLessThan(leftH)
    }
  })

  it('新面が -90° 側から現れる: 後半の頭は軸のそばで細く、終盤に向かって本来の幅へ広がる', async () => {
    const s = await setup()
    await s.turn(1000)
    const width = (): number => {
      const k = corners(meshesIn(hostOf(s.board))[1])
      return Math.max(k[0], k[2], k[4], k[6]) - Math.min(k[0], k[2], k[4], k[6])
    }
    s.time.tick(520)
    const early = width()
    s.time.tick(250)
    const mid = width()
    s.time.tick(200)
    const late = width()
    expect(early).toBeLessThan(mid)
    expect(mid).toBeLessThan(late)
  })

  it('旧面が無い（何も表示していない）状態からでも新面だけが現れて終わる', async () => {
    const s = await setup({ oldStage: false })
    await s.turn(1000)
    for (const h of hosts(s)) expect(meshesIn(h)).toHaveLength(1)
    s.time.tick(100)
    for (const h of hosts(s)) expect(meshesIn(h)[0].visible).toBe(false)
    s.time.tick(500)
    for (const h of hosts(s)) expect(meshesIn(h)[0].visible).toBe(true)
    s.time.tick(600)
    expect(s.ctrl.run).toBeNull()
    expect(stateOf(s)).toEqual(NEW_STATE)
    expect(sprites(s.prop)).toHaveLength(1)
  })

  it('裏側が一部のレイヤーだけでも、旧面全体が退場する（指定の無いレイヤーは空になる）', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.flush()
    await flush()
    // 床・壁・背景板の旧面も回って消える。
    for (const h of [hostOf(s.wall), hostOf(s.board), hostOf(s.floor)]) {
      expect(meshesIn(h)).toHaveLength(1)
    }
    expect(s.wall.getState()).toBeNull()
    expect(s.floor.getState()).toBeNull()
    expect(s.board.getState()).toEqual([])
    s.time.tick(2000)
    expect(s.wall.hasImage()).toBe(false)
    expect(s.floor.hasImage()).toBe(false)
    expect(sprites(s.board)).toHaveLength(0)
    expect(sprites(s.prop)).toHaveLength(1)
  })

  it('[壁: なし] [床: なし] を含む裏側: 旧い壁・床は回って消え、何も戻らない', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.wall.clear())
    s.ctrl.defer(() => s.floor.clear())
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.flush()
    await flush()
    expect(s.ctrl.run).not.toBeNull() // clear は回転を打ち切らない
    expect(meshesIn(hostOf(s.wall))).toHaveLength(1)
    expect(meshesIn(hostOf(s.floor))).toHaveLength(1)
    s.time.tick(2000)
    expect(s.wall.getState()).toBeNull()
    expect(s.floor.getState()).toBeNull()
    expect(s.wall.hasImage()).toBe(false)
    expect(s.floor.hasImage()).toBe(false)
  })

  it('同じ範囲で同じスロットを 2 回指定したら最後が新面（壁・床は単一スロット）', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.wall.show('C.png', {}, '/a'))
    s.ctrl.defer(() => s.wall.show('B.png', {}, '/a'))
    s.ctrl.defer(() => s.floor.show('C.png', 0.25, '/a'))
    s.ctrl.defer(() => s.floor.clear())
    s.ctrl.flush()
    await flush()
    expect(s.wall.getState()?.path).toBe('B.png')
    expect(s.floor.getState()).toBeNull()
    // 壁: 旧面 + B の 2 枚（C は取り消された）。
    expect(meshesIn(hostOf(s.wall))).toHaveLength(2)
    s.time.tick(2000)
    expect(sprites(s.wall).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(s.floor.hasImage()).toBe(false)
  })

  it('回転を始める前は全ての新面のロードを待つ。待っている間は旧面が角度 0 のまま残る', async () => {
    const s = await setup({ defer: ['B.png'] })
    await s.turn(1000)
    // B.png が全レイヤーでロード待ち。回転は始まらない。
    expect(s.ctrl.run?.started).toBe(false)
    s.time.tick(2500)
    expect(s.ctrl.run?.started).toBe(false)
    for (const h of hosts(s)) {
      const m = meshesIn(h)
      expect(m).toHaveLength(1)
      expect(m[0].visible).toBe(true)
    }
    // 旧大道具の mesh は旧 sprite と同じ矩形（角度 0）。
    const k = corners(meshesIn(hostOf(s.prop))[0])
    expect(k[0]).toBeLessThan(k[2])
    expect(k[1]).toBeCloseTo(k[3], 3)
    // 保存状態は待っている間も最終状態。
    expect(stateOf(s)).toEqual(NEW_STATE)
  })

  it('新面のロードが全部そろった時点で回り始め、その時点から所要時間を数える', async () => {
    const s = await setup({ defer: ['B.png'] })
    const calls: Array<(t: Texture) => void> = []
    vi.spyOn(Assets, 'load').mockImplementation(((url: string) => {
      const name = String(url).split('/').pop()!
      if (name === 'B.png') return new Promise<Texture>((r) => calls.push(r))
      return Promise.resolve(texFor(name))
    }) as never)
    await s.turn(1000)
    expect(calls).toHaveLength(4)
    s.time.tick(2500)
    calls.slice(0, 3).forEach((r) => r(texFor('B.png')))
    await flush()
    expect(s.ctrl.run?.started).toBe(false)
    calls[3](texFor('B.png'))
    await flush()
    expect(s.ctrl.run?.started).toBe(true)
    s.time.tick(400)
    expect(meshesIn(hostOf(s.prop))[0].visible).toBe(true) // まだ前半
    s.time.tick(200)
    expect(meshesIn(hostOf(s.prop))[0].visible).toBe(false)
  })

  it('新面のロードに失敗しても、その面なしで回転は進み、最終状態に落ち着く（宣言は残る）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = await setup()
    vi.spyOn(Assets, 'load').mockImplementation(((url: string) => {
      const name = String(url).split('/').pop()!
      if (name === 'B.png' && url.includes('images')) return Promise.reject(new Error('404'))
      return Promise.resolve(texFor(name))
    }) as never)
    await s.turn(1000)
    expect(warn).toHaveBeenCalled()
    expect(s.ctrl.run?.started).toBe(true)
    expect(stateOf(s)).toEqual(NEW_STATE)
    s.time.tick(2000)
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(sprites(s.prop)).toHaveLength(0) // 読めなかった大道具は出ない
    expect(s.wall.hasImage()).toBe(false)
  })

  it('assetBaseUrl が空なら読み込まず、新面なしとして回転は進む（ロード待ちで固まらない）', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.prop.add('B.png', 2, ''))
    s.ctrl.defer(() => s.floor.show('B.png', 0.25, ''))
    s.ctrl.defer(() => s.wall.show('B.png', {}, ''))
    s.ctrl.flush()
    await flush()
    expect(s.ctrl.run?.started).toBe(true)
    s.time.tick(2000)
    expect(s.ctrl.run).toBeNull()
  })
})

describe('即時になる条件（同じ最終状態、回転 mesh は作らない）', () => {
  const cases: Array<[string, (s: Stage) => void, number | null]> = [
    ['ノベル', (s) => void (s.flags.theater = false), 1000],
    ['スキップ中', (s) => void (s.flags.skip = true), 1000],
    ['動画書き出し中', (s) => void (s.flags.exporting = true), 1000],
    ['prefers-reduced-motion', () => void (mq.matches = true), 1000],
    ['時間 0', () => {}, 0],
  ]
  it.each(cases)('%s', async (_n, arm, ms) => {
    const s = await setup()
    arm(s)
    s.ctrl.begin(ms)
    s.back()
    s.ctrl.flush()
    // 旧面は即座に無くなっている。
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    await flush()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(stateOf(s)).toEqual(NEW_STATE)
    expect(sprites(s.prop).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(sprites(s.board).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(sprites(s.wall).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect(s.floor.hasImage()).toBe(true)
  })

  it('ノベルのカメラでも最終状態は回転と同じ（旧面は全消去）', async () => {
    const s = await setup({ mode: 'Novel' })
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.flush()
    await flush()
    expect(s.wall.getState()).toBeNull()
    expect(s.floor.getState()).toBeNull()
    expect(s.board.getState()).toEqual([])
    expect(s.prop.getState()).toEqual([{ path: 'B.png', depth: 2 }])
  })
})

describe('割り込み', () => {
  it('回転中の再指定: 先の回転は最終状態へ畳まれ、その舞台が今度の旧面になる', async () => {
    const s = await setup()
    await s.turn(1000, 'B.png')
    s.time.tick(300)
    const first = s.ctrl.run
    await s.turn(1000, 'C.png')
    expect(first?.ended).toBe(true)
    expect(s.ctrl.run).not.toBe(first)
    expect(stateOf(s).wall?.path).toBe('C.png')
    // 今度の旧面は B.png（先の回転の最終状態）。
    const oldProp = meshesIn(hostOf(s.prop))[0]
    expect(oldProp.texture).toBe(texFor('B.png'))
    s.time.tick(3000)
    expect(sprites(s.prop).map((x) => x.texture)).toEqual([texFor('C.png')])
  })

  it('回転中の各レイヤー clear（場面転換・新規開始・復元）で打ち切り、全レイヤーの mesh が消える', async () => {
    for (const which of ['prop', 'board', 'wall', 'floor'] as const) {
      const s = await setup()
      await s.turn(1000)
      s.time.tick(200)
      s[which].clear()
      expect(s.ctrl.run).toBeNull()
      expect(hosts(s).every((h) => h === undefined)).toBe(true)
    }
  })

  it('回転中の restore は最終状態へ即時（回転しない・mesh が残らない）', async () => {
    const s = await setup()
    await s.turn(1000)
    s.time.tick(200)
    s.prop.restore([{ path: 'D.png', depth: 1 }], '/a')
    await flush()
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(s.prop.getState()).toEqual([{ path: 'D.png', depth: 1 }])
    expect(sprites(s.prop)).toHaveLength(1)
    s.wall.restore({ path: 'D.png', loop: true, mute: true }, '/a')
    s.floor.restore({ path: 'D.png', height: 0.25 }, '/a')
    await flush()
    expect(s.wall.hasImage()).toBe(true)
  })

  it('壁・床の restore は、同じ状態への復元でも回転を畳む（再読み込みはしない）', async () => {
    for (const act of [
      (s: Stage) => s.wall.restore({ path: 'B.png', loop: true, mute: true }, '/a'),
      (s: Stage) => s.floor.restore({ path: 'B.png', height: 0.25 }, '/a'),
    ]) {
      const s = await setup()
      await s.turn(1000)
      s.time.tick(200)
      act(s)
      expect(s.ctrl.run).toBeNull()
      expect(hosts(s).every((h) => h === undefined)).toBe(true)
    }
  })

  it('動画書き出しの開始で最終状態へ畳む（タイマーも止まる）', async () => {
    const s = await setup()
    await s.turn(1000)
    s.time.tick(200)
    s.prop.setExporting(true)
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(sprites(s.wall).map((x) => x.texture)).toEqual([texFor('B.png')])
    expect((s.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
  })

  it('カメラの mode / 向き / 仰角が変わると打ち切り、ズームだけ（setCamera 同値）なら続く', async () => {
    const s = await setup()
    await s.turn(1000)
    s.time.tick(200)
    // ズームは setCamera の引数が変わらない → 続行。
    s.prop.setCamera('Theater', 'Audience', null)
    s.board.setCamera('Theater', 'Audience', null)
    expect(s.ctrl.run).not.toBeNull()
    expect(hostOf(s.prop)).toBeDefined()
    s.time.tick(100)
    expect(s.ctrl.run).not.toBeNull()
    // 向きが変わると打ち切る。
    s.prop.setCamera('Theater', 'Stage', null)
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(sprites(s.board).map((x) => x.texture)).toEqual([texFor('B.png')])
  })

  it('仰角・mode の変化でも打ち切る', async () => {
    for (const change of [
      (s: Stage) => s.board.setCamera('Theater', 'Audience', 'LookUp'),
      (s: Stage) => s.board.setCamera('Novel', 'Audience', null),
    ]) {
      const s = await setup()
      await s.turn(1000)
      change(s)
      expect(s.ctrl.run).toBeNull()
    }
  })

  it('回転中に dispose 相当（clear + destroy）しても落ちず、タイマーが残らない', async () => {
    const s = await setup()
    await s.turn(1000)
    s.time.tick(200)
    for (const l of [s.wall, s.board, s.floor, s.prop]) l.clear()
    for (const l of [s.wall, s.board, s.floor, s.prop]) l.destroy({ children: true })
    expect((s.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
    s.time.tick(5000)
  })

  it('回転が自然に終わるとタイマーも mesh も残らない', async () => {
    const s = await setup()
    await s.turn(1000)
    s.time.tick(1500)
    expect((s.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
    for (const layer of [s.wall, s.board, s.floor, s.prop]) {
      expect(layer.children.some((c) => c instanceof PerspectiveMesh)).toBe(false)
    }
  })
})

describe('回転中の範囲外の再指定', () => {
  it('範囲を閉じたあとの add / show は先の回転を最終状態へ畳み、そのうえで普通に足される', async () => {
    for (const act of [
      (s: Stage) => s.prop.add('C.png', 5, '/a'),
      (s: Stage) => s.board.add('C.png', 5, '/a'),
      (s: Stage) => s.wall.show('C.png', {}, '/a'),
      (s: Stage) => s.floor.show('C.png', 0.3, '/a'),
      (s: Stage) => s.prop.replace('C.png', 2, 'B.png', '/a'),
    ]) {
      const s = await setup()
      await s.turn(1000)
      s.time.tick(200)
      act(s)
      expect(s.ctrl.run).toBeNull()
      expect(hosts(s).every((h) => h === undefined)).toBe(true)
      await flush()
    }
  })
})

describe('スキップ判定は範囲を開く時点の値も見る', () => {
  it('スキップ中に開いた範囲は、閉じる時点でスキップが解除されていても即時（待機・選択肢の到達で解除される）', async () => {
    const s = await setup()
    s.flags.skip = true
    s.ctrl.begin(1000)
    s.back()
    s.flags.skip = false // [待機] / 選択肢が setSkipMode(false) した後
    s.ctrl.flush()
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    await flush()
    expect(stateOf(s)).toEqual(NEW_STATE)
  })

  it('スキップでない範囲は従来どおり回る（開く時点で false なら閉じる時点が true でも、閉じる時点の値で即時）', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.back()
    s.ctrl.flush()
    expect(s.ctrl.run).not.toBeNull()
    const t = await setup()
    t.ctrl.begin(1000)
    t.back()
    t.flags.skip = true
    t.ctrl.flush()
    expect(t.ctrl.run).toBeNull()
  })

  it('連続する [舞台回転] の途中でスキップに入っても即時（|| で保持）', async () => {
    const s = await setup()
    s.flags.skip = true
    s.ctrl.begin(1000)
    s.flags.skip = false
    s.ctrl.begin(1000)
    s.back()
    s.ctrl.flush()
    expect(s.ctrl.run).toBeNull()
  })
})

describe('流し込み中の例外', () => {
  it('裏側の指定が例外を投げても run は seal され、回転が始まる（旧面が残り続けない）', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.defer(() => {
      throw new Error('boom')
    })
    expect(() => s.ctrl.flush()).toThrow('boom')
    await flush()
    expect(s.ctrl.run?.started).toBe(true)
    s.time.tick(2000)
    expect(s.ctrl.run).toBeNull()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
    expect(sprites(s.prop).map((x) => x.texture)).toEqual([texFor('B.png')])
  })
})

describe('新面のロード待ちの上限', () => {
  it('着かない新面は上限で見切って回り始め、遅れて着いた面は回転の終わりに現れる。タイマーは残らない', async () => {
    const s = await setup({ defer: ['B.png'] })
    await s.turn(1000)
    expect(s.ctrl.run?.started).toBe(false)
    expect(STAGE_TURN_MAX_WAIT_MS).toBe(3000)
    s.time.tick(2900)
    expect(s.ctrl.run?.started).toBe(false)
    s.time.tick(200)
    expect(s.ctrl.run?.started).toBe(true)
    // 着いていない新面なしで回る（旧面だけが見え、後半は何も見えない）。
    for (const h of hosts(s)) expect(meshesIn(h)).toHaveLength(1)
    s.time.tick(2000)
    expect(s.ctrl.run).toBeNull()
    expect((s.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
    // 遅れて着く（run は終了済み）。落ちず、最終状態に出る。
    s.deferred['B.png'].resolve(texFor('B.png'))
    await flush()
    expect(hosts(s).every((h) => h === undefined)).toBe(true)
  })

  it('上限より前に全て着けば待ちタイマーは解除される。打ち切り・clear でも残らない', async () => {
    const s = await setup()
    await s.turn(1000)
    s.time.tick(3000)
    expect((s.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
    const t = await setup({ defer: ['B.png'] })
    await t.turn(1000)
    t.prop.clear()
    expect(t.ctrl.run).toBeNull()
    expect((t.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
    t.time.tick(10000)
  })

  it('ロード待ち中に次の [舞台回転] が来ても、先の run は畳まれ、遅れて着いた面は無視される（競合）', async () => {
    const s = await setup({ defer: ['B.png'] })
    await s.turn(1000, 'B.png')
    expect(s.ctrl.run?.started).toBe(false)
    const first = s.ctrl.run
    await s.turn(1000, 'C.png')
    expect(first?.ended).toBe(true)
    expect(s.ctrl.run).not.toBe(first)
    s.deferred['B.png'].resolve(texFor('B.png'))
    await flush()
    expect(stateOf(s).wall?.path).toBe('C.png')
    expect(stateOf(s).prop).toEqual([{ path: 'C.png', depth: 2 }])
    s.time.tick(3000)
    expect(s.ctrl.run).toBeNull()
    expect(sprites(s.prop).map((x) => x.texture)).toEqual([texFor('C.png')])
    expect((s.time as unknown as { timers: unknown[] }).timers).toHaveLength(0)
  })
})

describe('StageTurnRun の後始末', () => {
  it('終わった run への addOld / resolveNew は、渡された焼き込みテクスチャを破棄する', () => {
    const time = new TimeController()
    time.setMode('virtual')
    const run = new StageTurnRun(time, computeStageTurnView(W, H), 100)
    const token = run.expectNew()
    run.seal()
    run.finish()
    const owned1 = texFor('D.png')
    const owned2 = tex(10, 10)
    const d1 = vi.spyOn(owned1, 'destroy').mockImplementation(() => {})
    const d2 = vi.spyOn(owned2, 'destroy').mockImplementation(() => {})
    const host = new Container()
    run.addOld(host, texFor('A.png'), { x: 0, y: 0, width: 1, height: 1 }, 0, {
      ownedTexture: owned1,
    })
    run.resolveNew(token, host, texFor('A.png'), { x: 0, y: 0, width: 1, height: 1 }, 0, {
      ownedTexture: owned2,
    })
    expect(d1).toHaveBeenCalledWith(true)
    expect(d2).toHaveBeenCalledWith(true)
    expect(host.children).toHaveLength(0)
  })
})

describe('第1弾の `回転:`（個別の面の切り替え）との共存', () => {
  it('裏側に `回転: 旧` が書かれていても個別の回転にはならず、舞台全体の回転が優先される', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    // `[大道具: B.png, depth: 2, 回転: A.png]` — A.png は旧舞台のものだが、旧舞台は既に回転へ渡されている。
    s.ctrl.defer(() => s.prop.replace('B.png', 2, 'A.png', '/a', { flipMs: 300, skip: false }))
    s.ctrl.defer(() => s.board.replace('B.png', 3, 'A.png', '/a', { flipMs: 300, skip: false }))
    s.ctrl.flush()
    await flush()
    // 個別の回転 run（entry.run）は作られず、舞台の host に旧面と新面の mesh が 1 組ずつ。
    for (const layer of [s.prop, s.board]) {
      const entries = (
        layer as unknown as { entries: Array<{ run: unknown; pendingOld: unknown }> }
      ).entries
      expect(entries.every((e) => e.run === null && e.pendingOld === null)).toBe(true)
      expect(meshesIn(hostOf(layer))).toHaveLength(2)
    }
    expect(s.prop.getState()).toEqual([{ path: 'B.png', depth: 2 }])
    // 所要時間は舞台回転の 1000ms（個別指定の 300ms は無視）。
    s.time.tick(600)
    expect(s.ctrl.run).not.toBeNull()
    s.time.tick(500)
    expect(s.ctrl.run).toBeNull()
  })

  it('同じ範囲で追加した板を `回転:` で差し替えても、置き換わるだけ（旧面は舞台の旧面のまま）', async () => {
    const s = await setup()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.defer(() => s.prop.replace('C.png', 2, 'B.png', '/a', { flipMs: 300 }))
    s.ctrl.flush()
    await flush()
    expect(s.prop.getState()).toEqual([{ path: 'C.png', depth: 2 }])
    const m = meshesIn(hostOf(s.prop))
    expect(m).toHaveLength(2) // 旧舞台の A + 新 C
    expect(m.map((x) => x.texture)).toEqual([texFor('A.png'), texFor('C.png')])
  })

  it('個別の面の切り替え（第1弾）の回転・ロード待ちは hasPendingFlip（[待機: 表示完了] が待つ）で見える', async () => {
    for (const layer of ['prop', 'board'] as const) {
      const s = await setup({ defer: ['B.png'] })
      const l = s[layer]
      expect(l.hasPendingFlip()).toBe(false)
      l.replace('B.png', layer === 'prop' ? 2 : 3, 'A.png', '/a', { flipMs: 500 })
      expect(l.hasPendingFlip()).toBe(true) // 新面のロード待ち（旧面を残している）
      s.deferred['B.png'].resolve(texFor('B.png'))
      await flush()
      expect(l.hasPendingFlip()).toBe(true) // 回転中
      s.time.tick(1000)
      expect(l.hasPendingFlip()).toBe(false)
    }
  })

  it('舞台回転が無い通常の `回転:` は従来どおり（個別の面の切り替え、舞台 host は作られない）', async () => {
    const s = await setup()
    s.prop.replace('B.png', 2, 'A.png', '/a', { flipMs: 500, skip: false })
    await flush()
    expect(hostOf(s.prop)).toBeUndefined()
    const entries = (s.prop as unknown as { entries: Array<{ run: unknown }> }).entries
    expect(entries[0].run).not.toBeNull()
  })
})

describe('動画の壁は回さず、回転の中間で入れ替わる', () => {
  it('旧い動画の壁は中間まで残り、新しい動画の壁は中間から現れる', async () => {
    const show = vi.spyOn(VideoLayer.prototype, 'show').mockImplementation(() => {})
    const remove = vi.spyOn(VideoLayer.prototype, 'remove').mockImplementation(() => {})
    vi.spyOn(VideoLayer.prototype, 'setAssetBaseUrl').mockImplementation(() => {})
    const s = await setup({ oldStage: false })
    s.wall.show('old.webm', {}, '/a')
    s.prop.add('A.png', 2, '/a', { instant: true })
    await flush()
    show.mockClear()
    remove.mockClear()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.wall.show('new.webm', {}, '/a'))
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.flush()
    await flush()
    // 回転の最中も保存状態は新しい壁。動画はまだ入れ替わっていない。
    expect(s.wall.getState()?.path).toBe('new.webm')
    expect(remove).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    s.time.tick(400)
    expect(remove).not.toHaveBeenCalled()
    s.time.tick(150)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0][0]).toBe('new.webm')
    s.time.tick(1000)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('回転が打ち切られても、新しい動画の壁は必ず現れる', async () => {
    const show = vi.spyOn(VideoLayer.prototype, 'show').mockImplementation(() => {})
    vi.spyOn(VideoLayer.prototype, 'remove').mockImplementation(() => {})
    vi.spyOn(VideoLayer.prototype, 'setAssetBaseUrl').mockImplementation(() => {})
    const s = await setup({ oldStage: false })
    s.prop.add('A.png', 2, '/a', { instant: true })
    await flush()
    s.ctrl.begin(1000)
    s.ctrl.defer(() => s.wall.show('new.webm', {}, '/a'))
    s.ctrl.defer(() => s.prop.add('B.png', 2, '/a'))
    s.ctrl.flush()
    await flush()
    s.time.tick(100)
    s.prop.setExporting(true)
    expect(show).toHaveBeenCalledTimes(1)
  })
})
