/**
 * 一枚絵フィールドサンプルページ (#807) の設定 JSON まわりの純粋関数。ブラウザ API には触れない。
 * 画像は URL で指す（相対 URL は設定 JSON の URL を基準に解決。assetBaseUrl があれば RPG の画像と同じく
 * `${base}/images/...` に解決する (#746/#785)）。
 */
import { hasOwn } from '../game/ownProperty'
import { parseEncounterGroup } from '../game/enemyGroup'
import {
  formatEncounterGroupErrors,
  validateEncounterGroups,
  type EncounterGroupError,
} from '../game/encounterGroupValidation'
import {
  normalizeEnemyGrid,
  normalizeEnemyWindowOverlapSetting,
  type EnemyGridSize,
} from '../game/enemyGrid'
import { resolveRpgImagePath } from '../game/novelLayout'
import { parseMenuList, parsePoses, resolveUrl, type ParseResult } from '../battleSample/config'
import type { DiagonalFacing, Edge, FieldLink, Facing, Vec } from '../game/fieldWalk'
import type { EncounterStepConfig, SceneEncounter } from '../game/fieldEncounter'
import type { MonsterDef } from '../types'
import type { BattleEntity } from '../game/spellDsl'
import type { BattleLayoutMode } from '../game/battleLayout'
import type { SpriteStyle } from '../game/spriteStyle'
import type { BattlePresentation } from '../game/battleMotion'
import type { WindowStyle } from '../game/windowStyle'
import type { CommandLayout } from '../game/battleCommands'
import type { BattleAtbConfig } from '../game/battleAtb'
import type { BattleItemEntry, BattleSpellEntry } from '../game/battleMenu'

export const EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right']
export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right']
export const DIAGONAL_FACINGS: readonly DiagonalFacing[] = [
  'upLeft',
  'upRight',
  'downLeft',
  'downRight',
]

/** 斜めの向きの左右の相方（mirrorOf の反転元にできるのはこれだけ） */
export const MIRROR_PARTNER: Record<DiagonalFacing, DiagonalFacing> = {
  upLeft: 'upRight',
  upRight: 'upLeft',
  downLeft: 'downRight',
  downRight: 'downLeft',
}

