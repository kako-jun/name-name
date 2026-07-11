/**
 * 立ち絵表示レイヤー
 *
 * PixiJS Container 上でキャラクター立ち絵の表示・表情変更・退場を管理する。
 */

import { Assets, Container, Graphics, Sprite, Text, Texture, TextStyle, Ticker } from 'pixi.js'
import type { Easing } from '../types'
import { applyEasing, resolveDelta } from './easing'
import { ensureFontLoaded } from './FontLoader'
import { TimeController, defaultTimeController } from './TimeController'
import {
  computeGlyphTransform,
  cursorVisible,
  glyphAnchorOffset,
  isRevealEffect,
  layoutGlyphCenters,
  resolveCursor,
  resolveTransformEffect,
  resolveTypewriterMsPerChar,
  textEffectTotalDurationMs,
  type ResolvedCursor,
  type ResolvedTransformEffect,
  type TextEffectParams,
} from './textEffect'
import {
  layoutUnderline,
  resolveUnderline,
  underlineScaleX,
  type ResolvedUnderline,
  type UnderlineParams,
} from './underline'
// 色パーサ・2D 位置・URL 解決は novelLayout.ts（色/幾何の純関数置き場）に集約 (#273 / #274)。
import {
  parseColorToNumber,
  resolvePositionWithOverride,
  resolveAssetUrl,
  resolveCharacterImageUrls,
} from './novelLayout'
import { startTypewriter, tickTypewriter, type TypewriterState } from './typewriter'
import { hasOwn, safeAssign } from './ownProperty'

/**
 * 瞬断リトライ前の待機時間 (ms) (#389)。全候補が一巡失敗したらこの時間だけ待って再試行する。
 * 一時的なネットワーク瞬断の回復を待つのが目的。長くしすぎると #293 の onReady 発火（テキスト
 * 解禁）までの待ちが伸びるため、短く抑える。
 */
const LOAD_RETRY_DELAY_MS = 300

/**
 * URL 候補を先頭から順に Assets.load し、最初に成功した読み込み結果を返す (#376)。
 * webp→png フォールバック用。候補が 1 本だけなら従来通り単純ロードと等価。
 *
 * 全候補が一巡失敗した場合、短い待機を挟んで **1 回だけ**もう一巡リトライしてから reject する
 * (#389)。一時的なネットワーク瞬断で #293 のフォールバック（ロード成否に関わらず onReady 発火）
 * が「立ち絵なし・テキストあり」に倒れるのを緩和する。PixiJS v8 の Loader は失敗した URL を
 * `promiseCache` から削除する（キャッシュ済み reject を残さない）ため、同一 URL のリトライも
 * 実際に再取得を試みる＝ネット回復・別 URL 候補の両方に効く。過剰にしないため、リトライは
 * 1 巡だけ（計 2 巡）で打ち切る。#293 の順序保証とは両立する（失敗が確定すれば従来どおり
 * onReady が発火してテキストは解禁される。リトライぶん解禁が遅れるだけで詰まらせない）。
 *
 * リトライ待機は呼び出し元から `delay` で注入する。本番経路（`loadTexture`）は `this.time`
 * (TimeController) 経由の遅延を渡し、全タイマーを TimeController に通す規律に揃える＝仮想時間
 * エクスポート（Phase 2）でも決定論 replay とズレない。デフォルトは生 `setTimeout` フォールバックで、
 * module-level 関数を直接叩く単体テストが遅延関数を差し替えずに済むようにしてある。
 */
async function loadFirstAvailableTexture(
  urls: string[],
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<Texture> {
  let lastError: unknown
  const maxAttempts = 2 // 初回 + 瞬断リトライ 1 回
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // 待機は TimeController 経由（仮想時間エクスポートと整合）。注入された delay を使う。
      await delay(LOAD_RETRY_DELAY_MS)
    }
    for (const url of urls) {
      try {
        return await Assets.load<Texture>(url)
      } catch (err) {
        lastError = err
      }
    }
  }
  throw lastError
}

/** キャラクターの画面上の配置位置（screenWidth に対する比率） */
const CHARACTER_X_RATIO: Record<string, number> = {
  left: 150 / 800, // 0.1875
  center: 400 / 800, // 0.5
  right: 650 / 800, // 0.8125
  // オフスクリーン位置（スクロールイン/アウトの初期/終了位置として使う）
  // スプライト中心の x。画像の半幅 (~400 logical) を考えると 1.5 にしないと右端が見える
  off_left: -400 / 800, // -0.5, 画像中心が画面左 0.5 分外
  off_right: 1200 / 800, // 1.5, 画像中心が画面右 0.5 分外
}

/**
 * novel スタイル (#286) の役割配置 x 比率。質問役（主人公）＝左 / 回答役（住人）＝右。
 * 名札を出さない novel で「誰が喋っているか」を左右で示すため、中央でなく左右に振る。
 * 既定の left/center/right（CHARACTER_X_RATIO 0.1875/0.5/0.8125）とは別の、より外側に寄せた
 * 比率（0.25 / 0.75）を使う。issue #286 の「左 x≈0.25 / 右 x≈0.75」に合わせる。
 * 縦位置は CHARACTER_Y_RATIO（全員共通ベースライン固定）をそのまま使う。
 * テストが期待値を直書きして陳腐化しないよう export する。
 */
export const NOVEL_ROLE_X_RATIO = {
  /** 質問役（主人公）。画面左寄り。 */
  questioner: 0.25,
  /** 回答役（住人 / 司会など非主人公）。画面右寄り。 */
  responder: 0.75,
} as const

/**
 * 日本語表記の position を英語 key に正規化する。
 * パーサーは "中央" 等の日本語表記をそのまま position 文字列に流すため、
 * CharacterLayer 側で受ける必要がある (#133)。
 *
 * サポートする表記:
 *   - 英語: left / center / right
 *   - 英語ゆれ (case / 綴り): Left / Center / Centre / Right
 *   - 日本語 (左): 左 / 左寄り / 左端
 *   - 日本語 (中央): 中央 / 真ん中 / まんなか / 真中 / 中
 *   - 日本語 (右): 右 / 右寄り / 右端
 *
 * 未知の値が来たら CharacterLayer 側で center にフォールバックする。
 */
const POSITION_ALIASES_JA: Record<string, string> = {
  左: 'left',
  左寄り: 'left',
  左端: 'left',
  中央: 'center',
  真ん中: 'center',
  まんなか: 'center',
  真中: 'center',
  中: 'center',
  右: 'right',
  右寄り: 'right',
  右端: 'right',
  // オフスクリーン（スクロールイン/アウトの起点・終点）
  右外: 'off_right',
  画面外右: 'off_right',
  オフ右: 'off_right',
  左外: 'off_left',
  画面外左: 'off_left',
  オフ左: 'off_left',
}

const POSITION_ALIASES_EN: Record<string, string> = {
  Left: 'left',
  Center: 'center',
  Centre: 'center',
  Right: 'right',
}

export function normalizePosition(position: string): string {
  // 空文字 / null 相当は早期に center に倒す (review #152 nit)
  if (!position) return 'center'
  // own-property のみ見る (#368)。素朴な `POSITION_ALIASES_JA[position]` は Object.prototype も
  // 辿ってしまい、position が `constructor` 等と一致すると `??` の後続（EN 表・生 position への
  // フォールバック）が発火せず関数オブジェクトを返してしまう。
  if (hasOwn(POSITION_ALIASES_JA, position)) return POSITION_ALIASES_JA[position]
  if (hasOwn(POSITION_ALIASES_EN, position)) return POSITION_ALIASES_EN[position]
  return position
}

/**
 * 明示フィット指定 (#294) の立ち絵スケールを計算する純粋関数。
 *
 * 脚本の話者行に `フィット` / `fit` を書いた立ち絵だけに適用する旧 fit-down ロジック:
 * テクスチャが論理画面 (`screenW`×`screenH`) より大きいときだけ、画面内に収まるよう
 * `min(screenW/texW, screenH/texH)` で縮小する。論理画面に収まる小さい立ち絵は原寸 (1)。
 *
 * これは ca5308a で撤去した自動縮小と同一の式で、fit=true のときだけ復活させる。
 * fit=false（既定）の立ち絵は常に原寸 (1) で表示する（この関数を呼ばない）。
 *
 * 不正・非有限・非正のテクスチャ寸法は原寸 (1) に倒す（0 除算・NaN ガード）。
 */
export function computeFitScale(
  texW: number,
  texH: number,
  screenW: number,
  screenH: number
): number {
  if (
    !Number.isFinite(texW) ||
    !Number.isFinite(texH) ||
    texW <= 0 ||
    texH <= 0 ||
    !Number.isFinite(screenW) ||
    !Number.isFinite(screenH) ||
    screenW <= 0 ||
    screenH <= 0
  ) {
    return 1
  }
  // 大きい時だけ収める。小さい・等倍は原寸のまま（拡大しない）。
  if (texW > screenW || texH > screenH) {
    return Math.min(screenW / texW, screenH / texH)
  }
  return 1
}

/**
 * per-game 目標表示高さ (#360) の立ち絵スケールを計算する純粋関数。
 *
 * frontmatter `character_height_ratio`（画面高さに対する割合 0..1）を指定した立ち絵に適用する。
 * 高解像度化した立ち絵（例: 2倍リサイズ 696×1396px）を原寸 (scale=1) で置くと論理画面
 * (`screenH`) に対して巨大化するため、`目標高さ = character_height_ratio × screenH` を
 * テクスチャ高さで割った uniform scale を返す（幅はアスペクト比で追従）。元画像が 2 倍でも
 * 4 倍でも画面上の大きさは不変になる。
 *
 * `fit`（#294）と違い「大きい時だけ縮める」ではなく、常に目標高さへ合わせる（拡大もする）。
 * 呼び出し側で [0.05, 2.0] にクランプ済みの ratio を渡す想定だが、関数内でも 0 除算・NaN を
 * ガードする。不正な引数は全て原寸 (1) に倒す：非有限・非正の texH/screenH に加え、非有限の
 * ratio および非正の ratio（ratio<=0 だと scale=0 で不可視・負で反転になるため）も 1 に倒す。
 *
 * テストが定数計算を直書きして陳腐化しないよう export する（規律4 / #262 の教訓）。
 */
export function computeTargetHeightScale(
  texH: number,
  targetHeightRatio: number,
  screenH: number
): number {
  if (
    !Number.isFinite(texH) ||
    texH <= 0 ||
    !Number.isFinite(screenH) ||
    screenH <= 0 ||
    !Number.isFinite(targetHeightRatio) ||
    targetHeightRatio <= 0
  ) {
    return 1
  }
  return (targetHeightRatio * screenH) / texH
}

/** character_scale の許容下限 (#378)。元絵基準の一律スケール。0 だと立ち絵が消える（scale=0）ため、
 *  極小でも視認できる下限を設ける。値は character_height_ratio (#360) の下限と同じ 0.05 を再利用するが、
 *  意味（元絵基準 vs 画面基準）を明確にするため専用定数として持つ。
 *  テストが期待値（0.05）を直書きして陳腐化しないよう export する（規律4 / #262 の教訓）。 */
export const CHARACTER_SCALE_MIN = 0.05
/** character_scale の許容上限 (#378)。元絵基準スケールは元絵解像度に依存し、身長差を焼き込んだ立ち絵を
 *  そのまま拡大する用途があるため、画面基準の character_height_ratio (#360, 上限2) より広く 4 まで許容する
 *  （暴走値で立ち絵を画面外まで巨大化させないよう上限は設ける）。
 *  テストが期待値（4）を直書きして陳腐化しないよう export する（規律4 / #262 の教訓）。 */
export const CHARACTER_SCALE_MAX = 4

/**
 * 立ち絵の元絵基準スケール character_scale (#378) を許容範囲へクランプする純粋関数。
 *
 * `character_scale` は **元絵基準** の一律スケール（`sprite.scale = 値` ＝ 表示px = 値 × texture.height）。
 * 元絵に焼き込んだ縦px差（身長差）をそのまま画面へ出す。これは **画面基準** の
 * `character_height_ratio`（#360, 表示高さ = 値 × screenH でテクスチャの縦pxを割り消す）と対照的で、
 * 画面基準は元絵解像度に関わらず身長差を潰すのに対し、元絵基準は身長差を保存する。
 *
 * 値を [CHARACTER_SCALE_MIN, CHARACTER_SCALE_MAX] = [0.05, 4] にクランプして返す。
 * 呼び出し側（setCharacterScale）が非有限・非正を弾いた後の有効値だけを渡す想定。
 *
 * テストが定数（0.05 / 4）を直書きして陳腐化しないよう export する（規律4 / #262 の教訓）。
 */
export function clampCharacterScale(scale: number): number {
  return Math.min(CHARACTER_SCALE_MAX, Math.max(CHARACTER_SCALE_MIN, scale))
}

/**
 * per-character の character_height_ratios override (#364) を解決する純粋関数。
 *
 * `character_height_ratio`（#360）はスクリプト単位の単一値のため、1つのスクリプトに登場する
 * 全キャラの表示高さが同一値に強制収束してしまう（テクスチャの縦pxに関わらず身長差が潰れる）。
 * per-character override マップを持たせて、キャラごとに違う目標高さを指定できるようにする。
 *
 * 優先順位: `ratios[characterName]`（per-character override）> `defaultRatio`（character_height_ratio、
 * スクリプト単位）> `null`（呼び出し側で原寸 scale=1 にフォールバック）。
 * `setCharacterHeightRatios` が保存前に [CHARACTER_HEIGHT_RATIO_MIN, MAX] へクランプ・不正値除去
 * 済みのため、ここでは単純なルックアップのみ行う（値の検証はこの関数の責務ではない）。
 *
 * テストが期待値を直書きして陳腐化しないよう export する（規律4 / #262 の教訓）。
 */
export function resolveCharacterHeightRatio(
  characterName: string,
  ratios: Record<string, number>,
  defaultRatio: number | null
): number | null {
  // own-property のみ見る（#364 セルフレビュー修正 / #368 で共通ヘルパーへ統一）。
  // `ratios[characterName]` の素朴なブラケットアクセスは prototype chain も辿ってしまい、
  // キャラ名が `constructor` / `toString` 等の Object.prototype のプロパティ名と一致すると
  // 関数オブジェクトを返してしまう
  // （呼び出し側 computeTargetHeightScale の Number.isFinite ガードで静かに scale=1 に化ける）。
  const isOwn = hasOwn(ratios, characterName)
  return isOwn ? ratios[characterName] : defaultRatio
}

/**
 * ラベルの `揃え` / `align`（正規化済み left/center/right）を Pixi の anchor.x に写す (#275)。
 *
 * 左=0 / 中央=0.5 / 右=1。parser が日本語/英語を `left`/`center`/`right` に正規化済みなので
 * ここではその 3 値だけを見る。未指定・未知は中央 (0.5) にフォールバック（既定 = 現状維持）。
 * テストが期待値を直書きして陳腐化しないよう export する。
 */
export function alignToAnchorX(align: string | undefined): number {
  switch (align) {
    case 'left':
      return 0
    case 'right':
      return 1
    case 'center':
      return 0.5
    default:
      return 0.5
  }
}

