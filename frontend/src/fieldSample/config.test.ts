import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULTS,
  DIAGONAL_FACINGS,
  configNotice,
  findReturnLink,
  forceBattleCandidates,
  parseConfig,
  parseConfigText,
  pickConfigSource,
  type FieldSampleConfig,
} from './config'
import type { FieldLink } from '../game/fieldWalk'
import teramachiSample from './teramachi.sample.json?raw'
import diagonalSample from './diagonal-walk.sample.json?raw'

const BASE = 'https://example.com/field/config.json'

/** 1 項目ずつ壊すための、最小の有効設定（毎回新しいオブジェクトを返す） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>
function minimal(): Raw {
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]
  return {
    startScene: 'a',
    start: { x: 10, y: 20 },
    player: {
      sprites: {
        up: frames('up'),
        down: frames('down'),
        left: frames('left'),
        right: frames('right'),
      },
    },
    scenes: {
      a: { background: 'a.png', mask: 'a-mask.png' },
    },
  }
}

/** minimal() を 1 か所だけ変えた設定を作る */
function mutated(fn: (c: Raw) => void): Raw {
  const c = minimal()
  fn(c)
  return c
}

/** 戦闘ありの設定（モンスターとエンカウントを足す） */
function withEncounter(): Raw {
  const c = minimal()
  c.monsters = { slime: { name: 'スライム', hp: 10 } }
  c.scenes.a.encounter = { rate: 5, groups: ['slime'] }
  return c
}

function ok(raw: unknown): FieldSampleConfig {
  const r = parseConfig(raw, BASE)
  if (!r.ok) throw new Error(`ok のはずが失敗: ${r.error}`)
  return r.value
}

