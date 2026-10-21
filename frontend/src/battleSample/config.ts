/**
 * 戦闘画面サンプルページ (#749) の設定まわりの純粋関数。
 * ブラウザ API には触れない（URL 解決の基準 URL は引数で受ける）。
 */
import type { BattleEntity } from '../game/spellDsl'
import type {
  ItemDef,
  JobDef,
  MagiciteDef,
  MonsterLoot,
  SkillDef,
  StatusDef,
  SummonDef,
} from '../types'
import type { BattleResult } from '../game/loot'
import { normalizeAttrId, type BattleAffinity } from '../game/affinity'
import { applyPartyEquipment, parseGear, parseJobs } from './configEquipment'
import { parseBeasts, parseMagicites } from './configMagicite'
import { resolveSummonRefs, warnSummonOnce } from '../game/summons'
import { toSkillExecutions } from '../game/enemyAi'
import {
  DEPTH_DEFAULT_HORIZON,
  normalizeBattleRow,
  type BattleDepth,
  type BattleLayoutMode,
} from '../game/battleLayout'
import type { SpriteStyle } from '../game/spriteStyle'
import type { WindowStyle } from '../game/windowStyle'
import type { BackgroundTone } from '../game/backgroundTone'
import type { BackgroundDof } from '../game/depthOfField'
import type { BattleLogTypewriterMode } from '../game/battleLogTypewriter'
import { normalizePoses, type BattlePresentation } from '../game/battleMotion'
import type { AtbMode, BattleScriptOptions, SkillExecution } from '../game/battleEngine'
import type { BattleAtbConfig } from '../game/battleAtb'
import {
  COMMAND_DEFAULTS,
  parseCommandIds,
  type CommandId,
  type CommandLabels,
  type CommandLayout,
} from '../game/battleCommands'
import type {
  BattleItemEntry,
  BattleMenuData,
  BattleSkillEntry,
  BattleSpellEntry,
  BattleSummonEntry,
} from '../game/battleMenu'

export const SCREEN_SIZES = [
  { id: '360x640', width: 360, height: 640 },
  { id: '800x450', width: 800, height: 450 },
  { id: '1280x720', width: 1280, height: 720 },
  { id: '640x360', width: 640, height: 360 },
] as const
export type ScreenSizeId = (typeof SCREEN_SIZES)[number]['id']

/**
 * 描画解像度。main = 本編相当（本編の app.init は resolution 未指定 = 1）、dpr = 実 DPR。
 * 既定は main（本編と同じ見た目を確認するため）。
 */
export const RESOLUTION_MODES = ['main', 'dpr'] as const
export type ResolutionMode = (typeof RESOLUTION_MODES)[number]
/**
 * 戦闘の結果（経験値・ゴールド・戦利品、#831）を 1 つの文にする。ホストが `onClose` で受け取る `BattleResult` の確認用（サンプルページの表示）。
 * 戦利品は獲得順に `品 ×個数（ドロップ / ぬすむ / ぬすむ〔レア〕・元の敵）`、無ければ「なし」
 */
export function describeBattleResult(
  result: BattleResult,
  names: Readonly<Record<string, string>> = {}
): string {
  const name = (id: string): string =>
    Object.prototype.hasOwnProperty.call(names, id) ? names[id] : id
  const loot =
    result.loot.length === 0
      ? 'なし'
      : result.loot
          .map((l) => {
            const via = l.via === 'drop' ? 'ドロップ' : l.rare ? 'ぬすむ・レア' : 'ぬすむ'
            return `${name(l.itemId)} ×${l.count}（${via}・${l.enemyName}）`
          })
          .join(' / ')
  const script = result.script
    ? `  脚本: ${result.script.id} フラグ=${JSON.stringify(result.script.flags)}${result.script.next !== undefined ? ` 次=${result.script.next}` : ''}`
    : ''
  return `結果: ${result.outcome}  exp=${result.exp}  gold=${result.gold}  戦利品: ${loot}${script}`
}

export const DEFAULT_RESOLUTION_MODE: ResolutionMode = 'main'

/**
 * 隊列の見せ方 (#747)。config = 設定 JSON の party[].row どおり、front = 全員前衛、
 * backHalf = 前衛が人数の半分（切り上げ）、残りを後衛にする（1 人=後衛 0 / 2 人=1 / 3 人=1 / 4 人=2）。ライブ比較用。
 */
export const FORMATION_MODES = ['config', 'front', 'backHalf'] as const
export type FormationMode = (typeof FORMATION_MODES)[number]

/** 設定 JSON に horizon / perspective が無いときの奥行きオン時の既定（サンプル用の見やすい値） */
export const SAMPLE_DEFAULT_PERSPECTIVE = 0.8

export const DEFAULT_SIZE_ID: ScreenSizeId = '800x450'
export const MAX_PARTY = 4
export const MAX_ENEMIES = 4

