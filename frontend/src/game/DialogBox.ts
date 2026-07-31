/**
 * PixiJS ベースのダイアログボックス
 *
 * ノベル・RPG 共通のテキストウィンドウ基盤。#194 で旧 RpgDialogBox の機能を統合済み。
 *
 * ## モード
 * - **ノベルモード**（デフォルト）: 半透明黒背景 + 白枠、話者名別枠、▼インジケーター、禁則ワードラップ
 * - **RPG モード**（`bgColor` / `nameColor` 指定）: 紺背景・黄名前など外観をカスタマイズ可能
 * - **枠なしモード**（`borderless: true`）: 背景・枠を非表示にし DropShadow で可読性を確保
 *
 * ## portrait
 * `portrait` オプションで NPC 顔画像を左側に表示できる（#73 / #101）。
 * 非同期ロード・token による race 防止・contain fit（アスペクト比維持）を実装。
 *
 * ## 複数同時表示
 * インスタンスを複数生成して stage に追加するだけで実現できる。
 */

import { Assets, Container, Graphics, Sprite, Text, TextStyle, Texture, Ticker } from 'pixi.js'
import { wordwrap } from './wordwrap'
import { parseRubyText, stripRubyMarkup } from './ruby'
import { type RubyPlacement, computeRubyPlacements } from './rubyLayout'
import { ensureFontLoaded } from './FontLoader'
import {
  type TypewriterState,
  isTypingActive,
  makeInitialTypewriterState,
  skipTypewriter as typewriterSkip,
  startTypewriter,
  startTypewriterFrom,
  tickTypewriter,
  visibleText,
} from './typewriter'
import {
  computeNovelIndicatorPlacement,
  type DualWindowTextRegions,
  getIndicatorImageUrls,
  type IndicatorKind,
  type LayoutRect,
  wrappedPrefixLength,
} from './novelLayout'

// ---------------------------------------------------------------------------
// portrait レイアウト定数（テストが参照する）
// ---------------------------------------------------------------------------
export const PORTRAIT_SIZE = 80
export const PORTRAIT_MARGIN = 20
export const PORTRAIT_X = 40
export const PORTRAIT_Y_OFFSET = 20

/**
 * portrait 画像を `PORTRAIT_SIZE` 正方形枠に「contain」（アスペクト比維持で内接）するときの
 * 表示矩形を計算する純関数。余白は portraitFrame の半透明黒で埋まる前提。
 */
export function computePortraitContainFit(
  srcW: number,
  srcH: number,
  frameX: number,
  frameY: number,
  frameSize: number
): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { x: frameX, y: frameY, width: frameSize, height: frameSize }
  }
  const scale = Math.min(frameSize / srcW, frameSize / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return {
    x: frameX + (frameSize - w) / 2,
    y: frameY + (frameSize - h) / 2,
    width: w,
    height: h,
  }
}

// ---------------------------------------------------------------------------
// portrait テクスチャキャッシュ（モジュールグローバル）
// 複数の DialogBox インスタンスでキャッシュを共有する。
// 同一パスへの重複ロードを避け、ちらつきを防ぐ。
// テスト間でキャッシュが汚染される可能性があるため、テストでは vi.mock 等で隔離すること。
// ---------------------------------------------------------------------------
const portraitCache: Map<string, Promise<Texture>> = new Map()

function loadPortraitTexture(path: string): Promise<Texture> {
  const cached = portraitCache.get(path)
  if (cached) return cached
  const promise = Assets.load(path).then((tex: unknown) => {
    if (!(tex instanceof Texture)) {
      throw new Error(`[DialogBox] loaded asset for "${path}" is not a Texture`)
    }
    return tex
  })
  portraitCache.set(path, promise)
  promise.catch((err: unknown) => {
    console.warn(`[DialogBox] failed to load portrait "${path}":`, err)
    portraitCache.delete(path)
  })
  return promise
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface DialogBoxConfig {
  /** ゲーム画面幅 */
  screenWidth: number
  /** ゲーム画面高さ */
  screenHeight: number
  /** ボックスの高さ（デフォルト: 180） */
  boxHeight?: number
  /** ボックスの左右マージン（デフォルト: 20） */
  marginX?: number
  /** ボックスの下マージン（デフォルト: 20） */
  marginBottom?: number
  /** テキスト内パディング（デフォルト: 20） */
  padding?: number
  /** フォントサイズ（デフォルト: 22） */
  fontSize?: number
  /** フォントファミリー（デフォルト: Noto Sans JP, sans-serif） */
  fontFamily?: string
  /** typewriter 表示の 1 文字あたり ms（デフォルト: 30ms/char） */
  msPerChar?: number
  /**
   * 枠なしナレ風モード（デフォルト: false）。
   * true のとき半透明黒背景・白枠・話者名ボックスを非表示にし、
   * テキストに drop-shadow を付けて可読性を確保する。
   */
  borderless?: boolean
  /**
   * 背景色（デフォルト: 0x000000）。
   * RPG 用に紺（0x000033）などを指定できる。
   */
  bgColor?: number
  /**
   * 話者名テキスト色（デフォルト: 0xffffff）。
   * RPG 用に黄色（0xffe066）などを指定できる。
   */
  nameColor?: number
  /**
   * 話者名を別ボックスとして表示するか（デフォルト: true）。
   * false にするとウィンドウ内上部にインライン表示する（RPG スタイル）。
   */
  nameSeparateBox?: boolean
}

/** typewriter のデフォルト速度（ms/char） */
const DEFAULT_MS_PER_CHAR = 30

/** 枠なしモードの DropShadow 設定 */
const BORDERLESS_DROP_SHADOW = { color: 0x000000, blur: 8, distance: 3, alpha: 1 } as const

/**
 * クリッカー（インジケータ）の種別 (#292)。`IndicatorKind` 本体は画像パス一覧
 * `getIndicatorImageUrls` と同じ novelLayout.ts に定義する（種別と一覧の食い違いを防ぐ #413）。
 * ここでは既存の `import { IndicatorKind } from './DialogBox'` 経路を維持するため re-export する。
 *  - `next`     : 同ページにまだ続く文がある（次は文の送り）。
 *  - `pageturn` : そのページの最後の文（クリックでページを離れる＝次ページ or 次イベント）。
 */
export type { IndicatorKind }

/**
 * 種別 → プレースホルダ記号（グリフ）の対応表 (#292)。**ここ 1 箇所に集約**する。
 * 将来 /image の本番アイコンへ hot-swap するときも、差し替えはこの表だけで済むようにする。
 *  - next     = 明滅する `▼`（次の文）
 *  - pageturn = `❯`（ページめくり）
 */
const INDICATOR_GLYPH: Record<IndicatorKind, string> = {
  next: '▼',
  pageturn: '❯',
}

/** インジケータグリフの既定色（淡い水色）。2窓モードでない全ゲーム共通・非回帰。 */
const INDICATOR_GLYPH_COLOR = 0xa8dadc

/**
 * 2窓モード (#444 / #447) の▼グリフ色。kako-jun 実機指摘3（静止した白/水色の▼で十分）を受け、
 * 自分(self)アクティブ時=白・相手(opponent)アクティブ時=水色にする。NovelRenderer の
 * `RESIDENT_TEXT_COLOR` / `OPPONENT_TEXT_COLOR`（#305 本文色、TUI 版 gymnasia#39 準拠）と
 * 同じ値を再利用する。DialogBox → NovelRenderer の逆依存は作れないため値は複製しているが、
 * 変更する場合は両方揃えること。
 */
const DUAL_WINDOW_SELF_INDICATOR_COLOR = 0xffffff
const DUAL_WINDOW_OPPONENT_INDICATOR_COLOR = 0x9ad4e8

const INDICATOR_IMAGE_SIZE = 32
const INDICATOR_FRAME_MS = 360

/**
 * 2窓モード (#447 追加要望1) の▼グリフ点滅間隔（ms）。端末カーソル風の機械的な ON/OFF
 * （なめらかなフェードではない）。
 */
const INDICATOR_BLINK_MS = 1000

/**
 * ▼グリフの縦方向スケール (#447 追加要望2)。1 未満にして平べったく見せる。2窓モード限定の
 * 演出ではなく（話者色・点滅と異なりグリフ自体の形状の話のため）全ゲーム共通・常時適用する。
 * kako-jun が実機で見て微調整する前提の初期値。
 */
const INDICATOR_GLYPH_SCALE_Y = 0.6

/**
 * novel スタイル (#283) のテキスト領域マージン（px、論理座標）。
 * 全画面ノベル（ToHeart 式）では画面の大半をテキストに使う。本文は左上付近から始め、
 * 左右・上下に小さな余白を残す。テストが参照できるよう export する。
 */
export const NOVEL_TEXT_MARGIN_X = 6
/** 本文域の上端 Y（画面高に対する比率）。本文はより左上から始める（端から少しだけ離す）。 */
export const NOVEL_TEXT_TOP_RATIO = 0.012
/** 本文域の下端マージン（px）。高さを使い切るため小さめ。 */
export const NOVEL_TEXT_MARGIN_BOTTOM = 20

/**
 * 話者名ボックス（`drawNameBox`）の高さ・本文ボックスとの間隔（px）。
 * `drawNameBox` 本体と、split_layout の上部クリアランス計算（`applySplitLayoutBoxGeometry`、
 * #442 self-review must-1）の両方が同じ値を参照する共通定数。テストも参照できるよう export する。
 */
export const NAME_BOX_HEIGHT = 36
/** 名札ボックスと本文ボックスの間隔（px）。`nameBoxY = boxY - NAME_BOX_HEIGHT - NAME_BOX_GAP`。 */
export const NAME_BOX_GAP = 4

/**
 * ルビの x 位置計算用の Canvas measure コンテキスト。
 */
let cachedRubyCanvas: HTMLCanvasElement | null = null
let cachedRubyCtx: CanvasRenderingContext2D | null = null
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (!cachedRubyCtx) {
    cachedRubyCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
    cachedRubyCtx = cachedRubyCanvas?.getContext('2d') ?? null
  }
  return cachedRubyCtx
}

