/**
 * イベント絵ピクセレート遷移 (#583) の時間→値 純粋計算。
 *
 * `ambientEffects.ts`（ゆらぎ・ろうそく揺れの時間→値計算）と同じ流儀: PixiJS 本体の描画コード
 * から「いつ・どんな値になるか」の計算を切り出し、`EventImageLayer` はタイマー駆動の
 * 「いつ計算するか」と「結果を PixelateFilter.size にどう反映するか」だけを持つ。遷移の
 * 進行位相（コルセン/ホールド/リファインのどの段階か・経過時間）は settled state
 * （`NovelGameState`/`EventImageState`）ではなくレンダラ側の一時状態に属する
 * （ADR-0002 / dev-doctrine 規律1）。
 *
 * 配分の根拠: `[イベント絵: path, 遷移=pixelate, フェード=N]` の `N`（既存の `fade_ms` を
 * 「遷移全体の所要時間」として再利用）を、前半 `PIXELATE_TRANSITION_SWAP_RATIO`（既定 50%）で
 * コルセン（ドットを 1→maxSize へ粗くする）、その地点で画像を切り替え、残り半分でリファイン
 * （maxSize→1 へ細かく戻す）に均等配分する。50/50 にしたのは、TUI 側 `image_fade.rs` の
 * `blend()` が既存の透明度クロスフェードで t>=0.5 の中間点をハード切替に使っているのと対称的な
 * 「中間点でスワップ」設計に揃えるため（GUI/TUI の見た目のリズムを合わせる）。
 * 画像ロードがコルセン完了より遅れた場合は `holding` フェーズとしてロード完了まで最大サイズを
 * 維持してから切り替える（呼び出し側 `EventImageLayer` が管理する）。
 */

/** PixelateFilter.size の最大値（最も粗い状態）。実装者裁量の moderate 値。 */
export const PIXELATE_TRANSITION_MAX_SIZE = 24

/** 遷移全体の所要時間のうち、コルセン（切替前半）に配分する割合。 */
export const PIXELATE_TRANSITION_SWAP_RATIO = 0.5

/**
 * 遷移全体の所要時間 `durationMs` から、コルセン→切替の境界時刻 (ms) を返す。
 */
export function computeSwapAtMs(
  durationMs: number,
  ratio: number = PIXELATE_TRANSITION_SWAP_RATIO
): number {
  const d = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  return d * ratio
}

/**
 * コルセン中（画像切替前）の `PixelateFilter.size` を返す。1(最も細かい)→maxSize(最も粗い) へ
 * 線形に変化する。
 *
 * 入力契約: `elapsedMs` の非有限値/負値は `0` 扱い（ambientEffects.ts と同じ防御）。
 * `swapAtMs<=0` は即座に maxSize を返す（所要時間0＝瞬時切替）。
 */
export function computeCoarsenSize(
  elapsedMs: number,
  swapAtMs: number,
  maxSize: number = PIXELATE_TRANSITION_MAX_SIZE
): number {
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const t = swapAtMs <= 0 ? 1 : Math.min(1, e / swapAtMs)
  return Math.max(1, Math.round(1 + t * (maxSize - 1)))
}

/**
 * リファイン中（画像切替後）の `PixelateFilter.size` を返す。maxSize(最も粗い)→1(最も細かい) へ
 * 線形に変化する。`remainingMs` はコルセン完了（実際のスワップ時刻）からの残り所要時間
 * （`durationMs - swapAtMs` が基本だが、ロード待ちで伸びた分は含めない — 呼び出し側が
 * スワップ実時刻を基準に計測する）。
 *
 * 入力契約: `elapsedMs` の非有限値/負値は `0` 扱い。`remainingMs<=0` は即座に 1 を返す。
 */
export function computeRefineSize(
  elapsedMs: number,
  remainingMs: number,
  maxSize: number = PIXELATE_TRANSITION_MAX_SIZE
): number {
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const t = remainingMs <= 0 ? 1 : Math.min(1, e / remainingMs)
  return Math.max(1, Math.round(maxSize - t * (maxSize - 1)))
}

/** コルセン完了（切替のタイミングに到達したか）を返す。 */
export function isCoarsenComplete(elapsedMs: number, swapAtMs: number): boolean {
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  return e >= swapAtMs
}

/** リファイン完了（遷移全体の終了）を返す。 */
export function isRefineComplete(elapsedMs: number, remainingMs: number): boolean {
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  return e >= remainingMs
}
