/** BattleScreen の武器レイヤー (#1027): 人物の上に刀を重ね、ポーズごとの変換・アクスタの動きに追従する */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture, TextureSource, type Container, type Sprite } from 'pixi.js'
import { BattleScreen, opaqueBounds, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { DEFAULT_MOTION_TIMING as T } from './battleMotion'
import { computeWeaponPlacement, type BattleWeaponSpec } from './battleWeapon'
import { DUMMY_CATALOG, DUMMY_LAYERS } from './battleWeaponFixture'

const sized = (w: number, h: number): Texture =>
  new Texture({ source: new TextureSource({ width: w, height: h }) })
const SIZES: Record<string, [number, number]> = {
  'img/hero.webp': [40, 80],
  'img/blade.webp': [100, 80],
}
const POSES = {
  idle: 'img/idle.webp',
  ready: 'img/ready.webp',
  slash: 'img/slash.webp',
  hurt: 'img/hurt.webp',
  down: 'img/down.webp',
  'swing-windup': 'img/windup.webp',
  'swing-followthrough': 'img/follow.webp',
}
const WEAPON: BattleWeaponSpec = {
  image: 'img/blade.webp',
  structure: 'standing',
  anchor: { x: 0.8, y: 0.8 },
  layers: 'l.json',
  catalog: 'c.json',
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface View {
  container: Container
  sprite: Sprite
  shownPose: string
  weapon: { sprite: Sprite; front: boolean } | null
}
const pv = (s: BattleScreen): View => (s as unknown as { partyViews: View[] }).partyViews[0]

const created: BattleScreen[] = []
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url === 'l.json' ? DUMMY_LAYERS : DUMMY_CATALOG),
  }))
  vi.stubGlobal('fetch', fetchMock)
  const cache = new Map<string, Texture>()
  vi.spyOn(Assets, 'load').mockImplementation((async (p: string) => {
    if (!cache.has(p)) cache.set(p, sized(...(SIZES[p] ?? [40, 80])))
    return cache.get(p)
  }) as never)
  vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation(((
    tex: Texture
  ) => ({
    texture: sized(tex.width + 16, tex.height + 16),
    pad: 8,
    shadow: sized(64, 32),
    foot: { x: 32, y: 16 },
  })) as never)
})
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(
  over: Partial<BattleEntity> = {},
  opts: BattleScreenOptions = { spriteStyle: 'acrylic' }
) {
  const hero: BattleEntity = {
    id: 'hero',
    name: 'HERO',
    hp: 20,
    maxHp: 20,
    mp: 4,
    maxMp: 4,
    atk: 3,
    def: 1,
    agi: 2,
    sprite: 'img/hero.webp',
    poses: POSES,
    weapon: WEAPON,
    ...over,
  }
  const engine = new BattleEngine(
    [hero],
    [
      {
        ...hero,
        id: 'slime',
        name: 'SLIME',
        sprite: undefined,
        poses: undefined,
        weapon: undefined,
        atk: 1,
        hp: 999,
        maxHp: 999,
      },
    ],
    { rng: () => 0.5 }
  )
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  for (let i = 0; i < 5; i++) await flush()
  return { s, engine }
}

/** 人物の絵（全面不透明＝jsdom は画素が読めず全体）の矩形から期待する刀の置き場 */
function expected(v: View, pose: Parameters<typeof computeWeaponPlacement>[0]) {
  const w = v.weapon!.sprite
  return computeWeaponPlacement(
    pose,
    { width: w.texture.width, height: w.texture.height },
    { x: v.sprite.x, y: v.sprite.y, width: v.sprite.width, height: v.sprite.height }
  )
}

