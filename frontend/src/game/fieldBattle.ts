/**
 * フィールド（RaycastRenderer / TopDownRenderer）から戦闘画面（BattleScreen）を開閉する共通部分 (#784)。
 *
 * - `readFieldBattleSettings`: frontmatter 由来の戦闘設定を RPGProject から読む（既定値の正本）
 * - `buildPartyBattleEntities` ほか: パーティマスター → 戦闘の味方 BattleEntity（純粋関数）
 * - `FieldInputGate`: 戦闘をまたぐキー入力の扱い（押下中の矢印キー追跡・離すまで無視・設定中の停止）
 * - `openFieldBattle`: BattleEngine + BattleScreen を組み立ててステージへ載せ、終了時に畳む
 *
 * どのレンダラーも同じ設定・同じキー規約で戦闘に入る。エンカウント抽選・クールダウン・移動入力は各レンダラーの責務。
 */

import type { Container } from 'pixi.js'
import type {
  BattleScriptDef,
  ItemDef,
  MonsterDef,
  PartyMemberDef,
  SkillDef,
  SpellDef,
  StatusDef,
} from '../types'
import type { RPGProject } from '../types/rpg'
import { BattleScreen } from './BattleScreen'
import { itemNamesOf, type BattleOutcome, type BattleResult } from './loot'
import { BattleEngine, type BattleScriptOptions } from './battleEngine'
import { buildEnemyEntities } from './encounter'
import { parseEncounterGroup, resolveEncounterGroup } from './enemyGroup'
import { toSkillExecutions } from './enemyAi'
import { parseBattleScript } from './battleScript'
import { hasOwn } from './ownProperty'
import type { EventBattleHost } from './eventRunner'
import { resolveBattleNextCommands, type FieldScriptEvents } from './fieldScript'
import type { BattleEntity } from './spellDsl'
import type { BattleDepth, BattleLayoutMode } from './battleLayout'
import { normalizeBattleRow } from './battleLayout'
import { DIALOG_JUST_SHOWN_GUARD_MS, suppressNextTouchTap } from './touchInput'
import type { SpriteStyle } from './spriteStyle'
import type { WindowStyle } from './windowStyle'
import type { BackgroundTone } from './backgroundTone'
import type { BackgroundDof } from './depthOfField'
import type { BattleLogTypewriterMode } from './battleLogTypewriter'
import { posesField, type BattleMotionPreset, type BattlePresentation } from './battleMotion'
import type { BattleEnemyListMode } from './battleEnemyList'
import type { BattleAtbConfig } from './battleAtb'
import type { EnemyGridSize } from './enemyGrid'
import type { CommandId, CommandLabels, CommandLayout } from './battleCommands'
import type {
  BattleMenuData,
  BattleSkillEntry,
  BattleSpellEntry,
  BattleSummonEntry,
} from './battleMenu'
import { applyMemberMagicite, summonEntries } from './magicite'
import { resolveMemberEquipment, type EquipmentRoster } from './equipment'
import { resolveMemberJob } from './job'
import { convertForJob } from './jobConversion'
import {
  battleTransitionParams,
  isBattleTransitionEnabled,
  type BattleTransitionMode,
} from './battleTransition'
import type { FieldBattleTransition } from './fieldBattleTransition'
import type { BattleEffects } from './battleEffects'

/** 戦闘画面の設定（frontmatter 由来）。未指定の既定値は `readFieldBattleSettings` が正本 */
export interface FieldBattleSettings {
  /** `battle_layout` (#736) */
  layout: BattleLayoutMode
  /** `battle_background` (#736) */
  background: string | undefined
  /** `sprite_style` (#737) */
  spriteStyle: SpriteStyle
  /** `window_style` (#744) */
  windowStyle: WindowStyle
  /** `battle_background_tone` (#753) */
  backgroundTone: BackgroundTone
  /** `battle_background_dof` (#753) */
  backgroundDof: BackgroundDof
  /** `battle_log_typewriter` (#755) */
  logTypewriter: BattleLogTypewriterMode
  /** `battle_presentation` (#745)。`dq`（既定）/ `ff` */
  presentation: BattlePresentation
  /** `battle_motion` (#956)。`default`（現行）/ `snappy`。`presentation: ff` のときだけ効く */
  motion: BattleMotionPreset
  /** `battle_enemy_list` (#954)。`off`（既定）/ `window`。ff かつ side のときだけ効く */
  enemyList: BattleEnemyListMode
  /** `battle_horizon` / `battle_perspective` (#747) */
  depth: BattleDepth | null
  /** `battle_foreground` (#747) */
  foreground: string | undefined
  /** ドット絵モード (#466)。戦闘のテクスチャを nearest のままにする (#760) */
  pixelArt: boolean
  /** `battle_atb` / `battle_atb_mode` (#205)。undefined = 従来ターン制 */
  atb: BattleAtbConfig | undefined
  /** `battle_enemy_grid` (#839)。undefined = 無効（従来の敵配置）。`BattleScreen` 経由で描画に効く（#839 段4で配線済み） */
  enemyGrid: EnemyGridSize | undefined
  /** `battle_enemy_window_overlap` (#839)。undefined = 既定（0.25） */
  enemyWindowOverlap: number | undefined
  /** `battle_command_layout` (#204) */
  commandLayout: CommandLayout
  /** `battle_command_labels` (#204) */
  commandLabels: CommandLabels | undefined
  /** `battle_commands` (#873)。undefined = 既定の attack / spell / item / escape */
  commands: CommandId[] | undefined
  /** `battle_transition` (#830)。`none`（既定・現行の挙動）/ `ff`（開始=2段ズームして暗転、終了=黒を経由して戻る）/ `ff-mosaic`（`ff` + 暗さ連動のモザイク #953） */
  transition: BattleTransitionMode
}

