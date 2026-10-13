/**
 * RPG レンダラー（Raycast / TopDown）がアセットのベース URL を NPC スプライト・NPC 顔・戦闘へ配線していること (#746)。
 *
 * Application の init（WebGL）は不要なので、コンストラクタ直後のインスタンスに最小限の internals を差し込んで駆動する。
 * 解決規則そのもの（resolveRpgImagePath）は novelLayout.test.ts、BattleScreen 側は BattleScreen.test.ts が担当。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container, Graphics } from 'pixi.js'
import { loadNpcSpriteSheet } from './npcSpriteSheet'
import { RaycastRenderer } from './RaycastRenderer'
import { TopDownRenderer } from './TopDownRenderer'
import type { RPGProject, UiNpcData } from '../types/rpg'

// スプライトシートの実読み込み（Assets.load / 手続き生成）は行わず、レンダラーが渡すパスだけを観測する
vi.mock('./npcSpriteSheet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./npcSpriteSheet')>()),
  loadNpcSpriteSheet: vi.fn().mockResolvedValue(null),
}))

const BASE = 'https://api.example.com/api/projects/g/assets/raw'

function npcData(over: Partial<UiNpcData> = {}): UiNpcData {
  return { name: 'N', x: 1, y: 0, color: 0xff0000, message: 'hi', ...over } as UiNpcData
}

function project(npcs: UiNpcData[], over: Partial<RPGProject> = {}): RPGProject {
  return {
    name: 't',
    version: '1.0.0',
    map: {
      width: 3,
      height: 3,
      tileSize: 32,
      tiles: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    },
    player: { x: 0, y: 0, direction: 'right' },
    npcs,
    view: 'raycast',
    ...over,
  }
}

interface RaycastInternals {
  app: { stage: Container; renderer?: object }
  npcs: unknown[]
  playerX: number
  playerY: number
  playerAngle: number
  dialogBox: { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> } | null
  tryTalk(): void
}
interface TopDownInternals {
  app: { stage: Container; renderer?: object }
  initialized: boolean
  tileSize: number
  npcs: unknown[]
  playerGridX: number
  playerGridY: number
  playerDirection: string
  inputLocked: boolean
  dialogBox: { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> } | null
  tryTalk(): void
  loadNpcSprite(npc: unknown, placeholder: Graphics): Promise<void>
}

function raycast(): { r: RaycastRenderer; i: RaycastInternals } {
  const r = new RaycastRenderer()
  const i = r as unknown as RaycastInternals
  // __demo の手続き生成は renderer を WeakMap のキーにするため、オブジェクトを差し込む
  i.app = { stage: new Container(), renderer: {} }
  i.dialogBox = { show: vi.fn(), hide: vi.fn() }
  return { r, i }
}

function topdown(): { r: TopDownRenderer; i: TopDownInternals } {
  const r = new TopDownRenderer()
  const i = r as unknown as TopDownInternals
  i.app = { stage: new Container() }
  i.dialogBox = { show: vi.fn(), hide: vi.fn() }
  return { r, i }
}

/** loadNpcSpriteSheet に渡されたスプライトパス一覧 */
function spyAssets() {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return {
    get paths() {
      return vi.mocked(loadNpcSpriteSheet).mock.calls.map((c) => c[0])
    },
  }
}

afterEach(() => {
  vi.mocked(loadNpcSpriteSheet).mockClear()
  vi.restoreAllMocks()
})

