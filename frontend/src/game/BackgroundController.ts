import { Assets, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { BackgroundFade, NovelGameState } from './GameState'
import { buildEdgeFadeMask, normalizeEdgeFade } from './edgeFadeMask'
import { computeCoverFit, parseColorToNumber, resolveAssetUrl } from './novelLayout'
import type { TimeController } from './TimeController'

/**
 * 各端の生 fade 値（parser / セーブデータ由来）を正規化して BackgroundFade | null を返す (#250)。
 *
 * 実体は #252 で `edgeFadeMask` の共通関数 `normalizeEdgeFade` に切り出した。
 * 既存の import 経路（`NovelRenderer` から）と既存テストを壊さないため、レンダラ側が再エクスポートする。
 */
export const normalizeBackgroundFade = normalizeEdgeFade

/**
 * 背景の明るさ（brightness）の生値（parser / セーブデータ由来）を 0.0〜1.0 に正規化する。
 *
 * 同一画像をシーン毎に減光する持続プロパティ（「暗いシーンは背景も暗くする」演出用）。
 * - 非数値 / null / undefined / 非有限（NaN/Infinity）→ null（＝原画のまま＝tint 無効）
 * - 1.0 以上（原画と同義）→ null（tint=白 と区別がないため持たない・round-trip 安定）
 * - それ以外は 0.0〜1.0 にクランプして返す（負値は 0.0）
 *
 * parser 側でも同等のクランプ・1.0→None 化を行うが、セーブデータ由来の生値（古い手書き
 * セーブ等）でも安全になるよう、ランタイム側でも防御的に正規化する。
 */
export function normalizeBackgroundBrightness(
  brightness: number | null | undefined
): number | null {
  if (brightness == null || !Number.isFinite(brightness)) return null
  const clamped = Math.min(1, Math.max(0, brightness))
  return clamped < 1 ? clamped : null
}

/**
 * 背景明るさ（brightness、0.0〜1.0）を PixiJS の tint 値（24bit RGB number）に変換する。
 *
 * PixiJS の tint は乗算なので、明るさ b に対し各チャンネルを `round(b*255)` にした
 * グレー値（`rgb(g, g, g)`）を返すと、スプライト全体が b 倍に減光される（b=0.6 で 60%）。
 * null/未指定は 0xffffff（白）＝tint 無効＝原画のまま（後方互換）。
 * 入力は normalizeBackgroundBrightness 済みを想定するが、防御的に再クランプする。
 */
export function brightnessToTint(brightness: number | null | undefined): number {
  if (brightness == null || !Number.isFinite(brightness)) return 0xffffff
  const clamped = Math.min(1, Math.max(0, brightness))
  const g = Math.round(clamped * 255)
  return (g << 16) | (g << 8) | g
}

interface BackgroundEntry {
  sprite: Sprite
  mask: Sprite | null
  fadeAnimation: BackgroundFadeAnimation | null
}

interface BackgroundFadeAnimation {
  startMs: number
  durationMs: number
  fromAlpha: number
  toAlpha: number
  /** true なら fade-out 完了時に sprite/mask を破棄して bgEntries から消す */
  destroyOnComplete: boolean
}

/**
 * `BackgroundController` がレンダラ（ファサード）へ頼む読み取り (#828 7a)。背景は状態と更新を自分で持ち、
 * 「レンダラだけが知っている値」を読むだけにする。`NovelRenderer` も他モジュールも import しない。
 * メソッド数は8以内に保つ（#735 設計 §6）。
 */
export interface BackgroundHost {
  /** アセットのベース URL（空なら背景画像は描かず entries を空にする）。 */
  getAssetBaseUrl(): string
  /** スキップ中か（スキップ中のクロスフェードは即時）。 */
  isSkipMode(): boolean
  /** レンダラが初期化済みで破棄されていないか（ロード完了時の遅延描画の判定）。 */
  isInitialized(): boolean
  /** 画面サイズ（construct 時に固定）。 */
  getScreenSize(): { width: number; height: number }
  /** 背景クロスフェードの長さ（ms）。per-game 設定で、終劇の消去フェードとも共有されるためレンダラが持つ。 */
  getCrossfadeMs(): number
}

/**
 * 背景（下地ベタ・背景画像のクロスフェード・端フェードマスク・明るさ・地色）の状態と更新 (#828 7a, #735 7/8 の第1段)。
 *
 * 次のフィールドの唯一の書き手: `bgEntries` / `bgMaskSprite` / `bgCrossfadeTimer` / `currentBackground*` /
 * `defaultBackgroundColor` / `textureCache` / `bgLoadToken` / `pendingBackgroundLoad*`。
 * `getSnapshot()` / `applyState` の背景フィールド（`backgroundPath` / `backgroundColor` / `backgroundFade` /
 * `backgroundBrightness`）だけを `capture()` / `restore()` で出し入れする。クロスフェードの中間状態
 * （`bgEntries` の alpha・`fadeAnimation`・タイマー）は GameState に持たない（ADR 0002）。
 *
 * 動画レイヤ（`VideoLayer`）や背景板（`BackgroundBoardLayer`）には触れない。それらを同時にクリアするかどうかは
 * 複数モジュールをまたぐ判断なので、`resetAndStartEvents` / `applyState` / `destroy` を持つレンダラが決める。
 * Pixi は演出側として使うが、`NovelRenderer` は import しない（Host 越しのみ）。
 */
export class BackgroundController {
  /** 下地ベタ（最背面の全面塗り）。既定は frontmatter `background_color:`、`[背景色:]` で上書き。 */
  readonly graphics: Graphics = new Graphics()
  /** 背景画像コンテナ（`graphics` の直後に積む）。 */
  readonly container: Container = new Container()

  /** 現在の背景パス。 */
  private currentBackgroundPath: string | null = null

  /** 現在の単色地色 (#273)。背景パスと同じ永続状態。なしなら null（既定色＝下地ベタ）。
   *  背景画像とは独立スロット: graphics を塗り直すだけで container の画像には触れない。 */
  private currentBackgroundColor: string | null = null

  /** 下地ベタ（graphics）の既定色 (#409)。frontmatter `background_color:` の値。
   *  `[背景色:]`（#273）のシーン上書きが無いとき（`currentBackgroundColor === null`）の実塗り色になり、
   *  最初の背景絵がこの色から `background_fade_ms` でフェードインする。null なら黒 0x000000（後方互換）。 */
  private defaultBackgroundColor: string | null = null

  /** 現在の背景端フェードマスク (#250)。なしなら null */
  private currentBackgroundFade: BackgroundFade | null = null

  /** 現在の背景明るさ（brightness、0.0〜1.0）。同一画像をシーン毎に減光する持続プロパティ。
   *  null/未指定は原画のまま（tint=白）。背景スプライト生成/復元時に tint として乗算適用する。 */
  private currentBackgroundBrightness: number | null = null

  /** 背景 sprite と対応 mask の所有リスト。クロスフェード中は旧 + 新の複数枚になる。 */
  private bgEntries: BackgroundEntry[] = []

  /** 現在の背景に適用中のマスク Sprite (#250)。解放時に破棄する。互換用に最前面 mask を指す */
  private bgMaskSprite: Sprite | null = null

  /** 背景クロスフェード用タイマー。GameState には持たない演出中間状態。 */
  private bgCrossfadeTimer: number | null = null

  /** 読み込み済みの背景テクスチャ（URL → Texture）。背景だけが使う（立ち絵・他レイヤーは各自で持つ）。 */
  private textureCache: Map<string, Texture> = new Map()

  /** setBackground の非同期ロード用トークン。destroy / 再入 の race 回避に使う */
  private bgLoadToken = 0
  /** 現在表示対象としてロード待ち中の背景 token。本文 reveal の背景待ち判定に使う。 */
  private pendingBackgroundLoadToken: number | null = null
  /** 進行中の背景ロード（成功・失敗・破棄のどれでも解決する）。`waitForLoad` が待つ (#734) */
  private pendingBackgroundLoad: Promise<void> | null = null

  constructor(
    private readonly host: BackgroundHost,
    private readonly time: TimeController
  ) {}

  // --- 組み立て・状態の出し入れ ---

  /**
   * 下地ベタ（既定色・#409）を塗り、ステージに積む（`NovelRenderer.init`）。最初の背景絵はこの地色の上に
   * alpha 0→1 で重なってフェードインする（コールドスタート）。
   */
  attachTo(stage: Container): void {
    const { width, height } = this.host.getScreenSize()
    this.graphics.rect(0, 0, width, height)
    this.graphics.fill(this.defaultBackgroundColorNum())
    stage.addChild(this.graphics)
    stage.addChild(this.container)
  }

  /** `getSnapshot()` の背景部分（宣言的に確定した値のみ。クロスフェードの中間状態は含まない）。 */
  capture(): Pick<
    NovelGameState,
    'backgroundPath' | 'backgroundColor' | 'backgroundFade' | 'backgroundBrightness'
  > {
    return {
      backgroundPath: this.currentBackgroundPath,
      backgroundColor: this.currentBackgroundColor,
      backgroundFade: this.currentBackgroundFade,
      backgroundBrightness: this.currentBackgroundBrightness,
    }
  }

  /**
   * `applyState` の背景部分（背景画像 → 単色地色の順）。復元は即時反映でフェードしない。
   * 動画レイヤには触れない（背景なしの復元で動画も消す扱いはレンダラが行う）。
   */
  restore(
    state: Pick<
      NovelGameState,
      'backgroundPath' | 'backgroundColor' | 'backgroundFade' | 'backgroundBrightness'
    >
  ): void {
    // 背景復元
    if (state.backgroundPath) {
      this.setBackground(state.backgroundPath, state.backgroundFade, state.backgroundBrightness, {
        instant: true,
      })
    } else {
      this.clearBackground()
    }

    // 単色地色の復元 (#273)。背景画像とは独立スロット（graphics）なので別分岐で復元する。
    // 古いセーブ・スナップショットには backgroundColor が無い → ?? null で「色なし」に倒す。
    if (state.backgroundColor) {
      this.setBackgroundColor(state.backgroundColor)
    } else {
      this.clearBackgroundColor()
    }
  }

  /** イベント絵の `back=Hide` で背面スタックごと隠す／戻すトグル（下地ベタと画像コンテナ）。 */
  setVisible(visible: boolean): void {
    this.graphics.visible = visible
    this.container.visible = visible
  }

  // --- 背景画像 ---

  /**
   * 背景画像を設定する（アスペクト比維持でカバー）。
   * fade を渡すと端フェードマスク (#250) を適用する。
   */
  setBackground(
    path: string,
    fade?: BackgroundFade | null,
    brightness?: number | null,
    opts?: { instant?: boolean }
  ): void {
    const previousPath = this.currentBackgroundPath
    this.currentBackgroundPath = path
    const normalizedFade = normalizeBackgroundFade(fade)
    const normalizedBrightness = normalizeBackgroundBrightness(brightness)
    this.currentBackgroundFade = normalizedFade
    this.currentBackgroundBrightness = normalizedBrightness

    const assetBaseUrl = this.host.getAssetBaseUrl()
    if (!assetBaseUrl) {
      this.clearBackgroundEntries()
      return
    }

    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    // #409: コールドスタート（直前に背景画像が無い＝物語/シーンの最初の背景）も
    // crossfade 経路（alpha 0→1）で `background_fade_ms` フェードインさせる。ステージ最背面の
    // graphics は下地ベタの既定色（frontmatter `background_color:`・未指定なら黒 0x000000）なので、
    // これは「下地ベタ（既定は黒）から浮かび上がる」フェードインになる（黒フラッシュにはならない）。
    // 復元（applyState が opts.instant:true を明示＝goBack/seekTo/セーブ復元/任意局面起動）と
    // skipMode・同一 path だけを即時に残す。以前あった `!previousPath` /
    // `this.bgEntries.length === 0`（＝コールドスタート指標）は #409 で削除した。
    const instant = opts?.instant === true || this.host.isSkipMode() || previousPath === path

    // ロード要求ごとにトークンを更新し、古い非同期完了による UAF / race を防ぐ。
    // キャッシュヒットで同期描画する場合も必ず進めること。さもないと直前に
    // 走っていた別背景の Assets.load().then が後から解決し、即描画した背景の上に
    // 古い sprite+fade を addChild してしまう。
    const token = ++this.bgLoadToken
    this.pendingBackgroundLoadToken = null
    this.pendingBackgroundLoad = null

    // キャッシュ済みの Texture があれば再利用（戻る操作時のフリッカー防止）
    const cached = this.textureCache.get(url)
    if (cached) {
      this.showLoadedBackground(cached, {
        fade: normalizedFade,
        brightness: normalizedBrightness,
        instant,
      })
      return
    }

    this.pendingBackgroundLoadToken = token
    const loading = Assets.load(url)
      .then((texture) => {
        if (token !== this.bgLoadToken) return
        if (this.pendingBackgroundLoadToken === token) this.pendingBackgroundLoadToken = null
        if (!this.host.isInitialized()) return
        this.textureCache.set(url, texture)
        this.showLoadedBackground(texture, {
          fade: normalizedFade,
          brightness: normalizedBrightness,
          instant: instant || this.host.isSkipMode(),
        })
      })
      .catch((err) => {
        if (this.pendingBackgroundLoadToken === token) this.pendingBackgroundLoadToken = null
        console.warn('[name-name] 背景画像の読み込みに失敗: ' + url, err)
      })
      .finally(() => {
        if (this.pendingBackgroundLoad === loading) this.pendingBackgroundLoad = null
      })
    this.pendingBackgroundLoad = loading
  }

  private showLoadedBackground(
    texture: Texture,
    opts: {
      fade: BackgroundFade | null
      brightness: number | null
      instant: boolean
    }
  ): void {
    const sprite = new Sprite(texture)
    this.applyCoverFit(sprite)
    this.applyBrightnessTint(sprite, opts.brightness)
    const mask = this.applyEdgeFadeMask(sprite, opts.fade)
    const entry: BackgroundEntry = { sprite, mask, fadeAnimation: null }
    this.bgMaskSprite = mask

    if (opts.instant) {
      this.replaceBackgroundEntries(entry)
      return
    }

    this.crossfadeToBackgroundEntry(entry)
  }

  private replaceBackgroundEntries(entry: BackgroundEntry): void {
    this.stopBackgroundCrossfade()
    this.clearBackgroundEntries()
    entry.sprite.alpha = 1
    entry.fadeAnimation = null
    this.addBackgroundEntryToContainer(entry)
    this.bgEntries = [entry]
    this.bgMaskSprite = entry.mask
  }

  private crossfadeToBackgroundEntry(next: BackgroundEntry): void {
    this.stopBackgroundCrossfade()
    const startMs = this.time.now()
    const durationMs = this.host.getCrossfadeMs()
    const previous = [...this.bgEntries]
    this.beginFadeOutEntries(previous, startMs, durationMs)
    next.sprite.alpha = 0
    next.fadeAnimation = {
      startMs,
      durationMs,
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    }
    this.addBackgroundEntryToContainer(next)
    this.bgEntries = [...previous, next]
    this.updateBackgroundFadeFrame()
    this.ensureBackgroundCrossfadeTicker()
  }

  /**
   * 複数の背景 entry に「alpha 0 へフェードアウト → 完了後に破棄」の fadeAnimation を
   * 一括で仕込む (#386 セルフレビュー nit)。`crossfadeToBackgroundEntry`（次背景を追加する
   * クロスフェード）と `fadeOutBackgroundEntries`（次背景を追加しない終劇演出）の両方が
   * 「旧背景を消す」部分としてこの手続きを共有する（重複実装の解消）。
   */
  private beginFadeOutEntries(
    entries: BackgroundEntry[],
    startMs: number,
    durationMs: number
  ): void {
    for (const entry of entries) {
      entry.fadeAnimation = {
        startMs,
        durationMs,
        fromAlpha: entry.sprite.alpha,
        toAlpha: 0,
        destroyOnComplete: true,
      }
    }
  }

  /**
   * 現在の背景画像 entry 群をフェードアウトさせる (#386 終劇演出)。
   * `crossfadeToBackgroundEntry` の「旧背景を消す」半分だけを取り出した形（次背景を
   * 追加しない）。完了後は `updateBackgroundFadeFrame` の `destroyOnComplete` で自動的に
   * 破棄される。ステージ最背面の `graphics` は endStory 側の `clearBackgroundColor()` で
   * 先に下地ベタの既定色（`background_color:` #409。未指定なら黒）へリセット済みのため、
   * フェード完了後は自然にその地色が残る。
   */
  fadeOutBackgroundEntries(durationMs: number): void {
    if (this.bgEntries.length === 0) return
    this.stopBackgroundCrossfade()
    const startMs = this.time.now()
    this.beginFadeOutEntries(this.bgEntries, startMs, durationMs)
    this.updateBackgroundFadeFrame()
    this.ensureBackgroundCrossfadeTicker()
  }

  private stopBackgroundCrossfade(): void {
    if (this.bgCrossfadeTimer == null) return
    this.time.clearInterval(this.bgCrossfadeTimer)
    this.bgCrossfadeTimer = null
  }

  /** 進行中のクロスフェードを畳み、最新の背景だけを不透明で残す（スキップ・持ち越し遷移）。 */
  finishBackgroundCrossfadeInstant(): void {
    if (!this.hasActiveBackgroundFade()) return
    this.stopBackgroundCrossfade()
    const latest = this.bgEntries[this.bgEntries.length - 1]
    for (const entry of this.bgEntries) {
      if (entry !== latest) this.destroyBackgroundEntry(entry)
    }
    if (!latest) {
      this.bgEntries = []
      this.bgMaskSprite = null
      return
    }
    latest.sprite.alpha = 1
    latest.fadeAnimation = null
    this.bgEntries = [latest]
    this.bgMaskSprite = latest.mask
  }

  private ensureBackgroundCrossfadeTicker(): void {
    if (this.bgCrossfadeTimer != null) return
    if (!this.hasActiveBackgroundFade()) return
    this.bgCrossfadeTimer = this.time.setInterval(() => {
      this.updateBackgroundFadeFrame()
    }, 16)
  }

  hasActiveBackgroundFade(): boolean {
    return this.bgEntries.some((entry) => entry.fadeAnimation !== null)
  }

  hasPendingBackgroundLoad(): boolean {
    return this.pendingBackgroundLoadToken === this.bgLoadToken
  }

  /**
   * 進行中の背景画像ロードの完了を待つ (#734)。ロードが無ければ即解決。
   * 失敗・破棄（より新しい背景要求）でも reject せず解決する。
   */
  async waitForLoad(): Promise<void> {
    await this.pendingBackgroundLoad
  }

  updateBackgroundFadeFrame(): void {
    let anyActive = false
    for (const entry of [...this.bgEntries]) {
      const f = entry.fadeAnimation
      if (!f) continue
      const t =
        f.durationMs <= 0
          ? 1
          : Math.min(1, Math.max(0, (this.time.now() - f.startMs) / f.durationMs))
      if (t >= 1) {
        entry.sprite.alpha = f.toAlpha
        entry.fadeAnimation = null
        if (f.destroyOnComplete) {
          this.destroyBackgroundEntry(entry)
          this.bgEntries = this.bgEntries.filter((candidate) => candidate !== entry)
        }
      } else {
        anyActive = true
        entry.sprite.alpha = f.fromAlpha + (f.toAlpha - f.fromAlpha) * t
      }
    }
    const top = this.bgEntries[this.bgEntries.length - 1] ?? null
    this.bgMaskSprite = top?.mask ?? null
    if (!anyActive) this.stopBackgroundCrossfade()
  }

  private addBackgroundEntryToContainer(entry: BackgroundEntry): void {
    this.container.addChild(entry.sprite)
    if (entry.mask) this.container.addChild(entry.mask)
  }

  /**
   * 現在の currentBackgroundBrightness に基づいて背景スプライトの tint（減光）を適用する。
   * PixiJS の tint は乗算なので、明るさ b（0.0〜1.0）に対し
   * `tint = rgb(round(b*255), round(b*255), round(b*255))` で全体を b 倍に減光する。
   * null/未指定（＝原画のまま）は 0xffffff（白＝tint 無効）で従来動作。
   */
  private applyBrightnessTint(
    sprite: { tint: number },
    brightness: number | null = this.currentBackgroundBrightness
  ): void {
    sprite.tint = brightnessToTint(brightness)
  }

  private applyCoverFit(sprite: Sprite): void {
    // カバーフィット幾何は novelLayout.computeCoverFit に集約 (#260)。
    // 戻り値の {width,height,x,y} を Object.assign で sprite の各 setter に流し込む。
    const { width, height } = sprite.texture
    const screen = this.host.getScreenSize()
    Object.assign(sprite, computeCoverFit(width, height, screen.width, screen.height))
  }

  /**
   * 現在の currentBackgroundFade に基づいて端フェードマスク (#250) を sprite に適用する。
   * フェード指定がなければ何もしない（従来動作）。
   */
  private applyEdgeFadeMask(
    sprite: Sprite,
    fade: BackgroundFade | null = this.currentBackgroundFade
  ): Sprite | null {
    // #252 で共通ユーティリティ buildEdgeFadeMask に切り出した（VideoLayer と共有）。
    const screen = this.host.getScreenSize()
    const maskSprite = buildEdgeFadeMask(fade, screen.width, screen.height)
    if (!maskSprite) return null
    sprite.mask = maskSprite
    return maskSprite
  }

  /** 背景 entry が所有する mask Sprite とそのテクスチャを破棄する (#250)。メモリリーク防止 */
  private disposeBgMask(maskSprite: Sprite | null = this.bgMaskSprite): void {
    if (maskSprite) {
      maskSprite.removeFromParent()
      // canvas 由来のテクスチャは textureCache に乗らないので確実に破棄する
      maskSprite.destroy({ texture: true, textureSource: true })
      if (this.bgMaskSprite === maskSprite) this.bgMaskSprite = null
    }
  }

  private destroyBackgroundEntry(entry: BackgroundEntry): void {
    entry.sprite.removeFromParent()
    entry.sprite.destroy()
    this.disposeBgMask(entry.mask)
  }

  /** 背景 entry を全て破棄する（canvas 由来マスクテクスチャを含む #250/#319）。`destroy` からも呼ぶ。 */
  clearBackgroundEntries(): void {
    this.stopBackgroundCrossfade()
    for (const entry of this.bgEntries) this.destroyBackgroundEntry(entry)
    this.bgEntries = []
    this.bgMaskSprite = null
    this.container.removeChildren()
  }

  /**
   * 進行中の背景ロードを無効化する（トークンを進め、待ちを下ろす）。持ち越し遷移（preserve）でも、
   * 古い非同期完了が新しい背景の上に描かれないようにするために単独で呼ぶ。
   */
  cancelPendingLoad(): void {
    this.bgLoadToken++
    this.pendingBackgroundLoadToken = null
    this.pendingBackgroundLoad = null
  }

  /**
   * 背景画像の宣言状態（パス・端フェード・明るさ）を捨て、進行中のロードを無効化する。見た目の entries は
   * 触らない（終劇は entries を別途フェードアウトさせる）。単色地色は別スロットなので触らない。
   */
  forgetBackground(): void {
    this.currentBackgroundPath = null
    this.currentBackgroundFade = null
    this.currentBackgroundBrightness = null
    this.cancelPendingLoad()
  }

  /**
   * 背景画像をクリアする。動画レイヤは触らない（背景と同じ扱いで消すのはレンダラ側 #252）。
   */
  clearBackground(): void {
    this.forgetBackground()
    this.clearBackgroundEntries()
  }

  // --- 単色地色（下地ベタ） ---

  /**
   * 単色の地色を設定する (#273)。`graphics`（全面を覆う最背面の塗り）を塗り直す。
   *
   * 背景画像とは独立スロット: container の画像には触れない（画像が上に乗る）。
   * 色解決は novelLayout.parseColorToNumber に委譲（不正値は黒 0x000000 にフォールバック）。
   * init 時に一度 rect+fill 済みなので、重ね塗りで透けないよう必ず clear() してから塗り直す。
   */
  setBackgroundColor(color: string): void {
    this.currentBackgroundColor = color
    this.paintBase(parseColorToNumber(color, 0x000000))
  }

  /**
   * 単色の地色をリセットする (#273)。地色を下地ベタの既定色（`background_color:` #409。未指定なら黒）に戻す。
   * 背景画像の clearBackground と対をなす（背景色スロットだけを初期化する）。`[背景色:]` の解除・終劇で呼ぶ。
   */
  clearBackgroundColor(): void {
    this.currentBackgroundColor = null
    this.paintBase(this.defaultBackgroundColorNum())
  }

  /**
   * 下地ベタ（graphics）の既定色を数値で解決する (#409)。`defaultBackgroundColor`（frontmatter
   * `background_color:`）が設定されていれば parseColorToNumber で解決、未指定なら黒 0x000000（後方互換）。
   */
  private defaultBackgroundColorNum(): number {
    return this.defaultBackgroundColor
      ? parseColorToNumber(this.defaultBackgroundColor, 0x000000)
      : 0x000000
  }

  /**
   * 下地ベタ（graphics）の既定色を設定する (#409)。frontmatter `background_color:` の値（`#rrggbb`）を
   * 渡す。null/空文字は既定の黒に倒す。
   *
   * `[背景色:]`（#273）のシーン上書きが**無い**とき（`currentBackgroundColor === null`）だけ graphics を
   * 即座に塗り直す。上書きが有効な間は `currentBackgroundColor` が勝つ（上書きを踏み潰さない）。
   */
  setDefaultBackgroundColor(color: string | null | undefined): void {
    this.defaultBackgroundColor = color && color.length > 0 ? color : null
    // シーン上書きが無いときだけ地色を新しい既定色へ即反映する。上書き中は触らない。
    if (this.currentBackgroundColor === null) {
      this.paintBase(this.defaultBackgroundColorNum())
    }
  }

  private paintBase(colorNum: number): void {
    const { width, height } = this.host.getScreenSize()
    this.graphics.clear()
    this.graphics.rect(0, 0, width, height)
    this.graphics.fill(colorNum)
  }

  // --- 解放 ---

  /**
   * 読み込み済みテクスチャを解放する（`setEvents` / `loadEvents` が文書を入れ替えるとき、`destroy`）。
   * PixiJS v8 の Assets.load で取得した Texture は Assets の内部キャッシュに残り続けるため、
   * キャッシュ済みURLを Assets.unload で解放してからキャッシュをクリアする（GPU テクスチャのリーク防止）。
   */
  releaseTextures(): void {
    const urls = Array.from(this.textureCache.keys())
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err) => {
      console.warn('[name-name] テクスチャの解放に失敗', err)
    })
    this.textureCache.clear()
  }
}