describe('foreground 前面レイヤー (#866)', () => {
  const parse = (c: Raw) => parseConfig(c, BASE)
  it('省略は undefined（既存設定は変わらない）', () => {
    const r = parse(minimal())
    if (!r.ok) throw new Error(r.error)
    expect(r.value.scenes.a.foreground).toBeUndefined()
    expect('foreground' in r.value.scenes.a).toBe(false)
  })
  it('URL に解決される（相対は設定 JSON 基準・assetBaseUrl は images 配下）', () => {
    const c = mutated((c) => (c.scenes.a.foreground = 'a-fg.png'))
    const r = parse(c)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.scenes.a.foreground).toBe('https://example.com/field/a-fg.png')
    const c2 = mutated((c) => {
      c.assetBaseUrl = 'https://cdn.example.com/g'
      c.scenes.a.foreground = 'maps/a-fg.png'
    })
    const r2 = parse(c2)
    if (!r2.ok) throw new Error(r2.error)
    expect(r2.value.scenes.a.foreground).toBe('https://cdn.example.com/g/images/maps/a-fg.png')
  })
  it('文字列以外・空文字は、パスつきのエラー', () => {
    for (const bad of [1, '', '  ', null, {}]) {
      const r = parse(mutated((c) => (c.scenes.a.foreground = bad)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('scenes.a.foreground')
    }
  })
})

describe('warps / shake / scroll (#864)', () => {
  const parse = (c: Raw) => parseConfig(c, BASE)
  const withScene = (c: Raw) => {
    c.scenes.b = { background: 'b.png', mask: 'b-mask.png' }
    return c
  }
  const ok = (c: Raw) => {
    const r = parse(c)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  it('省略は空（既存設定は変わらない）', () => {
    const v = ok(minimal())
    expect(v.warps).toEqual({})
    expect('shake' in v.scenes.a).toBe(false)
    expect('scroll' in v.scenes.a).toBe(false)
  })
  it('warps: 既定は fade・時間は演出の既定、上書きできる', () => {
    const v = ok(
      withScene(
        mutated((c) => {
          c.warps = {
            w1: { to: 'b', at: { x: 5, y: 6 } },
            w2: {
              to: 'a',
              at: { x: 1, y: 2 },
              facing: 'up',
              effect: 'flash',
              holdMs: 0,
              outMs: 10,
            },
          }
        })
      )
    )
    expect(v.warps.w1).toEqual({
      id: 'w1',
      to: 'b',
      at: { x: 5, y: 6 },
      effect: 'fade',
      timing: { outMs: 400, holdMs: 200, inMs: 400 },
    })
    expect(v.warps.w2.facing).toBe('up')
    expect(v.warps.w2.effect).toBe('flash')
    expect(v.warps.w2.timing).toEqual({ outMs: 10, holdMs: 0, inMs: 500 })
  })
  it('warps: 不正はパスつきエラー（to 不明・at 不正・facing・effect・時間の負）', () => {
    const bad: Array<[string, unknown]> = [
      ['to', { to: 'zzz', at: { x: 0, y: 0 } }],
      ['at', { to: 'a', at: { x: 'x', y: 0 } }],
      ['at', { to: 'a' }],
      ['facing', { to: 'a', at: { x: 0, y: 0 }, facing: 'upLeft' }],
      ['effect', { to: 'a', at: { x: 0, y: 0 }, effect: 'spin' }],
      ['holdMs', { to: 'a', at: { x: 0, y: 0 }, holdMs: -1 }],
      ['outMs', { to: 'a', at: { x: 0, y: 0 }, outMs: NaN }],
    ]
    for (const [key, w] of bad) {
      const r = parse(mutated((c) => (c.warps = { w1: w })))
      expect(r.ok, key).toBe(false)
      if (!r.ok) expect(r.error, key).toContain(`warps.w1.${key}`)
    }
    expect(parse(mutated((c) => (c.warps = []))).ok).toBe(false)
  })
  it('warps: 時間 0 は許す（その区間を飛ばす）', () => {
    const v = ok(mutated((c) => (c.warps = { w: { to: 'a', at: { x: 0, y: 0 }, outMs: 0 } })))
    expect(v.warps.w.timing.outMs).toBe(0)
  })
  it('shake: amplitudeY は必須の正数、periodMs の既定は 600', () => {
    const v = ok(mutated((c) => (c.scenes.a.shake = { amplitudeY: 3 })))
    expect(v.scenes.a.shake).toEqual({ amplitudeY: 3, periodMs: 600 })
    for (const sh of [
      {},
      { amplitudeY: 0 },
      { amplitudeY: -1 },
      { amplitudeY: 3, periodMs: 0 },
      5,
    ]) {
      const r = parse(mutated((c) => (c.scenes.a.shake = sh)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('scenes.a.shake')
    }
  })
  it('scroll: image は URL に解決・speed は負も 0 も可・y の既定は 0', () => {
    const v = ok(mutated((c) => (c.scenes.a.scroll = { image: 'sky.png', speed: -120 })))
    expect(v.scenes.a.scroll).toEqual({
      image: 'https://example.com/field/sky.png',
      speed: -120,
      y: 0,
    })
    const v0 = ok(mutated((c) => (c.scenes.a.scroll = { image: 'sky.png', speed: 0, y: 40 })))
    expect(v0.scenes.a.scroll?.speed).toBe(0)
    expect(v0.scenes.a.scroll?.y).toBe(40)
  })
  it('scroll: image 無し・speed が数値でない・y が数値でないはエラー', () => {
    for (const sc of [
      { speed: 1 },
      { image: 'a.png' },
      { image: 'a.png', speed: '1' },
      { image: 'a.png', speed: Infinity },
      { image: 'a.png', speed: 1, y: 'x' },
      3,
    ]) {
      const r = parse(mutated((c) => (c.scenes.a.scroll = sc)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('scenes.a.scroll')
    }
  })
})

describe('flags / assist / companion (#862)', () => {
  const parse = (c: Raw) => parseConfig(c, BASE)
  const ok = (c: Raw) => {
    const r = parse(c)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]
  const companionRaw = () => ({
    sprites: { up: frames('cu'), down: frames('cd'), left: frames('cl'), right: frames('cr') },
  })
  const withAssist = (a: Raw = { requires: 'after' }): Raw =>
    mutated((c) => {
      c.flags = { after: false, refuse: false, dead: false }
      c.assist = a
    })

  it('省略は flags 空・assist/companion なし（既存設定は変わらない）', () => {
    const v = ok(minimal())
    expect(v.flags).toEqual({})
    expect(v.assist).toBeNull()
    expect(v.companion).toBeNull()
  })
  it('flags: 真偽値だけ。初期値を保つ', () => {
    expect(ok(mutated((c) => (c.flags = { a: true, b: false }))).flags).toEqual({
      a: true,
      b: false,
    })
    for (const bad of [{ a: 1 }, { a: 'true' }, { a: null }, [], 'x']) {
      expect(parse(mutated((c) => (c.flags = bad))).ok).toBe(false)
    }
  })
  it('assist: requires は 1 つの文字列でも配列でもよく、既定値が入る', () => {
    const v = ok(withAssist({ requires: 'after' }))
    expect(v.assist).toEqual({
      requires: ['after'],
      speedFactor: 0.7,
      ghostAlpha: 0.5,
      offset: 40,
      fadeMs: 200,
    })
    const v2 = ok(withAssist({ requires: ['after', 'dead'], unless: 'refuse', ghostWhen: 'dead' }))
    expect(v2.assist?.requires).toEqual(['after', 'dead'])
    expect(v2.assist?.unless).toBe('refuse')
    expect(v2.assist?.ghostWhen).toBe('dead')
  })
  it('assist: 上書きできる（fadeMs 0 は即時、ghostAlpha 0/1 は境界として可）', () => {
    const v = ok(
      withAssist({ requires: 'after', speedFactor: 1, ghostAlpha: 0, offset: 10, fadeMs: 0 })
    )
    expect(v.assist).toMatchObject({ speedFactor: 1, ghostAlpha: 0, offset: 10, fadeMs: 0 })
    expect(ok(withAssist({ requires: 'after', ghostAlpha: 1 })).assist?.ghostAlpha).toBe(1)
  })
  it('assist: 宣言していないフラグ名・requires 無し/空はパスつきエラー', () => {
    const bad: Array<[string, Raw]> = [
      ['assist.requires', { requires: 'nope' }],
      ['assist.requires[1]', { requires: ['after', 'nope'] }],
      ['assist.requires', {}],
      ['assist.requires', { requires: [] }],
      ['assist.requires', { requires: 5 }],
      ['assist.unless', { requires: 'after', unless: 'nope' }],
      ['assist.ghostWhen', { requires: 'after', ghostWhen: 'nope' }],
    ]
    for (const [path, a] of bad) {
      const r = parse(withAssist(a))
      expect(r.ok, path).toBe(false)
      if (!r.ok) expect(r.error, path).toContain(path)
    }
  })
  it('assist: 数値の範囲（speedFactor>0・offset>0・ghostAlpha 0..1・fadeMs>=0）', () => {
    const bad: Array<[string, Raw]> = [
      ['speedFactor', { speedFactor: 0 }],
      ['speedFactor', { speedFactor: -1 }],
      ['offset', { offset: 0 }],
      ['ghostAlpha', { ghostAlpha: 1.01 }],
      ['ghostAlpha', { ghostAlpha: -0.01 }],
      ['ghostAlpha', { ghostAlpha: '0.5' }],
      ['fadeMs', { fadeMs: -1 }],
    ]
    for (const [key, extra] of bad) {
      const r = parse(withAssist({ requires: 'after', ...extra }))
      expect(r.ok, key).toBe(false)
      if (!r.ok) expect(r.error, key).toContain(`assist.${key}`)
    }
    expect(parse(withAssist('x' as unknown as Raw)).ok).toBe(false)
  })
  it('companion: 4 方向×3 コマを URL に解決・height は任意', () => {
    const c = withAssist()
    c.companion = companionRaw()
    const v = ok(c)
    expect(v.companion?.sprites.up[0]).toBe('https://example.com/field/cu1.png')
    expect(v.companion?.height).toBeUndefined()
    c.companion.height = 80
    expect(ok(c).companion?.height).toBe(80)
  })
  it('companion: 方向の欠け・コマ数違い・height 不正・assist なしはエラー', () => {
    const noLeft = withAssist()
    noLeft.companion = companionRaw()
    delete noLeft.companion.sprites.left
    const r1 = parse(noLeft)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain('companion.sprites.left')
    const two = withAssist()
    two.companion = companionRaw()
    two.companion.sprites.up = ['a.png', 'b.png']
    expect(parse(two).ok).toBe(false)
    const hb = withAssist()
    hb.companion = { ...companionRaw(), height: 0 }
    const r2 = parse(hb)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toContain('companion.height')
    const lone = mutated((c) => (c.companion = companionRaw()))
    const r3 = parse(lone)
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.error).toContain('companion')
    expect(parse(mutated((c) => (c.companion = 3))).ok).toBe(false)
  })
})

describe('playerHeight (#810)', () => {
  it('既定の player.height は 96', () => {
    expect(DEFAULTS.height).toBe(96)
    expect(ok(minimal()).player.height).toBe(96)
  })
  it('シーンの playerHeight を読む・未指定は undefined（全体値を使う）', () => {
    const raw = minimal()
    raw.scenes.a.playerHeight = 60
    raw.scenes.b = { background: 'b.png', mask: 'b-mask.png' }
    const c = ok(raw)
    expect(c.scenes.a.playerHeight).toBe(60)
    expect(c.scenes.b.playerHeight).toBeUndefined()
    expect('playerHeight' in c.scenes.b).toBe(false)
  })
})

describe('parseConfig 正常系 (Issue #807/#809)', () => {
  it('最小設定が ok で既定値が入る', () => {
    const c = ok(minimal())
    expect(c.startScene).toBe('a')
    expect(c.start).toEqual({ x: 10, y: 20 })
    expect(c.speed).toBe(DEFAULTS.speed)
    expect(c.edgeThreshold).toBe(DEFAULTS.edgeThreshold)
    expect(c.player.height).toBe(DEFAULTS.height)
    expect(c.player.frameMs).toBe(DEFAULTS.frameMs)
    expect(c.encounter).toEqual({
      stepDistance: DEFAULTS.stepDistance,
      minSteps: DEFAULTS.minSteps,
    })
    expect(c.battle).toEqual({
      layout: 'side',
      spriteStyle: 'none',
      width: DEFAULTS.battleWidth,
      height: DEFAULTS.battleHeight,
    })
    expect(c.scenes.a.links).toEqual([])
    expect(c.monsters).toEqual({})
  })

  it('同梱のサンプル teramachi.sample.json が ok', () => {
    const r = parseConfigText(teramachiSample, 'http://localhost:8780/teramachi.sample.json')
    if (!r.ok) throw new Error(r.error)
    expect(Object.keys(r.value.scenes).length).toBeGreaterThan(0)
  })

  it('寺町サンプルの銭湯の下端リンクは歩ける幅いっぱい [930,1535]、坂の上端は [1024,1420] (#938)', () => {
    const r = parseConfigText(teramachiSample, 'http://localhost:8780/teramachi.sample.json')
    if (!r.ok) throw new Error(r.error)
    const bottom = r.value.scenes.bathhouse.links.find((l) => l.edge === 'bottom')
    const top = r.value.scenes.slope.links.find((l) => l.edge === 'top')
    expect(bottom?.range).toEqual([930, 1535])
    expect(top?.range).toEqual([1024, 1420])
  })

  it('同梱サンプルの素材 URL は sit-by-me の現行パスの形（assets/images/...webp）をしている。パスの形だけを確かめ、ファイルの実在は確かめない (#938)', () => {
    for (const raw of [teramachiSample, diagonalSample]) {
      const urls = [...raw.matchAll(/"(http:\/\/localhost:8765\/[^"]+)"/g)].map((m) => m[1])
      expect(urls.length).toBeGreaterThan(0)
      for (const u of urls) expect(u).toMatch(/^http:\/\/localhost:8765\/assets\/images\/.+\.webp$/)
    }
  })

  it('相対 URL は baseUrl を基準に解決される', () => {
    const c = ok(minimal())
    expect(c.scenes.a.background).toBe('https://example.com/field/a.png')
    expect(c.scenes.a.mask).toBe('https://example.com/field/a-mask.png')
    expect(c.player.sprites.up[0]).toBe('https://example.com/field/up1.png')
  })

  it('絶対 URL はそのまま', () => {
    const c = ok(mutated((r) => (r.scenes.a.background = 'https://cdn.example.org/bg.png')))
    expect(c.scenes.a.background).toBe('https://cdn.example.org/bg.png')
  })

  it('assetBaseUrl があると `${base}/images/...` に解決される', () => {
    const c = ok(mutated((r) => (r.assetBaseUrl = 'https://cdn.example.com/game')))
    expect(c.scenes.a.background).toBe('https://cdn.example.com/game/images/a.png')
    expect(c.player.sprites.left[2]).toBe('https://cdn.example.com/game/images/left3.png')
  })

  it('空白だけの assetBaseUrl は無視される', () => {
    const c = ok(mutated((r) => (r.assetBaseUrl = '   ')))
    expect(c.scenes.a.background).toBe('https://example.com/field/a.png')
  })

  it('party 省略で hero が補完される', () => {
    const c = ok(minimal())
    expect(c.party).toHaveLength(1)
    expect(c.party[0].id).toBe('hero')
  })

  it('party が空配列でも hero が補完される', () => {
    const c = ok(mutated((r) => (r.party = [])))
    expect(c.party).toHaveLength(1)
    expect(c.party[0].id).toBe('hero')
  })

  it('party の sprite が URL に解決される', () => {
    const c = ok(
      mutated((r) => (r.party = [{ name: 'ゆうしゃ', hp: 20, sprite: 'hero/pose.png' }]))
    )
    expect(c.party[0].sprite).toBe('https://example.com/field/hero/pose.png')
    expect(c.party[0].name).toBe('ゆうしゃ')
    expect(c.party[0].hp).toBe(20)
    expect(c.party[0].maxHp).toBe(20)
  })

  it('monsters の exp / gold を省略すると 0', () => {
    const c = ok(withEncounter())
    expect(c.monsters.slime.exp).toBe(0)
    expect(c.monsters.slime.gold).toBe(0)
    expect(c.monsters.slime.id).toBe('slime')
  })

  it('encounter 省略のシーンは encounter が null', () => {
    expect(ok(minimal()).scenes.a.encounter).toBeNull()
  })

  it('encounter ありのシーンは rate と groups を持つ', () => {
    expect(ok(withEncounter()).scenes.a.encounter).toEqual({ rate: 5, groups: ['slime'] })
  })

  it('群の新書式（個数・重み・配置）は monsters 照合で id だけを見る (#839)', () => {
    const c = ok(
      mutated((r) => {
        r.monsters = { slime: { name: 'スライム', hp: 10 }, bit: { name: 'ビット', hp: 5 } }
        r.scenes.a.encounter = { rate: 5, groups: ['slime*3', 'slime*1..2+bit@E1:2'] }
      })
    )
    expect(c.scenes.a.encounter?.groups).toEqual(['slime*3', 'slime*1..2+bit@E1:2'])
  })

  it('新書式でも未知の id は monsters にありませんで失敗', () => {
    const r = parseConfig(
      mutated((c) => {
        c.monsters = { slime: { name: 'スライム', hp: 10 } }
        c.scenes.a.encounter = { rate: 5, groups: ['slime*3+ghost@B1:2'] }
      }),
      BASE
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('"ghost"')
  })

  it.each(['slime*0', 'slime*1..', 'slime:0', 'slime*3..1', 'slime@1A'])(
    '群の構文エラー %s は parseConfig で失敗する (#839)',
    (g) => {
      const r = parseConfig(
        mutated((c) => {
          c.monsters = { slime: { name: 'スライム', hp: 10 } }
          c.scenes.a.encounter = { rate: 5, groups: [g] }
        }),
        BASE
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(`"${g}"`)
    }
  )

  it('encounter.rate=0 と小数 0.5 は ok、groups が空配列も ok', () => {
    const c0 = ok(mutated((r) => (r.scenes.a.encounter = { rate: 0, groups: [] })))
    expect(c0.scenes.a.encounter?.rate).toBe(0)
    const c05 = ok(mutated((r) => (r.scenes.a.encounter = { rate: 0.5, groups: [] })))
    expect(c05.scenes.a.encounter?.rate).toBe(0.5)
  })

  it('encounter.minSteps=0 は ok', () => {
    const c = ok(mutated((r) => (r.encounter = { minSteps: 0 })))
    expect(c.encounter.minSteps).toBe(0)
  })

  it('range が a==b の link は ok', () => {
    const c = ok(
      mutated((r) => {
        r.scenes.b = { background: 'b.png', mask: 'b-mask.png' }
        r.scenes.a.links = [{ edge: 'right', range: [100, 100], to: 'b' }]
      })
    )
    expect(c.scenes.a.links[0]).toEqual({ edge: 'right', range: [100, 100], to: 'b' })
  })

  it('encounter.background と battle.background は URL に解決される', () => {
    const c = ok(
      mutated((r) => {
        r.scenes.a.encounter = { rate: 0, groups: [], background: 'enc.png' }
        r.battle = { background: 'battle.png', layout: 'front', spriteStyle: 'acrylic' }
      })
    )
    expect(c.scenes.a.encounter?.background).toBe('https://example.com/field/enc.png')
    expect(c.battle.background).toBe('https://example.com/field/battle.png')
    expect(c.battle.layout).toBe('front')
    expect(c.battle.spriteStyle).toBe('acrylic')
  })

  it('groups の `+` 連結で空白付きでも monsters にあれば ok', () => {
    const c = withEncounter()
    c.monsters.ghost = { name: 'ゴースト', hp: 14 }
    c.scenes.a.encounter = { rate: 3, groups: ['slime + ghost'] }
    expect(parseConfig(c, BASE).ok).toBe(true)
  })
})

describe('parseConfig 異常系 (Issue #807/#809)', () => {
  it('JSON 構文エラーは ok=false', () => {
    const r = parseConfigText('{ not json', BASE)
    expect(r.ok).toBe(false)
  })

  it.each([
    ['配列', []],
    ['null', null],
    ['文字列', 'x'],
    ['数値', 3],
  ])('ルートが %s なら不正', (_n, raw) => {
    expect(parseConfig(raw, BASE).ok).toBe(false)
  })

  const bad: [string, (c: Raw) => void][] = [
    ['scenes が空', (c) => (c.scenes = {})],
    ['scenes が配列', (c) => (c.scenes = [])],
    ['scenes が欠落', (c) => delete c.scenes],
    ['startScene が未知', (c) => (c.startScene = 'zzz')],
    ['startScene が非文字列', (c) => (c.startScene = 1)],
    ['startScene が欠落', (c) => delete c.startScene],
    ['start が欠落', (c) => delete c.start],
    ['start.x が非数値', (c) => (c.start.x = 'a')],
    ['start.y が NaN', (c) => (c.start.y = NaN)],
    ['start.x が Infinity', (c) => (c.start.x = Infinity)],
    ['start が文字列', (c) => (c.start = '10,20')],
    ['speed が 0', (c) => (c.speed = 0)],
    ['speed が負', (c) => (c.speed = -1)],
    ['speed が NaN', (c) => (c.speed = NaN)],
    ['speed が文字列', (c) => (c.speed = '260')],
    ['edgeThreshold が 0', (c) => (c.edgeThreshold = 0)],
    ['edgeThreshold が負', (c) => (c.edgeThreshold = -3)],
    ['edgeThreshold が NaN', (c) => (c.edgeThreshold = NaN)],
    ['edgeThreshold が文字列', (c) => (c.edgeThreshold = '6')],
    ['player.height が 0', (c) => (c.player.height = 0)],
    ['player.height が負', (c) => (c.player.height = -1)],
    ['player.height が NaN', (c) => (c.player.height = NaN)],
    ['player.height が文字列', (c) => (c.player.height = '150')],
    ['scenes.a.playerHeight が 0', (c) => (c.scenes.a.playerHeight = 0)],
    ['scenes.a.playerHeight が負', (c) => (c.scenes.a.playerHeight = -1)],
    ['scenes.a.playerHeight が NaN', (c) => (c.scenes.a.playerHeight = NaN)],
    ['scenes.a.playerHeight が文字列', (c) => (c.scenes.a.playerHeight = '60')],
    ['player.frameMs が 0', (c) => (c.player.frameMs = 0)],
    ['player.frameMs が負', (c) => (c.player.frameMs = -1)],
    ['player.frameMs が NaN', (c) => (c.player.frameMs = NaN)],
    ['player.frameMs が文字列', (c) => (c.player.frameMs = '140')],
    ['player が欠落', (c) => delete c.player],
    ['player.sprites が欠落', (c) => delete c.player.sprites],
    ['sprites.up が配列でない', (c) => (c.player.sprites.up = 'up.png')],
    ['sprites.down が長さ 2', (c) => (c.player.sprites.down = ['a', 'b'])],
    ['sprites.left が長さ 4', (c) => (c.player.sprites.left = ['a', 'b', 'c', 'd'])],
    ['sprites.right が欠落', (c) => delete c.player.sprites.right],
    ['sprites の URL が空文字', (c) => (c.player.sprites.up[1] = '')],
    ['sprites の URL が空白のみ', (c) => (c.player.sprites.up[1] = '   ')],
    ['sprites の URL が非文字列', (c) => (c.player.sprites.up[2] = 5)],
    ['シーンがオブジェクトでない', (c) => (c.scenes.a = 'x')],
    ['シーンが配列', (c) => (c.scenes.a = [])],
    ['background が欠落', (c) => delete c.scenes.a.background],
    ['mask が欠落', (c) => delete c.scenes.a.mask],
    ['background が解決不能な URL', (c) => (c.scenes.a.background = 'http://')],
    ['links が配列でない', (c) => (c.scenes.a.links = {})],
    ['link がオブジェクトでない', (c) => (c.scenes.a.links = ['x'])],
    ['link.edge が不正', (c) => (c.scenes.a.links = [{ edge: 'middle', range: [0, 1], to: 'a' }])],
    ['link.edge が欠落', (c) => (c.scenes.a.links = [{ range: [0, 1], to: 'a' }])],
    ['range が非配列', (c) => (c.scenes.a.links = [{ edge: 'left', range: 5, to: 'a' }])],
    ['range の長さが 1', (c) => (c.scenes.a.links = [{ edge: 'left', range: [5], to: 'a' }])],
    ['range の長さが 3', (c) => (c.scenes.a.links = [{ edge: 'left', range: [1, 2, 3], to: 'a' }])],
    ['range が非数値', (c) => (c.scenes.a.links = [{ edge: 'left', range: ['1', '2'], to: 'a' }])],
    ['range が逆順', (c) => (c.scenes.a.links = [{ edge: 'left', range: [10, 5], to: 'a' }])],
    ['range に NaN', (c) => (c.scenes.a.links = [{ edge: 'left', range: [NaN, 5], to: 'a' }])],
    [
      'range に Infinity',
      (c) => (c.scenes.a.links = [{ edge: 'left', range: [0, Infinity], to: 'a' }]),
    ],
    [
      'link.to が未知のシーン',
      (c) => (c.scenes.a.links = [{ edge: 'left', range: [0, 1], to: 'zzz' }]),
    ],
    ['link.to が欠落', (c) => (c.scenes.a.links = [{ edge: 'left', range: [0, 1] }])],
    ['encounter がオブジェクトでない', (c) => (c.scenes.a.encounter = 5)],
    ['encounter.rate が負', (c) => (c.scenes.a.encounter = { rate: -1, groups: [] })],
    ['encounter.rate が NaN', (c) => (c.scenes.a.encounter = { rate: NaN, groups: [] })],
    ['encounter.rate が文字列', (c) => (c.scenes.a.encounter = { rate: '5', groups: [] })],
    ['encounter.rate が欠落', (c) => (c.scenes.a.encounter = { groups: [] })],
    ['encounter.groups が非配列', (c) => (c.scenes.a.encounter = { rate: 1, groups: 'slime' })],
    ['encounter.groups が欠落', (c) => (c.scenes.a.encounter = { rate: 1 })],
    [
      'encounter.groups に非文字列要素',
      (c) => (c.scenes.a.encounter = { rate: 1, groups: ['slime', 3] }),
    ],
    [
      'encounter.background の URL が不正',
      (c) => (c.scenes.a.encounter = { rate: 0, groups: [], background: '' }),
    ],
    [
      'encounter.background が解決不能',
      (c) => (c.scenes.a.encounter = { rate: 0, groups: [], background: 'http://' }),
    ],
    [
      'groups のモンスター id が monsters に無い',
      (c) => {
        c.monsters = {}
        c.scenes.a.encounter = { rate: 1, groups: ['slime'] }
      },
    ],
    [
      'groups の `+` 連結の途中に未知 id（空白付き）',
      (c) => {
        c.monsters = { slime: { name: 'スライム', hp: 10 } }
        c.scenes.a.encounter = { rate: 1, groups: ['slime + ghost'] }
      },
    ],
    ['encounter（全体）がオブジェクトでない', (c) => (c.encounter = 5)],
    ['encounter.stepDistance が 0', (c) => (c.encounter = { stepDistance: 0 })],
    ['encounter.stepDistance が負', (c) => (c.encounter = { stepDistance: -80 })],
    ['encounter.minSteps が負', (c) => (c.encounter = { minSteps: -1 })],
    ['encounter.minSteps が小数', (c) => (c.encounter = { minSteps: 1.5 })],
    ['encounter.minSteps が文字列', (c) => (c.encounter = { minSteps: '3' })],
    ['monsters がオブジェクトでない', (c) => (c.monsters = [])],
    ['monsters の要素がオブジェクトでない', (c) => (c.monsters = { slime: 'x' })],
    ['monsters の name が欠落', (c) => (c.monsters = { slime: { hp: 10 } })],
    ['monsters の name が空白', (c) => (c.monsters = { slime: { name: '  ', hp: 10 } })],
    ['monsters の hp が欠落', (c) => (c.monsters = { slime: { name: 's' } })],
    ['monsters の hp が負', (c) => (c.monsters = { slime: { name: 's', hp: -1 } })],
    ['monsters の hp が 0', (c) => (c.monsters = { slime: { name: 's', hp: 0 } })],
    ['monsters の hp が NaN', (c) => (c.monsters = { slime: { name: 's', hp: NaN } })],
    [
      'monsters の sprite が空文字',
      (c) => (c.monsters = { slime: { name: 's', hp: 1, sprite: '' } }),
    ],
    ['party が配列でない', (c) => (c.party = {})],
    ['party の要素の name が欠落', (c) => (c.party = [{ hp: 10 }])],
    ['party の要素の hp が負', (c) => (c.party = [{ name: 'a', hp: -5 }])],
    ['battle がオブジェクトでない', (c) => (c.battle = 'x')],
    ['battle.layout が不正', (c) => (c.battle = { layout: 'diagonal' })],
    ['battle.spriteStyle が不正', (c) => (c.battle = { spriteStyle: 'glass' })],
    ['battle.width が 0', (c) => (c.battle = { width: 0 })],
    ['battle.width が負', (c) => (c.battle = { width: -800 })],
    ['battle.height が 0', (c) => (c.battle = { height: 0 })],
    ['battle.height が負', (c) => (c.battle = { height: -1 })],
    ['battle.background の URL が不正', (c) => (c.battle = { background: '' })],
    ['battle.background が解決不能', (c) => (c.battle = { background: 'http://' })],
  ]

  it.each(bad)('%s なら不正', (_name, fn) => {
    const r = parseConfig(mutated(fn), BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  it('エラーメッセージが原因の項目名を含む（startScene）', () => {
    const r = parseConfig(
      mutated((c) => (c.startScene = 'zzz')),
      BASE
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('startScene')
  })
})

describe('parseConfig プロトタイプキー (B2, Issue #807/#809)', () => {
  it("startScene: 'constructor' は不正", () => {
    expect(
      parseConfig(
        mutated((c) => (c.startScene = 'constructor')),
        BASE
      ).ok
    ).toBe(false)
  })

  it("link の to: 'toString' は不正", () => {
    const c = mutated((r) => {
      r.scenes.a.links = [{ edge: 'left', range: [0, 10], to: 'toString' }]
    })
    expect(parseConfig(c, BASE).ok).toBe(false)
  })

  it("groups の 'constructor' は不正（monsters に無い）", () => {
    const c = mutated((r) => {
      r.monsters = { slime: { name: 'スライム', hp: 10 } }
      r.scenes.a.encounter = { rate: 1, groups: ['constructor'] }
    })
    expect(parseConfig(c, BASE).ok).toBe(false)
  })

  it("groups の `+` 連結の途中の 'toString' も不正", () => {
    const c = mutated((r) => {
      r.monsters = { slime: { name: 'スライム', hp: 10 } }
      r.scenes.a.encounter = { rate: 1, groups: ['slime+toString'] }
    })
    expect(parseConfig(c, BASE).ok).toBe(false)
  })
})

describe('findReturnLink (Issue #807)', () => {
  const toB: FieldLink = { edge: 'right', range: [0, 10], to: 'b' }

  function configOf(scenes: Record<string, FieldLink[]>): FieldSampleConfig {
    const raw = minimal()
    raw.scenes = {}
    for (const [id, links] of Object.entries(scenes)) {
      raw.scenes[id] = { background: `${id}.png`, mask: `${id}-m.png`, links }
    }
    raw.startScene = Object.keys(scenes)[0]
    return ok(raw)
  }

  it('遷移先に戻りリンクがあればそれを返す', () => {
    const back: FieldLink = { edge: 'left', range: [0, 10], to: 'a' }
    const c = configOf({ a: [toB], b: [back] })
    expect(findReturnLink(c, 'a', toB)).toEqual(back)
  })

  it('複数あれば反対側の辺を優先する', () => {
    const same: FieldLink = { edge: 'right', range: [0, 10], to: 'a' }
    const opposite: FieldLink = { edge: 'left', range: [20, 30], to: 'a' }
    const c = configOf({ a: [toB], b: [same, opposite] })
    expect(findReturnLink(c, 'a', toB)).toEqual(opposite)
  })

  it('反対側が無ければ最初の候補を返す', () => {
    const first: FieldLink = { edge: 'top', range: [0, 10], to: 'a' }
    const second: FieldLink = { edge: 'bottom', range: [0, 10], to: 'a' }
    const c = configOf({ a: [toB], b: [first, second] })
    expect(findReturnLink(c, 'a', toB)).toEqual(first)
  })

  it('戻りリンクが無ければ null（別シーンへのリンクしか無い場合も）', () => {
    const other: FieldLink = { edge: 'left', range: [0, 10], to: 'c' }
    const c = configOf({ a: [toB], b: [other], c: [] })
    expect(findReturnLink(c, 'a', toB)).toBeNull()
  })

  it('遷移先シーンが存在しなければ null', () => {
    const c = configOf({ a: [] })
    expect(findReturnLink(c, 'a', { edge: 'right', range: [0, 10], to: 'nowhere' })).toBeNull()
  })

  it('遷移先がプロトタイプキーでも null（hasOwn で守る）', () => {
    const c = configOf({ a: [] })
    expect(findReturnLink(c, 'a', { edge: 'right', range: [0, 10], to: 'constructor' })).toBeNull()
    expect(findReturnLink(c, 'a', { edge: 'right', range: [0, 10], to: 'toString' })).toBeNull()
  })
})

describe('parseConfig 敵グリッド・サイズ・群の検証 (#839)', () => {
  function withGrid(grid: unknown, groups: string[]): Raw {
    const c = minimal()
    c.monsters = {
      bit: { name: 'ビット', hp: 5 },
      boss: { name: 'ボス', hp: 50, size: '2x2', scale: 0.5 },
    }
    c.scenes.a.encounter = { rate: 5, groups }
    c.battle = { enemyGrid: grid, enemyWindowOverlap: 0.3 }
    return c
  }

  it('monsters.<id>.size / scale を MonsterDef に入れる（scale は 0.25〜1 に丸める）', () => {
    const c = ok(withGrid('6x2', ['bit']))
    expect(c.monsters.boss.size).toEqual({ w: 2, h: 2 })
    expect(c.monsters.boss.scale).toBe(0.5)
    expect(c.monsters.bit.size).toBeUndefined()
    expect(c.monsters.bit.scale).toBeUndefined()
    const lo = withGrid('6x2', ['bit'])
    lo.monsters.boss.scale = 0.1
    expect(ok(lo).monsters.boss.scale).toBe(0.25)
    const hi = withGrid('6x2', ['bit'])
    hi.monsters.boss.scale = 3
    expect(ok(hi).monsters.boss.scale).toBe(1)
  })

  it('size は Rust parser と同じ書式（全角・× 可）、不正はエラー', () => {
    for (const [raw, want] of [
      ['2x1', { w: 2, h: 1 }],
      ['２×１', { w: 2, h: 1 }],
      ['3X4', { w: 3, h: 4 }],
    ] as const) {
      const c = withGrid('6x2', ['bit'])
      c.monsters.boss.size = raw
      expect(ok(c).monsters.boss.size).toEqual(want)
    }
    for (const bad of [
      '0x1',
      '2',
      '2x',
      'x2',
      '+2x1',
      '1.5x1',
      'axb',
      2,
      '1x1x1',
      '99999999999x1',
    ]) {
      const c = withGrid('6x2', ['bit'])
      c.monsters.boss.size = bad
      expect(parseConfig(c, BASE).ok, String(bad)).toBe(false)
    }
  })

  it('scale が数値でなければエラー', () => {
    const c = withGrid('6x2', ['bit'])
    c.monsters.boss.scale = 'big'
    expect(parseConfig(c, BASE).ok).toBe(false)
  })

  it('battle の presentation / windowStyle / commandLayout / atb を読む (#883)', () => {
    const c = withEncounter()
    c.battle = {
      presentation: 'ff',
      windowStyle: 'ff-blue',
      commandLayout: 'cross',
      atb: 'on',
      atbMode: 'active',
    }
    const b = ok(c).battle
    expect(b.presentation).toBe('ff')
    expect(b.windowStyle).toBe('ff-blue')
    expect(b.commandLayout).toBe('cross')
    expect(b.atb).toEqual({ mode: 'active' })
  })

  it('battle.commands と skills を読む。未指定は commands キーなし・skills 空 (#873)', () => {
    const c = withEncounter()
    c.battle = { commands: ['skill', 'spell', 'item', 'escape'] }
    c.skills = [
      { name: 'きる', effect: 'damage 5..5' },
      { id: 'sw', name: 'なぎ', target: '相手全体' },
    ]
    const v = ok(c)
    expect(v.battle.commands).toEqual(['skill', 'spell', 'item', 'escape'])
    expect(v.skills).toEqual([
      { id: 'skills-1', name: 'きる', effect: 'damage 5..5', target: '相手単体' },
      { id: 'sw', name: 'なぎ', target: '相手全体' },
    ])
    const d = ok(withEncounter())
    expect('commands' in d.battle).toBe(false)
    expect(d.skills).toEqual([])
  })

  it('battle.commands は配列・既知 id・重複なしでなければエラー (#873)', () => {
    for (const bad of ['skill', ['skill', 'foo'], ['skill', 'skill'], [1], []]) {
      const c = withEncounter()
      c.battle = { commands: bad }
      expect(parseConfig(c, BASE).ok, JSON.stringify(bad)).toBe(false)
    }
    const c = withEncounter()
    c.skills = [{ name: 1 }]
    expect(parseConfig(c, BASE).ok).toBe(false)
  })

  it('atb: "on" だけなら wait、"off" や未指定は atb なし (#883)', () => {
    const c = withEncounter()
    c.battle = { atb: 'on' }
    expect(ok(c).battle.atb).toEqual({ mode: 'wait' })
    c.battle = { atb: 'off', atbMode: 'active' }
    expect(ok(c).battle.atb).toBeUndefined()
  })

  it('battle の演出系が未指定なら該当キーが無い（従来どおり） (#883)', () => {
    const b = ok(withEncounter()).battle
    for (const k of ['presentation', 'windowStyle', 'commandLayout', 'atb']) {
      expect(k in b).toBe(false)
    }
  })

  it('layout front と ff／cross の組は警告を出す（読み込みは成功） (#883)', () => {
    const c = withEncounter()
    c.battle = { layout: 'front', presentation: 'ff', commandLayout: 'cross' }
    const v = ok(c)
    expect(v.warnings).toHaveLength(2)
    expect(v.warnings?.[0]).toContain('presentation')
    expect(v.warnings?.[1]).toContain('commandLayout')
  })

  it('組でなければ警告は出ない (#883)', () => {
    for (const battle of [
      { layout: 'side', presentation: 'ff', commandLayout: 'cross' },
      { presentation: 'ff', commandLayout: 'cross' },
      { layout: 'front', presentation: 'dq', commandLayout: 'grid' },
      { layout: 'front' },
    ]) {
      const c = withEncounter()
      c.battle = battle
      expect(ok(c).warnings).toBeUndefined()
    }
  })

  it('battle の演出系の不正値はエラー (#883)', () => {
    const bad: Array<Record<string, unknown>> = [
      { presentation: 'ffx' },
      { presentation: 1 },
      { windowStyle: 'blue' },
      { commandLayout: 'diamond' },
      { atb: true },
      { atb: 'maybe' },
      { atbMode: 'fast' },
    ]
    for (const battle of bad) {
      const c = withEncounter()
      c.battle = battle
      expect(parseConfig(c, BASE).ok).toBe(false)
    }
  })

  it('battle.enemyGrid / enemyWindowOverlap を読む', () => {
    const c = ok(withGrid('6x2', ['bit']))
    expect(c.battle.enemyGrid).toEqual({ cols: 6, rows: 2 })
    expect(c.battle.enemyWindowOverlap).toBe(0.3)
  })

  it('enemyGrid が不正ならエラーにせず無効（検証もしない）', () => {
    for (const bad of ['abc', '0x2', 6, null]) {
      const c = ok(withGrid(bad, ['boss*9']))
      expect(c.battle.enemyGrid).toBeUndefined()
      expect(c.groupErrors).toBeUndefined()
      expect(c.scenes.a.encounter?.groups).toEqual(['boss*9'])
    }
  })

  it('configNotice は群エラーと警告を 1 つにまとめる（両方画面に出る） (#883)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const c = withGrid('6x2', ['boss*9'])
      c.battle = { ...c.battle, layout: 'front', presentation: 'ff' }
      const v = ok(c)
      expect(v.groupErrors?.length).toBeGreaterThan(0)
      expect(v.warnings).toHaveLength(1)
      const n = configNotice(v)
      expect(n).toContain('boss')
      expect(n).toContain('presentation')
    } finally {
      spy.mockRestore()
    }
  })

  it('configNotice は群エラーだけ・警告だけでも出す (#883)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const onlyErr = ok(withGrid('6x2', ['boss*9']))
      expect(onlyErr.warnings).toBeUndefined()
      expect(configNotice(onlyErr)).toContain('boss')
      const c = withEncounter()
      c.battle = { layout: 'front', commandLayout: 'cross' }
      const n = configNotice(ok(c))
      expect(n).toContain('commandLayout')
    } finally {
      spy.mockRestore()
    }
  })

  it('configNotice は何も無ければ null (#883)', () => {
    expect(configNotice(ok(minimal()))).toBeNull()
  })

  it('収まらない群を除外し、groupErrors と console.error に出す', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 6x2 に 2x2 は 3 体まで入る（4 体は入らない）。bit@M1 は範囲外
      const c = ok(withGrid('6x2', ['bit', 'boss*4', 'bit@M1', 'boss+bit']))
      expect(c.scenes.a.encounter?.groups).toEqual(['bit', 'boss+bit'])
      expect(c.groupErrors!.map((e) => e.group)).toEqual(['boss*4', 'bit@M1'])
      expect(c.groupErrors![0].mapId).toBe('a')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('全群が無効なら空配列になる', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const c = ok(withGrid('6x2', ['bit@M1']))
      expect(c.scenes.a.encounter?.groups).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('今すぐエンカウントの候補: 群があればそれ、群が空なら全モンスター（グリッド有効時は収まらないものを除く）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const mk = (groups: string[]) => {
        const raw = withGrid('6x2', groups)
        ;(raw.monsters as Record<string, unknown>).huge = { name: '巨体', hp: 9, size: '7x1' }
        return ok(raw)
      }
      expect(forceBattleCandidates(mk(['bit', 'boss']), 'a')).toEqual(['bit', 'boss'])
      // 最初から群が無い
      expect(forceBattleCandidates(mk([]), 'a')).toEqual(['bit', 'boss'])
      // 全群が無効化された（huge は 6x2 に入らない）→ 群は空。フォールバックでも収まらない huge は外す
      const allBad = mk(['huge'])
      expect(allBad.scenes.a.encounter?.groups).toEqual([])
      expect(forceBattleCandidates(allBad, 'a')).toEqual(['bit', 'boss'])
    } finally {
      spy.mockRestore()
    }
  })

  it('グリッド未指定では検証しない（console.error なし・群は不変）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const raw = withGrid(undefined, ['bit@M1', 'boss*40'])
      const c = ok(raw)
      expect(c.scenes.a.encounter?.groups).toEqual(['bit@M1', 'boss*40'])
      expect(c.groupErrors).toBeUndefined()
      expect(c.battle.enemyGrid).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('同梱の寺町サンプルは従来どおり（グリッドなし・errors なし）', () => {
    const c = ok(JSON.parse(teramachiSample))
    expect(c.battle.enemyGrid).toBeUndefined()
    expect(c.groupErrors).toBeUndefined()
  })
})

describe('parseConfig 斜め 4 方向 (Issue #811)', () => {
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]
  const withDiag = (fn: (s: Raw) => void): Raw =>
    mutated((c) => {
      for (const d of ['upLeft', 'upRight', 'downLeft', 'downRight'])
        c.player.sprites[d] = frames(d)
      fn(c.player.sprites)
    })

  it('斜めの設定が無ければ 4 方向のまま（mirrorOf は空）', () => {
    const c = ok(minimal())
    expect(c.player.sprites.upLeft).toBeUndefined()
    expect(c.player.mirrorOf).toEqual({})
  })

  it('斜め 4 方向を自前の画像で指定できる', () => {
    const c = ok(withDiag(() => {}))
    expect(c.player.sprites.downRight?.[2]).toBe('https://example.com/field/downRight3.png')
  })

  it('mirrorOf で一部を反転で埋められる', () => {
    const c = ok(
      withDiag((s) => {
        delete s.upLeft
        s.mirrorOf = { upLeft: 'upRight' }
      })
    )
    expect(c.player.sprites.upLeft).toBeUndefined()
    expect(c.player.mirrorOf).toEqual({ upLeft: 'upRight' })
  })

  it.each([
    ['斜めが 3 方向だけ', (s: Raw) => delete s.upLeft],
    ['斜めの URL が 2 コマ', (s: Raw) => (s.upLeft = ['a', 'b'])],
    ['mirrorOf のキーが斜めでない', (s: Raw) => (s.mirrorOf = { left: 'upRight' })],
    [
      'mirrorOf の値が斜めでない',
      (s: Raw) => ((s.mirrorOf = { upLeft: 'right' }), delete s.upLeft),
    ],
    ['自前画像と mirrorOf の両方', (s: Raw) => (s.mirrorOf = { upLeft: 'upRight' })],
    [
      '反転元が mirrorOf 側',
      (s: Raw) => {
        delete s.upLeft
        delete s.upRight
        s.mirrorOf = { upLeft: 'upRight', upRight: 'upLeft' }
      },
    ],
    ['mirrorOf がオブジェクトでない', (s: Raw) => (s.mirrorOf = 'upRight')],
  ])('不正: %s', (_name, fn) => {
    expect(parseConfig(withDiag(fn), BASE).ok).toBe(false)
  })

  it.each([
    ['upLeft', 'downRight'],
    ['upLeft', 'downLeft'],
    ['downLeft', 'upRight'],
    ['downRight', 'upLeft'],
    ['upLeft', 'upLeft'],
  ])('mirrorOf.%s は %s を指せない（左右の相方だけ）', (k, v) => {
    const r = parseConfig(
      withDiag((s) => {
        delete s[k]
        s.mirrorOf = { [k]: v }
      }),
      BASE
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('左右の相方')
  })

  it('mirrorOf を左右の相方に向けると 4 組とも通る', () => {
    for (const [k, v] of [
      ['upLeft', 'upRight'],
      ['upRight', 'upLeft'],
      ['downLeft', 'downRight'],
      ['downRight', 'downLeft'],
    ]) {
      const c = ok(
        withDiag((s) => {
          delete s[k]
          s.mirrorOf = { [k]: v }
        })
      )
      expect(c.player.mirrorOf).toEqual({ [k]: v })
    }
  })

  it('同梱の斜めサンプル（diagonal-walk.sample.json）が ok で、8 方向すべてが自前の 3 コマ', () => {
    const c = ok(JSON.parse(diagonalSample))
    expect(c.player.mirrorOf).toEqual({})
    for (const f of ['up', 'down', 'left', 'right', ...DIAGONAL_FACINGS] as const) {
      expect(c.player.sprites[f]).toHaveLength(3)
    }
  })
})

describe('parseConfig spells / items (#890)', () => {
  const fail = (raw: unknown) => {
    const r = parseConfig(raw, BASE)
    expect(r.ok).toBe(false)
    return r.ok ? '' : r.error
  }

  it('spells / items 未指定は空配列（従来の設定は変わらない）', () => {
    const c = ok(minimal())
    expect(c.spells).toEqual([])
    expect(c.items).toEqual([])
  })

  it('teramachi.sample.json は ok で spells / items が空', () => {
    const c = ok(JSON.parse(teramachiSample))
    expect(c.spells).toEqual([])
    expect(c.items).toEqual([])
  })

  it('指定した spells / items を保持する（呪文は mp と target、アイテムは count）', () => {
    const c = ok(
      mutated((r) => {
        r.spells = [{ id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' }]
        r.items = [{ id: 'potion', name: 'ポーション', effect: 'heal 20..30', count: 3 }]
      })
    )
    expect(c.spells).toEqual([
      { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' },
    ])
    expect(c.items).toEqual([{ id: 'potion', name: 'ポーション', effect: 'heal 20..30', count: 3 }])
  })

  it('count 省略はキー自体が無い（所持数管理なし）', () => {
    const c = ok(mutated((r) => (r.items = [{ name: 'みず' }])))
    expect(c.items[0]).not.toHaveProperty('count')
  })

  it.each([
    [-1, 0],
    [0, 0],
    [1, 1],
    [2.7, 2],
  ])('count=%s は %s に丸められる', (count, expected) => {
    const c = ok(mutated((r) => (r.items = [{ name: 'みず', count }])))
    expect(c.items[0].count).toBe(expected)
  })

  it('id 省略は連番で、spells と items で独立している', () => {
    const c = ok(
      mutated((r) => {
        r.spells = [{ name: 'a' }, { name: 'b' }]
        r.items = [{ name: 'c' }]
      })
    )
    expect(c.spells.map((s) => s.id)).toEqual(['spells-1', 'spells-2'])
    expect(c.items.map((i) => i.id)).toEqual(['items-1'])
  })

  it.each([
    ['spells が配列でない', { spells: {} }],
    ['items が配列でない', { items: 'x' }],
    ['spells の要素が null', { spells: [null] }],
    ['items の要素が null', { items: [null] }],
    ['name が空', { spells: [{ name: '' }] }],
    ['name が空白だけ', { items: [{ name: '  ' }] }],
    ['name が無い', { items: [{ count: 1 }] }],
    ['mp が文字列', { spells: [{ name: 'a', mp: '3' }] }],
    ['mp が NaN', { spells: [{ name: 'a', mp: NaN }] }],
    ['mp が Infinity', { spells: [{ name: 'a', mp: Infinity }] }],
    ['count が文字列', { items: [{ name: 'a', count: '2' }] }],
    ['count が NaN', { items: [{ name: 'a', count: NaN }] }],
    ['count が Infinity', { items: [{ name: 'a', count: Infinity }] }],
  ])('不正（%s）は ok=false', (_label, patch) => {
    const err = fail({ ...minimal(), ...patch })
    expect(err).toMatch(/spells|items/)
  })
})

describe('parseConfig monsters / party の poses (#890)', () => {
  const withMonster = (monster: Raw) =>
    mutated((r) => {
      r.monsters = { slime: { name: 'スライム', hp: 10, ...monster } }
    })
  const err = (raw: unknown) => {
    const r = parseConfig(raw, BASE)
    if (r.ok) throw new Error('失敗するはずが ok')
    return r.error
  }

  it('monsters.poses は URL を解決して保持する（部分指定可）', () => {
    const c = ok(withMonster({ poses: { idle: 'i.png', hurt: '/h.png' } }))
    expect(c.monsters.slime.poses).toEqual({
      idle: 'https://example.com/field/i.png',
      hurt: 'https://example.com/h.png',
    })
  })

  it('poses 未指定は poses キー無し', () => {
    expect(ok(withMonster({})).monsters.slime).not.toHaveProperty('poses')
  })

  it('未知のポーズ名は捨てる。全部捨てたら poses 無し', () => {
    const c = ok(withMonster({ poses: { idle: 'i.png', bogus: 'b.png' } }))
    expect(c.monsters.slime.poses).toEqual({ idle: 'https://example.com/field/i.png' })
    expect(ok(withMonster({ poses: { bogus: 'b.png' } })).monsters.slime).not.toHaveProperty(
      'poses'
    )
  })

  it('空白だけの URL は無視する', () => {
    const c = ok(withMonster({ poses: { idle: 'i.png', hurt: '   ' } }))
    expect(c.monsters.slime.poses).toEqual({ idle: 'https://example.com/field/i.png' })
  })

  it('poses がオブジェクトでない／値が文字列でないときは path つきエラー', () => {
    expect(err(withMonster({ poses: [] }))).toContain('monsters.slime.poses')
    expect(err(withMonster({ poses: 'x' }))).toContain('monsters.slime.poses')
    expect(err(withMonster({ poses: { idle: 3 } }))).toContain('monsters.slime.poses.idle')
  })

  it('party の poses も同じ規則で通る', () => {
    const c = ok(
      mutated((r) => {
        r.party = [{ name: 'ゆうしゃ', hp: 10, poses: { idle: 'h.png', slash: 's.png' } }]
      })
    )
    expect(c.party[0].poses).toEqual({
      idle: 'https://example.com/field/h.png',
      slash: 'https://example.com/field/s.png',
    })
    const r = parseConfig(
      mutated((x) => (x.party = [{ name: 'a', hp: 10, poses: { idle: 1 } }])),
      BASE
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('party[0].poses.idle')
  })

  it('__proto__ / constructor をポーズ名にしても汚染されない（未知名として捨てる）', () => {
    const raw = JSON.parse('{"__proto__":"x.png","constructor":"y.png","idle":"i.png"}')
    const c = ok(withMonster({ poses: raw }))
    expect(c.monsters.slime.poses).toEqual({ idle: 'https://example.com/field/i.png' })
    expect(({} as Record<string, unknown>).idle).toBeUndefined()
    expect(Object.getPrototypeOf(c.monsters.slime.poses)).toBe(Object.prototype)
  })
})

describe('pickConfigSource (#890)', () => {
  it('?fixture=dummy だけなら dummy', () => {
    expect(pickConfigSource('?fixture=dummy')).toEqual({ configParam: undefined, dummy: true })
  })

  it('?config= があれば fixture=dummy より優先（dummy にならない）', () => {
    expect(pickConfigSource('?config=a.json&fixture=dummy')).toEqual({
      configParam: 'a.json',
      dummy: false,
    })
  })

  it('解決できない ?config= でも dummy に化けない', () => {
    expect(pickConfigSource('?config=http://&fixture=dummy').dummy).toBe(false)
  })

  it('空白だけの ?config= は無指定扱い。fixture が dummy 以外なら dummy でない', () => {
    expect(pickConfigSource('?config=%20&fixture=dummy').dummy).toBe(true)
    expect(pickConfigSource('?fixture=x').dummy).toBe(false)
    expect(pickConfigSource('').dummy).toBe(false)
  })
})

describe('battle.effects エフェクト重ね (#936)', () => {
  it('未指定は battle に effects キーが無い（従来と同一）', () => {
    const c = ok(minimal())
    expect('effects' in c.battle).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('宣言は URL に解決され（assetBaseUrl は images 配下）、ff でなければ効かない警告が出る', () => {
    const c = ok(
      mutated((c) => {
        c.assetBaseUrl = 'https://cdn.example.com/g'
        c.battle = {
          layout: 'side',
          presentation: 'ff',
          effects: { cast: { image: 'fx/c.png', frames: 6 } },
        }
      })
    )
    expect(c.battle.effects?.cast?.image).toBe('https://cdn.example.com/g/images/fx/c.png')
    expect(c.warnings).toBeUndefined()
    const dq = ok(
      mutated((c) => {
        c.battle = { layout: 'side', effects: { cast: { image: 'fx/c.png', frames: 6 } } }
      })
    )
    expect(dq.warnings?.some((w) => w.includes('battle.effects'))).toBe(true)
  })
  it('不正な種類は読み込みを止めず、battle. つきの警告にして無視する', () => {
    const c = ok(
      mutated((c) => {
        c.battle = {
          layout: 'side',
          presentation: 'ff',
          effects: { slash: { image: 'a.png', frames: 0 }, magic: { image: 'm.png', frames: 2 } },
        }
      })
    )
    expect(Object.keys(c.battle.effects ?? {})).toEqual(['magic'])
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings?.[0]).toContain('battle.effects.slash')
  })
})

describe('emotions 感情吹き出し (#937)', () => {
  it('未指定は emotions キーが無く警告も無い（従来と同一）', () => {
    const c = ok(minimal())
    expect('emotions' in c).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('宣言は URL に解決される（assetBaseUrl は images 配下）。種類名は自由', () => {
    const c = ok(
      mutated((c) => {
        c.assetBaseUrl = 'https://cdn.example.com/g'
        c.emotions = {
          '!': { image: 'em/bang.png', durationMs: 800, offset: { x: 0, y: -6 }, motion: 'pop' },
          '...': { image: 'em/dots.png', frames: 3, frameMs: 200 },
        }
      })
    )
    expect(Object.keys(c.emotions ?? {})).toEqual(['!', '...'])
    expect(c.emotions!['!'].image).toBe('https://cdn.example.com/g/images/em/bang.png')
    expect(c.emotions!['!'].durationMs).toBe(800)
    expect(c.emotions!['...'].frames).toBe(3)
    expect(c.warnings).toBeUndefined()
  })
  it('不正な種類は読み込みを止めず、警告にして無視する', () => {
    const c = ok(
      mutated((c) => {
        c.emotions = { '!': { image: 'a.png', durationMs: -1 }, '?': { image: 'q.png' } }
      })
    )
    expect(Object.keys(c.emotions ?? {})).toEqual(['?'])
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings?.[0]).toContain('emotions.!.durationMs')
  })
  it('全部不正なら emotions キー自体が付かない', () => {
    const c = ok(
      mutated((c) => {
        c.emotions = { '!': {} }
      })
    )
    expect('emotions' in c).toBe(false)
    expect(c.warnings).toHaveLength(1)
  })
})

describe('emotionsUrl 感情吹き出しの外部 JSON (#946)', () => {
  it('未指定は emotionsSource キーが無い（従来と同一）', () => {
    const c = ok(minimal())
    expect('emotionsSource' in c).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('URL は assetBaseUrl（images 配下）基準で解決し、中の画像 URL も同じ規則で解決できる', () => {
    const c = ok(
      mutated((c) => {
        c.assetBaseUrl = 'https://cdn.example.com/g'
        c.emotionsUrl = 'field_emotions.json'
      })
    )
    expect(c.emotionsSource?.url).toBe('https://cdn.example.com/g/images/field_emotions.json')
    expect(c.emotionsSource?.resolveImage('em/bang.png')).toBe(
      'https://cdn.example.com/g/images/em/bang.png'
    )
    expect(c.warnings).toBeUndefined()
  })
  it('インラインの emotions と併存できる', () => {
    const c = ok(
      mutated((c) => {
        c.emotions = { '?': { image: 'q.png' } }
        c.emotionsUrl = 'https://example.com/e.json'
      })
    )
    expect(Object.keys(c.emotions ?? {})).toEqual(['?'])
    expect(c.emotionsSource?.url).toBe('https://example.com/e.json')
  })
  it('文字列でない・空は警告して無視（読み込みは成功のまま）', () => {
    for (const bad of [123, '', '  ', null, {}]) {
      const c = ok(
        mutated((c) => {
          c.emotionsUrl = bad
        })
      )
      expect('emotionsSource' in c).toBe(false)
      expect(c.warnings).toHaveLength(1)
      expect(c.warnings?.[0]).toContain('emotionsUrl')
    }
  })
})

describe('scenes.<id>.npcs (#841 段階1)', () => {
  const npc = (extra: Raw = {}): Raw => ({
    id: 'oba',
    name: 'おばあさん',
    x: 300,
    y: 400,
    sprite: 'oba.png',
    line: 'こんにちは。',
    ...extra,
  })
  const withNpcs = (npcs: unknown): Raw =>
    mutated((c) => {
      c.scenes.a.npcs = npcs
    })
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]

  it('未指定は npcs キーも警告も無し（従来と完全に同じ）', () => {
    const c = ok(minimal())
    expect('npcs' in c.scenes.a).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('空配列も npcs キーを作らない', () => {
    const c = ok(withNpcs([]))
    expect('npcs' in c.scenes.a).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('単一画像 sprite の NPC を読む（URL は設定 JSON 基準で解決・facing 既定は down）', () => {
    const c = ok(withNpcs([npc()]))
    expect(c.scenes.a.npcs).toEqual([
      {
        id: 'oba',
        name: 'おばあさん',
        x: 300,
        y: 400,
        sprite: 'https://example.com/field/oba.png',
        facing: 'down',
        line: 'こんにちは。',
      },
    ])
    expect(c.warnings).toBeUndefined()
  })
  it('4 方向 × 3 コマの sprites と height・facing を読む', () => {
    const c = ok(
      withNpcs([
        npc({
          sprite: undefined,
          sprites: {
            up: frames('u'),
            down: frames('d'),
            left: frames('l'),
            right: frames('r'),
          },
          height: 120,
          facing: 'left',
        }),
      ])
    )
    const n = c.scenes.a.npcs![0]
    expect(n.sprites?.left[1]).toBe('https://example.com/field/l2.png')
    expect(n.sprite).toBeUndefined()
    expect(n.height).toBe(120)
    expect(n.facing).toBe('left')
  })
  it('npcs が配列でなければ警告して無視（読み込みは成功）', () => {
    const c = ok(withNpcs({ oba: npc() }))
    expect('npcs' in c.scenes.a).toBe(false)
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings?.[0]).toContain('scenes.a.npcs')
  })
  it('不正な NPC はその 1 件だけ警告して読み飛ばし、正しい NPC は残る', () => {
    const bads: unknown[] = [
      npc({ id: '' }),
      npc({ id: 5 }),
      npc({ name: '' }),
      npc({ x: 'a' }),
      npc({ y: Infinity }),
      npc({ line: '  ' }),
      npc({ facing: 'upLeft' }),
      npc({ height: 0 }),
      npc({ height: -3 }),
      npc({ sprite: undefined }),
      npc({ sprites: { up: frames('u') } }),
      npc({ sprite: 123 }),
      npc({ sprite: undefined, sprites: 'x' }),
      'string',
      null,
    ]
    for (const bad of bads) {
      const c = ok(withNpcs([bad, npc({ id: 'good' })]))
      expect(c.scenes.a.npcs?.map((n) => n.id)).toEqual(['good'])
      expect(c.warnings).toHaveLength(1)
      expect(c.warnings?.[0]).toContain('scenes.a.npcs[0]')
    }
  })
  it('sprite と sprites の同時指定は不正', () => {
    const c = ok(
      withNpcs([
        npc({
          sprites: { up: frames('u'), down: frames('d'), left: frames('l'), right: frames('r') },
        }),
      ])
    )
    expect('npcs' in c.scenes.a).toBe(false)
    expect(c.warnings).toHaveLength(1)
  })
  it('id が重複したら後のほうを警告して捨てる', () => {
    const c = ok(withNpcs([npc(), npc({ name: 'べつ' })]))
    expect(c.scenes.a.npcs).toHaveLength(1)
    expect(c.scenes.a.npcs![0].name).toBe('おばあさん')
    expect(c.warnings?.[0]).toContain('重複')
  })
  it('未知のキー（スペルミス）は警告するが NPC は残す', () => {
    const c = ok(withNpcs([npc({ heigth: 100 })]))
    expect(c.scenes.a.npcs).toHaveLength(1)
    expect(c.scenes.a.npcs![0]).not.toHaveProperty('heigth')
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings?.[0]).toContain('scenes.a.npcs[0].heigth')
  })
  it('既知のキーだけなら警告なし（height・facing も）', () => {
    const c = ok(withNpcs([npc({ height: 120, facing: 'left' })]))
    expect(c.warnings).toBeUndefined()
  })
  it('警告は configNotice の表示にも出る', () => {
    const c = ok(withNpcs([npc({ line: '' })]))
    expect(configNotice(c)).toContain('scenes.a.npcs[0]')
  })
})

describe('scriptUrl と npcs.scene (#841 段階2)', () => {
  const npcRaw = (extra: Raw = {}): Raw => ({
    id: 'oba',
    name: 'おばあさん',
    x: 300,
    y: 400,
    sprite: 'oba.png',
    line: 'こんにちは。',
    ...extra,
  })
  const withNpcs = (npcs: unknown): Raw =>
    mutated((c) => {
      c.scenes.a.npcs = npcs
    })

  it('未指定は scriptUrl キーも scene キーも警告も無し（従来と同一）', () => {
    const c = ok(withNpcs([npcRaw()]))
    expect('scriptUrl' in c).toBe(false)
    expect('scene' in c.scenes.a.npcs![0]).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('scriptUrl は assetBaseUrl（images 配下）基準で解決する', () => {
    const c = ok(
      mutated((c) => {
        c.assetBaseUrl = 'https://cdn.example.com/g'
        c.scriptUrl = 'npc.md'
      })
    )
    expect(c.scriptUrl).toBe('https://cdn.example.com/g/images/npc.md')
    expect(c.warnings).toBeUndefined()
  })
  it('scriptUrl が文字列でない・空は警告して無視（読み込みは成功のまま）', () => {
    for (const bad of [123, '', '  ', null, {}]) {
      const c = ok(
        mutated((c) => {
          c.scriptUrl = bad
        })
      )
      expect('scriptUrl' in c).toBe(false)
      expect(c.warnings).toHaveLength(1)
      expect(c.warnings?.[0]).toContain('scriptUrl')
    }
  })
  it('NPC の scene を読む（前後の空白は除く）', () => {
    const c = ok(withNpcs([npcRaw({ scene: ' 老婆の話 ' })]))
    expect(c.scenes.a.npcs![0].scene).toBe('老婆の話')
    expect(c.warnings).toBeUndefined()
  })
  it('scene が不正（空・文字列でない）は警告して scene だけ無視（NPC は残る）', () => {
    for (const bad of ['', '  ', 5, null]) {
      const c = ok(withNpcs([npcRaw({ scene: bad })]))
      expect(c.scenes.a.npcs).toHaveLength(1)
      expect('scene' in c.scenes.a.npcs![0]).toBe(false)
      expect(c.warnings).toHaveLength(1)
      expect(c.warnings?.[0]).toContain('.scene')
    }
  })
})
