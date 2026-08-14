/**
 * `NovelRenderer` の純粋計算（幾何・色パース・URL/フォント解決・シーンルックアップ）。
 *
 * `NovelRenderer.ts`（god-object）の肥大トレンド監視と漸進分離 (#260) の一環。
 * 入力→出力が決定論的で、`this` / PixiJS / DOM / TimeController に一切依存しない計算だけを
 * ここに集約する。`screenEffects.ts`（時間→値）/ `raycastProjection.ts`（射影幾何）/
 * `easing.ts` と同じ流儀。NovelRenderer 側は「いつ計算するか」「結果をどの表示オブジェクト・
 * オーディオに当てるか」だけを保持する。
 *
 * 各関数は抽出前に NovelRenderer 内へ直書きされていた式と数値・文字列が完全に一致する
 * （挙動不変）。リファレンス等価性は novelLayout.test.ts で機械的に担保する。
 */

import type { BackgroundFade, NovelGameState } from './GameState'
import type { SaveSlotData } from './SaveManager'
import type { EventScene } from '../types'
import { MIDLINE_RULE } from './textCanonical'
import { hasOwn } from './ownProperty'

/** カバーフィット後の背景スプライト寸法と配置（px）。 */
export interface CoverFit {
  /** sprite.width に設定する表示幅（px） */
  width: number
  /** sprite.height に設定する表示高さ（px） */
  height: number
  /** sprite.x に設定する左上 X（中央寄せのオフセット） */
  x: number
  /** sprite.y に設定する左上 Y（中央寄せのオフセット） */
  y: number
}

/**
 * 背景画像をアスペクト比維持で画面いっぱいに「カバー」し、中央寄せした寸法を返す純粋関数。
 *
 * 元 `NovelRenderer.applyCoverFit` と同一:
 *   scaleX = screenW / texW
 *   scaleY = screenH / texH
 *   scale  = max(scaleX, scaleY)         // 短辺を画面に合わせ、長辺は溢れさせる（cover）
 *   width  = texW * scale
 *   height = texH * scale
 *   x = (screenW - width) / 2            // 溢れた分を左右（または上下）に等分して中央寄せ
 *   y = (screenH - height) / 2
 *
 * `Math.max(scaleX, scaleY)` で「画面を覆う最小倍率」を選ぶため、画像は必ず画面全体を埋め、
 * はみ出した方向は中央でトリミングされる（contain ではなく cover）。
 *
 * NovelRenderer 側はこの結果を sprite.{width,height,x,y} にそのまま代入するだけ。
 * texture サイズと screen サイズはどちらも純粋な数値で、PixiJS Sprite には触れない。
 */
export function computeCoverFit(
  textureWidth: number,
  textureHeight: number,
  screenWidth: number,
  screenHeight: number
): CoverFit {
  const scaleX = screenWidth / textureWidth
  const scaleY = screenHeight / textureHeight
  const scale = Math.max(scaleX, scaleY)
  const width = textureWidth * scale
  const height = textureHeight * scale
  return {
    width,
    height,
    x: (screenWidth - width) / 2,
    y: (screenHeight - height) / 2,
  }
}

/**
 * `computeDynamicRenderResolution` が許容する裏バッファの幅・高さそれぞれの上限（px）。GPU の
 * `MAX_TEXTURE_SIZE`（2015年以降の GPU はほぼ全て 8192 以上をサポート）に対して十分な余裕を
 * 持たせた保守的な固定値。
 *
 * 4096 だった旧値は、27インチ 5K iMac / Studio Display（dpr=2、論理解像度 2560×1440 程度）で
 * NovelPlayer をフルウィンドウ表示するだけで発動してしまい（displayWidth≈2560, screenWidth=800
 * (16:9) → raw=6.4 > maxResolution=5.12 でクランプ）、Issue #446 本来の目的（大画面での文字の
 * 精細さ向上）をごく普通の高DPI単体モニタ環境でも部分的に打ち消していた（#446 再レビュー
 * should対応）。8192 まで引き上げることで、単体モニタでの通常利用ではまず発動しない。
 */
export const MAX_RENDER_BACKBUFFER_DIMENSION_PX = 8192

/**
 * 実表示サイズに応じたレンダラ解像度を算出する純粋関数 (#446)。
 *
 * PixiJS のレンダリング解像度は元々 `devicePixelRatio`（Retina 補正）だけで固定していたが、
 * canvas 要素自体が CSS で表示サイズいっぱいに引き伸ばされる分（レターボックス内接矩形が
 * 実ビューポートよりずっと大きい大画面・最大化時等）を考慮しておらず、DotGothic16 等で
 * 文字の滲み・ジャギーが目立っていた（#446）。
 *
 * `displayWidth`（`containerRef` の実測 CSS 表示幅）と `screenWidth`（論理解像度幅。
 * construct 時に固定、`ASPECT_RATIOS` 由来）の比率＝「CSS 引き伸ばし倍率」を
 * `devicePixelRatio` に掛け合わせることで、実表示サイズに応じた裏バッファ密度を得る。
 * `screenWidth`/`screenHeight`（論理サイズ）自体は変更しない（変えるのは裏バッファの密度だけ）。
 *
 * `displayWidth <= 0` または `screenWidth <= 0`（レイアウト未確定・jsdom 等）の場合は
 * 安全側の `devicePixelRatio`（引き伸ばし倍率 1 扱い）にフォールバックする
 * （0 除算・NaN・負値を避ける）。`devicePixelRatio` 自体が不正（0 以下・NaN・Infinity）な
 * 場合も 1 にフォールバックする。
 *
 * 上限クランプ (#446 セルフレビュー should対応 / 再レビュー question対応): 裏バッファの幅・高さ
 * （PixiJS が実際に確保する `screenWidth × resolution` / `screenHeight × resolution`）は
 * GPU の `MAX_TEXTURE_SIZE`（2015年以降の GPU はほぼ全て 8192 以上）を超えられない。
 * 複数モニタにまたがる横幅の広いウィンドウ＋高DPRのような極端な構成では
 * `displayWidth/screenWidth × dpr` が際限なく大きくなりうるため、`MAX_RENDER_BACKBUFFER_DIMENSION_PX`
 * を超えないよう結果をクランプする。GPU ごとの正確な上限は実行時に取得できないため、
 * 低スペック環境でも安全な余裕を持たせた値を採用する。
 *
 * クランプ基準は `screenWidth`/`screenHeight` の**大きい方**（`Math.max`）にする。`screenWidth`
 * のみを基準にすると、9:16 のような縦長アスペクト比（`screenHeight > screenWidth`）で裏バッファの
 * **高さ**（`screenHeight × resolution`）がクランプの計算式で保護されず、`MAX_RENDER_BACKBUFFER_DIMENSION_PX`
 * を超えうる（#446 再レビュー question対応）。大きい方の軸を基準にすれば、その軸の裏バッファは
 * ちょうど上限に収まり、小さい方の軸は同じ resolution で必ずそれ以下になる（矩形の短辺と長辺の
 * 関係は resolution を掛けても変わらないため）。`screenHeight` が不正（0 以下・NaN・非有限）な
 * 場合は `screenWidth` をそのまま基準にする（screenHeight 未指定・不明時のフォールバック）。
 *
 * 上限に達した場合、返り値は「クランプ基準側で裏バッファ幅（or 高さ）が
 * `MAX_RENDER_BACKBUFFER_DIMENSION_PX` に一致する resolution」に切り詰められる（見た目には Retina
 * 表示の鮮明さが頭打ちになるだけで、クラッシュや真っ黒描画は避けられる）。
 */
export function computeDynamicRenderResolution(
  displayWidth: number,
  screenWidth: number,
  screenHeight: number,
  devicePixelRatio: number
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  if (!(displayWidth > 0) || !(screenWidth > 0)) return dpr
  const raw = dpr * (displayWidth / screenWidth)
  const safeScreenHeight =
    Number.isFinite(screenHeight) && screenHeight > 0 ? screenHeight : screenWidth
  const clampBasis = Math.max(screenWidth, safeScreenHeight)
  const maxResolution = MAX_RENDER_BACKBUFFER_DIMENSION_PX / clampBasis
  return Math.min(raw, maxResolution)
}

/**
 * `window.devicePixelRatio` を安全に読む (#446 セルフレビュー nit 対応 / #455 nit 対応で
 * `NovelPlayer.tsx` のローカル関数からここへ移設)。
 *
 * SSR/jsdom 等 `window` が存在しない場合、または `devicePixelRatio` が未設定・0 の場合は
 * 1（等倍）にフォールバックする。`computeDynamicRenderResolution` の `devicePixelRatio` 引数を
 * 埋める値の取得元として、`NovelPlayer.tsx`（初期解像度適用・ResizeObserver 追従の2箇所）と
 * `VideoExporter.ts`（#455 `resolveCleanupResolution`、書き出し終了時の解像度復元）が共有する。
 *
 * このモジュールの他の関数と異なり `window` というグローバル環境を直接読むため、厳密には
 * 「引数だけから出力が決まる」純粋関数ではない（同じ呼び出しでも window の状態次第で値が
 * 変わる）。それでも、呼び出し側 3 箇所でバイト単位同一の式が重複していた実害（#455 セルフ
 * レビュー nit）を解消する実利を優先し、他の純粋計算と同じくここに集約する。
 */
