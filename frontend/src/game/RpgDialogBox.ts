/**
 * PixiJS ベースの RPG 用ダイアログボックス。
 *
 * TopDownRenderer / RaycastRenderer で共通利用する会話 UI。
 * - 紺背景 + 白枠 + 黄色話者名 + 白本文（PixiText wordWrap）
 * - 長文は mask でボックス内にクリップ
 * - Issue #73 Phase 1: NPC の portrait 指定時は左側に 80x80 の顔枠を表示（VN 風）。
 *   portrait 未指定時は従来通り顔枠なし（後方互換）。
 *
 * ノベル用 DialogBox（話者名別枠 + ▼インジケーター + 禁則ワードラップ）とは見た目が別系統のため独立クラスとして分離している。
 */

import {
  Assets,
  Container,
  Graphics,
  Sprite,
  Text as PixiText,
  TextStyle,
  Texture,
  Ticker,
} from 'pixi.js'
import {
  type TypewriterState,
  isTypingActive,
  makeInitialTypewriterState,
  skipTypewriter as typewriterSkip,
  startTypewriter,
  tickTypewriter,
  visibleText,
} from './typewriter'
import { stripRubyMarkup } from './ruby'

/** typewriter のデフォルト速度（ms/char）。設定画面 #138 で上書き可能になる前提 */
const DEFAULT_RPG_MS_PER_CHAR = 30

/**
 * レイアウト定数（モジュール export）。
 *
 * ダイアログ全体は画面下部に幅 `screenWidth - SIDE_MARGIN*2`、高さ `DIALOG_HEIGHT` で配置される。
 * portrait 顔枠はダイアログ内左端に `PORTRAIT_SIZE × PORTRAIT_SIZE` で配置し、
 * テキスト開始 x は portrait あり時に `PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN` にシフトする。
 *
 * 計算式:
 *   dialog width  = screenWidth - SIDE_MARGIN*2
 *   textStartX    = portrait あり ? PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN : TEXT_X_NO_PORTRAIT
 *   wordWrapWidth = portrait あり ? dialog width - (PORTRAIT_SIZE + PORTRAIT_MARGIN + PORTRAIT_X)
 *                                 : dialog width - TEXT_INNER_PADDING
 *
 * テストもこの export を使って計算式で assert しているので、数値を変えたら両方追従する。
 */
export const PORTRAIT_SIZE = 80

/**
 * portrait 画像を `PORTRAIT_SIZE` 正方形枠に「contain」（アスペクト比維持で内接）するときの
 * 表示矩形を計算する純関数 (#104)。余白は portraitFrame の半透明黒で埋まる前提。
 *
 * 縮退ケース:
 * - texture が未ロードで `srcW`/`srcH` が 0 の場合: 枠と同じサイズを返してフォールバック描画にする
 * - 比率が枠と同じ場合: 余白なし（枠ぴったり）
 *
 * (frameX, frameY) は portrait 枠の左上座標。返り値の x/y はその枠内で中央揃えする位置。
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
export const PORTRAIT_MARGIN = 20
export const PORTRAIT_X = 40
export const DIALOG_HEIGHT = 120
export const DIALOG_BOTTOM_MARGIN = 20
export const SIDE_MARGIN = 20
export const TEXT_X_NO_PORTRAIT = 40
export const TEXT_INNER_PADDING = 40
export const NAME_Y_OFFSET = 10
export const MESSAGE_Y_OFFSET = 40
export const PORTRAIT_Y_OFFSET = 20

/**
 * portrait テクスチャの loader キャッシュ。
 * パスごとに Promise<Texture> を覚え、同一パスへの複数コール時に重複ロードを避ける。
 *
 * 失敗した Promise はキャッシュに残さない（`.catch` 内で `delete` する）。
 * これにより一時的な 404 で以降永続的に placeholder が固定される問題を防ぎ、
 * 次回 show で自動的に再試行される。
 *
 * HMR 等で module が再評価された場合は新しい Map になるが、PIXI Assets 側も
 * 内部キャッシュを持つため二重ロードにはならない。
 */
