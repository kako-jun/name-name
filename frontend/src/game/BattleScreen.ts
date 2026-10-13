/**
 * RPG 戦闘画面 (#173)。
 *
 * Undertale 風レイアウト + DQ1/DQ5 風の「フィールド背景を残す」方針:
 *
 *   +-----------------------+
 *   |                       |  ← フィールドのフレーム（暗くする）
 *   |    [敵スプライト]       |
 *   |                       |
 *   +---+-------+-----------+
 *   |HP/MP|たたかう|じゅもん|どうぐ|にげる|
 *   +-----+-------+----------------------+
 *   |  > スライムがあらわれた！          |  ← 戦闘ログ（最新数行）
 *   |  > ゆうしゃのこうげき！...          |
 *   +-----+-------+----------------------+
 *
 * `layout: 'side'`（#736・FF 系サイドビュー）では配置が変わる。座標は battleLayout.ts が正本:
 *
 *   +-----------------------------------+
 *   | ログ帯（敵の数で 2〜4 行）          |
 *   |  [敵群 + 名前/HP ラベル]  [味方全員] |  ← 敵が左・味方が右。背景画像があれば cover で敷く
 *   +----------+------------------------+
 *   |たたかう … | ゆうしゃ HP 20/20 MP …  |  ← コマンド 2x2 / 味方全員分の HP パネル
 *   +----------+------------------------+
 *
 * BattleEngine（状態機械）を観測して描画する責務だけ持つ。コマンド入力は
 * 4 つのボタン (たたかう/じゅもん/どうぐ/にげる) を直接タップで決定。
 *
 * Phase 1 では呪文 / アイテムは「準備中」のログを出すだけ（パーティ #175 と
 * セットで Phase 2）。たたかう / にげる だけ動作する。
 */

import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text as PixiText,
  TextStyle,
  type Texture,
} from 'pixi.js'
import type { OutlineFilter } from 'pixi-filters'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  SIDE_LABEL_LINE_HEIGHT,
  SIDE_LOG_LINE_HEIGHT,
  computeContainFit,
  computeFallbackRect,
  computeSideBattleLayout,
  SIDE_COMMAND_TEXT_PADDING,
  fitCommandFontSize,
  SIDE_LABEL_FONT_SIZE,
  SIDE_LABEL_STROKE_WIDTH,
  fitHpLabel,
  fitLabel,
  fitNameWithSuffix,
  type BattleLayoutMode,
  type SpriteSlot,
} from './battleLayout'
import {
  DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
  createAcrylicRimFilter,
  createPaperDollOutlineFilter,
} from './outlineFilter'
import {
  computeAcrylicGeometry,
  resolveAcrylicParams,
  type AcrylicParams,
  type SpriteStyle,
} from './spriteStyle'
import { computeCoverFit } from './novelLayout'

const BG_DIM_ALPHA = 0.55
const PANEL_BG = 0x000000
const PANEL_BG_ALPHA = 0.85
const PANEL_STROKE = 0xffffff
const TEXT_COLOR = 0xffffff
const HP_COLOR = 0x88ee88
// MP_COLOR は HP/MP バー UI 実装時（戦闘 Phase 2、#175 と同時想定）に追加する

const STAGE_PADDING = 16
const STATS_HEIGHT = 32
const COMMAND_HEIGHT = 56
const LOG_HEIGHT = 96
const LOG_VISIBLE_LINES = 4
const PANEL_GAP = 6

/** 画像が無い（未指定・読み込み失敗）ときの色四角 (#736)。敵=赤系 / 味方=青系 */
/** acrylic の台座の色 (#737)。黒に近い円形台座 */
const ACRYLIC_BASE_COLOR = 0x111111
const FALLBACK_ENEMY_COLOR = 0xcc5555
const FALLBACK_PARTY_COLOR = 0x5588cc
const DEAD_ALPHA = 0.3
const SIDE_STATUS_FONT_SIZE = 14
/** status 行の左右余白（テキスト開始位置と、右端に残す余白） */
const SIDE_STATUS_TEXT_PADDING = 12
/** 敵ラベルの縁取り。写真背景（dim なし）でも読めるよう、背景指定の有無にかかわらず付ける (#736) */
export const SIDE_LABEL_STROKE_COLOR = 0x000000