// ---------------------------------------------------------------------------
// DialogBox
// ---------------------------------------------------------------------------
export class DialogBox extends Container {
  // --- 背景・枠 ---
  private bg: Graphics
  // --- 話者名（separate box モード） ---
  private nameBox: Graphics
  private nameText: Text
  // --- RPG インライン名（separate box = false モード） ---
  private inlineNameText: Text | null = null
  // --- ダイアログ本文 ---
  private dialogText: Text
  /** ルビ描画用 Container */
  private rubyContainer: Container
  private rubyEntries: Array<{ placement: RubyPlacement; text: Text }> = []
  private rubyPlacements: RubyPlacement[] = []
  // --- ▼インジケーター ---
  private indicator: Container
  private indicatorGlyph: Text
  private indicatorSprite: Sprite
  private indicatorBaseY: number
  private indicatorTime = 0
  private indicatorFrameElapsed = 0
  private indicatorFrameIndex = 0
  /** 2窓モード点滅 (#447 追加要望1) の累積経過時間（ms）・現在の ON/OFF 状態。 */
  private indicatorBlinkElapsed = 0
  private indicatorBlinkOn = true
  private indicatorAssetBaseUrl = ''
  private indicatorFrameTextures: Partial<Record<IndicatorKind, Texture[]>> = {}
  private failedIndicatorKinds = new Set<IndicatorKind>()
  /**
   * 画像フレームの fetch が「実際に in-flight」な種別の集合 (#413)。
   * `failedIndicatorKinds`（確定失敗）にも `indicatorFrameTextures`（確定成功）にも属さない
   * “未確定” のうち、ここに載っている種別だけが「結果待ち＝▼ も出さない」対象になる。載って
   * いない“未確定”（`setIndicatorAssetBaseUrl`/`setIndicatorKind` が一度も呼ばれていない＝
   * そもそも fetch を試みていない作品・RPG モード等）は非回帰で ▼ を即表示する。
   */
  private pendingIndicatorKinds = new Set<IndicatorKind>()
  /**
   * インジケータ種別 (#292)。`next`=次の文（▼明滅）/ `pageturn`=改頁（❯）。
   * `setIndicatorKind` で切り替え、グリフは INDICATOR_GLYPH 表から引く。
   */
  private indicatorKind: IndicatorKind = 'next'
  /**
   * novel の文末インジケータ配置に使う、現在の表示テキストの wordwrap 結果 (#292)。
   * setNovelDialogProgressive でのみ更新する。adv（2窓含む）は #450 で positionIndicator() が
   * 右下固定へ戻ったため参照しない。
   */
  private novelWrappedLines: string[] = []
  // --- portrait ---
  private portraitFrame: Graphics | null = null
  private portraitSprite: Sprite | null = null
  private currentPortrait: string | undefined = undefined
  private currentPortraitToken = 0
  private rubyBuildToken = 0

  // --- レイアウト ---
  private boxX: number
  private boxY: number
  private boxW: number
  private boxH: number
  private padding: number
  private fontSize: number
  private fontFamily: string
  private marginX: number
  private marginBottom: number

  // --- 設定 ---
  private borderless: boolean
  private bgColor: number
  private nameColor: number
  private nameSeparateBox: boolean
  /**
   * 本文テキスト色 (#305)。既定は純白 0xffffff。NovelRenderer が話者ごと（主人公=暖アイボリー /
   * 住人=白）に `setBodyTextColor` で切り替える。本文 (`dialogText`) とルビ (`rubyEntries`) の両方に当てる。
   * 演出中間状態ではなく per-line の描画属性なので、GameState には持たず render 時に話者から決定論的に導出する。
   */
  private bodyTextColor = 0xffffff

  // --- 画面寸法（novel モードの全画面テキスト領域算出に使う #283） ---
  private screenWidth: number
  private screenHeight: number
  /**
   * novel スタイル (#283)。true のとき:
   *  - borderless 相当（枠・背景・名札なし、白文字 + DropShadow）
   *  - テキスト領域を画面の大半に拡張（boxH=180 固定を解除）
   * adv スタイルは false（従来の下部 ADV 箱）。NovelRenderer が改頁と組み合わせて使う。
   */
  private novelMode = false
  /** adv モードの ADV 箱高さ（novel → adv 復帰時に boxH を戻すため保持 #283） */
  private advBoxHeight: number
  /**
   * split_layout (#442) のテキスト領域。null = 従来ジオメトリ（adv 下部バー or novel 全画面）。
   * dialog_style（novel/adv）とは独立の軸。設定時も adv/novel どちらの見た目（枠・名札の有無・
   * DropShadow 等は setBorderless/setNovelMode が管理）にも触れず、ジオメトリ（boxX/Y/W/H）だけを
   * この矩形に固定する。`setSplitLayoutRegion` で設定・解除する。
   */
  private splitLayoutRegion: LayoutRect | null = null

  /**
   * 2窓モード (#444) のテキスト領域（相手=上/自分=下）。null = 無効（従来の単一テキスト
   * ウィンドウ、`splitLayoutRegion` 全体 or 全画面/下部バー）。`split_layout: true` かつ
   * `protagonist:` 指定時にだけ NovelRenderer が `setDualWindowRegions` で設定する。
   * 設定時は dialog_style（novel/adv）に関わらず常に無枠・名札なし（`effectiveBorderless()`）
   * で描く（Issue #444 確定仕様）。
   */
  private dualWindowRegions: DualWindowTextRegions | null = null
  /**
   * 2窓モードで現在アクティブな話者側 (#444)。`dualWindowRegions` が null のときは幾何計算に
   * 使われない（無視される）。`setDualWindowActiveRole` で Dialog ごとに切り替える。
   */
  private dualWindowActiveRole: 'self' | 'opponent' = 'self'

  // --- 状態 ---
  private currentText: string = ''
  private showing = false
  /**
   * `show()` を最後に呼んだ時刻 (performance.now())。0 = 一度も show されていない（差分が
   * 常に巨大になるためガード判定は偽になる）。
   * `isJustShown(guardMs)` 経由で「メニュー → tryTalk → dialog.show 直後に到達した tap で
   * dialog がすぐ閉じる事故」のガード判定に使う。`hide()` でリセットしない（次の `show()`
   * で上書きされるため）。
   */
  private lastShownAtMs = 0

  // --- typewriter ---
  private typewriter: TypewriterState = makeInitialTypewriterState()
  private msPerChar: number
  private indicatorWanted: boolean = false
  private onTypingDone: (() => void) | null = null

  private ticker: Ticker

  constructor(config: DialogBoxConfig) {
    super()

    const {
      screenWidth,
      screenHeight,
      boxHeight = 180,
      marginX = 20,
      marginBottom = 20,
      padding = 20,
      fontSize = 40,
      fontFamily = "'Noto Sans JP', sans-serif",
      msPerChar = DEFAULT_MS_PER_CHAR,
      borderless = false,
      bgColor = 0x000000,
      nameColor = 0xffffff,
      nameSeparateBox = true,
    } = config

    this.padding = padding
    this.fontSize = fontSize
    this.fontFamily = fontFamily
    this.msPerChar = msPerChar
    this.borderless = borderless
    this.bgColor = bgColor
    this.nameColor = nameColor
    this.nameSeparateBox = nameSeparateBox
    this.marginX = marginX
    this.marginBottom = marginBottom
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.boxW = screenWidth - marginX * 2
    this.boxH = boxHeight
    this.advBoxHeight = boxHeight
    this.boxX = marginX
    this.boxY = screenHeight - boxHeight - marginBottom

    // --- 背景 ---
    this.bg = new Graphics()
    if (!this.borderless) {
      this.drawBackground()
    }
    this.addChild(this.bg)

    // --- portrait 顔枠（常に作成し visible=false で保持） ---
    this.portraitFrame = new Graphics()
    const portraitY = this.boxY + PORTRAIT_Y_OFFSET
    this.portraitFrame.rect(PORTRAIT_X, portraitY, PORTRAIT_SIZE, PORTRAIT_SIZE)
    this.portraitFrame.fill({ color: 0x000000, alpha: 0.6 })
    this.portraitFrame.stroke({ width: 2, color: 0xffffff })
    this.portraitFrame.visible = false
    this.addChild(this.portraitFrame)

    // --- 話者名（separate box モード） ---
    this.nameBox = new Graphics()
    this.addChild(this.nameBox)

    const nameStyle = new TextStyle({
      fontFamily,
      fontSize: fontSize - 2,
      fill: this.nameColor,
      fontWeight: 'bold',
    })
    this.nameText = new Text({ text: '', style: nameStyle })
    this.nameText.x = this.boxX + padding + 8
    this.nameText.y = this.boxY - 36
    this.addChild(this.nameText)
    this.nameBox.visible = false
    this.nameText.visible = false

    // --- インライン名（nameSeparateBox = false のとき使用） ---
    if (!nameSeparateBox) {
      const inlineStyle = new TextStyle({
        fontFamily,
        fontSize: fontSize - 4,
        fill: this.nameColor,
        fontWeight: 'bold',
      })
      this.inlineNameText = new Text({ text: '', style: inlineStyle })
      this.inlineNameText.x = this.boxX + padding
      this.inlineNameText.y = this.boxY + padding
      this.inlineNameText.visible = false
      this.addChild(this.inlineNameText)
    }

    // --- ダイアログテキスト ---
    this.dialogText = new Text({ text: '', style: this.makeDialogTextStyle() })
    this.dialogText.x = this.textStartX()
    this.dialogText.y = this.textStartY()
    this.addChild(this.dialogText)

    // --- ルビ Container ---
    this.rubyContainer = new Container()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    this.addChild(this.rubyContainer)

    // --- ▼インジケーター ---
    this.indicator = new Container()
    // makeIndicatorGlyphStyle() はこの時点で必要な this.fontFamily / dualWindowActive の両方が
    // 既に確定済み（前者は上のコンストラクタ冒頭、後者はクラスフィールド初期値 null）(#447)。
    this.indicatorGlyph = new Text({ text: '▼', style: this.makeIndicatorGlyphStyle() })
    // ▼を縦方向にやや潰す (#447 追加要望2)。scale は Text の transform（style/text とは独立）
    // なので、setIndicatorKind() 等が後で style/text を再設定してもリセットされない。生成が
    // 1 箇所（ここ）だけなので、この 1 行だけで以降ずっと保持される。
    this.indicatorGlyph.scale.y = INDICATOR_GLYPH_SCALE_Y
    // 既定は表示 (#413)。画像フレームの fetch が実際に始まった（pendingIndicatorKinds に載る）
    // 種別だけ applyIndicatorFrame() が一時的に隠す。fetch を一度も試みていない作品（画像なし・
    // RPG モード等）はここでの true のまま＝非回帰で ▼ が即表示される。
    this.indicatorGlyph.visible = true
    this.indicatorSprite = new Sprite(Texture.EMPTY)
    this.indicatorSprite.width = INDICATOR_IMAGE_SIZE
    this.indicatorSprite.height = INDICATOR_IMAGE_SIZE
    this.indicatorSprite.visible = false
    this.indicator.addChild(this.indicatorSprite)
    this.indicator.addChild(this.indicatorGlyph)
    this.indicatorBaseY = this.boxY + this.boxH - 30
    this.indicator.x = this.boxX + this.boxW - 40
    this.indicator.y = this.indicatorBaseY
    this.addChild(this.indicator)

    // --- ticker ---
    this.ticker = new Ticker()
    this.ticker.add(() => {
      this.tickIndicatorFrame(this.ticker.deltaMS)
      this.tickIndicatorMotion(this.ticker.deltaMS)
      this.tickIndicatorBlink(this.ticker.deltaMS)

      // typewriter
      if (isTypingActive(this.typewriter)) {
        const next = tickTypewriter(this.typewriter, this.ticker.deltaMS, this.msPerChar)
        if (next.displayedCharCount !== this.typewriter.displayedCharCount) {
          this.dialogText.text = this.visibleDialogText(next)
          this.updateRubyVisibility(next.displayedCharCount)
        }
        const justFinished = isTypingActive(this.typewriter) && !isTypingActive(next)
        this.typewriter = next
        if (justFinished) {
          // タイプ完了 → novel ならインジケータを文末（最終 wrap 行の右）へ配置し直す (#292)。
          this.positionIndicator()
          if (this.onTypingDone) {
            const cb = this.onTypingDone
            this.onTypingDone = null
            cb()
          }
        }
      }

      this.applyIndicatorContainerVisibility()
    })
    this.ticker.start()
  }