/** 足元 Y 座標の**既定**比率（`characterY = screenHeight * CHARACTER_Y_RATIO`）。
 *  立ち絵は anchor(0.5, 1)＝下辺が足。この比率に screenHeight を掛けた値を足元 Y にする。
 *  - 1.0 = 足が画面下端（全身が見える）。
 *  - >1.0（例 1.05）= 足が画面下端より下＝靴が画面外に切れる（ToHeart 式）。
 *  以前は 380/450 ≒ 0.844 (DialogBox の上端あたり) だったが、
 *  枠なし・教育動画モードでは立ち絵の下端を画面下端まで下げたほうが座りが良い。
 *
 *  足元をどこに置くか（全身 / 靴を切る）はゲームごとに違うため、この定数は
 *  グローバルに全ゲームを動かす値ではなく **per-game 未指定時の既定値**。frontmatter
 *  `character_y_ratio` から流した per-game 値で `setCharacterYRatio` 経由で上書きできる。
 *  未指定（呼ばない）なら 1.0 が効く＝後方互換。dialog_style: novel/adv 非依存。
 *  テストが期待値を直書きして陳腐化するのを防ぐため export する（#262）。 */
export const CHARACTER_Y_RATIO = 1.0

/** character_y_ratio の許容下限 (#308)。負・極端値は安全側にクランプする。
 *  0 = 足が画面上端（立ち絵が上に張り付く）。これより小さい値は意味を成さない。 */
const CHARACTER_Y_RATIO_MIN = 0
/** character_y_ratio の許容上限 (#308)。1 画面分下まで（足が下端の 1 画面下＝完全に画面外）。
 *  靴を切る用途（>1.0）は許すが、暴走値で立ち絵を遥か下に飛ばさないよう上限を設ける。 */
const CHARACTER_Y_RATIO_MAX = 2

/** character_height_ratio の許容下限 (#360)。0 だと立ち絵が消える（scale=0）ため、
 *  極小でも視認できる下限を設ける（画面高の 5%）。 */
const CHARACTER_HEIGHT_RATIO_MIN = 0.05
/** character_height_ratio の許容上限 (#360)。画面高の 2 倍まで（拡大用途を許容しつつ暴走を防ぐ）。
 *  character_y_ratio (#308) と同じく安全側にクランプする。 */
const CHARACTER_HEIGHT_RATIO_MAX = 2

interface CharacterState {
  sprite: Sprite
  /** 立ち絵の上に表示する名前ラベル（off_right/off_left で登場したとき自動付与）。
   *  sprite と同じ x で追従する。退場時に一緒に destroy する。 */
  label?: Text
  position: string
  expression: string
  /** 進行中アニメーション。null なら静的 */
  animation: ActiveAnimation | null
  /** フェードイン/アウトアニメーション。退場時は完了後に sprite を destroy する */
  fadeAnimation: FadeAnimation | null
  /** 話者交代のポーズ変化 (#286)。null なら適用なし。novel の話者表示に使う自己復帰の軽い持ち上げ。 */
  poseNudge: PoseNudge | null
  /** グリフ単位の文字演出 (#268)。null なら適用なし（タイトルは単一 label 表示）。 */
  textEffect: TextEffectAnimation | null
  /** 下線ビーム (#270)。null なら適用なし。sprite の子として線を持つ。 */
  underline: UnderlineAnimation | null
  /** 解決済みのタイトル文字色 (Pixi 数値カラー) (#273)。showTitle が `色=` 指定から解決して保持する。
   *  グリフ演出 (爆発) のグリフ fill とカーソル fallback がこの色を使う。
   *  未指定（タイトル以外のキャラ含む）は undefined → 各所で TITLE_FILL（白）にフォールバック。 */
  titleColor?: number
  /** 解決済みのタイトル文字サイズ (px) (#275)。showTitle が `サイズ=` 指定から解決して保持する。
   *  グリフ演出 (爆発) のグリフ fontSize とカーソル高さがこの値を使う。
   *  未指定（タイトル以外のキャラ含む）は undefined → 各所で TITLE_FONT_SIZE（64）にフォールバック。 */
  titleFontSize?: number
  /** 2コマ自動切替 (expression が `*-a` なら `*-b` と 1 秒ごとに交互)。
   *  remove() / clear() で interval を必ずクリアする。TimeController 経由なので number。 */
  idleIntervalId?: number
  /** show() 時の assetBaseUrl。アニメ開始時に idle cycle を仕掛けるとき再利用する */
  assetBaseUrl: string
  /** 明示フィット指定 (#294)。脚本の話者行に `フィット` を書いた立ち絵だけ true。
   *  true のとき loadTexture で旧 fit-down（大きい時だけ画面内に収める）を適用する。
   *  既定 false は原寸 (scale=1)。表情変更・2コマ切替で texture を再ロードしても維持する。 */
  fit: boolean
  /** 演出表示（タイトル / ラベル / 画像）か (#274)。true なら getCharacterStates が除外し、
   *  `NovelGameState.characters` に漏れない（doctrine 規律3: 立ち絵 show だけが復元対象）。
   *  Title / Label / Image はセーブ/シーク/任意局面起動で再 emit されない（spec L520, ADR0002）。 */
  renderOnly?: boolean
  /** 同一人物クロスフェード用の旧 sprite。描画・待機対象だが NovelGameState には入れない。 */
  snapshotHidden?: boolean
  /** 円形マスク用 Graphics (#274)。`[画像: 円形]` のとき sprite.mask に設定する。退場で破棄する。 */
  maskGraphics?: Graphics
  /** ラベルの水平 anchor (#275)。左=0 / 中央=0.5 / 右=1。label.anchor.x と一致させて保持する。
   *  グリフ演出 (buildTextEffect) のグリフ群オフセット (glyphAnchorOffset) とカーソル位置
   *  (positionCursor) が anchor を尊重するために参照する。未設定（立ち絵等）は 0.5 扱い。 */
  anchorX?: number
  /** false の間は GameState 上の最終表示としては存在するが、旧人物 fade-out 待ちで描画ツリーには未追加。 */
  attached?: boolean
}

interface FadeAnimation {
  startMs: number
  durationMs: number
  fromAlpha: number
  toAlpha: number
  /** true なら 0 に到達した時点で sprite を破棄して characters Map から消す */
  destroyOnComplete: boolean
  /** fade-out 完了後に次の人物の fade-in を開始するためのローカル hook。GameState には出さない。 */
  onComplete?: () => void
}

/**
 * 話者交代のポーズ変化 (#286)。
 *
 * 名札を出さない novel スタイルで「今この人が喋っている」を立ち絵で示すための、軽い自己復帰アニメ。
 * sprite を baseY から少し持ち上げて（最大 -liftPx）半周期で元へ戻す sin 山形のオフセット。
 * #283 の ExpressionChange/scrim 自動退避フックに相乗りして呼ばれる（新規の重い演出は作らない）。
 *
 * baseY を明示保持し、補間オフセットを毎フレーム baseY に足し込む（中間状態を sprite.y に焼き込まない）。
 * 1 文ごとの高速入替でも、再 nudge は前回の baseY を引き継いで上書きするだけなので破綻しない。
 * GameState には持たない（演出・render-only。復元では nudge していない静止状態に倒す）。
 */
interface PoseNudge {
  /** 効果開始時刻（elapsedMs 基準）。 */
  startMs: number
  /** 山形オフセットの所要 ms（持ち上げ → 復帰で 1 周）。 */
  durationMs: number
  /** 持ち上げ量（px）。sprite は最大 baseY - liftPx まで上がって戻る。 */
  liftPx: number
  /** オフセットを足し込む基準 y（nudge 開始時の sprite.y）。完了で必ずここへ戻す。 */
  baseY: number
}

/**
 * 立ち絵のフェードイン/アウトのデフォルト時間 (ms)。
 * 仕様書 docs/spec/markdown-v0.1.md と数値を揃えて変更する。
 * #407: 300→700 に変更（背景フェード既定 BACKGROUND_CROSSFADE_MS=700 と揃え、ToHeart 式の
 * じわっとした登場を既定にする）。`character_fade_ms` 未指定の全作品の立ち絵フェードが 700ms になる。
 */
const DEFAULT_FADE_MS = 700
const CHARACTER_FADE_MS_MIN = 0
const CHARACTER_FADE_MS_MAX = 5_000

/**
 * タイトルカード補助要素（ラベル / 画像 #274）のフェードイン時間 (ms)。
 * opening.html の各要素の fadeIn（0.3〜0.8s で順次）相当。立ち絵 (#177) より長めの
 * ゆったりした登場にして、OP のスタック演出の "間" を出す。
 */
const TITLE_CARD_FADE_MS = 700

export interface AnimateParams {
  /** "+500" / "-200" / "400" / undefined */
  dx?: string
  dy?: string
  /** 度数 (degree)。"+360" / "180" / undefined */
  rotation?: string
  /** 1.0 = 等倍。undefined で変更なし */
  scale?: number
  duration_ms: number
  easing?: Easing
}

interface ActiveAnimation {
  startMs: number
  durationMs: number
  easing: Easing
  // 開始時点のスナップショット
  fromX: number
  fromY: number
  fromRotation: number
  fromScale: number
  // 終端値 (resolveDelta 適用後)
  toX: number
  toY: number
  toRotation: number
  toScale: number
}

/**
 * グリフ単位の文字演出の進行状態 (#268)。
 *
 * タイトル label を 1 文字ずつ Text に分解して container に並べ、ticker で
 * 各グリフの transform/alpha を毎フレーム純粋計算（textEffect.ts）して適用する。
 * 効果完了後も container を保持し、後続 `[アニメ target=Title]` が sprite を動かすと
 * container が追従する（container は sprite の子）。
 *
 * 中間状態は持たない（ADR 0002）: 進行は startMs からの経過 ms で都度計算する。
 * 復元時は applyTextEffectResting で「効果完了済み = 全グリフ整列」状態にする。
 */
interface TextEffectAnimation {
  /** sprite の子として並ぶグリフ Text 群を束ねる container。整列レイアウト済み。 */
  container: Container
  /**
   * 1 文字ごとのグリフと、その整列位置（restX/restY）を明示保持する。
   * 毎フレームの補間オフセットは restX/restY を基準に足し込む（モンキーパッチ排除 #268）。
   */
  glyphs: Array<{ glyph: Text; restX: number; restY: number }>
  /** transform 系（爆発等）の解決済みパラメータ。reveal 系では null。 */
  transform: ResolvedTransformEffect | null
  /** reveal 系（タイプ）の typewriter 状態。transform 系では null。 */
  typewriter: TypewriterState | null
  /** reveal の 1 文字あたり ms（typewriter 駆動用）。 */
  msPerChar: number
  /** 効果開始時刻（elapsedMs 基準）。transform 進行の起点。 */
  startMs: number
  /** 効果全体の所要 ms（最後のグリフが整列し終わるまで）。ticker 停止判定用。 */
  totalMs: number
  /** 整列確定（settleTextEffect）済みか。完了後に毎フレーム再 settle しないためのラッチ。 */
  settled: boolean
  /** 点滅カーソル (#271)。null ならカーソルなし。reveal 系（タイプ）かつ cursor=on のときだけ持つ。
   *  settle 後もカーソルだけは点滅し続ける（render-only の小例外）。 */
  cursor: CursorState | null
}

/**
 * タイプ末尾の点滅カーソル状態 (#271)。
 *
 * reveal head（表示済み末尾グリフの右端）に縦矩形 Graphics を置き、`cursorVisible` の
 * 純関数で点滅させる。タイプ完了後も末尾位置に固定して点滅し続ける（closing.html 忠実）。
 * ADR0002: 点滅位相は render-only でセーブ対象外。位置はタイプ完了位置に固定。
 * skip(instant) 時はカーソルなしの静止全表示に畳む（gfx を非表示にする）。
 */
interface CursorState {
  /** カーソル本体の縦矩形 Graphics（container の子）。 */
  gfx: Graphics
  /** カーソルに適用した解決済み色 number (#273)。`カーソル色` 指定 > タイトル色 fallback の一次情報。 */
  colorNum: number
  /** 点滅周期 (ms)。半周期で表示/非表示。 */
  blinkMs: number
  /** 点滅起点（elapsedMs 基準）。startMs と揃え、export 再現のため仮想時間で算出する。 */
  blinkStartMs: number
}

/**
 * 下線ビーム (#270) の進行状態。
 *
 * 対象テキスト幅にフィットする横線（Pixi Graphics の矩形）を sprite の子として置き、
 * ticker で `underlineScaleX` の純関数値を scale.x に当てて左から伸ばす。
 * 矩形は左端基準で描画し、pivot/位置で transform-origin 左を実現する。
 *
 * 中間状態は持たない（ADR0002）: 進行は startMs からの経過 ms で都度計算する。
 * skip 時（skipMode のスキップ前進）は scale.x=1（伸び切り）の静止状態にする。
 * applyState は [下線] を replay しない（GameState に持たない・ADR0002）ので、復元では走らない。
 */
interface UnderlineAnimation {
  /** 線本体の Graphics（左端基準で矩形を描画済み。scale.x で伸長する）。 */
  gfx: Graphics
  /** 解決済みパラメータ（色/太さ/duration/easing）。 */
  resolved: ResolvedUnderline
  /** 効果開始時刻（elapsedMs 基準）。 */
  startMs: number
  /** 伸長アニメ所要 ms（resolved.durationMs）。ticker 停止判定用。 */
  durationMs: number
  /** 伸び切り確定済みか。完了後に毎フレーム再 settle しないためのラッチ。 */
  settled: boolean
}