/** 未指定時の戦闘設定（既定値の正本） */
export const DEFAULT_FIELD_BATTLE_SETTINGS: Readonly<FieldBattleSettings> = {
  layout: 'front',
  background: undefined,
  spriteStyle: 'none',
  windowStyle: 'dark',
  backgroundTone: 'on',
  backgroundDof: 'off',
  logTypewriter: 'off',
  presentation: 'dq',
  motion: 'default',
  enemyList: 'off',
  depth: null,
  foreground: undefined,
  pixelArt: false,
  atb: undefined,
  enemyGrid: undefined,
  enemyWindowOverlap: undefined,
  commandLayout: 'grid',
  commandLabels: undefined,
  commands: undefined,
  transition: 'none',
}

/** RPGProject から戦闘設定を読む。未指定は既定値に倒す */
export function readFieldBattleSettings(gameData: RPGProject): FieldBattleSettings {
  const d = DEFAULT_FIELD_BATTLE_SETTINGS
  return {
    layout: gameData.battleLayout ?? d.layout,
    background: gameData.battleBackground,
    spriteStyle: gameData.spriteStyle ?? d.spriteStyle,
    windowStyle: gameData.windowStyle ?? d.windowStyle,
    backgroundTone: gameData.battleBackgroundTone ?? d.backgroundTone,
    backgroundDof: gameData.battleBackgroundDof ?? d.backgroundDof,
    logTypewriter: gameData.battleLogTypewriter ?? d.logTypewriter,
    presentation: gameData.battlePresentation ?? d.presentation,
    motion: gameData.battleMotion ?? d.motion,
    enemyList: gameData.battleEnemyList ?? d.enemyList,
    depth: gameData.battleDepth ?? d.depth,
    foreground: gameData.battleForeground,
    pixelArt: gameData.pixelArt === true,
    atb: gameData.battleAtb,
    enemyGrid: gameData.battleEnemyGrid,
    enemyWindowOverlap: gameData.battleEnemyWindowOverlap,
    commandLayout: gameData.battleCommandLayout ?? d.commandLayout,
    commandLabels: gameData.battleCommandLabels,
    commands: gameData.battleCommands,
    transition: gameData.battleTransition ?? d.transition,
  }
}

/**
 * 戦闘のパーティマスター（`party` と、その定義順 `order`）。
 * 魔石 (#889) と装備 (#207) の入力（`magicites` / `equipment` / `growth` / `extraElements`、`EquipmentRoster`。アイテムのマスターは `items`）は、
 * 魔石も装備品も宣言しないゲームでは全部省略する。`equipment` は魔石とアイテムの id を混在で受ける
 */
export interface FieldBattleRoster extends EquipmentRoster {
  party: Record<string, PartyMemberDef>
  /** 定義順。整数風 ID でも出現順を保つため別持ち */
  order: string[]
  /** 呪文のマスター (#204)。あれば `learns`（レベル以下で覚えるもの）から候補窓の呪文を作る */
  spells?: Record<string, SpellDef>
  /** 特技のマスター (#835)。敵の `行動:` の候補の id から引く。無ければ特技の候補は通常攻撃になる */
  skills?: Record<string, SkillDef>
  /** 状態のマスター (#870)。`[状態]` の宣言。あれば戦闘エンジンの `statuses` に渡す（継続ダメージ・行動不能・回復の反転などが働く） */
  statuses?: Record<string, StatusDef>
  /** ラーニング (#882): パーティ共通の習得済みの呪文 id（ホストが保存した分。前の戦闘の `BattleResult.learnedSpells`）。全員の呪文の候補の最後に出る（既存の `learns` の呪文と同じ候補窓）。保存は #738 の領分 */
  learnedSpells?: string[]
  /** アイテムのマスター (#831)。戦利品のログ（「〇〇 を てにいれた！」）の表示名と、装備品 (#207) の宣言（`種別` が 武器 / 防具 / 盾 / 兜 のもの）に使う。所持品の保存は持たない */
  items?: Record<string, ItemDef>
}

/**
 * 戦闘の味方ごとの呪文の一覧（候補窓用 #204）。`PartyMemberDef.learns` のうち、そのメンバーのレベル（既定 1）以下で
 * 覚えるもので、呪文マスターに定義があるものを定義順に並べる。1 つもなければ undefined（候補窓は開かない）。
 * アイテムは所持品の仕組みが無いので渡さない（どうぐは従来どおり何も起きない）。
 * 「わざ」(#873) は `PartyMemberDef.abilities`（`わざ:` の特技 id）に、装備中のアイテムの `わざ` (#207) を重複なく後ろへ足した列のうち、
 * 特技マスター（`roster.skills`）にあるものを並べて作る。
 */
