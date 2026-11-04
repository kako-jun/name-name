/**
 * 一枚絵フィールドの全画面メニュー (#880) の描画と入力。状態遷移・配置・文言・遷移の時間計算は
 * `fieldMenu.ts` / `fieldMenuScreens.ts` / `fieldMenuTransition.ts`（純粋関数）が正本で、
 * ここは渡された状態を PixiJS に描き、タップ・キーを `stepFieldMenu` に流すだけ。
 * 配色は #744 の ff-blue（`windowStyle.ts`）の色だけを借りる。寸法はテーマに依らない（16:9 基準面の比率）。
 * 項目画面は共通の枠（説明バー・本体の窓・案内・戻る）に、定義側から差し込む中身（一覧・タブ・設定）を載せる。
 * 装備・購入・使用の実処理は持たない（選んだ結果は説明バーの通知）。
 */
import { Container, Graphics, Rectangle, Sprite, Text as PixiText, type Texture } from 'pixi.js'
import { FieldAcrylicFigure } from '../fieldSample/acrylicFigure'
import { HAND_HEIGHT, HAND_PIXEL, handCells } from './battleMenuLayout'
import {
  CLOSED_MENU,
  MENU_BACK_LABEL,
  MENU_EMPTY_BODY,
  TOP_SCREEN,
  computeMenuLayout,
  formatInfoBand,
  itemRowAt,
  menuHint,
  menuKeyEvent,
  openMenuState,
  resolveMenuItems,
  screenKindOfItem,
  stepFieldMenu,
  type FieldMenuCtx,
  type FieldMenuEvent,
  type FieldMenuInfo,
  type FieldMenuItemDef,
  type FieldMenuItemView,
  type FieldMenuState,
  type MenuLayout,
  type Rect,
} from './fieldMenu'
import {
  computeScreenLayout,
  listCount,
  listEntries,
  optionValue,
  resolveContent,
  screenDescription,
  type ResolvedContent,
  type ScreenCtx,
  type ScreenLayout,
  type ScreenNav,
} from './fieldMenuScreens'
import {
  DEFAULT_MENU_TRANSITION,
  sampleMenuTransition,
  transitionDurationMs,
  type MenuTransitionTiming,
} from './fieldMenuTransition'
import {
  FF_BLUE_BOTTOM_COLOR,
  FF_BLUE_PANEL_ALPHA,
  FF_BLUE_TEXT_SHADOW,
  FF_BLUE_TOP_COLOR,
  computeBands,
  lerpColor,
} from './windowStyle'

/** 左のパーティ1人ぶんの表示データ（フィールドと同じアクスタ姿・Lv・HP） */
export interface FieldMenuPartyView {
  id: string
  name: string
  /** レベル。未定義（レベルの仕組みが未実装の間）は「Lv --」 */
  level?: number
  hp: number
  maxHp: number
  mp?: number
  maxMp?: number
  atk?: number
  def?: number
  agi?: number
  /** アクスタ姿の絵。読めなかった・無いときは null（絵なしで枠だけ） */
  texture: Texture | null
}

export interface FieldMenuOpenData {
  items: readonly FieldMenuItemDef[]
  party: readonly FieldMenuPartyView[]
  info: FieldMenuInfo
  /** セーブスロットごとの表示（既存データの要約。空きは null）。長さ `SAVE_SLOT_COUNT` */
  slots: readonly (string | null)[]
  /** せっていの前回値（key → 選択肢 index） */
  settings?: Readonly<Record<string, number>>
}

export interface FieldMenuScreenOptions {
  /** キャンバスの論理サイズ（画面全体。背景はここ全体に敷く） */
  width: number
  height: number
  /** true = 左のパーティにアクスタの板・台座・影を付ける（フィールドの `spriteStyle: "acrylic"` と同じ） */
  acrylic: boolean
  /** 画面遷移の速さ（既定 `DEFAULT_MENU_TRANSITION`） */
  transition?: MenuTransitionTiming
  /** メニューが閉じた（最上位で戻った）。呼び出し側がフィールドへ戻す */
  onClose(): void
  /** 項目画面を開いた（id） */
  onOpenScreen?(id: string): void
  /** セーブスロットが決定された。保存できたら新しい要約、失敗は null */
  onSave?(slot: number): string | null
  /** せっていが変わった */
  onSetting?(key: string, value: number): void
}

