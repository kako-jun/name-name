/**
 * イベント絵アンビエント演出 (#582) の時間→値 純粋計算 + テクスチャ生成ヘルパー。
 *
 * `screenEffects.ts`（shake/flash/fade の時間→値計算）と同じ流儀: PixiJS 本体の描画コードから
 * 「いつ・どんな値になるか」の計算を切り出し、`EventImageLayer` はタイマー駆動の「いつ計算するか」
 * と「結果をどの表示オブジェクトに当てるか」だけを持つ。ゆらぎ・ろうそく揺れのアニメーション位相は
 * settled state（`NovelGameState`/`EventImageState`）ではなくここ（レンダラ側の一時計算）に属する
 * （ADR-0002 / dev-doctrine 規律1）。
 */

/**
 * ゆらぎ (DisplacementFilter 用) の変位スプライトオフセット。2つの正弦波を重ねて機械的な
 * 周期性を弱め、Gymnasia の「常時ゆらぎ」に必要な「微妙な」有機的うねりにする。
 *
 * 入力契約: `elapsedMs` の非有限値/負値は `0` 扱い（発散・NaN 伝播を防ぐ）。
 */
export function computeWobbleOffset(elapsedMs: number): { x: number; y: number } {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  return {
    x: Math.sin(t * 0.00035) * 14 + Math.sin(t * 0.0013) * 5,
    y: Math.cos(t * 0.00027) * 10 + Math.cos(t * 0.0011) * 4,
  }
}

/**
 * `seed` から決定論的な擬似乱数を1つ生成する（mulberry32、`screenEffects.ts` の
 * 三角関数ベース計算と同じく PixiJS/DOM に依存しない純粋関数）。ろうそく揺れの
 * 「数コマ単位のステップ」ごとに異なるが再現可能な値を得るための小さなハッシュとして使う。
 */
function mulberry32(seed: number): number {
  let a = seed >>> 0
  a |= 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** ろうそく揺れの既定ステップ間隔 (ms)。伝統アニメの「2〜4コマ持ち」に近い体感速度。 */
export const CANDLE_STEP_MS = 120

/**
 * ろうそく光の数コマ揺れ（#582 要件4）の明度係数を返す純粋関数。
 *
 * `elapsedMs` を `stepMs` 単位で量子化してから疑似乱数を引く「段階的な」揺れ
 * （滑らかな lerp ではなく、伝統的なコマ撮りアニメのように一定時間ごとに値が飛ぶ）。
 * 戻り値は `[0.86, 1.0]`（暗すぎて視認性を損なわない範囲の moderate な揺れ）。
 *
 * 入力契約: `elapsedMs` の非有限値/負値は `0` 扱い。`stepMs<=0` は既定 `CANDLE_STEP_MS` にフォールバック。
 */
export function computeCandleFlicker(elapsedMs: number, stepMs: number = CANDLE_STEP_MS): number {
  const safeStep = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : CANDLE_STEP_MS
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const step = Math.floor(t / safeStep)
  const r = mulberry32(step + 1)
  return 0.86 + r * 0.14
}

/**
 * 変位マップ用のシード付き「雲」テクスチャを `size x size` の canvas に生成する。
 * 中心グレー（R=G=128=変位ゼロ）を下地に、R/G チャンネルを僅かにずらした半透明の
 * 放射グラデーションを重ねることで、`DisplacementFilter` に与えたとき滑らかな
 * ヒートヘイズ的歪みになる（ランダムな単ピクセルノイズだとブロックノイズ状の
 * 荒れた歪みになってしまうため、意図的に低周波のブロブで構成する）。
 *
 * jsdom（`canvas` npm パッケージ未導入環境。フロントエンドのユニットテストで使用）では
 * `getContext('2d')` が `null` を返すため、その場合は `null` を返す（呼び出し側は
 * ゆらぎフィルタの追加を諦めるだけで、他の描画には影響しない防御的フォールバック）。
 * 実ブラウザでは常に生成できる。
 *
 * PixiJS の `Texture` に依存するため呼び出し側で `Texture.from(canvas)` する
 * （このファイル自体は screenEffects.ts と同じく計算主体だが、この関数だけは
 * DOM Canvas API を直接呼ぶ非純粋関数 — テクスチャ生成はどのみち副作用を伴うため
 * ここに同居させる）。
 */
export function buildDisplacementNoiseCanvas(size = 256): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = 'rgb(128, 128, 128)'
  ctx.fillRect(0, 0, size, size)

  const blobCount = 36
  for (let i = 0; i < blobCount; i++) {
    // シード付き（i 起点）にして再生成のたびに絵柄が変わらないようにする（見た目の一貫性）。
    const rx = mulberry32(i * 7 + 1)
    const ry = mulberry32(i * 7 + 2)
    const rr = mulberry32(i * 7 + 3)
    const rdr = mulberry32(i * 7 + 4)
    const rdg = mulberry32(i * 7 + 5)
    const x = rx * size
    const y = ry * size
    const r = size * (0.1 + rr * 0.22)
    const dr = Math.round((rdr - 0.5) * 110)
    const dg = Math.round((rdg - 0.5) * 110)
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, `rgba(${128 + dr}, ${128 + dg}, 128, 0.55)`)
    grad.addColorStop(1, 'rgba(128, 128, 128, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }

  return canvas
}