  // ---------------------------------------------------------------------------
  // show / hide（RPG スタイル API）
  // ---------------------------------------------------------------------------

  /**
   * ダイアログを表示する（RPG スタイル用）。
   * ノベル用には `setDialog` を直接呼ぶこともできる。
   *
   * Note: ルビ記法（`漢字《かんじ》`）は RPG モードでは非対応。
   * `stripRubyMarkup` でマークアップを除去してから表示する。
   */
  show(name: string, message: string, portrait?: string): void {
    const cleanMessage = stripRubyMarkup(message)
    const previousPortrait = this.currentPortrait
    this.showing = true
    this.lastShownAtMs = performance.now()
    this.currentPortrait = portrait && portrait.length > 0 ? portrait : undefined

    // setDialog が bg.visible / showing を管理するため、ここでは bg.visible を触らない。
    // （show() で bg.visible = true した直後に setDialog() が borderless 状態に応じて上書きするのを防ぐ）
    this.setDialog(name, cleanMessage)

    // portrait
    this.applyPortraitLayout()
    if (this.currentPortrait) {
      const samePath = previousPortrait === this.currentPortrait
      this.beginPortraitLoad(this.currentPortrait, samePath)
    } else {
      this.hidePortrait()
    }
  }

  hide(): void {
    this.showing = false
    this.bg.visible = false
    this.nameBox.visible = false
    this.nameText.visible = false
    if (this.inlineNameText) this.inlineNameText.visible = false
    this.dialogText.visible = false
    this.indicator.visible = false
    this.hidePortrait()
    this.typewriter = makeInitialTypewriterState()
    this.onTypingDone = null
  }

  get isShowing(): boolean {
    return this.showing
  }

  /**
   * 直前の `show()` から `guardMs` ミリ秒以内なら true を返す。
   * 「タップによってダイアログを開いた瞬間の同一ジェスチャに含まれる二重発火 tap で
   * dialog がすぐ閉じる事故」を防ぐためのガード判定。
   */
  isJustShown(guardMs: number): boolean {
    return this.showing && performance.now() - this.lastShownAtMs < guardMs
  }

  /**
   * split_layout (#442) 用に、渡された領域（テキストウィンドウ側の半分）へ boxX/Y/W/H を合わせる。
   * `NOVEL_TEXT_MARGIN_X` / `NOVEL_TEXT_TOP_RATIO` / `NOVEL_TEXT_MARGIN_BOTTOM` と同じ余白規約を、
   * 画面全体ではなく `region` 基準で適用する（`NOVEL_TEXT_TOP_RATIO` は region.height に対する比率）。
   * dialogText/ruby/indicator への反映は呼び出し側（`applyNovelGeometry` / `redraw`）が既存の
   * 手順でそのまま行う（このメソッドは矩形の確定だけを担う）。
   *
   * #442 self-review must-1: `drawNameBox` は常に名札を箱の**上**（`boxY - NAME_BOX_HEIGHT -
   * NAME_BOX_GAP`）に描く。`NOVEL_TEXT_TOP_RATIO` は「ほぼ余白なし」の novel 全画面向け設計値
   * なので、そのまま adv（名札を描画する）に適用すると region 上端付近で名札が画面外・隣接する
   * キャラ画像領域へはみ出す。`!this.borderless`（＝名札を実際に描く adv 相当）のときだけ、
   * 名札 1 個分の上部クリアランスを追加で確保する。novel（borderless、名札を描かない）は
   * 従来どおり最小余白のまま。`updateNameDisplay` の `this.borderless` 判定と同じ軸で分岐する。
   */
  private applySplitLayoutBoxGeometry(region: LayoutRect): void {
    const topMargin = Math.round(region.height * NOVEL_TEXT_TOP_RATIO)
    const nameBoxClearance = this.borderless ? 0 : NAME_BOX_HEIGHT + NAME_BOX_GAP
    const topY = region.y + topMargin + nameBoxClearance
    this.boxX = region.x + NOVEL_TEXT_MARGIN_X
    this.boxW = region.width - NOVEL_TEXT_MARGIN_X * 2
    this.boxY = topY
    this.boxH = region.y + region.height - topY - NOVEL_TEXT_MARGIN_BOTTOM
  }

  /**
   * split_layout (#442) のテキスト領域を設定・解除する。`novelLayout.ts` の
   * `computeSplitLayoutRegions(...).text` をそのまま渡す想定。
   * null で解除し、従来ジオメトリ（adv 下部バー or novel 全画面）に戻す。
   * dialog_style（`setNovelMode` / `setBorderless`）には触れない — 見た目（枠・名札・
   * DropShadow の有無）は変えず、配置（boxX/Y/W/H）だけを変える。
   */
  setSplitLayoutRegion(region: LayoutRect | null): void {
    this.splitLayoutRegion = region
    if (this.novelMode) {
      this.applyNovelGeometry()
    } else {
      this.redraw(this.screenWidth, this.screenHeight)
    }
  }

  /** 2窓モード (#444) が有効か。`dualWindowRegions` が設定されていれば true。 */
  private get dualWindowActive(): boolean {
    return this.dualWindowRegions !== null
  }

  /**
   * 実効的な borderless 判定 (#444)。2窓モードは dialog_style（novel/adv）に関わらず常に
   * 無枠・名札なしで描く（Issue #444 確定仕様）。背景描画・名札表示・DropShadow の分岐を
   * この 1 箇所（`this.borderless` との OR）に集約する。`this.borderless` 自体（novelMode /
   * setBorderless 由来）は変えない — 2窓モード解除後に元の見た目へ正しく戻すため。
   */
  private effectiveBorderless(): boolean {
    return this.borderless || this.dualWindowActive
  }

  /**
   * 2窓モード (#444) のテキスト領域（相手=上/自分=下）を設定・解除する。
   * `novelLayout.ts` の `splitTextRegionForDualWindow(computeSplitLayoutRegions(...).text)` を
   * そのまま渡す想定。null で解除し、従来の単一テキストウィンドウ（`splitLayoutRegion` 全体、
   * 未指定なら novel 全画面 / adv 下部バー）に戻る。
   *
   * `setSplitLayoutRegion` と同様、幾何のみを担う（typewriter/テキスト内容には触れない）。
   * 背景（bg）の可視状態は次の `setDialog`/`setNovelDialogProgressive` 呼び出し時に
   * `effectiveBorderless()` から再導出されるため、ここで個別に操作する必要はない。
   *
   * ただし名札（nameBox/nameText/inlineNameText）は例外: `setProtagonist` 経由で台詞表示中に
   * 動的に2窓モードへ入ると、次の `updateNameDisplay` 呼び出し（＝次のセリフ表示）まで旧位置・
   * 旧可視状態の名札が一瞬取り残される（self-review S2）。2窓モードは常に無枠・名札なしという
   * 不変条件（`effectiveBorderless()`）と一致させるため、regions が null でなくなる（2窓モードに
   * 入る）瞬間にここで即座に隠す。null 解除時（2窓モード終了）は次の `updateNameDisplay` で
   * 正しい状態に戻るので触らない。
   *
   * ▼インジケータグリフの色（#447）も `dualWindowActive` に連動するため、regions 確定直後に
   * `indicatorGlyph.style` を再生成する（2窓モードに入った瞬間に旧・水色のまま残る/2窓モードを
   * 抜けた瞬間に話者色のまま残る、の両方を防ぐ）。
   *
   * ▼インジケータの点滅（#447 追加要望1）も `dualWindowActive` 連動なので、regions が null に
   * なった瞬間に点滅タイマーをリセットする。可視性自体は `applyIndicatorFrame()` に再計算させる
   * （画像フレームがある作品ではグリフでなくスプライト側が正しい表示のため、blind に
   * `visible = true` を代入すると2窓解除直後にグリフがスプライトへ重なって一瞬見えてしまう）。
   */
  setDualWindowRegions(regions: DualWindowTextRegions | null): void {
    this.dualWindowRegions = regions
    this.indicatorGlyph.style = this.makeIndicatorGlyphStyle()
    if (regions !== null) {
      this.nameBox.visible = false
      this.nameText.visible = false
      if (this.inlineNameText) this.inlineNameText.visible = false
    } else {
      // 2窓モード終了: 点滅を止め、OFF位相のまま抜けて▼が消えたまま残る事故を防ぐ。
      this.indicatorBlinkElapsed = 0
      this.indicatorBlinkOn = true
      this.applyIndicatorFrame()
    }
    if (this.novelMode) {
      this.applyNovelGeometry()
    } else {
      this.redraw(this.screenWidth, this.screenHeight)
    }
  }