const FONT_FAMILY = "'Noto Sans JP', sans-serif"
const WHITE = 0xffffff
const GRAY = 0x808080
const NOTICE_COLOR = 0xffee66
const HINT_COLOR = 0xdddddd
const BACKDROP_COLOR = lerpColor(FF_BLUE_TOP_COLOR, FF_BLUE_BOTTOM_COLOR, 0.55)

interface Transition {
  /** 浅い画面（最上位）との間で遷移する深い画面 */
  screen: string
  nav: ScreenNav
  reverse: boolean
  elapsed: number
}

export class FieldMenuScreen extends Container {
  private state: FieldMenuState = CLOSED_MENU
  private data: FieldMenuOpenData | null = null
  private contents: Record<string, ResolvedContent> = {}
  private slots: (string | null)[] = []
  private timed = false
  private dirty = false
  private trans: Transition | null = null
  private w: number
  private h: number
  private readonly timing: MenuTransitionTiming
  private readonly staticLayer = new Container()
  /** 絵（アクスタ・立ち絵）。再描画しても作り直さない */
  private readonly artLayer = new Container()
  private readonly figures: FieldAcrylicFigure[] = []
  private readonly sprites: Sprite[] = []
  private readonly useAcrylic: boolean

  constructor(private readonly opts: FieldMenuScreenOptions) {
    super()
    this.w = opts.width
    this.h = opts.height
    this.useAcrylic = opts.acrylic
    this.timing = opts.transition ?? DEFAULT_MENU_TRANSITION
    this.visible = false
    this.eventMode = 'static'
    this.hitArea = new Rectangle(0, 0, this.w, this.h)
    // 右クリック = 戻る（フィールド上では何もしない。メニュー内だけ）
    this.on('rightdown', () => this.dispatch({ type: 'back' }))
    this.addChild(this.staticLayer, this.artLayer)
  }

  get isOpen(): boolean {
    return this.state.open
  }

  /** 画面遷移（枠スライド）の最中か */
  get transitioning(): boolean {
    return this.trans !== null
  }

  /** テスト・検証用 */
  get current(): FieldMenuState {
    return this.state
  }

  private itemViews(): FieldMenuItemView[] {
    return this.data ? resolveMenuItems(this.data.items, { timeLimited: this.timed }) : []
  }

  private ctx(): FieldMenuCtx {
    return {
      items: this.itemViews(),
      contents: this.contents,
      partyCount: this.data?.party.length ?? 0,
      slotFilled: this.slots.map((s) => s !== null),
    }
  }

  /** 時間制限中か。セーブなど `blockedWhileTimed` の項目が灰色になり、左上の残り時間の予約領域を避ける配置になる */
  setTimed(timed: boolean): void {
    this.timed = timed
    this.dirty = true
  }

  open(data: FieldMenuOpenData): void {
    this.data = data
    this.slots = [...data.slots]
    this.contents = {}
    for (const d of data.items) {
      const kind = screenKindOfItem(d)
      this.contents[d.id] = resolveContent(d.label, kind, d.content)
    }
    this.state = openMenuState({ ...(data.settings ?? {}) })
    this.trans = null
    this.visible = true
    this.redraw()
  }

  /** 開き直しのための、いまのせってい（key → 選択肢 index） */
  get settings(): Record<string, number> {
    return this.state.open ? { ...this.state.settings } : {}
  }

  /** メニューを閉じる（`onClose` は呼ばない。呼び出し側が自分で閉じるとき用） */
  close(): void {
    this.state = CLOSED_MENU
    this.trans = null
    this.visible = false
    for (const f of this.figures) f.display.visible = false
  }

  /** 画面（キャンバス）の大きさが変わったとき */
  resize(width: number, height: number): void {
    this.w = width
    this.h = height
    this.hitArea = new Rectangle(0, 0, width, height)
    this.dirty = true
  }

  /** 毎フレーム。画面遷移を進め、ポインタ操作で付いた再描画をまとめて反映する */
  tick(dtMs: number): void {
    if (!this.state.open && !this.trans) return
    if (this.trans) {
      this.trans.elapsed += dtMs
      if (this.trans.elapsed >= transitionDurationMs(this.timing)) this.trans = null
      this.dirty = true
    }
    if (this.dirty) this.redraw()
  }