const NAME_FONT_SIZE = 18
const COMMAND_FONT_SIZE = 18
const LOG_FONT_SIZE = 16
const HP_FONT_SIZE = 16

const TEXT_STYLE_NAME = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: NAME_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_COMMAND = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: COMMAND_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_LOG = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: LOG_FONT_SIZE,
  fill: TEXT_COLOR,
})
const TEXT_STYLE_HP = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: HP_FONT_SIZE,
  fill: TEXT_COLOR,
})

type CommandId = 'attack' | 'spell' | 'item' | 'escape'

interface CommandButton {
  id: CommandId
  hit: Container
  text: PixiText
}

export interface BattleScreenOptions {
  /** バトル終了（victory / defeat / escaped）時に呼ばれる */
  onClose?: (outcome: 'victory' | 'defeat' | 'escaped') => void
  /**
   * 戦闘レイアウト (#736)。`front`（既定）= 従来の Undertale 風正面配置（先頭 1 人のみ表示）、
   * `side` = FF 系サイドビュー（敵群が左・味方全員が右・下にコマンドと HP パネル）。
   */
  layout?: BattleLayoutMode
  /**
   * 背景画像パス (#736)。指定して読み込みに成功したら、フィールドを暗くする半透明黒の代わりに
   * 画像を cover で敷く。未指定・読み込み失敗時は従来どおり半透明黒。
   */
  background?: string
  /**
   * スプライト表示スタイル (#737)。`none`（既定）= 素材そのまま、`acrylic` = アクリルスタンド風
   * （白フチ・透明アクリル縁・黒い円形台座・接地影）。画像のある枠（`side` のスプライト）にだけかけ、
   * 色四角のフォールバックにはかけない。`front` は敵・味方の画像を描かないので影響しない。
   */
  spriteStyle?: SpriteStyle
  /** `acrylic` のパラメータ上書き (#737)。省略した項目は既定値。値はスプライト枠一辺に対する比率 */
  spriteStyleParams?: Partial<AcrylicParams>
}

/** サイドビューの 1 体ぶんの表示物 */
interface EntityView {
  container: Container
  fallback: Graphics
  color: number
  sprite: Sprite | null
  /** acrylic のとき: 台座・影を描く Graphics（fallback の直上・sprite の直下）と、sprite にかけるフィルタ。画像読み込み成功まで null/非表示 */
  acrylicBack: Graphics | null
  acrylicFilters: { edge: OutlineFilter; rim: OutlineFilter } | null
  /** 敵のみ: 名前 + HP ラベル */
  label: PixiText | null
}

export class BattleScreen extends Container {
  private engine: BattleEngine
  private screenWidth: number
  private screenHeight: number
  private opts: BattleScreenOptions

  private layoutMode: BattleLayoutMode
  /** 表示スタイル (#737)。`acrylic` のときだけ params が入る */
  private spriteStyle: SpriteStyle
  private acrylicParams: AcrylicParams | null
  private destroyedFlag = false
  private backgroundSprite: Sprite | null = null
  private enemyViews: EntityView[] = []
  private partyViews: EntityView[] = []
  private statusTexts: PixiText[] = []
  private visibleLogLines = LOG_VISIBLE_LINES
  /** side: status が狭く MP 表記を省いているか（layoutSide が更新） */
  private sideCompact = false
  /** side: status テキストに使える幅(px)（layoutSide が更新） */
  private sideStatusTextWidth = Infinity
  /** side: 敵ラベルに使える幅(px)（layoutSide が更新。enemyViews と同じ index） */
  private sideLabelWidths: number[] = []

  private dim: Graphics // フィールドを暗くする半透明黒
  private enemyNameText: PixiText
  private enemyHpText: PixiText
  private heroStatsText: PixiText
  private statsPanel: Graphics
  private commandPanel: Graphics
  private logPanel: Graphics
  private logLines: PixiText[] = []
  private commands: CommandButton[] = []

