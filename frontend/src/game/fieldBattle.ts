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
import type { BattleEntity } from './spellDsl'
import type { BattleDepth, BattleLayoutMode } from './battleLayout'
import { normalizeBattleRow } from './battleLayout'
import { DIALOG_JUST_SHOWN_GUARD_MS, suppressNextTouchTap } from './touchInput'
import type { SpriteStyle } from './spriteStyle'
import type { WindowStyle } from './windowStyle'
import type { BackgroundTone } from './backgroundTone'
import type { BackgroundDof } from './depthOfField'
import type { BattleLogTypewriterMode } from './battleLogTypewriter'
import { posesField, type BattlePresentation } from './battleMotion'
import type { BattleAtbConfig } from './battleAtb'
import type { EnemyGridSize } from './enemyGrid'
import type { CommandId, CommandLabels, CommandLayout } from './battleCommands'
import type { BattleMenuData, BattleSkillEntry, BattleSpellEntry } from './battleMenu'
import type { BattleTransitionMode } from './battleTransition'
import type { FieldBattleTransition } from './fieldBattleTransition'

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
  /** `battle_transition` (#830)。`none`（既定・現行の挙動）/ `ff`（開始=2段ズームして暗転、終了=黒を経由して戻る） */
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

/** 戦闘のパーティマスター（`party` と、その定義順 `order`） */
export interface FieldBattleRoster {
  party: Record<string, PartyMemberDef>
  /** 定義順。整数風 ID でも出現順を保つため別持ち */
  order: string[]
  /** 呪文のマスター (#204)。あれば `learns`（レベル以下で覚えるもの）から候補窓の呪文を作る */
  spells?: Record<string, SpellDef>
  /** 特技のマスター (#835)。敵の `行動:` の候補の id から引く。無ければ特技の候補は通常攻撃になる */
  skills?: Record<string, SkillDef>
  /** 状態のマスター (#870)。`[状態]` の宣言。あれば戦闘エンジンの `statuses` に渡す（継続ダメージ・行動不能・回復の反転などが働く） */
  statuses?: Record<string, StatusDef>
  /** アイテムのマスター (#831)。戦利品のログ（「〇〇 を てにいれた！」）の表示名だけに使う。所持品の保存は持たない */
  items?: Record<string, ItemDef>
}

/**
 * 戦闘の味方ごとの呪文の一覧（候補窓用 #204）。`PartyMemberDef.learns` のうち、そのメンバーのレベル（既定 1）以下で
 * 覚えるもので、呪文マスターに定義があるものを定義順に並べる。1 つもなければ undefined（候補窓は開かない）。
 * アイテムは所持品の仕組みが無いので渡さない（どうぐは従来どおり何も起きない）。
 * 「わざ」(#873) は `PartyMemberDef.abilities`（`わざ:` の特技 id）のうち特技マスター（`roster.skills`）にあるものを書いた順に作る。
 */
export function buildBattleMenuData(
  roster: FieldBattleRoster,
  party: readonly BattleEntity[]
): BattleMenuData | undefined {
  const master = roster.spells ?? {}
  const spells: Record<string, BattleSpellEntry[]> = {}
  const skills: Record<string, BattleSkillEntry[]> = {}
  for (const member of party) {
    const def = roster.party[member.id]
    // 「わざ」(#873): `わざ:` の特技 id のうち、特技マスターに定義があるものを書いた順に並べる（MP なし）
    if (def?.abilities && roster.skills) {
      const sm = roster.skills
      const sl: BattleSkillEntry[] = []
      for (const id of def.abilities) {
        const sk = Object.prototype.hasOwnProperty.call(sm, id) ? sm[id] : undefined
        if (!sk || sl.some((e) => e.id === sk.id)) continue
        sl.push({
          id: sk.id,
          name: sk.name,
          target: sk.target,
          ...(sk.effect !== undefined ? { effect: sk.effect } : {}),
          ...(sk.builtin !== undefined ? { builtin: sk.builtin } : {}),
          ...(sk.message !== undefined ? { message: sk.message } : {}),
          ...(sk.telegraph !== undefined ? { telegraph: sk.telegraph } : {}),
        })
      }
      if (sl.length > 0) skills[member.id] = sl
    }
    if (!def?.learns) continue
    const level = def.level ?? 1
    const list: BattleSpellEntry[] = []
    for (const l of def.learns) {
      const sp = Object.prototype.hasOwnProperty.call(master, l.spell) ? master[l.spell] : undefined
      if (!sp || l.level > level || list.some((e) => e.id === sp.id)) continue
      list.push({
        id: sp.id,
        name: sp.name,
        mp: sp.mp,
        target: sp.target,
        ...(sp.effect !== undefined ? { effect: sp.effect } : {}),
        ...(sp.builtin !== undefined ? { builtin: sp.builtin } : {}),
      })
    }
    if (list.length > 0) spells[member.id] = list
  }
  const hasSpells = Object.keys(spells).length > 0
  const hasSkills = Object.keys(skills).length > 0
  if (!hasSpells && !hasSkills) return undefined
  return { ...(hasSpells ? { spells } : {}), ...(hasSkills ? { skills } : {}) }
}

/** PartyMemberDef → BattleEntity。隊列 (#747) は side のときだけ反映する（front は隊列を描かない） */
export function partyDefToBattleEntity(
  def: PartyMemberDef,
  layout: BattleLayoutMode
): BattleEntity {
  return {
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
  if (def) return partyDefToBattleEntity(def, layout)
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
  return ordered.map((k) => partyDefToBattleEntity(roster.party[k], layout))
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
      joiners[id] = partyDefToBattleEntity(roster.party[id], layout)
    }
  }
  return {
    enemies,
    partyIds,
    script: { id: def.id, rules: def.rules, joiners },
  }
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
  /** `battle_transition: ff` (#830) のとき、終了の演出（黒を経由して戻る）を再生するレンダラーの再生機。無ければ（または `none`）即座に畳む */
  transition?: FieldBattleTransition
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
    transition,
    scripted,
    onClosed,
  } = args
  // 初期編成: 脚本制御の戦闘が `味方:` を宣言していればその順（front は先頭 1 人だけ）。なければ従来どおり
  const scriptedParty =
    scripted && scripted.partyIds.length > 0
      ? scripted.partyIds.map((id) => partyDefToBattleEntity(roster.party[id], settings.layout))
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
    ...(scripted ? { script: scripted.script } : {}),
    ...(settings.atb ? { atb: settings.atb } : {}),
    ...(roster.skills ? { skills: toSkillExecutions(roster.skills) } : {}),
    ...(roster.statuses ? { statuses: roster.statuses } : {}),
    ...(itemNamesOf(roster.items) ? { itemNames: itemNamesOf(roster.items) } : {}),
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
    depth: settings.depth,
    foreground: settings.foreground,
    pixelArt: settings.pixelArt,
    ...(settings.enemyGrid ? { enemyGrid: settings.enemyGrid } : {}),
    ...(settings.enemyWindowOverlap !== undefined
      ? { enemyWindowOverlap: settings.enemyWindowOverlap }
      : {}),
    commandLayout: settings.commandLayout,
    commandLabels: settings.commandLabels,
    commands: settings.commands,
    // 途中参戦する味方（#741）の呪文・わざも、参戦したときに選べるよう最初から用意する
    menu: buildBattleMenuData(roster, [...party, ...Object.values(scripted?.script.joiners ?? {})]),
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
      if (settings.transition === 'ff' && transition) {
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