  /**
   * 2窓モード (#444) で次に表示する話者側を指定する。`setDialog`/`setNovelDialogProgressive`
   * より前に呼ぶこと（呼ばれた時点の boxX/Y/W/H を使ってテキスト/ルビ/インジケータを
   * 配置するため）。`dualWindowRegions` が null（2窓モード無効）のときは no-op。
   *
   * ▼インジケータグリフの色（#447）もここでロール（self=白/opponent=水色）に連動させる。
   */
  setDualWindowActiveRole(role: 'self' | 'opponent'): void {
    if (!this.dualWindowRegions) return
    if (this.dualWindowActiveRole === role) return
    this.dualWindowActiveRole = role
    this.indicatorGlyph.style = this.makeIndicatorGlyphStyle()
    if (this.novelMode) {
      this.applyNovelGeometry()
    } else {
      this.redraw(this.screenWidth, this.screenHeight)
    }
  }

  /**
   * 2窓モード (#444) で、現在アクティブな話者側（self/opponent）の領域へ boxX/Y/W/H を合わせる。
   * `applySplitLayoutBoxGeometry` と同じ余白規約（NOVEL_TEXT_MARGIN_X / NOVEL_TEXT_TOP_RATIO /
   * NOVEL_TEXT_MARGIN_BOTTOM）を使うが、2窓モードは常に無枠・名札なしなので名札クリアランス
   * （`applySplitLayoutBoxGeometry` の `nameBoxClearance`）は加えない（常に 0 相当）。
   */
  private applyDualWindowBoxGeometry(): void {
    if (!this.dualWindowRegions) return
    const region = this.dualWindowRegions[this.dualWindowActiveRole]
    const topMargin = Math.round(region.height * NOVEL_TEXT_TOP_RATIO)
    this.boxX = region.x + NOVEL_TEXT_MARGIN_X
    this.boxW = region.width - NOVEL_TEXT_MARGIN_X * 2
    this.boxY = region.y + topMargin
    this.boxH = region.height - topMargin - NOVEL_TEXT_MARGIN_BOTTOM
  }

  /**
   * novel スタイル (#283) の全画面テキスト領域へ幾何を再計算する。
   * 画面の下 60%（`NOVEL_TEXT_TOP_RATIO` 以下）をテキスト域にし、左右・下に小さな余白を残す。
   * 改頁はこの領域に収まる行数 (`novelMaxLinesPerPage`) で行う。
   * split_layout (#442) 指定時は全画面ではなく `splitLayoutRegion` の矩形に収める。
   */
  private applyNovelGeometry(): void {
    if (this.dualWindowRegions) {
      // 2窓モード (#444): split_layout のテキスト領域全体ではなく、現在アクティブな
      // 話者側（相手=上/自分=下）のサブ領域へ収める。splitLayoutRegion より優先する。
      this.applyDualWindowBoxGeometry()
    } else if (this.splitLayoutRegion) {
      // split_layout (#442): 全画面ではなく渡された領域（テキストウィンドウ側の半分）へ収める。
      this.applySplitLayoutBoxGeometry(this.splitLayoutRegion)
    } else {
      const topY = Math.round(this.screenHeight * NOVEL_TEXT_TOP_RATIO)
      this.boxX = NOVEL_TEXT_MARGIN_X
      this.boxW = this.screenWidth - NOVEL_TEXT_MARGIN_X * 2
      this.boxY = topY
      this.boxH = this.screenHeight - topY - NOVEL_TEXT_MARGIN_BOTTOM
    }

    // テキスト位置更新（borderless 前提なので背景・名札は描かない）。
    this.dialogText.x = this.textStartX()
    this.dialogText.y = this.textStartY()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    // novel のインジケータは文末（最終 wrap 行の右）に置く (#292)。ここで adv の右下固定
    // （boxX+boxW-40, boxY+boxH-30）を再設定すると、resize のたびに文末配置を上書きして
    // 一瞬右下へ戻ってしまう（#292 セルフレビュー N2）。novelWrappedLines は保持済みなので
    // positionIndicator() で現在の文末へ置き直す。実 y はバウンスで ticker が base に sin を足す。
    this.positionIndicator()
  }

  /**
   * 画面リサイズ時にレイアウトを再計算する。
   */
  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    if (this.novelMode) {
      // novel モードは全画面テキスト領域なので redraw でも novel geometry を維持する。
      this.applyNovelGeometry()
      return
    }
    if (this.dualWindowRegions) {
      // 2窓モード (#444): adv でもテキスト領域全体ではなく、現在アクティブな話者側の
      // サブ領域へ固定する（dialog_style 非依存。splitLayoutRegion より優先）。
      this.applyDualWindowBoxGeometry()
    } else if (this.splitLayoutRegion) {
      // split_layout (#442): adv でも下部バーではなくテキスト領域へ固定する（dialog_style 非依存）。
      this.applySplitLayoutBoxGeometry(this.splitLayoutRegion)
    } else {
      // adv 下部バー: split_layout 解除直後は boxH が直前の applySplitLayoutBoxGeometry による
      // split 由来の値のまま残っているため、advBoxHeight へ確実にリセットしてから boxY を
      // 再計算する（setNovelMode(false) と同じパターン #442）。
      this.boxH = this.advBoxHeight
      this.boxW = screenWidth - this.marginX * 2
      this.boxX = this.marginX
      this.boxY = screenHeight - this.boxH - this.marginBottom
    }

    // 背景再描画
    this.bg.clear()
    if (!this.effectiveBorderless()) this.drawBackground()

    // テキスト位置更新
    this.dialogText.x = this.textStartX()
    this.dialogText.y = this.textStartY()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    // インジケータ配置は positionIndicator() 経由に統一する（#447 Part 1）。#450 で non-novel
    // （2窓含む）は positionIndicator() 自体が右下固定を返すようになったため直書きと等価だが、
    // 二重実装を避けるためこの経路のまま維持する。
    this.positionIndicator()

    // 名前テキスト位置
    this.nameText.x = this.boxX + this.padding + 8
    this.nameText.y = this.boxY - 36
    if (this.inlineNameText) {
      this.inlineNameText.x = this.boxX + this.padding
      this.inlineNameText.y = this.boxY + this.padding
    }

    // portrait 枠位置
    if (this.portraitFrame) {
      const portraitY = this.boxY + PORTRAIT_Y_OFFSET
      this.portraitFrame.clear()
      this.portraitFrame.rect(PORTRAIT_X, portraitY, PORTRAIT_SIZE, PORTRAIT_SIZE)
      this.portraitFrame.fill({ color: 0x000000, alpha: 0.6 })
      this.portraitFrame.stroke({ width: 2, color: 0xffffff })
    }