const portraitCache: Map<string, Promise<Texture>> = new Map()

function loadPortraitTexture(path: string): Promise<Texture> {
  const cached = portraitCache.get(path)
  if (cached) return cached
  const promise = Assets.load(path).then((tex: unknown) => {
    // 型 guard: Assets.load の戻りは unknown なので Texture かを明示的に検証する
    if (!(tex instanceof Texture)) {
      throw new Error(`[RpgDialogBox] loaded asset for "${path}" is not a Texture`)
    }
    return tex
  })
  // 先にキャッシュ登録してから failure handler を繋ぐ（set → catch の順で意図を明確化）。
  // 同じ path が呼び出された場合は cached を返し、ここでの set は実行されない。
  // なお Assets.load は常に非同期なので順序差が現実のレースになることはないが、意図として自然な並びにしておく。
  portraitCache.set(path, promise)
  // 失敗したらキャッシュから除去（以降の show で再試行可能にする）。
  // 呼び出し側（beginPortraitLoad）は .then の 2 引数形 or .catch で reject も扱うので、
  // ここで握り潰しても Unhandled Rejection にはならない（同じ promise を cached として返す経路でも同様）。
  promise.catch((err: unknown) => {
    console.warn(`[RpgDialogBox] failed to load portrait "${path}":`, err)
    portraitCache.delete(path)
  })
  return promise
}

export class RpgDialogBox extends Container {
  private bg: Graphics | null = null
  private nameText: PixiText | null = null
  private messageText: PixiText | null = null
  private maskGraphics: Graphics | null = null
  private portraitFrame: Graphics | null = null
  private portraitSprite: Sprite | null = null
  private currentName = ''
  private currentMessage = ''
  private currentPortrait: string | undefined = undefined
  /**
   * 非同期 portrait ロードの race 条件防止用トークン。
   * 別 NPC の show() が来たら increment し、古い Promise の解決時点で
   * token の不一致を見て破棄する。
   * 実用上 1 セッション内に 2^53 回 show することはないため number のままで問題ない。
   */
  private currentPortraitToken = 0
  private screenWidth: number
  private screenHeight: number
  private showing = false

  /** typewriter 状態 (#150 / #137 と共通 helper) */
  private typewriter: TypewriterState = makeInitialTypewriterState()
  /** typewriter: 1 文字あたり ms */
  private msPerChar: number = DEFAULT_RPG_MS_PER_CHAR
  /** typewriter 進行 + show 中のみ動かす ticker */
  private ticker: Ticker

  constructor(screenWidth: number, screenHeight: number) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.build()

