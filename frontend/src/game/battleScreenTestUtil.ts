import type { BattleScreen } from './BattleScreen'

/**
 * 登場スライド (#1037/#1110) を済ませた状態にする。
 * ff かつ side の戦闘は default でも開始時に登場スライドが走り、その間は入力・ATB・演出の再生が止まる。
 * 登場と無関係なテストが「開始直後から動く」前提で書かれているので、構築直後に登場を終わらせて位置も反映する
 * （登場そのものを確かめるテストは BattleScreenMotion.test.ts で、これを使わず実際に tick する）。
 */
export function skipEntrance<T extends BattleScreen>(s: T): T {
  const x = s as unknown as { entranceActive: boolean; refresh(): void }
  x.entranceActive = false
  x.refresh()
  return s
}