    if (this.showing) {
      this.applyPortraitLayout()
      if (this.currentPortrait) {
        this.beginPortraitLoad(this.currentPortrait, false)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ノベル用 API
  // ---------------------------------------------------------------------------

  /**
   * ダイアログを表示（話者名 + テキスト）。
   *
   * テキスト開始 x / wordwrap 幅は `currentPortrait` に依存する。
   * portrait を変更してからこのメソッドを呼ぶ場合は、事前に `this.currentPortrait` を
   * 更新しておくこと。`show()` 経由の場合は自動的に順序が保証される。
   *
   * @param onTypingDone タイピング完了時コールバック（オートモード用）
   */
  setDialog(name: string | null, text: string, onTypingDone?: (() => void) | null): void {
    // テキストが空 (空文字 / 空白だけ / 全角空白だけ) なら DialogBox は隠す。
    // 立ち絵を登場させるためだけの空ダイアログで ▼ インジケーターや透明枠が残るのを避ける。
    const trimmedText = text.replace(/\s/g, '').replace(/\u3000/g, '')
    if (trimmedText === '') {
      this.hide()
      this.onTypingDone = null
      // 呼び出し側 (NovelRenderer) は onTypingDone でオートモードを進めるので、
      // 即時 done を通知する
      if (onTypingDone) onTypingDone()
      return
    }
    this.currentText = text
    this.showing = true
    this.bg.visible = !this.effectiveBorderless()

    // 話者名
    this.updateNameDisplay(name)

    // テキスト
    this.dialogText.visible = true
    const font = `${this.fontSize}px ${this.fontFamily}`
    const maxTextWidth = this.maxTextWidth()
    const runs = parseRubyText(text)
    const plainText = stripRubyMarkup(text)
    const lines = wordwrap(plainText, maxTextWidth, font)
    this.typewriter = startTypewriter(lines.join('\n'))
    this.dialogText.text = ''
    this.indicator.visible = false
    this.rubyPlacements = computeRubyPlacements(runs, lines)
    this.rubyBuildToken += 1
    const rubyToken = this.rubyBuildToken
    ensureFontLoaded(this.fontFamily)
      .then(() => {
        if (rubyToken !== this.rubyBuildToken) return
        this.rebuildRubyEntries(lines, font)
        // msPerChar=0 の場合も update() が skipTypewriter() を呼ぶため、ここでの特別処理は不要。
        // setFontFamily 側は typewriter をリセットするため .then 内での即時スキップが必要（設計上の非対称点）。
      })
      .catch(() => {
        // フォントロード失敗時はルビなしで継続（クラッシュ防止）
      })
    this.onTypingDone = onTypingDone ?? null
    if (!isTypingActive(this.typewriter) && this.onTypingDone) {
      const cb = this.onTypingDone
      this.onTypingDone = null
      cb()
    }
  }

  /**
   * novel スタイルの文単位送り (#292) でページをプログレッシブ表示する。
   *
   * `cumulativeText` = そのページの「先頭〜現在の文」までを連結した本文。`shownPlainLength` =
   * そのうち「既に表示済み（前の文まで）」の plain（折返し前）文字数。
   * cumulativeText を wordwrap → `wrappedPrefixLength` で既出分の wrapped 上のインデックスを
   * 算出 → `startTypewriterFrom` で「既出分は即時表示・残りだけタイプ」する。
   * これにより既出の文は消えず同一ページに溜まり、最後に足した文だけがタイプされる。
   *
   * - 空テキスト（空文字 / 空白だけ）は既存 setDialog 同様 hide する（空ページの ▼/枠残りを避ける）。
   * - ルビは累積テキストに対して既存 parseRubyText / computeRubyPlacements 経路で解決し、既出分
   *   （fromCount 以下に reveal 位置がある）は即 reveal する。novel ページは上流で stripRubyMarkup
   *   済みのため通常ルビは無いが、経路は setDialog と揃える。
   * - インジケータ配置は文末（最終 wrap 行の右）。タイプ完了時に ticker が positionIndicator で当てる。
   *
   * @param name 話者名（novel は borderless なので名札は出ないが、後方互換で受ける）
   * @param cumulativeText 先頭〜現在の文の連結本文（既出 + 今回タイプする文）
   * @param shownPlainLength 既出プレフィックスの plain 文字数（page.sentences.slice(0,k).join('').length）
   * @param onTypingDone タイピング完了時コールバック（オートモード用）
   */
  setNovelDialogProgressive(
    name: string | null,
    cumulativeText: string,
    shownPlainLength: number,
    onTypingDone?: (() => void) | null
  ): void {
    // 空（空文字 / 空白だけ / 全角空白だけ）なら hide。setDialog と同じ規則。
    const trimmedText = cumulativeText.replace(/[\s\u3000]/g, '')
    if (trimmedText === '') {
      this.hide()
      this.onTypingDone = null
      if (onTypingDone) onTypingDone()
      return
    }
    this.currentText = cumulativeText
    this.showing = true
    this.bg.visible = !this.effectiveBorderless()

    // 話者名（novel = borderless で updateNameDisplay は名札を出さないが、経路は揃える）
    this.updateNameDisplay(name)

    this.dialogText.visible = true
    const font = `${this.fontSize}px ${this.fontFamily}`
    const maxTextWidth = this.maxTextWidth()
    const runs = parseRubyText(cumulativeText)
    const plainText = stripRubyMarkup(cumulativeText)
    const lines = wordwrap(plainText, maxTextWidth, font)
    const fullText = lines.join('\n')
    // 既出 plain 文字数を plainText 長にクランプし、wordwrap の \n を跨いだ wrapped 上の
    // インデックス（fromCount）へ変換する。plain 長さ ≠ wrapped 長さ なので純関数で吸収する。
    const clampedPlainPrefix = Math.max(0, Math.min(plainText.length, Math.floor(shownPlainLength)))
    const fromCount = wrappedPrefixLength(fullText, clampedPlainPrefix)
    this.typewriter = startTypewriterFrom(fullText, fromCount)
    // 既出分（fromCount 文字）は即時表示する。残りは ticker がタイプする。
    this.dialogText.text = this.visibleDialogText(this.typewriter)
    this.indicator.visible = false
    // novel 配置用に累積テキストの wrap 結果を保持する (#292)。
    this.novelWrappedLines = lines
    // 表示はタイプ完了まで抑えるが、座標はこの時点で現在文末へ同期しておく。
    // 旧座標のまま visible になる 1 フレームの跳ねを防ぐ (#333)。
    this.positionIndicator()
    this.rubyPlacements = computeRubyPlacements(runs, lines)
    this.rubyBuildToken += 1
    const rubyToken = this.rubyBuildToken
    ensureFontLoaded(this.fontFamily)
      .then(() => {
        if (rubyToken !== this.rubyBuildToken) return
        this.rebuildRubyEntries(lines, font)
        // 既出分のルビは即 reveal、これからタイプする分は displayedCharCount 連動で出す。
        this.updateRubyVisibility(this.typewriter.displayedCharCount)
      })
      .catch(() => {
        // フォントロード失敗時はルビなしで継続（クラッシュ防止）
      })
    this.onTypingDone = onTypingDone ?? null
    // 既に全文表示済み（今回タイプする文が無い＝fromCount == length）なら即 done + 配置。
    if (!isTypingActive(this.typewriter)) {
      this.positionIndicator()
      if (this.onTypingDone) {
        const cb = this.onTypingDone
        this.onTypingDone = null
        cb()
      }
    }
  }

  clearText(): void {
    this.rubyBuildToken += 1
    this.typewriter = makeInitialTypewriterState()
    this.dialogText.text = ''
    this.currentText = ''
    this.onTypingDone = null
    this.novelWrappedLines = []
    this.clearRubyEntries()
  }

  skipTypewriter(): void {
    if (!isTypingActive(this.typewriter)) return
    this.typewriter = typewriterSkip(this.typewriter)
    this.dialogText.text = this.visibleDialogText(this.typewriter)
    this.revealAllRuby()
    this.onTypingDone = null
    // スキップ完了で文末まで一気に出るので、novel ならインジケータを文末へ置き直す (#292)。
    // ticker の justFinished はスキップ（直接代入）では発火しないため、ここで明示的に当てる。
    this.positionIndicator()
  }

  isTyping(): boolean {
    return isTypingActive(this.typewriter)
  }

  /**
   * タイプ完了コールバックを「今から」差し替える (#302)。
   *
   * `setDialog` / `setNovelDialogProgressive` は描画時点の onTypingDone を確定するため、
   * auto OFF で描画された行は callback=null になる。その行のタイプ進行中に auto を ON にした
   * 場合、この live 張り替えで「現在タイプ中の行が完了したら scheduleAutoAdvance する」よう
   * 直す。タイプ中でなければ（既に完了済み）即その場で 1 回だけ呼ぶ（既存の即時 done と同型）。
   *
   * `cb=null` を渡すと解除（auto OFF 時に呼び、OFF 中に完了して誤進行するのを防ぐ）。
   * 完了時の発火は ticker の justFinished 分岐が `onTypingDone` を一度 null にしてから呼ぶため
   * 1 回だけ消費される（二重発火しない）。
   */
  setOnTypingDone(cb: (() => void) | null): void {
    this.onTypingDone = cb
    if (cb && !isTypingActive(this.typewriter)) {
      // 既にタイプ完了済み → onTypingDone は今後発火しないので、その場で 1 回だけ消費する。
      this.onTypingDone = null
      cb()
    }
  }

  setMsPerChar(msPerChar: number): void {
    this.msPerChar = Math.max(0, msPerChar)
    if (this.msPerChar === 0) {
      this.skipTypewriter()
    }
  }

  /** 現在のタイプライター速度（ms/文字）。playScript の保存/復元用 (#220)。 */
  getMsPerChar(): number {
    return this.msPerChar
  }

  /**
   * 本文テキスト色を設定する (#305)。
   *
   * NovelRenderer が render() 時に話者から決定論的に決めて呼ぶ（主人公=やや暖かいアイボリー #FFF0D8 /
   * 住人=純白 #FFFFFF）。本文 (`dialogText`) と表示中ルビ (`rubyEntries`) の両方に当てる。
   * 値が同じなら no-op（毎 render 呼び出しでも style を作り直さない）。
   *
   * これは per-line の描画属性であり演出中間状態ではないため、GameState には持たない。
   * 復元時も render() が話者から再導出するので、色だけを別途復元する必要はない。
   */
  setBodyTextColor(color: number): void {
    if (this.bodyTextColor === color) return
    this.bodyTextColor = color
    this.dialogText.style = this.makeDialogTextStyle()
    const rubyStyle = this.makeRubyTextStyle()
    for (const e of this.rubyEntries) {
      e.text.style = rubyStyle
    }
  }

  /** 現在の本文テキスト色 (#305)。テスト・配線検証用。 */
  getBodyTextColor(): number {
    return this.bodyTextColor
  }

  setBorderless(borderless: boolean): void {
    if (this.borderless === borderless) return
    this.borderless = borderless
    this.bg.clear()
    if (!this.effectiveBorderless()) {
      this.drawBackground()
    }
    this.dialogText.style = this.makeDialogTextStyle()
    const rubyStyle = this.makeRubyTextStyle()
    for (const e of this.rubyEntries) {
      e.text.style = rubyStyle
    }
    if (this.effectiveBorderless()) {
      this.nameBox.visible = false
      this.nameText.visible = false
      if (this.inlineNameText) this.inlineNameText.visible = false
    }
  }

  /**
   * novel スタイル (#283) の ON/OFF を切り替える。
   *
   * ON のとき:
   *  - borderless 相当（枠・背景・名札なし、白文字 + DropShadow）にする
   *  - テキスト領域を画面の大半に拡張する（`boxH=180` 固定を解除し全画面ノベル化）
   * OFF（adv）は従来の下部 ADV 箱に戻す。
   *
   * 名札 OFF と DropShadow は `setBorderless(true)` のロジックを流用する（novel は実質 borderless 描画）。
   * 改頁・スクリムは NovelRenderer 側が制御する。本メソッドは DialogBox の幾何と外観だけを担う。
   */
  setNovelMode(novel: boolean): void {
    // 早期 return しない（冪等に再適用する）。NovelRenderer は setEvents 内で
    // `setBorderless(defaultDialogBorderless)` を呼んだ直後に setNovelMode を呼び直すため、
    // 「novelMode は変わっていないが borderless が剥がされた」状態でも novel 描画を復元する必要がある。
    this.novelMode = novel
    // novel は枠なし白文字（名札 OFF）。setBorderless の既存ロジックを流用する。
    // setBorderless は同値ガードで no-op になり得るので、borderless が既に望む値でも
    // 確実に geometry を再適用するため下の applyNovelGeometry / redraw を必ず通す。
    this.setBorderless(novel)
    if (novel) {
      this.applyNovelGeometry()
    } else {
      // adv に戻す: 下部 ADV 箱の幾何へ復帰する。
      this.boxH = this.advBoxHeight
      this.redraw(this.screenWidth, this.screenHeight)
    }
  }

  /** novel スタイルか (#283)。NovelRenderer が改頁・スクリムの分岐に使う。 */
  get isNovelMode(): boolean {
    return this.novelMode
  }

  /**
   * 本文を 1 行ずつ wordwrap し、各文の占有行数を測るためのメトリクスを提供する (#283)。
   * novel 改頁（`paginateSentencesByLines`）の入力に使う。
   * 純粋関数の wordwrap を現在のフォント設定で呼ぶだけのアダプタ。
   */
  measureLineCount(plainText: string): number {
    const font = `${this.fontSize}px ${this.fontFamily}`
    return wordwrap(plainText, this.maxTextWidth(), font).length
  }

  /**
   * novel モードで 1 ページに収まる最大行数 (#283)。
   * 利用可能テキスト高さ ÷ 行高（端数切り捨て・最低 1）。
   */
  novelMaxLinesPerPage(): number {
    const usable = this.boxH - this.padding * 2
    return Math.max(1, Math.floor(usable / this.lineHeight()))
  }

  setFontFamily(family: string): void {
    if (this.fontFamily === family) return
    this.fontFamily = family
    this.dialogText.style = this.makeDialogTextStyle()
    this.nameText.style = new TextStyle({
      fontFamily: family,
      fontSize: this.fontSize - 2,
      fill: this.nameColor,
      fontWeight: 'bold',
    })
    // インライン名（nameSeparateBox=false）も per-game フォントに追従させる。
    // setFontSize は inlineNameText を作り直すのに setFontFamily が漏らしていた非対称を是正
    // （#287 review nit）。インライン名だけ旧フォントで残るのを防ぐ。
    if (this.inlineNameText) {
      this.inlineNameText.style = new TextStyle({
        fontFamily: family,
        fontSize: this.fontSize - 4,
        fill: this.nameColor,
        fontWeight: 'bold',
      })
    }
    this.indicatorGlyph.style = this.makeIndicatorGlyphStyle()
    if (this.currentText) {
      const font = `${this.fontSize}px ${this.fontFamily}`
      const maxTextWidth = this.maxTextWidth()
      const runs = parseRubyText(this.currentText)
      const plainText = stripRubyMarkup(this.currentText)
      const lines = wordwrap(plainText, maxTextWidth, font)
      const fullText = lines.join('\n')
      const visiblePlainLength = this.visibleDialogText(this.typewriter).replace(/\n/g, '').length
      this.typewriter = startTypewriterFrom(
        fullText,
        wrappedPrefixLength(fullText, visiblePlainLength)
      )
      this.dialogText.text = this.visibleDialogText(this.typewriter)
      this.rubyPlacements = computeRubyPlacements(runs, lines)
      this.rubyBuildToken += 1
      const rubyToken = this.rubyBuildToken
      ensureFontLoaded(this.fontFamily)
        .then(() => {
          if (rubyToken !== this.rubyBuildToken) return
          this.rebuildRubyEntries(lines, font)
          if (this.msPerChar === 0) {
            this.skipTypewriter()
            this.dialogText.text = fullText
            this.revealAllRuby()
          } else if (!isTypingActive(this.typewriter)) {
            this.dialogText.text = fullText
            this.revealAllRuby()
          } else {
            this.dialogText.text = ''
            this.updateRubyVisibility(0)
          }
        })
        .catch(() => {
          // フォントロード失敗時はルビなしで継続（クラッシュ防止）
        })
    }
  }

  /**
   * 本文フォントサイズ (px) を切り替える (#283 補遺)。
   * frontmatter `font_size:` の per-game 値（未指定なら runtime 既定 40）を渡す。
   * setFontFamily と同じく依存する TextStyle を作り直し、表示中テキストがあれば
   * 同フォントで再 wordwrap・再レイアウトする。novel モード中は改頁が boxH/行高
   * 依存なので redraw で geometry を再適用する。
   *
   * font_family と違いフォント lazy load を伴わないため即時反映してよい（数値変更のみ）。
   */
  setFontSize(size: number): void {
    // 0 / 負値で fontSize が潰れるのを防ぐ防御（極端な大値は許容）。
    const next = Math.max(1, Math.round(size))
    if (this.fontSize === next) return
    this.fontSize = next

    // 本文・名札・インライン名・インジケーターの TextStyle を作り直す。
    // 名札系は fontSize 相対（-2 / -4）でサイズが決まるので追従させる。
    // インジケーター（▼）は固定 20px のまま（本文サイズと独立した UI 記号）。
    this.dialogText.style = this.makeDialogTextStyle()
    this.nameText.style = new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: this.fontSize - 2,
      fill: this.nameColor,
      fontWeight: 'bold',
    })
    if (this.inlineNameText) {
      this.inlineNameText.style = new TextStyle({
        fontFamily: this.fontFamily,
        fontSize: this.fontSize - 4,
        fill: this.nameColor,
        fontWeight: 'bold',
      })
    }

    // novel モードは geometry（boxH / 行高 / 改頁）に影響するため再適用する。
    // adv モードでもテキスト開始 y（インライン名の下）が fontSize 依存なので redraw で
    // 位置を取り直す。
    if (this.novelMode) {
      this.applyNovelGeometry()
    } else {
      this.redraw(this.screenWidth, this.screenHeight)
    }

    // 表示中テキストがあれば新フォントサイズで再 wordwrap・再レイアウトする。
    // font lazy load は不要なので setFontFamily の .then を待たず同期で再構築する。
    if (this.currentText) {
      const font = `${this.fontSize}px ${this.fontFamily}`
      const maxTextWidth = this.maxTextWidth()
      const runs = parseRubyText(this.currentText)
      const plainText = stripRubyMarkup(this.currentText)
      const lines = wordwrap(plainText, maxTextWidth, font)
      const fullText = lines.join('\n')
      this.typewriter = startTypewriter(fullText)
      this.rubyPlacements = computeRubyPlacements(runs, lines)
      this.rubyBuildToken += 1
      this.rebuildRubyEntries(lines, font)
      if (this.msPerChar === 0) {
        this.skipTypewriter()
        this.dialogText.text = fullText
        this.revealAllRuby()
      } else if (!isTypingActive(this.typewriter)) {
        this.dialogText.text = fullText
        this.revealAllRuby()
      } else {
        this.dialogText.text = ''
        this.updateRubyVisibility(0)
      }
    }
  }