/** 呪文のマスターから候補の 1 行を作る（ジョブの変換 #876 を含む） */
function spellEntry(
  sp: SpellDef,
  job: ReturnType<typeof resolveMemberJob>['job']
): BattleSpellEntry {
  const conv = convertForJob(job, sp.tags, sp.effect, `呪文 '${sp.id}'`)
  return {
    id: sp.id,
    name: sp.name,
    mp: sp.mp,
    target: sp.target,
    ...(sp.multiTarget === true ? { multiTarget: true } : {}),
    ...(conv ? { effect: conv.effect, convertedBy: conv.convertedBy } : {}),
    ...(!conv && sp.effect !== undefined ? { effect: sp.effect } : {}),
    ...(sp.builtin !== undefined ? { builtin: sp.builtin } : {}),
  }
}

export function buildBattleMenuData(
  roster: FieldBattleRoster,
  party: readonly BattleEntity[]
): BattleMenuData | undefined {
  const master = roster.spells ?? {}
  const spells: Record<string, BattleSpellEntry[]> = {}
  const skills: Record<string, BattleSkillEntry[]> = {}
  const summons: Record<string, BattleSummonEntry[]> = {}
  /** 味方の現在のジョブ (#876)。ジョブを持たない・解決できない味方は undefined（従来と同一） */
  const jobOf = (d: PartyMemberDef) =>
    roster.jobs || roster.currentJobs ? resolveMemberJob(d, roster).job : undefined
  for (const member of party) {
    const def = roster.party[member.id]
    // 装備 (#207 / #889): 装備中の魔石とアイテム。何も宣言していないゲームでは空
    const equipped =
      def && (roster.magicites || roster.items || roster.equipment)
        ? resolveMemberEquipment(def, roster)
        : undefined
    // 「しょうかん」(#889): 装備中の魔石の召喚獣を枠の順に並べる（呼び済みのグレー表示は画面が entity の `summoned` で決める）
    if (equipped && roster.magicites && equipped.stones.length > 0) {
      summons[member.id] = summonEntries(equipped.stones)
    }
    // 「わざ」(#873): `わざ:` の特技 id と、装備中のアイテムの `わざ` (#207) のうち、特技マスターに定義があるものを並べる（MP なし）
    const abilityIds = [...(def?.abilities ?? []), ...(equipped?.abilities ?? [])]
    if (abilityIds.length > 0 && roster.skills) {
      const sm = roster.skills
      const sl: BattleSkillEntry[] = []
      for (const id of abilityIds) {
        const sk = Object.prototype.hasOwnProperty.call(sm, id) ? sm[id] : undefined
        if (!sk || sl.some((e) => e.id === sk.id)) continue
        // ジョブの変換 (#876): 就いているジョブの変換ルールがこのタグの効果に効くときだけ、効果を変換して印を付ける
        const conv = def
          ? convertForJob(jobOf(def), sk.tags, sk.effect, `特技 '${sk.id}'`)
          : undefined
        sl.push({
          id: sk.id,
          name: sk.name,
          target: sk.target,
          ...(conv ? { effect: conv.effect, convertedBy: conv.convertedBy } : {}),
          ...(!conv && sk.effect !== undefined ? { effect: sk.effect } : {}),
          ...(sk.builtin !== undefined ? { builtin: sk.builtin } : {}),
          ...(sk.message !== undefined ? { message: sk.message } : {}),
          ...(sk.telegraph !== undefined ? { telegraph: sk.telegraph } : {}),
          ...(sk.cue !== undefined ? { cue: sk.cue } : {}),
        })
      }
      if (sl.length > 0) skills[member.id] = sl
    }
    // 習得済み（`roster.learnedSpells`、#882）があるときは、`learns` の無い味方にも全員共通の習得済みを出す
    if (!def || (!def.learns && !roster.learnedSpells)) continue
    // 保存した Lv (#206。レベルアップで上がった今の Lv) を優先し、無ければ定義の初期 Lv
    const level = member.level ?? def.level ?? 1
    const list: BattleSpellEntry[] = []
    for (const l of def.learns ?? []) {
      const sp = Object.prototype.hasOwnProperty.call(master, l.spell) ? master[l.spell] : undefined
      if (!sp || l.level > level || list.some((e) => e.id === sp.id)) continue
      list.push(spellEntry(sp, jobOf(def)))
    }
    // ラーニング (#882): パーティ共通の習得済み（`roster.learnedSpells`）は、全員の候補の最後に足す（装備枠なし・レベル不問）
    for (const id of roster.learnedSpells ?? []) {
      const sp = Object.prototype.hasOwnProperty.call(master, id) ? master[id] : undefined
      if (sp && !list.some((e) => e.id === sp.id)) list.push(spellEntry(sp, jobOf(def)))
    }
    if (list.length > 0) spells[member.id] = list
  }
  const hasSpells = Object.keys(spells).length > 0
  const hasSkills = Object.keys(skills).length > 0
  const hasSummons = Object.keys(summons).length > 0
  if (!hasSpells && !hasSkills && !hasSummons) return undefined
  return {
    ...(hasSpells ? { spells } : {}),
    ...(hasSkills ? { skills } : {}),
    ...(hasSummons ? { summons } : {}),
  }
}