  /** キー入力。メニューが開いていて対象のキーなら true（呼び出し側は既定動作を止める） */
  handleKey(code: string): boolean {
    if (!this.state.open) return false
    const ev = menuKeyEvent(code)
    if (!ev) return false
    this.dispatch(ev)
    return true
  }

  dispatch(ev: FieldMenuEvent): void {
    if (!this.state.open || this.trans) return
    const prev = this.state
    const step = stepFieldMenu(prev, ev, this.ctx())
    this.state = step.state
    switch (step.effect) {
      case 'closed':
        this.close()
        this.opts.onClose()
        return
      case 'opened-screen':
        if (this.state.open && this.state.nav) {
          this.startTransition(this.state.screen, this.state.nav, false)
          this.opts.onOpenScreen?.(this.state.screen)
        }
        break
      case 'back-to-top':
        if (prev.open && prev.nav) this.startTransition(prev.screen, prev.nav, true)
        break
      case 'save':
        if (step.save !== undefined) {
          const label = this.opts.onSave?.(step.save) ?? null
          if (label !== null) this.slots[step.save] = label
          else if (this.state.open) this.state = { ...this.state, notice: 'セーブできませんでした' }
        }
        break
      case 'setting':
        if (step.setting) this.opts.onSetting?.(step.setting.key, step.setting.value)
        break
      default:
        break
    }
    if (step.state !== prev || step.effect === 'save') this.dirty = true
  }

  private startTransition(screen: string, nav: ScreenNav, reverse: boolean): void {
    if (transitionDurationMs(this.timing) <= 0) return
    this.trans = { screen, nav, reverse, elapsed: 0 }
  }

  // ---- 描画 ----

  private screenCtx(content: ResolvedContent): ScreenCtx {
    return {
      content,
      partyCount: this.data?.party.length ?? 0,
      slotFilled: this.slots.map((s) => s !== null),
      settings: this.state.open ? this.state.settings : {},
    }
  }

  private screenLayout(screen: string, nav: ScreenNav, open: boolean): ScreenLayout {
    const c = this.contents[screen]
    const items = this.itemViews()
    const top = computeMenuLayout(
      this.w,
      this.h,
      items.length,
      this.data?.party.length ?? 0,
      this.timed
    )
    const ctx = this.screenCtx(c)
    return computeScreenLayout({
      kind: c.kind,
      base: top.base,
      partyCount: this.data?.party.length ?? 0,
      tabCount: c.tabs.length,
      listCount: listCount(ctx, nav),
      cursor: nav.list,
      reserveTimer: this.timed,
      confirmOpen: open && nav.focus === 'confirm',
    })
  }

  private redraw(): void {
    this.dirty = false
    const data = this.data
    const st = this.state
    if (!data) return
    for (const c of this.staticLayer.removeChildren()) c.destroy({ children: true })
    this.artLayer.removeChildren()
    for (const f of this.figures) f.display.visible = false
    this.artIndex = 0
    const S = this.staticLayer
    const items = this.itemViews()
    const lay = computeMenuLayout(this.w, this.h, items.length, data.party.length, this.timed)
    // 背景は画面全体（基準面の外の黒帯まで）に敷く
    S.addChild(new Graphics().rect(0, 0, this.w, this.h).fill({ color: BACKDROP_COLOR }))
    const t = this.trans
    const interactive = !t
    const inScreen = st.open && st.screen !== TOP_SCREEN
    // 描くべき深い画面（遷移中は遷移先／遷移元、そうでなければ開いている画面）
    const deepId = t ? t.screen : inScreen && st.open ? st.screen : null
    const deepNav = t ? t.nav : inScreen && st.open ? st.nav : null
    let frame: Rect = lay.itemWindow
    let topAlpha = deepId ? 0 : 1
    let deepAlpha = deepId ? 1 : 0
    let sl: ScreenLayout | null = null
    if (deepId && deepNav) {
      sl = this.screenLayout(deepId, deepNav, interactive)
      frame = sl.primary
      if (t) {
        const sample = sampleMenuTransition(
          t.elapsed,
          this.timing,
          lay.itemWindow,
          this.screenLayout(deepId, deepNav, false).primary,
          t.reverse
        )
        frame = sample.frame
        topAlpha = sample.fromAlpha
        deepAlpha = sample.toAlpha
      }
    }
    // 再利用する枠（右上の項目窓 ⇄ 項目画面の本体窓）
    this.panel(S, frame, lay)
    if (topAlpha > 0) {
      const top = new Container()
      top.alpha = topAlpha
      this.drawTopContents(top, items, st, lay, interactive && !inScreen, data)
      S.addChild(top)
    }
    if (deepAlpha > 0 && deepId && deepNav && sl) {
      const deep = new Container()
      deep.alpha = deepAlpha
      this.drawScreenContents(deep, deepId, deepNav, sl, lay, interactive)
      S.addChild(deep)
    }
    this.drawBand(S, st, lay, data, deepId && deepNav ? this.screenCtxFor(deepId, deepNav) : null)
  }