/** 検証・補完・URL 解決済みの設定 */
export interface BattleSampleConfig {
  layout: BattleLayoutMode
  spriteStyle: SpriteStyle
  windowStyle: WindowStyle
  /** 背景の彩度・明度を落とすか (#753)。既定 on */
  backgroundTone: BackgroundTone
  /** 背景の被写界深度風の手前ぼかし (#753)。既定 off */
  backgroundDof: BackgroundDof
  /** ドット絵モード (#466・#760)。on なら戦闘のテクスチャを nearest のまま使う（既定 off＝mipmap+linear で縮小をなめらかに） */
  pixelArt: 'on' | 'off'
  /** 戦闘ログの 1 文字ずつ表示 (#755)。既定 off */
  logTypewriter: BattleLogTypewriterMode
  /** 演出方式 (#745)。既定 dq（現行の見た目・挙動）。ff は side のときだけ効く */
  presentation: BattlePresentation
  /** ATB 方式 (#205)。既定 off（従来ターン制） */
  atb: 'on' | 'off'
  /** ATB の進行方式 (#205)。既定 wait（コマンド選択中は時間停止） */
  atbMode: AtbMode
  /** コマンド窓の配置 (#204)。既定 grid（2x2）。cross は side のとき十字配置＋矢印キー */
  commandLayout: CommandLayout
  /** コマンドの表示名の上書き (#204)。部分指定可（省略は既定の日本語）。id は変わらない */
  commandLabels: CommandLabels
  /** 候補窓の呪文 (#204)。味方全員が使える（grid でも cross でも「じゅもん」で開く）。MP が足りないものはグレー */
  spells: BattleSpellEntry[]
  /** 候補窓のアイテム (#204)。`count` は所持数（使うたびに BattleScreen が渡された entry の count を 1 減らす。呼び出し側は戦闘ごとに複製を渡す） */
  items: BattleItemEntry[]
  /** 絶対 URL。なしは null */
  background: string | null
  /** 奥行きの地平線の高さ（画面比 0〜1）(#747)。奥行きオン時に使う。既定 DEPTH_DEFAULT_HORIZON */
  horizon: number
  /** 奥行きの遠近の強さ（0〜1）(#747)。奥行きオン時に使う。既定 SAMPLE_DEFAULT_PERSPECTIVE */
  perspective: number
  /** 前景レイヤー画像の絶対 URL (#747)。なしは null */
  foreground: string | null
  /** 敵が使える特技 (#835)。設定 JSON の `skills`。`enemies[].actions` の候補の id から引く。既定は空 */
  skills: Record<string, SkillExecution>
  /** 状態の宣言 (#870)。設定 JSON の `statuses`（`[状態]` と同じキー: id / name / duration / tickDamage / action / reverse / cure / expire）。既定は空 */
  statuses: Record<string, StatusDef>
  /** コマンドの構成と順序 (#889)。設定 JSON の `commands`（`attack` / `skill` / `summon` / `spell` / `item` / `escape` を重複なく）。未指定は undefined＝既定の 4 つ */
  commands: CommandId[] | undefined
  /** 魔石の宣言 (#889)。設定 JSON の `magicites`（`[魔石]` と同じキー）。`party[].magicites` が装備する。既定は空 */
  magicites: Record<string, MagiciteDef>
  /** 魔石を装備した味方の「しょうかん」の行 (#889)（味方 id → 行）。`party[].magicites` / `party[].equipment` から作る。既定は空 */
  summons: Record<string, BattleSummonEntry[]>
  /** 装備品の宣言 (#207)。設定 JSON の `gear`（`[アイテム]` の装備品と同じキー）。`party[].equipment` が装備する。既定は空 */
  gear: Record<string, ItemDef>
  /** ジョブの宣言 (#740)。設定 JSON の `jobs`（`[ジョブ]` と同じキー）。`party[].jobs` が就けるジョブ、`party[].job` が現在のジョブ。既定は空 */
  jobs: Record<string, JobDef>
  /** 味方の「わざ」の行 (#207)（味方 id → 行）。`party[].abilities` と装備中の `gear` の `abilities` から、`skills` を引いて作る。既定は空 */
  abilities: Record<string, BattleSkillEntry[]>
  /** 戦利品のログ用の表示名 (#831)。設定 JSON の `itemNames`（アイテム id → 名前）。既定は空（id をそのまま表示） */
  itemNames: Record<string, string>
  /**
   * 脚本制御の戦闘 (#741 / #863)。設定 JSON の `script`（`{ id?, rules: [...], joiners?: [...] }`。`rules` は `[戦闘]` の `キー: 値` の行、
   * `joiners` は途中参戦する味方で `party` と同じ書式）。既定は null（脚本なし＝従来の戦闘）
   */
  script: BattleScriptOptions | null
  party: BattleEntity[]
  enemies: BattleEntity[]
}

/** ツールバーで切り替える表示状態（ブリンク比較の単位） */
export interface BattleSampleView {
  layout: BattleLayoutMode
  spriteStyle: SpriteStyle
  windowStyle: WindowStyle
  backgroundTone: BackgroundTone
  backgroundDof: BackgroundDof
  pixelArt: 'on' | 'off'
  logTypewriter: BattleLogTypewriterMode
  /** 演出方式 (#745)。既定 dq。ff（FF 式）は layout が side のときだけ効く */
  presentation: BattlePresentation
  /** ATB 方式 (#205)。既定 off（従来ターン制） */
  atb: 'on' | 'off'
  /** ATB の進行方式 (#205)。atb が on のときだけ効く */
  atbMode: AtbMode
  /** コマンド窓の配置 (#204)。既定 grid */
  commandLayout: CommandLayout
  backgroundOn: boolean
  /** 奥行き (#747)。on のとき config の horizon / perspective で行ごとの縮尺をつける。既定 off（平面） */
  depth: 'on' | 'off'
  /** 前景レイヤー (#747) */
  foregroundOn: boolean
  /** 隊列 (#747) */
  formation: FormationMode
  partyCount: number
  enemyCount: number
  sizeId: ScreenSizeId
  resolutionMode: ResolutionMode
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 内蔵既定の味方（sprite なし = 色四角） */
export function defaultParty(): BattleEntity[] {
  const names = ['ゆうしゃ', 'まほうつかい', 'そうりょ', 'せんし']
  return names.map((name, i) => ({
    id: `party${i + 1}`,
    name,
    hp: 30 - i * 3,
    maxHp: 30,
    mp: 8 + i,
    maxMp: 12,
    atk: 8,
    def: 4,
    agi: 5,
  }))
}

/** 内蔵既定の敵（sprite なし = 色四角） */
export function defaultEnemies(): BattleEntity[] {
  const names = ['スライム', 'ドラキー', 'ゴースト', 'ドラゴン']
  return names.map((name, i) => ({
    id: `enemy${i + 1}`,
    name,
    hp: 20 + i * 10,
    maxHp: 20 + i * 10,
    mp: 0,
    maxMp: 0,
    atk: 6,
    def: 2,
    agi: 3,
    exp: 5,
    gold: 3,
  }))
}

/** 内蔵既定の呪文 (#204)。メテオは MP 20 で、既定の味方（MP 最大 12）には足りずグレーになる。一覧が長いときの確認用に 6 件 */
export function defaultSpells(): BattleSpellEntry[] {
  return [
    { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14 type=fire' },
    { id: 'thunder', name: 'いなずま', mp: 6, target: '敵全体', effect: 'damage 5..9' },
    { id: 'heal', name: 'ヒール', mp: 2, target: '味方単体', effect: 'heal 15..25' },
    { id: 'heal-all', name: 'ヒーリング', mp: 8, target: '味方全体', effect: 'heal 10..15' },
    { id: 'self', name: 'ちゆのいのり', mp: 4, target: '自分', effect: 'heal 20..30' },
    { id: 'meteor', name: 'メテオ', mp: 20, target: '敵全体', effect: 'damage 30..40' },
  ]
}

/** 内蔵既定のアイテム (#204) */
export function defaultItems(): BattleItemEntry[] {
  return [
    { id: 'potion', name: 'ポーション', effect: 'heal 20..30', count: 3 },
    { id: 'hi-potion', name: 'ハイポーション', effect: 'heal 50..60', count: 1 },
    { id: 'ether', name: 'エーテル', effect: 'heal 1..1', count: 0 },
  ]
}

export function defaultConfig(): BattleSampleConfig {
  return {
    layout: 'side',
    spriteStyle: 'none',
    windowStyle: 'dark',
    backgroundTone: 'on',
    backgroundDof: 'off',
    pixelArt: 'off',
    logTypewriter: 'off',
    presentation: 'dq',
    atb: 'off',
    atbMode: 'wait',
    commandLayout: 'grid',
    commandLabels: {},
    spells: defaultSpells(),
    items: defaultItems(),
    background: null,
    horizon: DEPTH_DEFAULT_HORIZON,
    perspective: SAMPLE_DEFAULT_PERSPECTIVE,
    foreground: null,
    skills: {},
    statuses: {},
    commands: undefined,
    magicites: {},
    summons: {},
    gear: {},
    jobs: {},
    abilities: {},
    itemNames: {},
    script: null,
    party: defaultParty(),
    enemies: defaultEnemies(),
  }
}

/** 絶対 URL または基準 URL からの相対 URL を絶対 URL にする。解決できなければ null */
export function resolveUrl(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).href
  } catch {
    return null
  }
}