describe('BattleScreen: 武器レイヤー (#1027)', () => {
  it('idle では刀は出ない。人物の上（container の子・人物より後）に作られる', async () => {
    const { s } = await setup()
    const v = pv(s)
    expect(v.weapon).not.toBeNull()
    expect(v.weapon!.sprite.visible).toBe(false)
    expect(v.weapon!.sprite.parent).toBe(v.container)
    expect(v.container.getChildIndex(v.weapon!.sprite)).toBeGreaterThan(
      v.container.getChildIndex(v.sprite)
    )
  })

  it('通常攻撃の 5 段で、刀の変換がポーズごとに切り替わる（windup / slash / followthrough / ready）', async () => {
    const { s, engine } = await setup()
    const v = pv(s)
    engine.selectAttack()
    s.redraw(800, 450)
    const seen = new Map<
      string,
      { visible: boolean; rotation: number; scaleX: number; x: number; y: number }
    >()
    for (let t = 0; t < T.attackStepMs + T.attackSlashMs + T.attackReturnMs; t += 4) {
      s.tick(4)
      const w = v.weapon!.sprite
      if (!seen.has(v.shownPose))
        seen.set(v.shownPose, {
          visible: w.visible,
          rotation: w.rotation,
          scaleX: w.scale.x,
          x: w.x,
          y: w.y,
        })
    }
    for (const p of ['ready', 'swing-windup', 'slash', 'swing-followthrough']) {
      expect(seen.get(p)?.visible, p).toBe(true)
    }
    expect(seen.get('swing-windup')!.rotation).toBeCloseTo(Math.PI / 2) // -90 度 = 反時計の逆
    expect(seen.get('slash')!.rotation).toBeCloseTo((-45 * Math.PI) / 180)
    expect(seen.get('swing-followthrough')!.rotation).toBeCloseTo(-Math.PI / 2)
    expect(seen.get('ready')!.rotation).toBeCloseTo(0)
    // 位置は変換どおり（slash は柄が人物の絵の (0.56, 0.48)）
    expect(seen.get('slash')!.x).not.toBe(seen.get('ready')!.x)
  })

  it('slash の位置: 柄ターゲットが人物の絵の矩形の (0.56, 0.48)・高さ 0.52 倍', async () => {
    const { s, engine } = await setup()
    const v = pv(s)
    engine.selectAttack()
    s.redraw(800, 450)
    for (let t = 0; v.shownPose !== 'slash' && t < 2000; t += 4) s.tick(4)
    expect(v.shownPose).toBe('slash')
    const w = v.weapon!.sprite
    const e = expected(v, {
      heightRatio: 0.52,
      rotationDeg: 45,
      handleTarget: { x: 0.56, y: 0.48 },
      flipX: false,
    })
    expect(w.x).toBeCloseTo(e.x)
    expect(w.y).toBeCloseTo(e.y)
    expect(w.scale.y).toBeCloseTo(e.scaleY)
    expect(w.anchor.x).toBeCloseTo(0.8)
    expect(w.anchor.y).toBeCloseTo(0.8)
    expect(w.visible).toBe(true)
  })

  it('アクスタ: 刀は container の子なので、傾き・倒れの回転に絵と一緒に付いてくる', async () => {
    const { s, engine } = await setup()
    const v = pv(s)
    engine.selectAttack()
    s.redraw(800, 450)
    for (let t = 0; v.shownPose !== 'slash' && t < 2000; t += 4) s.tick(4)
    const w = v.weapon!.sprite
    expect(w.parent).toBe(v.container)
    // container を足元 pivot で回しても、刀の container 内の座標は変わらず、画面上の位置は人物と同じ回転で動く
    const local = { x: w.x, y: w.y }
    const before = w.getGlobalPosition()
    const px = v.sprite.x + v.sprite.width / 2
    const py = v.sprite.y + v.sprite.height
    v.container.pivot.set(px, py)
    v.container.position.set(v.container.x + px, v.container.y + py)
    v.container.rotation = 0.5
    expect({ x: w.x, y: w.y }).toEqual(local)
    const after = w.getGlobalPosition()
    const sp = v.sprite.getGlobalPosition()
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1)
    // 足元からの距離は回転で不変（人物と同じ剛体回転）
    // 刀の画面上の位置 = container の変換を通した、container 内の座標（人物の絵と同じ変換）
    const expectGlobal = v.container.toGlobal(local)
    expect(after.x).toBeCloseTo(expectGlobal.x)
    expect(after.y).toBeCloseTo(expectGlobal.y)
    // 人物の絵の同じ点も同じ変換で動く（比較の基準が動いていないことの確認）
    expect(sp.x).toBeCloseTo(v.container.toGlobal({ x: v.sprite.x, y: v.sprite.y }).x)
  })

  it('被弾 (hurt)・倒れ (down) のポーズでは刀を隠す', async () => {
    const { s } = await setup()
    const v = pv(s)
    const u = s as unknown as { updateWeapon(view: View): void }
    for (const p of ['hurt', 'down', 'idle']) {
      v.shownPose = p
      u.updateWeapon(v)
      expect(v.weapon!.sprite.visible, p).toBe(false)
    }
    v.shownPose = 'ready'
    u.updateWeapon(v)
    expect(v.weapon!.sprite.visible).toBe(true)
  })

  it('刀の指定が無ければ従来どおり（武器レイヤーなし・子の数も同じ・fetch も呼ばない）', async () => {
    const { s } = await setup({ weapon: undefined })
    const v = pv(s)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(v.weapon).toBeNull()
    const withWeapon = await setup()
    expect(v.container.children.length).toBe(pv(withWeapon.s).container.children.length - 1)
    expect(fetchMock).toHaveBeenCalled() // 比較側（刀あり）だけが読む
  })

  it('dq（presentation 既定）では刀を読まない', async () => {
    const { s } = await setup({}, { spriteStyle: 'acrylic', presentation: 'dq' })
    expect(pv(s).weapon).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('柄アンカーが決まらない（spec にも catalog にも無い）なら警告して刀なし', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { s } = await setup({ weapon: { ...WEAPON, anchor: undefined, catalog: undefined } })
    expect(pv(s).weapon).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('layers JSON が 404（読めず undefined）のときは警告を出す（刀は出ない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockImplementation(async (url: string) =>
      url === 'l.json' ? { ok: false } : { ok: true, json: async () => DUMMY_CATALOG }
    )
    const { s } = await setup()
    expect(pv(s).weapon!.sprite.visible).toBe(false)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('layers JSON "l.json"'))).toBe(true)
  })

  it('JSON が読めなくても落ちない（変換が無いので刀は出ない）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValue(new Error('404'))
    const { s, engine } = await setup()
    const v = pv(s)
    engine.selectAttack()
    s.redraw(800, 450)
    for (let t = 0; t < 400; t += 4) s.tick(4)
    expect(v.weapon!.sprite.visible).toBe(false)
  })
})