export class CharacterLayer extends Container {
  private characters: Map<string, CharacterState> = new Map()
  private transitionSerial = 0
  /** show/changeExpression から起動した立ち絵 texture load の未完数。 */
  private pendingPortraitLoads = 0
  /** アニメーション駆動用 ticker。動いているキャラがいないときは停止しておく */
  private animTicker: Ticker | null = null
  /** ticker.deltaMS の累計を保持してアニメ進行に使う */
  private elapsedMs: number = 0
  /** 足元 Y 座標（screenHeight * characterYRatio）。setCharacterYRatio で再計算される (#308)。 */
  private characterY: number
  /** 足元 Y 比率 (#308)。既定は CHARACTER_Y_RATIO（1.0）。frontmatter `character_y_ratio` 由来の
   *  per-game 値を setCharacterYRatio で受けて上書きする。未指定なら 1.0 で後方互換。 */
  private characterYRatio: number = CHARACTER_Y_RATIO
  /** 立ち絵の目標表示高さ比率 (#360)。null = 未設定＝原寸 (scale=1) で後方互換。
   *  frontmatter `character_height_ratio` 由来の per-game 値を setCharacterHeightRatio で受けて
   *  [CHARACTER_HEIGHT_RATIO_MIN, MAX] にクランプして保持する。設定時は loadTexture が
   *  computeTargetHeightScale で目標高さへ合わせる（fit=true の立ち絵は #294 優先で対象外）。 */
  private characterHeightRatio: number | null = null
  /** キャラごとの立ち絵目標表示高さ比率 override (#364)。キーはキャラクター表示名。
   *  frontmatter `character_height_ratios` 由来の per-character 値を setCharacterHeightRatios で
   *  受けて各値を [CHARACTER_HEIGHT_RATIO_MIN, MAX] にクランプして保持する。マップに無いキャラは
   *  characterHeightRatio（スクリプト単位）へフォールバックする（resolveCharacterHeightRatio）。
   *  未指定なら空 Record で後方互換。 */
  private characterHeightRatios: Record<string, number> = {}
  /** 立ち絵の元絵基準の一律スケール (#378)。null = 未設定＝下位優先順位
   *  （character_height_ratios > character_height_ratio > 原寸1）へフォールバック（後方互換）。
   *  frontmatter `character_scale` 由来の per-game 値を setCharacterScale で受けて
   *  [CHARACTER_SCALE_MIN, CHARACTER_SCALE_MAX] にクランプして保持する。設定時は loadTexture /
   *  reapplyCharacterHeightRatios が fit(#294) の次（最優先）で `sprite.scale = 値` を適用する。
   *  character_height_ratio(#360) が**画面基準**（表示高さ = 値 × screenHeight でテクスチャの縦pxを
   *  割り消し身長差を潰す）なのに対し、character_scale は**元絵基準**（表示px = 値 × texture.height）で
   *  元絵に焼き込んだ身長差をそのまま出す。 */
  private characterScale: number | null = null
  /** 立ち絵の新規表示・退場フェード時間（ms）。frontmatter `character_fade_ms` 由来。 */
  private characterFadeMs: number = DEFAULT_FADE_MS
  /** auto-scale 計算のために screenWidth / screenHeight を保持 */
  private readonly screenWidth: number
  private readonly screenHeight: number
  /** X 座標テーブル（screenWidth * CHARACTER_X_RATIO[pos]） */
  private readonly positionX: Record<string, number>
  /** タイマーの抽象化 (動画エクスポート用 virtual モード対応) */
  private readonly time: TimeController

  /**
   * @param screenWidth 論理画面幅（ASPECT_RATIOS から取得した値を渡す）
   * @param screenHeight 論理画面高さ（ASPECT_RATIOS から取得した値を渡す）
   */
  constructor(
    screenWidth: number,
    screenHeight: number,
    time: TimeController = defaultTimeController
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.time = time
    this.characterY = screenHeight * this.characterYRatio
    this.positionX = {
      left: screenWidth * CHARACTER_X_RATIO.left,
      center: screenWidth * CHARACTER_X_RATIO.center,
      right: screenWidth * CHARACTER_X_RATIO.right,
      off_left: screenWidth * CHARACTER_X_RATIO.off_left,
      off_right: screenWidth * CHARACTER_X_RATIO.off_right,
    }
  }

  /**
   * 足元 Y 比率を per-game 値で上書きする (#308)。
   * frontmatter `character_y_ratio:` の値を渡す。null/undefined のときは既定 CHARACTER_Y_RATIO (1.0)。
   *
   * 不正値（非有限＝NaN/Infinity）は既定 1.0 に倒し、範囲外（負・極端値）は
   * [CHARACTER_Y_RATIO_MIN, CHARACTER_Y_RATIO_MAX] = [0, 2] へクランプする（安全側フォールバック）。
   * 立ち絵配置は dialog_style: novel/adv 非依存（両モードで同じ足元）。
   *
   * NovelPlayer の init では setEvents/setScenes（＝最初の show）より前に呼ばれるため、
   * 通常は characterY の再計算だけで足りる。既に表示中の立ち絵がある場合に備え、
   * アニメ・nudge していない静的な sprite は新しい足元 Y に再ベースする（後から比率が変わっても破綻させない）。
   * 進行中（アニメ／nudge）の sprite は触らず、次の show で新しい足元 Y に揃う（`protagonist` と同じく動的変更は次の show から反映＝中間状態の焼き込みを避ける割り切り）。
   */
  setCharacterYRatio(ratio: number | null | undefined): void {
    const next =
      ratio == null || !Number.isFinite(ratio)
        ? CHARACTER_Y_RATIO
        : Math.min(CHARACTER_Y_RATIO_MAX, Math.max(CHARACTER_Y_RATIO_MIN, ratio))
    this.characterYRatio = next
    this.characterY = this.screenHeight * next
    // 既に表示中で、位置アニメ・ポーズ nudge が走っていない静的な立ち絵だけ新しい足元 Y へ再ベースする。
    // アニメ中の sprite を触ると中間状態を焼き込んでしまうため除外する（PoseNudge は baseY を持つので尊重）。
    for (const state of this.characters.values()) {
      if (state.animation === null && state.poseNudge === null) {
        state.sprite.y = this.characterY
      }
    }
  }

  /**
   * 名札ラベルを立ち絵 sprite の幅に収める (#275)。
   *
   * label.scale を一旦 1 に戻して natural width を測り、sprite 幅を超えていれば等比縮小する。
   * 収まっていれば等倍のまま（大きくしない）。label.anchor=(0.5,1) なので水平中央は sprite.x に追従する。
   * loadTexture（初回ロード・表情変更・2コマ切替）と setCharacterHeightRatio のライブ再スケール (#360) の
   * 両方から呼び、fit ロジックを一箇所に集約して重複を避ける（規律4）。label 無し・destroy 済みは no-op。
   */
  private fitLabelToSprite(sprite: Sprite, label: Text | undefined): void {
    if (!label || label.destroyed) return
    const spriteW = sprite.width
    label.scale.set(1, 1)
    const naturalW = label.width
    if (naturalW > spriteW && naturalW > 0) {
      const s = spriteW / naturalW
      label.scale.set(s, s)
    }
  }

  /**
   * 立ち絵の目標表示高さ比率を per-game 値で上書きする (#360)。
   * frontmatter `character_height_ratio:` の値を渡す。null/undefined/非有限は null（＝原寸 scale=1・後方互換）、
   * 有効値は [CHARACTER_HEIGHT_RATIO_MIN, CHARACTER_HEIGHT_RATIO_MAX] = [0.05, 2] へクランプして保持する。
   *
   * scale の実適用は loadTexture が担う（優先順位: fit(#294) > height_ratio > 原寸1）。ここで保持した
   * 値は次の show / 表情変更 / 2コマ切替の texture ロード時に反映される。
   *
   * setCharacterYRatio (#308) と対称に、既に表示中で位置アニメが走っておらず fit でない静的な
   * 立ち絵は、texture がロード済み（height>0）なら新しい target-height scale を即再適用する
   * （後から比率が変わっても破綻させない）。アニメ中・fit・render-only（Title/Label/Image）の
   * sprite は触らない（中間状態の焼き込み回避 / render-only は各自の sizing のまま #274）。
   */
  setCharacterHeightRatio(ratio: number | null | undefined): void {
    const next =
      ratio == null || !Number.isFinite(ratio)
        ? null
        : Math.min(CHARACTER_HEIGHT_RATIO_MAX, Math.max(CHARACTER_HEIGHT_RATIO_MIN, ratio))
    this.characterHeightRatio = next
    this.reapplyCharacterHeightRatios()
  }

  /**
   * キャラごとの立ち絵目標表示高さ比率 override を per-game 値で上書きする (#364)。
   * frontmatter `character_height_ratios:` から流した Record を渡す。null/undefined は空 Record
   * 扱い（＝マップ override なし・全キャラ character_height_ratio へフォールバック、後方互換）。
   *
   * setCharacterHeightRatio (#360) と同じ規約で、各値を [CHARACTER_HEIGHT_RATIO_MIN, MAX] へ
   * クランプする。非有限・非正の値は捨てる（そのキャラはマップ override なし扱いになり、
   * resolveCharacterHeightRatio 経由で character_height_ratio へフォールバックする）。
   *
   * setCharacterHeightRatio と同じくライブ再適用ロジックを共有する（reapplyCharacterHeightRatios）。
   */
  setCharacterHeightRatios(ratios: Record<string, number> | null | undefined): void {
    const next: Record<string, number> = {}
    if (ratios) {
      for (const [name, value] of Object.entries(ratios)) {
        if (Number.isFinite(value) && value > 0) {
          // #370: name はキャラ名（frontmatter 由来の自由文字列）。"__proto__" でも
          // own-property として書く（prototype pollution 回避）
          safeAssign(
            next,
            name,
            Math.min(CHARACTER_HEIGHT_RATIO_MAX, Math.max(CHARACTER_HEIGHT_RATIO_MIN, value))
          )
        }
      }
    }
    this.characterHeightRatios = next
    this.reapplyCharacterHeightRatios()
  }

  /**
   * 立ち絵の元絵基準スケール character_scale を per-game 値で上書きする (#378)。
   * frontmatter `character_scale:` の値を渡す。null/undefined/非有限/非正は null（＝未設定＝下位優先順位
   * (character_height_ratios > character_height_ratio > 原寸1) へフォールバック・後方互換）、有効値は
   * clampCharacterScale で [CHARACTER_SCALE_MIN, CHARACTER_SCALE_MAX] = [0.05, 4] へクランプして保持する。
   *
   * character_scale は**元絵基準**（sprite.scale = 値 ＝ 表示px = 値 × texture.height）で、**画面基準**の
   * character_height_ratio (#360, 表示高さ = 値 × screenHeight でテクスチャの縦pxを割り消す) と違い元絵の
   * 縦pxを割り消さない＝元絵に焼き込んだ身長差をそのまま出す。
   *
   * setCharacterHeightRatio (#360) と同じ構造で、保持後にライブ再適用する（reapplyCharacterHeightRatios）。
   * scale の実適用は loadTexture / reapplyCharacterHeightRatios が担う（優先順位: fit(#294) >
   * character_scale(#378) > height_ratios(#364) > height_ratio(#360) > 原寸1）。
   */
  setCharacterScale(scale: number | null | undefined): void {
    const next =
      scale == null || !Number.isFinite(scale) || scale <= 0 ? null : clampCharacterScale(scale)
    this.characterScale = next
    this.reapplyCharacterHeightRatios()
  }

  /**
   * 表示中の立ち絵に現在の characterScale (#378) / characterHeightRatio(s) を即再適用する (#360 / #364 / #378)。
   * setCharacterScale / setCharacterHeightRatio / setCharacterHeightRatios の共通ライブ再スケールロジック（規律4）。
   *
   * 既に表示中で位置アニメが走っておらず fit でない静的な立ち絵は、texture がロード済み
   * （height>0）なら新しい scale を即再適用する（後から値が変わっても破綻させない）。
   * loadTexture と同じ優先順位で決める: character_scale(#378, 元絵基準・sprite.scale=値) が最優先、
   * 無ければ character_height_ratios / character_height_ratio（画面基準・target-height scale）、
   * どちらも無ければ原寸 1。アニメ中・fit・render-only（Title/Label/Image）の sprite は触らない
   * （中間状態の焼き込み回避 / render-only は各自の sizing のまま #274）。
   */
  private reapplyCharacterHeightRatios(): void {
    for (const [name, state] of this.characters.entries()) {
      // render-only（Title/Label/Image #274）と fit（#294）・アニメ中の sprite は対象外。
      // クロスフェード中の旧 sprite（snapshotHidden、キーは `${character}__transition_N`）も対象外
      // （getCharacterStates と同じ理由 #337）。Map キーをそのまま名前として解決すると override
      // マップにヒットせず旧 sprite だけ既定比率にフォールバックし、新 sprite との間で一時的な
      // サイズ不一致が起きる。旧 sprite はまもなく破棄されるので再スケールする意味もない。
      if (state.renderOnly || state.fit || state.animation !== null || state.snapshotHidden)
        continue
      const texture = state.sprite.texture
      // texture 未ロード（height<=0）なら次の loadTexture に委ねる（ここでは触らない）。
      if (!texture || texture.height <= 0) continue
      // 優先順位 (#378): character_scale（元絵基準・既に [0.05,4] クランプ済み）> character_height_ratios /
      // character_height_ratio（画面基準）> 原寸 1。loadTexture の scale 決定分岐と同じ順序。
      let scale: number
      if (this.characterScale !== null) {
        scale = this.characterScale
      } else {
        const targetRatio = resolveCharacterHeightRatio(
          name,
          this.characterHeightRatios,
          this.characterHeightRatio
        )
        scale =
          targetRatio === null
            ? 1
            : computeTargetHeightScale(texture.height, targetRatio, this.screenHeight)
      }
      state.sprite.scale.set(scale)
      // sprite 幅が変わったので名札も追従して収め直す（縮んだ立ち絵から名札がはみ出さない #360）。
      this.fitLabelToSprite(state.sprite, state.label)
    }
  }

  /**
   * 立ち絵の新規表示・退場フェード時間を per-game 値で上書きする。
   * null/undefined/非有限値は既定 700ms (#407)、範囲外は [0, 5000] にクランプする。
   */
  setCharacterFadeMs(ms: number | null | undefined): void {
    const next =
      ms == null || !Number.isFinite(ms)
        ? DEFAULT_FADE_MS
        : Math.min(CHARACTER_FADE_MS_MAX, Math.max(CHARACTER_FADE_MS_MIN, Math.floor(ms)))
    this.characterFadeMs = next
  }

  private createPortraitState(
    character: string,
    expression: string,
    normalizedPosition: string,
    assetBaseUrl: string,
    targetX: number,
    fit: boolean,
    alpha: number,
    attached: boolean
  ): CharacterState {
    const sprite = new Sprite()
    sprite.anchor.set(0.5, 1)
    sprite.x = targetX
    sprite.y = this.characterY
    sprite.alpha = alpha

    let label: Text | undefined
    if (normalizedPosition === 'off_right' || normalizedPosition === 'off_left') {
      const labelFont = 'bellpoke_font, sans-serif'
      label = new Text({
        text: character,
        style: new TextStyle({ fontFamily: labelFont, fontSize: 48, fill: 0xffffff }),
      })
      label.anchor.set(0.5, 1)
      label.x = sprite.x
      label.y = this.screenHeight * 0.18
      label.alpha = alpha
      const labelRef = label
      void ensureFontLoaded(labelFont)
        .then(() => {
          if (labelRef.destroyed) return
          labelRef.style = new TextStyle({ fontFamily: labelFont, fontSize: 48, fill: 0xffffff })
        })
        .catch(() => {})
    }

    return {
      sprite,
      label,
      position: normalizedPosition,
      expression,
      assetBaseUrl,
      fit,
      animation: null,
      poseNudge: null,
      fadeAnimation: null,
      textEffect: null,
      underline: null,
      attached,
    }
  }

  private attachCharacterState(state: CharacterState): void {
    state.attached = true
    if (!state.sprite.parent) this.addChild(state.sprite)
    if (state.label && !state.label.parent) this.addChild(state.label)
  }

  private destroyCharacterState(state: CharacterState): void {
    if (state.idleIntervalId) {
      this.time.clearInterval(state.idleIntervalId)
      state.idleIntervalId = undefined
    }
    this.clearTextEffect(state)
    this.clearUnderline(state)
    this.clearMask(state)
    state.sprite.removeFromParent()
    state.sprite.destroy()
    if (state.label) {
      state.label.removeFromParent()
      state.label.destroy()
      state.label = undefined
    }
  }