  setIndicatorVisible(visible: boolean): void {
    this.indicatorWanted = visible
    if (visible) this.positionIndicator()
    // #447 must: 点滅位相の ON リセットも含め、可視性確定は applyIndicatorContainerVisibility()
    // に一本化する（ticker からの呼び出しと同じ「非表示→表示」判定を通す）。
    this.applyIndicatorContainerVisibility()
  }

  /**
   * ゲームリポの assets/images ベース URL を設定する。`assets/images/ui/text-next-*.webp` /
   * `page-turn-*.webp` が存在する作品では画像フレームのカーソルを使い、存在しない作品では
   * 従来のグリフにフォールバックする。
   */
  setIndicatorAssetBaseUrl(url: string): void {
    if (this.indicatorAssetBaseUrl === url) return
    this.indicatorAssetBaseUrl = url
    this.indicatorFrameTextures = {}
    this.failedIndicatorKinds.clear()
    // #413 S1: pendingIndicatorKinds も併せてクリアする。`loadIndicatorFrames` は S1 で
    // 「既に pending 中なら再フェッチしない」ガードを持つため、ここでクリアしないと旧 baseUrl
    // の未解決 fetch が残した pending 状態のせいで、新 baseUrl 用の正当な再フェッチが誤って
    // 短絡されてしまう（旧 fetch の解決は下の `.then`/`.catch` の baseUrl 不一致ガードで
    // 別途無視されるので、ここで消しても「触ると新 fetch 完了前に一瞬 pending が外れる」問題は
    // 起きない＝直後の `loadIndicatorFrames` 呼び出しが同期的に入れ直す）。
    this.pendingIndicatorKinds.clear()
    this.loadIndicatorFrames(this.indicatorKind)
    // #413 re-review S1: `loadIndicatorFrames` がフレッシュフェッチ分岐（in-flight を新規に
    // 開始するケース）に入ると `applyIndicatorFrame()` を同期的に呼ばない設計のため、旧 baseUrl
    // で既に確定表示していたスプライト（visible=true・旧テクスチャ）がここで止まると新 fetch が
    // 解決するまで残存表示されてしまう。M1 と同じ理屈で `applyIndicatorFrame()` は現在の3集合を
    // 読むだけの冪等関数なので、ここで明示的に呼び直して pending 中は非表示にする不変条件を
    // baseUrl 切替の瞬間にも適用する。
    this.applyIndicatorFrame()
  }

  /**
   * インジケータの種別を切り替える (#292)。`next`=次の文（▼）/ `pageturn`=改頁（❯）。
   * グリフは INDICATOR_GLYPH 表（1 箇所集約）から引く。種別が変わったら配置も取り直す
   * （記号幅が変わるとはみ出しクランプが変わるため）。
   */
  setIndicatorKind(kind: IndicatorKind): void {
    if (this.indicatorKind === kind && this.indicatorGlyph.text === INDICATOR_GLYPH[kind]) {
      // #413 M1: この早期return自体は変わらないが、`applyIndicatorFrame()` を呼ばずに戻ると
      // pending 状態の変化（例: この呼び出し直前に `setIndicatorAssetBaseUrl` が fetch を開始した
      // ばかり）が glyph/sprite の可視状態へ反映されない。コンストラクタ既定値 kind='next' と
      // 一致するセッション最初の `setIndicatorKind('next')` 呼び出しがまさにこの分岐を通るため、
      // ここで呼ばないと #413 が最も一般的なケース（最初に使う kind が既定値と一致）で再発する。
      // `applyIndicatorFrame()` は現在の3集合を読むだけの冪等関数なので毎回呼んでも安全。
      this.applyIndicatorFrame()
      return
    }
    this.indicatorKind = kind
    this.indicatorGlyph.text = INDICATOR_GLYPH[kind]
    this.indicatorFrameElapsed = 0
    this.indicatorFrameIndex = 0
    this.loadIndicatorFrames(kind)
    this.applyIndicatorFrame()
    this.positionIndicator()
  }

  /**
   * インジケータの基準位置を現在のモードに合わせて確定する (#292 / #450)。
   *  - novel: 表示テキストの**最後の wrap 行の右端**（文末の右）。
   *  - adv（2窓含む）: 常に右下固定（`boxX + boxW - 40`, `boxY + boxH - 30`）。
   *    #447 で 2窓 adv だけ novel と同じ文末追従に変えたが、kako-jun の実機確認で「adv なんだし
   *    カーソルは右下固定だと思っていた」との指摘を受け #450 で右下固定へ戻した。2窓の boxY/boxH
   *    は `applyDualWindowBoxGeometry()` によりアクティブなサブ領域（相手=上/自分=下）自身の値に
   *    なっているため、この固定オフセットはサブ領域自身の右下付近になる。
   * `indicatorBaseY` を設定し、x を確定する。実 y は 2窓モードでは静止・それ以外はバウンスのため
   * ticker が base に sin を足す（#447）。
   */
  private positionIndicator(): void {
    if (!this.novelMode) {
      // adv（2窓含む）: 右下固定。redraw 等が既に設定している x/baseY を尊重しつつ再アサート。
      this.indicator.x = this.boxX + this.boxW - 40
      this.indicatorBaseY = this.boxY + this.boxH - 30
      this.indicator.y = this.indicatorBaseY
      return
    }
    // novel: 最終 wrap 行の右端へ。lines が空（未設定）なら 1 行 / 幅 0 として扱う。
    const lines = this.novelWrappedLines
    const lineCount = lines.length >= 1 ? lines.length : 1
    const lastLine = lines.length > 0 ? lines[lines.length - 1] : ''
    const font = `${this.fontSize}px ${this.fontFamily}`
    const lastLineWidth = this.measureTextWidth(lastLine, font)
    const indicatorWidth = this.measureIndicatorWidth(font)
    // インジケータの高さ (#300)。本番（WebGL）では実測 height（fontSize 20 の ▼/❯ は行間込みで
    // おおむね ~24-27px）を使い、行 band の縦中央へ正確に揃える。jsdom は canvas 2d ctx が null で
    // Text.height が measureFont で throw するため measureIndicatorHeight() が 0 を返す。その場合だけ
    // 20（= indicator の fontSize。実 height より小さいが縦中央化の方向は保つ）に倒すフォールバック
    // 値であって、本番の実 height ではない（measureTextWidth の ctx ガードと同趣旨の退化）。
    const indicatorHeight = this.measureIndicatorHeight() || 20
    const placement = computeNovelIndicatorPlacement({
      textStartX: this.textStartX(),
      textStartY: this.textStartY(),
      lineCount,
      lastLineWidth,
      lineHeight: this.lineHeight(),
      indicatorWidth,
      indicatorHeight,
      boxRightEdge: this.boxX + this.boxW - this.padding,
      // 次行送り (#306) の y クランプ用にテキスト領域の下端を渡す。満杯ページで記号が箱外へ
      // 飛ばないようにする。
      boxBottom: this.boxY + this.boxH - this.padding,
    })
    this.indicator.x = placement.x
    this.indicatorBaseY = placement.y
    this.indicator.y = this.indicatorBaseY
  }

