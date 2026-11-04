/**
 * 全画面メニュー (#880) のフィールド側の配線（開閉・≡ ボタン・キー振り分け・入力の遮断）。
 * PixiJS / DOM に触れず、狭い依存 `FieldMenuHostDeps` だけを受けるので単体テストできる（`fieldSample/main.ts` が実物を渡す）。
 *
 * 要点:
 * - `busy`（開き始め〜閉じ切るまで）の間、フィールドは入力を受けず時間も進めない。開き始め（テクスチャ待ち）から止める。
 * - 「◀戻る」や右クリックでメニューを閉じた同じ pointerdown がフィールドへ抜けないよう、
 *   pointerdown の**始まった時点で**メニューが塞いでいたかを `beginPointer`（window の capture）で記録する。
 *   Pixi の EventSystem は canvas の pointerdown を capture で聞くので、メニューの close は canvas の bubble 側の
 *   ハンドラより先に走る。bubble 側は `isMenuBlocked`（記録）だけを見る。
 */
import {
  canOpenMenu,
  computeMenuButtonRect,
  isMenuOpenKey,
  pointInRect,
  type FieldMenuConfig,
  type FieldMenuInfo,
  type Rect,
} from './fieldMenu'
import type { FieldMenuOpenData } from './FieldMenuScreen'

/** ホストが使うメニュー画面の面（`FieldMenuScreen` が満たす） */
export interface FieldMenuScreenLike {
  readonly isOpen: boolean
  readonly transitioning: boolean
  readonly settings: Record<string, number>
  handleKey(code: string): boolean
  open(data: FieldMenuOpenData): void
  resize(width: number, height: number): void
  setTimed(timed: boolean): void
  setInfo(info: FieldMenuInfo): void
  tick(dtMs: number): void
}

export interface FieldMenuFace {
  w: number
  h: number
  /** 画面上の表示倍率（canvas の CSS 幅 / 論理幅） */
  cssScale: number
}

export interface FieldMenuHostDeps {
  screen: FieldMenuScreenLike
  config: FieldMenuConfig
  /** メニューを置く面の大きさと表示倍率（≡ ボタンの表示と当たりで同じ値を使う） */
  face(): FieldMenuFace
  /** フィールド側の状態でメニューを開けるか（会話・戦闘・演出・ワープ中は不可） */
  fieldState(): {
    battle: boolean
    battleTransition: boolean
    talking: boolean
    transition: boolean
    warp: boolean
  }
  /** 開き始めの準備（歩き入力の破棄など）と、パーティ・スロットの組み立て（テクスチャ待ちを含む） */
  prepare(): Promise<Pick<FieldMenuOpenData, 'party' | 'slots'>>
  info(): FieldMenuInfo
  timed(): boolean
  /** フィールドの表示を隠して contain する・戻す */
  enterView(face: FieldMenuFace): void
  leaveView(): void
  /** ≡ ボタンの表示。null = 隠す */
  drawButton(rect: Rect | null): void
  disposed(): boolean
}

export interface KeyLike {
  code: string
  repeat: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

const MOVE_CODES = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]

export class FieldMenuHost {
  private opening = false
  private settings: Record<string, number> = {}
  private pointerBlocked = false
  private lastInfo = ''
  private lastButtonKey = ''

  constructor(private readonly d: FieldMenuHostDeps) {}

  /** 開き始め（テクスチャ待ち）から閉じ切るまで。この間フィールドは入力を受けず、時間も進めない */
  get busy(): boolean {
    return this.opening || this.d.screen.isOpen || this.d.screen.transitioning
  }

  private canOpenNow(): boolean {
    return !this.busy && canOpenMenu(this.d.fieldState())
  }

  /** 開く。開けない状態・開き始めの最中は何もしない。開けたら true */
  async open(): Promise<boolean> {
    if (!this.canOpenNow()) return false
    this.opening = true
    let entered = false
    try {
      const prepared = await this.d.prepare()
      // 読み込み中に会話・戦闘などが始まったら開かない
      if (this.d.disposed() || !canOpenMenu(this.d.fieldState())) return false
      const face = this.d.face()
      this.d.screen.resize(face.w, face.h)
      this.d.screen.setTimed(this.d.timed())
      this.d.drawButton(null)
      this.d.enterView(face)
      entered = true
      this.d.screen.open({
        items: this.d.config.items,
        party: prepared.party,
        slots: prepared.slots,
        info: this.d.info(),
        settings: this.settings,
      })
      return true
    } catch (e) {
      // 準備・表示の失敗は握る（unhandled rejection にしない）。開き始めを取り消し、フィールドの表示へ戻す
      console.warn('[field-menu] メニューを開けませんでした', e)
      if (entered) this.d.leaveView()
      // open の途中で隠した ≡ ボタンを、次の syncButton で描き直す（同じ位置でも再描画させる）
      this.lastButtonKey = ''
      return false
    } finally {
      this.opening = false
    }
  }