  private startFade(
    state: CharacterState,
    fromAlpha: number,
    toAlpha: number,
    destroyOnComplete: boolean,
    onComplete?: () => void
  ): void {
    state.fadeAnimation = {
      startMs: this.elapsedMs,
      durationMs: this.characterFadeMs,
      fromAlpha,
      toAlpha,
      destroyOnComplete,
      onComplete,
    }
    this.ensureTicker()
  }

  private nextTransitionName(character: string): string {
    this.transitionSerial += 1
    return `${character}__transition_${this.transitionSerial}`
  }

  /**
   * キャラクター立ち絵を表示する。既に表示中なら position / expression を更新する。
   *
   * 新規表示時は alpha 0 から DEFAULT_FADE_MS かけてフェードインする（#177）。
   * セーブからの復元やスキップモードなど瞬時表示が望ましい場合は `options.instant: true` を渡す。
   * 退場アニメ中の同名キャラを再 show すると、フェードアウトを取り消してフェードインに切り替える。
   *
   * フェードイン進行中（destroyOnComplete=false）の同名キャラへの再 show は、position / expression
   * が同じなら no-op、異なれば即時切替（フェード進行はそのまま継続）。フェード自体を再起動する
   * ユースケースは現状想定していないため、明示的な「フェードリスタート」API は持たない。
   */
  show(
    character: string,
    expression: string,
    position: string,
    assetBaseUrl: string,
    options?: { instant?: boolean; xRatio?: number; fit?: boolean; onReady?: () => void }
  ): void {
    // onReady (#293): 立ち絵の用意（テクスチャ load 完了／texture 不要な早期 return）が済んだら
    // 1回だけ呼ぶフック。NovelRenderer が forward novel でテキスト reveal をこの完了に揃え、
    // 「立ち絵 →（同時/直後に）テキスト」を保証する。texture を再ロードしない経路では同期発火する。
    const onReady = options?.onReady
    // 明示フィット (#294)。脚本の話者行 `フィット` 由来。既定 false（原寸）。
    const fit = options?.fit === true
    const normalizedPosition = normalizePosition(position)
    const instant = options?.instant === true
    // novel 役割配置 (#286): xRatio override があれば positionX テーブルでなく
    // screenWidth * xRatio で水平位置を決める。position 文字列（snapshot/復元用の正本トークン）は
    // 据え置き、見た目の x だけを役割（質問役=左 / 回答役=右）に合わせる。
    const hasXOverride = options?.xRatio !== undefined && Number.isFinite(options.xRatio)
    const overrideX = hasXOverride ? this.screenWidth * (options?.xRatio as number) : undefined
    // この show が立ち絵を置く先の水平座標 (#303)。override x > position トークン > center の順で解決する。
    // 「1 位置に 1 キャラ」を保証するため、別キャラがこの x を占有していたら退場させる判定に使う。
    // own-property のみ見る (#368)。素朴な `this.positionX[normalizedPosition]` は Object.prototype
    // も辿ってしまい、normalizedPosition が `constructor` 等と一致すると `??` のフォールバックが
    // 発火せず関数オブジェクトを返してしまう。
    const targetX =
      overrideX ??
      (hasOwn(this.positionX, normalizedPosition)
        ? this.positionX[normalizedPosition]
        : this.positionX['center'])
    const existing = this.characters.get(character)

    if (existing) {
      // 退場フェード中の再 show: フェードアウトを取り消して再フェードイン（または即時表示）に倒す
      if (existing.fadeAnimation?.destroyOnComplete) {
        if (instant || this.characterFadeMs <= 0) {
          existing.sprite.alpha = 1
          existing.fadeAnimation = null
        } else {
          this.startFade(existing, existing.sprite.alpha, 1, false)
        }
      }

      // novel 役割配置 (#286): override x がある再 show は、現在の sprite.x と違えば
      // 「横位置変更あり」とみなす（position トークンは同じでも質問役↔回答役の入替で x が動く）。
      // override 無しの従来呼び出しでは、position トークン未変化なら x を触らない（#134 の
      // [アニメ] で動かした立ち絵を再 show で勝手に戻さない adv 非回帰のため、override 時だけ判定する）。
      const overrideXChanged =
        hasXOverride && Math.abs(existing.sprite.x - (overrideX as number)) >= 0.5

      // 表情が同じで位置も同じ、フィット指定も同じなら何もしない（フェード状態は上で解消済み）。
      // フィット (#294) が変化したら texture を再ロードして scale を取り直す必要があるので、
      // 早期 return の条件に fit 一致も含める。
      if (
        existing.expression === expression &&
        existing.position === normalizedPosition &&
        existing.fit === fit &&
        !overrideXChanged
      ) {
        // no-op（立ち絵は既に表示済み）。texture を待つ必要はないので即 ready (#293)。
        onReady?.()
        return
      }

      // 位置変更（position トークンの変化、または override x の変化）。
      // x（見た目の横座標）と position（正本トークン）は別の関心事なので更新を分ける (N2)。
      // 旧実装は overrideXChanged だけ（position トークンは同一）のとき `existing.position` への
      // 再代入が no-op になっていた。position は実際に変化したときだけ更新して意図を明確にする。
      const positionChanged = existing.position !== normalizedPosition
      const textureChanged = existing.expression !== expression || existing.fit !== fit
      if (textureChanged && !instant && this.characterFadeMs > 0) {
        // 同一人物の表情・ポーズ/fit 変更は旧 sprite を即 texture 差し替えせず、
        // 旧 sprite と新 sprite を重ねて同時クロスフェードする (#337)。
        if (positionChanged || overrideXChanged) {
          this.evictCollidersAt(targetX, character, instant)
        }
        if (existing.idleIntervalId) {
          this.time.clearInterval(existing.idleIntervalId)
          existing.idleIntervalId = undefined
        }

        const oldKey = this.nextTransitionName(character)
        existing.snapshotHidden = true
        this.characters.delete(character)
        this.characters.set(oldKey, existing)

        const nextState = this.createPortraitState(
          character,
          expression,
          normalizedPosition,
          assetBaseUrl,
          targetX,
          fit,
          0,
          true
        )
        this.attachCharacterState(nextState)
        this.characters.set(character, nextState)

        void this.loadTexture(
          nextState.sprite,
          character,
          expression,
          assetBaseUrl,
          nextState.label,
          fit,
          onReady
        ).then((loaded) => {
          if (this.characters.get(character) !== nextState) return
          if (this.characters.get(oldKey) !== existing) return
          if (!loaded && assetBaseUrl) {
            this.destroyCharacterState(nextState)
            this.characters.delete(character)
            existing.fadeAnimation = null
            existing.snapshotHidden = false
            existing.sprite.alpha = 1
            this.characters.delete(oldKey)
            this.characters.set(character, existing)
            return
          }
          this.startFade(existing, existing.sprite.alpha, 0, true)
          this.startFade(nextState, 0, 1, false)
        })
        return
      }

      if (positionChanged || overrideXChanged) {
        // 1 位置 1 キャラ (#303): 移動先 x を別キャラが占有していたら退場させる。
        // 自分自身（character）と renderOnly（Title/Label/Image）は対象外。
        this.evictCollidersAt(targetX, character, instant)
        existing.sprite.x = targetX
      }
      if (positionChanged) {
        existing.position = normalizedPosition
      }

      // 表情変更・またはフィット指定変更 (#294) のとき texture を再ロードする。
      // どちらの場合も loadTexture が最新の fit に基づいて scale を取り直す
      // （表情据え置きでフィットだけ変わったケースも再ロードで反映する）。
      if (textureChanged) {
        existing.fit = fit
        // texture 再ロード経路では onReady を loadTexture に委ねる（load 完了/失敗で発火）(#293)。
        void this.loadTexture(
          existing.sprite,
          character,
          expression,
          assetBaseUrl,
          existing.label,
          fit,
          onReady
        )
        existing.expression = expression
      } else {
        // 位置/x だけの変更（texture 据え置き）。待つ必要はないので即 ready (#293)。
        onReady?.()
      }
      return
    }

    const shouldFade = !instant && this.characterFadeMs > 0
    const state = this.createPortraitState(
      character,
      expression,
      normalizedPosition,
      assetBaseUrl,
      targetX,
      fit,
      shouldFade ? 0 : 1,
      false
    )
    this.characters.set(character, state)
    let entranceStarted = false
    let collidersGone = false
    let textureReady = false
    let textureLoaded = false
    const attachEntrance = () => {
      if (entranceStarted) return
      entranceStarted = true
      this.attachCharacterState(state)
      if (shouldFade) {
        this.startFade(state, 0, 1, false)
      }
    }
    const startEntrance = () => {
      if (entranceStarted) return
      if (!collidersGone || !textureReady) return
      if (this.characters.get(character) !== state) return
      if (!textureLoaded && assetBaseUrl) return
      attachEntrance()
    }
    const colliderCount = this.evictCollidersAt(targetX, character, instant, () => {
      collidersGone = true
      startEntrance()
    })
    if (instant) {
      // instant 表示（skip / 復元）は texture を待たず即出す。
      collidersGone = true
      attachEntrance()
    } else if (colliderCount === 0) {
      // 退場対象がいない新規立ち絵でも、フェードインは texture load 完了後に始める (#17)。
      // 直接 attachEntrance すると、texture 読込が fade より遅い初回（コールドキャッシュ）で
      // alpha が 1 に達し切ってから texture が現れ、フェードが見えず突然出る（例: 本編入口で
      // 初出の司会。ハブに居らず退場衝突が無いため colliderCount===0 でこの経路を踏む）。
      // colliderCount>0 の経路（上の evict コールバック）と同じく startEntrance で texture-gate する。
      // collidersGone は evictCollidersAt が count===0 で onComplete を同期発火して既に true。
      startEntrance()
    }
    // 新規立ち絵: texture load 完了/失敗で onReady を発火（#293）。これでテキスト reveal が
    // 立ち絵の用意完了に揃う。
    void this.loadTexture(
      state.sprite,
      character,
      expression,
      assetBaseUrl,
      state.label,
      fit,
      onReady
    ).then((loaded) => {
      textureReady = true
      textureLoaded = loaded
      startEntrance()
    })
  }

