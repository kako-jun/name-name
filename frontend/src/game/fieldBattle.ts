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
import type { PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { BattleDepth, BattleLayoutMode } from './battleLayout'
import { normalizeBattleRow } from './battleLayout'
import { DIALOG_JUST_SHOWN_GUARD_MS, suppressNextTouchTap } from './touchInput'
import type { SpriteStyle } from './spriteStyle'
import type { WindowStyle } from './windowStyle'
import type { BackgroundTone } from './backgroundTone'
import type { BackgroundDof } from './depthOfField'
import type { BattleLogTypewriterMode } from './battleLogTypewriter'
import type { BattleAtbConfig } from './battleAtb'
import type { CommandLabels, CommandLayout } from './battleCommands'

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
  /** `battle_horizon` / `battle_perspective` (#747) */
  depth: BattleDepth | null
  /** `battle_foreground` (#747) */
  foreground: string | undefined
  /** ドット絵モード (#466)。戦闘のテクスチャを nearest のままにする (#760) */
  pixelArt: boolean
  /** `battle_atb` / `battle_atb_mode` (#205)。undefined = 従来ターン制 */
  atb: BattleAtbConfig | undefined
  /** `battle_command_layout` (#204) */
  commandLayout: CommandLayout
  /** `battle_command_labels` (#204) */
  commandLabels: CommandLabels | undefined
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
  depth: null,
  foreground: undefined,
  pixelArt: false,
  atb: undefined,
  commandLayout: 'grid',
  commandLabels: undefined,
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
    depth: gameData.battleDepth ?? d.depth,
    foreground: gameData.battleForeground,
    pixelArt: gameData.pixelArt === true,
    atb: gameData.battleAtb,
    commandLayout: gameData.battleCommandLayout ?? d.commandLayout,
    commandLabels: gameData.battleCommandLabels,
  }
}

/** 戦闘のパーティマスター（`party` と、その定義順 `order`） */
export interface FieldBattleRoster {
  party: Record<string, PartyMemberDef>
  /** 定義順。整数風 ID でも出現順を保つため別持ち */
  order: string[]
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

export interface OpenFieldBattleArgs {
  stage: Container
  width: number
  height: number
  settings: FieldBattleSettings
  roster: FieldBattleRoster
  enemies: BattleEntity[]
  gate: FieldInputGate
  /** 戦闘画面を畳んだ直後に呼ぶ（クールダウンのセットや移動キーの破棄など、レンダラー固有の後始末）。`closeFieldBattle` で強制的に畳んだときは呼ばれない */
  onClosed: (outcome: BattleOutcome) => void
}

/** 戦闘の結果（BattleScreen の onClose と同じ） */
export type BattleOutcome = 'victory' | 'defeat' | 'escaped'

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
  const { stage, width, height, settings, roster, enemies, gate, onClosed } = args
  const party =
    settings.layout === 'side'
      ? buildPartyBattleEntities(roster, settings.layout)
      : [buildHeroBattleEntity(roster, settings.layout)]
  const engine = new BattleEngine(party, enemies, settings.atb ? { atb: settings.atb } : {})
  const screen: BattleScreen = new BattleScreen(engine, width, height, {
    layout: settings.layout,
    background: settings.background,
    spriteStyle: settings.spriteStyle,
    windowStyle: settings.windowStyle,
    backgroundTone: settings.backgroundTone,
    backgroundDof: settings.backgroundDof,
    logTypewriter: settings.logTypewriter,
    depth: settings.depth,
    foreground: settings.foreground,
    pixelArt: settings.pixelArt,
    commandLayout: settings.commandLayout,
    commandLabels: settings.commandLabels,
    initialHeldKeys: gate.heldKeys(),
    isInputSuspended: () => gate.isSuspended,
    onClose: (outcome) => {
      if (closedScreens.has(screen)) return
      // 戦闘を終わらせたタップ（にげる・止めのたたかう）は PixiJS の pointertap が先に処理して画面を畳むため、
      // 続けて canvas の onUp が handleTap に届き、フィールドのメニューが開いてしまう。直後の tap を抑止する
      suppressNextTouchTap(DIALOG_JUST_SHOWN_GUARD_MS)
      gate.armReleaseGate()
      closeFieldBattle(stage, screen)
      onClosed(outcome)
    },
  })
  stage.addChild(screen)
  return screen
}