/** location.search から `config` パラメータ（設定 JSON の URL）を取り出し、基準 URL で解決する */
export function extractConfigUrl(search: string, baseUrl: string): string | null {
  const raw = new URLSearchParams(search).get('config')
  if (!raw || !raw.trim()) return null
  return resolveUrl(raw.trim(), baseUrl)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number, min = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback
}

/**
 * 戦闘ポーズ別スプライト (#745) の設定 `{ "idle": "...", "step": "...", ... }` を検証して URL に解決する（部分指定可・値は URL 文字列）。
 * 戦闘サンプルとフィールドサンプル (#890) で共有する。URL の解決方法は `resolve` で呼び出し側が決める。
 * 未知のポーズ名は無視する（部分指定の typo で全体を落とさない）。1 つも残らなければ undefined
 */
export function parsePoses(
  raw: unknown,
  path: string,
  resolve: (url: string) => string | null
): ParseResult<BattleEntity['poses'] | undefined> {
  if (!isRecord(raw)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
  const resolved: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `${path}.${k} は URL 文字列である必要があります` }
    }
    if (!v.trim()) continue
    const url = resolve(v.trim())
    if (!url) return { ok: false, error: `${path}.${k} の URL を解決できません: ${v}` }
    resolved[k] = url
  }
  return { ok: true, value: normalizePoses(resolved) }
}

function parseEntity(
  raw: unknown,
  fallback: BattleEntity,
  baseUrl: string,
  path: string
): ParseResult<BattleEntity> {
  if (!isRecord(raw)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
  if (raw.sprite !== undefined && typeof raw.sprite !== 'string') {
    return { ok: false, error: `${path}.sprite は文字列である必要があります` }
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') {
    return { ok: false, error: `${path}.name は文字列である必要があります` }
  }
  const maxHp = Math.max(
    1,
    num(raw.maxHp, raw.hp !== undefined ? num(raw.hp, fallback.maxHp, 1) : fallback.maxHp)
  )
  const maxMp = num(raw.maxMp, raw.mp !== undefined ? num(raw.mp, fallback.maxMp) : fallback.maxMp)
  const entity: BattleEntity = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallback.name,
    hp: Math.min(maxHp, num(raw.hp, maxHp)),
    maxHp,
    mp: Math.min(maxMp, num(raw.mp, maxMp)),
    maxMp,
    atk: num(raw.atk, fallback.atk),
    def: num(raw.def, fallback.def),
    agi: num(raw.agi, fallback.agi),
    exp: fallback.exp,
    gold: fallback.gold,
  }
  if (raw.row !== undefined) {
    if (typeof raw.row !== 'string') {
      return { ok: false, error: `${path}.row は "front" か "back": ${JSON.stringify(raw.row)}` }
    }
    if (normalizeBattleRow(raw.row) === 'back') entity.row = 'back'
  }
  if (typeof raw.sprite === 'string' && raw.sprite.trim()) {
    const url = resolveUrl(raw.sprite.trim(), baseUrl)
    if (!url) return { ok: false, error: `${path}.sprite の URL を解決できません: ${raw.sprite}` }
    entity.sprite = url
  }
  if (raw.poses !== undefined) {
    const poses = parsePoses(raw.poses, `${path}.poses`, (u) => resolveUrl(u, baseUrl))
    if (!poses.ok) return poses
    if (poses.value) entity.poses = poses.value
  }
  if (raw.actions !== undefined) {
    // 敵の行動ルール (#835)。`行動:` の値と同じ書式の文字列の配列（書いた順）。解釈は enemyAi.ts（不正な行は戦闘側で警告して無視）
    if (!Array.isArray(raw.actions) || raw.actions.some((a) => typeof a !== 'string')) {
      return { ok: false, error: `${path}.actions は文字列の配列である必要があります` }
    }
    const actions = (raw.actions as string[]).map((a) => a.trim()).filter((a) => a !== '')
    if (actions.length > 0) entity.actions = actions
  }
  if (raw.counters !== undefined) {
    // 敵の反撃ルール (#837)。`反撃:` の値と同じ書式の文字列の配列（書いた順）
    if (!Array.isArray(raw.counters) || raw.counters.some((a) => typeof a !== 'string')) {
      return { ok: false, error: `${path}.counters は文字列の配列である必要があります` }
    }
    const counters = (raw.counters as string[]).map((a) => a.trim()).filter((a) => a !== '')
    if (counters.length > 0) entity.counters = counters
  }
  if (raw.onDeath !== undefined) {
    // 敵の死亡時の行動 (#837)。`死亡時:` の値と同じ書式の 1 行の文字列
    if (typeof raw.onDeath !== 'string') {
      return { ok: false, error: `${path}.onDeath は文字列である必要があります` }
    }
    if (raw.onDeath.trim() !== '') entity.onDeath = raw.onDeath.trim()
  }
  if (raw.affinity !== undefined) {
    // 味方側の属性（防具・魔石）は未対応 (#872 の範囲外)。黙って効いてしまわないよう読み込みエラーにする
    if (path.startsWith('party[')) {
      return {
        ok: false,
        error: `${path}.affinity: 味方側の相性は未対応です（enemies[].affinity のみ）`,
      }
    }
    // 属性相性 (#872)。`[モンスター]` の `弱点:` 等と同じ 4 欄。各欄は属性 id の文字列の配列（parser と同じ表で半角・小文字に寄せる）
    if (!isRecord(raw.affinity)) {
      return { ok: false, error: `${path}.affinity はオブジェクトである必要があります` }
    }
    const out: BattleAffinity = {}
    for (const key of ['weak', 'halve', 'nullify', 'absorb'] as const) {
      const v = raw.affinity[key]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) {
        return { ok: false, error: `${path}.affinity.${key} は文字列の配列である必要があります` }
      }
      const ids = (v as string[]).map((a) => normalizeAttrId(a.trim())).filter((a) => a !== '')
      if (ids.length > 0) out[key] = ids
    }
    if (Object.keys(out).length > 0) entity.affinity = out
  }
  if (raw.loot !== undefined) {
    // 敵の戦利品 (#831)。`[モンスター]` の `ドロップ:` `ぬすむ:` `ぬすむレア:` `ぬすむ回数:` と同じ書式の文字列（drops / steal / stealRare は配列、stealLimit は 1 つの文字列）
    if (path.startsWith('party[')) {
      return { ok: false, error: `${path}.loot: 戦利品は enemies[] だけに書けます` }
    }
    if (!isRecord(raw.loot)) {
      return { ok: false, error: `${path}.loot はオブジェクトである必要があります` }
    }
    const out: MonsterLoot = {}
    for (const key of ['drops', 'steal', 'stealRare'] as const) {
      const v = raw.loot[key]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) {
        return { ok: false, error: `${path}.loot.${key} は文字列の配列である必要があります` }
      }
      const lines = (v as string[]).map((a) => a.trim()).filter((a) => a !== '')
      if (lines.length > 0) out[key] = lines
    }
    if (raw.loot.stealLimit !== undefined) {
      if (typeof raw.loot.stealLimit !== 'string' && typeof raw.loot.stealLimit !== 'number') {
        return { ok: false, error: `${path}.loot.stealLimit は文字列か数です` }
      }
      out.stealLimit = String(raw.loot.stealLimit)
    }
    if (Object.keys(out).length > 0) entity.loot = out
  }
  return { ok: true, value: entity }
}