  /** 指定 font で文字列の表示幅（px）を測る。ctx が無い jsdom では 0 を返す（配置は退化的に左端寄せ）。 */
  private measureTextWidth(s: string, font: string): number {
    const ctx = getMeasureContext()
    if (!ctx) return 0
    ctx.font = font
    return ctx.measureText(s).width
  }

  /**
   * インジケータ記号の表示高さ（px）を測る (#300)。Pixi の `Text.height` は bounds 計算で
   * canvas 2d を使うため、ctx が null の jsdom では `measureFont` が throw する。例外時は 0 を
   * 返し、呼び出し側で fontSize ベース（20）にフォールバックさせる（measureTextWidth と同趣旨）。
   */
  private measureIndicatorHeight(): number {
    if (this.hasIndicatorImages()) return INDICATOR_IMAGE_SIZE
    try {
      const h = this.indicatorGlyph.height
      return Number.isFinite(h) && h > 0 ? h : 0
    } catch {
      return 0
    }
  }

  private measureIndicatorWidth(font: string): number {
    if (this.hasIndicatorImages()) return INDICATOR_IMAGE_SIZE
    return this.measureTextWidth(this.indicatorGlyph.text, font) || 20
  }

  private hasIndicatorImages(): boolean {
    return (this.indicatorFrameTextures[this.indicatorKind]?.length ?? 0) > 0
  }

  /**
   * 種別 1 つ分の画像フレームをロードする (#292)。
   *
   * #413: 「読み込み中かどうか」を確定させるため 3 分岐に分ける。
   *  1. 既にロード済み／既に確定失敗済み／既に fetch が in-flight（`pendingIndicatorKinds`）
   *     → 再フェッチせず、現在の確定状態（または pending 中の非表示状態）を再適用するだけ。
   *     pending 判定 (#413 S1) が無いと、同一 kind への短時間の出入り（例: next→pageturn→next
   *     と戻ってきたが next の fetch がまだ解決していない）で `Assets.load` が重複発火する。
   *  2. `indicatorAssetBaseUrl` が未設定（＝そもそもこの作品にアセットが設定されていない＝
   *     将来も絶対に成功しない）→ 即座に確定失敗として扱う（▼ フォールバックを即表示させる）。
   *  3. それ以外（実際にフェッチする）→ `pendingIndicatorKinds` に載せてから fetch を開始する。
   *     結果が確定する（then/catch）までは `applyIndicatorFrame()` を呼ばない＝▼ もスプライトも
   *     出さない「読み込み中は何も見せない」状態を保つ。
   */
  private loadIndicatorFrames(kind: IndicatorKind): void {
    if (
      this.indicatorFrameTextures[kind] ||
      this.failedIndicatorKinds.has(kind) ||
      this.pendingIndicatorKinds.has(kind)
    ) {
      this.applyIndicatorFrame()
      return
    }
    if (!this.indicatorAssetBaseUrl) {
      this.failedIndicatorKinds.add(kind)
      this.applyIndicatorFrame()
      return
    }
    const baseUrl = this.indicatorAssetBaseUrl
    const urls = getIndicatorImageUrls(baseUrl, kind)
    this.pendingIndicatorKinds.add(kind)
    Promise.all(urls.map((url) => Assets.load(url)))
      .then((loaded) => {
        // baseUrl が変わっていたら古い結果。pendingIndicatorKinds は新しい fetch の分をまだ
        // 表しているはずなので触らない（触ると新 fetch 完了前に一瞬 pending が外れてしまう）。
        if (this.indicatorAssetBaseUrl !== baseUrl) return
        this.pendingIndicatorKinds.delete(kind)
        const textures = loaded.filter((tex): tex is Texture => tex instanceof Texture)
        if (textures.length !== urls.length) {
          this.failedIndicatorKinds.add(kind)
          if (this.indicatorKind === kind) this.applyIndicatorFrame()
          return
        }
        this.indicatorFrameTextures[kind] = textures
        if (this.indicatorKind === kind) {
          this.applyIndicatorFrame()
          this.positionIndicator()
        }
      })
      .catch((err: unknown) => {
        if (this.indicatorAssetBaseUrl !== baseUrl) return
        this.pendingIndicatorKinds.delete(kind)
        this.failedIndicatorKinds.add(kind)
        console.warn(`[DialogBox] failed to load ${kind} indicator images:`, err)
        if (this.indicatorKind === kind) this.applyIndicatorFrame()
      })
  }

  private tickIndicatorFrame(deltaMs: number): void {
    const frames = this.indicatorFrameTextures[this.indicatorKind]
    if (!frames || frames.length === 0) return
    this.indicatorFrameElapsed += deltaMs
    if (this.indicatorFrameElapsed < INDICATOR_FRAME_MS) return
    const steps = Math.floor(this.indicatorFrameElapsed / INDICATOR_FRAME_MS)
    this.indicatorFrameElapsed %= INDICATOR_FRAME_MS
    this.indicatorFrameIndex = (this.indicatorFrameIndex + steps) % frames.length
    this.applyIndicatorFrame()
  }

  private tickIndicatorMotion(deltaMs: number): void {
    if (this.hasIndicatorImages()) {
      this.indicator.y = this.indicatorBaseY
      return
    }
    if (this.dualWindowActive) {
      // 2窓モード (#447 指摘1): 端末/ドット風の世界観にバウンスが合わないという kako-jun の
      // 実機指摘を受け、フォールバック▼グリフも画像フレームと同様に静止させる（他ゲームの
      // 従来バウンスは非2窓なので下の分岐のまま非回帰）。
      this.indicator.y = this.indicatorBaseY
      return
    }
    // グリフ fallback 用の従来バウンス。画像フレームは自前で動くため揺らさない。
    this.indicatorTime = (this.indicatorTime + deltaMs / 1000) % ((2 * Math.PI) / 3)
    this.indicator.y = this.indicatorBaseY + Math.sin(this.indicatorTime * 3) * 4
  }

  /**
   * 2窓モード (#447 追加要望1) の▼グリフを 1 秒間隔で機械的に点滅させる（端末カーソル風。
   * なめらかなフェードではなく visible を ON/OFF でカチッと切り替える）。
   *
   * `tickIndicatorMotion` が担う Y座標の静止とは独立の軸: 位置には触れず可視性だけを反転する。
   * 画像フレーム（`hasIndicatorImages()`）のときは対象外（グリフフォールバック限定の演出。
   * 既存の sin バウンスも画像フレームには適用されない設計なので同じ条件分岐に倣う）。
   * 2窓モードでないとき、または画像フレームがあるときは `indicatorGlyph.visible` に触れない
   * （可視性は `applyIndicatorFrame()` 等の既存ロジックに委ねる）。累積値だけリセットしておき、
   * 次に2窓モード・グリフフォールバックへ入った瞬間に ON（可視）から点滅を開始できるようにする。
   */
  private tickIndicatorBlink(deltaMs: number): void {
    if (this.hasIndicatorImages() || !this.dualWindowActive) {
      this.indicatorBlinkElapsed = 0
      this.indicatorBlinkOn = true
      return
    }
    // tickIndicatorFrame と同じ O(1) スタイル（累積 → Math.floor で経過ステップ数を出し、
    // %= で余りに丸める）に揃える。奇数ステップ分だけ ON/OFF が反転する（偶数ステップは往復して元に戻る）。
    this.indicatorBlinkElapsed += deltaMs
    const steps = Math.floor(this.indicatorBlinkElapsed / INDICATOR_BLINK_MS)
    if (steps > 0) {
      this.indicatorBlinkElapsed %= INDICATOR_BLINK_MS
      if (steps % 2 === 1) {
        this.indicatorBlinkOn = !this.indicatorBlinkOn
      }
    }
    this.indicatorGlyph.visible = this.indicatorBlinkOn
  }

  /**
   * `indicator` コンテナの可視性を「非表示 → 表示」の遷移として確定する (#447 self-review must)。
   *
   * `tickIndicatorBlink` は `indicator` が実際に見えているかに関わらず毎フレーム無条件に呼ばれる
   * ため、`indicatorBlinkElapsed` はタイプ表示中（`indicator` 自体が非表示）も壁時計時間で積み
   * 上がり続ける。その状態のままタイプが完了して `indicator` が実際に見える瞬間を迎えると、
   * `indicatorGlyph.visible` が壁時計基準で ON/OFF どちらになっているか分からず、約半分の行で
   * 「読み終わって送りたいのに▼が最大1秒近く見えない」事故になっていた。
   *
   * ここで「今フレームの新しい可視状態」と「直前の可視状態」を比較し、非表示 → 表示へ切り替わる
   * 瞬間だけ点滅位相を `indicatorBlinkElapsed = 0` / `indicatorBlinkOn = true`（ON）へ明示リセット
   * する。2窓モードのグリフ点滅（画像フレームなし）が対象で、画像フレーム表示中はグリフの
   * 可視性を `applyIndicatorFrame()` に委ねるため触らない。
   *
   * ticker（毎フレーム）と `setIndicatorVisible`（NovelRenderer からの明示呼び出し。タイプが
   * 既に完了済み＝msPerChar=0 やページ内で追加文字が無いケースはここが実際の遷移点になる）の
   * 両方から呼ぶ — どちらが本番で実際の遷移フレームになるかは呼び出し順とタイミング次第のため。
   */
  private applyIndicatorContainerVisibility(): void {
    const newVisible = this.indicatorWanted && !isTypingActive(this.typewriter)
    if (
      newVisible &&
      !this.indicator.visible &&
      this.dualWindowActive &&
      !this.hasIndicatorImages()
    ) {
      this.indicatorBlinkElapsed = 0
      this.indicatorBlinkOn = true
      this.indicatorGlyph.visible = true
    }
    this.indicator.visible = newVisible
  }