  private screenCtxFor(id: string, nav: ScreenNav): { ctx: ScreenCtx; nav: ScreenNav } {
    return { ctx: this.screenCtx(this.contents[id]), nav }
  }

  private drawTopContents(
    C: Container,
    items: FieldMenuItemView[],
    st: FieldMenuState,
    lay: MenuLayout,
    interactive: boolean,
    data: FieldMenuOpenData
  ): void {
    // 左のパーティ（項目選択中は何も強調しない）
    data.party
      .slice(0, lay.partySlots.length)
      .forEach((p, i) => this.drawPartySlot(C, p, lay.partySlots[i], lay, false))
    items.forEach((it, i) => {
      const r = lay.itemRows[i]
      C.addChild(
        this.text(
          it.label,
          lay.fonts.row,
          it.enabled ? WHITE : GRAY,
          r.x + r.h * 1.4,
          r.y + r.h / 2,
          'left'
        )
      )
      if (st.open && i === st.cursor)
        C.addChild(this.hand(r.x + r.h * 0.2, r.y + r.h / 2, r.h * 0.6))
      if (interactive)
        this.hit(C, r, (e) => {
          if (e.button === 2) return
          this.dispatch({ type: 'tap', index: itemRowAt(lay.itemRows, e.global.x, e.global.y) })
        })
    })
  }

  private drawScreenContents(
    C: Container,
    id: string,
    nav: ScreenNav,
    sl: ScreenLayout,
    lay: MenuLayout,
    interactive: boolean
  ): void {
    const content = this.contents[id]
    const data = this.data!
    const ctx = this.screenCtx(content)
    const st = this.state
    const notice = st.open ? st.notice : null
    const k = content.kind
    // 説明バー（上端）
    this.panel(C, sl.desc, lay)
    C.addChild(
      this.text(
        screenDescription(nav, ctx, notice),
        sl.fonts.desc,
        notice ? NOTICE_COLOR : WHITE,
        sl.desc.x + sl.desc.h * 0.4,
        sl.desc.y + sl.desc.h / 2,
        'left'
      )
    )
    // 左の人物（どうぐ・まほう・そうび・まいし・ジョブ）。選んでいる段階に入ってから強調する
    sl.party.forEach((r, i) => {
      const p = data.party[i]
      if (!p) return
      const emphasize =
        i === nav.party && (nav.focus === 'party' || (k === 'party-list' && nav.focus === 'list'))
      this.drawPartySlot(C, p, r, lay, emphasize, true)
      if (interactive)
        this.hit(C, r, (e) => {
          if (e.button !== 2) this.dispatch({ type: 'select', target: 'party', index: i })
        })
    })
    // タブ（サブコマンド）
    sl.tabs.forEach((r, i) => {
      this.panel(C, r, lay)
      C.addChild(
        this.text(
          content.tabs[i].label,
          sl.fonts.tab,
          i === nav.tab && nav.focus !== 'tab' ? NOTICE_COLOR : WHITE,
          r.x + r.w / 2 + r.h * 0.2,
          r.y + r.h / 2,
          'center'
        )
      )
      if (i === nav.tab && nav.focus === 'tab')
        C.addChild(this.hand(r.x + r.h * 0.15, r.y + r.h / 2, r.h * 0.55))
      if (interactive)
        this.hit(C, r, (e) => {
          if (e.button !== 2) this.dispatch({ type: 'select', target: 'tab', index: i })
        })
    })
    // 本体の窓の中身
    if (k === 'status') this.drawStatus(C, nav, sl, lay, interactive)
    else this.drawList(C, nav, ctx, sl, interactive)
    // 確認窓
    if (sl.confirm) {
      const cf = sl.confirm
      this.panel(C, cf.frame, lay, true)
      const label =
        k === 'save'
          ? `スロット${nav.list + 1}に上書きしますか？`
          : `「${listEntries(ctx, nav)[nav.list]?.label ?? ''}」を買いますか？`
      C.addChild(
        this.text(
          label,
          sl.fonts.row,
          WHITE,
          cf.message.x + cf.message.w / 2,
          cf.message.y + cf.message.h / 2,
          'center'
        )
      )
      const names = k === 'save' ? ['はい', 'いいえ'] : ['買う', 'やめる']
      cf.options.forEach((r, i) => {
        C.addChild(this.text(names[i], sl.fonts.row, WHITE, r.x + r.w / 2, r.y + r.h / 2, 'center'))
        if (i === nav.confirm) C.addChild(this.hand(r.x + r.w * 0.3, r.y + r.h / 2, r.h * 0.6))
        if (interactive)
          this.hit(C, r, (e) => {
            if (e.button !== 2) this.dispatch({ type: 'select', target: 'confirm', index: i })
          })
      })
    }
  }