function parseEntities(
  raw: unknown,
  defaults: BattleEntity[],
  max: number,
  baseUrl: string,
  key: string
): ParseResult<BattleEntity[]> {
  if (raw === undefined) return { ok: true, value: defaults }
  if (!Array.isArray(raw)) return { ok: false, error: `${key} は配列である必要があります` }
  if (raw.length === 0) return { ok: false, error: `${key} は 1 件以上必要です` }
  const out: BattleEntity[] = []
  for (let i = 0; i < Math.min(raw.length, max); i++) {
    const r = parseEntity(raw[i], defaults[i % defaults.length], baseUrl, `${key}[${i}]`)
    if (!r.ok) return r
    // id 重複を避ける（既定 id を流用した場合）
    const dup = out.some((e) => e.id === r.value.id)
    out.push(dup ? { ...r.value, id: `${r.value.id}-${i}` } : r.value)
  }
  return { ok: true, value: out }
}

/** 設定 JSON の commandLabels (#204) を検証する。`{ attack?, spell?, item?, escape? }`（値は空でない文字列） */
function parseCommandLabelsConfig(raw: unknown): ParseResult<CommandLabels> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!isRecord(raw))
    return { ok: false, error: 'commandLabels はオブジェクトである必要があります' }
  const ids: readonly string[] = COMMAND_DEFAULTS.map((c) => c.id)
  const out: CommandLabels = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!ids.includes(k)) {
      return { ok: false, error: `commandLabels のキーは ${ids.join(' / ')}: ${JSON.stringify(k)}` }
    }
    if (typeof v !== 'string' || v.trim() === '') {
      return {
        ok: false,
        error: `commandLabels.${k} は空でない文字列である必要があります: ${JSON.stringify(v)}`,
      }
    }
    out[k as keyof CommandLabels] = v
  }
  return { ok: true, value: out }
}

/** 設定 JSON の skills (#835) を検証する。`[{ id, name?, target?, effect?, builtin?, message?, telegraph? }]`。`id` は必須（`actions` の候補から引く） */
function parseSkills(
  raw: unknown
): ParseResult<Record<string, SkillExecution & { summonId?: string }>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!Array.isArray(raw)) return { ok: false, error: 'skills は配列である必要があります' }
  const entries: [string, SkillExecution & { summonId?: string }][] = []
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `skills[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    if (typeof r.id !== 'string' || r.id.trim() === '') {
      return { ok: false, error: `${path}.id は空でない文字列である必要があります` }
    }
    for (const f of [
      'name',
      'target',
      'effect',
      'builtin',
      'message',
      'telegraph',
      'summonId',
    ] as const) {
      if (r[f] !== undefined && typeof r[f] !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
    }
    const id = r.id.trim()
    entries.push([
      id,
      {
        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id,
        target: typeof r.target === 'string' && r.target.trim() ? r.target.trim() : '相手単体',
        ...(typeof r.effect === 'string' ? { effect: r.effect } : {}),
        ...(typeof r.builtin === 'string' ? { builtin: r.builtin } : {}),
        ...(typeof r.message === 'string' ? { message: r.message } : {}),
        ...(typeof r.telegraph === 'string' ? { telegraph: r.telegraph } : {}),
        // 召喚獣の参照 (#750)。`beasts` を引き当てる前の印で、解決後の特技には演出の元（cue）が付く
        ...(typeof r.summonId === 'string' && r.summonId.trim() !== ''
          ? { summonId: r.summonId.trim() }
          : {}),
      },
    ])
  }
  return { ok: true, value: Object.fromEntries(entries) }
}

/**
 * 設定 JSON の特技・魔石の `summonId` (#750) を `beasts` へ引き当てる。どちらも参照しなければ入力と同じオブジェクトを返す（従来と同一）。
 * 特技は `SkillExecution`（id を持たない）なので、引き当てるときだけ `SkillDef` へ写して解決し、演出の元（cue）つきの `SkillExecution` へ戻す
 */
function resolveSampleSummons(
  skills: Record<string, SkillExecution & { summonId?: string }>,
  magicites: Record<string, MagiciteDef>,
  beasts: Record<string, SummonDef>
): { skills: Record<string, SkillExecution>; magicites: Record<string, MagiciteDef> } {
  const hasRef =
    Object.values(skills).some((s) => s.summonId !== undefined) ||
    Object.values(magicites).some((m) => m.summonId !== undefined)
  if (!hasRef) return { skills, magicites }
  const defs: Record<string, SkillDef> = {}
  for (const [id, s] of Object.entries(skills)) defs[id] = { id, ...s }
  const r = resolveSummonRefs({ skills: defs, magicites, summons: beasts })
  warnSummonOnce(r.warnings)
  return {
    skills: r.skills ? toSkillExecutions(r.skills) : skills,
    magicites: r.magicites ?? magicites,
  }
}

/**
 * 設定 JSON の statuses (#870) を検証する。`[{ id, name?, duration?, tickDamage?, action?, reverse?, cure?, expire? }]`。
 * `id` は必須。値は `[状態]` と同じ書式の文字列（解釈は `game/statusEffects.ts`）。`name` 省略は id
 */
function parseStatuses(raw: unknown): ParseResult<Record<string, StatusDef>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!Array.isArray(raw)) return { ok: false, error: 'statuses は配列である必要があります' }
  const entries: [string, StatusDef][] = []
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `statuses[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    if (typeof r.id !== 'string' || r.id.trim() === '') {
      return { ok: false, error: `${path}.id は空でない文字列である必要があります` }
    }
    const def: StatusDef = {
      id: r.id.trim(),
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id.trim(),
    }
    for (const f of ['duration', 'tickDamage', 'action', 'reverse', 'cure', 'expire'] as const) {
      const v = r[f]
      if (v === undefined) continue
      // 持続は数値でも書ける（`"duration": 3`）
      const text = typeof v === 'number' && f === 'duration' ? String(v) : v
      if (typeof text !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
      if (text.trim() !== '') def[f] = text.trim()
    }
    entries.push([def.id, def])
  }
  return { ok: true, value: Object.fromEntries(entries) }
}