/** 呪文マスターから表示名（id → 名前）を作る（戦闘後リザルトの「〇〇を おぼえた！」用 #1039） */
function spellNamesOf(spells: Record<string, SpellDef>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, def] of Object.entries(spells)) if (def?.name) out[id] = def.name
  return out
}

/** PartyMemberDef → BattleEntity。隊列 (#747) は side のときだけ反映する（front は隊列を描かない） */
export function partyDefToBattleEntity(
  def: PartyMemberDef,
  layout: BattleLayoutMode,
  /** 魔石 (#889) と装備 (#207) の入力。省略・何も装備しない味方は従来と同一の `BattleEntity`（キーも増えない） */
  magicite?: EquipmentRoster
): BattleEntity {
  const entity: BattleEntity = {
    id: def.id,
    name: def.name,
    hp: def.hp,
    maxHp: def.hp,
    mp: def.mp ?? 0,
    maxMp: def.mp ?? 0,
    atk: def.atk,
    def: def.def,
    agi: def.agi,
    sprite: def.sprite,
    ...posesField(def.poses),
    ...(layout === 'side' && normalizeBattleRow(def.row) === 'back'
      ? { row: 'back' as const }
      : {}),
  }
  if (magicite) applyMemberMagicite(entity, resolveMemberEquipment(def, magicite))
  return entity
}

/**
 * party['hero'] から BattleEntity を組み立てる。未定義ならハードコード値 (#175)。
 * 将来的にはセーブデータの現在値（HP/MP 残量、レベル）を反映する。
 */
export function buildHeroBattleEntity(
  roster: FieldBattleRoster,
  layout: BattleLayoutMode
): BattleEntity {
  const def = roster.party['hero']
  if (def) return partyDefToBattleEntity(def, layout, roster)
  return {
    id: 'hero',
    name: 'ゆうしゃ',
    hp: 20,
    maxHp: 20,
    mp: 4,
    maxMp: 4,
    atk: 5,
    def: 3,
    agi: 4,
  }
}

/**
 * party のキーを定義順で返す。`order`（ドキュメント上の出現順）を優先し、
 * それに無いキーは `Object.keys` 順で後ろに足す。`Object.keys` だけだと ID が整数風（"2" 等）のとき
 * 定義順より前に並べ替えられてしまう (#736)。
 */
export function orderedPartyKeys(roster: FieldBattleRoster): string[] {
  const own = new Set(Object.keys(roster.party))
  const keys = roster.order.filter((k) => own.has(k))
  const seen = new Set(keys)
  for (const k of own) if (!seen.has(k)) keys.push(k)
  return keys
}

/**
 * 戦闘に出す味方全員を組み立てる (#736)。
 * - party が空: ハードコード hero 1 人（従来どおり）
 * - hero 定義あり: hero を先頭に、残りを定義順
 * - hero 定義なし: 定義順そのまま（定義に無い「ゆうしゃ」を混ぜない）
 */
export function buildPartyBattleEntities(
  roster: FieldBattleRoster,
  layout: BattleLayoutMode
): BattleEntity[] {
  const keys = orderedPartyKeys(roster)
  if (keys.length === 0) return [buildHeroBattleEntity(roster, layout)]
  const ordered = keys.includes('hero') ? ['hero', ...keys.filter((k) => k !== 'hero')] : keys
  return ordered.map((k) => partyDefToBattleEntity(roster.party[k], layout, roster))
}

/**
 * 戦闘をまたぐフィールドのキー入力状態 (#204 / #784)。PixiJS には触れない。
 *
 * - `held`: 今押されている矢印キー。戦闘開始時に BattleScreen へ渡し、押しっぱなしの誤爆を防ぐ
 * - `releaseGate`: 戦闘終了時に押されていた矢印キー。keyup されるまでフィールド移動に使わない
 * - `suspended`: 外側の UI（設定オーバーレイ）が入力を止めているか
 * - `blur` でフォーカスを失うと keyup が届かないので押下状態を捨てる
 */
export class FieldInputGate {
  private held = new Set<string>()
  private releaseGate = new Set<string>()
  private suspended = false

  /** keydown を追跡する（戦闘中・停止中・repeat でも呼ぶ）。矢印キーだけ覚える */
  trackKeyDown(key: string): void {
    if (key.startsWith('Arrow')) this.held.add(key)
  }

  trackKeyUp(key: string): void {
    this.held.delete(key)
    this.releaseGate.delete(key)
  }

  /** ウィンドウがフォーカスを失った */
  blur(): void {
    this.held.clear()
    this.releaseGate.clear()
  }

  /** load() 時：押下中の追跡だけを捨てる（離すまで無視する gate は持ち越す） */
  resetHeld(): void {
    this.held.clear()
  }

  /** 戦闘終了時に押されていたキーを、離されるまで無視する対象にする */
  armReleaseGate(): void {
    this.releaseGate = new Set(this.held)
  }

  /** 戦闘終了時に押しっぱなしだったキーか（離されるまで移動に使わない） */
  isReleaseGated(key: string): boolean {
    return this.releaseGate.has(key)
  }

