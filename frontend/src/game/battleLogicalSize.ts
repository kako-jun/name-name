/**
 * 戦闘画面の論理キャンバス (sit-by-me#52)。純粋関数のみ。
 *
 * 決定 `SIT.battle-canvas-1920x1080-single-logical`: 戦闘もフィールドと同じ 1920×1080 px（16:9）を唯一の論理キャンバスにする。
 * 端末の物理解像度・縦横比で戦闘座標を作り変えない（crop・背景延長・可変 world 座標なし。表示は 16:9 の等比 contain）。
 *
 * 既存の戦闘レイアウト（`battleLayout.ts` の `SIDE_*` px 定数・文字・窓）は高さ 450 基準の設計値なので、
 * 1920×1080 では BattleScreen の根に `uiScale = 1080 / 450 = 2.4` を掛けて同じ相対的な見た目にする（1920 / 2.4 = 800 なので 16:9 のまま割り切れる）。
 * `logicalSize` 未指定の呼び出し（戦闘サンプル・本編 RPG・従来の field-sample）は従来の可変レイアウトのまま。
 */

export const BATTLE_LOGICAL_WIDTH = 1920
export const BATTLE_LOGICAL_HEIGHT = 1080
/** `SIDE_*` の px 定数が前提にしている設計上の高さ（サンプルの 800×450） */
export const BATTLE_UI_BASE_HEIGHT = 450

export type BattleLogicalSize = '1920x1080'

export interface BattleFrame {
  /** 論理キャンバスの幅（`renderer.resize` に渡す値） */
  width: number
  /** 論理キャンバスの高さ */
  height: number
  /** UI スケール（`height / BATTLE_UI_BASE_HEIGHT`）。BattleScreen の `uiScale` */
  uiScale: number
}

/** 論理サイズの指定（`battle.logicalSize`）を検証する。不正値は undefined（＝従来の可変レイアウト） */
export function parseBattleLogicalSize(raw: unknown): BattleLogicalSize | undefined {
  return raw === '1920x1080' ? '1920x1080' : undefined
}

/** `logicalSize` 指定ありなら 1920×1080 固定の枠、なし（undefined）なら null（従来どおり呼び出し側の width/height） */
export function resolveBattleFrame(logicalSize: BattleLogicalSize | undefined): BattleFrame | null {
  if (logicalSize !== '1920x1080') return null
  return {
    width: BATTLE_LOGICAL_WIDTH,
    height: BATTLE_LOGICAL_HEIGHT,
    uiScale: BATTLE_LOGICAL_HEIGHT / BATTLE_UI_BASE_HEIGHT,
  }
}

/** BattleScreen の `uiScale` を正規化する。有限の正数以外は 1（従来） */
export function normalizeUiScale(raw: number | undefined): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
}

/**
 * 16:9 論理キャンバスを viewport へ等比 contain で収めたときの表示矩形（CSS px）。
 * 余白は黒帯（上下または左右）。crop しない。
 */
export function containRect(
  viewportW: number,
  viewportH: number,
  logicalW: number = BATTLE_LOGICAL_WIDTH,
  logicalH: number = BATTLE_LOGICAL_HEIGHT
): { x: number; y: number; w: number; h: number; scale: number } {
  if (!(viewportW > 0) || !(viewportH > 0)) return { x: 0, y: 0, w: 0, h: 0, scale: 0 }
  const scale = Math.min(viewportW / logicalW, viewportH / logicalH)
  const w = logicalW * scale
  const h = logicalH * scale
  return { x: (viewportW - w) / 2, y: (viewportH - h) / 2, w, h, scale }
}