/** 設定 JSON の spells / items (#204) と skills（わざ、#873。MP なし・`target` は特技の相対表現で既定 `相手単体`）を検証する。`name` は必須、`id` 省略は連番、`effect` / `builtin` は文字列 */
export function parseMenuList<T extends BattleSpellEntry | BattleItemEntry | BattleSkillEntry>(
  raw: unknown,
  fallback: T[],
  key: 'spells' | 'items' | 'skills'
): ParseResult<T[]> {
  if (raw === undefined) return { ok: true, value: fallback }
  if (!Array.isArray(raw)) return { ok: false, error: `${key} は配列である必要があります` }
  const out: T[] = []
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `${key}[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    if (typeof r.name !== 'string' || r.name.trim() === '') {
      return { ok: false, error: `${path}.name は空でない文字列である必要があります` }
    }
    for (const f of ['mp', 'count'] as const) {
      if (r[f] !== undefined && (typeof r[f] !== 'number' || !Number.isFinite(r[f]))) {
        return { ok: false, error: `${path}.${f} は数値である必要があります` }
      }
    }
    for (const f of ['effect', 'builtin', 'id'] as const) {
      if (r[f] !== undefined && typeof r[f] !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
    }
    const base = {
      id: typeof r.id === 'string' && r.id ? r.id : `${key}-${i + 1}`,
      name: r.name.trim(),
      ...(typeof r.effect === 'string' ? { effect: r.effect } : {}),
      ...(typeof r.builtin === 'string' ? { builtin: r.builtin } : {}),
    }
    if (key === 'skills') {
      if (typeof r.target !== 'undefined' && typeof r.target !== 'string') {
        return { ok: false, error: `${path}.target は文字列である必要があります` }
      }
      out.push({
        ...base,
        target: typeof r.target === 'string' ? r.target : '相手単体',
      } as T)
    } else if (key === 'spells') {
      if (typeof r.target !== 'undefined' && typeof r.target !== 'string') {
        return { ok: false, error: `${path}.target は文字列である必要があります` }
      }
      out.push({
        ...base,
        mp: num(r.mp, 0),
        target: typeof r.target === 'string' ? r.target : '敵単体',
      } as T)
    } else {
      out.push({
        ...base,
        ...(typeof r.count === 'number' && Number.isFinite(r.count)
          ? { count: Math.max(0, Math.floor(r.count)) }
          : {}),
      } as T)
    }
  }
  return { ok: true, value: out }
}

/** 設定 JSON（パース済みの値）を検証し、既定値を補完し、URL を絶対化する */
/** 設定 JSON の `script` (#741)。`rules` は文字列の配列（必須）、`joiners` は味方と同じ書式の配列（任意） */
function parseScript(raw: unknown, baseUrl: string): ParseResult<BattleScriptOptions | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (!isRecord(raw)) return { ok: false, error: 'script はオブジェクトである必要があります' }
  if (!Array.isArray(raw.rules) || raw.rules.some((r) => typeof r !== 'string')) {
    return { ok: false, error: 'script.rules は文字列の配列である必要があります' }
  }
  let id = 'sample'
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id === '') {
      return { ok: false, error: 'script.id は空でない文字列である必要があります' }
    }
    id = raw.id
  }
  const joiners: Record<string, BattleEntity> = {}
  if (raw.joiners !== undefined) {
    const list = parseEntities(raw.joiners, defaultParty(), MAX_PARTY, baseUrl, 'script.joiners')
    if (!list.ok) return list
    for (const e of list.value) joiners[e.id] = e
  }
  return {
    ok: true,
    value: {
      id,
      rules: raw.rules as string[],
      ...(Object.keys(joiners).length > 0 ? { joiners } : {}),
    },
  }
}

export function parseConfig(raw: unknown, baseUrl: string): ParseResult<BattleSampleConfig> {
  if (!isRecord(raw))
    return { ok: false, error: '設定 JSON のルートはオブジェクトである必要があります' }
  const def = defaultConfig()
  let layout = def.layout
  if (raw.layout !== undefined) {
    if (raw.layout !== 'front' && raw.layout !== 'side') {
      return { ok: false, error: `layout は "front" か "side": ${JSON.stringify(raw.layout)}` }
    }
    layout = raw.layout
  }
  let spriteStyle = def.spriteStyle
  if (raw.spriteStyle !== undefined) {
    if (raw.spriteStyle !== 'none' && raw.spriteStyle !== 'acrylic') {
      return {
        ok: false,
        error: `spriteStyle は "none" か "acrylic": ${JSON.stringify(raw.spriteStyle)}`,
      }
    }
    spriteStyle = raw.spriteStyle
  }
  let windowStyle = def.windowStyle
  if (raw.windowStyle !== undefined) {
    if (raw.windowStyle !== 'dark' && raw.windowStyle !== 'ff-blue') {
      return {
        ok: false,
        error: `windowStyle は "dark" か "ff-blue": ${JSON.stringify(raw.windowStyle)}`,
      }
    }
    windowStyle = raw.windowStyle
  }
  let backgroundTone = def.backgroundTone
  if (raw.backgroundTone !== undefined) {
    if (raw.backgroundTone !== 'on' && raw.backgroundTone !== 'off') {
      return {
        ok: false,
        error: `backgroundTone は "on" か "off": ${JSON.stringify(raw.backgroundTone)}`,
      }
    }
    backgroundTone = raw.backgroundTone
  }
  let backgroundDof = def.backgroundDof
  if (raw.backgroundDof !== undefined) {
    if (raw.backgroundDof !== 'on' && raw.backgroundDof !== 'off') {
      return {
        ok: false,
        error: `backgroundDof は "on" か "off": ${JSON.stringify(raw.backgroundDof)}`,
      }
    }
    backgroundDof = raw.backgroundDof
  }
  let pixelArt = def.pixelArt
  if (raw.pixelArt !== undefined) {
    if (raw.pixelArt !== 'on' && raw.pixelArt !== 'off') {
      return { ok: false, error: `pixelArt は "on" か "off": ${JSON.stringify(raw.pixelArt)}` }
    }
    pixelArt = raw.pixelArt
  }
  let logTypewriter = def.logTypewriter
  if (raw.logTypewriter !== undefined) {
    if (raw.logTypewriter !== 'on' && raw.logTypewriter !== 'off') {
      return {
        ok: false,
        error: `logTypewriter は "on" か "off": ${JSON.stringify(raw.logTypewriter)}`,
      }
    }
    logTypewriter = raw.logTypewriter
  }
  let presentation = def.presentation
  if (raw.presentation !== undefined) {
    if (raw.presentation !== 'dq' && raw.presentation !== 'ff') {
      return {
        ok: false,
        error: `presentation は "dq" か "ff": ${JSON.stringify(raw.presentation)}`,
      }
    }
    presentation = raw.presentation
  }
  let atb = def.atb
  if (raw.atb !== undefined) {
    if (raw.atb !== 'on' && raw.atb !== 'off') {
      return { ok: false, error: `atb は "on" か "off": ${JSON.stringify(raw.atb)}` }
    }
    atb = raw.atb
  }
  let atbMode = def.atbMode
  if (raw.atbMode !== undefined) {
    if (raw.atbMode !== 'wait' && raw.atbMode !== 'active') {
      return {
        ok: false,
        error: `atbMode は "wait" か "active": ${JSON.stringify(raw.atbMode)}`,
      }
    }
    atbMode = raw.atbMode
  }
  let commandLayout = def.commandLayout
  if (raw.commandLayout !== undefined) {
    if (raw.commandLayout !== 'grid' && raw.commandLayout !== 'cross') {
      return {
        ok: false,
        error: `commandLayout は "grid" か "cross": ${JSON.stringify(raw.commandLayout)}`,
      }
    }
    commandLayout = raw.commandLayout
  }
  const commandLabels = parseCommandLabelsConfig(raw.commandLabels)
  if (!commandLabels.ok) return commandLabels
  const spells = parseMenuList<BattleSpellEntry>(raw.spells, def.spells, 'spells')
  if (!spells.ok) return spells
  const items = parseMenuList<BattleItemEntry>(raw.items, def.items, 'items')
  if (!items.ok) return items
  const skills = parseSkills(raw.skills)
  if (!skills.ok) return skills
  const statuses = parseStatuses(raw.statuses)
  if (!statuses.ok) return statuses
  const magicites = parseMagicites(raw.magicites)
  if (!magicites.ok) return magicites
  const beasts = parseBeasts(raw.beasts, (u) => resolveUrl(u, baseUrl))
  if (!beasts.ok) return beasts
  // 召喚獣 (#750): 魔石・特技の `summonId` を `beasts` へ引き当てる。参照が無ければ入力のまま（従来と同一）
  const refs = resolveSampleSummons(skills.value, magicites.value, beasts.value)
  const gear = parseGear(raw.gear)
  if (!gear.ok) return gear
  const jobs = parseJobs(raw.jobs)
  if (!jobs.ok) return jobs
  let commands: CommandId[] | undefined
  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands) || raw.commands.some((c) => typeof c !== 'string')) {
      return { ok: false, error: 'commands は文字列の配列である必要があります' }
    }
    commands = parseCommandIds((raw.commands as string[]).join(','))
    if (!commands || commands.length !== raw.commands.length) {
      return {
        ok: false,
        error: `commands は attack / skill / summon / spell / item / escape を重複なく並べてください: ${JSON.stringify(raw.commands)}`,
      }
    }
  }
  const itemNames: Record<string, string> = {}
  if (raw.itemNames !== undefined) {
    if (!isRecord(raw.itemNames)) {
      return {
        ok: false,
        error: 'itemNames は { アイテムid: 名前 } のオブジェクトである必要があります',
      }
    }
    for (const [id, name] of Object.entries(raw.itemNames)) {
      if (typeof name !== 'string') {
        return { ok: false, error: `itemNames.${id} は文字列である必要があります` }
      }
      itemNames[id] = name
    }
  }
  let background: string | null = null
  if (raw.background !== undefined && raw.background !== null && raw.background !== '') {
    if (typeof raw.background !== 'string') {
      return { ok: false, error: 'background は URL 文字列である必要があります' }
    }
    const bg = raw.background.trim()
    if (bg) {
      background = resolveUrl(bg, baseUrl)
      if (!background)
        return { ok: false, error: `background の URL を解決できません: ${raw.background}` }
    }
  }
  const unit = (key: 'horizon' | 'perspective', fallback: number): ParseResult<number> => {
    const v = raw[key]
    if (v === undefined) return { ok: true, value: fallback }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, error: `${key} は 0〜1 の数値: ${JSON.stringify(v)}` }
    }
    return { ok: true, value: v }
  }
  const horizon = unit('horizon', def.horizon)
  if (!horizon.ok) return horizon
  const perspective = unit('perspective', def.perspective)
  if (!perspective.ok) return perspective
  let foreground: string | null = null
  if (raw.foreground !== undefined && raw.foreground !== null && raw.foreground !== '') {
    if (typeof raw.foreground !== 'string') {
      return { ok: false, error: 'foreground は URL 文字列である必要があります' }
    }
    const fg = raw.foreground.trim()
    if (fg) {
      foreground = resolveUrl(fg, baseUrl)
      if (!foreground)
        return { ok: false, error: `foreground の URL を解決できません: ${raw.foreground}` }
    }
  }
  const script = parseScript(raw.script, baseUrl)
  if (!script.ok) return script
  const party = parseEntities(raw.party, def.party, MAX_PARTY, baseUrl, 'party')
  if (!party.ok) return party
  const enemies = parseEntities(raw.enemies, def.enemies, MAX_ENEMIES, baseUrl, 'enemies')
  if (!enemies.ok) return enemies
  // 魔石 (#889)・装備 (#207): 装備する味方の能力値・耐性・通常攻撃の属性を反映し、「しょうかん」「わざ」の行を作る
  const equipped = applyPartyEquipment(raw.party, party.value, {
    magicites: refs.magicites,
    gear: gear.value,
    skills: refs.skills,
    jobs: jobs.value,
  })
  if (!equipped.ok) return equipped
  return {
    ok: true,
    value: {
      layout,
      spriteStyle,
      windowStyle,
      backgroundTone,
      backgroundDof,
      pixelArt,
      logTypewriter,
      presentation,
      atb,
      atbMode,
      commandLayout,
      commandLabels: commandLabels.value,
      spells: spells.value,
      items: items.value,
      background,
      horizon: horizon.value,
      perspective: perspective.value,
      foreground,
      skills: refs.skills,
      statuses: statuses.value,
      commands,
      magicites: refs.magicites,
      summons: equipped.value.summons,
      gear: gear.value,
      jobs: jobs.value,
      abilities: equipped.value.skills,
      itemNames,
      script: script.value,
      party: party.value,
      enemies: enemies.value,
    },
  }
}

/** JSON 文字列から設定を作る。JSON 構文エラーも ParseResult で返す */
export function parseConfigText(text: string, baseUrl: string): ParseResult<BattleSampleConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      error: `JSON として読めません: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  return parseConfig(raw, baseUrl)
}