  /**
   * 表示中インジケータ（sprite/glyph）の可視状態を確定する (#292 / #413)。
   *
   * 3 状態:
   *  - 画像フレームが揃っている → sprite を表示し ▼ グリフは隠す（従来どおり）。
   *  - 画像フレームは無いが fetch が in-flight（`pendingIndicatorKinds` に載っている）→
   *    sprite も ▼ グリフも隠す。「結果未確定の間は何も見せない」が #413 の本題。
   *  - それ以外（fetch を試みていない／確定失敗） → 従来どおり ▼ グリフへフォールバックする。
   */
  private applyIndicatorFrame(): void {
    const frames = this.indicatorFrameTextures[this.indicatorKind]
    if (frames && frames.length > 0) {
      this.indicatorSprite.texture = frames[this.indicatorFrameIndex % frames.length]
      this.indicatorSprite.width = INDICATOR_IMAGE_SIZE
      this.indicatorSprite.height = INDICATOR_IMAGE_SIZE
      this.indicatorSprite.visible = true
      this.indicatorGlyph.visible = false
      return
    }
    this.indicatorSprite.visible = false
    this.indicatorGlyph.visible = !this.pendingIndicatorKinds.has(this.indicatorKind)
  }

  dispose(): void {
    this.clearRubyEntries()
    this.ticker.stop()
    this.ticker.destroy()
  }

  // ---------------------------------------------------------------------------
  // private: レイアウト
  // ---------------------------------------------------------------------------

  private textStartX(): number {
    if (this.currentPortrait) {
      return PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN
    }
    return this.boxX + this.padding
  }

  private textStartY(): number {
    if (!this.nameSeparateBox && this.inlineNameText) {
      // インライン名の下
      return this.boxY + this.padding + (this.fontSize - 4) + 4
    }
    return this.boxY + this.padding
  }

  private maxTextWidth(): number {
    const left = this.currentPortrait
      ? PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN
      : this.boxX + this.padding
    return this.boxX + this.boxW - this.padding - left
  }

  private updateNameDisplay(name: string | null): void {
    if (this.effectiveBorderless() || !name) {
      this.nameBox.visible = false
      this.nameText.visible = false
      if (this.inlineNameText) this.inlineNameText.visible = false
      return
    }
    if (this.nameSeparateBox) {
      this.nameText.text = name
      const measured = this.nameText.width
      this.drawNameBox(measured)
      this.nameBox.visible = true
      this.nameText.visible = true
      if (this.inlineNameText) this.inlineNameText.visible = false
    } else {
      if (this.inlineNameText) {
        this.inlineNameText.text = name
        this.inlineNameText.visible = true
      }
      this.nameBox.visible = false
      this.nameText.visible = false
    }
  }

  private drawBackground(): void {
    this.bg.clear()
    this.bg.roundRect(this.boxX, this.boxY, this.boxW, this.boxH, 8)
    this.bg.fill({ color: this.bgColor, alpha: 0.92 })
    this.bg.roundRect(this.boxX, this.boxY, this.boxW, this.boxH, 8)
    this.bg.stroke({ color: 0xf1faee, width: 2, alpha: 1 })
  }

  private drawNameBox(textWidth: number): void {
    const nameBoxW = textWidth + this.padding * 2 + 16
    const nameBoxH = NAME_BOX_HEIGHT
    const nameBoxX = this.boxX
    const nameBoxY = this.boxY - nameBoxH - NAME_BOX_GAP

    this.nameBox.clear()
    this.nameBox.roundRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH, 6)
    this.nameBox.fill({ color: this.bgColor, alpha: 0.92 })
    this.nameBox.roundRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH, 6)
    this.nameBox.stroke({ color: 0xf1faee, width: 2, alpha: 1 })

    this.nameText.x = nameBoxX + this.padding
    this.nameText.y = nameBoxY + (nameBoxH - this.fontSize + 2) / 2
  }

  private makeDialogTextStyle(): TextStyle {
    return new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      // 本文色 (#305): 既定は白。主人公セリフのときだけ NovelRenderer が暖アイボリーに切り替える。
      fill: this.bodyTextColor,
      lineHeight: this.lineHeight(),
      dropShadow: this.effectiveBorderless() ? BORDERLESS_DROP_SHADOW : false,
    })
  }

  /**
   * ▼インジケータグリフの色を現在の状態から決定する (#447)。2窓モードでなければ従来の水色
   * （非回帰）。2窓モードでは `dualWindowActiveRole` に連動: 自分=白 / 相手=水色。
   */
  private indicatorGlyphColor(): number {
    if (!this.dualWindowActive) return INDICATOR_GLYPH_COLOR
    return this.dualWindowActiveRole === 'self'
      ? DUAL_WINDOW_SELF_INDICATOR_COLOR
      : DUAL_WINDOW_OPPONENT_INDICATOR_COLOR
  }

  /** ▼インジケータグリフ用 TextStyle を作る (#447)。フォント切替・2窓ロール切替の両方から呼ぶ。 */
  private makeIndicatorGlyphStyle(): TextStyle {
    return new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: 20,
      fill: this.indicatorGlyphColor(),
    })
  }

  private visibleDialogText(state: TypewriterState): string {
    // 本文は verbatim で描く (#356)。ダッシュ・長音符などの glyph 統一はエンジンで行わない
    // （原稿＝単一情報源を描画層が書き換えない）。表記統一が要るなら原稿側で揃える。
    return visibleText(state)
  }

  /**
   * ルビ用 TextStyle を作る (#307)。本文色 (#305) と borderless DropShadow をルビにも揃える。
   * 旧来 setBorderless / setBodyTextColor / rebuildRubyEntries の 3 経路に独立生成されていた同一
   * スタイル式を 1 箇所に集約し、将来のルビ様式変更を 1 箇所修正で済むようにする（挙動不変）。
   */
  private makeRubyTextStyle(): TextStyle {
    return new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: this.rubyFontSize(),
      // ルビも本文色 (#305) に合わせる（主人公=暖アイボリー / 住人=白）。
      fill: this.bodyTextColor,
      dropShadow: this.effectiveBorderless() ? BORDERLESS_DROP_SHADOW : false,
    })
  }

  private lineHeight(): number {
    return this.fontSize * 1.6
  }

  private rubyFontSize(): number {
    return Math.max(12, Math.round(this.fontSize * 0.5))
  }

  // ---------------------------------------------------------------------------
  // private: portrait
  // ---------------------------------------------------------------------------

  private applyPortraitLayout(): void {
    const hasPortrait = !!this.currentPortrait
    if (this.portraitFrame) {
      this.portraitFrame.visible = hasPortrait && this.showing
    }
    const tx = this.textStartX()
    this.dialogText.x = tx
    this.rubyContainer.x = tx
  }

  private hidePortrait(): void {
    if (this.portraitFrame) this.portraitFrame.visible = false
    if (this.portraitSprite) this.portraitSprite.visible = false
  }

  private beginPortraitLoad(path: string, keepSpriteVisible: boolean): void {
    this.currentPortraitToken += 1
    const token = this.currentPortraitToken
    if (!keepSpriteVisible && this.portraitSprite) {
      this.portraitSprite.visible = false
    }

    void loadPortraitTexture(path).then(
      (texture) => {
        if (token !== this.currentPortraitToken) return
        if (!this.portraitFrame) return

        const portraitY = this.boxY + PORTRAIT_Y_OFFSET
        const fit = computePortraitContainFit(
          texture.width,
          texture.height,
          PORTRAIT_X,
          portraitY,
          PORTRAIT_SIZE
        )

        if (!this.portraitSprite) {
          const sprite = new Sprite(texture)
          sprite.x = fit.x
          sprite.y = fit.y
          sprite.width = fit.width
          sprite.height = fit.height
          this.portraitSprite = sprite
          this.addChild(sprite)
        } else {
          this.portraitSprite.texture = texture
          this.portraitSprite.x = fit.x
          this.portraitSprite.y = fit.y
          this.portraitSprite.width = fit.width
          this.portraitSprite.height = fit.height
        }
        this.portraitSprite.visible = this.showing && !!this.currentPortrait
      },
      () => {
        if (token !== this.currentPortraitToken) return
        if (this.portraitSprite) this.portraitSprite.visible = false
      }
    )
  }

  // ---------------------------------------------------------------------------
  // private: ruby
  // ---------------------------------------------------------------------------

  private rebuildRubyEntries(lines: string[], font: string): void {
    for (const e of this.rubyEntries) {
      this.rubyContainer.removeChild(e.text)
      e.text.destroy()
    }
    this.rubyEntries = []

    if (this.rubyPlacements.length === 0) return

    const ctx = getMeasureContext()
    if (ctx) ctx.font = font
    const measure = (s: string): number =>
      ctx ? ctx.measureText(s).width : s.length * this.fontSize

    const lineHeight = this.lineHeight()
    const rubyFontSize = this.rubyFontSize()
    const rubyStyle = this.makeRubyTextStyle()

    for (const p of this.rubyPlacements) {
      const line = lines[p.lineIndex] ?? ''
      const before = line.substring(0, p.charStartInLine)
      const baseStr = line.substring(p.charStartInLine, p.charEndInLine)
      const xStart = measure(before)
      const baseWidth = measure(baseStr)
      const rubyWidth = measure(p.ruby)
      const xRubyCenter = xStart + baseWidth / 2
      const xRuby = xRubyCenter - rubyWidth / 2
      const yLineTop = p.lineIndex * lineHeight
      const yRuby = yLineTop - rubyFontSize + 2

      const t = new Text({ text: p.ruby, style: rubyStyle })
      t.x = xRuby
      t.y = yRuby
      t.visible = false
      this.rubyContainer.addChild(t)
      this.rubyEntries.push({ placement: p, text: t })
    }
  }

  private updateRubyVisibility(displayedCharCount: number): void {
    for (const e of this.rubyEntries) {
      e.text.visible = displayedCharCount >= e.placement.revealAt
    }
  }

  private revealAllRuby(): void {
    for (const e of this.rubyEntries) {
      e.text.visible = true
    }
  }

  private clearRubyEntries(): void {
    for (const e of this.rubyEntries) {
      this.rubyContainer.removeChild(e.text)
      e.text.destroy()
    }
    this.rubyEntries = []
    this.rubyPlacements = []
  }
}
