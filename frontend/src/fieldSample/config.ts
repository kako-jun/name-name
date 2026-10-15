/**
 * 一枚絵フィールドサンプルページ (#807) の設定 JSON まわりの純粋関数。ブラウザ API には触れない。
 * 画像は URL で指す（相対 URL は設定 JSON の URL を基準に解決。assetBaseUrl があれば RPG の画像と同じく
 * `${base}/images/...` に解決する (#746/#785)）。
 */
import { hasOwn } from '../game/ownProperty'
import { parseEncounterGroup } from '../game/enemyGroup'
import { resolveRpgImagePath } from '../game/novelLayout'
import { resolveUrl, type ParseResult } from '../battleSample/config'
import type { Edge, FieldLink, Facing, Vec } from '../game/fieldWalk'
import type { EncounterStepConfig, SceneEncounter } from '../game/fieldEncounter'
import type { MonsterDef } from '../types'
import type { BattleEntity } from '../game/spellDsl'
import type { BattleLayoutMode } from '../game/battleLayout'
import type { SpriteStyle } from '../game/spriteStyle'

export const EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right']
export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right']

export interface FieldSceneConfig {
  id: string
  /** 背景画像の URL */
  background: string
  /** 歩行マスク画像の URL（白=歩ける・黒=歩けない。背景と同じ大きさ） */
  mask: string
  links: FieldLink[]
  /** ランダムエンカウント (#809)。省略 = エンカウントなし */
  encounter: (SceneEncounter & { background?: string }) | null
}

/** 戦闘画面の設定 (#809) */
export interface FieldBattleConfig {
  layout: BattleLayoutMode
  spriteStyle: SpriteStyle
  /** 戦闘の既定の背景 URL（シーンの encounter.background で上書き可） */
  background?: string
  /** 戦闘中の画面の大きさ（戦闘サンプルの 800x450 と同じ既定） */
  width: number
  height: number
}

export interface FieldSampleConfig {
  startScene: string
  /** 開始シーンでの足元の初期位置（背景のピクセル座標） */
  start: Vec
  /** 移動速度（背景ピクセル/秒） */
  speed: number
  /** 端のしきい値（背景ピクセル） */
  edgeThreshold: number
  player: {
    /** 向きごとに 3 コマの画像 URL */
    sprites: Record<Facing, [string, string, string]>
    /** 表示する高さ（背景ピクセル） */
    height: number
    /** 1 コマの長さ(ms) */
    frameMs: number
  }
  scenes: Record<string, FieldSceneConfig>
  /** 歩数の刻みと連続エンカウント抑制 (#809) */
  encounter: EncounterStepConfig
  /** エンカウントで使うモンスターのマスター (#809) */
  monsters: Record<string, MonsterDef>
  /** 戦闘に出す味方 (#809)。主人公のポーズ画像を sprite に指す */
  party: BattleEntity[]
  battle: FieldBattleConfig
}

export const DEFAULTS = {
  speed: 260,
  edgeThreshold: 6,
  height: 150,
  frameMs: 140,
  stepDistance: 80,
  minSteps: 3,
  battleWidth: 800,
  battleHeight: 450,
} as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