describe('opaqueBounds の実画素経由 (#1027)', () => {
  afterEach(() => vi.restoreAllMocks())

  /** jsdom には canvas の実装が無いので、2D コンテキストの getImageData に合成の RGBA を返させる */
  function withPixels(w: number, h: number, opaque: (x: number, y: number) => boolean): Texture {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = opaque(x, y) ? 255 : 0
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: () => {},
      getImageData: () => ({ data }),
    })) as never)
    const tex = sized(w, h)
    ;(tex.source as unknown as { resource: unknown }).resource = {}
    return tex
  }

  it('不透明部分だけの範囲（比）を返す', () => {
    // 20x10 の絵の x 5..14・y 2..7 だけ不透明
    const tex = withPixels(20, 10, (x, y) => x >= 5 && x <= 14 && y >= 2 && y <= 7)
    expect(opaqueBounds(tex)).toEqual({ x: 5 / 20, y: 2 / 10, w: 10 / 20, h: 6 / 10 })
  })

  it('完全に透明なら全体（切り詰め済みとみなす）', () => {
    expect(opaqueBounds(withPixels(8, 8, () => false))).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('画素が読めない（context なし・resource なし）なら全体', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => null) as never)
    const t1 = sized(8, 8)
    ;(t1.source as unknown as { resource: unknown }).resource = {}
    expect(opaqueBounds(t1)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(opaqueBounds(sized(8, 8))).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})