  private drawList(
    C: Container,
    nav: ScreenNav,
    ctx: ScreenCtx,
    sl: ScreenLayout,
    interactive: boolean
  ): void {
    const k = ctx.content.kind
    const total = listCount(ctx, nav)
    if (total === 0) {
      C.addChild(
        this.text(
          MENU_EMPTY_BODY,
          sl.fonts.row,
          GRAY,
          sl.primary.x + sl.primary.w / 2,
          sl.primary.y + sl.primary.h / 2,
          'center'
        )
      )
      return
    }
    sl.rows.forEach((r, vi) => {
      const i = sl.rowStart + vi
      let label = ''
      let detail = ''
      let enabled = true
      if (k === 'save') {
        label = `スロット${i + 1}`
        detail = this.slots[i] ?? 'あき'
        enabled = true
      } else if (k === 'config') {
        const o = ctx.content.options[i]
        label = o.label
        detail = `< ${o.choices[optionValue(ctx, o)]} >`
      } else {
        const e = listEntries(ctx, nav)[i]
        label = e.label
        detail = e.detail ?? ''
        enabled = e.enabled !== false
      }
      const color = enabled ? WHITE : GRAY
      C.addChild(this.text(label, sl.fonts.row, color, r.x + r.h * 1.1, r.y + r.h / 2, 'left'))
      if (detail)
        C.addChild(
          this.text(detail, sl.fonts.row, color, r.x + r.w - r.h * 0.5, r.y + r.h / 2, 'right')
        )
      if (i === nav.list && (nav.focus === 'list' || nav.focus === 'confirm'))
        C.addChild(this.hand(r.x + r.h * 0.15, r.y + r.h / 2, r.h * 0.6))
      if (interactive)
        this.hit(C, r, (e) => {
          if (e.button !== 2) this.dispatch({ type: 'select', target: 'list', index: i })
        })
    })
  }

  private drawStatus(
    C: Container,
    nav: ScreenNav,
    sl: ScreenLayout,
    lay: MenuLayout,
    interactive: boolean
  ): void {
    const p = this.data!.party[nav.party]
    const P = sl.primary
    const f = sl.fonts.row
    if (sl.statusNav) {
      for (const [r, label, target] of [
        [sl.statusNav.prev, '◀ 前', 'prev'],
        [sl.statusNav.next, '次 ▶', 'next'],
      ] as const) {
        this.panel(C, r, lay)
        C.addChild(this.text(label, sl.fonts.tab, WHITE, r.x + r.w / 2, r.y + r.h / 2, 'center'))
        if (interactive)
          this.hit(C, r, (e) => {
            if (e.button !== 2) this.dispatch({ type: 'select', target, index: 0 })
          })
      }
    }
    if (!p) {
      C.addChild(this.text(MENU_EMPTY_BODY, f, GRAY, P.x + P.w / 2, P.y + P.h / 2, 'center'))
      return
    }
    const x0 = P.x + P.w * 0.08
    const lh = P.h * 0.1
    let y = P.y + P.h * 0.2
    const line = (s: string, color = WHITE): void => {
      C.addChild(this.text(s, f, color, x0, y, 'left'))
      y += lh
    }
    line(`${p.name} ${p.level === undefined ? 'Lv --' : `Lv ${p.level}`}`)
    line(`HP  ${p.hp} / ${p.maxHp}`)
    if (p.mp !== undefined) line(`MP  ${p.mp} / ${p.maxMp ?? p.mp}`)
    line(`ちから ${p.atk ?? '--'} まもり ${p.def ?? '--'} すばやさ ${p.agi ?? '--'}`)
    line('こゆうそしつ  --', GRAY)
    line('そうび  --', GRAY)
    line('おもいのやいば  --', GRAY)
    this.placeArt(p.texture, P.h * 0.5, P.x + P.w * 0.8, P.y + P.h * 0.9)
  }