export interface FieldSceneConfig {
  id: string
  /** 背景画像の URL */
  background: string
  /** 歩行マスク画像の URL（白=歩ける・黒=歩けない。背景と同じ大きさ） */
  mask: string
  /**
   * 前面レイヤー (#866)。背景と同じ大きさの透明 PNG の URL。主人公（と同行者）より手前に重ねて描く（天井から吊った物の下を歩くと隠れる）。
   * 見た目だけで、歩行マスク・リンク・エンカウントには関与しない。省略 = 従来どおり（前面なし）
   */
  foreground?: string
  links: FieldLink[]
  /** このシーンでの主人公の表示高さ（背景ピクセル）。省略 = 全体の `player.height` (#810) */
  playerHeight?: number
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
  /** 敵の見えないグリッド (#839)。`battle.enemyGrid: "6x2"`。不正値・未指定は undefined＝従来の配置 */
  enemyGrid?: EnemyGridSize
  /** 敵の絵と窓の重なり許容量 (#838/#839)。`battle.enemyWindowOverlap`（0〜0.5 に丸める）。未指定は既定 */
  enemyWindowOverlap?: number
  /** 演出方式 (#883)。`battle.presentation`: `dq` / `ff`。未指定は undefined＝BattleScreen の既定（dq） */
  presentation?: BattlePresentation
  /** 窓の配色 (#883)。`battle.windowStyle`: `dark` / `ff-blue`。未指定は undefined＝既定（dark） */
  windowStyle?: WindowStyle
  /** コマンド窓の配置 (#883)。`battle.commandLayout`: `grid` / `cross`。未指定は undefined＝既定（grid） */
  commandLayout?: CommandLayout
  /** ATB (#883)。`battle.atb: "on"` のとき `{ mode: battle.atbMode ?? "wait" }`。未指定・"off" は undefined＝ターン制 */
  atb?: BattleAtbConfig
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
    /** 向きごとに 3 コマの画像 URL。斜め 4 方向 (#811) は optional（`mirrorOf` で埋めた分は含まない） */
    sprites: Record<Facing, [string, string, string]> &
      Partial<Record<DiagonalFacing, [string, string, string]>>
    /**
     * 斜めの向きを、左右の相方（upLeft↔upRight、downLeft↔downRight）の画像の左右反転で済ませる指定 (#811)。例: `{ upLeft: 'upRight' }`。
     * 斜めの 4 方向がすべて（自前の画像か `mirrorOf` で）揃ったときだけ 8 方向で動く。揃っていなければ 4 方向
     */
    mirrorOf: Partial<Record<DiagonalFacing, DiagonalFacing>>
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
  /**
   * 戦闘の候補窓 (#890)。`spells`: 味方全員が使える呪文（戦闘サンプルと同じ書式）。`items`: 試作用の所持品（`count` が所持数。
   * 本編の inventory とは無関係で、戦闘のたびに設定の値から始まる）。どちらも `battle.commandLayout: "cross"` のときだけ候補窓に出る。
   * 未指定は空＝じゅもん・どうぐの窓が開かない（従来どおり）
   */
  spells: BattleSpellEntry[]
  items: BattleItemEntry[]
  /** 敵グリッドに収まらず無効化した群 (#839 段5)。`battle.enemyGrid` が有効で 1 件以上あるときだけ入る */
  groupErrors?: EncounterGroupError[]
  /** 設定は読めたが効かない組み合わせの警告 (#883)。`layout: "front"` と `presentation: "ff"`／`commandLayout: "cross"` など。無ければ省略 */
  warnings?: string[]
}

