/**
 * 画面効果 (#143) の時間→値 純粋計算。
 *
 * `NovelRenderer` の `startShake` / `startFlash` / `startFade` は内部で
 * `performance.now()` を読み、その経過時間から「stage の揺れオフセット」や
 * 「effectOverlay の alpha」を毎フレーム計算して PixiJS に反映していた。
 * その計算自体（減衰 sin/cos 揺れ・線形 alpha 補間）は決定論的な pure computation
 * なので、`easing.ts` / `raycastProjection.ts` と同じ流儀でここに切り出す（#260 漸進分離）。
 *
 * PixiJS / DOM / TimeController に一切依存しない。`NovelRenderer` 側はタイマー駆動の
 * 「いつ計算するか」と「結果をどの表示オブジェクトに当てるか」だけを持つ。
 */

/**
 * 経過時間と継続時間から進行率 t を返す（0..1 にクランプ済み）。
 *
 * `progress = min(elapsed / durationMs, 1)` を 1 箇所に集約したもの。
 * shake / flash / fade の 3 経路で同じ式を使っていた。
 *
 * 入力契約:
 *  - `durationMs <= 0` または非有限 → `1`（即完了扱い。0 除算と発散を回避）
 *  - `elapsed` の `NaN/Infinity` → `1`（破損時刻は完了扱いにして演出を残さない）
 *  - 負の `elapsed` は `0` にクランプ
 */
export function effectProgress(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1
  if (!Number.isFinite(elapsedMs)) return 1
  if (elapsedMs <= 0) return 0
  const t = elapsedMs / durationMs
  return t > 1 ? 1 : t
}

/** 画面シェイク 1 フレーム分の stage オフセット（px）。 */
export interface ShakeOffset {
  /** stage.position.x に設定する横揺れ量 */
  offsetX: number
  /** stage.position.y に設定する縦揺れ量 */
  offsetY: number
  /** 演出が完了したか（progress >= 1）。true なら呼び出し側はオフセットを 0 に戻して終了する */
  done: boolean
}

/**
 * 減衰 sin/cos 波ベースの画面シェイクオフセットを返す純粋関数 (#143)。
 *
 * 元 `NovelRenderer.startShake` の tick 内と同一の式:
 *   decay   = 1 - progress
 *   offsetX = sin(elapsed * 0.05) * intensityPx * decay
 *   offsetY = cos(elapsed * 0.037) * intensityPx * decay * 0.6
 * 残り時間に比例して振幅を絞る（progress=1 で振幅 0）。X より Y を弱く（×0.6）して
 * 横揺れ主体の自然な揺れにする。位相係数 0.05 / 0.037 は互いに素に近い比でうねりを出す。
 *
 * `done` は `progress >= 1`。呼び出し側は `done` のとき stage を (0,0) に戻して停止する。
 *
 * 入力契約:
 *  - `intensityPx` の `NaN/Infinity` は `0` 扱い（揺れなし）
 *  - `elapsedMs` / `durationMs` は `effectProgress` の契約に従う
 */
export function computeShakeOffset(
  elapsedMs: number,
  intensityPx: number,
  durationMs: number
): ShakeOffset {
  const progress = effectProgress(elapsedMs, durationMs)
  const safeIntensity = Number.isFinite(intensityPx) ? intensityPx : 0
  const decay = 1 - progress
  const safeElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  const offsetX = Math.sin(safeElapsed * 0.05) * safeIntensity * decay
  const offsetY = Math.cos(safeElapsed * 0.037) * safeIntensity * decay * 0.6
  return { offsetX, offsetY, done: progress >= 1 }
}

/** flash / fade 1 フレーム分の alpha と完了状態。 */
export interface EffectAlpha {
  /** effectOverlay.alpha に設定する不透明度 */
  alpha: number
  /** 演出が完了したか（progress >= 1） */
  done: boolean
}

/**
 * フラッシュ演出の alpha を返す純粋関数 (#143)。
 *
 * 元 `NovelRenderer.startFlash` と同一: `alpha = peakAlpha * (1 - progress)`。
 * peak から 0 へ線形フェードアウトする。`done`（progress>=1）のとき呼び出し側は
 * overlay を不可視に戻す。
 *
 * 入力契約: `peakAlpha` の `NaN/Infinity` は `0` 扱い。
 */
export function computeFlashAlpha(
  elapsedMs: number,
  peakAlpha: number,
  durationMs: number
): EffectAlpha {
  const progress = effectProgress(elapsedMs, durationMs)
  const safePeak = Number.isFinite(peakAlpha) ? peakAlpha : 0
  return { alpha: safePeak * (1 - progress), done: progress >= 1 }
}

/**
 * フェード演出の alpha を返す純粋関数 (#143)。
 *
 * 元 `NovelRenderer.startFade` と同一: `alpha = fromAlpha + (toAlpha - fromAlpha) * progress`。
 * fromAlpha → toAlpha へ線形補間する。`done`（progress>=1）のとき alpha は `toAlpha` ちょうど
 * （補間誤差を残さないよう呼び出し側で `toAlpha` を当て直す元挙動と一致させる）。
 *
 * 入力契約: `fromAlpha` / `toAlpha` の `NaN/Infinity` は `0` 扱い。
 */
export function computeFadeAlpha(
  elapsedMs: number,
  fromAlpha: number,
  toAlpha: number,
  durationMs: number
): EffectAlpha {
  const progress = effectProgress(elapsedMs, durationMs)
  const safeFrom = Number.isFinite(fromAlpha) ? fromAlpha : 0
  const safeTo = Number.isFinite(toAlpha) ? toAlpha : 0
  if (progress >= 1) return { alpha: safeTo, done: true }
  return { alpha: safeFrom + (safeTo - safeFrom) * progress, done: false }
}
