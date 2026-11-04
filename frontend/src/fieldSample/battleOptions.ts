/**
 * フィールドサンプルの戦闘（BattleScreen）に渡すオプションの組み立て。DOM / PixiJS に依存しない純関数。
 * 設定の `battle` ブロックの値を、指定があるものだけ BattleScreen のオプションへ渡す（未指定のキーは出さない＝従来の既定）。
 */
import type { BattleScreenOptions } from '../game/BattleScreen'
import type { BattleEngineOptions } from '../game/battleEngine'
import type { BattleMenuData } from '../game/battleMenu'
import type { StatusDef } from '../types'
import type { FieldBattleConfig } from './config'
import { resolveBattleFrame } from '../game/battleLogicalSize'

export function buildBattleScreenOptions(
  b: FieldBattleConfig,
  extra: { background?: string; menu?: BattleMenuData; renderResolution?: number }
): Omit<BattleScreenOptions, 'onClose'> {
  const frame = resolveBattleFrame(b.logicalSize)
  return {
    layout: b.layout,
    spriteStyle: b.spriteStyle,
    ...(b.presentation ? { presentation: b.presentation } : {}),
    ...(b.windowStyle ? { windowStyle: b.windowStyle } : {}),
    ...(b.motion ? { motion: b.motion } : {}),
    ...(b.enemyList ? { enemyList: b.enemyList } : {}),
    ...(b.commandLayout ? { commandLayout: b.commandLayout } : {}),
    ...(b.commands ? { commands: b.commands } : {}),
    ...(b.effects ? { effects: b.effects } : {}),
    ...(extra.background ? { background: extra.background } : {}),
    ...(extra.menu ? { menu: extra.menu } : {}),
    // 論理サイズ指定 (sit-by-me#52) のときだけ UI スケールを渡す（未指定は従来どおり 1 倍＝キー自体を出さない）
    ...(frame
      ? {
          uiScale: frame.uiScale,
          ...(extra.renderResolution ? { renderResolution: extra.renderResolution } : {}),
        }
      : {}),
    ...(b.enemyGrid ? { enemyGrid: b.enemyGrid } : {}),
    ...(b.enemyGrid && b.enemyWindowOverlap !== undefined
      ? { enemyWindowOverlap: b.enemyWindowOverlap }
      : {}),
  }
}

/**
 * BattleEngine に渡すオプション。ATB が有効なときだけ `atb` を渡す（未指定はターン制）。
 * side かつ敵グリッドがあるときは `enemyRow`（最前列でない敵への通常攻撃は半分 #896。設定は無い。BattleScreen に渡すグリッドと同じもの）も渡す
 */
export function buildBattleEngineOptions(
  b: Pick<FieldBattleConfig, 'atb' | 'layout' | 'enemyGrid'>,
  statuses?: Record<string, StatusDef>
): BattleEngineOptions {
  return {
    // 状態の宣言 (#870)。空なら渡さない（戦闘サンプルと同じ条件）
    ...(statuses && Object.keys(statuses).length > 0 ? { statuses } : {}),
    ...(b.atb ? { atb: b.atb } : {}),
    ...(b.layout === 'side' && b.enemyGrid ? { enemyRow: { grid: b.enemyGrid } } : {}),
  }
}