  /** メニュー画面が閉じた（最上位で戻った）とき */
  onScreenClosed(): void {
    this.settings = this.d.screen.settings
    this.d.leaveView()
  }

  /**
   * keydown。戻り値が true のとき呼び出し側は preventDefault（`stop` が true なら stopImmediatePropagation も）する。
   * `typing` = 文字入力にフォーカスがある。
   */
  onKeyDown(ev: KeyLike, typing: boolean): { handled: boolean; stop: boolean } {
    const none = { handled: false, stop: false }
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return none
    const s = this.d.screen
    if (s.isOpen) {
      // メニュー内のキーはメニューだけが受ける（歩き・会話へ渡さない）。長押しの繰り返しは移動だけ
      if (ev.repeat && !MOVE_CODES.includes(ev.code)) return { handled: true, stop: false }
      return s.handleKey(ev.code) ? { handled: true, stop: true } : none
    }
    // 開き始め・遷移中はフィールドへキーを渡さない
    if (this.busy) return { handled: false, stop: true }
    if (!isMenuOpenKey(ev.code) || ev.repeat || typing || !this.canOpenNow()) return none
    void this.open()
    return { handled: true, stop: false }
  }

  /**
   * pointerdown の始まり（window の capture で呼ぶ）。この時点でメニューが塞いでいたかを記録する。
   * Pixi が先に処理してメニューが閉じても、同じ操作はフィールドへ抜けない。
   */
  beginPointer(): void {
    this.pointerBlocked = this.busy
  }

  /** 直近の pointerdown が、始まった時点でメニューに塞がれていたか（canvas の bubble 側ハンドラが見る） */
  get isMenuBlocked(): boolean {
    return this.pointerBlocked || this.busy
  }

  /** ≡ ボタンのタップ判定。当たって開き始めたら true（呼び出し側は他の処理へ進まない） */
  tapButton(p: { x: number; y: number }): boolean {
    if (!this.canOpenNow()) return false
    const f = this.d.face()
    if (!pointInRect(computeMenuButtonRect(f.w, f.h, f.cssScale), p.x, p.y)) return false
    void this.open()
    return true
  }

  /** contextmenu。メニューが塞いでいる間・閉じた同じ操作では、ブラウザの右クリックメニューを出さない。true なら preventDefault */
  onContextMenu(): boolean {
    const blocked = this.isMenuBlocked
    // 閉じた同じ操作の分は使い切り。以降の（メニューと無関係な）右クリックのメニューは通常どおり出す
    this.pointerBlocked = false
    return blocked
  }

  /** ≡ ボタンの表示・位置の更新（毎フレーム）。表示と当たりは同じ `face()` を使う */
  syncButton(): void {
    if (!this.canOpenNow()) {
      this.lastButtonKey = ''
      this.d.drawButton(null)
      return
    }
    const f = this.d.face()
    const r = computeMenuButtonRect(f.w, f.h, f.cssScale)
    const key = `${r.x}|${r.y}|${r.w}|${r.h}`
    if (key === this.lastButtonKey) return
    this.lastButtonKey = key
    this.d.drawButton(r)
  }

  /**
   * 毎フレーム。メニューが塞いでいる間は画面を進め（遷移・情報帯の更新）、true を返す
   * （呼び出し側はフィールドの時間・入力を進めない）。プレイ時間は塞いでいても進む（情報帯に反映する）。
   */
  tick(dtMs: number): boolean {
    this.syncButton()
    if (!this.busy) return false
    if (this.d.screen.isOpen || this.d.screen.transitioning) {
      this.d.screen.tick(dtMs)
      const info = this.d.info()
      const key = JSON.stringify(info)
      if (key !== this.lastInfo) {
        this.lastInfo = key
        this.d.screen.setInfo(info)
      }
    }
    return true
  }
}
