/**
 * 戦闘の ATB 方式 (#205) の設定まわりの純粋関数。
 *
 * frontmatter `battle_atb: on|off`（既定 off＝従来ターン制）と `battle_atb_mode: wait|active`（既定 wait）から
 * `BattleEngine` の `atb` オプションを作る。ゲージ・キューの計算そのものは battleEngine.ts が正本。
 */
import type { AtbMode } from './battleEngine'

/** `BattleEngine` の `atb` オプションのうち、設定由来の部分 */
export interface BattleAtbConfig {
  mode: AtbMode
}

/** frontmatter `battle_atb_mode` の値を正規化する。`'active'` 以外（未指定・空・未知値含む）は `'wait'`（大小無視） */
export function normalizeAtbMode(raw: string | null | undefined): AtbMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'active' ? 'active' : 'wait'
}

/**
 * frontmatter `battle_atb` / `battle_atb_mode` を正規化する。`battle_atb` が `on`（大小無視）のときだけ設定を返し、
 * それ以外（未指定・空・未知値含む）は undefined＝従来ターン制。
 */
export function normalizeBattleAtb(
  atbRaw: string | null | undefined,
  modeRaw: string | null | undefined
): BattleAtbConfig | undefined {
  if (typeof atbRaw !== 'string' || atbRaw.trim().toLowerCase() !== 'on') return undefined
  return { mode: normalizeAtbMode(modeRaw) }
}