export const DEFAULTS = {
  speed: 260,
  edgeThreshold: 6,
  height: 96,
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
  const parseFrames = (v: unknown, path: string): ParseResult<[string, string, string]> => {
    if (!Array.isArray(v) || v.length !== 3) return fail(`${path} は 3 コマ分の URL 配列が必要です`)
    const urls: string[] = []
    for (let i = 0; i < 3; i++) {
      const u = url(v[i], `${path}[${i}]`)
      if (!u.ok) return u
      urls.push(u.value)
    }
    return { ok: true, value: urls as [string, string, string] }
  }
  const sprites = {} as FieldSampleConfig['player']['sprites']
  for (const f of FACINGS) {
    const r = parseFrames(raw.player.sprites[f], `player.sprites.${f}`)
    if (!r.ok) return r
    sprites[f] = r.value
  }
  // 斜め 4 方向 (#811)。未指定は 4 方向のまま（後方互換）
  for (const f of DIAGONAL_FACINGS) {
    if (raw.player.sprites[f] === undefined) continue
    const r = parseFrames(raw.player.sprites[f], `player.sprites.${f}`)
    if (!r.ok) return r
    sprites[f] = r.value
  }
  const mirrorOf: FieldSampleConfig['player']['mirrorOf'] = {}
  const mirrorRaw = raw.player.sprites.mirrorOf
  if (mirrorRaw !== undefined) {
    if (!isObj(mirrorRaw)) return fail('player.sprites.mirrorOf はオブジェクトが必要です')
    for (const [k, v] of Object.entries(mirrorRaw)) {
      if (!(DIAGONAL_FACINGS as readonly string[]).includes(k))
        return fail(
          `player.sprites.mirrorOf.${k} は斜めの向き（${DIAGONAL_FACINGS.join(' / ')}）のどれかにしてください`
        )
      // 左右反転は x だけを入れ替えるので、反転元は左右の相方（upLeft↔upRight / downLeft↔downRight）だけ
      const partner = MIRROR_PARTNER[k as DiagonalFacing]
      if (v !== partner)
        return fail(
          `player.sprites.mirrorOf.${k} は左右の相方 ${partner} だけを指せます（左右反転なので上下は変えられません）`
        )
      const to = partner
      if (sprites[k as DiagonalFacing])
        return fail(`player.sprites.${k} と player.sprites.mirrorOf.${k} は同時に指定できません`)
      mirrorOf[k as DiagonalFacing] = to
    }
    for (const [k, to] of Object.entries(mirrorOf)) {
      if (!sprites[to as DiagonalFacing])
        return fail(
          `player.sprites.mirrorOf.${k} の反転元 ${to} には、mirrorOf ではなく自前の画像（player.sprites.${to}）が必要です`
        )
    }
  }
  const diagCount = DIAGONAL_FACINGS.filter((f) => sprites[f] || mirrorOf[f]).length
  if (diagCount !== 0 && diagCount !== DIAGONAL_FACINGS.length)
    return fail(
      `斜めの向きは 4 方向（${DIAGONAL_FACINGS.join(' / ')}）すべてを、画像か mirrorOf で揃えてください（いまは ${diagCount} 方向）`
    )
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
    let foreground: string | undefined
    if (sc.foreground !== undefined) {
      const fg = url(sc.foreground, `scenes.${id}.foreground`)
      if (!fg.ok) return fg
      foreground = fg.value
    }
    let playerHeight: number | undefined
    if (sc.playerHeight !== undefined) {
      const ph = positive(sc.playerHeight, 0, `scenes.${id}.playerHeight`)
      if (!ph.ok) return ph
      playerHeight = ph.value
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
    scenes[id] = {
      id,
      background: background.value,
      mask: mask.value,
      ...(foreground !== undefined ? { foreground } : {}),
      links,
      ...(playerHeight !== undefined ? { playerHeight } : {}),
      encounter,
    }
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
      const size = parseMonsterSize((m as Obj).size, `monsters.${mid}.size`)
      if (!size.ok) return size
      const scale = parseMonsterScale((m as Obj).scale, `monsters.${mid}.scale`)
      if (!scale.ok) return scale
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
        ...(e.value.poses ? { poses: e.value.poses } : {}),
        ...(size.value ? { size: size.value } : {}),
        ...(scale.value !== undefined ? { scale: scale.value } : {}),
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

  // 戦闘の候補窓 (#890)。戦闘サンプルと同じ parser（spells は味方全員共通）
  const spells = parseMenuList<BattleSpellEntry>(raw.spells, [], 'spells')
  if (!spells.ok) return spells
  const items = parseMenuList<BattleItemEntry>(raw.items, [], 'items')
  if (!items.ok) return items

  const b = raw.battle === undefined ? {} : raw.battle
  if (!isObj(b)) return fail('battle はオブジェクトが必要です')
  if (b.layout !== undefined && b.layout !== 'front' && b.layout !== 'side')
    return fail(`battle.layout は "front" か "side": ${JSON.stringify(b.layout)}`)
  if (b.spriteStyle !== undefined && b.spriteStyle !== 'none' && b.spriteStyle !== 'acrylic')
    return fail(`battle.spriteStyle は "none" か "acrylic": ${JSON.stringify(b.spriteStyle)}`)
  if (b.presentation !== undefined && b.presentation !== 'dq' && b.presentation !== 'ff')
    return fail(`battle.presentation は "dq" か "ff": ${JSON.stringify(b.presentation)}`)
  if (b.windowStyle !== undefined && b.windowStyle !== 'dark' && b.windowStyle !== 'ff-blue')
    return fail(`battle.windowStyle は "dark" か "ff-blue": ${JSON.stringify(b.windowStyle)}`)
  if (b.commandLayout !== undefined && b.commandLayout !== 'grid' && b.commandLayout !== 'cross')
    return fail(`battle.commandLayout は "grid" か "cross": ${JSON.stringify(b.commandLayout)}`)
  if (b.atb !== undefined && b.atb !== 'on' && b.atb !== 'off')
    return fail(`battle.atb は "on" か "off": ${JSON.stringify(b.atb)}`)
  if (b.atbMode !== undefined && b.atbMode !== 'wait' && b.atbMode !== 'active')
    return fail(`battle.atbMode は "wait" か "active": ${JSON.stringify(b.atbMode)}`)
  // front では効かない設定の組（静かに無視されるので警告する。読み込みは成功のまま）
  const warnings: string[] = []
  if (b.layout === 'front') {
    if (b.presentation === 'ff')
      warnings.push(
        'battle.presentation "ff" は layout "side" のときだけ効きます（"front" では無視されます）'
      )
    if (b.commandLayout === 'cross')
      warnings.push(
        'battle.commandLayout "cross" は layout "side" のときだけ効きます（"front" では無視されます）'
      )
  }
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

  // 敵グリッド (#839)。不正値はエラーにせず無効（従来の配置）
  const enemyGrid = normalizeEnemyGrid(typeof b.enemyGrid === 'string' ? b.enemyGrid : undefined)
  const enemyWindowOverlap =
    typeof b.enemyWindowOverlap === 'number' && Number.isFinite(b.enemyWindowOverlap)
      ? normalizeEnemyWindowOverlapSetting(String(b.enemyWindowOverlap))
      : undefined

  // 収まらない群の検証 (#839 段5)。グリッドが有効なときだけ全シーンの群を検証し、収まらない群を除外する
  let groupErrors: EncounterGroupError[] | undefined
  if (enemyGrid) {
    const inputs = Object.values(scenes).flatMap((sc) =>
      (sc.encounter?.groups ?? []).map((spec) => ({ mapId: sc.id, spec }))
    )
    const result = validateEncounterGroups({ grid: enemyGrid, masters: monsters, groups: inputs })
    if (result.errors.length > 0) {
      groupErrors = result.errors
      console.error(`[name-name] ${formatEncounterGroupErrors(result.errors)}`)
      const bad = new Set(
        inputs.filter((_, i) => !result.valid[i]).map((g) => `${g.mapId}\u0000${g.spec}`)
      )
      for (const sc of Object.values(scenes)) {
        const enc = sc.encounter
        if (!enc) continue
        sc.encounter = {
          ...enc,
          groups: enc.groups.filter((spec) => !bad.has(`${sc.id}\u0000${spec}`)),
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      startScene: raw.startScene,
      start: { x: s.x, y: s.y },
      speed: speed.value,
      edgeThreshold: edgeThreshold.value,
      player: { sprites, mirrorOf, height: height.value, frameMs: frameMs.value },
      scenes,
      encounter: { stepDistance: stepDistance.value, minSteps },
      monsters,
      party,
      spells: spells.value,
      items: items.value,
      battle: {
        layout: b.layout ?? 'side',
        spriteStyle: b.spriteStyle ?? 'none',
        ...(battleBg ? { background: battleBg } : {}),
        width: bw.value,
        height: bh.value,
        ...(enemyGrid ? { enemyGrid } : {}),
        ...(enemyWindowOverlap !== undefined ? { enemyWindowOverlap } : {}),
        ...(b.presentation ? { presentation: b.presentation } : {}),
        ...(b.windowStyle ? { windowStyle: b.windowStyle } : {}),
        ...(b.commandLayout ? { commandLayout: b.commandLayout } : {}),
        ...(b.atb === 'on' ? { atb: { mode: b.atbMode ?? 'wait' } } : {}),
      },
      ...(groupErrors ? { groupErrors } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  }
}

/** 全角の数字・x を半角へ（parser/src/master.rs の `to_halfwidth` と同じ範囲。`×` はそのまま） */
function toHalfwidth(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[ｘＸ]/g, 'x')
}

/**
 * `monsters.<id>.size`（"2x1" など。幅x高さ、整数 1 以上）を解釈する。Rust parser の `サイズ:`（master.rs `parse_size_pair`）と同じ書式:
 * x / X / × 区切り・全角数字可・符号や小数は不可・u32 の範囲。未指定は undefined。不正はエラー
 */
export function parseMonsterSize(
  raw: unknown,
  path: string
): ParseResult<{ w: number; h: number } | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  const bad = fail(`${path} は "2x1" のような 幅x高さ（整数 1 以上）: ${JSON.stringify(raw)}`)
  if (typeof raw !== 'string') return bad
  const parts = toHalfwidth(raw).split(/[xX×]/)
  if (parts.length < 2) return bad
  // Rust の split_once は最初の区切りで 2 つに割る。残りに区切りが含まれると数字だけの検査で落ちる
  if (parts.length > 2) return bad
  const [a, b] = parts.map((t) => t.trim())
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return bad
  const w = Number(a)
  const h = Number(b)
  const U32_MAX = 4294967295
  if (w < 1 || h < 1 || w > U32_MAX || h > U32_MAX) return bad
  return { ok: true, value: { w, h } }
}

/** `monsters.<id>.scale`（数値。0.25〜1 に丸める。`倍率:` と同じ範囲）。未指定は undefined。数値でなければエラー */
export function parseMonsterScale(raw: unknown, path: string): ParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'number' || !Number.isFinite(raw))
    return fail(`${path} は数値（0.25〜1 に丸めます）: ${JSON.stringify(raw)}`)
  return { ok: true, value: Math.min(1, Math.max(0.25, raw)) }
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
  if (raw.poses !== undefined) {
    const poses = parsePoses(raw.poses, `${path}.poses`, (v) => {
      const r = url(v, `${path}.poses`)
      return r.ok ? r.value : null
    })
    if (!poses.ok) return poses
    if (poses.value) e.poses = poses.value
  }
  return { ok: true, value: e }
}

/**
 * 「今すぐエンカウント（確認用）」の抽選候補（群の文字列の配列）。
 * シーンに群があればそれ。群が空（最初から無い・全群が敵グリッドに収まらず無効化された）なら全モンスターを 1 体ずつの群として使うが、
 * 敵グリッドが有効なときは、1 体でも収まらない（サイズ超過など）モンスターは候補から外す (#839 段5)。
 */
export function forceBattleCandidates(config: FieldSampleConfig, sceneId: string): string[] {
  const groups = hasOwn(config.scenes, sceneId)
    ? (config.scenes[sceneId].encounter?.groups ?? [])
    : []
  if (groups.length > 0) return groups
  const ids = Object.keys(config.monsters)
  const grid = config.battle.enemyGrid
  if (!grid) return ids
  return ids.filter(
    (id) =>
      validateEncounterGroups({
        grid,
        masters: config.monsters,
        groups: [{ mapId: sceneId, spec: id }],
      }).errors.length === 0
  )
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

/** 読み込み成功時に画面へ出す通知（群エラーの一覧＋警告）。無ければ null。showError は置換なので 1 つにまとめる */
export function configNotice(config: FieldSampleConfig): string | null {
  const parts: string[] = []
  if (config.groupErrors && config.groupErrors.length > 0)
    parts.push(formatEncounterGroupErrors(config.groupErrors))
  if (config.warnings) parts.push(...config.warnings)
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * URL の検索文字列から、設定の読み元を決める (#890)。`?config=` が与えられていれば（URL として解決できなくても）
 * それが優先で、`?fixture=dummy` は `?config=` が無いときだけ効く
 */
export function pickConfigSource(search: string): {
  configParam: string | undefined
  dummy: boolean
} {
  const q = new URLSearchParams(search)
  const configParam = q.get('config')?.trim() || undefined
  return { configParam, dummy: !configParam && q.get('fixture') === 'dummy' }
}
