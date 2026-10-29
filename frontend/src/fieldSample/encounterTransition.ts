/**
 * 一枚絵フィールドのエンカウント → 戦闘の画面遷移の配線 (sit-by-me#55)。PixiJS には触れない（再生は `FieldBattleTransition`）。
 *
 * - `battle.transition` が `none`（既定）なら従来どおり即 `open()`。`ff` / `ff-mosaic` なら開始の演出（ズーム・暗転・モザイク）を挟み、
 *   真っ暗になった瞬間に `open()`（戦闘画面を開く）
 * - 演出中は `transition.active`。すでに演出中の開始要求は無視する（二重エンカウント・強制エンカウントとの重なり防止）
 * - 戦闘の終了も同じモードで、黒を経由してから `close()`（戦闘画面を畳んでフィールドへ戻す）
 */

import {
  battleTransitionParams,
  isBattleTransitionEnabled,
  type BattleTransitionMode,
} from '../game/battleTransition'
import type { BattleOutcome } from '../game/loot'
import type { FieldTalkState } from '../game/fieldNpc'

/** `FieldBattleTransition` のうち配線が使う部分（テストで差し替えられるように切り出す） */
export interface EncounterTransitionPlayer {
  readonly active: boolean
  setParams(params: ReturnType<typeof battleTransitionParams>): void
  playEnter(
    width: number,
    height: number,
    focus: () => { x: number; y: number },
    onBlack: () => void
  ): void
  playExit(
    width: number,
    height: number,
    outcome: BattleOutcome,
    onBlack: () => void,
    onDone: () => void
  ): void
}

/**
 * 戦闘の開始。始められたら true。演出中の要求は false（何もしない）。
 * `none` のときは演出を挟まず `open()` を同期で呼ぶ。
 */
export function beginBattleWithTransition(args: {
  mode: BattleTransitionMode | undefined
  player: EncounterTransitionPlayer
  width: number
  height: number
  focus: () => { x: number; y: number }
  open: () => void
}): boolean {
  const { mode, player, width, height, focus, open } = args
  if (player.active) return false
  if (!isBattleTransitionEnabled(mode)) {
    open()
    return true
  }
  player.setParams(battleTransitionParams(mode))
  player.playEnter(width, height, focus, open)
  return true
}

/** 戦闘の終了。`none` なら即 `close()`、それ以外は黒を経由して（真っ暗な瞬間に）`close()` */
export function endBattleWithTransition(args: {
  mode: BattleTransitionMode | undefined
  player: EncounterTransitionPlayer
  width: number
  height: number
  outcome: BattleOutcome
  close: () => void
}): void {
  const { mode, player, width, height, outcome, close } = args
  if (!isBattleTransitionEnabled(mode)) {
    close()
    return
  }
  player.setParams(battleTransitionParams(mode))
  player.playExit(width, height, outcome, close, () => {})
}

/**
 * 会話・ワープ・決定キー・吹き出しの「取り込み中」判定用の状態。戦闘の開始・終了の演出中は戦闘画面が無い間も
 * 「戦闘中」として扱い、その間に会話やワープが始まらないようにする (sit-by-me#55)。
 */
export function buildTalkState(s: {
  battle: boolean
  battleTransitionActive: boolean
  talking: boolean
  transition: boolean
  warping: boolean
}): FieldTalkState {
  return {
    battle: s.battle || s.battleTransitionActive,
    talking: s.talking,
    transition: s.transition,
    warping: s.warping,
  }
}