export function parseConfigText(text: string, baseUrl: string): ParseResult<FieldSampleConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fail(`JSON として読めません: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseConfig(raw, baseUrl)
}

export function parseConfig(raw: unknown, baseUrl: string): ParseResult<FieldSampleConfig> {
  if (!isObj(raw)) return fail('設定はオブジェクトである必要があります')
  const assetBase =
    typeof raw.assetBaseUrl === 'string' && raw.assetBaseUrl.trim()
      ? raw.assetBaseUrl.trim()
      : undefined
  const url = (v: unknown, path: string): ParseResult<string> => {
    if (typeof v !== 'string' || !v.trim()) return fail(`${path} は URL 文字列である必要があります`)
    const u = resolveUrl(resolveRpgImagePath(assetBase, v.trim()), baseUrl)
    return u ? { ok: true, value: u } : fail(`${path} の URL を解決できません: ${v}`)
  }
  const positive = (v: unknown, def: number, path: string): ParseResult<number> => {
    if (v === undefined) return { ok: true, value: def }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
      return fail(`${path} は 0 より大きい数値: ${JSON.stringify(v)}`)
    return { ok: true, value: v }
  }

  if (!isObj(raw.scenes) || Object.keys(raw.scenes).length === 0)
    return fail('scenes は 1 件以上のオブジェクトが必要です')
  if (typeof raw.startScene !== 'string' || !hasOwn(raw.scenes, raw.startScene))
    return fail(`startScene は scenes のキーのどれか: ${JSON.stringify(raw.startScene)}`)
  const s = raw.start
  if (
    !isObj(s) ||
    typeof s.x !== 'number' ||
    typeof s.y !== 'number' ||
    !Number.isFinite(s.x) ||
    !Number.isFinite(s.y)
  )
    return fail('start は { x, y }（数値）が必要です')

  const speed = positive(raw.speed, DEFAULTS.speed, 'speed')
  if (!speed.ok) return speed
  const edgeThreshold = positive(raw.edgeThreshold, DEFAULTS.edgeThreshold, 'edgeThreshold')
  if (!edgeThreshold.ok) return edgeThreshold

  if (!isObj(raw.player) || !isObj(raw.player.sprites)) return fail('player.sprites が必要です')
  const sprites = {} as Record<Facing, [string, string, string]>
  for (const f of FACINGS) {
    const arr = raw.player.sprites[f]
    if (!Array.isArray(arr) || arr.length !== 3)
      return fail(`player.sprites.${f} は 3 コマ分の URL 配列が必要です`)
    const urls: string[] = []
    for (let i = 0; i < 3; i++) {
      const u = url(arr[i], `player.sprites.${f}[${i}]`)
      if (!u.ok) return u
      urls.push(u.value)
    }
    sprites[f] = urls as [string, string, string]
  }
  const height = positive(raw.player.height, DEFAULTS.height, 'player.height')
  if (!height.ok) return height
  const frameMs = positive(raw.player.frameMs, DEFAULTS.frameMs, 'player.frameMs')
  if (!frameMs.ok) return frameMs

  const scenes: Record<string, FieldSceneConfig> = {}
  for (const [id, sc] of Object.entries(raw.scenes)) {
    if (!isObj(sc)) return fail(`scenes.${id} はオブジェクトが必要です`)
    const background = url(sc.background, `scenes.${id}.background`)
    if (!background.ok) return background
    const mask = url(sc.mask, `scenes.${id}.mask`)
    if (!mask.ok) return mask
    const links: FieldLink[] = []
    if (sc.links !== undefined) {
      if (!Array.isArray(sc.links)) return fail(`scenes.${id}.links は配列が必要です`)
      for (let i = 0; i < sc.links.length; i++) {
        const l: unknown = sc.links[i]
        const p = `scenes.${id}.links[${i}]`
        if (!isObj(l)) return fail(`${p} はオブジェクトが必要です`)
        if (!EDGES.includes(l.edge as Edge)) return fail(`${p}.edge は top/bottom/left/right`)
        const r = l.range
        if (
          !Array.isArray(r) ||
          r.length !== 2 ||
          typeof r[0] !== 'number' ||
          typeof r[1] !== 'number' ||
          !Number.isFinite(r[0]) ||
          !Number.isFinite(r[1]) ||
          r[0] > r[1]
        )
          return fail(`${p}.range は [小, 大] の数値 2 つが必要です`)
        if (typeof l.to !== 'string' || !hasOwn(raw.scenes, l.to))
          return fail(`${p}.to は scenes のキーのどれか: ${JSON.stringify(l.to)}`)
        links.push({ edge: l.edge as Edge, range: [r[0], r[1]], to: l.to })
      }
    }
    let encounter: FieldSceneConfig['encounter'] = null
    if (sc.encounter !== undefined) {
      const e = sc.encounter
      const p = `scenes.${id}.encounter`
      if (!isObj(e)) return fail(`${p} はオブジェクトが必要です`)
      if (typeof e.rate !== 'number' || !Number.isFinite(e.rate) || e.rate < 0)
        return fail(`${p}.rate は 0 以上の数値（0=なし・N=1/N・1=毎回）: ${JSON.stringify(e.rate)}`)
      if (!Array.isArray(e.groups) || !e.groups.every((g) => typeof g === 'string'))
        return fail(`${p}.groups は文字列の配列が必要です`)
      let bg: string | undefined
      if (e.background !== undefined) {
        const u = url(e.background, `${p}.background`)
        if (!u.ok) return u
        bg = u.value
      }
      encounter = { rate: e.rate, groups: e.groups as string[], ...(bg ? { background: bg } : {}) }
    }
    scenes[id] = { id, background: background.value, mask: mask.value, links, encounter }
  }

  // ---- ランダムエンカウント・戦闘 (#809) ----
  const stepRaw = raw.encounter === undefined ? {} : raw.encounter
  if (!isObj(stepRaw)) return fail('encounter はオブジェクトが必要です')
  const stepDistance = positive(
    stepRaw.stepDistance,
    DEFAULTS.stepDistance,
    'encounter.stepDistance'
  )
  if (!stepDistance.ok) return stepDistance
  const minSteps = stepRaw.minSteps === undefined ? DEFAULTS.minSteps : stepRaw.minSteps
  if (typeof minSteps !== 'number' || !Number.isInteger(minSteps) || minSteps < 0)
    return fail(`encounter.minSteps は 0 以上の整数: ${JSON.stringify(minSteps)}`)

  const monsters: Record<string, MonsterDef> = {}
  if (raw.monsters !== undefined) {
    if (!isObj(raw.monsters)) return fail('monsters はオブジェクトが必要です')
    for (const [mid, m] of Object.entries(raw.monsters)) {
      const e = parseEntity(m, mid, `monsters.${mid}`, url)
      if (!e.ok) return e
      monsters[mid] = {
        id: mid,
        name: e.value.name,
        hp: e.value.hp,
        mp: e.value.mp,
        atk: e.value.atk,
        def: e.value.def,
        agi: e.value.agi,
        exp: e.value.exp ?? 0,
        gold: e.value.gold ?? 0,
        ...(e.value.sprite ? { sprite: e.value.sprite } : {}),
      }
    }
  }
  for (const sc of Object.values(scenes)) {
    for (const g of sc.encounter?.groups ?? []) {
      const parsed = parseEncounterGroup(g)
      if (parsed.warnings.length > 0)
        return fail(`scenes.${sc.id}.encounter.groups の "${g}": ${parsed.warnings[0]}`)
      for (const { id: mid } of parsed.items) {
        if (!hasOwn(monsters, mid))
          return fail(`scenes.${sc.id}.encounter.groups の "${mid}" が monsters にありません`)
      }
    }
  }

  const party: BattleEntity[] = []
  if (raw.party !== undefined) {
    if (!Array.isArray(raw.party)) return fail('party は配列が必要です')
    for (let i = 0; i < raw.party.length; i++) {
      const e = parseEntity(raw.party[i], `party${i + 1}`, `party[${i}]`, url)
      if (!e.ok) return e
      party.push(e.value)
    }
  }
  if (party.length === 0) {
    party.push({
      id: 'hero',
      name: '主人公',
      hp: 30,
      maxHp: 30,
      mp: 8,
      maxMp: 8,
      atk: 8,
      def: 4,
      agi: 5,
    })
  }

  const b = raw.battle === undefined ? {} : raw.battle
  if (!isObj(b)) return fail('battle はオブジェクトが必要です')
  if (b.layout !== undefined && b.layout !== 'front' && b.layout !== 'side')
    return fail(`battle.layout は "front" か "side": ${JSON.stringify(b.layout)}`)
  if (b.spriteStyle !== undefined && b.spriteStyle !== 'none' && b.spriteStyle !== 'acrylic')
    return fail(`battle.spriteStyle は "none" か "acrylic": ${JSON.stringify(b.spriteStyle)}`)
  const bw = positive(b.width, DEFAULTS.battleWidth, 'battle.width')
  if (!bw.ok) return bw
  const bh = positive(b.height, DEFAULTS.battleHeight, 'battle.height')
  if (!bh.ok) return bh
  let battleBg: string | undefined
  if (b.background !== undefined) {
    const u = url(b.background, 'battle.background')
    if (!u.ok) return u
    battleBg = u.value
  }

  return {
    ok: true,
    value: {
      startScene: raw.startScene,
      start: { x: s.x, y: s.y },
      speed: speed.value,
      edgeThreshold: edgeThreshold.value,
      player: { sprites, height: height.value, frameMs: frameMs.value },
      scenes,
      encounter: { stepDistance: stepDistance.value, minSteps },
      monsters,
      party,
      battle: {
        layout: b.layout ?? 'side',
        spriteStyle: b.spriteStyle ?? 'none',
        ...(battleBg ? { background: battleBg } : {}),
        width: bw.value,
        height: bh.value,
      },
    },
  }
}

/** 味方・モンスターの 1 件分の検証（ステータスは数値、sprite は URL に解決） */
function parseEntity(
  raw: unknown,
  id: string,
  path: string,
  url: (v: unknown, path: string) => ParseResult<string>
): ParseResult<BattleEntity> {
  if (!isObj(raw)) return fail(`${path} はオブジェクトが必要です`)
  if (typeof raw.name !== 'string' || !raw.name.trim()) return fail(`${path}.name が必要です`)
  const num = (k: string, def?: number, min = 0): ParseResult<number> => {
    const v = raw[k] === undefined ? def : raw[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min)
      return fail(`${path}.${k} は ${min} 以上の数値が必要です`)
    return { ok: true, value: v }
  }
  // hp 0 だと戦闘が即時終了して進行不能になるので 1 以上
  const hp = num('hp', undefined, 1)
  if (!hp.ok) return hp
  const mp = num('mp', 0)
  if (!mp.ok) return mp
  const atk = num('atk', 5)
  if (!atk.ok) return atk
  const def = num('def', 3)
  if (!def.ok) return def
  const agi = num('agi', 5)
  if (!agi.ok) return agi
  const exp = num('exp', 0)
  if (!exp.ok) return exp
  const gold = num('gold', 0)
  if (!gold.ok) return gold
  const e: BattleEntity = {
    id,
    name: raw.name,
    hp: hp.value,
    maxHp: hp.value,
    mp: mp.value,
    maxMp: mp.value,
    atk: atk.value,
    def: def.value,
    agi: agi.value,
    exp: exp.value,
    gold: gold.value,
  }
  if (raw.sprite !== undefined) {
    const u = url(raw.sprite, `${path}.sprite`)
    if (!u.ok) return u
    e.sprite = u.value
  }
  return { ok: true, value: e }
}

/**
 * srcId のシーンから link で出たとき、遷移先シーンで対応する（srcId へ戻る）リンクを返す。
 * 遷移先に複数あれば、辺が反対側のものを優先し、なければ最初のもの。無ければ null。
 */
export function findReturnLink(
  config: FieldSampleConfig,
  srcId: string,
  link: FieldLink
): FieldLink | null {
  const back =
    (hasOwn(config.scenes, link.to) ? config.scenes[link.to] : undefined)?.links.filter(
      (l) => l.to === srcId
    ) ?? []
  if (back.length === 0) return null
  return back.find((l) => l.edge === OPPOSITE[link.edge]) ?? back[0]
}

const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