/** 設定から、ツールバーの初期表示状態を作る */
export function initialView(config: BattleSampleConfig): BattleSampleView {
  return {
    layout: config.layout,
    spriteStyle: config.spriteStyle,
    windowStyle: config.windowStyle,
    backgroundTone: config.backgroundTone,
    backgroundDof: config.backgroundDof,
    pixelArt: config.pixelArt,
    logTypewriter: config.logTypewriter,
    presentation: config.presentation,
    atb: config.atb,
    atbMode: config.atbMode,
    commandLayout: config.commandLayout,
    backgroundOn: config.background !== null,
    depth: 'off',
    foregroundOn: config.foreground !== null,
    formation: 'config',
    partyCount: config.party.length,
    enemyCount: config.enemies.length,
    sizeId: DEFAULT_SIZE_ID,
    resolutionMode: DEFAULT_RESOLUTION_MODE,
  }
}

/** 解像度モードから renderer.resolution の値を決める（dpr は呼び出し側が毎回読んだ window.devicePixelRatio） */
export function resolveResolution(mode: ResolutionMode, devicePixelRatio: number): number {
  if (mode === 'main') return 1
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
}

/**
 * 実際にエンジンへ渡す味方人数。front は本編（RaycastRenderer.startBattle）と同じく
 * hero 1 人だけを渡すので、ツールバーの味方人数に関わらず 1。side は選択どおり（1〜MAX_PARTY）。
 */