describe('RaycastRenderer: アセットのベース URL の配線 (#746)', () => {
  it('NPC スプライトの相対パスを images 配下に解決して読む', () => {
    const load = spyAssets()
    const { r } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([npcData({ sprite: 'npc/old man.png' })]))
    expect(load.paths).toContain(`${BASE}/images/npc/old man.png`)
  })

  it('ベース未設定なら NPC スプライトのパスをそのまま読む（従来どおり）', () => {
    const load = spyAssets()
    const { r } = raycast()
    r.load(project([npcData({ sprite: 'npc/a.png' })]))
    expect(load.paths).toContain('npc/a.png')
  })

  it('NPC スプライトが絶対 URL ならベースを付けない（二重付与しない）', () => {
    const load = spyAssets()
    const { r } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([npcData({ sprite: 'https://cdn.example.com/n.png' })]))
    expect(load.paths).toContain('https://cdn.example.com/n.png')
  })

  it('NPC スプライトが __demo ならベースを付けない（手続き生成の合図）', () => {
    const load = spyAssets()
    const { r } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([npcData({ sprite: '__demo' })]))
    expect(load.paths).toEqual(['__demo'])
  })

  it('会話の顔グラ（portrait）をベースで解決して DialogBox に渡す', () => {
    spyAssets()
    const { r, i } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([npcData({ portrait: 'face/a.png' })]))
    i.playerX = 0.5
    i.playerY = 0.5
    i.playerAngle = 0
    i.tryTalk()
    expect(i.dialogBox!.show).toHaveBeenCalledWith('N', 'hi', `${BASE}/images/face/a.png`)
  })

  it('表情差分（expressions）で選ばれたパスもベースで解決する', () => {
    spyAssets()
    const { r, i } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(
      project([
        npcData({
          message: '[expression=sad]hi',
          portrait: 'face/a.png',
          expressions: { sad: 'face/sad.png' },
        }),
      ])
    )
    i.playerX = 0.5
    i.playerY = 0.5
    i.playerAngle = 0
    i.tryTalk()
    expect(i.dialogBox!.show.mock.calls[0][2]).toBe(`${BASE}/images/face/sad.png`)
  })

  it('portrait 未指定なら undefined のまま（"" や base 単体にならない）', () => {
    spyAssets()
    const { r, i } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([npcData()]))
    i.playerX = 0.5
    i.playerY = 0.5
    i.playerAngle = 0
    i.tryTalk()
    expect(i.dialogBox!.show.mock.calls[0][2]).toBeUndefined()
  })

  it('setAssetBaseUrl を load の後に変えても、次の会話からは新しいベースが使われる', () => {
    spyAssets()
    const { r, i } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([npcData({ portrait: 'face/a.png' })]))
    r.setAssetBaseUrl('https://other.example.com/raw')
    i.playerX = 0.5
    i.playerY = 0.5
    i.playerAngle = 0
    i.tryTalk()
    expect(i.dialogBox!.show.mock.calls[0][2]).toBe(
      'https://other.example.com/raw/images/face/a.png'
    )
  })
})

describe('TopDownRenderer: アセットのベース URL の配線 (#746)', () => {
  function npcRuntime(over: Partial<UiNpcData> = {}) {
    const data = npcData({ sprite: 'npc/a.png', ...over })
    return {
      data,
      x: data.x,
      y: data.y,
      direction: 'down',
      container: new Container(),
      sheet: null,
    }
  }

  it('NPC スプライトの相対パスを images 配下に解決して読む', async () => {
    const load = spyAssets()
    const { r, i } = topdown()
    r.setAssetBaseUrl(BASE)
    await i.loadNpcSprite(npcRuntime({ sprite: 'npc/ひと 1.png' }), new Graphics())
    expect(load.paths).toEqual([`${BASE}/images/npc/ひと 1.png`])
  })

  it('ベース未設定ならパスをそのまま読む（従来どおり）', async () => {
    const load = spyAssets()
    const { i } = topdown()
    await i.loadNpcSprite(npcRuntime(), new Graphics())
    expect(load.paths).toEqual(['npc/a.png'])
  })

  it('会話の顔グラと表情差分をベースで解決して DialogBox に渡す', () => {
    spyAssets()
    const { r, i } = topdown()
    r.setAssetBaseUrl(BASE)
    i.inputLocked = false
    i.playerGridX = 0
    i.playerGridY = 0
    i.playerDirection = 'right'
    i.npcs = [
      npcRuntime({
        message: '[expression=sad]hi',
        portrait: 'face/a.png',
        expressions: { sad: 'face/sad.png' },
      }),
    ]
    i.tryTalk()
    expect(i.dialogBox!.show.mock.calls[0][2]).toBe(`${BASE}/images/face/sad.png`)
  })

  it('portrait 未指定なら undefined のまま', () => {
    spyAssets()
    const { r, i } = topdown()
    r.setAssetBaseUrl(BASE)
    i.playerGridX = 0
    i.playerGridY = 0
    i.playerDirection = 'right'
    i.npcs = [npcRuntime({ sprite: undefined })]
    i.tryTalk()
    expect(i.dialogBox!.show.mock.calls[0][2]).toBeUndefined()
  })
})

describe('RaycastRenderer: 戦闘への配線 (#746)', () => {
  it('startBattle で BattleScreen の opts に assetBaseUrl が渡る', () => {
    spyAssets()
    const { r, i } = raycast()
    r.setAssetBaseUrl(BASE)
    r.load(project([]))
    ;(i as unknown as { startBattle(e: unknown[]): void }).startBattle([
      { id: 's', name: 'S', hp: 1, maxHp: 1, mp: 0, maxMp: 0, atk: 1, def: 0, agi: 1 },
    ])
    const bs = (i as unknown as { battleScreen: { opts: { assetBaseUrl?: string } } }).battleScreen
    expect(bs.opts.assetBaseUrl).toBe(BASE)
  })
})