  private artIndex = 0

  private drawPartySlot(
    C: Container,
    p: FieldMenuPartyView,
    r: Rect,
    lay: MenuLayout,
    emphasize: boolean,
    compact = false
  ): void {
    this.panel(C, r, lay, emphasize)
    if (emphasize)
      C.addChild(new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: WHITE, alpha: 0.16 }))
    this.placeArt(p.texture, r.h * 0.86, r.x + r.h * 0.65, r.y + r.h * 0.94)
    const tx = r.x + r.h * 1.4
    const size = compact ? lay.fonts.party * 0.8 : lay.fonts.party
    const right = r.x + r.w - r.h * 0.3
    const lv = p.level === undefined ? 'Lv --' : `Lv ${p.level}`
    const hp = `HP  ${p.hp} / ${p.maxHp}`
    // 「いま選択中」の表示（矢印でなくアクスタ側に出す。戦闘と同じ見方）
    const mark = emphasize ? '選択中' : null
    if (compact) {
      // 狭い枠: 名前 / Lv（と選択中）/ HP の3段
      C.addChild(this.text(p.name, size, WHITE, tx, r.y + r.h * 0.22, 'left'))
      C.addChild(this.text(lv, size, WHITE, tx, r.y + r.h * 0.5, 'left'))
      if (mark)
        C.addChild(this.text(mark, size * 0.85, NOTICE_COLOR, right, r.y + r.h * 0.5, 'right'))
      C.addChild(this.text(hp, size, WHITE, tx, r.y + r.h * 0.78, 'left'))
      return
    }
    C.addChild(this.text(p.name, size, WHITE, tx, r.y + r.h * 0.3, 'left'))
    C.addChild(this.text(lv, size, WHITE, right, r.y + r.h * 0.3, 'right'))
    C.addChild(this.text(hp, size, WHITE, tx, r.y + r.h * 0.7, 'left'))
    if (mark)
      C.addChild(this.text(mark, size * 0.8, NOTICE_COLOR, right, r.y + r.h * 0.72, 'right'))
  }

  /** アクスタ姿（足元 (x, y)、高さ height）。絵が無ければ何もしない */
  private placeArt(tex: Texture | null, height: number, x: number, y: number): void {
    if (!tex) return
    const idx = this.artIndex++
    if (this.useAcrylic) {
      let fig = this.figures[idx]
      if (!fig) {
        fig = new FieldAcrylicFigure()
        this.figures[idx] = fig
      }
      fig.update(tex, height, false, x, y)
      this.artLayer.addChild(fig.display)
    }
    let sp = this.sprites[idx]
    if (!sp) {
      sp = new Sprite(tex)
      sp.anchor.set(0.5, 1)
      this.sprites[idx] = sp
    }
    sp.texture = tex
    sp.scale.set(height / tex.height)
    sp.position.set(x, y)
    this.artLayer.addChild(sp)
  }

  private drawBand(
    S: Container,
    st: FieldMenuState,
    lay: MenuLayout,
    data: FieldMenuOpenData,
    deep: { ctx: ScreenCtx; nav: ScreenNav } | null
  ): void {
    const b = lay.backButton
    // 「◀戻る」ボタン（情報帯の左端。1タップで1階層戻る）
    this.panel(S, b, lay)
    S.addChild(
      this.text(MENU_BACK_LABEL, lay.fonts.band, WHITE, b.x + b.w / 2, b.y + b.h / 2, 'center')
    )
    if (!this.trans)
      this.hit(S, b, (e) => {
        if (e.button !== 2) this.dispatch({ type: 'back' })
      })
    const r = lay.band
    S.addChild(
      this.text(formatInfoBand(data.info), lay.fonts.band, WHITE, r.x, r.y + r.h * 0.27, 'left')
    )
    // 案内は常に出す。通知（選べない項目の理由など）があるときは理由に替える
    const notice = st.open ? st.notice : null
    void deep
    const msg = notice ?? menuHint(st)
    S.addChild(
      this.text(
        msg,
        lay.fonts.hint,
        notice ? NOTICE_COLOR : HINT_COLOR,
        r.x,
        r.y + r.h * 0.74,
        'left'
      )
    )
  }

  private hit(
    parent: Container,
    r: Rect,
    onDown: (e: { button: number; global: { x: number; y: number } }) => void
  ): void {
    const g = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 })
    g.eventMode = 'static'
    g.cursor = 'pointer'
    g.on('pointerdown', onDown)
    parent.addChild(g)
  }

  /** ff-blue の窓（帯グラデーション・白枠・角丸）。寸法はテーマに持たせない。`strong` = 枠を太く黄みにして目立たせる */
  private panel(S: Container, r: Rect, lay: MenuLayout, strong = false): void {
    const g = new Container()
    const radius = lay.base.h * 0.012
    const line = Math.max(2, lay.base.h * (strong ? 0.008 : 0.004))
    const bands = new Graphics()
    for (const band of computeBands(Math.round(r.h))) {
      bands
        .rect(r.x, r.y + band.y, r.w, band.h)
        .fill({ color: band.color, alpha: FF_BLUE_PANEL_ALPHA })
    }
    const mask = new Graphics().roundRect(r.x, r.y, r.w, r.h, radius).fill({ color: WHITE })
    bands.mask = mask
    const frame = new Graphics()
      .roundRect(r.x, r.y, r.w, r.h, radius)
      .stroke({ width: line, color: strong ? NOTICE_COLOR : WHITE })
    g.addChild(bands, mask, frame)
    S.addChild(g)
  }

  private text(
    s: string,
    size: number,
    color: number,
    x: number,
    y: number,
    align: 'left' | 'center' | 'right'
  ): PixiText {
    const t = new PixiText({
      text: s,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: size,
        fill: color,
        padding: Math.ceil(size * 0.3),
        dropShadow:
          color === GRAY ? false : { ...FF_BLUE_TEXT_SHADOW, distance: Math.max(1, size / 14) },
      },
    })
    t.anchor.set(align === 'left' ? 0 : align === 'center' ? 0.5 : 1, 0.5)
    t.position.set(x, y)
    t.eventMode = 'none'
    return t
  }

  /** 手の形カーソル (#744)。戦闘の手と同じドット絵（右向き）を行の高さに合わせて拡大する */
  private hand(x: number, cy: number, height: number): Graphics {
    const rows = HAND_HEIGHT / HAND_PIXEL
    const unit = height / rows
    const cells = handCells('right')
    const g = new Graphics()
    g.eventMode = 'none'
    const top = cy - height / 2
    const k = unit / HAND_PIXEL
    for (const c of cells)
      g.rect(x + c.x * k - 1, top + c.y * k - 1, unit + 2, unit + 2).fill({ color: 0x000000 })
    for (const c of cells) g.rect(x + c.x * k, top + c.y * k, unit, unit).fill({ color: WHITE })
    return g
  }

  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    for (const f of this.figures) f?.destroy()
    super.destroy(options)
  }
}

/** フィールド面の右上隅の ≡ ボタンを描く（三本線の図形。絵文字は使わない）。位置・大きさは `computeMenuButtonRect` */
export function drawMenuButton(g: Graphics, r: Rect): Graphics {
  g.clear()
  const radius = r.h * 0.18
  g.roundRect(r.x, r.y, r.w, r.h, radius).fill({ color: FF_BLUE_BOTTOM_COLOR, alpha: 0.85 })
  g.roundRect(r.x, r.y, r.w, r.h, radius).stroke({ width: Math.max(2, r.h * 0.05), color: WHITE })
  const lineH = r.h * 0.09
  for (const f of [0.3, 0.5, 0.7])
    g.rect(r.x + r.w * 0.22, r.y + r.h * f - lineH / 2, r.w * 0.56, lineH).fill({ color: WHITE })
  return g
}
