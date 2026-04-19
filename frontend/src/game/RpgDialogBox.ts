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

import { Assets, Container, Graphics, Sprite, Text as PixiText, TextStyle, Texture } from 'pixi.js'

/**
 * portrait 顔枠の表示サイズ（px）。ダイアログ高 120 に対して 80x80 に収め、
 * 左 20px 余白 + 枠 80 + 余白 20 = テキスト開始 120px というレイアウトを取る。
 */
const PORTRAIT_SIZE = 80

/**
 * portrait テクスチャの loader キャッシュ。
 * パスごとに Promise<Texture | null> を覚え、同一パスへの複数コール時に
 * 重複ロードを避ける。ロード失敗時は null を保持し、以降は placeholder で描画する。
 *
 * HMR 等で module が再評価された場合は新しい Map になるが、PIXI Assets 側も
 * 内部キャッシュを持つため二重ロードにはならない。
 */
const portraitCache: Map<string, Promise<Texture | null>> = new Map()

function loadPortraitTexture(path: string): Promise<Texture | null> {
  const cached = portraitCache.get(path)
  if (cached) return cached
  const promise = Assets.load(path)
    .then((tex) => tex as Texture)
    .catch((err: unknown) => {
      console.warn(`[RpgDialogBox] failed to load portrait "${path}":`, err)
      return null
    })
  portraitCache.set(path, promise)
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
  private currentPortraitToken = 0
  private screenWidth: number
  private screenHeight: number
  private showing = false

  constructor(screenWidth: number, screenHeight: number) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.build()
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
    this.showing = true
    this.currentName = name
    this.currentMessage = message
    this.currentPortrait = portrait && portrait.length > 0 ? portrait : undefined

    if (this.bg) this.bg.visible = true
    if (this.nameText) {
      this.nameText.text = name
      this.nameText.visible = true
    }
    if (this.messageText) {
      this.messageText.text = message
      this.messageText.visible = true
    }

    this.applyPortraitLayout()
    if (this.currentPortrait) {
      this.beginPortraitLoad(this.currentPortrait)
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
        this.messageText.text = this.currentMessage
        this.messageText.visible = true
      }
      this.applyPortraitLayout()
      if (this.currentPortrait) {
        this.beginPortraitLoad(this.currentPortrait)
      }
    }
  }

  override destroy(): void {
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

  private build(): void {
    const height = 120
    const width = this.screenWidth - 40
    const boxTop = this.screenHeight - 140

    const bg = new Graphics()
    bg.roundRect(20, boxTop, width, height, 8)
    bg.fill({ color: 0x000033, alpha: 0.92 })
    bg.stroke({ width: 3, color: 0xffffff })
    bg.visible = this.showing
    this.bg = bg
    this.addChild(bg)

    // 顔枠（portrait 指定時のみ表示）。build 時点では常に作成し visible=false で保持。
    // 位置はダイアログ左端: x=40 (bg の左端 20 + padding 20), y=boxTop+20（上下 20px ずつ余白）。
    const portraitFrame = new Graphics()
    const portraitX = 40
    const portraitY = boxTop + 20
    portraitFrame.rect(portraitX, portraitY, PORTRAIT_SIZE, PORTRAIT_SIZE)
    portraitFrame.fill({ color: 0x000000, alpha: 0.6 })
    portraitFrame.stroke({ width: 2, color: 0xffffff })
    portraitFrame.visible = false
    this.portraitFrame = portraitFrame
    this.addChild(portraitFrame)

    // 画像 Sprite は Texture 確定後に差し込むが、placeholder 段階では Sprite を作らず Graphics のみ表示する

    const nameStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xffe066,
      fontWeight: 'bold',
    })
    const name = new PixiText({ text: this.currentName, style: nameStyle })
    name.x = 40
    name.y = boxTop + 10
    name.visible = this.showing
    this.nameText = name
    this.addChild(name)

    const textStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xffffff,
      wordWrap: true,
      wordWrapWidth: width - 40,
      breakWords: true,
      lineHeight: 26,
    })
    const message = new PixiText({ text: this.currentMessage, style: textStyle })
    message.x = 40
    message.y = boxTop + 40
    message.visible = this.showing
    this.messageText = message
    this.addChild(message)

    const mask = new Graphics()
    mask.rect(20, boxTop, width, height)
    mask.fill(0xffffff)
    this.maskGraphics = mask
    this.addChild(mask)
    message.mask = mask
  }

  /**
   * currentPortrait の有無に応じてレイアウトを切り替える。
   * - portrait あり: 顔枠を表示、テキスト開始 x を顔枠右側に寄せる（40 → 140）、wordWrapWidth を縮める
   * - portrait なし: 顔枠を隠し、テキスト開始 x を 40 に戻す（従来挙動）
   */
  private applyPortraitLayout(): void {
    const boxTop = this.screenHeight - 140
    const boxWidth = this.screenWidth - 40
    const hasPortrait = !!this.currentPortrait

    if (this.portraitFrame) {
      this.portraitFrame.visible = hasPortrait && this.showing
    }

    // テキスト開始 x: portrait ありなら顔枠 (40 + 80 + 20 = 140)、なしなら従来 40
    const textStartX = hasPortrait ? 40 + PORTRAIT_SIZE + 20 : 40
    // wordWrapWidth: portrait ありなら縮める、なしなら従来 (width - 40)
    const wordWrap = hasPortrait ? boxWidth - (PORTRAIT_SIZE + 20 + 40) : boxWidth - 40

    if (this.nameText) {
      this.nameText.x = textStartX
      this.nameText.y = boxTop + 10
    }
    if (this.messageText) {
      this.messageText.x = textStartX
      this.messageText.y = boxTop + 40
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
   * ロード失敗時は Sprite を作らず portraitFrame (黒枠プレースホルダ) のみ表示。
   */
  private beginPortraitLoad(path: string): void {
    this.currentPortraitToken += 1
    const token = this.currentPortraitToken
    // 既存 Sprite は一旦隠す（新しい texture に差し替わるまでの間はフレームのみ）
    if (this.portraitSprite) this.portraitSprite.visible = false

    void loadPortraitTexture(path).then((texture) => {
      // トークンが古い（別の show 呼び出しで上書きされた）なら何もしない
      if (token !== this.currentPortraitToken) return
      // destroy 後なら無視
      if (!this.portraitFrame) return
      if (!texture) return // placeholder のまま

      // 位置計算は build の portraitFrame と同じ
      const boxTop = this.screenHeight - 140
      const portraitX = 40
      const portraitY = boxTop + 20

      if (!this.portraitSprite) {
        const sprite = new Sprite(texture)
        sprite.x = portraitX
        sprite.y = portraitY
        sprite.width = PORTRAIT_SIZE
        sprite.height = PORTRAIT_SIZE
        this.portraitSprite = sprite
        // portraitFrame の上に乗せる（addChild で最後が最前面）
        this.addChild(sprite)
      } else {
        this.portraitSprite.texture = texture
        this.portraitSprite.x = portraitX
        this.portraitSprite.y = portraitY
        this.portraitSprite.width = PORTRAIT_SIZE
        this.portraitSprite.height = PORTRAIT_SIZE
      }
      this.portraitSprite.visible = this.showing && !!this.currentPortrait

      // message mask よりも前面にしたいので、mask を再 addChild して最背面→最前面を調整
      // （mask 自体は message.mask として使われており、表示順には寄与しないが、Sprite の上に出たくないので再設定）
      if (this.maskGraphics && this.messageText) {
        this.removeChild(this.maskGraphics)
        this.addChild(this.maskGraphics)
      }
    })
  }
}