  constructor(
    engine: BattleEngine,
    screenWidth: number,
    screenHeight: number,
    opts: BattleScreenOptions = {}
  ) {
    super()
    this.engine = engine
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.opts = opts
    this.layoutMode = opts.layout === 'side' ? 'side' : 'front'
    this.spriteStyle = opts.spriteStyle === 'acrylic' ? 'acrylic' : 'none'
    this.acrylicParams =
      this.spriteStyle === 'acrylic' ? resolveAcrylicParams(opts.spriteStyleParams) : null

    this.dim = new Graphics()
    this.statsPanel = new Graphics()
    this.commandPanel = new Graphics()
    this.logPanel = new Graphics()
    this.enemyNameText = new PixiText({ text: '', style: TEXT_STYLE_NAME })
    this.enemyHpText = new PixiText({ text: '', style: TEXT_STYLE_HP })
    this.heroStatsText = new PixiText({ text: '', style: TEXT_STYLE_HP })

    this.addChild(this.dim)
    this.addChild(this.enemyNameText)
    this.addChild(this.enemyHpText)
    this.addChild(this.statsPanel)
    this.addChild(this.heroStatsText)
    this.addChild(this.commandPanel)
    this.addChild(this.logPanel)
    this.buildCommandButtons()
    // front のログは固定 4 行。side は layoutSide が必要な行数だけ作る
    if (this.layoutMode === 'front') this.buildLogLines()
    else this.buildSideViews()
    if (opts.background) void this.loadBackground(opts.background)
    this.layout()
    this.refresh()
  }

  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    this.destroyedFlag = true
    // フィルタは Container.destroy の対象外なので自分で破棄する (#737)
    for (const v of [...this.enemyViews, ...this.partyViews]) {
      v.acrylicFilters?.edge.destroy()
      v.acrylicFilters?.rim.destroy()
      v.acrylicFilters = null
    }
    super.destroy(options)
  }

  /** 背景画像を読み込んで cover で敷く (#736)。失敗時は半透明黒のまま */
  private async loadBackground(path: string): Promise<void> {
    try {
      const tex = (await Assets.load(path)) as Texture
      if (this.destroyedFlag) return
      const sprite = new Sprite(tex)
      this.backgroundSprite = sprite
      this.addChildAt(sprite, 0)
      this.layout()
    } catch (e) {
      console.warn(`[BattleScreen] failed to load background "${path}":`, e)
    }
  }

  /** サイドビュー用の敵・味方スプライトとステータス行を作る (#736) */
  private buildSideViews(): void {
    const s = this.engine.getState()
    // 前面用（正面配置）の表示物は使わない
    this.enemyNameText.visible = false
    this.enemyHpText.visible = false
    this.heroStatsText.visible = false
    const stage = new Container()
    // dim の直後（パネル・テキストより下）に差し込む
    this.addChildAt(stage, this.getChildIndex(this.dim) + 1)
    for (const e of s.enemies) {
      const view = this.createEntityView(e, FALLBACK_ENEMY_COLOR, true)
      stage.addChild(view.container)
      this.enemyViews.push(view)
    }
    for (const p of s.party) {
      const view = this.createEntityView(p, FALLBACK_PARTY_COLOR, false)
      stage.addChild(view.container)
      this.partyViews.push(view)
    }
    for (let i = 0; i < s.party.length; i++) {
      const t = new PixiText({
        text: '',
        style: new TextStyle({
          fontFamily: "'Noto Sans JP', sans-serif",
          fontSize: SIDE_STATUS_FONT_SIZE,
          fill: TEXT_COLOR,
        }),
      })
      this.statusTexts.push(t)
      this.addChild(t)
    }
  }

  private createEntityView(entity: BattleEntity, color: number, withLabel: boolean): EntityView {
    const container = new Container()
    const fallback = new Graphics()
    container.addChild(fallback)
    // acrylic: 台座・影は画像が読み込めるまで出さない（色四角にはかけない）
    let acrylicBack: Graphics | null = null
    if (this.acrylicParams && entity.sprite) {
      acrylicBack = new Graphics()
      acrylicBack.visible = false
      container.addChild(acrylicBack)
    }
    const label = withLabel
      ? new PixiText({
          text: '',
          style: new TextStyle({
            fontFamily: "'Noto Sans JP', sans-serif",
            fontSize: SIDE_LABEL_FONT_SIZE,
            fill: TEXT_COLOR,
            align: 'center',
            lineHeight: SIDE_LABEL_LINE_HEIGHT,
            stroke: { color: SIDE_LABEL_STROKE_COLOR, width: SIDE_LABEL_STROKE_WIDTH },
          }),
        })
      : null
    if (label) {
      label.anchor.set(0.5, 0)
      container.addChild(label)
    }
    const view: EntityView = {
      container,
      fallback,
      color,
      sprite: null,
      acrylicBack,
      acrylicFilters: null,
      label,
    }
    if (entity.sprite) void this.loadEntitySprite(view, entity.sprite)
    return view
  }

  private async loadEntitySprite(view: EntityView, path: string): Promise<void> {
    try {
      const tex = (await Assets.load(path)) as Texture
      if (this.destroyedFlag || view.container.destroyed) return
      const sprite = new Sprite(tex)
      view.sprite = sprite
      view.container.addChildAt(sprite, view.acrylicBack ? 2 : 1)
      if (view.acrylicBack) {
        // フィルタは texture ごとに 1 回だけ作る。太さは placeEntityView が枠の大きさに合わせて更新する
        view.acrylicFilters = {
          edge: createPaperDollOutlineFilter({
            color: DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
            thickness: 1,
          }),
          rim: createAcrylicRimFilter(1, this.acrylicParams?.rimAlpha ?? 0),
        }
        view.acrylicBack.visible = true
      }
      this.layout()
      this.refresh()
    } catch (e) {
      // 失敗時は色四角のまま
      console.warn(`[BattleScreen] failed to load sprite "${path}":`, e)
    }
  }

  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.layout()
    this.refresh()
  }

  /** UI からコマンドが選ばれたとき呼ばれる。エンジン側を進めて refresh */
  private handleCommand(id: CommandId): void {
    if (this.engine.isOver()) return
    switch (id) {
      case 'attack':
        this.engine.selectAttack()
        break
      case 'escape':
        this.engine.selectEscape()
        break
      case 'spell':
      case 'item':
        // Phase 1: パーティ / マスターアクセスが #175 で揃ってから実装
        // 現状は識別ログのみ（戦闘エンジン側の log には積まない）
        console.info(`[BattleScreen] command '${id}' は #175 で実装`)
        break
    }
    this.refresh()
    if (this.engine.isOver()) {
      const outcome = this.engine.getState().phase
      // outcome は victory / defeat / escaped のいずれか（isOver がガード）
      this.opts.onClose?.(outcome as 'victory' | 'defeat' | 'escaped')
    }
  }

  private buildCommandButtons(): void {
    const labels: Array<{ id: CommandId; label: string }> = [
      { id: 'attack', label: 'たたかう' },
      { id: 'spell', label: 'じゅもん' },
      { id: 'item', label: 'どうぐ' },
      { id: 'escape', label: 'にげる' },
    ]
    for (const item of labels) {
      const text = new PixiText({ text: item.label, style: TEXT_STYLE_COMMAND.clone() })
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointertap', () => this.handleCommand(item.id))
      this.addChild(hit)
      this.addChild(text)
      this.commands.push({ id: item.id, hit, text })
    }
  }

  private buildLogLines(): void {
    this.setLogLineCount(LOG_VISIBLE_LINES)
  }

  /** ログ行テキストの数を n に揃える（足りなければ作り、余れば破棄する） */
  private setLogLineCount(n: number): void {
    while (this.logLines.length < n) {
      const text = new PixiText({ text: '', style: TEXT_STYLE_LOG })
      this.logLines.push(text)
      this.addChild(text)
    }
    while (this.logLines.length > n) {
      this.logLines.pop()?.destroy()
    }
    this.visibleLogLines = n
  }

  private layout(): void {
    const W = this.screenWidth
    const H = this.screenHeight
    const panelW = W - STAGE_PADDING * 2

    // 背景画像が読み込めていれば cover で敷き、暗くする半透明黒は使わない (#736)
    if (this.backgroundSprite) {
      const tex = this.backgroundSprite.texture
      const fit = computeCoverFit(tex.width, tex.height, W, H)
      this.backgroundSprite.position.set(fit.x, fit.y)
      this.backgroundSprite.width = fit.width
      this.backgroundSprite.height = fit.height
      this.dim.clear()
    } else {
      // フィールド全体を暗くする半透明黒
      this.dim.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: BG_DIM_ALPHA })
    }

    if (this.layoutMode === 'side') {
      this.layoutSide()
      return
    }

    // 敵スプライト領域: 上半分の中央。スプライトは未実装、名前と HP テキストだけ
    this.enemyNameText.anchor.set(0.5, 0)
    this.enemyNameText.x = W / 2
    this.enemyNameText.y = H * 0.15
    this.enemyHpText.anchor.set(0.5, 0)
    this.enemyHpText.x = W / 2
    this.enemyHpText.y = H * 0.15 + NAME_FONT_SIZE + 8

    // 縦積み構成: 下から ログ → コマンド → HP/MP の 3 段。
    // 9:16 縦長スマホ (W=360 程度) でもコマンドが画面幅をはみ出さない構造。
    const logY = H - LOG_HEIGHT - STAGE_PADDING
    const commandY = logY - PANEL_GAP - COMMAND_HEIGHT
    const statsY = commandY - PANEL_GAP - STATS_HEIGHT

    // HP/MP パネル
    this.statsPanel
      .clear()
      .roundRect(STAGE_PADDING, statsY, panelW, STATS_HEIGHT, 6)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ color: PANEL_STROKE, width: 2 })
    this.heroStatsText.x = STAGE_PADDING + 12
    this.heroStatsText.y = statsY + (STATS_HEIGHT - HP_FONT_SIZE) / 2

    // コマンドパネル（4 コマンドを画面幅で均等割）
    this.commandPanel
      .clear()
      .roundRect(STAGE_PADDING, commandY, panelW, COMMAND_HEIGHT, 6)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ color: PANEL_STROKE, width: 2 })
    // commands.length は固定 4。万一 0 になっても div by zero しないよう max(1) でガード
    const cmdW = panelW / Math.max(1, this.commands.length)
    for (let i = 0; i < this.commands.length; i++) {
      const node = this.commands[i]
      const cellX = STAGE_PADDING + i * cmdW
      node.hit.hitArea = new Rectangle(cellX, commandY, cmdW, COMMAND_HEIGHT)
      node.text.anchor.set(0.5, 0.5)
      node.text.x = cellX + cmdW / 2
      node.text.y = commandY + COMMAND_HEIGHT / 2
    }

    // ログパネル（画面最下部）
    this.logPanel
      .clear()
      .roundRect(STAGE_PADDING, logY, panelW, LOG_HEIGHT, 6)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ color: PANEL_STROKE, width: 2 })
    for (let i = 0; i < this.logLines.length; i++) {
      const text = this.logLines[i]
      text.x = STAGE_PADDING + 12
      text.y = logY + 8 + i * (LOG_FONT_SIZE + 4)
    }
  }

  /** サイドビューの配置 (#736)。座標は battleLayout.ts の純粋関数が正本 */
  private layoutSide(): void {
    const s = this.engine.getState()
    const L = computeSideBattleLayout({
      width: this.screenWidth,
      height: this.screenHeight,
      partyCount: s.party.length,
      enemyCount: s.enemies.length,
      commandCount: this.commands.length,
    })
    const panel = (r: { x: number; y: number; w: number; h: number }, g: Graphics) =>
      g
        .clear()
        .roundRect(r.x, r.y, r.w, r.h, 6)
        .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
        .stroke({ color: PANEL_STROKE, width: 2 })

    // ログ帯（上）
    panel(L.log, this.logPanel)
    this.setLogLineCount(L.logLines)
    for (let i = 0; i < this.logLines.length; i++) {
      const text = this.logLines[i]
      text.x = L.log.x + 12
      text.y = L.log.y + 8 + i * SIDE_LOG_LINE_HEIGHT
    }

    // 敵・味方スプライト
    for (let i = 0; i < this.enemyViews.length; i++) {
      this.placeEntityView(this.enemyViews[i], L.enemies[i])
    }
    for (let i = 0; i < this.partyViews.length; i++) {
      this.placeEntityView(this.partyViews[i], L.party[i])
    }

    // 下パネル: コマンド（左）
    panel(L.command, this.commandPanel)
    // 全コマンド共通で、いちばん狭いセルに最長ラベルが収まるフォントサイズにする
    const minCellW = L.commandCells.reduce((m, c) => Math.min(m, c.w), Infinity)
    const cmdFont = fitCommandFontSize(
      minCellW,
      this.commands.map((c) => c.text.text),
      COMMAND_FONT_SIZE,
      SIDE_COMMAND_TEXT_PADDING
    )
    for (let i = 0; i < this.commands.length; i++) {
      const cell = L.commandCells[i]
      const node = this.commands[i]
      node.hit.hitArea = new Rectangle(cell.x, cell.y, cell.w, cell.h)
      node.text.style.fontSize = cmdFont
      node.text.anchor.set(0.5, 0.5)
      node.text.x = cell.x + cell.w / 2
      node.text.y = cell.y + cell.h / 2
    }

    // 下パネル: 味方 HP/MP（右）
    panel(L.status, this.statsPanel)
    for (let i = 0; i < this.statusTexts.length; i++) {
      const row = L.statusRows[i]
      this.statusTexts[i].x = row.x + SIDE_STATUS_TEXT_PADDING
      this.statusTexts[i].y = row.y + (row.h - SIDE_STATUS_FONT_SIZE) / 2
    }
    this.sideCompact = L.statusCompact
    this.sideStatusTextWidth = Math.max(0, L.status.w - SIDE_STATUS_TEXT_PADDING * 2)
    this.sideLabelWidths = L.enemies.map((e) => e.label?.w ?? 0)
  }

  private placeEntityView(view: EntityView, slot: SpriteSlot | undefined): void {
    if (!slot) return
    view.container.position.set(slot.x, slot.y)
    const size = slot.size
    const fb = computeFallbackRect(size)
    view.fallback.clear().rect(fb.x, fb.y, fb.w, fb.h).fill(view.color)
    if (view.sprite) {
      if (this.acrylicParams && view.acrylicBack && view.acrylicFilters) {
        this.placeAcrylic(view.sprite, view.acrylicBack, view.acrylicFilters, size)
      } else {
        const fit = computeContainFit(view.sprite.texture.width, view.sprite.texture.height, size)
        view.sprite.position.set(fit.x, fit.y)
        view.sprite.width = fit.width
        view.sprite.height = fit.height
      }
      view.fallback.visible = false
    }
    if (view.label) {
      // ラベル位置は純粋関数が返す矩形（container 相対に直す）。置けない枠では隠す
      view.label.visible = !!slot.label
      if (slot.label) {
        view.label.x = slot.label.x - slot.x + slot.label.w / 2
        view.label.y = slot.label.y - slot.y
      }
    }
  }

  /**
   * acrylic のスプライト 1 体を配置する (#737)。幾何は純粋関数 computeAcrylicGeometry が正本で、
   * ここは結果を Graphics とフィルタの太さに反映するだけ（フィルタは再生成せず thickness を更新）。
   * 配置は slot 枠の内側に収まるので battleLayout の座標・ラベルとは重ならない。
   */
  private placeAcrylic(
    sprite: Sprite,
    back: Graphics,
    filters: { edge: OutlineFilter; rim: OutlineFilter },
    size: number
  ): void {
    const params = this.acrylicParams
    if (!params) return
    const g = computeAcrylicGeometry(sprite.texture.width, sprite.texture.height, size, params)
    sprite.position.set(g.sprite.x, g.sprite.y)
    sprite.width = g.sprite.width
    sprite.height = g.sprite.height
    back.clear()
    if (g.shadow) {
      back
        .ellipse(g.shadow.cx, g.shadow.cy, g.shadow.rx, g.shadow.ry)
        .fill({ color: 0x000000, alpha: params.shadowAlpha })
    }
    if (g.base) {
      back.ellipse(g.base.cx, g.base.cy, g.base.rx, g.base.ry).fill(ACRYLIC_BASE_COLOR)
    }
    if (g.highlight) {
      back
        .ellipse(g.highlight.cx, g.highlight.cy, g.highlight.rx, g.highlight.ry)
        .fill({ color: 0xffffff, alpha: params.highlightAlpha })
    }
    filters.edge.thickness = g.outlineWidth
    filters.rim.thickness = g.rimWidth
    const active: OutlineFilter[] = []
    if (g.outlineWidth > 0) active.push(filters.edge)
    if (g.rimWidth > 0 && params.rimAlpha > 0) active.push(filters.rim)
    sprite.filters = active.length > 0 ? active : null
    // 画像のある枠だけ台座・影を出す（読み込み前・失敗時は色四角のまま）
    back.visible = true
  }

  /** サイドビューのテキスト・生死表示を更新する (#736) */
  private refreshSide(): void {
    const s = this.engine.getState()
    for (let i = 0; i < this.enemyViews.length; i++) {
      const e = s.enemies[i]
      const view = this.enemyViews[i]
      if (!e) continue
      view.container.alpha = e.hp > 0 ? 1 : DEAD_ALPHA
      if (view.label) {
        // 純粋関数が返すラベル幅（1 列は領域幅まで・上限は一辺の SIDE_LABEL_MAX_WIDTH_RATIO 倍、
        // 多列は列ピッチ=スプライト一辺）を越える名前は省略して隣と重ねない
        // 縁取りは文字の両側にはみ出すので、そのぶん（左右 2 本）を最大幅から引く
        const w = Math.max(0, (this.sideLabelWidths[i] ?? 0) - SIDE_LABEL_STROKE_WIDTH * 2)
        view.label.text =
          `${fitLabel(e.name, w, SIDE_LABEL_FONT_SIZE)}\n` +
          fitHpLabel(e.hp, e.maxHp, w, SIDE_LABEL_FONT_SIZE)
      }
    }
    for (let i = 0; i < this.partyViews.length; i++) {
      const p = s.party[i]
      if (!p) continue
      this.partyViews[i].container.alpha = p.hp > 0 ? 1 : DEAD_ALPHA
    }
    for (let i = 0; i < this.statusTexts.length; i++) {
      const p = s.party[i]
      if (!p) continue
      const t = this.statusTexts[i]
      // 名前だけ省略して HP/MP は必ず見せる（パネル端を越えない）
      const suffix = this.sideCompact
        ? `  HP ${p.hp}/${p.maxHp}`
        : `  HP ${p.hp}/${p.maxHp}  MP ${p.mp}/${p.maxMp}`
      t.text = fitNameWithSuffix(p.name, suffix, this.sideStatusTextWidth, SIDE_STATUS_FONT_SIZE)
      t.style.fill = p.hp > 0 ? TEXT_COLOR : 0x888888
    }
  }

  /** エンジン状態を読み取り、テキストを更新する */
  private refresh(): void {
    const s = this.engine.getState()
    if (this.layoutMode === 'side') this.refreshSide()
    const aliveEnemy: BattleEntity | undefined = s.enemies.find((e) => e.hp > 0) ?? s.enemies[0]
    if (aliveEnemy) {
      this.enemyNameText.text = aliveEnemy.name
      this.enemyHpText.text = `HP ${aliveEnemy.hp}/${aliveEnemy.maxHp}`
      this.enemyHpText.style.fill = aliveEnemy.hp > 0 ? HP_COLOR : 0x666666
    }
    const hero: BattleEntity | undefined = s.party[0]
    if (hero) {
      this.heroStatsText.text = `${hero.name}  HP ${hero.hp}/${hero.maxHp}  MP ${hero.mp}/${hero.maxMp}`
      this.heroStatsText.style.fill = hero.hp > 0 ? TEXT_COLOR : 0x888888
    }
    // ログ末尾 visibleLogLines 件（front は LOG_VISIBLE_LINES、side は layoutSide が決めた行数）
    const tail = s.log.slice(-this.visibleLogLines)
    for (let i = 0; i < this.logLines.length; i++) {
      this.logLines[i].text = tail[i] ?? ''
    }
    // 暫定: コマンド入力不可なら見た目で示す（alpha 半分）
    const inputEnabled = s.phase === 'party-input'
    for (const cmd of this.commands) {
      cmd.hit.alpha = inputEnabled ? 1 : 0.4
      cmd.text.alpha = inputEnabled ? 1 : 0.4
      cmd.hit.eventMode = inputEnabled ? 'static' : 'none'
    }
  }
}