export function effectivePartyCount(view: BattleSampleView): number {
  if (view.layout === 'front') return 1
  return Math.max(1, Math.min(view.partyCount, MAX_PARTY))
}

export function resolveSize(id: ScreenSizeId): { width: number; height: number } {
  const s = SCREEN_SIZES.find((x) => x.id === id) ?? SCREEN_SIZES[1]
  return { width: s.width, height: s.height }
}

/**
 * 隊列の見せ方を味方へ適用する (#747)。config = 設定どおり、front = 全員前衛、
 * backHalf = 先頭から人数の半分（切り上げ）が前衛、残りが後衛（1 人=後衛 0 / 2 人=1 / 3 人=1 / 4 人=2）。入力は変更せず複製を返す
 */
export function applyFormation(party: BattleEntity[], mode: FormationMode): BattleEntity[] {
  const backFrom = Math.ceil(party.length / 2)
  return party.map((p, i) => {
    if (mode === 'config') return { ...p }
    const { row: _row, ...rest } = p
    void _row
    if (mode === 'backHalf' && i >= backFrom) return { ...rest, row: 'back' as const }
    return rest
  })
}

/** 表示状態 + 設定から、BattleScreen に渡す素材一式を作る（人数は先頭から切り出す。足りなければ既定で補う） */
export function buildBattleSetup(
  config: BattleSampleConfig,
  view: BattleSampleView
): {
  party: BattleEntity[]
  enemies: BattleEntity[]
  options: {
    layout: BattleLayoutMode
    spriteStyle: SpriteStyle
    windowStyle: WindowStyle
    backgroundTone: BackgroundTone
    backgroundDof: BackgroundDof
    pixelArt: boolean
    logTypewriter: BattleLogTypewriterMode
    presentation: BattlePresentation
    commandLayout: CommandLayout
    commandLabels: CommandLabels
    /** コマンドの構成と順序 (#889)。未指定は既定の 4 つ */
    commands?: CommandId[]
    /** 候補窓の呪文・アイテム (#204)・召喚 (#889)。side の BattleScreen が grid でも cross でも使う */
    menu: BattleMenuData
    background?: string
    depth: BattleDepth | null
    foreground?: string
  }
  /** BattleEngine に渡す ATB 設定 (#205)。undefined = 従来ターン制 */
  atb?: BattleAtbConfig
  /** BattleEngine に渡す敵の特技 (#835) */
  skills: Record<string, SkillExecution>
  /** BattleEngine に渡す状態の宣言 (#870) */
  statuses: Record<string, StatusDef>
  /** BattleEngine に渡す戦利品の表示名 (#831) */
  itemNames: Record<string, string>
  /** BattleEngine に渡す脚本 (#741)。無ければ undefined（従来の戦闘）。味方の人数の切り替えとは独立（参戦者は設定どおり） */
  script?: BattleScriptOptions
  width: number
  height: number
} {
  const fill = (src: BattleEntity[], fallback: BattleEntity[], n: number, prefix: string) => {
    const count = Math.max(1, n)
    const out: BattleEntity[] = []
    for (let i = 0; i < count; i++) {
      const e = src[i] ?? { ...fallback[i % fallback.length], id: `${prefix}-extra${i + 1}` }
      // BattleEngine は状態を書き換えるので複製を渡す
      out.push({ ...e })
    }
    return out
  }
  const { width, height } = resolveSize(view.sizeId)
  const party = fill(config.party, defaultParty(), effectivePartyCount(view), 'party')
  return {
    ...(view.atb === 'on' ? { atb: { mode: view.atbMode } } : {}),
    skills: config.skills,
    statuses: config.statuses,
    itemNames: config.itemNames,
    // 脚本は戦闘ごとに複製を渡す（エンジンも複製するが、設定を共有しない）
    ...(config.script
      ? { script: JSON.parse(JSON.stringify(config.script)) as BattleScriptOptions }
      : {}),
    // front 配置は本編と同じく隊列を使わない（RaycastRenderer.partyDefToBattleEntity と同じ）
    party: applyFormation(party, view.layout === 'front' ? 'front' : view.formation),
    enemies: fill(
      config.enemies,
      defaultEnemies(),
      Math.min(view.enemyCount, MAX_ENEMIES),
      'enemy'
    ),
    options: {
      layout: view.layout,
      spriteStyle: view.spriteStyle,
      windowStyle: view.windowStyle,
      backgroundTone: view.backgroundTone,
      backgroundDof: view.backgroundDof,
      pixelArt: view.pixelArt === 'on',
      logTypewriter: view.logTypewriter,
      presentation: view.presentation,
      commandLayout: view.commandLayout,
      commandLabels: config.commandLabels,
      ...(config.commands ? { commands: [...config.commands] } : {}),
      menu: {
        // 呪文は味方全員が同じものを使える（複製して渡す。BattleScreen は読むだけだが、設定を共有しない）
        spells: Object.fromEntries(
          [...party, ...Object.values(config.script?.joiners ?? {})].map((p) => [
            p.id,
            config.spells.map((e) => ({ ...e })),
          ])
        ),
        items: config.items.map((e) => ({ ...e })),
        // わざ (#207): 固定のわざ（`party[].abilities`）と装備中の `gear` の `abilities` を持つ味方だけ。画面に出る味方の分だけ複製する
        ...(party.some((p) => config.abilities[p.id])
          ? {
              skills: Object.fromEntries(
                party
                  .filter((p) => config.abilities[p.id])
                  .map((p) => [p.id, config.abilities[p.id].map((e) => ({ ...e }))])
              ),
            }
          : {}),
        // 召喚 (#889): 魔石を装備した味方だけ。画面に出る（渡す）味方の分だけ複製する
        ...(party.some((p) => config.summons[p.id])
          ? {
              summons: Object.fromEntries(
                party
                  .filter((p) => config.summons[p.id])
                  .map((p) => [p.id, config.summons[p.id].map((e) => ({ ...e }))])
              ),
            }
          : {}),
      },
      ...(view.backgroundOn && config.background ? { background: config.background } : {}),
      depth:
        view.depth === 'on' ? { horizon: config.horizon, perspective: config.perspective } : null,
      ...(view.foregroundOn && config.foreground ? { foreground: config.foreground } : {}),
    },
    width,
    height,
  }
}