export function resolveDevicePixelRatio(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

/**
 * `#RRGGBB` 形式（またはプレフィックス省略の `RRGGBB`）を PixiJS 用の数値色に変換する純粋関数。
 *
 * 元 `NovelRenderer.parseHexColor` と同一:
 *   clean = hex の先頭 '#' を 1 つだけ除去
 *   n     = parseInt(clean, 16)
 *   結果  = NaN なら 0xffffff（白フォールバック）、それ以外は n
 *
 * `replace('#', '')` は最初の '#' のみ除去する元実装をそのまま踏襲する。
 * `parseInt(_, 16)` の寛容な解釈（途中までパース・先頭空白許容等）も元と一致。
 * 不正値で白にフォールバックするのは Flash/Fade のオーバーレイ色が消えないようにするため。
 */
export function parseHexColor(hex: string): number {
  const clean = hex.replace('#', '')
  const n = parseInt(clean, 16)
  return isNaN(n) ? 0xffffff : n
}

/** 矩形（px・論理座標）。split_layout の画像/テキスト領域の共通表現。 */
export interface LayoutRect {
  /** 左上 X（px） */
  x: number
  /** 左上 Y（px） */
  y: number
  /** 幅（px） */
  width: number
  /** 高さ（px） */
  height: number
}

/** `computeSplitLayoutRegions` の結果（#442）。 */
export interface SplitLayoutRegions {
  /** 横長・正方形＝'landscape'（左右分割） / 縦長＝'portrait'（上下分割）。 */
  orientation: 'landscape' | 'portrait'
  /** キャラ画像を収める領域。 */
  character: LayoutRect
  /** テキストウィンドウを収める領域。 */
  text: LayoutRect
}

/**
 * frontmatter `split_layout: true`（#442）用に、画面比率からキャラ画像領域・テキスト領域を
 * 左右/上下に振り分ける純粋関数。
 *
 * dialog_style（adv/novel、テキスト送りの挙動）とは独立の軸で、こちらは「画像を画面全面＋
 * テキストをオーバーレイ」という既存の重畳ジオメトリの**代わりに**、画面を隙間なく 2 分割し
 * 画像とテキストを別領域に収める第三のジオメトリを提供する。
 *
 * 判定規則:
 *  - `screenWidth >= screenHeight`（横長 **or ちょうど正方形**）→ `'landscape'`。
 *    左半分＝画像、右半分＝テキスト（`x` で左右に 2 等分）。
 *  - `screenWidth < screenHeight`（縦長）→ `'portrait'`。
 *    上半分＝画像、下半分＝テキスト（`y` で上下に 2 等分）。
 *
 * 正方形（`screenWidth === screenHeight`）は横長側（左右分割）に倒す。分割点の面積は
 * どちらの軸で切っても同じ（ちょうど半分）なので見た目の破綻はなく、判定を単純な `>=` 1つに
 * 統一するための割り切り。`constants.ts` の `pickFluidAspectRatio`（fluid `aspect_ratio: auto`
 * 用に横長/縦長の離散比率を選ぶ関数）も同じ `>=` 規約（正方形は横長側）を使う。両者が食い違うと
 * 「キャンバスの実形」と「split_layout の領域分割」が矛盾するため、どちらかを変える場合は
 * 必ずもう一方も揃えること。
 *
 * 領域は隙間なく画面いっぱいを 2 等分する（合計が screenWidth × screenHeight に一致する）。
 * Math.random など非決定要素は使わない決定論的写像。
 */
export function computeSplitLayoutRegions(
  screenWidth: number,
  screenHeight: number
): SplitLayoutRegions {
  if (screenWidth >= screenHeight) {
    const half = screenWidth / 2
    return {
      orientation: 'landscape',
      character: { x: 0, y: 0, width: half, height: screenHeight },
      text: { x: half, y: 0, width: screenWidth - half, height: screenHeight },
    }
  }
  const half = screenHeight / 2
  return {
    orientation: 'portrait',
    character: { x: 0, y: 0, width: screenWidth, height: half },
    text: { x: 0, y: half, width: screenWidth, height: screenHeight - half },
  }
}

/** `splitTextRegionForDualWindow` の結果 (#444)。話者別2窓（相手=上/自分=下）のテキスト領域。 */
export interface DualWindowTextRegions {
  /** 相手側テキストウィンドウ（上半分）。 */
  opponent: LayoutRect
  /** 自分側テキストウィンドウ（下半分）。 */
  self: LayoutRect
}

/**
 * split_layout (#442) のテキスト領域（`computeSplitLayoutRegions(...).text`）を、話者別2窓
 * （相手=上 / 自分=下）にさらに上下2分割する純粋関数 (#444)。
 *
 * Issue #444 確定仕様: `split_layout: true` + `protagonist:` 指定時、テキスト領域を上下2つの
 * ウィンドウに固定配置する（横長時は正方形2つを横に並べた形をさらに上下に割る、縦長時は同じ構造を
 * 90度回転）。`computeSplitLayoutRegions` が既に orientation（landscape/portrait）を
 * `text.height` に折り込み済みのため、この関数はどちらの orientation でも同じ式で良い
 * （`text.width` は左右方向に分割しないためそのまま両ウィンドウで共有する）。
 *
 * 上半分＝相手（opponent、話者 ≠ protagonist）、下半分＝自分（self、話者 = protagonist）固定。
 * 隙間なく厳密に2等分する（opponent.height + self.height === text.height）。整数丸め
 * （Math.floor 等）は行わないため、奇数 height では両ウィンドウとも小数 px になる
 * （例: height=101 → 50.5 ずつ、非対称な「端数吸収」は起きない）。PixiJS は小数 px 座標を
 * 問題なく描画するため実害はない。Math.random など非決定要素は使わない決定論的写像。
 */
export function splitTextRegionForDualWindow(text: LayoutRect): DualWindowTextRegions {
  const half = text.height / 2
  return {
    opponent: { x: text.x, y: text.y, width: text.width, height: half },
    self: { x: text.x, y: text.y + half, width: text.width, height: text.height - half },
  }
}

/** `computeFullscreenImageFit` の結果（#530）。 */
export interface FullscreenImageFit {
  /** sprite.width に設定する表示幅（px）。常に canvasWidth と一致する（横幅いっぱい）。 */
  width: number
  /** sprite.height に設定する表示高さ（px）。アスペクト比維持のため canvasHeight を超えうる。 */
  height: number
  /** sprite.x に設定する左上 X（px）。常に 0（横方向は常にぴったり収まるため中央寄せ不要）。 */
  x: number
  /**
   * canvasHeight に対して縦スクロールが必要か（`height > canvasHeight`）。
   * true のとき、呼び出し側はスクロールヒントを出し、`clampFullscreenImageScrollY` で
   * クランプした offsetY を `y` に適用してよい（`0`〜`-maxScrollY` の範囲）。
   */
  scrollable: boolean
  /**
   * 縦スクロールの最大オフセット（px、0 以上）。`scrollable=false` のときは常に 0。
   * `height - canvasHeight` を 0 未満にならないようクランプした値。
   */
  maxScrollY: number
}

/**
 * frontmatter `fullscreen_image: true`（#530）用の、テキストウィンドウ非表示・contain・
 * 縦スクロール対応の画像フィットを算出する純粋関数。
 *
 * `computeCoverFit`（画面いっぱいに覆う代わりに長辺をクロップする）とは異なり、こちらは
 * 「クロップしない」ことを優先する。仕様（Issue #530）どおり常に横幅を canvasWidth に
 * 一致させてから高さをアスペクト比維持で決める（`scale = canvasWidth / textureWidth` 固定、
 * `computeCoverFit` の `Math.max(scaleX, scaleY)` のような縦横比較はしない）。結果として
 * 画像は必ず横幅いっぱいに contain され、縦長画像で高さが canvasHeight を超える場合は
 * 追加の縮小をせず（＝横幅を保ったまま）呼び出し側が縦スクロールで見せる。
 *
 * 横長画像（例: Gymnasia ロゴ 256x48, aspect 5.33:1）は通常 `height <= canvasHeight` となり
 * `scrollable=false`。縦長・極端に長い画像は `scrollable=true` になる。
 *
 * `textureWidth`/`canvasWidth` が 0 以下の場合は 0 除算を避けて `scale=0` にフォールバックし、
 * `height`（＝`textureHeight * scale`）を 0 にする（`computeCoverFit` は呼び出し側の texture
 * ロード完了後にのみ呼ばれる前提でガードしていないのと同じ流儀だが、こちらは scrollable 判定の
 * 分母事故を避けるため明示的に 0 ガードする）。`width` はこのガードの対象外で、`FullscreenImageFit.width`
 * の契約どおり常に `canvasWidth` をそのまま返す（`canvasWidth` 自体が 0 以下ならその値がそのまま出る）
 * （novelLayout.test.ts の `computeFullscreenImageFit` 退化入力テスト参照）。
 */
export function computeFullscreenImageFit(
  textureWidth: number,
  textureHeight: number,
  canvasWidth: number,
  canvasHeight: number
): FullscreenImageFit {
  const scale = textureWidth > 0 && canvasWidth > 0 ? canvasWidth / textureWidth : 0
  const width = canvasWidth
  const height = textureHeight * scale
  const maxScrollY = Math.max(0, height - canvasHeight)
  return {
    width,
    height,
    x: 0,
    scrollable: maxScrollY > 0,
    maxScrollY,
  }
}

/**
 * `computeFullscreenImageFit` の `maxScrollY` へスクロールオフセットをクランプする純粋関数 (#530)。
 * 負のオフセット（上端を超える）・`maxScrollY` を超えるオフセット（下端を超える）の両方を
 * `[0, maxScrollY]` に収める。`maxScrollY <= 0`（スクロール不要）のときは常に 0 を返す。
 */
export function clampFullscreenImageScrollY(offsetY: number, maxScrollY: number): number {
  if (maxScrollY <= 0) return 0
  return Math.min(Math.max(offsetY, 0), maxScrollY)
}

/** `computeChoiceGridLayout` が返す 1 選択肢分の列・行・中心 X (#508)。 */
export interface ChoiceGridButtonPosition {
  /** 0-based 列インデックス（非グリッド時は常に 0）。 */
  col: number
  /** 0-based 行インデックス（非グリッド時は常に選択肢の index と同じ）。 */
  row: number
  /**
   * ボタン中心 X（px）。`isGrid=true` のときは列全体を area 内で中央寄せした実際の中心 X、
   * `isGrid=false` のときは `area.x + area.width / 2`（従来の縦一列と同じ、全ボタン共通）。
   */
  x: number
}

/** `computeChoiceGridLayout` の戻り値 (#508)。 */
export interface ChoiceGridLayout {
  /** 正規化済みの列数（`Math.max(1, Math.floor(columns ?? 1))`。1 以上の整数）。 */
  columns: number
  /** `columns > 1` のときだけ true。false は従来どおりの縦一列（非グリッド）。 */
  isGrid: boolean
  /** 行数。グリッド時は `Math.ceil(count / columns)`、非グリッド時は `count` と同じ。 */
  rows: number
  /**
   * グリッド時のボタン幅（利用可能幅ちょうどに `columns` 列を敷き詰めた1ボタン幅を
   * `buttonWidthMax` で上限クランプした値）。非グリッド時は `buttonWidthMax` をそのまま返すが、
   * 呼び出し側が split_layout 領域向けの別クランプ（`CHOICE_REGION_MIN_BUTTON_WIDTH` 等）を
   * 適用する場合はこの値を使わず自前で計算してよい（ChoiceOverlay.show がそうしている）。
   */
  buttonWidth: number
  /** 選択肢 index（0-based）順の列・行・中心 X。 */
  positions: ChoiceGridButtonPosition[]
}

/**
 * `[選択: 列=N]`（#508）のグリッド配置ジオメトリ（列・行の割付、ボタン幅の fitWidth 計算、
 * 列全体を area 内で中央寄せする開始 X）を算出する純粋関数。
 *
 * 元は `ChoiceOverlay.show()` 内に直書きされていたロジック。`ChoiceOverlay` は PixiJS の
 * Container/Graphics/Text を組み立てる責務に専念し、幾何計算はここに集約する
 * （dev-doctrine 規約4: レンダラ本体に計算ロジックを直書きしない）。
 *
 * 引数:
 *  - `columns`: 脚本 `[選択: 列=N]` の N（未指定/null/undefined は 1 扱い＝非グリッド）。
 *  - `count`: 選択肢の総数。
 *  - `area`: レイアウト領域（`ChoiceOverlay` では split_layout region または画面全体）。
 *  - `buttonWidthMax`: ボタン幅の上限（`ChoiceOverlay.BUTTON_WIDTH`）。
 *  - `columnGap`: 列間ギャップ（`ChoiceOverlay.GRID_COLUMN_GAP`）。
 *  - `horizontalMargin`: area 端からの安全マージン（`ChoiceOverlay.GRID_HORIZONTAL_MARGIN`）。
 *
 * 非グリッド時（`columns` が未指定/1 以下）は `isGrid=false` を返し、`buttonWidth` は
 * `buttonWidthMax` のまま・`positions` は全て `col=0`, `row=index`, `x=area.x + area.width/2`
 * になる（従来の縦一列と完全に同じ結果。ChoiceOverlay 側の split_layout 用ボタン幅クランプは
 * 呼び出し側が別途適用する）。
 *
 * グリッド時（`columns > 1`）:
 *  - `fitWidth` = 利用可能幅（`area.width - horizontalMargin * 2`）ちょうどに `columns` 列を
 *    敷き詰めたときの1ボタン幅。`buttonWidth = Math.min(buttonWidthMax, fitWidth)`
 *    （下限クランプはしない。#508 実バグ: 下限を先に適用すると列数が多いケースではみ出していた）。
 *  - 列全体の幅 `columns * buttonWidth + (columns - 1) * columnGap` を area 内で中央寄せした
 *    開始 X から、`col * (buttonWidth + columnGap)` ずつ右にずらした位置がボタン中心 X。
 *  - `col = index % columns`, `row = Math.floor(index / columns)`（左上から行優先で敷き詰め、
 *    余った選択肢は最終行に左詰め）。
 *
 * Y 座標（行の縦位置）はスクロール可否や `BUTTON_HEIGHT`/`BUTTON_GAP` など呼び出し側の
 * 事情と絡むため、ここでは `row` のみ返し、Y の実値計算は呼び出し側に委ねる。
 * Math.random など非決定要素は使わない決定論的写像。
 */
export function computeChoiceGridLayout(
  columns: number | null | undefined,
  count: number,
  area: LayoutRect,
  buttonWidthMax: number,
  columnGap: number,
  horizontalMargin: number
): ChoiceGridLayout {
  const gridColumns = Math.max(1, Math.floor(columns ?? 1))
  const isGrid = gridColumns > 1
  const rows = isGrid ? Math.ceil(count / gridColumns) : count

  let buttonWidth = buttonWidthMax
  if (isGrid) {
    const availableWidth = area.width - horizontalMargin * 2
    const gapTotal = (gridColumns - 1) * columnGap
    const fitWidth = Math.max(1, Math.floor((availableWidth - gapTotal) / gridColumns))
    buttonWidth = Math.min(buttonWidthMax, fitWidth)
  }

  const gridRowWidth = gridColumns * buttonWidth + (gridColumns - 1) * columnGap
  const gridStartX = area.x + (area.width - gridRowWidth) / 2

  const positions: ChoiceGridButtonPosition[] = Array.from({ length: count }, (_, i) => {
    const col = isGrid ? i % gridColumns : 0
    const row = isGrid ? Math.floor(i / gridColumns) : i
    const x = isGrid
      ? gridStartX + col * (buttonWidth + columnGap) + buttonWidth / 2
      : area.x + area.width / 2
    return { col, row, x }
  })

  return { columns: gridColumns, isGrid, rows, buttonWidth, positions }
}

/** `computeChoiceIconLayout` の戻り値 (#598)。ボタン中心を基準にした縦位置 (px)。 */
export interface ChoiceIconLayout {
  /** アイコン sprite の中心 Y（`hasIcon=false` のときは未使用の値、呼び出し側は描画しない）。 */
  iconY: number
  /** ラベル Text の中心 Y。`hasIcon=false` のときは従来どおりボタン中心（非破壊）。 */
  textY: number
}

/**
 * 選択肢ボタン内で、アイコン（既読=完了 `assets/images/read-icon.webp` / 未読
 * `assets/images/unread-icon.webp`、#598）とラベルテキストの縦位置を算出する純粋関数。
 * どちらのアイコンも同じサイズ・同じレイアウトを使うため、呼び出し側が選んだテクスチャの
 * 種類はこの関数の関知するところではない（`hasIcon` は「今回アイコンを描画するか」だけを表す）。
 * アイコンをテキストの上に置き、2つを合わせた塊をボタン中心を軸に概算的に上下対称へ配置する
 * （`iconY`/`textY` はどちらもボタン中心から `iconSize` の half-extent 分だけ離れた位置。
 * テキスト側も同じ offset を使う近似であり、実際のテキスト高さは見ていない——fontSize は
 * 20-22px、`iconSize`（`ICON_SIZE`）は 18px のため数 px 程度の誤差があり、真の光学的対称
 * ではない）。
 *
 * `hasIcon=false`（対応するテクスチャの未読み込み/取得失敗などで今回アイコンを描画しない）のときは、
 * `iconY`/`textY` とも `buttonHeight / 2` を返す——#591 以来の「ラベルをボタン中心に
 * 一点センタリング」という既存レイアウトと完全に同じ結果になる（非破壊）。
 *
 * `buttonHeight` は呼び出し側 (`ChoiceOverlay`) がアイコン表示時用に嵩上げした値
 * （`layoutButtonHeight`）を渡す想定——アイコン＋テキストがボタン枠内に収まるかどうかの
 * 判断・調整は呼び出し側の責務で、この関数は与えられた `buttonHeight` の中で対称配置する
 * だけの幾何計算に専念する。
 */
export function computeChoiceIconLayout(
  buttonHeight: number,
  hasIcon: boolean,
  iconSize: number,
  iconTextGap: number
): ChoiceIconLayout {
  const center = buttonHeight / 2
  if (!hasIcon) {
    return { iconY: center, textY: center }
  }
  const offset = (iconSize + iconTextGap) / 2
  return { iconY: center - offset, textY: center + offset }
}

/** `resolveChoiceIconKind` の戻り値 (#598 追記3 / #604)。表示すべきアイコンの種類。
 * `'none'` は #604 で `locked` 引数が削除されたのに伴い、`resolveChoiceIconKind` が
 * 返し得なくなったため削除した（cleared の真偽だけで 'read'/'unread' のどちらかに必ず
 * 定まる）。この型を使うのは `resolveChoiceIconKind` の戻り値だけで、他に 'none' 相当の
 * 状態を表す用途は無い。 */
export type ChoiceIconKind = 'read' | 'unread'

/**
 * 選択肢ボタン1件に表示すべきアイコンの種類を判定する純粋関数 (#598 追記3 / #604 訂正)。
 *
 * 「ロック」と「既読/完了」は独立した2軸の状態である（ロック＝読むことすらできない、
 * 既読/完了＝読めるようになった後に読んだかどうか）。#604 で判明した誤り：ロックは
 * 「読むことすらできない」だけであって「未読でない」わけではない。ロック中の選択肢も
 * 当然「未読」ではあるので、`locked` はアイコン種別の判定に一切関与しない。
 * `cleared` のみで決まる（配色側の `resolveChoiceVisual` の locked > cleared > alreadyRead
 * > 通常という優先順位とは別軸の判定であり、`alreadyRead` もここでは一切参照しない）：
 *
 * - `cleared === true` → `'read'`（既読/完了。`read-icon.webp`。ロック中でも同じ）
 * - `cleared === false` → `'unread'`（未読。`alreadyRead` の真偽に関わらず `unread-icon.webp`。ロック中でも同じ）
 *
 * ロックの見た目（暗い配色・クリック不可）は `resolveChoiceVisual` 側で別途表現する。
 * 実際に描画するかどうか（対応するテクスチャの先読みに成功しているか）は呼び出し側
 * （`ChoiceOverlay`）の責務。この関数は「本来どちらを見せるべきか」という論理だけを返す。
 */
export function resolveChoiceIconKind(cleared: boolean): ChoiceIconKind {
  return cleared ? 'read' : 'unread'
}

/**
 * CSS カラー文字列（"#1a4a7a" / "#222" / "1a4a7a"）を Pixi の数値カラーに変換する純粋関数 (#270 / #273)。
 *
 * 元は `underline.ts` にあったものを、色解決の純関数置き場であるこのモジュールへ集約した
 * （`parseHexColor` の隣）。下線ビーム（#270）・タイトル文字色（#273）・背景色（#273）が共有する。
 * `underline.ts` は後方互換のためここから re-export する。
 *
 * `parseHexColor` との違い:
 *  - 3 桁短縮形（#222 → #222222）を展開する。
 *  - 純 hex（`[0-9a-fA-F]`）以外（`+1a4a7` 等の符号付き）は fallback に倒す。
 *  - fallback を任意指定できる（`parseHexColor` は白固定）。
 *  - `undefined` を受けたら fallback を返す（「指定なし」を呼び出し側でハンドルしやすい）。
 *
 * 解釈不能なら `fallback` を返す。Math.random など非決定要素は使わない。
 */
export function parseColorToNumber(color: string | undefined, fallback: number): number {
  if (color === undefined) return fallback
  let s = color.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 3) {
    // #rgb → #rrggbb
    s = s
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (s.length !== 6) return fallback
  // 純粋 hex 16 進数のみ受理する。Number.parseInt は '+1a4a7'/'-1a4a7' のような符号付き
  // 文字列を解釈してしまい fallback に倒れないため、parseInt 前に純 hex 判定で弾く。
  if (!/^[0-9a-fA-F]+$/.test(s)) return fallback
  const n = Number.parseInt(s, 16)
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback
  return n
}

/**
 * Pixi の数値カラー（`0xa8dadc` 等）を CSS カラー文字列（`#a8dadc`）に変換する純粋関数 (#601)。
 *
 * `parseColorToNumber` の逆方向。`SeekBar.DEFAULT_BAR_FILL_COLOR` のような数値定数を
 * `<input type="range">` の `accentColor`（CSS 文字列）にそのまま使うために用意した。
 * 0 未満・不正値は素直に `#000000` へクランプする（呼び出し側は定数を渡す想定で異常系は薄い）。
 *
 * NaN 防御 (#601 セルフレビュー nit1): NaN は `Number.isNaN` で明示的に検出して 0 に倒す
 * （`Math.floor(NaN)` は NaN のままで、後続の `Math.min`/`Math.max` も NaN を素通しするため、
 * ガードなしでは `"#NaN"` のような壊れた文字列になる）。`Infinity`/`-Infinity` は NaN ではない
 * ので Math.floor→Math.min/Math.max のクランプにそのまま乗せてよく、自然に上限 `0xffffff`
 * （Infinity）・下限 `0`（-Infinity）へ丸まる（novelLayout.test.ts 参照）。
 */
export function numberToHexColor(color: number): string {
  const safeColor = Number.isNaN(color) ? 0 : Math.floor(color)
  const clamped = Math.max(0, Math.min(0xffffff, safeColor))
  return `#${clamped.toString(16).padStart(6, '0')}`
}

// 操作ボタン（A/S/D）の ON 時色の fallback (#605)。seekbar_color 未設定プロジェクトでは
// これまで通り Tailwind の bg-blue-500 / bg-green-500 / bg-cyan-500 相当の見た目にする。
// このリポは Tailwind v4（oklch ベース）で、v3 の記憶値（#3b82f6 等）とは実際の RGB が異なる
// （#601 の RPGPlayer 事故の再発防止）ため、実機 DevTools（getComputedStyle + canvas 2D
// ラスタライズで oklch/oklab を実 sRGB へ変換）で実測した値をそのまま定数化している。
//
// NovelPlayer.tsx（利用側）ではなくこのゲームロジック層に置く理由: novelLayout.test.ts は
// pure logic のテストで、コンポーネント（.tsx）を import させたくない（layer 逆転を避ける）。
// テスト側の期待値もこの定数から導出させることで、fallback 値変更時にテストが自動追従する
// （手書きハードコード重複の禁止。#605 セルフレビュー指摘）。NovelPlayer.tsx / 各テストは
// いずれもここから直接 import する。
export const AUTO_BUTTON_FALLBACK_COLOR = 0x2b7fff // bg-blue-500 実測値
export const SKIP_BUTTON_FALLBACK_COLOR = 0x00c950 // bg-green-500 実測値
export const DEBUG_BUTTON_FALLBACK_COLOR = 0x00b8db // bg-cyan-500 実測値

/**
 * NovelPlayer の操作ボタン（オート/スキップ/デバッグ、A/S/D）の ON 時背景色を解決する純粋関数 (#605)。
 *
 * `parseColorToNumber` + `numberToHexColor` の合成。`seekbarColor` が未設定/不正値なら
 * `fallback`（各ボタンの既存 Tailwind 固定色を実機 DevTools で実測した数値）にそのまま倒れ、
 * seekbar_color 未設定プロジェクトの見た目を変えない（非回帰）。3 ボタンで色決定ロジックを
 * 共通化するためのヘルパー（#601 の `SettingsOverlay.tsx` `sliderAccentColor` と同じパターン）。
 * alpha（ON 時 80%/hover 100%）は呼び出し側の CSS が担当し、ここでは 6 桁 hex のみを返す。
 */
export function resolveActionButtonColor(
  seekbarColor: string | null | undefined,
  fallback: number
): string {
  return numberToHexColor(parseColorToNumber(seekbarColor ?? undefined, fallback))
}

/** 2D レイアウト位置の比率（screenWidth/Height に掛ける）。 */
export interface LayoutPosition {
  /** 横位置の比率（sprite 中心 x = screenWidth * xRatio）。 */
  xRatio: number
  /** 縦位置の比率（sprite 中心 y = screenHeight * yRatio）。 */
  yRatio: number
}

/**
 * 縦トークンの yRatio テーブル (#274)。
 * `上`=0.16 / `中上`=0.34 / `中`=0.5 / `中下`=0.64 / `下`=0.84。
 * opening.html の avatar→肩書→名前→タイトルの縦スタックを再現できる刻み。
 */
const VERTICAL_RATIO: Record<string, number> = {
  上: 0.16,
  中上: 0.34,
  中: 0.5,
  中下: 0.64,
  下: 0.84,
  // 英語 alias（最小限）。
  top: 0.16,
  upper: 0.34,
  center: 0.5,
  middle: 0.5,
  lower: 0.64,
  bottom: 0.84,
}

/**
 * 横トークンの xRatio テーブル (#274)。
 * `左`=0.1875 / `中央`=0.5 / `右`=0.8125（CHARACTER_X_RATIO と同値で立ち絵と揃える）。
 */
const HORIZONTAL_RATIO: Record<string, number> = {
  左: 0.1875,
  中央: 0.5,
  右: 0.8125,
  left: 0.1875,
  center: 0.5,
  right: 0.8125,
}

/**
 * `[ラベル]` / `[画像]` / `[タイトル]` 用の 2D 位置を比率で解決する純粋関数 (#274)。
 *
 * label/image/title は立ち絵（横位置のみの `normalizePosition`）と違い、opening.html の
 * 縦スタックを再現するため縦位置を効かせたい。縦トークン（上/中上/中/中下/下）と横トークン
 * （左/中央/右）を結合して解釈する:
 *   - `中上` → (x=0.5, y=0.34)
 *   - `左下` → (x=0.1875, y=0.84)
 *   - `中`   → (0.5, 0.5)
 *   - `上`   → (0.5, 0.16)  // 縦のみ指定は横は中央
 *   - `左`   → (0.1875, 0.5) // 横のみ指定は縦は中央
 * 結合は「縦トークンが先・横トークンが後」でも「横が先」でも両対応する（部分文字列で判定）。
 * 英語 alias（top/upper/center/middle/lower/bottom/left/right）も最小限受ける。
 * 未知/空 → center (0.5, 0.5)。
 *
 * 既存の `normalizePosition`（横のみ・立ち絵用）は壊さず、これは別関数として併存する。
 * Math.random など非決定要素は使わない（決定論的写像）。
 */
export function resolveLayoutPosition(position: string | undefined): LayoutPosition {
  const DEFAULT: LayoutPosition = { xRatio: 0.5, yRatio: 0.5 }
  if (!position) return DEFAULT
  const token = position.trim()
  if (token.length === 0) return DEFAULT

  // 1) 完全一致を先に試す（`中` を「中上」等の部分一致より優先するため）。
  // own-property のみ見る (#368)。`in` 演算子は Object.prototype も辿ってしまい、脚本側の
  // 自由記述である token が `constructor` 等と一致すると `token in VERTICAL_RATIO` が
  // 誤って true になり、後続の `VERTICAL_RATIO[token]` が関数オブジェクトを返してしまう。
  const inVertical = hasOwn(VERTICAL_RATIO, token)
  const inHorizontal = hasOwn(HORIZONTAL_RATIO, token)
  if (inVertical && inHorizontal) {
    // 同一トークンが両表に存在することは無い（語彙が排他）。保険として縦優先。
    return { xRatio: 0.5, yRatio: VERTICAL_RATIO[token] }
  }
  if (inVertical) {
    return { xRatio: 0.5, yRatio: VERTICAL_RATIO[token] }
  }
  if (inHorizontal) {
    return { xRatio: HORIZONTAL_RATIO[token], yRatio: 0.5 }
  }

  // 2) 結合トークン（`中上` / `左下` / `右中` 等）を部分文字列で分解する。
  //    縦・横を独立に拾い、片方しか見つからなければ他方は中央にフォールバックする。
  let yRatio: number | undefined
  let xRatio: number | undefined
  // 縦トークン（日本語）を長い順（中上/中下 を 中 より先）に探す。
  for (const key of ['中上', '中下', '上', '下', '中']) {
    if (token.includes(key)) {
      yRatio = VERTICAL_RATIO[key]
      break
    }
  }
  // 横トークン（日本語）。`中央` を `中` と衝突させないため `中央` を先に探す。
  for (const key of ['左', '中央', '右']) {
    if (token.includes(key)) {
      xRatio = HORIZONTAL_RATIO[key]
      break
    }
  }
  if (yRatio === undefined && xRatio === undefined) return DEFAULT
  return { xRatio: xRatio ?? 0.5, yRatio: yRatio ?? 0.5 }
}

/**
 * 2D 位置をトークン解釈し、数値 `x`/`y`（0..1 の比率）が指定されていれば**そちらを優先**する純関数 (#275)。
 *
 * `resolveLayoutPosition(position)` でトークン由来の比率を出してから、`x`/`y` の数値 override を
 * 軸ごとに被せる。テンプレ（closing.html）の install-line のように `位置=中下` の刻みでは届かない
 * 厳密配置（`x=0.36, y=0.62`）を必要とする要素のために用意する。
 *
 * override の採用条件（軸ごとに独立判定）:
 *  - `undefined` → トークン由来の比率を使う（override なし）。
 *  - 有限数 かつ 0..1（両端含む）→ その値を使う。
 *  - それ以外（NaN / Infinity / 範囲外）→ 無視してトークン由来の比率に**フォールバック**する。
 *
 * 軸独立なので「`x` だけ override・`y` はトークン」も成立する。Math.random など非決定要素は使わない。
 */
export function resolvePositionWithOverride(
  position: string | undefined,
  x: number | undefined,
  y: number | undefined
): LayoutPosition {
  const base = resolveLayoutPosition(position)
  const xRatio = isValidRatio(x) ? x : base.xRatio
  const yRatio = isValidRatio(y) ? y : base.yRatio
  return { xRatio, yRatio }
}

/** override 比率が採用条件（有限数・0..1）を満たすかの述語 (#275)。型ガードで number に絞る。 */
function isValidRatio(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1
}

/** アセット URL の種別。`images/` か `sounds/` のサブディレクトリに対応する。 */
export type AssetKind = 'images' | 'sounds'

/**
 * アセットの相対パスを配信用の絶対 URL に解決する純粋関数。
 *
 * 元 NovelRenderer 内に 5 箇所直書きされていた式を 1 つに集約:
 *   `${baseUrl}/${kind}/${path.replace(/^\//, '')}`
 * 背景画像（images）と BGM/SE/voice/復元 BGM（sounds）で同形だった。
 *
 * `path.replace(/^\//, '')` は path 先頭の '/' を 1 つだけ落とす（`/bgm/a.mp3` →
 * `bgm/a.mp3`）。baseUrl と kind の間・kind と path の間は常に '/' 1 つで連結する。
 * baseUrl 末尾の '/' 正規化はしない（元実装どおり。呼び出し側は baseUrl を末尾スラッシュ
 * なしで渡す前提）。
 */
export function resolveAssetUrl(baseUrl: string, kind: AssetKind, path: string): string {
  return `${baseUrl}/${kind}/${path.replace(/^\//, '')}`
}

/**
 * 立ち絵（拡張子を省略したキャラ画像）を配信 URL に解決する候補列を優先順で返す (#376)。
 *
 * エンジンは従来 `${base}/images/{path}/{expr}.png` と `.png` 固定で読み込んでいたが、
 * 2倍解像度 PNG が name-name-api の 1 MiB 安全上限を超えて 413 になる作品向けに、
 * **軽量 webp を先に試し、無ければ png にフォールバック**する。呼び出し側（CharacterLayer.loadTexture）は
 * 返った候補を先頭から Assets.load し、最初に成功した Texture を使う。
 *
 * - 拡張子なし（従来の立ち絵パス `char/expr`）→ `[.webp, .png]` の 2 候補。
 * - 既に `.webp` / `.png` が付いている（明示指定）→ その 1 本だけ（`.png.png` のような多重拡張子を避ける）。
 *
 * 背景・単独画像・portrait は呼び出し側が拡張子を明記するのでここは通らない（それらは resolveAssetUrl を直接使う）。
 */
export function resolveCharacterImageUrls(baseUrl: string, cleanPath: string): string[] {
  const lower = cleanPath.toLowerCase()
  if (lower.endsWith('.webp') || lower.endsWith('.png')) {
    return [resolveAssetUrl(baseUrl, 'images', cleanPath)]
  }
  return [
    resolveAssetUrl(baseUrl, 'images', `${cleanPath}.webp`),
    resolveAssetUrl(baseUrl, 'images', `${cleanPath}.png`),
  ]
}

/**
 * ページ送りインジケータ（▼/❯ の代替となる pen 風 4 フレーム連番画像）の種別 (#292)。
 *  - `next`     : 同ページにまだ続く文がある（次は文の送り）。
 *  - `pageturn` : そのページの最後の文（クリックでページを離れる＝次ページ or 次イベント）。
 * DialogBox（本体ロード）と NovelPlayer（先読み #413）の両方が参照する。
 */
export type IndicatorKind = 'next' | 'pageturn'

/**
 * インジケータ画像の相対パス一覧 (#292)。next=`ui/text-next-{1..4}.webp` /
 * pageturn=`ui/page-turn-{1..4}.webp`。`getIndicatorImageUrls` の唯一の情報源。
 * DialogBox.loadIndicatorFrames と NovelPlayer の先読み（#413: renderer.init() を待たない
 * early fetch）が同じ一覧を参照することで、パス一覧の重複・食い違いを避ける（doctrine 規律4）。
 */
const INDICATOR_IMAGE_PATHS: Record<IndicatorKind, string[]> = {
  next: [
    'ui/text-next-1.webp',
    'ui/text-next-2.webp',
    'ui/text-next-3.webp',
    'ui/text-next-4.webp',
  ],
  pageturn: [
    'ui/page-turn-1.webp',
    'ui/page-turn-2.webp',
    'ui/page-turn-3.webp',
    'ui/page-turn-4.webp',
  ],
}

/**
 * インジケータ 1 種別分の画像フレーム URL 一覧を配信用の絶対 URL に解決する純粋関数 (#413)。
 *
 * `INDICATOR_IMAGE_PATHS[kind]` を `resolveAssetUrl(baseUrl, 'images', path)` で URL 化するだけ。
 * DialogBox.loadIndicatorFrames（本体ロード）と NovelPlayer（mount 時／assetBaseUrl 確定時の
 * 早期先読み）の両方がこの 1 関数を呼ぶ。PixiJS の `Assets.load()` は同一 URL キーに対して
 * in-flight/解決済みの Promise をキャッシュ共有するため、先に先読みが同じ URL を要求しておけば
 * 後段の DialogBox 側の読み込みは実質即解決になる。
 */
export function getIndicatorImageUrls(baseUrl: string, kind: IndicatorKind): string[] {
  return INDICATOR_IMAGE_PATHS[kind].map((path) => resolveAssetUrl(baseUrl, 'images', path))
}

/**
 * セーブスロットデータ (`SaveSlotData`) を復元用の `NovelGameState` に変換する純粋関数。
 *
 * 元 `NovelRenderer.loadFromSaveData` 内に直書きされていた state 構築ブロックと同一の
 * フィールド対応・後方互換フォールバックを集約する:
 *   sceneId        = data.sceneId（呼び出し側で非 null を保証してから渡す）
 *   eventIndex     = data.eventIndex
 *   textIndex      = data.textIndex
 *   sentenceIndex  = data.sentenceIndex ?? 0  // 古いセーブには無い → ページ先頭 (#292)
 *   flags          = data.flags
 *   backgroundPath = data.backgroundPath
 *   backgroundColor = data.backgroundColor ?? null  // 古いセーブには無い → 地色なし (#273)
 *   backgroundFade = normalizedFade（呼び出し側で normalizeBackgroundFade 済みを渡す）
 *   backgroundBrightness = data.backgroundBrightness ?? null  // 古いセーブには無い → 原画のまま
 *   video          = data.video ?? null      // 古いセーブには無い → 動画なし
 *   isBlackout     = data.isBlackout ?? false
 *   characters     = data.characters ?? []
 *   currentBgmPath = data.currentBgmPath ?? null
 *   storyEnded     = false  // SaveSlotData 未対応 (#386)。セーブ/ロードは常に「終劇していない」扱い
 *
 * `backgroundFade` の正規化（`normalizeBackgroundFade` / `edgeFadeMask`）は PixiJS を間接
 * 参照するため、このモジュールを PixiJS 非依存に保つ目的で「正規化済みの値」を引数で受け取る。
 * これにより本関数は `data` の読み取りと定数フォールバックだけの純粋写像になる。
 *
 * `data.sceneId` は型上 `string | null` だが、呼び出し側（`loadFromSaveData`）が null を
 * 早期 return で弾いた後に呼ぶ前提。元実装も同じ前提で `state.sceneId = data.sceneId`
 * としていたため、ここでもそのまま代入する（挙動不変）。
 */
export function saveSlotToGameState(
  data: SaveSlotData,
  normalizedFade: BackgroundFade | null
): NovelGameState {
  return {
    sceneId: data.sceneId,
    eventIndex: data.eventIndex,
    textIndex: data.textIndex,
    // novel の現ページ内文インデックス (#292)。古いセーブには無い → ?? 0（ページ先頭）に倒す。
    sentenceIndex: data.sentenceIndex ?? 0,
    flags: data.flags,
    backgroundPath: data.backgroundPath,
    backgroundColor: data.backgroundColor ?? null,
    backgroundFade: normalizedFade,
    // 背景の明るさ。古いセーブには無い → ?? null で原画のまま（tint=白）に倒す。
    backgroundBrightness: data.backgroundBrightness ?? null,
    video: data.video ?? null,
    // イベント絵レイヤー (#351)。古いセーブには無い → ?? null（イベント絵なし）に倒す。
    eventImage: data.eventImage ?? null,
    isBlackout: data.isBlackout ?? false,
    characters: data.characters ?? [],
    currentBgmPath: data.currentBgmPath ?? null,
    // 終劇状態 (#386) はセーブデータに持たせない（SaveSlotData 未対応・古いセーブにも無い）。
    // quicksave/quickload・スロット保存はすべて「終劇していない」状態として復元する。
    storyEnded: false,
  }
}

/**
 * フォント解決の優先順チェーンを 1 箇所に集約する純粋関数 (#147 / #260)。
 *
 * 元 NovelRenderer 内で 2 箇所に直書きされていた同形の式:
 *   - `render()`:      `perLineFontFamily ?? this.gameDefaultFontFamily ?? RUNTIME_DEFAULT_FONT_FAMILY`
 *   - `processDirective()` の `TitleShow`:
 *                      `ts.font_family ?? this.gameDefaultFontFamily ?? RUNTIME_DEFAULT_FONT_FAMILY`
 * どちらも「per-line override → per-game default → runtime default」の同じ 3 段フォールバック。
 *
 * `??`（nullish coalescing）の元挙動を忠実に踏襲する:
 *  - `perLine` が `null`/`undefined` のときだけ `perGameDefault` に落ちる。
 *  - `perGameDefault` も `null`/`undefined` のときだけ `runtimeDefault` に落ちる。
 *  - 空文字 `''` は「指定あり」として扱う（`??` は `''` を素通しする。元実装と同じ）。
 *
 * 引数は `string | null | undefined` を受けるが、`runtimeDefault` は必ず非 null の文字列を
 * 渡す前提（元実装の `RUNTIME_DEFAULT_FONT_FAMILY` 定数）。戻り値は常に非 null の family 文字列。
 */
export function resolveFontFamily(
  perLine: string | null | undefined,
  perGameDefault: string | null | undefined,
  runtimeDefault: string
): string {
  return perLine ?? perGameDefault ?? runtimeDefault
}

/**
 * per-game フェード時間 (ms) のパース・クランプ純粋関数 (#407 / #404)。
 *
 * `NovelRenderer.setBackgroundFadeMs`（frontmatter `background_fade_ms:`）と
 * `CharacterLayer.setCharacterFadeMs`（frontmatter `character_fade_ms:`）が同じ規則
 * （null/undefined/非有限は既定へフォールバック、範囲外は [min, max] にクランプ）を
 * 個別実装していたのをここに集約する。intermission.md 用のフェード時間（#404、既定が
 * 700ms ではなく別値）もこの関数を共有する — 既定値だけが違うだけで規則は同じため。
 */
export function clampFadeMs(
  ms: number | null | undefined,
  fallbackMs: number,
  min = 0,
  max = 5_000
): number {
  return ms == null || !Number.isFinite(ms)
    ? fallbackMs
    : Math.min(max, Math.max(min, Math.floor(ms)))
}

/**
 * シーンカウンターの表示文字列を返す純粋関数 (#260)。
 *
 * 元 `NovelRenderer.updateCounter` の `this.counterText.text = \`${displayIndex} / ${this.displayEventCount}\``
 * と同一のテンプレートリテラル。`displayIndex`（1-based 現在位置）と `total`（表示イベント総数）を
 * `"{displayIndex} / {total}"` に整形するだけ。数値の書式変換（ロケール・桁区切り等）は一切しない。
 */
export function formatCounterText(displayIndex: number, total: number): string {
  return `${displayIndex} / ${total}`
}

/** SeekBar.update に渡す現在位置と総数。 */
export interface SeekBarPosition {
  /** SeekBar.update の第 1 引数 `current`（0-based。ratio = current/(total-1) で塗り幅を出す） */
  current: number
  /** SeekBar.update の第 2 引数 `total`（表示イベント総数） */
  total: number
}

/**
 * SeekBar に渡す `{current, total}` を算出する純粋関数 (#125 / #260)。
 *
 * 元 `NovelRenderer.updateSeekBar` と同一:
 *   current = Math.max(0, displayIndex - 1)   // 1-based displayIndex を 0-based に変換
 *   total   = displayEventCount
 * SeekBar 側は `ratio = current / (total - 1)` で塗り幅を出すため、`displayIndex` を
 * 1-based のまま渡すと末尾で ratio が 1 を超える。ここで 1 を引いて 0-based に直し、
 * 先頭（displayIndex=0、まだテキスト未到達）でも負にならないよう `Math.max(0, …)` でクランプする。
 */
export function computeSeekBarPosition(displayIndex: number, total: number): SeekBarPosition {
  return { current: Math.max(0, displayIndex - 1), total }
}

// ---------------------------------------------------------------------------
// 下部丸ボタン + SeekBar の共有レイアウト定数 (#350)
// ---------------------------------------------------------------------------

/**
 * play 画面下部の丸ボタン（S/A/⚙/D）と SeekBar（シナリオスライダ）の縦位置を**同じ定数から**導く
 * ための共有レイアウト値 (#350)。
 *
 * 目的: つまみ中心を丸ボタンの中央を貫く高さに上げ、「ボタンが手前・スライダが背面でボタンの円を
 * 貫くライン」に見せる。NovelPlayer（DOM 丸ボタン）と SeekBar（Pixi キャンバス内）の双方がこの
 * 定数を参照するため、片方を変えてももう片方が揃う（doctrine: テスト陳腐化予防＝期待値に
 * `12 + 36/2` のような定数計算を直書きしない）。
 *
 * px は NovelPlayer の Tailwind クラス（`bottom-3`=12px / `right-3`=12px / `w-9 h-9`=36px /
 * スロット間隔=ボタン幅 36 + 余白 8 = 44px）と一致させてある。
 */
/** 下部丸ボタンの直径（px）。Tailwind `w-9 h-9` = 2.25rem = 36px と一致。 */
export const PLAYER_BUTTON_SIZE_PX = 36
/** 下部丸ボタンの画面下端からのマージン（px）。Tailwind `bottom-3` = 0.75rem = 12px と一致。 */
export const PLAYER_BUTTON_BOTTOM_MARGIN_PX = 12
/** 下部丸ボタンの画面右端からのマージン（px）。スロット採番の基点。Tailwind `right-3` = 12px と一致。 */
export const PLAYER_BUTTON_RIGHT_MARGIN_PX = 12
/** 下部丸ボタンのスロット間隔（px）。ボタン幅 36 + 余白 8。 */
export const PLAYER_BUTTON_SLOT_GAP_PX = 44

/**
 * 下部丸ボタンの中央 Y を「画面下端からのオフセット px」で表した値 (#350)。
 * = ボタン下端マージン + 半径。SeekBar のつまみ中心 Y をこの高さに合わせ、ボタンの円を貫くラインにする。
 * `PLAYER_BUTTON_BOTTOM_MARGIN_PX` / `PLAYER_BUTTON_SIZE_PX` を変えると自動で追従する。
 */
export const PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX =
  PLAYER_BUTTON_BOTTOM_MARGIN_PX + PLAYER_BUTTON_SIZE_PX / 2

/** SeekBar の幾何（px・論理座標）。`computeSeekBarGeometry` の戻り値。 */
export interface SeekBarGeometry {
  /** トラック左端 X（px） */
  barX: number
  /** トラック幅（px） */
  barWidth: number
  /** トラック（バー）の top Y（px） */
  barY: number
  /** つまみ中心 Y（px）。丸ボタン中央と一致する（#350） */
  thumbCenterY: number
}

/**
 * SeekBar のトラック矩形とつまみ中心 Y を算出する純粋関数 (#350)。
 *
 * つまみ中心 Y は `screenHeight - PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX`（＝丸ボタン中央）に合わせる。
 * トラック（バー）はその中心に縦中央で重ねる（`barY = thumbCenterY - barHeight/2`）。左右は
 * `marginX` で内側に寄せる。`marginX` / `barHeight` は SeekBar 側の見た目定数を引数で受け取り、
 * 縦位置（ボタン中央連動）だけをここで一元計算する。
 *
 * 旧実装（バー top = `screenHeight - 12`、つまみ中心 = `screenHeight - 9`）と違い、つまみが
 * 画面最下部ではなくボタン中央の高さに来る。Math.random など非決定要素は使わない決定論的写像。
 */
export function computeSeekBarGeometry(
  screenWidth: number,
  screenHeight: number,
  marginX: number,
  barHeight: number
): SeekBarGeometry {
  const thumbCenterY = screenHeight - PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX
  return {
    barX: marginX,
    barWidth: screenWidth - marginX * 2,
    barY: thumbCenterY - barHeight / 2,
    thumbCenterY,
  }
}

/** デバッグ HUD 用に 1 イベントから取り出した種別と本文プレビュー。 */
export interface DebugEventDescriptor {
  /** イベント種別。`Dialog` / `Background` 等のキー名。判定不能は `'(none)'` / `'(unknown)'` */
  kind: string
  /** 本文プレビュー。取り出せないときは `undefined` */
  text: string | undefined
}

/**
 * 1 つの `Event` からデバッグ HUD 用の `{kind, text}` を取り出す純粋関数 (#260)。
 *
 * 元 `NovelRenderer.getDebugState` 内に直書きされていた抽出ロジックと同一:
 *   - object でなければ `kind='(none)'`, `text=undefined`
 *   - object なら `kind = Object.keys(event)[0] ?? '(unknown)'`
 *   - その値 `v = event[kind]` が object のとき、本文を以下の優先順で 1 つ取り出す:
 *       1. `v.text` が長さ 1 以上の配列 → `JSON.stringify(v.text[0]).slice(0, 120)`
 *       2. `v.line` が string → そのまま
 *       3. `v.path` が string → そのまま
 *       4. `v.target` が string → そのまま
 *       いずれにも当たらなければ `text=undefined`
 *
 * `this` / PixiJS / DOM に触れず、入力イベントだけから決定論的に値を導く。HUD 表示専用で
 * ゲーム進行には影響しない。`text` は最大 120 文字に切り詰める元挙動（配列ケースのみ）を踏襲。
 *
 * 引数型を元の `Event` から `unknown` に広げているのは任意入力耐性のため（HUD デバッグ用途で
 * `resolvedEvents` 由来の想定外・不正形なイベントを渡されても落ちず `'(none)'`/`'(unknown)'`
 * に落とす）。内部でガードしてから読むため `unknown` でも安全。
 */
export function describeEventForDebug(event: unknown): DebugEventDescriptor {
  let kind = '(none)'
  let text: string | undefined
  if (event && typeof event === 'object') {
    kind = Object.keys(event)[0] ?? '(unknown)'
    const v = (event as Record<string, unknown>)[kind]
    if (v && typeof v === 'object') {
      const maybeText = (v as { text?: unknown; line?: unknown; path?: unknown; target?: unknown })
        .text
      if (Array.isArray(maybeText) && maybeText.length > 0)
        text = JSON.stringify(maybeText[0]).slice(0, 120)
      else if (typeof (v as { line?: unknown }).line === 'string')
        text = (v as { line: string }).line
      else if (typeof (v as { path?: unknown }).path === 'string')
        text = (v as { path: string }).path
      else if (typeof (v as { target?: unknown }).target === 'string')
        text = (v as { target: string }).target
    }
  }
  return { kind, text }
}

/**
 * シーン ID から該当シーンを線形探索する純粋関数 (#260)。
 *
 * 元 NovelRenderer 内に同形で複数箇所直書きされていた `this.allScenes.find((s) => s.id === id)`
 * を 1 つに集約する。具体的には以下の「シーン本体を引く」用途が同一の式だった:
 *   - `jumpToScene(sceneId)`:        `this.allScenes.find((s) => s.id === sceneId)`
 *   - `loadFromSaveData(data)`:      `this.allScenes.find((s) => s.id === data.sceneId)`
 *   - `startFrom(opts)`:             `this.allScenes.find((s) => s.id === opts.sceneId)`
 *   - `resolveSceneTitle` 内部:       title を引くための同じ scene ルックアップ
 *
 * 見つからなければ `Array.prototype.find` の素の挙動どおり `undefined` を返す（元実装と同じ。
 * 呼び出し側が `if (!scene)` で未発見時の分岐／警告／フォールバックを各自で行う前提）。
 * `===` による厳密一致で、先頭から最初に一致した 1 件を返す（重複 id は先勝ち）。
 * `this` / PixiJS / DOM / audio に一切触れない決定論的写像。
 */
export function findSceneById(scenes: EventScene[], sceneId: string): EventScene | undefined {
  return scenes.find((s) => s.id === sceneId)
}

/**
 * 現在のシーン ID からセーブ表示用のシーンタイトルを解決する純粋関数 (#260)。
 *
 * 元 NovelRenderer 内で `quickSave()` と `openSaveMenu()` の 2 箇所にバイト単位で重複していた式:
 *   `this.currentSceneId
 *      ? (this.allScenes.find((s) => s.id === this.currentSceneId)?.title ?? null)
 *      : null`
 * を 1 関数に集約する（`resolveAssetUrl` / `resolveFontFamily` と同じ「2 箇所以上の重複を集約」）。
 *
 * 段階を元実装どおり忠実に踏襲する:
 *  - `sceneId` が falsy（`null` / `undefined` / 空文字 `''`）なら、scene を引かずに即 `null`。
 *    元の `this.currentSceneId ? … : null` の三項を踏襲する（空文字も「シーン未確定」として `null`）。
 *  - scene が見つからなければ（`find` が `undefined`）`?.title` が `undefined` になり `?? null` で `null`。
 *  - scene の `title` が（型上はあり得ないが）`undefined`/`null` でも `?? null` で `null` に落とす。
 *  - それ以外は scene の `title` 文字列を返す。
 *
 * scene 本体の線形探索は `findSceneById` に委譲する（探索ロジックの一元化）。
 */
export function resolveSceneTitle(
  scenes: EventScene[],
  sceneId: string | null | undefined
): string | null {
  if (!sceneId) return null
  return findSceneById(scenes, sceneId)?.title ?? null
}

// ---------------------------------------------------------------------------
// novel スタイルの改頁ロジック (#283)
// ---------------------------------------------------------------------------

/**
 * 日本語の文末記号。文境界での改頁判定に使う (#283)。
 *
 * 句点・感嘆符・疑問符（全角/半角）に加え、それらの直後に続く閉じ括弧・閉じ引用符は
 * 同じ文の一部として扱う（`「…ですか？」` を `？` で割らず `」` まで含めて 1 文にする）。
 */
// 文末記号: 句点・感嘆符・疑問符（全角＋半角 !?）
const SENTENCE_TERMINATORS = '。！？!?'
// 文末記号の直後に同じ文へ取り込む閉じ括弧・閉じ引用符・読点
const SENTENCE_TRAILERS = '」』】〕〗〙）］｝〉》”’｠、，'
// 先頭ダッシュ (#374) を導く「括りの終わり」の閉じ括弧・閉じ引用符。SENTENCE_TRAILERS から
// 読点 `、，` を除いた集合（読点は句の途中なので `--` は文中扱いのまま）。SENTENCE_TRAILERS に
// 閉じ括弧を足せば自動追従する。
// 注意 (#374 レビュー): `’`(U+2019) は閉じ一重引用符だが英語アポストロフィも兼ねる。理論上
// `don’t--stop` がアポストロフィ後で先頭ダッシュ化するが、JA ノベル台本では発生せず既存
// SENTENCE_TRAILERS の分類を踏襲するため、あえて除外しない（実害なし・意識的に据え置き）。
const CLOSING_BRACKETS = Array.from(SENTENCE_TRAILERS)
  .filter((ch) => ch !== '、' && ch !== '，')
  .join('')

/**
 * 余韻横棒 `──`（U+2500 の連続）を文送り境界として扱うか判定する 1 文字述語 (#340)。
 *
 * 正準化パス（textCanonical.ts）が原稿 `--`（ASCII 2 連）を `──` へ置換済み。この中央罫線を
 * novel の文送り境界にする（#340 本題）。言いよどみ `⋯`（U+22EF）は境界にしないため対象外。
 */
function isMidlineRule(ch: string): boolean {
  return ch === MIDLINE_RULE
}

/**
 * 本文を文境界で分割する純粋関数 (#283 / #340 / #374)。
 *
 * 句点・感嘆符・疑問符を文末とみなし、直後に続く閉じ括弧・閉じ引用符（および句読点）は
 * その文に含める。加えて余韻横棒 `──`（U+2500 の連続、原稿 `--` の正準化後）も文送り境界とする。
 * 文末記号を持たない末尾の断片も 1 文として返す。改行（`\n`）は文の途中の改行として温存し、
 * 文境界とはしない（wordwrap が別途処理する）。
 *
 * `──` の帰属は直前の「括りの終わり」の有無で決まる (#374)。括りの終わり＝文末記号（`。！？!?`）
 * または閉じ括弧/閉じ引用符（`」』）…`。読点 `、` は含めない＝句の途中）:
 *  - **括りの終わりの直後の `──`（`。──` / `」──` 等）**＝「次のかたまりを導く先頭ダッシュ」。括りの
 *    終わりで切って `──` は**次の**表示単位の先頭に回す。例: `です。──それと` → `['です。', '──それと']`、
 *    `「お題」──本文` → `['「お題」', '──本文']`。`です。`／`「お題」`まで表示→クリック→`──…`が一気に
 *    出る自然な息継ぎにする（theo-hayami のフィードバック）。括りの終わりと `──` の間の空白（`。 ──`／
 *    `「お題」 ──`）は捨てず次単位の先頭空白として温存する。
 *  - **それ以外の `──`（直前が括りの終わりでない・文中）**＝従来どおり `──` の後で停止し、`──` は前の
 *    単位に含める (#340)。例: `私はこう見ている──在る` → `['私はこう見ている──', '在る']`、
 *    `A、──B` → `['A、──', 'B']`（読点は括りの終わりでない）。この場合は直後に文末記号が続けば
 *    `──。` として 1 停止にまとめる（二重に止まらない）。
 *
 * `？！` のような文末記号どうし（間に `──` を挟まない）は従来どおり別々に止める（#283 の回帰固定を
 * 維持）。`⋯`（U+22EF）は境界にしないため、`⋯⋯──` は `──` で 1 回、`⋯⋯。` は `。` で 1 回止まる。
 * `⋯⋯。──` は `。` で切って `──` が次の単位を導く (#374)。
 *
 * - 空文字・空白だけの入力は空配列 `[]` を返す。
 * - テキスト全体の先頭・末尾（外周）の余分な空白は関数冒頭で 1 回だけトリムするが、
 *   文と文の**境界**にある空白・改行はトリムせず温存する (#362)。`？`/`！` 直後の半角スペースは
 *   theo-hayami#12 で確定した演出情報であり、境界を跨いで連結（`joinSentences`）される際に
 *   消してはならない。判定（空文字かどうか）には `trim()` した値を使うが、push する値は
 *   常に untrimmed の `current` にする。
 *
 * @param text 本文（イベントの text 行を連結したもの。ルビ記法は stripRubyMarkup 済みを渡す想定）
 * @returns 文の配列（空要素は含まない）
 */
export function splitIntoSentences(text: string): string[] {
  // 外周だけ 1 回 trim する。文中・文境界の空白/改行は以降一切トリムしない (#362)。
  const outerTrimmed = text.trim()
  const sentences: string[] = []
  const chars = Array.from(outerTrimmed)
  const n = chars.length
  let current = ''

  const isTerminator = (ch: string) => SENTENCE_TERMINATORS.includes(ch)
  const isTrailer = (ch: string) => SENTENCE_TRAILERS.includes(ch)

  // 判定には trim() した値を使うが、push する値は untrimmed の current にする (#362)。
  // 文と文の境界にある空白・改行を落とさないため。
  const flush = () => {
    if (current.trim() !== '') sentences.push(current)
    current = ''
  }

  // 直後の閉じ括弧・閉じ引用符・句読点を同じ文へ取り込む。i を最後に吸収した位置へ進めて返す。
  const absorbTrailers = (i: number): number => {
    while (i + 1 < n && isTrailer(chars[i + 1])) {
      i++
      current += chars[i]
    }
    return i
  }

  // 連続する `──` を current に取り込み、末尾の index を返す (#340)。
  const absorbRuleRun = (i: number): number => {
    while (i + 1 < n && isMidlineRule(chars[i + 1])) {
      i++
      current += chars[i]
    }
    return i
  }

  // 文中 `──`（trailing）の後処理 (#340/#374): 直後の閉じ括弧トレーラを吸収し、さらに直後に
  // 文末記号が続けば `──。` として 1 停止にまとめる（そのトレーラも吸収）。文末記号側から `──` を
  // 吸収する向き（`。──`）は #374 で廃止し、先頭ダッシュ分岐で処理する。
  const absorbRuleTrail = (i: number): number => {
    i = absorbTrailers(i)
    if (i + 1 < n && isTerminator(chars[i + 1])) {
      i++
      current += chars[i]
      i = absorbTrailers(i)
    }
    return i
  }

  // runStart の `──` の直前（空白を飛ばした最後の実文字）が「括りの終わり」＝文末記号 or
  // 閉じ括弧/閉じ引用符か。true ならこの `──` は「次のかたまりを導く先頭ダッシュ」で、括りの終わりで
  // 切って `──` を次の単位の先頭に回す (#374)。読点 `、` は括りの終わりに含めない（文中扱い）。
  const precededByClauseEnd = (runStart: number): boolean => {
    let p = runStart - 1
    while (p >= 0 && /\s/.test(chars[p])) p--
    if (p < 0) return false
    return isTerminator(chars[p]) || CLOSING_BRACKETS.includes(chars[p])
  }

  for (let i = 0; i < n; i++) {
    const ch = chars[i]
    if (isMidlineRule(ch)) {
      if (precededByClauseEnd(i)) {
        // 先頭ダッシュ (#374): 括りの終わり（文末記号 or 閉じ括弧）で切り、この `──` を次の単位の
        // 先頭に置く。current を「末尾空白」と「それ以外の本文」に分け、本文を 1 単位として flush し、
        // 末尾空白は次単位の先頭空白として温存する:
        //  - 文末記号ケース（`。 ──`）: 本文は文末記号分岐で既に flush 済み → current は空白のみ or 空。
        //    本文 flush は no-op、空白だけが次単位の先頭に残る（#362/theo-hayami#12 の `？`/`！` 直後
        //    スペース保護を先頭ダッシュ経路でも守る。`flush()` で丸ごと捨てると空白が消える）。
        //  - 閉じ括弧ケース（`「…」──`）: `」` は flush されずに current に溜まっている → 本文 `「…」`
        //    をここで 1 単位として確定する。末尾空白（`「…」 ──`）は次単位の先頭に温存する。
        // ここでは停止せず、次の停止（括りの終わり or 文中 `──`）まで累積する。
        const trailingWs = (current.match(/\s*$/) as RegExpMatchArray)[0]
        current = current.slice(0, current.length - trailingWs.length)
        flush() // 本文（空でなければ）を確定。空白のみ/空なら no-op で current='' に。
        current = trailingWs + ch
        i = absorbRuleRun(i)
      } else {
        // 文中 `──`（trailing, #340）: `──`（連続分含む）の後で停止し、前の単位に含める。
        current += ch
        i = absorbRuleRun(i)
        i = absorbRuleTrail(i)
        flush()
      }
    } else if (isTerminator(ch)) {
      // 文末記号: 直後のトレーラを吸収して停止する。直後の `──` は吸収しない (#374)。
      // 文末記号どうし（`？！`）は間に `──` を挟まない限り別停止のまま（#283 回帰固定）。
      current += ch
      i = absorbTrailers(i)
      flush()
    } else {
      current += ch
    }
  }
  // 文末記号で終わらない末尾の断片も 1 文として拾う。判定は trim、push は untrimmed (#362)。
  if (current.trim() !== '') sentences.push(current)
  return sentences
}

/** 1 ページ分の改頁結果 (#283)。 */
export interface NovelPage {
  /** このページに含まれる文を結合した本文（wordwrap 前の plain text） */
  text: string
  /**
   * このページを構成する文の配列 (#292)。
   * 文単位送り（息継ぎ単位の novel 表示）で「累積表示テキスト」を組み立てるために使う。
   * `text` は `joinSentences(sentences)` の連結であり（後方互換）、`sentences.join('')`
   * を既定の連結関数で組むと `text` と一致する。
   */
  sentences: string[]
  /** このページが占有する wordwrap 後の行数（高さ算出のデバッグ・検証用） */
  lineCount: number
}

/**
 * 文ごとの wordwrap 行数の配列から、利用可能行数に収まるようページへ貪欲分割する純粋関数 (#283)。
 *
 * アルゴリズム（Issue #283 スコープ改訂より）:
 *  - 文を順に詰めていき、**次の文を入れると `maxLinesPerPage` を超える手前で改頁**する
 *    （= 改頁前の最後の文は必ずきりよく収まり、文の途中で切らない）。
 *  - 結果ページの行数は可変でよい（1 文でも複数文でも可）。下端まで機械的に詰めない
 *    （収まる範囲で文単位に切る）。
 *  - 1 文だけで `maxLinesPerPage` を超える場合は、その文を単独で 1 ページに置く
 *    （これ以上分割できないため。文途中改頁を避ける優先度が高い）。
 *
 * `joinSentences` で連結した本文を `NovelPage.text` に持たせる（呼び出し側が wordwrap して描画する）。
 * 加えて各ページを構成した文の配列を `NovelPage.sentences` に持たせる (#292)。文単位送りでは
 * `sentences.slice(0, k+1)` の累積テキストを wordwrap して 1 文ずつ表示する。
 *
 * `maxSentencesPerPage` (#448): frontmatter `sentence_per_page: true` 用の**追加の**制約。
 * 既定 `Infinity`（未指定）は従来どおり行数キャップだけで貪欲に複数文を詰める（非回帰）。
 * 有限値（実運用では 1）を渡すと、1 ページに置ける文の数をその上限に固定する — 行数キャップ
 * （オーバーフロー防止・常時 ON）はそのまま生きたまま、「文数」でも改頁するようになるだけで、
 * 上記の「1 文だけで cap を超える場合は単独ページ」安全策は変更・迂回しない（両方の条件を OR で
 * 判定するだけなので、どちらか一方が先に発火してもページ内容は同じになる）。
 *
 * @param sentences 文の配列（`splitIntoSentences` の結果）
 * @param sentenceLineCounts 各文を単独で wordwrap したときの行数（`sentences` と同じ長さ・1 以上）
 * @param maxLinesPerPage 1 ページに収まる最大行数（1 以上。利用可能高さ ÷ 行高 で算出）
 * @param joinSentences 同一ページ内の文を連結する関数（既定は素朴な空文字連結）
 * @param maxSentencesPerPage 1 ページに置ける文数の上限 (#448)。既定 `Infinity`（制約なし＝後方互換）
 * @returns ページ配列（各ページの text と占有行数）
 */
export function paginateSentencesByLines(
  sentences: string[],
  sentenceLineCounts: number[],
  maxLinesPerPage: number,
  joinSentences: (sentencesOnPage: string[]) => string = (s) => s.join(''),
  maxSentencesPerPage: number = Number.POSITIVE_INFINITY
): NovelPage[] {
  // maxLinesPerPage は 1 未満を許さない（0 だと 1 文も置けず無限ループになる）。
  const cap = Math.max(1, Math.floor(maxLinesPerPage))
  // maxSentencesPerPage も同様に 1 未満・非有限（NaN 等）を許さない。未指定/Infinity は無制限のまま。
  const sentenceCap =
    Number.isFinite(maxSentencesPerPage) && maxSentencesPerPage >= 1
      ? Math.floor(maxSentencesPerPage)
      : Number.POSITIVE_INFINITY
  const pages: NovelPage[] = []
  let pageSentences: string[] = []
  let pageLines = 0

  const flush = () => {
    if (pageSentences.length === 0) return
    // sentences はこのページを構成する文の配列 (#292)。文単位送りの累積テキスト組み立てに使う。
    // text は従来どおり joinSentences(sentences) の連結で後方互換を保つ。
    pages.push({
      text: joinSentences(pageSentences),
      sentences: pageSentences,
      lineCount: pageLines,
    })
    pageSentences = []
    pageLines = 0
  }

  for (let i = 0; i < sentences.length; i++) {
    // 行数情報が欠けている／非有限（undefined・NaN・Infinity）な場合は 1 行として扱う（防御的）。
    // NaN は `?? 1` をすり抜け Math.max/floor でも残り pageLines を汚染するため Number.isFinite で弾く。
    const rawLineCount = sentenceLineCounts[i]
    const lines = Number.isFinite(rawLineCount) ? Math.max(1, Math.floor(rawLineCount)) : 1
    if (
      pageSentences.length > 0 &&
      (pageLines + lines > cap || pageSentences.length >= sentenceCap)
    ) {
      // この文を足すと溢れる、または文数上限 (#448) に達した → 改頁してから新ページの先頭に置く。
      flush()
    }
    pageSentences.push(sentences[i])
    pageLines += lines
    // 1 文だけで cap を超えるケースはここで即 flush し、文途中改頁を避けて単独ページにする。
    if (pageSentences.length === 1 && pageLines >= cap) {
      flush()
    }
  }
  flush()
  return pages
}

/**
 * wordwrap 済みテキスト中で「plain（折返し前）文字を `plainPrefixLength` 個消費し終えた位置」の
 * インデックス（UTF-16 コード単位）を返す純粋関数 (#292)。
 *
 * 文単位送り（息継ぎ単位の novel 表示）の最重要ヘルパー。DialogBox は表示テキストを wordwrap して
 * `lines.join('\n')` を typewriter の fullText にする。文単位送りでは:
 *  - 累積表示テキスト  = `page.sentences.slice(0, sentenceIndex+1).join('')` を wordwrap した fullText
 *  - 既出プレフィックス = `page.sentences.slice(0, sentenceIndex).join('')`（plain 長さ）
 * を即時表示扱いにしたい。だが wordwrap は `\n` を挿入するため **plain 長さ ≠ wrapped 長さ**。
 * 「既出プレフィックスの plain 文字数」を、wrapped 文字列上のインデックス（＝ `startTypewriterFrom`
 * の `fromCount`）へ変換するのがこの関数の役目。
 *
 * 単位の一致（#292 セルフレビュー M1 で是正）:
 *  - 呼び出し側（DialogBox.setNovelDialogProgressive）は `plainPrefixLength` を **UTF-16 コード単位長**
 *    （`plainText.length` / `sentences.slice(...).join('').length`）で渡す。
 *  - 本関数も **UTF-16 コード単位**で走査・計数する（`for (let i=0; i<wrappedText.length; i++)`）。
 *  - 入力と内部カウンタの単位を一致させることで、サロゲートペア（絵文字等）が既出プレフィックスに
 *    含まれても停止条件がズレない。`\n` は wordwrap がコードポイント境界にしか挿入せず、プレフィックスは
 *    常に完全なコードポイント列なので、`substring`（UTF-16 単位）でサロゲートを割らない。
 *
 * アルゴリズム:
 *  - wrappedText を先頭から UTF-16 コード単位で 1 つずつ走査する。
 *  - `\n`（wordwrap が挿入した改行）は plain にカウントしない（既出文には含まれない区切り）。
 *  - `\n` 以外（plain 文字のコード単位）を 1 つ数えるたびに consumed を増やす。
 *  - consumed が plainPrefixLength に達した**直後**のインデックス（次の位置）を返す。
 *
 * 境界の扱い:
 *  - `plainPrefixLength <= 0`（NaN も `<= 0` を素通りしないため別途 0 扱い）→ 0（既出なし＝全部これからタイプ）。
 *  - プレフィックスがちょうど wrap 境界に land した場合: 既出文の末尾 plain 文字を消費した直後で
 *    返すため、その直後に続く `\n`（次行頭の手前の改行）は **含めない**。`\n` を plain に数えない
 *    ので自然にそうなる（既出文の末尾＝次行の手前で止まる）。
 *  - plainPrefixLength が wrapped 中の plain コード単位総数以上 → wrappedText.length（全消費）。
 *  - 空文字 / `\n` 連続も安全（plain を数えないので素通しする）。
 *
 * Math.random など非決定要素は使わない。`this` / PixiJS / DOM に触れない決定論的写像。
 *
 * @param wrappedText wordwrap 後のテキスト（`lines.join('\n')`）
 * @param plainPrefixLength 既出プレフィックスの plain（折返し前）文字数（UTF-16 コード単位）
 * @returns wrappedText 上で、その plain プレフィックスを表示し終えた位置のインデックス（UTF-16 コード単位）
 */
export function wrappedPrefixLength(wrappedText: string, plainPrefixLength: number): number {
  // NaN は `<= 0` も `>= n` も素通りするので、有限数でなければ 0（既出なし）に倒す。
  if (!(plainPrefixLength > 0)) return 0
  let consumed = 0
  for (let i = 0; i < wrappedText.length; i++) {
    if (wrappedText[i] === '\n') continue
    consumed++
    if (consumed >= plainPrefixLength) {
      // この plain コード単位を消費し終えた = その次の位置までが既出。直後の \n は含めない
      // （\n を数えないので、ここで返すインデックスは次の plain 文字 or 改行の手前で止まる）。
      return i + 1
    }
  }
  // 全 plain コード単位を消費しても plainPrefixLength に届かない → 全文が既出（末尾まで）。
  return wrappedText.length
}

/** novel モードのインジケータ配置（px・論理座標）。 */
export interface IndicatorPlacement {
  /** インジケータ左上 x（px） */
  x: number
  /** インジケータ左上 y（px） */
  y: number
}

/**
 * novel モードで、止まっている表示テキストの**最後の wrap 行の右端**にインジケータを置く座標を
 * 計算する純粋関数 (#292)。novel では右下固定を廃止し、文末の右にクリッカーを出す。
 *
 * 入力（すべて DialogBox の font メトリクス／幾何から得る・このモジュールは DOM/PIXI 非依存）:
 *  - `textStartX` / `textStartY`: dialogText の左上（`textStartX()` / `textStartY()`）。
 *  - `lineCount`: 表示テキストの wrap 後行数（最低 1。0 が来たら 1 扱い）。
 *  - `lastLineWidth`: 最終行の表示幅（px。同じ font で measureText した値）。
 *  - `lineHeight`: 行高（px）。
 *  - `indicatorWidth`: インジケータ記号の表示幅（px。右端クランプで使う）。
 *  - `indicatorHeight`: インジケータ記号の表示高さ（px。文末行の縦中央寄せに使う・#300）。
 *  - `boxRightEdge`: テキスト領域の右端 x（px。`boxX + boxW - padding` 等）。
 *
 * 配置（同一行に収まる場合・従来挙動）:
 *   x = textStartX + lastLineWidth                                          // 最終行の右端（文末の右）
 *   y = textStartY + (lineCount - 1) * lineHeight + (lineHeight - indicatorHeight) / 2
 *                                                                           // 最終行 band の縦中央（#300）
 *
 * 行折り返し (#306): 最終行が右端まで埋まっていて、クリッカーが**同一行のテキスト右に収まらない**
 * （`rawX + indicatorWidth > boxRightEdge`）場合、従来は `boxRightEdge - indicatorWidth` にクランプして
 * いたため**最終行末尾の文字の上にクリッカーが重なって**見えた（画面外は防げるが文字に被る）。
 * これを避けるため、収まらないときは**次の行に落とす**:
 *   x = boxRightEdge - indicatorWidth                                       // 次行の右端（「次行の右下」風）
 *   y = textStartY + lineCount * lineHeight + (lineHeight - indicatorHeight) / 2
 *                                                                           // テキストの 1 行下の band 縦中央
 * 同一行に収まる場合は折り返さず従来通り（既存挙動維持）。
 *
 * 箱からのはみ出し防止 (#306): 次行に落とした y が箱下端（`boxBottom`）を超えないよう
 * `Math.min(y, boxBottom - indicatorHeight)` でクランプし、下限は箱内の最終行 band の縦中央
 * （= 同一行配置時の y）に留めて、満杯ページでも記号が箱外・最終行より上に飛ばないようにする。
 * `boxBottom` 未指定（後方互換）は Infinity 扱い＝クランプ無効。
 *
 * y の縦中央化 (#300): インジケータ高さ（≪ 行高 ~64）なので `(lineHeight - indicatorHeight) / 2` の
 * 余白を足して行 band の縦中央へ揃える。`indicatorHeight` が **lineHeight を超える**ときは余白が
 * 負になるため `Math.max(0, …)` で 0 にクランプし、上端（旧挙動）へ退化させて下振れの破綻を防ぐ。
 *
 * Math.random など非決定要素は使わない。決定論的写像。
 */
export function computeNovelIndicatorPlacement(args: {
  textStartX: number
  textStartY: number
  lineCount: number
  lastLineWidth: number
  lineHeight: number
  indicatorWidth: number
  indicatorHeight: number
  boxRightEdge: number
  /** テキスト領域の下端 y（px。`boxY + boxH - padding` 等）。次行送り時の y クランプに使う (#306)。
   *  未指定（後方互換）は Infinity 扱い＝クランプしない。 */
  boxBottom?: number
}): IndicatorPlacement {
  const { textStartX, textStartY, lastLineWidth, lineHeight, indicatorWidth, boxRightEdge } = args
  const lineCount = args.lineCount >= 1 ? args.lineCount : 1
  const boxBottom = args.boxBottom ?? Number.POSITIVE_INFINITY
  // 行 band 内でインジケータを縦中央へ寄せる余白 (#300)。indicatorHeight が lineHeight を
  // 超えると負になるため 0 にクランプ（上端＝旧挙動に退化）。同一行・次行どちらでも使う。
  const verticalCenterOffset = Math.max(0, (lineHeight - args.indicatorHeight) / 2)

  const rawX = textStartX + lastLineWidth
  // 同一行のテキスト右にクリッカーが収まるか (#306)。収まる = 右端を超えない。
  const fitsOnSameLine = rawX + indicatorWidth <= boxRightEdge

  // 同一行配置時の y（最終行 band の縦中央）。次行クランプの下限としても使う。
  const sameLineY = textStartY + (lineCount - 1) * lineHeight + verticalCenterOffset

  if (fitsOnSameLine) {
    // 従来挙動: 最終行の右に縦中央配置（#300）。
    return { x: rawX, y: sameLineY }
  }

  // 溢れる → 次行に落とす (#306)。x は次行の右端（「次行の右下」風）でテキストに被らない。
  // 下限 textStartX は念のための負余白ガード（boxRightEdge < indicatorWidth の異常入力対策）。
  const x = Math.max(textStartX, boxRightEdge - indicatorWidth)
  // テキストの 1 行下の band 縦中央。箱下端を超えそうなら箱内へクランプし、最終行 band より
  // 上へは戻さない（満杯ページで記号が箱外・前行より上に飛ぶのを防ぐ）。
  const nextLineY = textStartY + lineCount * lineHeight + verticalCenterOffset
  const clampedY = Math.min(nextLineY, boxBottom - args.indicatorHeight)
  // 満杯ページで次行が箱外に出る場合、下限 sameLineY（最終行 band 縦中央）へ留める。これは
  // 「箱内優先で文字との重なりを許容（箱外に出るより良い）」という意図的な妥協（#306 nit）。
  const y = Math.max(sameLineY, clampedY)
  return { x, y }
}