  heldKeys(): string[] {
    return [...this.held]
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended
  }

  get isSuspended(): boolean {
    return this.suspended
  }
}

/**
 * 脚本制御の戦闘 (`[戦闘 id]`、#741) の組み立て結果。`openFieldBattle` の `scripted` に渡す。
 * `enemies` は戦闘の敵、`party` は初期編成（空なら従来のパーティ）、`script` と `joiners` はエンジンの `script` オプション
 */
export interface ScriptedBattleSetup {
  enemies: BattleEntity[]
  /** 初期編成の味方の id（定義順ではなく `味方:` に書いた順）。空は従来のパーティ（`buildPartyBattleEntities` など） */
  partyIds: string[]
  script: BattleScriptOptions
}

/** `味方:` の行（カンマ区切り）から id を集める。空要素は捨てる・重複は最初だけ */
export function parsePartyIds(lines: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const line of lines ?? []) {
    for (const piece of line.split(/[,、，]/)) {
      const id = piece.trim()
      if (id !== '' && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/** `[戦闘 id]` の `敵:` から敵を組み立てる。組み立てられなければ警告して null（TopDown の `buildScriptedBattle` と一枚絵フィールドが共有する） */
export function buildScriptedEnemies(
  def: BattleScriptDef,
  masters: Record<string, MonsterDef>,
  rng: () => number
): BattleEntity[] | null {
  if (!def.enemies || def.enemies.trim() === '') {
    console.warn(`[name-name] 戦闘 '${def.id}': 敵: がありません（戦闘を始めない）`)
    return null
  }
  const group = parseEncounterGroup(def.enemies.replace(/[,、，]/g, '+'))
  for (const w of group.warnings) console.warn(`[name-name] 戦闘 '${def.id}' の敵: ${w}`)
  const enemies = buildEnemyEntities(resolveEncounterGroup(group, rng), masters)
  if (enemies.length === 0) {
    console.warn(`[name-name] 戦闘 '${def.id}': 敵を 1 体も組み立てられない（戦闘を始めない）`)
    return null
  }
  return enemies
}

/**
 * `[戦闘 id]` の宣言から、戦闘の敵・初期編成・脚本を組み立てる (#741 / #863)。純粋関数（乱数は敵グループの個数の抽選だけで、注入する）。
 * - 敵: `敵:`（敵グループと同じ書式。`+` 連結。カンマ区切りも受理）。1 体も組み立てられなければ null（戦闘を始めない）
 * - 初期編成: `味方:` の id のうち `[パーティ]` にあるもの（無い id は警告して飛ばす）。1 人もいなければ従来のパーティ
 * - 途中参戦できる味方: 初期編成にいない `[パーティ]` 全員。**side レイアウトだけ**（front は先頭 1 人しか描かないので、参戦しても操作・表示できない）
 */
export function buildScriptedBattle(
  def: BattleScriptDef,
  masters: Record<string, MonsterDef>,
  roster: FieldBattleRoster,
  layout: BattleLayoutMode,
  rng: () => number
): ScriptedBattleSetup | null {
  const enemies = buildScriptedEnemies(def, masters, rng)
  if (!enemies) return null
  const partyIds: string[] = []
  for (const id of parsePartyIds(def.party)) {
    if (Object.prototype.hasOwnProperty.call(roster.party, id)) partyIds.push(id)
    else
      console.warn(`[name-name] 戦闘 '${def.id}' の味方: '${id}' は [パーティ] に無い（無視した）`)
  }
  const joiners: Record<string, BattleEntity> = {}
  if (layout === 'side') {
    const initial = partyIds.length > 0 ? partyIds : orderedPartyKeys(roster)
    for (const id of orderedPartyKeys(roster)) {
      if (initial.includes(id)) continue
      joiners[id] = partyDefToBattleEntity(roster.party[id], layout, roster)
    }
  }
  return {
    enemies,
    partyIds,
    script: { id: def.id, rules: def.rules, joiners },
  }
}

/**
 * 脚本制御の戦闘の一時付与 (#875)。`付与:` の対象の味方に、`わざ=` の特技 id と `魔法=` の呪文 id を足した**複製の**ロスターを返す
 * （渡したロスターは書き換えない＝戦闘後に残らない）。特技・呪文のマスターにない id と、`[パーティ]` にない味方は警告して無視する。
 * 呪文はレベル 1 で覚えている扱い（`learns`）にするので、レベルに関係なく候補窓に出る。`付与:` が無ければ渡したロスターをそのまま返す
 */
export function applyScriptGrants(
  roster: FieldBattleRoster,
  rules: readonly string[],
  battleId: string
): FieldBattleRoster {
  const grants = parseBattleScript(rules).grants
  if (!grants) return roster
  const party = { ...roster.party }
  const warn = (msg: string): void => console.warn(`[name-name] 戦闘 '${battleId}' の付与: ${msg}`)
  for (const g of grants) {
    const def = hasOwn(party, g.target) ? party[g.target] : undefined
    if (!def) {
      warn(`味方 '${g.target}' は [パーティ] に無い（無視した）`)
      continue
    }
    const abilities = [...(def.abilities ?? [])]
    const learns = [...(def.learns ?? [])]
    for (const id of g.abilities) {
      if (!roster.skills || !hasOwn(roster.skills, id))
        warn(`特技 '${id}' は [特技] に無い（無視した）`)
      else if (!abilities.includes(id)) abilities.push(id)
    }
    for (const id of g.spells) {
      if (!roster.spells || !hasOwn(roster.spells, id))
        warn(`呪文 '${id}' は [呪文] に無い（無視した）`)
      else if (!learns.some((l) => l.spell === id)) learns.push({ level: 1, spell: id })
      else {
        // すでに高いレベルで覚える宣言がある呪文も、付与ではレベルに関係なく出す（複製の learns 上で 1 にする。元は書き換えない）
        for (let i = 0; i < learns.length; i++) {
          if (learns[i].spell === id && learns[i].level > 1) learns[i] = { ...learns[i], level: 1 }
        }
      }
    }
    party[g.target] = { ...def, abilities, learns }
  }
  return { ...roster, party }
}

export interface OpenFieldBattleArgs {
  stage: Container
  width: number
  height: number
  settings: FieldBattleSettings
  roster: FieldBattleRoster
  enemies: BattleEntity[]
  gate: FieldInputGate
  /** プロジェクトのアセットのベース URL (#746)。レンダラーの状態なので設定ではなく引数で受ける。未設定ならパスをそのまま読む */
  assetBaseUrl?: string
  /** `battle_transition: ff` / `ff-mosaic` (#830) のとき、終了の演出（黒を経由して戻る）を再生するレンダラーの再生機。無ければ（または `none`）即座に畳む */
  transition?: FieldBattleTransition
  /** `battle_effects` (#941) を読み込み済みのエフェクト宣言。undefined = エフェクトなし（従来どおり） */
  effects?: BattleEffects
  /** 脚本制御の戦闘 (#741)。渡すと、`enemies` の代わりにこの組み立て結果の敵・初期編成・脚本で戦う（`enemies` は無視） */
  scripted?: ScriptedBattleSetup
  /** 戦闘画面を畳んだ直後に呼ぶ（クールダウンのセットや移動キーの破棄など、レンダラー固有の後始末）。`closeFieldBattle` で強制的に畳んだときは呼ばれない */
  onClosed: (outcome: BattleOutcome, result: BattleResult) => void
}

/** 戦闘の結果（BattleScreen の onClose と同じ）。`interrupted` = 脚本が中断した (#741) */
export type { BattleOutcome }

/** 畳み済みの戦闘画面。強制終了（`closeFieldBattle`）後に古い onClose が走って二重に後始末しないための印 */
const closedScreens = new WeakSet<BattleScreen>()

/**
 * 戦闘画面をステージから外して破棄する。多重呼び出しは無害。
 * 戦闘中の `load()` / `destroy()` から使い、古い `onClosed` が新しい状態を上書きしないよう `onClosed` は呼ばない。
 */
export function closeFieldBattle(stage: Container, screen: BattleScreen): void {
  if (closedScreens.has(screen)) return
  closedScreens.add(screen)
  stage.removeChild(screen)
  screen.destroy({ children: true })
}

/**
 * 戦闘画面を開く。front のパーティは先頭 1 人だけをエンジンに渡す（全員を渡すと、画面に出ない仲間が
 * 敵の標的・敗北判定に関与して挙動が変わるため）。side は全員を渡して全員を描く (#736)。
 * 終了（勝利・逃走・全滅）で画面を畳み、その時点で押されていた矢印キーを離すまで無視する gate を張る。
 */
export function openFieldBattle(args: OpenFieldBattleArgs): BattleScreen {
  const {
    stage,
    width,
    height,
    settings,
    roster,
    enemies,
    gate,
    assetBaseUrl,
    effects,
    transition,
    scripted,
    onClosed,
  } = args
  // 初期編成: 脚本制御の戦闘が `味方:` を宣言していればその順（front は先頭 1 人だけ）。なければ従来どおり
  const scriptedParty =
    scripted && scripted.partyIds.length > 0
      ? scripted.partyIds.map((id) =>
          partyDefToBattleEntity(roster.party[id], settings.layout, roster)
        )
      : null
  const party = scriptedParty
    ? settings.layout === 'side'
      ? scriptedParty
      : [scriptedParty[0]]
    : settings.layout === 'side'
      ? buildPartyBattleEntities(roster, settings.layout)
      : [buildHeroBattleEntity(roster, settings.layout)]
  const battleEnemies = scripted ? scripted.enemies : enemies
  const engine = new BattleEngine(party, battleEnemies, {
    // ラーニング (#882): ホストが保存した習得済み。戦闘で食らって覚えた分は結果（`BattleResult.learnedSpells`）で返る
    ...(roster.learnedSpells ? { learnedSpells: roster.learnedSpells } : {}),
    ...(scripted ? { script: scripted.script } : {}),
    ...(settings.atb ? { atb: settings.atb } : {}),
    // 敵の最前列 (#896)。設定は無く、side かつ敵グリッドがあるときだけ（front は敵の列を描かない）。グリッドは BattleScreen と同じものを渡す
    ...(settings.layout === 'side' && settings.enemyGrid
      ? { enemyRow: { grid: settings.enemyGrid } }
      : {}),
    ...(roster.skills ? { skills: toSkillExecutions(roster.skills) } : {}),
    ...(roster.statuses ? { statuses: roster.statuses } : {}),
    ...(itemNamesOf(roster.items) ? { itemNames: itemNamesOf(roster.items) } : {}),
    ...(roster.spells ? { spellNames: spellNamesOf(roster.spells) } : {}),
  })
  const screen: BattleScreen = new BattleScreen(engine, width, height, {
    layout: settings.layout,
    background: settings.background,
    assetBaseUrl,
    spriteStyle: settings.spriteStyle,
    windowStyle: settings.windowStyle,
    backgroundTone: settings.backgroundTone,
    backgroundDof: settings.backgroundDof,
    logTypewriter: settings.logTypewriter,
    presentation: settings.presentation,
    motion: settings.motion,
    enemyList: settings.enemyList,
    depth: settings.depth,
    foreground: settings.foreground,
    pixelArt: settings.pixelArt,
    ...(effects ? { effects } : {}),
    ...(settings.enemyGrid ? { enemyGrid: settings.enemyGrid } : {}),
    ...(settings.enemyWindowOverlap !== undefined
      ? { enemyWindowOverlap: settings.enemyWindowOverlap }
      : {}),
    commandLayout: settings.commandLayout,
    commandLabels: settings.commandLabels,
    commands: settings.commands,
    // 途中参戦する味方（#741）の呪文・わざも、参戦したときに選べるよう最初から用意する
    // 脚本の `付与:` (#875) は、その戦闘の候補窓にだけ足す（ロスター自体は書き換えない）
    menu: buildBattleMenuData(
      scripted ? applyScriptGrants(roster, scripted.script.rules, scripted.script.id) : roster,
      [...party, ...Object.values(scripted?.script.joiners ?? {})]
    ),
    initialHeldKeys: gate.heldKeys(),
    isInputSuspended: () => gate.isSuspended,
    onClose: (outcome, result) => {
      if (closedScreens.has(screen)) return
      const finishClose = (): void => {
        // 戦闘を終わらせたタップ（にげる・止めのたたかう）は PixiJS の pointertap が先に処理して画面を畳むため、
        // 続けて canvas の onUp が handleTap に届き、フィールドのメニューが開いてしまう。直後の tap を抑止する。
        // ff では演出を見せ切ってから閉じるため、この抑止は閉じた直後 400ms の保険として働く (#745)
        suppressNextTouchTap(DIALOG_JUST_SHOWN_GUARD_MS)
        gate.armReleaseGate()
        closeFieldBattle(stage, screen)
        onClosed(outcome, result)
      }
      if (isBattleTransitionEnabled(settings.transition) && transition) {
        transition.setParams(battleTransitionParams(settings.transition))
        // 勝敗待機 (#745) のあと、黒を経由して畳む (#830)。畳むのは真っ暗になった瞬間。
        // フェードイン中に押された矢印キーも、離すまで移動に使わない (#779)
        transition.playExit(width, height, outcome, finishClose, () => {
          gate.armReleaseGate()
          suppressNextTouchTap(DIALOG_JUST_SHOWN_GUARD_MS)
        })
        return
      }
      finishClose()
    },
  })
  stage.addChild(screen)
  return screen
}

/** 一枚絵フィールドの脚本制御の戦闘 (#1073) の組み立て結果。味方は持ち越し中の味方（HP 等）の複製 */
export interface FieldScriptedBattleSetup {
  enemies: BattleEntity[]
  /** 初期編成（`味方:` の順。1 人も解決できなければ全員） */
  party: BattleEntity[]
  script: BattleScriptOptions
}

/**
 * `[戦闘 id]` の宣言から、一枚絵フィールドの戦闘を組み立てる (#1073)。`buildScriptedBattle` との違いは味方の出どころだけで、
 * 一枚絵フィールドは `[パーティ]` の定義でなく持ち越し中の味方（`BattleEntity`）を持つので、`味方:` の id をそこから選ぶ。
 * 途中参戦できる味方は初期編成にいない味方全員（side レイアウトだけ。`buildScriptedBattle` と同じ）。渡した味方は書き換えない
 */
export function buildFieldScriptedBattle(
  def: BattleScriptDef,
  masters: Record<string, MonsterDef>,
  party: readonly BattleEntity[],
  layout: BattleLayoutMode,
  rng: () => number
): FieldScriptedBattleSetup | null {
  const enemies = buildScriptedEnemies(def, masters, rng)
  if (!enemies) return null
  const picked: BattleEntity[] = []
  for (const id of parsePartyIds(def.party)) {
    const m = party.find((p) => p.id === id)
    if (m) picked.push(structuredClone(m))
    else console.warn(`[name-name] 戦闘 '${def.id}' の味方: '${id}' は味方に居ない（無視した）`)
  }
  const initial = picked.length > 0 ? picked : party.map((p) => structuredClone(p))
  const joiners: Record<string, BattleEntity> = {}
  if (layout === 'side') {
    for (const p of party) {
      if (initial.some((i) => i.id === p.id)) continue
      joiners[p.id] = structuredClone(p)
    }
  }
  return { enemies, party: initial, script: { id: def.id, rules: def.rules, joiners } }
}

/** `planEventBattle` の判定結果。`skip` の理由: 宣言なし / すでに戦闘中・演出中 / 敵が組めない / 味方が居ない */
export type EventBattlePlan =
  | { kind: 'start'; setup: FieldScriptedBattleSetup }
  | { kind: 'skip'; reason: 'no-def' | 'busy' | 'no-enemies' | 'no-party' }

/**
 * 脚本の `[戦闘: id]` (#1073) を始められるかの判定と組み立て（startFieldGame の `startEventBattle` の判定部）。
 * 宣言が無い（`__proto__` / `toString` など継承の名前も弾く）→ 警告 1 回で `no-def`。`busy`（戦闘中・遷移中）→ 警告なしで `busy`。
 * 敵が 1 体も組めない → `no-enemies`（警告は `buildScriptedEnemies` が出す。一部が未知なら組めた敵だけで始める）。味方が居ない → 警告して `no-party`
 */
export function planEventBattle(args: {
  id: string
  battleScripts: Record<string, BattleScriptDef> | undefined
  busy: boolean
  monsters: Record<string, MonsterDef>
  party: readonly BattleEntity[]
  layout: BattleLayoutMode
  rng: () => number
}): EventBattlePlan {
  const { id, battleScripts, busy, monsters, party, layout, rng } = args
  const def = battleScripts && hasOwn(battleScripts, id) ? battleScripts[id] : undefined
  if (!def) {
    console.warn(`[field] 戦闘 '${id}' の宣言（[戦闘 ${id}]）が無い（読み飛ばします）`)
    return { kind: 'skip', reason: 'no-def' }
  }
  if (busy) return { kind: 'skip', reason: 'busy' }
  if (party.length === 0) {
    console.warn(`[field] 戦闘 '${id}': 味方が居ない（読み飛ばします）`)
    return { kind: 'skip', reason: 'no-party' }
  }
  const setup = buildFieldScriptedBattle(def, monsters, party, layout, rng)
  return setup ? { kind: 'start', setup } : { kind: 'skip', reason: 'no-enemies' }
}

/** `planBattleFlagUpdates` の結果。`set` は反映するフラグ（宣言済み・真偽値のもの）、`warnings` は反映しなかった理由 */
export interface BattleFlagUpdates {
  set: { name: string; value: boolean }[]
  warnings: string[]
}

/**
 * 戦闘結果の `フラグ=` (#1077) のうち、一枚絵フィールドのフラグへ反映できるものを選ぶ純粋関数。
 * 一枚絵フィールドのフラグは設定 JSON の `flags` で宣言した真偽値だけなので、**未宣言の名前**と
 * **真偽値でない値（数値・文字列）**は反映せず警告に回す（ノベルの `[フラグ:]` のような数値・文字列は持てない）。
 * `currentFlags` は実行時のフラグ（宣言済みの名前がキーで揃っている。値は見ない）。宣言の判定は継承の名前（`__proto__` など）を弾く
 */
export function planBattleFlagUpdates(
  currentFlags: Readonly<Record<string, boolean>>,
  resultFlags: Readonly<Record<string, boolean | number | string>> | undefined
): BattleFlagUpdates {
  const out: BattleFlagUpdates = { set: [], warnings: [] }
  if (!resultFlags) return out
  for (const name of Object.keys(resultFlags)) {
    const value = resultFlags[name]
    if (!hasOwn(currentFlags, name)) {
      out.warnings.push(`戦闘結果のフラグ '${name}' は flags に宣言が無い（反映しません）`)
    } else if (typeof value !== 'boolean') {
      out.warnings.push(
        `戦闘結果のフラグ '${name}' の値 ${JSON.stringify(value)} は真偽値でない（一枚絵フィールドのフラグは true / false のみ。反映しません）`
      )
    } else {
      out.set.push({ name, value })
    }
  }
  return out
}

/**
 * 一枚絵フィールドの `EventBattleHost` (#1077)。戦闘を始める `start` の結果が返ったら、`次=` の検索より前に
 * 結果の `フラグ=` を `setFlag` へ反映し（選別は `planBattleFlagUpdates`。反映しない理由は `warn`）、
 * `次=` の行き先は `resolveBattleNextCommands` で選ぶ。startFieldGame の配線とテストが同じ関数を踏む
 */
export function createFieldBattleHost(args: {
  start: (id: string) => Promise<BattleResult | null>
  flags: Readonly<Record<string, boolean>>
  setFlag: (name: string, value: boolean) => unknown
  events: FieldScriptEvents | undefined
  warn?: (msg: string) => void
}): EventBattleHost {
  const { start, flags, setFlag, events, warn = (m) => console.warn(m) } = args
  return {
    startBattle: (id) =>
      start(id).then((result) => {
        const plan = planBattleFlagUpdates(flags, result?.script?.flags)
        for (const w of plan.warnings) warn(`[field] ${w}`)
        for (const { name, value } of plan.set) setFlag(name, value)
        return result
      }),
    findEvent: (name) => resolveBattleNextCommands(name, events, warn),
  }
}