/**
 * pixelArt (#760) が前回の描画から変わったときだけ、解放すべき画像の URL（背景・前景・味方・敵のスプライト）を返す。
 * `Assets` のキャッシュは mipmap の有無・scaleMode ごと使い回されるので、nearest↔linear を切り替えたら
 * unload してから読み直す必要がある（v8 は mipLevelCount をアップロード時に決める）。他のトグルでは何も返さない。
 * `previous` が null（初回）なら空。重複は除く。
 */
export function assetsToUnload(
  previous: 'on' | 'off' | null,
  view: BattleSampleView,
  config: BattleSampleConfig
): string[] {
  if (previous === null || previous === view.pixelArt) return []
  const urls = [
    config.background,
    config.foreground,
    ...config.party.flatMap((e) => [e.sprite, ...Object.values(e.poses ?? {})]),
    ...config.enemies.flatMap((e) => [e.sprite, ...Object.values(e.poses ?? {})]),
  ]
  return [...new Set(urls.filter((u): u is string => typeof u === 'string' && u !== ''))]
}

export function viewsEqual(a: BattleSampleView, b: BattleSampleView): boolean {
  return (
    a.layout === b.layout &&
    a.spriteStyle === b.spriteStyle &&
    a.windowStyle === b.windowStyle &&
    a.backgroundTone === b.backgroundTone &&
    a.backgroundDof === b.backgroundDof &&
    a.pixelArt === b.pixelArt &&
    a.logTypewriter === b.logTypewriter &&
    a.presentation === b.presentation &&
    a.atb === b.atb &&
    a.atbMode === b.atbMode &&
    a.commandLayout === b.commandLayout &&
    a.backgroundOn === b.backgroundOn &&
    a.depth === b.depth &&
    a.foregroundOn === b.foregroundOn &&
    a.formation === b.formation &&
    effectivePartyCount(a) === effectivePartyCount(b) &&
    a.enemyCount === b.enemyCount &&
    a.sizeId === b.sizeId &&
    a.resolutionMode === b.resolutionMode
  )
}

/** ブリンク比較の履歴。現在とひとつ前を保持する */
export interface BlinkHistory {
  current: BattleSampleView
  previous: BattleSampleView | null
}

/** 設定を変更したとき: 現在をひとつ前に送る（同一内容なら履歴は変えない） */
export function pushView(h: BlinkHistory, next: BattleSampleView): BlinkHistory {
  if (viewsEqual(h.current, next)) return h
  return { current: next, previous: h.current }
}

/** スペース等: 現在とひとつ前を入れ替える（ひとつ前がなければ何もしない） */
export function swapView(h: BlinkHistory): BlinkHistory {
  return h.previous ? { current: h.previous, previous: h.current } : h
}

/** 画面表示用の 1 行サマリ */
export function describeView(
  view: BattleSampleView,
  dpr: number,
  size: { width: number; height: number },
  /** 実際に適用中の app.renderer.resolution。渡すと DPR と別項目で併記し、physical はこちらで計算する */
  rendererResolution?: number
): string {
  const physRes = rendererResolution ?? dpr
  return [
    `layout=${view.layout}`,
    `spriteStyle=${view.spriteStyle}`,
    `windowStyle=${view.windowStyle}`,
    `backgroundTone=${view.backgroundTone}`,
    `backgroundDof=${view.backgroundDof}`,
    `pixelArt=${view.pixelArt}`,
    `logTypewriter=${view.logTypewriter}`,
    // ff は side のときだけ効く（front では無視される）ので、効く場合だけ出す
    ...(view.presentation === 'ff' && view.layout === 'side' ? ['presentation=ff'] : []),
    // cross は side のときだけ効く（front では無視される）ので、効く場合だけ出す
    ...(view.commandLayout === 'cross' && view.layout === 'side' ? ['commandLayout=cross'] : []),
    ...(view.atb === 'on' ? ['atb=on', `atbMode=${view.atbMode}`] : []),
    `background=${view.backgroundOn ? 'on' : 'off'}`,
    `depth=${view.depth}`,
    `foreground=${view.foregroundOn ? 'on' : 'off'}`,
    `formation=${view.formation}`,
    `party=${effectivePartyCount(view)}`,
    `enemies=${view.enemyCount}`,
    `size=${view.sizeId}`,
    `logical=${size.width}x${size.height}`,
    `DPR=${dpr}`,
    ...(rendererResolution === undefined
      ? []
      : [`resolution=${view.resolutionMode}(renderer.resolution=${rendererResolution})`]),
    `physical=${Math.round(size.width * physRes)}x${Math.round(size.height * physRes)}`,
  ].join('  ')
}