    // typewriter ticker: show 中のみ tick を消費する。constructor では走らせず、
    // show() で start、hide() / destroy() で stop する。
    this.ticker = new Ticker()
    this.ticker.add(() => {
      if (!isTypingActive(this.typewriter)) return
      const next = tickTypewriter(this.typewriter, this.ticker.deltaMS, this.msPerChar)
      if (next.displayedCharCount !== this.typewriter.displayedCharCount && this.messageText) {
        this.messageText.text = visibleText(next)
      }
      this.typewriter = next
    })
  }

  get isShowing(): boolean {
    return this.showing
  }

  /**
   * ダイアログを表示する。
   * @param name 話者名
   * @param message 本文
   * @param portrait NPC の portrait 相対パス。未指定または空文字なら顔枠を表示しない
   */
  show(name: string, message: string, portrait?: string): void {
    // RpgDialogBox は現状ルビ非対応。Dialog/Narration と異なり NPC.message には
    // ルビ overlay を実装していないため、`漢字《かんじ》` 記法が含まれた場合は
    // ルビ markup を取り除いて plain として表示する (#148 R1 S2)。
    // 将来 RpgDialogBox にルビ対応を入れるならここで parseRubyText を呼ぶ。
    const cleanMessage = stripRubyMarkup(message)
    const previousPortrait = this.currentPortrait
    this.showing = true
    this.currentName = name
    this.currentMessage = cleanMessage
    this.currentPortrait = portrait && portrait.length > 0 ? portrait : undefined

    if (this.bg) this.bg.visible = true
    if (this.nameText) {
      this.nameText.text = name
      this.nameText.visible = true
    }
    if (this.messageText) {
      // typewriter: 全文を保持し、displayedCharCount を 0 から進めていく
      this.typewriter = startTypewriter(cleanMessage)
      this.messageText.text = ''
      this.messageText.visible = true
    }
    if (!this.ticker.started) this.ticker.start()

    this.applyPortraitLayout()
    if (this.currentPortrait) {
      // ちらつき防止: 同じ portrait path の場合は既存 Sprite の visible を落とさない。
      // path が変わる場合も、まず texture 差し替えを試み、成功時に visible=true を維持する。
      const samePath = previousPortrait === this.currentPortrait
      this.beginPortraitLoad(this.currentPortrait, samePath)
    } else {
      this.hidePortrait()
    }
  }

  hide(): void {
    this.showing = false
    if (this.bg) this.bg.visible = false
    if (this.nameText) this.nameText.visible = false
    if (this.messageText) this.messageText.visible = false
    this.hidePortrait()
    // typewriter 状態クリア + ticker 停止 (CPU 節約)
    this.typewriter = makeInitialTypewriterState()
    if (this.ticker.started) this.ticker.stop()
  }

  /**
   * typewriter 表示中なら全文を即時表示し完了させる (#150)。
   * 表示完了済み or hide 中なら何もしない。
   */
  skipTypewriter(): void {
    if (!isTypingActive(this.typewriter)) return
    this.typewriter = typewriterSkip(this.typewriter)
    if (this.messageText) this.messageText.text = visibleText(this.typewriter)
  }

  /**
   * typewriter が進行中（まだ全文表示されていない）か。
   */
  isTyping(): boolean {
    return isTypingActive(this.typewriter)
  }

  /**
   * typewriter 速度を設定する (#138 設定画面から呼ぶ前提)。
   * @param msPerChar 1 文字あたり ms。0 以下は瞬間表示扱い。
   */
  setMsPerChar(msPerChar: number): void {
    this.msPerChar = Math.max(0, msPerChar)
    if (this.msPerChar === 0) {
      this.skipTypewriter()
    }
  }

  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.disposeChildren()
    this.build()
    // redraw 後も表示継続させるため、show 状態なら再適用
    if (this.showing) {
      if (this.bg) this.bg.visible = true
      if (this.nameText) {
        this.nameText.text = this.currentName
        this.nameText.visible = true
      }
      if (this.messageText) {
        // redraw 時は typewriter の現在状態を保ったまま再描画する
        this.messageText.text = visibleText(this.typewriter)
        this.messageText.visible = true
      }
      this.applyPortraitLayout()
      if (this.currentPortrait) {
        // redraw では Sprite が destroy されて消えているので keepVisible は false（新規生成扱い）。
        // token を進めることで、redraw 前に in-flight だった古い load が解決しても差し替えないようにする。
        this.beginPortraitLoad(this.currentPortrait, false)
      }
    }
  }

  override destroy(): void {
    // typewriter ticker を完全に停止・破棄してリーク防止
    if (this.ticker.started) this.ticker.stop()
    this.ticker.destroy()
    // super.destroy({ children: true }) が自身と全子要素を破棄する
    this.bg = null
    this.nameText = null
    this.messageText = null
    this.maskGraphics = null
    this.portraitFrame = null
    this.portraitSprite = null
    super.destroy({ children: true })
  }

  private disposeChildren(): void {
    this.removeChildren()
    if (this.bg) {
      this.bg.destroy()
      this.bg = null
    }
    if (this.nameText) {
      this.nameText.destroy()
      this.nameText = null
    }
    if (this.messageText) {
      this.messageText.destroy()
      this.messageText = null
    }
    if (this.maskGraphics) {
      this.maskGraphics.destroy()
      this.maskGraphics = null
    }
    if (this.portraitFrame) {
      this.portraitFrame.destroy()
      this.portraitFrame = null
    }
    if (this.portraitSprite) {
      this.portraitSprite.destroy()
      this.portraitSprite = null
    }
  }

  /** ダイアログ本体の画面 Y 上端（build / applyPortraitLayout / beginPortraitLoad で共有）。 */
  private getBoxTop(): number {
    return this.screenHeight - DIALOG_HEIGHT - DIALOG_BOTTOM_MARGIN
  }

  /** ダイアログ本体の幅（画面幅 - 左右 SIDE_MARGIN）。 */
  private getBoxWidth(): number {
    return this.screenWidth - SIDE_MARGIN * 2
  }

  private build(): void {
    const boxTop = this.getBoxTop()
    const width = this.getBoxWidth()

    const bg = new Graphics()
    bg.roundRect(SIDE_MARGIN, boxTop, width, DIALOG_HEIGHT, 8)
    bg.fill({ color: 0x000033, alpha: 0.92 })
    bg.stroke({ width: 3, color: 0xffffff })
    bg.visible = this.showing
    this.bg = bg
    this.addChild(bg)

    // 顔枠（portrait 指定時のみ表示）。build 時点では常に作成し visible=false で保持。
    // 位置はダイアログ左端: x=PORTRAIT_X, y=boxTop+PORTRAIT_Y_OFFSET。
    const portraitFrame = new Graphics()
    const portraitY = boxTop + PORTRAIT_Y_OFFSET
    portraitFrame.rect(PORTRAIT_X, portraitY, PORTRAIT_SIZE, PORTRAIT_SIZE)
    portraitFrame.fill({ color: 0x000000, alpha: 0.6 })
    portraitFrame.stroke({ width: 2, color: 0xffffff })
    portraitFrame.visible = false
    this.portraitFrame = portraitFrame
    this.addChild(portraitFrame)

    // 画像 Sprite は Texture 確定後に差し込むが、texture ロード前は Sprite を作らず
    // Graphics の黒枠プレースホルダのみが見える状態にしておく

    const nameStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xffe066,
      fontWeight: 'bold',
    })
    const name = new PixiText({ text: this.currentName, style: nameStyle })
    name.x = TEXT_X_NO_PORTRAIT
    name.y = boxTop + NAME_Y_OFFSET
    name.visible = this.showing
    this.nameText = name
    this.addChild(name)

    const textStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xffffff,
      wordWrap: true,
      wordWrapWidth: width - TEXT_INNER_PADDING,
      breakWords: true,
      lineHeight: 26,
    })
    const message = new PixiText({ text: this.currentMessage, style: textStyle })
    message.x = TEXT_X_NO_PORTRAIT
    message.y = boxTop + MESSAGE_Y_OFFSET
    message.visible = this.showing
    this.messageText = message
    this.addChild(message)

    const mask = new Graphics()
    mask.rect(SIDE_MARGIN, boxTop, width, DIALOG_HEIGHT)
    mask.fill(0xffffff)
    this.maskGraphics = mask
    this.addChild(mask)
    message.mask = mask
  }

  /**
   * currentPortrait の有無に応じてレイアウトを切り替える。
   * - portrait あり: 顔枠を表示、テキスト開始 x を顔枠右側に寄せる、wordWrapWidth を縮める
   * - portrait なし: 顔枠を隠し、テキスト開始 x を TEXT_X_NO_PORTRAIT に戻す（従来挙動）
   */
  private applyPortraitLayout(): void {
    const boxTop = this.getBoxTop()
    const boxWidth = this.getBoxWidth()
    const hasPortrait = !!this.currentPortrait

    if (this.portraitFrame) {
      this.portraitFrame.visible = hasPortrait && this.showing
    }

    // テキスト開始 x: portrait ありなら顔枠右側、なしなら従来位置
    const textStartX = hasPortrait
      ? PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN
      : TEXT_X_NO_PORTRAIT
    // wordWrapWidth: portrait ありなら縮める、なしなら従来
    const wordWrap = hasPortrait
      ? boxWidth - (PORTRAIT_SIZE + PORTRAIT_MARGIN + PORTRAIT_X)
      : boxWidth - TEXT_INNER_PADDING

    if (this.nameText) {
      this.nameText.x = textStartX
      this.nameText.y = boxTop + NAME_Y_OFFSET
    }
    if (this.messageText) {
      this.messageText.x = textStartX
      this.messageText.y = boxTop + MESSAGE_Y_OFFSET
      // style は immutable style 差し替えを避けて直接 wordWrapWidth を更新
      this.messageText.style.wordWrapWidth = wordWrap
    }
  }

  private hidePortrait(): void {
    if (this.portraitFrame) this.portraitFrame.visible = false
    if (this.portraitSprite) this.portraitSprite.visible = false
  }

  /**
   * portrait のテクスチャを非同期ロードして Sprite を差し込む。
   * token でレース条件（別 NPC に切り替わったあとで前のロードが解決）を防ぐ。
   *
   * @param path portrait パス
   * @param keepSpriteVisible true なら既存 Sprite の visible を落とさず差し替えまで維持する（ちらつき防止）
   *
   * ロード失敗時は Sprite を作らず（または既存 Sprite を隠し）、portraitFrame
   * （黒枠プレースホルダ）のみが表示されたまま残る。
   */
  private beginPortraitLoad(path: string, keepSpriteVisible: boolean): void {
    this.currentPortraitToken += 1
    const token = this.currentPortraitToken
    // path 切替時は既存 Sprite を一旦隠す（前の顔が新 texture 差し替えまで見え続けないように）。
    // 同一 path なら visible を落とさず、差し替え時もそのまま表示を維持してちらつきを防ぐ。
    if (!keepSpriteVisible && this.portraitSprite) {
      this.portraitSprite.visible = false
    }

    void loadPortraitTexture(path).then(
      (texture) => {
        // トークンが古い（別の show/redraw で上書きされた）なら何もしない
        if (token !== this.currentPortraitToken) return
        // destroy 後なら無視
        if (!this.portraitFrame) return

        const boxTop = this.getBoxTop()
        const portraitY = boxTop + PORTRAIT_Y_OFFSET

        // 縦長立ち絵対応 (#104): contain モードでアスペクト比を保ったまま PORTRAIT_SIZE 枠に内接させる。
        // 余白は portraitFrame の半透明黒で埋まる。
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
          // portraitFrame の上に乗せる（addChild で最後が最前面）
          this.addChild(sprite)
        } else {
          this.portraitSprite.texture = texture
          this.portraitSprite.x = fit.x
          this.portraitSprite.y = fit.y
          this.portraitSprite.width = fit.width
          this.portraitSprite.height = fit.height
        }
        // 成功時は visible=true を維持（keepSpriteVisible の有無に関わらず、差し替え成功 = 表示）
        this.portraitSprite.visible = this.showing && !!this.currentPortrait

        // message mask よりも前面にしたいので、mask を再 addChild して表示順を調整
        // （mask 自体は message.mask として使われており、表示順には寄与しないが、Sprite の上に出たくないので再設定）
        if (this.maskGraphics && this.messageText) {
          this.removeChild(this.maskGraphics)
          this.addChild(this.maskGraphics)
        }
      },
      () => {
        // 失敗時: ロード失敗（`loadPortraitTexture` 内で警告済み）。既存 Sprite は
        // 視覚的な古い顔が残らないよう隠し、黒枠プレースホルダのみの状態にする。
        if (token !== this.currentPortraitToken) return
        if (this.portraitSprite) this.portraitSprite.visible = false
      }
    )
  }
}