  /**
   * 進行中の transform アニメーション (animate()) が走っている間だけ
   * `-a` / `-b` を 1 秒ごとに交互させる。停止状態では `-a` 固定。
   * 呼び出し側は animate() の開始/終了タイミングで呼ぶ。
   */
  private startIdleCycle(character: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state || state.idleIntervalId) return
    const match = state.expression.match(/^(.+)-a$/)
    if (!match) return
    const basename = match[1]
    let frame: 'a' | 'b' = 'a'
    const intervalId = this.time.setInterval(() => {
      const cur = this.characters.get(character)
      if (!cur || cur.sprite.destroyed) {
        this.time.clearInterval(intervalId)
        return
      }
      frame = frame === 'a' ? 'b' : 'a'
      const nextExpression = `${basename}-${frame}`
      cur.expression = nextExpression
      // 2コマ自動切替でも fit (#294) を維持する。
      void this.loadTexture(cur.sprite, character, nextExpression, assetBaseUrl, cur.label, cur.fit)
    }, 1000)
    state.idleIntervalId = intervalId
  }

  private stopIdleCycle(character: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state || !state.idleIntervalId) return
    this.time.clearInterval(state.idleIntervalId)
    state.idleIntervalId = undefined
    // 停止後は必ず -a に戻す
    const match = state.expression.match(/^(.+)-[ab]$/)
    if (match) {
      const aExpression = `${match[1]}-a`
      if (state.expression !== aExpression) {
        state.expression = aExpression
        // idle cycle 停止で -a に戻すときも fit (#294) を維持する。
        void this.loadTexture(
          state.sprite,
          character,
          aExpression,
          assetBaseUrl,
          state.label,
          state.fit
        )
      }
    }
  }

  /**
   * 動画タイトルを画面中央に表示する。
   * 既に Title があれば text を差し替える。空文字なら即時退場。
   * `[アニメ target=Title]` で普通の立ち絵と同じ規則で動かせる。
   */
  showTitle(
    text: string,
    fontFamily: string,
    position?: string,
    color?: string,
    // 文字サイズ・位置 override (#275)。size 未指定は既定 64。x/y は position トークンより優先。
    opts?: { size?: number; x?: number; y?: number }
  ): void {
    const NAME = 'Title'
    // タイトル文字色を解決する (#273)。未指定・不正値は白 (TITLE_FILL) にフォールバック。
    // この色を label・グリフ演出 (爆発)・カーソルの全てで使い、紺タイトルを一貫させる。
    const fill = parseColorToNumber(color, CharacterLayer.TITLE_FILL)
    // 文字サイズ (#275)。未指定は従来どおり既定 64。グリフ演出のグリフも同 size を使う。
    const fontSize = opts?.size ?? CharacterLayer.TITLE_FONT_SIZE
    // x/y 数値 override があるか（軸いずれかが有効値なら override 経路で位置決定する）(#275)。
    const hasPosOverride = opts?.x !== undefined || opts?.y !== undefined
    const existing = this.characters.get(NAME)
    if (text.length === 0) {
      if (existing) this.remove(NAME, { instant: true })
      return
    }
    if (existing) {
      // テキスト差し替え時は進行中のグリフ演出を破棄し、単一 label 表示へ戻す。
      // （グリフは古いテキストのままなので残すと不整合になる）#268
      this.clearTextEffect(existing)
      // 下線も対象テキスト幅に依存するため破棄する（#270）。
      this.clearUnderline(existing)
      // テキスト差し替え時は色も更新する（#273）。後続のグリフ演出・カーソルに波及させる。
      existing.titleColor = fill
      // フォントサイズも反映する (#275)。後続のグリフ演出・カーソル高さに波及する。
      existing.titleFontSize = fontSize
      if (existing.label && !existing.label.destroyed) {
        existing.label.text = text
        existing.label.style = new TextStyle({ fontFamily, fontSize, fill })
        existing.label.visible = true
      }
      // x/y override 指定時は ratio 解決で再配置する (#275)。トークンのみの再配置は従来 positionX 経路。
      if (hasPosOverride) {
        const { xRatio, yRatio } = resolvePositionWithOverride(position, opts?.x, opts?.y)
        const newX = this.screenWidth * xRatio
        const newY = this.screenHeight * yRatio
        existing.sprite.x = newX
        existing.sprite.y = newY
        if (existing.label && !existing.label.destroyed) {
          existing.label.x = newX
          existing.label.y = newY
        }
        existing.position = position ? normalizePosition(position) : existing.position
        existing.animation = null
      } else if (position) {
        // position が指定されていれば再配置する (再度別 position から登場させる用途)
        const normalized = normalizePosition(position)
        // own-property のみ見る (#368)。理由は show() 側の targetX 解決コメントと同様。
        const newX = hasOwn(this.positionX, normalized)
          ? this.positionX[normalized]
          : this.screenWidth * 0.5
        existing.sprite.x = newX
        if (existing.label && !existing.label.destroyed) {
          existing.label.x = newX
        }
        existing.position = normalized
        // 進行中の transform アニメがあれば破棄 (位置が壊れるので)
        existing.animation = null
      }
      return
    }
    // sprite は不可視 (no texture) のアンカー。CharacterState を保つために置く。
    const normalizedPosition = position ? normalizePosition(position) : 'center'
    // 位置はトークン（縦＋横の 2D）＋数値 x/y override を一括で解決する (#274/#275)。
    // ラベル・画像（showLabel/showImage）と同じ resolvePositionWithOverride に揃え、タイトルにも
    // 縦位置トークン（`位置=中下` 等＝opening.html の縦スタック内のツール名）を効かせる。
    // 左/中央/右の xRatio は立ち絵 positionX（CHARACTER_X_RATIO 0.1875/0.5/0.8125）と同値なので横位置は無回帰。
    const { xRatio, yRatio } = resolvePositionWithOverride(position, opts?.x, opts?.y)
    const initialX = this.screenWidth * xRatio
    const initialY = this.screenHeight * yRatio
    const sprite = new Sprite()
    sprite.x = initialX
    sprite.y = initialY
    sprite.alpha = 1
    this.addChild(sprite)

    const label = new Text({
      text,
      style: new TextStyle({ fontFamily, fontSize, fill }),
    })
    label.anchor.set(0.5, 0.5)
    label.x = sprite.x
    label.y = sprite.y
    this.addChild(label)
    // フォントが Google Fonts / @font-face で非同期ロードの場合、初回は fallback で
    // ベイクされるため、ロード完了後に style を再適用してグリフを差し替える
    void ensureFontLoaded(fontFamily)
      .then(() => {
        if (label.destroyed) return
        label.style = new TextStyle({ fontFamily, fontSize, fill })
      })
      .catch(() => {})

    this.characters.set(NAME, {
      sprite,
      label,
      position: normalizedPosition,
      expression: '',
      assetBaseUrl: '',
      // render-only（タイトル）はフィット対象外。常に原寸 (#294)。
      fit: false,
      animation: null,
      poseNudge: null,
      fadeAnimation: null,
      textEffect: null,
      underline: null,
      // 解決済みタイトル色 (#273)。グリフ演出・カーソルへ波及させるため state に保持する。
      titleColor: fill,
      // 解決済みタイトル文字サイズ (#275)。グリフ演出・カーソル高さへ波及させるため state に保持する。
      titleFontSize: fontSize,
      // 演出表示 (#274)。snapshot に漏らさない（getCharacterStates が除外）。
      renderOnly: true,
    })
  }

  /**
   * 単独の色付きラベルを表示する (#274)。
   *
   * orber OP タイトルカードの肩書 / 名前のような、立ち絵に紐付かない単独テキストを 2D 位置に出す。
   * Title と同様アンカー sprite + Text の構成で `characters` マップに id（既定 "Label"）で登録するため、
   * 後続の `[文字演出: id]` / `[下線: id]` / `[アニメ: target=id]` の対象になれる。
   * 既に同 id があれば text / 色 / 位置 / サイズを差し替える。空文字なら即時退場。
   * 登場時は alpha 0 → 1 のフェードイン（opening.html の fadeIn 相当）。render-only。
   */
  showLabel(opts: {
    id?: string
    text: string
    color?: string
    position?: string
    size?: number
    fontFamily: string
    instant?: boolean
    /** テキスト揃え (#275)。`left`/`center`/`right`。未指定は中央。 */
    align?: string
    /** 隣接配置 (#275)。参照ラベル id の右端にこの左端を接続。指定時は自動で左揃え。 */
    after?: string
    /** 横位置 override (0..1) (#275)。position トークンより優先。 */
    x?: number
    /** 縦位置 override (0..1) (#275)。 */
    y?: number
  }): void {
    const NAME = opts.id ?? 'Label'
    const fill = parseColorToNumber(opts.color, 0xffffff)
    const fontSize = opts.size ?? 24
    // `後ろ=` 指定ラベルは右へ伸びる前提なので自動で左揃え（anchor.x=0）にする (#275)。
    // それ以外は `揃え=` 由来の anchor を使う（未指定は中央 0.5 = 現状維持）。
    const anchorX = opts.after !== undefined ? 0 : alignToAnchorX(opts.align)
    const instant = opts.instant === true

    // 位置: x/y 数値 override が position トークンより優先 (#275)。
    const { xRatio, yRatio } = resolvePositionWithOverride(opts.position, opts.x, opts.y)
    let x = this.screenWidth * xRatio
    let y = this.screenHeight * yRatio
    // 隣接配置 (#275): 参照ラベルがあればその右端をこのラベルの左端に合わせ、y も揃える。
    // 参照が無い/まだ表示前ならフォールバック（上で算出した通常配置のまま）。
    if (opts.after !== undefined) {
      const adj = this.computeAfterAnchor(opts.after)
      if (adj) {
        x = adj.x
        y = adj.y
      }
    }

    const existing = this.characters.get(NAME)
    if (opts.text.length === 0) {
      if (existing) this.remove(NAME, { instant: true })
      return
    }
    if (existing) {
      // 差し替え時は進行中のグリフ演出・下線を破棄（テキスト/幅が変わるため不整合になる）。
      this.clearTextEffect(existing)
      this.clearUnderline(existing)
      existing.sprite.x = x
      existing.sprite.y = y
      existing.anchorX = anchorX
      if (existing.label && !existing.label.destroyed) {
        existing.label.text = opts.text
        existing.label.style = new TextStyle({
          fontFamily: opts.fontFamily,
          fontSize,
          fill,
        })
        existing.label.anchor.set(anchorX, 0.5)
        existing.label.x = x
        existing.label.y = y
        existing.label.visible = true
      }
      // showImage 再表示パスと対称に position も更新する（render-only で復元非使用だが対称性のため）。
      existing.position = opts.position ?? ''
      existing.titleColor = fill
      // ラベルのフォントサイズをグリフ演出・カーソルに波及させる (#275)。
      // 立ち絵 Title (64) と違いラベルは小さめ（既定 24）なので、演出グリフも同 size に揃える。
      existing.titleFontSize = fontSize
      return
    }

    // sprite は不可視 (no texture) のアンカー。Title と同形で CharacterState を保つために置く。
    const sprite = new Sprite()
    sprite.x = x
    sprite.y = y
    sprite.alpha = instant ? 1 : 0
    this.addChild(sprite)

    const label = new Text({
      text: opts.text,
      style: new TextStyle({ fontFamily: opts.fontFamily, fontSize, fill }),
    })
    // 揃えに応じた anchor.x（左=0/中央=0.5/右=1）。静止ラベルはこれだけで左/右に寄る。
    label.anchor.set(anchorX, 0.5)
    label.x = x
    label.y = y
    label.alpha = instant ? 1 : 0
    this.addChild(label)
    void ensureFontLoaded(opts.fontFamily)
      .then(() => {
        if (label.destroyed) return
        label.style = new TextStyle({ fontFamily: opts.fontFamily, fontSize, fill })
      })
      .catch(() => {})

    const state: CharacterState = {
      sprite,
      label,
      position: opts.position ?? '',
      expression: '',
      assetBaseUrl: '',
      // render-only（ラベル/タイトル）はフィット対象外。常に原寸 (#294)。
      fit: false,
      animation: null,
      poseNudge: null,
      fadeAnimation: instant
        ? null
        : {
            startMs: this.elapsedMs,
            durationMs: TITLE_CARD_FADE_MS,
            fromAlpha: 0,
            toAlpha: 1,
            destroyOnComplete: false,
          },
      textEffect: null,
      underline: null,
      // 文字色をグリフ演出・カーソルに波及させる（Title と同じ役割）。
      titleColor: fill,
      // ラベルのフォントサイズをグリフ演出・カーソルに波及させる (#275)。既定 24。
      titleFontSize: fontSize,
      // 演出表示 (#274)。snapshot に漏らさない。
      renderOnly: true,
      // 揃え (#275)。グリフ演出オフセット・カーソル位置が参照する。
      anchorX,
    }
    this.characters.set(NAME, state)
    if (state.fadeAnimation) this.ensureTicker()
  }

  /**
   * 単独の画像を表示する (#274)。
   *
   * orber OP タイトルカードのアバターのような、立ち絵（show）に紐付かない単独画像を 2D 位置に出す。
   * `characters` マップに id（既定 "Image"）で登録され `[アニメ: target=id]` 等の対象になれる。
   * テクスチャは背景画像と同じく `resolveAssetUrl(base, 'images', path)` から load する。
   * `shape==='円形'/'circle'` のとき直径 = 表示サイズの円形マスクを sprite にかける。
   * 登場時は alpha 0 → 1 のフェードイン（label と同じ）。render-only。
   */
  showImage(opts: {
    id?: string
    path: string
    position?: string
    shape?: string
    size?: number
    assetBaseUrl: string
    instant?: boolean
    /** 横位置 override (0..1) (#275)。position トークンより優先。 */
    x?: number
    /** 縦位置 override (0..1) (#275)。 */
    y?: number
  }): void {
    const NAME = opts.id ?? 'Image'
    // 位置: x/y 数値 override が position トークンより優先 (#275)。
    const { xRatio, yRatio } = resolvePositionWithOverride(opts.position, opts.x, opts.y)
    const x = this.screenWidth * xRatio
    const y = this.screenHeight * yRatio
    const instant = opts.instant === true
    const circular = opts.shape === '円形' || opts.shape === 'circle'

    const existing = this.characters.get(NAME)
    if (existing) {
      // 同 id 再表示は位置のみ更新する（テクスチャ差し替えは想定しないため最小挙動）。
      existing.sprite.x = x
      existing.sprite.y = y
      existing.position = opts.position ?? ''
      return
    }

    const sprite = new Sprite()
    sprite.anchor.set(0.5, 0.5)
    sprite.x = x
    sprite.y = y
    sprite.alpha = instant ? 1 : 0
    this.addChild(sprite)

    const state: CharacterState = {
      sprite,
      label: undefined,
      position: opts.position ?? '',
      expression: '',
      assetBaseUrl: opts.assetBaseUrl,
      // render-only（単独画像 #274）はフィット対象外。表示は showImage 専用の sizing に従う。
      fit: false,
      animation: null,
      poseNudge: null,
      fadeAnimation: instant
        ? null
        : {
            startMs: this.elapsedMs,
            durationMs: TITLE_CARD_FADE_MS,
            fromAlpha: 0,
            toAlpha: 1,
            destroyOnComplete: false,
          },
      textEffect: null,
      underline: null,
      renderOnly: true,
    }
    this.characters.set(NAME, state)
    if (state.fadeAnimation) this.ensureTicker()

    // 任意ファイル名パスの url 解決は背景画像と同じ resolveAssetUrl 経由（#274）。
    const url = resolveAssetUrl(opts.assetBaseUrl, 'images', opts.path)
    Assets.load(url)
      .then((texture) => {
        if (sprite.destroyed) return
        sprite.texture = texture
        // 表示サイズ: size 指定時はその幅にアスペクト維持でスケール。未指定は自然サイズ。
        let displayWidth = texture.width
        if (opts.size !== undefined && texture.width > 0) {
          const scale = opts.size / texture.width
          sprite.scale.set(scale, scale)
          displayWidth = opts.size
        } else {
          sprite.scale.set(1, 1)
        }
        // 円形マスク: 直径 = 表示サイズ（幅）。anchor 0.5 なので中心は sprite 原点。
        // mask はローカルではなくステージ座標で評価されるため、sprite と同じ位置・スケールに置く。
        if (circular) {
          const radius = displayWidth / 2
          const mask = new Graphics()
          mask.circle(0, 0, radius).fill(0xffffff)
          // mask は scale 後の sprite に対してローカル座標で当てる。sprite.scale が効くよう
          // mask を sprite の子にし、scale を打ち消す（mask の半径は表示 px で描いているため）。
          mask.x = 0
          mask.y = 0
          if (sprite.scale.x !== 0) {
            mask.scale.set(1 / sprite.scale.x, 1 / sprite.scale.y)
          }
          sprite.addChild(mask)
          sprite.mask = mask
          const st = this.characters.get(NAME)
          if (st) st.maskGraphics = mask
        }
      })
      .catch((err) => {
        console.warn('[name-name] 画像の読み込みに失敗: ' + url, err)
      })
  }

  /**
   * 表情のみを差し替える（位置はそのまま）
   */
  changeExpression(character: string, expression: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state) return
    if (state.expression === expression) return
    state.expression = expression
    // 表情のみ差し替えでも fit (#294) を維持する。
    void this.loadTexture(state.sprite, character, expression, assetBaseUrl, state.label, state.fit)
  }

  /**
   * キャラクター（または立ち絵スロット内のオブジェクト）にアニメーションを適用する (#134)。
   *
   * fire-and-forget: 呼び出し側はアニメ完了を待たずに次のイベントへ進める。
   * 子供向け動画用途で「車が回転しながら横移動」「寿司が降ってくる」等を実現。
   *
   * 既存アニメーションがあれば現在位置を起点に上書きする。
   *
   * @param character ターゲット名 (show で使った character 名と一致)
   * @param params アニメパラメータ
   */
  animate(character: string, params: AnimateParams): void {
    const state = this.characters.get(character)
    if (!state) return
    const sprite = state.sprite
    // 話者交代 nudge (#286) が進行中なら、その baseY へ戻してから animate を起こす。
    // mid-lift の y を起点にすると以後の dy 相対計算がずれるため、nudge を畳んで基準を確定する。
    if (state.poseNudge) {
      sprite.y = state.poseNudge.baseY
      state.poseNudge = null
    }
    const fromX = sprite.x
    const fromY = sprite.y
    const fromRotation = sprite.rotation
    const fromScale = sprite.scale.x // x/y 等しい想定 (uniform scale)

    // resolveDelta は数値文字列を相対/絶対解釈して target を返す
    const toX = resolveDelta(params.dx, fromX)
    const toY = resolveDelta(params.dy, fromY)
    // rotation はパーサー側で度数。PixiJS は radian なので変換
    const targetDegrees = resolveDelta(params.rotation, (fromRotation * 180) / Math.PI)
    const toRotation = (targetDegrees * Math.PI) / 180
    const toScale = params.scale !== undefined ? params.scale : fromScale

    const durationMs = Math.max(0, params.duration_ms | 0)
    if (durationMs === 0) {
      // 即時適用
      sprite.x = toX
      sprite.y = toY
      sprite.rotation = toRotation
      sprite.scale.set(toScale, toScale)
      state.animation = null
      this.maybeStopTicker()
      return
    }

    state.animation = {
      startMs: this.elapsedMs,
      durationMs,
      easing: params.easing ?? 'Linear',
      fromX,
      fromY,
      fromRotation,
      fromScale,
      toX,
      toY,
      toRotation,
      toScale,
    }
    // アニメ開始時に 2 コマ idle を回す（停止時は -a 固定なので、ここで切替を始める）
    this.startIdleCycle(character, state.assetBaseUrl)
    this.ensureTicker()
  }

  /** タイトル label の現在のフォント・サイズ・色を引き継ぐための定数。 */
  private static readonly TITLE_FONT_SIZE = 64
  private static readonly TITLE_FILL = 0xffffff

  /** 話者交代ポーズ変化 (#286) の持ち上げ量（px）と所要 ms。控えめな「ぴょこっ」。 */
  private static readonly POSE_NUDGE_LIFT_PX = 24
  private static readonly POSE_NUDGE_MS = 280

  /**
   * 話者交代のポーズ変化 (#286)。
   *
   * 名札を出さない novel スタイルで「今この人が喋っている」を立ち絵で示すため、対象立ち絵を
   * 軽く持ち上げて元に戻す自己復帰アニメをかける。NovelRenderer が話者交代を検出したときに
   * #283 の scrim 自動退避と一緒に呼ぶ（新規の重い演出は作らない）。
   *
   * fire-and-forget。対象が居ない / sprite 破棄済みなら no-op。連続呼び出しは前回の baseY を
   * 引き継いで上書きする（1 文ごとの高速入替でも例外を吐かず破綻しない）。
   */
  nudgePose(character: string): void {
    const state = this.characters.get(character)
    if (!state || state.sprite.destroyed) return
    // 連続 nudge: 既に nudge 中なら、焼き込まれていない元の baseY を引き継ぐ
    // （sprite.y には現在のオフセット込みの値が入っているため、それを基準にしない）。
    const baseY = state.poseNudge ? state.poseNudge.baseY : state.sprite.y
    state.poseNudge = {
      startMs: this.elapsedMs,
      durationMs: CharacterLayer.POSE_NUDGE_MS,
      liftPx: CharacterLayer.POSE_NUDGE_LIFT_PX,
      baseY,
    }
    this.ensureTicker()
  }

  /**
   * テスト用 (#286): 指定キャラの pose nudge 状態を観測する。
   * 進行中なら `{ active: true, baseY }`、無ければ `null`。jsdom では ticker が回らないため
   * 「nudge がセットされたか」「baseY が正しいか」を観測点として使う（描画ピクセルは不可）。
   */
  getPoseNudgeState(character: string): { active: boolean; baseY: number } | null {
    const state = this.characters.get(character)
    if (!state || !state.poseNudge) return null
    return { active: true, baseY: state.poseNudge.baseY }
  }

  /**
   * テスト用 (#286): 指定キャラの現在 sprite x / y を観測する。
   * 役割配置（質問役=左 / 回答役=右）の検証に使う。存在しなければ null。
   */
  getSpritePosition(character: string): { x: number; y: number } | null {
    const state = this.characters.get(character)
    if (!state) return null
    return { x: state.sprite.x, y: state.sprite.y }
  }

  /**
   * グリフ Text の表示幅を測る。PixiJS のテキスト計測に依存する。
   *
   * canvas が無い環境（jsdom など計測不能・非有限値・0 幅）では fontSize ベースの
   * 近似 advance（全角想定で fontSize * 0.6）にフォールバックする。レイアウトが
   * 0 幅で潰れて全グリフが重なる事故を防ぐ防御。実ブラウザでは正しい幅が返る。
   */
  private measureGlyphWidth(t: Text): number {
    let w = 0
    try {
      w = t.width
    } catch {
      w = 0
    }
    if (!Number.isFinite(w) || w <= 0) {
      return CharacterLayer.TITLE_FONT_SIZE * 0.6
    }
    return w
  }

  /**
   * 隣接配置 (#275) の接続点を計算する。`後ろ=<refId>` のラベルが参照ラベルの右端に
   * 左端を合わせるための (x, y) を返す。参照が存在しない / label が無い場合は null
   * （呼び出し側は通常配置にフォールバック＝落ちない）。
   *
   * 参照ラベルの右端 x = `参照 sprite.x + (1 - refAnchorX) * refWidth`:
   *  - 参照が左揃え（anchorX=0）なら sprite.x が左端なので 右端 = x + width。
   *  - 参照が中央（anchorX=0.5）なら 右端 = x + width/2。
   *  - 参照が右揃え（anchorX=1）なら sprite.x が右端なので 右端 = x。
   * 幅は参照ラベルの実 measure 幅（グリフ演出中なら見た目はグリフ群だが、幅はソース text の
   * measure 幅で近似する。measure 不能環境では measureGlyphWidth がフォントサイズ近似に倒す）。
   * y は同 y にする（Issue: プロンプトとコマンドは同じ行）。
   */
  private computeAfterAnchor(refId: string): { x: number; y: number } | null {
    const ref = this.characters.get(refId)
    if (!ref || !ref.label || ref.label.destroyed) return null
    const refWidth = this.measureGlyphWidth(ref.label)
    const refAnchorX = ref.anchorX ?? 0.5
    const rightEdge = ref.sprite.x + (1 - refAnchorX) * refWidth
    return { x: rightEdge, y: ref.sprite.y }
  }

  /**
   * グリフ単位の文字演出を適用する (#268)。
   *
   * 対象（CharacterLayer 上の identifier。例 "Title"）の label をグリフ Text 列に
   * 分解して同位置にレイアウトし、ticker で各グリフを `i*間隔` 遅延の enter アニメ。
   * reveal 系（タイプ）は typewriter.ts を this.time 駆動で 1 文字ずつ表示。
   *
   * fire-and-forget: 呼び出し側は完了を待たず次イベントへ進む。
   * 効果完了後も container を保持するため、後続 `[アニメ target=Title]` が効く。
   *
   * @param instant true なら即時完了状態（全グリフ整列・不透明）にする。
   *   セーブ復元・スキップ時に演出を飛ばすため（ADR 0002: 中間状態を持たない）。
   * @returns フォント確定後のグリフ構築まで含めた完了 Promise。fire-and-forget の
   *   呼び出し側は無視してよい（`void` で破棄）。テストは await して構築完了を待てる。
   */
  applyTextEffect(
    target: string,
    params: TextEffectParams,
    options?: { instant?: boolean }
  ): Promise<void> {
    const state = this.characters.get(target)
    if (!state || !state.label || state.label.destroyed) return Promise.resolve()

    const sourceText = state.label.text
    if (sourceText.length === 0) return Promise.resolve()

    // 既存の演出があれば破棄してから貼り直す（テキスト・パラメータ変更時の再適用）
    this.clearTextEffect(state)

    const fontFamily =
      state.label.style instanceof TextStyle
        ? state.label.style.fontFamily
        : ('sans-serif' as string | string[])

    // フォントが Web フォント遅延ロードの場合、未ロード状態で measure すると fallback
    // フォントの字形で幅が測られて字間がずれる（showTitle の label 再適用と同じ問題 #268）。
    // グリフの分解・幅計測・レイアウト・アニメ開始を ensureFontLoaded 完了後に行い、
    // 確定したフォントで measure する。既ロード時は microtask で即解決し実質遅延ゼロ。
    // fire-and-forget の呼び出し側契約は維持（呼び出し側は完了 Promise を無視できる）。
    const fontName = Array.isArray(fontFamily) ? fontFamily[0] : fontFamily
    return ensureFontLoaded(fontName)
      .catch(() => {})
      .then(() => {
        // 待っている間に対象が退場・テキスト差し替えされていたら何もしない。
        const cur = this.characters.get(target)
        if (cur !== state) return
        if (!state.label || state.label.destroyed) return
        if (state.label.text !== sourceText) return
        this.buildTextEffect(state, sourceText, fontFamily, params, options)
      })
  }

  /**
   * フォント確定後にグリフ列を構築して演出をセットする（applyTextEffect の後半）。
   * 純粋なレイアウト計算（中心 x）は textEffect.layoutGlyphCenters に委譲する。
   */
  private buildTextEffect(
    state: CharacterState,
    sourceText: string,
    fontFamily: string | string[],
    params: TextEffectParams,
    options?: { instant?: boolean }
  ): void {
    // 競合で既に別の演出が貼られている場合があるため、ここでも一度畳んでから貼り直す。
    this.clearTextEffect(state)

    // グリフ Text を生成し、行全体を中央寄せでレイアウトする。
    const container = new Container()
    // sprite の子にすることで、後続 [アニメ] による sprite の transform が container に波及する。
    state.sprite.addChild(container)

    // グリフの色は解決済みタイトル色 (#273) を使う。未設定なら白 (TITLE_FILL) にフォールバック。
    // OP の "orber" は爆発するグリフ自体が紺でなければならないため、ここで波及させる。
    const glyphFill = state.titleColor ?? CharacterLayer.TITLE_FILL
    // グリフのサイズは解決済みタイトル文字サイズ (#275) を使う。未設定なら既定 64。
    // タイトル `サイズ=` を演出グリフにも波及させ、本体 label とグリフ列の大きさを一致させる。
    const glyphFontSize = state.titleFontSize ?? CharacterLayer.TITLE_FONT_SIZE
    const chars = Array.from(sourceText) // サロゲートペア対応で code point 単位に分解
    const texts: Text[] = []
    const widths: number[] = []
    for (const ch of chars) {
      const t = new Text({
        text: ch,
        style: new TextStyle({
          fontFamily,
          fontSize: glyphFontSize,
          fill: glyphFill,
        }),
      })
      t.anchor.set(0.5, 0.5)
      container.addChild(t)
      texts.push(t)
      widths.push(this.measureGlyphWidth(t))
    }
    // 各グリフ中心 x は純関数で算出（行全体を container 原点で中央寄せ）。
    // 整列位置 (restX/restY) を明示保持して、補間オフセットは毎フレーム足し込む。
    const centers = layoutGlyphCenters(widths)
    // 揃え (#275): 中央寄せのグリフ群を anchor.x に応じて平行移動する。左揃え（anchorX=0）なら
    // 行の左端を sprite 原点へ寄せ、グリフ列が左から右へ並ぶ（ED の install-line のタイプ）。
    // container.x にオフセットを置くことで、子であるカーソル (positionCursor) も自動で追従する。
    const anchorX = state.anchorX ?? 0.5
    let totalWidth = 0
    for (const w of widths) totalWidth += w
    container.x = glyphAnchorOffset(totalWidth, anchorX)
    const glyphs = texts.map((t, i) => {
      t.x = centers[i]
      t.y = 0
      return { glyph: t, restX: centers[i], restY: 0 }
    })

    // 元の単一 label は隠す（グリフ列が見た目を担う）。
    if (state.label && !state.label.destroyed) state.label.visible = false

    const reveal = isRevealEffect(params)
    let effect: TextEffectAnimation
    if (reveal) {
      const msPerChar = resolveTypewriterMsPerChar(params)
      // #271: 点滅カーソル。reveal かつ cursor=on のときだけ縦矩形 Graphics を作る。
      // #273: カーソル色未指定時はグリフと同じ解決済みタイトル色にフォールバックする。
      const cursor = this.buildCursor(container, params, glyphFill, glyphFontSize)
      effect = {
        container,
        glyphs,
        transform: null,
        typewriter: startTypewriter(sourceText),
        msPerChar,
        startMs: this.elapsedMs,
        totalMs: msPerChar * chars.length,
        settled: false,
        cursor,
      }
    } else {
      const resolved = resolveTransformEffect(params)
      effect = {
        container,
        glyphs,
        transform: resolved,
        typewriter: null,
        msPerChar: 0,
        startMs: this.elapsedMs,
        totalMs: textEffectTotalDurationMs(resolved, glyphs.length),
        settled: false,
        cursor: null,
      }
    }
    state.textEffect = effect

    if (options?.instant) {
      // 即時完了: 全グリフを整列・不透明にして演出を畳む（中間状態を持たない）。
      // カーソルは破棄する（skip 時はカーソルなしの静止全表示、#271 ADR0002）。
      this.settleTextEffect(state, true)
      return
    }

    // 初期フレームを即時反映してから ticker を回す（最初の 1 フレームのチラつき防止）。
    this.updateTextEffectFrame(effect, 0)
    this.ensureTicker()
  }

  /**
   * 点滅カーソル (#271) の縦矩形 Graphics を作る（reveal かつ cursor=on のときのみ）。
   *
   * グリフ高さに合わせた細い縦棒。色は `カーソル色` 指定 > タイトル文字色 (#273) > 白 TITLE_FILL。
   * container の子にして reveal head（表示済み末尾グリフの右端）に毎フレーム追従させる。
   * `null` を返したら呼び出し側はカーソルなしの従来挙動になる。
   *
   * @param titleFallback `カーソル色` 未指定時に使う解決済みタイトル色 (#273)。
   *   タイトルが紺なら紺カーソルになる（OP/ED の一貫性）。
   * @param fontSize グリフと同じ解決済み文字サイズ (#275)。カーソルの太さ・高さをこれに比例させ、
   *   タイトル `サイズ=` 指定時もカーソルがグリフ高さに揃う。未指定は既定 64。
   */
  private buildCursor(
    container: Container,
    params: TextEffectParams,
    titleFallback: number,
    fontSize: number = CharacterLayer.TITLE_FONT_SIZE
  ): CursorState | null {
    const resolved: ResolvedCursor = resolveCursor(params)
    if (!resolved.enabled) return null
    const colorNum =
      resolved.color !== undefined
        ? parseColorToNumber(resolved.color, titleFallback)
        : titleFallback
    // 縦棒の太さ・高さはグリフサイズに比例。closing.html は border-right 2px 相当。
    const width = Math.max(2, Math.round(fontSize * 0.04))
    const height = fontSize
    const gfx = new Graphics()
    // 左端基準・縦中央基準で矩形を描く（rect の中心が原点に来るよう左上を負方向に置く）。
    gfx.rect(0, -height / 2, width, height).fill(colorNum)
    // build 直後はまだ reveal head へ配置されていない。positionCursor() が初期フレームで
    // 座標を確定してから表示することで、(0,0) 起点の一瞬表示を防ぐ (#333)。
    gfx.visible = false
    container.addChild(gfx)
    return {
      gfx,
      // gfx.fill に渡したのと同じ解決済み色を一次情報として保存する (#273)。
      colorNum,
      blinkMs: resolved.blinkMs,
      // 点滅起点は効果開始と揃える（仮想時間で算出 → export 再現）。
      blinkStartMs: this.elapsedMs,
    }
  }

  /**
   * カーソルを reveal head（表示済み末尾グリフの右端）に置き、点滅状態を反映する (#271)。
   * 表示文字が 0 のときは先頭グリフ左端へ。`cursorVisible` 純関数で点滅を決める。
   */
  private positionCursor(effect: TextEffectAnimation): void {
    const cursor = effect.cursor
    if (!cursor || cursor.gfx.destroyed) return
    const shown = effect.typewriter ? effect.typewriter.displayedCharCount : effect.glyphs.length
    let headX: number
    let headY: number
    if (effect.glyphs.length === 0) {
      headX = 0
      headY = 0
    } else if (shown <= 0) {
      // まだ 1 文字も出ていない: 先頭グリフの左端。
      // 幅は measureGlyphWidth でガード経由に読む（jsdom で Text.width getter が throw するのを防ぐ防御）。
      const first = effect.glyphs[0]
      headX = first.restX - this.measureGlyphWidth(first.glyph) / 2
      headY = first.restY
    } else {
      // 表示済み末尾グリフの右端。
      // 幅は measureGlyphWidth でガード経由に読む（jsdom で Text.width getter が throw するのを防ぐ防御）。
      const last = effect.glyphs[Math.min(shown, effect.glyphs.length) - 1]
      headX = last.restX + this.measureGlyphWidth(last.glyph) / 2
      headY = last.restY
    }
    cursor.gfx.x = headX
    cursor.gfx.y = headY
    const elapsed = this.elapsedMs - cursor.blinkStartMs
    cursor.gfx.visible = cursorVisible(elapsed, cursor.blinkMs)
  }

  /**
   * グリフ演出の 1 フレームを純粋計算（textEffect.ts / typewriter.ts）して各グリフへ適用する。
   * @param deltaMS このフレームの経過時間（typewriter の累積駆動用）。
   * @returns まだ進行中なら true、完了していれば false。
   */
  private updateTextEffectFrame(effect: TextEffectAnimation, deltaMS: number): boolean {
    if (effect.transform) {
      const elapsed = this.elapsedMs - effect.startMs
      for (let i = 0; i < effect.glyphs.length; i++) {
        const { glyph, restX, restY } = effect.glyphs[i]
        const gt = computeGlyphTransform(effect.transform, elapsed, i)
        glyph.x = restX + gt.offsetX
        glyph.y = restY + gt.offsetY
        glyph.rotation = gt.rotationRad
        glyph.scale.set(gt.scale, gt.scale)
        glyph.alpha = gt.alpha
      }
      return elapsed < effect.totalMs
    }
    if (effect.typewriter) {
      // reveal: typewriter を deltaMS で累積駆動し、displayedCharCount まで可視。
      const next = tickTypewriter(effect.typewriter, deltaMS, effect.msPerChar)
      effect.typewriter = next
      for (let i = 0; i < effect.glyphs.length; i++) {
        effect.glyphs[i].glyph.visible = i < next.displayedCharCount
      }
      // カーソルは reveal head に追従して点滅（タイプ中）。
      this.positionCursor(effect)
      return next.displayedCharCount < effect.glyphs.length
    }
    return false
  }

  /**
   * グリフ演出を「効果完了済み（全グリフ整列・不透明・全可視）」の静止状態にする。
   * container/glyphs は保持したまま、進行アニメだけ畳む。復元・即時完了に使う。
   *
   * @param instant true（skip 時。skipMode のスキップ前進。applyState は [文字演出] を replay
   *   しないので復元では走らない）ならカーソルを破棄して「カーソルなしの静止全表示」に畳む
   *   (#271 ADR0002: skip 時はカーソルなし)。false（通常完了）ならカーソルは末尾に固定して
   *   点滅し続ける（closing.html 忠実）— カーソルは settle 後も生かす小例外。
   */
  private settleTextEffect(state: CharacterState, instant = false): void {
    const effect = state.textEffect
    if (!effect) return
    for (const { glyph, restX, restY } of effect.glyphs) {
      glyph.x = restX
      glyph.y = restY
      glyph.rotation = 0
      glyph.scale.set(1, 1)
      glyph.alpha = 1
      glyph.visible = true
    }
    if (effect.typewriter) {
      effect.typewriter = { ...effect.typewriter, displayedCharCount: effect.glyphs.length, acc: 0 }
    }
    if (effect.cursor) {
      if (instant) {
        // skip 時: カーソルなしの静止全表示に畳む。
        this.destroyCursor(effect)
      } else {
        // 通常完了: カーソルを末尾位置に固定。点滅は settle 後も ticker が継続する。
        this.positionCursor(effect)
      }
    }
    // 進行を終えたので transform/typewriter の駆動は不要だが、container は保持する。
    // settled ラッチを立てて、以後 ticker が毎フレーム再 settle しないようにする。
    // （カーソルがある場合のみ ticker はカーソル点滅のために回り続ける — isTextEffectActive 参照。）
    effect.settled = true
  }

  /** カーソル Graphics を破棄する (#271)。skip / 演出破棄時に呼ぶ。 */
  private destroyCursor(effect: TextEffectAnimation): void {
    const cursor = effect.cursor
    if (!cursor) return
    if (!cursor.gfx.destroyed) {
      effect.container.removeChild(cursor.gfx)
      cursor.gfx.destroy()
    }
    effect.cursor = null
  }

  /**
   * グリフ演出を完全に破棄し、単一 label 表示へ戻す（テキスト差し替え・退場時）。
   */
  private clearTextEffect(state: CharacterState): void {
    const effect = state.textEffect
    if (!effect) return
    this.destroyCursor(effect)
    for (const { glyph } of effect.glyphs) {
      effect.container.removeChild(glyph)
      glyph.destroy()
    }
    if (!effect.container.destroyed) {
      state.sprite.removeChild(effect.container)
      effect.container.destroy()
    }
    state.textEffect = null
    if (state.label && !state.label.destroyed) state.label.visible = true
  }

  /**
   * 下線ビーム (#270) を対象テキストに適用する。
   *
   * 対象（CharacterLayer 上の identifier。例 "Title"）の label の実 measure 幅にフィットする
   * 横線を直下に置き、scale.x 0→1 で左から伸ばす（opening.html の drawLine 相当）。
   * 線は sprite の子にするため、後続 `[アニメ target=Title]` が sprite を動かすと追従する。
   *
   * fire-and-forget: 呼び出し側は完了を待たず次イベントへ進む。
   * 幅 measure は fallback フォントずれを避けるため ensureFontLoaded 後に行う。
   *
   * @param instant true（skip 時。skipMode のスキップ前進。applyState は [下線] を replay しない
   *   ので復元では走らない）なら伸び切り（scale.x=1）の静止線にする（ADR0002）。
   * @returns フォント確定後の線構築まで含めた完了 Promise。fire-and-forget は無視してよい。
   */
  applyUnderline(
    target: string,
    params: UnderlineParams,
    options?: { instant?: boolean }
  ): Promise<void> {
    const state = this.characters.get(target)
    if (!state || !state.label || state.label.destroyed) return Promise.resolve()
    const label = state.label
    const sourceText = label.text
    if (sourceText.length === 0) return Promise.resolve()

    // 既存の下線があれば破棄してから貼り直す（テキスト・パラメータ変更時の再適用）。
    this.clearUnderline(state)

    const fontFamily =
      label.style instanceof TextStyle
        ? label.style.fontFamily
        : ('sans-serif' as string | string[])
    const fontName = Array.isArray(fontFamily) ? fontFamily[0] : fontFamily
    return ensureFontLoaded(fontName)
      .catch(() => {})
      .then(() => {
        // 待っている間に対象が退場・テキスト差し替えされていたら何もしない。
        const cur = this.characters.get(target)
        if (cur !== state) return
        if (!state.label || state.label.destroyed) return
        if (state.label.text !== sourceText) return
        this.buildUnderline(state, params, options)
      })
  }

  /**
   * フォント確定後に下線 Graphics を構築して適用する（applyUnderline の後半）。
   * 幾何計算（左端 x・y・幅）は underline.layoutUnderline に委譲する。
   */
  private buildUnderline(
    state: CharacterState,
    params: UnderlineParams,
    options?: { instant?: boolean }
  ): void {
    // フォント待ちの競合で既に別の下線が貼られている場合に備え、ここでも一度畳んでから貼り直す。
    this.clearUnderline(state)
    const label = state.label
    if (!label || label.destroyed) return

    const resolved = resolveUnderline(params)
    // 対象テキストの実 measure 幅・高さ。anchor 0.5 のため sprite-local 中心は (0,0)。
    const textWidth = this.measureGlyphWidth(label)
    const textHeight = (() => {
      let h = 0
      try {
        h = label.height
      } catch {
        h = 0
      }
      return Number.isFinite(h) && h > 0 ? h : CharacterLayer.TITLE_FONT_SIZE
    })()
    // テキスト下端の sprite-local y（中心 0 から下へ半分）。
    const textBottomY = textHeight / 2
    // offset 未指定時の自動余白: フォントサイズの数 %（テキスト下端と線の間の隙間）。
    const autoOffset = Math.round(CharacterLayer.TITLE_FONT_SIZE * 0.1)
    const geom = layoutUnderline(textWidth, textBottomY, resolved, autoOffset)

    const gfx = new Graphics()
    // 矩形をローカル原点 (0,0) を左端として描く。scale.x はローカル原点基準で効くため、
    // gfx 自体を線の左端位置 (geom.x, geom.y) に置けば scale.x 0→1 が「左固定で右へ伸びる」になる。
    gfx.rect(0, 0, geom.width, geom.thickness).fill(resolved.colorNum)
    gfx.x = geom.x
    gfx.y = geom.y
    // 下線は sprite 直下に置く（グリフ container の子にはしない）。spec の「後続 [アニメ target=Title]
    // で sprite ごと動かせる」に沿わせるため。将来 container 単独 transform を入れても下線は sprite
    // 座標系に留まるので、container と別の子である点に注意（container だけ動かすと下線はずれる）。
    state.sprite.addChild(gfx)

    const anim: UnderlineAnimation = {
      gfx,
      resolved,
      startMs: this.elapsedMs,
      durationMs: resolved.durationMs,
      settled: false,
    }
    state.underline = anim

    if (options?.instant) {
      // 即時完了: 伸び切り（scale.x=1）の静止線にする（中間状態を持たない）。
      this.settleUnderline(state)
      return
    }
    // 初期フレーム（scale.x=0）を反映してから ticker を回す。
    this.updateUnderlineFrame(anim)
    this.ensureTicker()
  }

  /**
   * 下線の 1 フレームを純粋計算（underline.underlineScaleX）して scale.x に当てる。
   * @returns まだ伸長中なら true、伸び切ったら false。
   */
  private updateUnderlineFrame(anim: UnderlineAnimation): boolean {
    if (anim.gfx.destroyed) return false
    const elapsed = this.elapsedMs - anim.startMs
    const sx = underlineScaleX(elapsed, anim.resolved)
    anim.gfx.scale.x = sx
    return elapsed < anim.durationMs
  }

  /** 下線を伸び切り（scale.x=1）の静止状態にする。skip 時（skipMode のスキップ前進）・即時完了に使う。 */
  private settleUnderline(state: CharacterState): void {
    const anim = state.underline
    if (!anim) return
    if (!anim.gfx.destroyed) anim.gfx.scale.x = 1
    anim.settled = true
  }

  /** 下線 Graphics を完全に破棄する（テキスト差し替え・退場時）。 */
  private clearUnderline(state: CharacterState): void {
    const anim = state.underline
    if (!anim) return
    if (!anim.gfx.destroyed) {
      if (!state.sprite.destroyed) state.sprite.removeChild(anim.gfx)
      anim.gfx.destroy()
    }
    state.underline = null
  }

  /** 円形マスク Graphics (#274) を破棄する。画像の退場・破棄時に呼ぶ。
   *  sprite.destroy() は default で children を破棄しないため明示的に外して destroy する。 */
  private clearMask(state: CharacterState): void {
    const mask = state.maskGraphics
    if (!mask) return
    if (!state.sprite.destroyed) state.sprite.mask = null
    if (!mask.destroyed) {
      if (!state.sprite.destroyed) state.sprite.removeChild(mask)
      mask.destroy()
    }
    state.maskGraphics = undefined
  }

  /** 進行中アニメーション（transform / fade / textEffect / underline いずれか）を持つキャラがいるか */
  hasActiveAnimation(): boolean {
    for (const s of this.characters.values()) {
      if (s.animation || s.fadeAnimation || s.poseNudge) return true
      if (s.textEffect && this.isTextEffectActive(s.textEffect)) return true
      if (s.underline && this.isUnderlineActive(s.underline)) return true
    }
    return false
  }

  /**
   * 本物の立ち絵の遷移（transform / fade / pose nudge）が残っているか。
   *
   * hasActiveAnimation() はタイトル文字演出やカーソル点滅も含むため、本文 reveal の待機条件には
   * 強すぎる。forward novel では「立ち絵が落ち着くまで」だけ待てばよいので renderOnly と
   * textEffect/underline を除外する。
   */
  hasActivePortraitTransition(): boolean {
    for (const s of this.characters.values()) {
      if (s.renderOnly) continue
      if (s.animation || s.fadeAnimation || s.poseNudge) return true
    }
    return false
  }

  /**
   * `[待機: 表示完了]` 用の観測 API。
   * 現時点の対象は標準立ち絵の load / fade / transform / nudge。
   * 将来イベント絵などを CharacterLayer 管轄に足す場合は、この集約点に含める。
   */
  hasPendingVisualTransition(): boolean {
    return this.pendingPortraitLoads > 0 || this.hasActivePortraitTransition()
  }

  /** グリフ演出がまだ進行中か（完了済みなら container は保持するが ticker は止めてよい）。 */
  private isTextEffectActive(effect: TextEffectAnimation): boolean {
    // 完了後もカーソル（点滅）があれば ticker を回し続ける（#271 小例外）。
    // settle 後の cursor は render-only で、点滅し続けるため駆動が要る。
    if (effect.cursor) return true
    // 整列確定済みなら、たとえ未完了でも駆動不要（settle 後は静止状態を保つだけ）。
    if (effect.settled) return false
    if (effect.transform) return this.elapsedMs - effect.startMs < effect.totalMs
    if (effect.typewriter) return effect.typewriter.displayedCharCount < effect.glyphs.length
    return false
  }

  /** 下線ビームがまだ進行中か（伸び切れば ticker は止めてよい）。 (#270) */
  private isUnderlineActive(underline: UnderlineAnimation): boolean {
    if (underline.settled) return false
    return this.elapsedMs - underline.startMs < underline.durationMs
  }

  private ensureTicker(): void {
    if (this.animTicker) return
    const ticker = new Ticker()
    ticker.add(() => {
      this.elapsedMs += ticker.deltaMS
      let anyActive = false
      // 退場フェード完了で characters Map から削除する可能性があるため、entries を先にコピーする。
      // （Map 自体の iteration は delete に対して安全だが、コピー方が読みやすいので採用）
      const entries = Array.from(this.characters.entries())
      for (const [name, state] of entries) {
        const a = state.animation
        if (a) {
          const t = (this.elapsedMs - a.startMs) / a.durationMs
          if (t >= 1) {
            state.sprite.x = a.toX
            state.sprite.y = a.toY
            state.sprite.rotation = a.toRotation
            state.sprite.scale.set(a.toScale, a.toScale)
            state.animation = null
            // アニメ終了 → 2 コマ切替を止めて -a に戻す
            this.stopIdleCycle(name, state.assetBaseUrl)
          } else {
            anyActive = true
            const eased = applyEasing(a.easing, t)
            state.sprite.x = a.fromX + (a.toX - a.fromX) * eased
            state.sprite.y = a.fromY + (a.toY - a.fromY) * eased
            state.sprite.rotation = a.fromRotation + (a.toRotation - a.fromRotation) * eased
            const sc = a.fromScale + (a.toScale - a.fromScale) * eased
            state.sprite.scale.set(sc, sc)
          }
        }

        const f = state.fadeAnimation
        if (f) {
          const tf = (this.elapsedMs - f.startMs) / f.durationMs
          if (tf >= 1) {
            state.sprite.alpha = f.toAlpha
            // 完了フレームでも label を sprite に揃える。進行中フレームだけ同期して
            // 完了で揃えないと、フェードイン完了後に label.alpha が最終サブ1フレーム値
            // （0.97〜0.99 等）で固定され、[ラベル] 文字が恒久的に半透明になる。
            if (state.label) state.label.alpha = f.toAlpha
            state.fadeAnimation = null
            const onComplete = f.onComplete
            if (f.destroyOnComplete) {
              this.destroyCharacterState(state)
              this.characters.delete(name)
            }
            onComplete?.()
          } else {
            anyActive = true
            state.sprite.alpha = f.fromAlpha + (f.toAlpha - f.fromAlpha) * tf
            if (state.label) state.label.alpha = state.sprite.alpha
          }
        }

        // 話者交代のポーズ変化 (#286) を毎フレーム純粋計算で駆動する。
        // baseY を基準に sin 山形オフセットを足し込む（中間状態を sprite.y に焼き込まない）。
        // 進行中の transform animation がある間は y をそちらが支配するため nudge は当てない
        // （話者交代と [アニメ] が同時に来る脚本は想定外。競合時は animation を優先して破綻を避ける）。
        const pn = state.poseNudge
        if (pn && !state.animation) {
          const tp = (this.elapsedMs - pn.startMs) / pn.durationMs
          if (tp >= 1) {
            state.sprite.y = pn.baseY
            state.poseNudge = null
          } else {
            anyActive = true
            // 0→1 を sin(πt) で 0→1→0 の山にし、上方向（-y）へ持ち上げて戻す。
            const lift = Math.sin(Math.PI * tp) * pn.liftPx
            state.sprite.y = pn.baseY - lift
          }
        }

        // グリフ単位の文字演出 (#268) を毎フレーム純粋計算で駆動する。
        // 整列確定済み（settled）の effect は毎フレーム再 settle せず読み飛ばす（空回り回避 nit）。
        // settle は「進行 → 完了」へ遷移したフレームの 1 回だけで足りる。
        const te = state.textEffect
        if (te && !te.settled) {
          const stillRunning = this.updateTextEffectFrame(te, ticker.deltaMS)
          if (stillRunning) {
            anyActive = true
          } else {
            // 完了 → 整列状態に確定（container は保持し後続 [アニメ] が効く）。
            // 通常完了 = instant 引数なし（カーソルは末尾固定で点滅継続）。
            this.settleTextEffect(state)
          }
        } else if (te && te.cursor) {
          // settle 済みでもカーソルがあれば点滅だけ駆動し続ける（#271 render-only の小例外）。
          this.positionCursor(te)
          anyActive = true
        }

        // 下線ビーム (#270) を毎フレーム純粋計算で駆動する。
        const ul = state.underline
        if (ul && !ul.settled) {
          const stillRunning = this.updateUnderlineFrame(ul)
          if (stillRunning) {
            anyActive = true
          } else {
            // 完了 → 伸び切り（scale.x=1）に確定。
            this.settleUnderline(state)
          }
        }

        // 名前ラベルを sprite に追従させる（x のみ。y は loadTexture で画像高さに合わせて固定済み）
        if (state.label) {
          state.label.x = state.sprite.x
        }
      }
      if (!anyActive) {
        this.maybeStopTicker()
      }
    })
    ticker.start()
    this.animTicker = ticker
  }

  private maybeStopTicker(): void {
    if (!this.animTicker) return
    if (this.hasActiveAnimation()) return
    this.animTicker.stop()
    this.animTicker.destroy()
    this.animTicker = null
  }

  /** 同一位置判定の x 許容差 (px) (#303)。役割配置の overrideX と positionX は決定論的に
   *  同じ値になるため厳密一致でよいが、浮動小数の丸めに備えて 0.5px の許容を持たせる。 */
  private static readonly SAME_POSITION_EPSILON = 0.5

  /**
   * 指定 x を占有している「別の立ち絵」を退場させる (#303)。
   *
   * 「1 位置に 1 キャラ」を保証するための最小退場ロジック。新キャラ X を位置 P（= targetX）に
   * 出す前に呼び、P に既にいる別キャラ Y をフェードアウト（instant 時は即時）させる。これにより
   * ヴィンチア(右) → カンティア(右) のように同じ位置へ別キャラが続けて出るときの重なりを防ぐ。
   *
   * 除外対象:
   *  - `keepName`（今まさに置こうとしているキャラ自身）。同一キャラの再表示・位置変更は退場させない。
   *  - `renderOnly`（Title/Label/Image #274）。これらは立ち絵スロットを占有する標準立ち絵ではなく、
   *    2D 自由配置の演出要素なので位置衝突の対象にしない。
   *  - 既に退場フェード中（fadeAnimation.destroyOnComplete）のキャラ。二重退場を避ける。
   *
   * 別位置（左のせお等）には x が一致しないため干渉しない。退場は GameState に中間状態を持ち込まず、
   * characters Map から消える（getCharacterStates は退場後の状態を写す）ので、任意局面起動・goBack/seek
   * の復元でも重なり・消えすぎは起きない。
   */
  private evictCollidersAt(
    targetX: number,
    keepName: string,
    instant: boolean,
    onComplete?: () => void
  ): number {
    if (!Number.isFinite(targetX)) {
      onComplete?.()
      return 0
    }
    // 走査中に remove() が characters を delete するため、対象名を先に集めてから退場させる。
    const colliders: string[] = []
    for (const [name, state] of this.characters) {
      if (name === keepName) continue
      if (state.renderOnly) continue
      if (state.fadeAnimation?.destroyOnComplete) continue
      if (Math.abs(state.sprite.x - targetX) < CharacterLayer.SAME_POSITION_EPSILON) {
        colliders.push(name)
      }
    }
    if (colliders.length === 0) {
      onComplete?.()
      return 0
    }
    let remaining = colliders.length
    const markDone = () => {
      remaining -= 1
      if (remaining === 0) onComplete?.()
    }
    for (const name of colliders) {
      this.remove(name, { instant, onComplete: markDone })
    }
    return colliders.length
  }

  /**
   * キャラクターを退場させる。
   *
   * デフォルトでは alpha 1 → 0 のフェードアウト後に sprite を破棄する（#177）。
   * 即時退場が必要な場合は `options.instant: true`（旧挙動と等価）。
   */
  remove(character: string, options?: { instant?: boolean; onComplete?: () => void }): void {
    const state = this.characters.get(character)
    if (!state) {
      options?.onComplete?.()
      return
    }
    const instant = options?.instant === true
    if (state.idleIntervalId) {
      this.time.clearInterval(state.idleIntervalId)
      state.idleIntervalId = undefined
    }
    if (instant || this.characterFadeMs <= 0) {
      this.destroyCharacterState(state)
      this.characters.delete(character)
      this.maybeStopTicker()
      options?.onComplete?.()
      return
    }
    this.startFade(state, state.sprite.alpha, 0, true, options?.onComplete)
  }

  /**
   * 現在表示中のキャラクター情報を返す（スナップショット用）。
   *
   * 演出表示（renderOnly: Title / Label / Image, #274）は除外する。これらは動画を start→end で
   * 通し再生する前提の演出で、`NovelGameState.characters` に持たせない（doctrine 規律3 / spec L520 /
   * ADR0002）。立ち絵（show）だけが復元対象として残り、セーブ/シーク/任意局面起動で再現される。
   * 復元時（applyState）は state.characters を show() で再生するため、ここに renderOnly が漏れると
   * Title/Label/Image が立ち絵として誤って復元されてしまう。それを防ぐフィルタ。
   */
  getCharacterStates(): Array<{ name: string; expression: string; position: string }> {
    const result: Array<{ name: string; expression: string; position: string }> = []
    for (const [name, state] of this.characters) {
      if (state.renderOnly) continue
      if (state.snapshotHidden) continue
      // 退場フェード中（destroyOnComplete）のキャラは概念上もう退場済みなのでスナップショットに
      // 含めない (#303)。1 位置 1 キャラの衝突退場で fade-out 中の前キャラがまだ Map に残っていても、
      // セーブ/シーク/任意局面起動の復元で「退場しかけのキャラ」が立ち絵として蘇らないようにする。
      if (state.fadeAnimation?.destroyOnComplete) continue
      result.push({ name, expression: state.expression, position: state.position })
    }
    return result
  }

  /**
   * 全キャラクターを削除する
   */
  clear(): void {
    for (const [, state] of this.characters) {
      this.destroyCharacterState(state)
    }
    this.characters.clear()
    this.maybeStopTicker()
  }

  /**
   * 通常の scene jump 用クリア。
   *
   * セーブ復元・seek・destroy の clear() は中間状態を作らず即時破棄する。一方で通常再生の
   * Choice → jumpToScene では、前シーンの立ち絵が一瞬で消えると演出として不自然なので、
   * 標準立ち絵だけ fade-out に入れる。次シーン先頭で同じ人物が再 show された場合は show() 側の
   * 「退場フェード中の同名キャラ再 show」経路で fade-in に戻るため、メニュー間の主人公は瞬断しない。
   */
  clearForSceneTransition(): void {
    const names = Array.from(this.characters.keys())
    for (const name of names) {
      const state = this.characters.get(name)
      if (!state) continue
      if (state.renderOnly) {
        this.destroyCharacterState(state)
        this.characters.delete(name)
        continue
      }
      this.remove(name)
    }
  }

  /**
   * テクスチャをロードして Sprite に適用する。
   *
   * `onReady` (#293): テクスチャの用意が済んだ（または素早く諦めた）タイミングで**必ず1回だけ**
   * 呼ぶ。NovelRenderer がテキスト reveal をこの完了に揃えて「立ち絵 →（同時/直後に）テキスト」
   * の順序を保証するためのフック。assetBaseUrl 空（描画できない）・load 成功・load 失敗のいずれでも
   * 発火させ、テキストが永遠に出ない事故を防ぐ。
   *
   * `characterName` (#364): character_height_ratios の per-character override 解決に使う
   * キャラクター表示名。`this.characters` の key と同じ値を渡す（呼び出し側の `character` 変数）。
   */
  private loadTexture(
    sprite: Sprite,
    characterName: string,
    expression: string,
    assetBaseUrl: string,
    label?: Text,
    fit = false,
    onReady?: () => void
  ): Promise<boolean> {
    if (!assetBaseUrl) {
      // 描画できないので待たせない。テキスト側が詰まらないよう即座に ready 扱いにする (#293)。
      onReady?.()
      return Promise.resolve(true)
    }

    const cleanExpression = expression.replace(/^\//, '')
    const urls = resolveCharacterImageUrls(assetBaseUrl, cleanExpression)
    this.pendingPortraitLoads += 1

    return (
      // リトライ待機は this.time (TimeController) 経由に通す（生 setTimeout を使わない）。
      // 全タイマーを TimeController に集約する規律に従い、仮想時間エクスポートと整合させる (#389)。
      loadFirstAvailableTexture(
        urls,
        (ms) => new Promise<void>((resolve) => this.time.setTimeout(resolve, ms))
      )
        .then((texture) => {
          // destroy 後に解決した場合は反映しない（UAF 防止）。ただし ready 通知 (#293) は
          // finally で発火させ、テキスト側の待ちを必ず解く（sprite が消えても永久待ちにしない）。
          if (sprite.destroyed) return false
          // 立ち絵は既定で原寸（scale=1）。画面全体をブラウザ枠に合わせて縮める系統
          // （PixiJS canvas の wrapper スケール）が唯一の常時縮小であり、立ち絵を個別に
          // 自動 fit-down してはいけない。論理画面の上端・左右をはみ出してもよい。
          // ※ [アニメ] 等の脚本駆動 scale 演出（animate()）はこれとは別物で、ここでは触らない。
          //
          // 例外: 脚本の話者行に `フィット` / `fit` を書いた立ち絵だけ (#294)、旧 fit-down を
          // 明示適用する（論理画面より大きいときだけ画面内に収める・小さい時は原寸）。
          // サイズや位置では自動分岐しない。novel/adv でも分けない（fit フラグだけが分岐の根拠）。
          //
          // 優先順位 (#360 / #364 / #378): per-line フィット(fit=true, #294) > per-game
          //   character_scale(#378, 元絵基準) > per-character character_height_ratios override >
          //   per-game character_height_ratio > 既定 原寸(1)。
          //   fit のときは従来通り computeFitScale。fit=false かつ character_scale 指定時は元絵基準の
          //   一律スケール（sprite.scale = 値・既に [0.05,4] クランプ済み）をそのまま使う＝元絵に焼き込んだ
          //   身長差を保存する。character_scale 未指定時は resolveCharacterHeightRatio でこのキャラの目標比率
          //   （per-character override があればそれ、なければスクリプト単位の character_height_ratio）を解決し、
          //   あれば computeTargetHeightScale で**画面基準**の目標表示高さへ合わせる（高解像度立ち絵の巨大化を
          //   吸収しつつ身長差は潰れる）。どちらも無ければ原寸 1（後方互換の絶対条件）。
          // ※ loadTexture は show() の立ち絵専用。render-only（Title/Label/Image）は通らないので
          //   character_scale / height ratio は自動的に立ち絵のみへ効く。
          let scale: number
          if (fit) {
            scale = computeFitScale(
              texture.width,
              texture.height,
              this.screenWidth,
              this.screenHeight
            )
          } else if (this.characterScale !== null) {
            // character_scale (#378): 元絵基準の一律スケール（既に setCharacterScale で [0.05,4] クランプ済み）。
            // 画面基準の height_ratio と違いテクスチャの縦pxを割り消さず、表示px = 値 × texture.height。
            scale = this.characterScale
          } else {
            const targetRatio = resolveCharacterHeightRatio(
              characterName,
              this.characterHeightRatios,
              this.characterHeightRatio
            )
            scale =
              targetRatio === null
                ? 1
                : computeTargetHeightScale(texture.height, targetRatio, this.screenHeight)
          }
          sprite.scale.set(scale)
          // ラベルを立ち絵（sprite）の幅に収める。natural width が sprite 幅を超えたら縮小、
          // 収まっていれば等倍のまま（大きくしない）。setCharacterHeightRatio のライブ再スケール (#360)
          // と共有するヘルパで、fit ロジックの重複を避ける（規律4）。
          this.fitLabelToSprite(sprite, label)
          sprite.texture = texture
          return true
        })
        .catch((err) => {
          console.warn('[name-name] 立ち絵の読み込みに失敗: ' + urls.join(' , '), err)
          return false
        })
        // 成功/失敗/破棄いずれでも ready を1回だけ通知する (#293)。これでテキスト reveal が
        // 立ち絵の用意完了に揃い、ロード失敗でもテキストが詰まらない。
        .finally(() => {
          this.pendingPortraitLoads = Math.max(0, this.pendingPortraitLoads - 1)
          onReady?.()
        })
    )
  }
}
