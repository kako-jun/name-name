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
import { createHandCursor } from './HandCursor'
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
  MAX_PARTY_SLOTS,
  appstoreHasParty,
  clampNav,
  computeScreenLayout,
  entryForUse,
  listCount,
  listEntries,
  optionValue,
  resolveContent,
  screenDescription,
  type ResolvedContent,
  type ScreenCtx,
  type ScreenLayout,
  type ScreenNav,
  type ScreenUse,
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

/** 表示だけ更新する人物の数値（使ったあとの HP・MP など）。id で突き合わせて `FieldMenuPartyView` に重ねる */
export type FieldMenuPartyStat = { id: string } & Partial<
  Pick<FieldMenuPartyView, 'hp' | 'maxHp' | 'mp' | 'maxMp' | 'level' | 'atk' | 'def' | 'agi'>
>

/** 項目画面の中身・人物の数値の差し替え（使った・並べ替えたあと） */
export interface FieldMenuRefresh {
  /** メニュー項目の定義（content 込み）。渡すと中身を作り直す */
  items?: readonly FieldMenuItemDef[]
  party?: readonly FieldMenuPartyStat[]
}

/** 「使う」の要求（どうぐ・まほう）。中身の組み立てと同じ id（`MenuEntry.id`・人物の id）で渡す */
export interface FieldUseRequest {
  /** 項目の id（`item` / `magic` など） */
  screen: string
  entryId?: string
  /** まほうの使い手 */
  casterId?: string
  /** 対象の人物。全体・本人のときは undefined */
  targetId?: string
}

export interface FieldUseOutcome extends FieldMenuRefresh {
  ok: boolean
  /** 説明バーに出す文 */
  notice: string
}

export interface FieldMenuOpenData {
  items: readonly FieldMenuItemDef[]
  party: readonly FieldMenuPartyView[]
  info: FieldMenuInfo
  /** セーブスロットごとの表示（既存データの要約。空きは null）。長さ `SAVE_SLOT_COUNT` */
  slots: readonly (string | null)[]
  /** せっていの前回値（key → 選択肢 index） */
  settings?: Readonly<Record<string, number>>
  /** 一覧に出す画像（`MenuEntry.image` の URL → 読み込んだ絵）。読めなかった・未読み込みは null か無し（文字だけで出す） */
  images?: Readonly<Record<string, Texture | null>>
  /** 手のカーソルの画像 (#1067)。未指定・読めなかったは null か無し（従来のドット手） */
  handTexture?: Texture | null
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
  /** どうぐ・まほうを使う。null（または未指定）= 使う処理が無い（説明バーに「まだありません」） */
  onUse?(req: FieldUseRequest): FieldUseOutcome | null
  /** せいとん（種類別の並べ替え）。null（または未指定）= 処理が無い */
  onSort?(): FieldMenuRefresh | null
}

export const MENU_FONT_FAMILY = "'Noto Sans JP', sans-serif"
/** メニューの文字（情報帯・案内）に使う字を含む見本。フォントの字の分割ファイルを開く前に読むため */
export const MENU_FONT_SAMPLE = '現在地円時間歩数決定戻る選ぶ矢印タップ右クリックabc0123456789'
const FONT_FAMILY = MENU_FONT_FAMILY
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
  private readonly artTop = new Container()
  /** 項目画面側の絵。top / deep それぞれ窓の文字と一緒に遷移フェードする */
  private readonly artDeep = new Container()
  /** 項目画面ごとの一覧の見える先頭（FF 風に前回位置を保つ） */
  private readonly scrolls = new Map<string, number>()
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
    this.addChild(this.staticLayer, this.artTop, this.artDeep)
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
      partyCount: this.partyCount(),
      partyIds: this.data?.party.map((p) => p.id) ?? [],
      slotFilled: this.slots.map((s) => s !== null),
    }
  }

  /** 画面に出る人物の数（枠は最大 `MAX_PARTY_SLOTS`。選択はこの範囲に収める） */
  private partyCount(): number {
    return Math.min(this.data?.party.length ?? 0, MAX_PARTY_SLOTS)
  }

  /** 情報帯の内容（現在地・円・プレイ時間・歩数）を更新する。文字が変わらなければ再描画しない */
  setInfo(info: FieldMenuInfo): void {
    if (!this.data) return
    if (formatInfoBand(info) === formatInfoBand(this.data.info)) return
    this.data = { ...this.data, info }
    this.dirty = true
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
    const ev = menuKeyEvent(code, this.state.settings.keys)
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
      case 'use':
        if (step.use) this.runUse(step.use)
        break
      case 'sort':
        this.runSort()
        break
      default:
        break
    }
    if (step.state !== prev || step.effect === 'save' || step.effect === 'use') this.dirty = true
  }

  /** どうぐ・まほうを使う。実処理は呼び出し側（`onUse`）。結果の文は説明バーに出し、中身・人物の数値を差し替える */
  private runUse(use: ScreenUse): void {
    const st = this.state
    if (!st.open || !this.data) return
    const content = this.contents[st.screen]
    if (!content) return
    const ids = this.data.party.map((p) => p.id)
    const entry = entryForUse(content, ids, use)
    const out = entry
      ? this.opts.onUse?.({
          screen: st.screen,
          ...(entry.id !== undefined ? { entryId: entry.id } : {}),
          ...(use.caster >= 0 && ids[use.caster] !== undefined
            ? { casterId: ids[use.caster] }
            : {}),
          ...(use.target !== undefined && ids[use.target] !== undefined
            ? { targetId: ids[use.target] }
            : {}),
        })
      : null
    if (!out) {
      this.state = {
        ...st,
        notice: entry?.description ?? `「${entry?.label ?? ''}」の処理はまだありません`,
      }
      return
    }
    this.applyRefresh(out)
    if (this.state.open) this.state = { ...this.state, notice: out.notice }
  }

  private runSort(): void {
    const st = this.state
    if (!st.open) return
    const out = this.opts.onSort?.() ?? null
    if (!out) {
      this.state = { ...st, notice: '「せいとん」の処理はまだありません' }
      return
    }
    this.applyRefresh(out)
    if (this.state.open) this.state = { ...this.state, notice: 'しゅるいべつに ならべかえました' }
  }

  /** 中身（項目の定義）と人物の数値を差し替え、選択位置を一覧の範囲に収め直す */
  private applyRefresh(r: FieldMenuRefresh): void {
    if (!this.data) return
    let data = this.data
    if (r.party && r.party.length > 0) {
      data = {
        ...data,
        party: data.party.map((p) => {
          const s = r.party?.find((x) => x.id === p.id)
          return s ? { ...p, ...s } : p
        }),
      }
    }
    if (r.items) {
      data = { ...data, items: r.items }
      for (const d of r.items)
        this.contents[d.id] = resolveContent(d.label, screenKindOfItem(d), d.content)
    }
    this.data = data
    const st = this.state
    if (st.open && st.nav) {
      const c = this.contents[st.screen]
      if (c) this.state = { ...st, nav: clampNav(st.nav, this.screenCtx(c)) }
    }
    this.dirty = true
  }

  private startTransition(screen: string, nav: ScreenNav, reverse: boolean): void {
    if (transitionDurationMs(this.timing) <= 0) return
    this.trans = { screen, nav, reverse, elapsed: 0 }
  }

  // ---- 描画 ----

  private screenCtx(content: ResolvedContent): ScreenCtx {
    return {
      content,
      partyCount: this.partyCount(),
      partyIds: this.data?.party.map((p) => p.id) ?? [],
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
    const layout = computeScreenLayout({
      kind: c.kind,
      base: top.base,
      partyCount: this.partyCount(),
      tabCount: c.tabs.length,
      listCount: listCount(ctx, nav),
      cursor: nav.list,
      reserveTimer: this.timed,
      confirmOpen: open && nav.focus === 'confirm',
      prevRowStart: this.scrolls.get(screen) ?? 0,
      perParty: c.kind === 'appstore' && appstoreHasParty(c),
      headerCount:
        c.kind === 'equip'
          ? (c.headerByParty[this.data?.party[nav.party]?.id ?? '']?.length ?? 0)
          : 0,
    })
    this.scrolls.set(screen, layout.rowStart)
    return layout
  }

  private redraw(): void {
    this.dirty = false
    const data = this.data
    const st = this.state
    if (!data) return
    for (const c of this.staticLayer.removeChildren()) c.destroy({ children: true })
    this.artTop.removeChildren()
    this.artDeep.removeChildren()
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
    // 絵も窓の文字と一緒にフェードする
    this.artTop.alpha = topAlpha
    this.artDeep.alpha = deepAlpha
    this.drawBand(S, st, lay, data)
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
      .forEach((p, i) =>
        this.drawPartySlot(C, p, lay.partySlots[i], lay, false, false, this.artTop)
      )
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
    // 左の人物（どうぐ・まほう・そうび・ませき・ジョブ）。選んでいる段階に入ってから強調する
    sl.party.forEach((r, i) => {
      const p = data.party[i]
      if (!p) return
      const targeting = nav.focus === 'target'
      const emphasize = targeting
        ? i === nav.target
        : i === nav.party &&
          (nav.focus === 'party' || ((k === 'party-list' || k === 'equip') && nav.focus === 'list'))
      this.drawPartySlot(C, p, r, lay, emphasize, true, this.artDeep, targeting ? '対象' : '選択中')
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
    if (k === 'status') this.drawStatus(C, nav, sl, lay, interactive, content)
    else {
      if (k === 'appstore' && appstoreHasParty(content))
        this.drawPersonNav(C, sl, lay, interactive, this.data?.party[nav.party]?.name ?? '')
      if (k === 'equip') this.drawEquipHeader(C, nav, sl, content)
      this.drawList(C, nav, ctx, sl, interactive)
    }
    // 確認窓
    if (sl.confirm) {
      const cf = sl.confirm
      this.panel(C, cf.frame, lay, true)
      const label =
        k === 'save'
          ? `スロット${nav.list + 1}に上書きしますか？`
          : this.buyMessage(listEntries(ctx, nav)[nav.list])
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
      // アプリストアの品の画像（あれば小さく。読めない・未指定は文字だけ）
      const tex = k === 'appstore' ? this.imageOf(listEntries(ctx, nav)[i]?.image) : null
      if (tex) this.placeThumb(C, tex, r.x + r.h * 0.85, r.y + r.h * 0.5, r.h * 0.86, !enabled)
      C.addChild(
        this.text(label, sl.fonts.row, color, r.x + r.h * (tex ? 1.9 : 1.1), r.y + r.h / 2, 'left')
      )
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

  /** 人物の前・次ボタン（ステータス・アプリストア）。`name` があれば中央に人物名の枠を出す */
  private drawPersonNav(
    C: Container,
    sl: ScreenLayout,
    lay: MenuLayout,
    interactive: boolean,
    name?: string
  ): void {
    if (!sl.statusNav) return
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
    if (name) {
      const l = sl.statusNav.label
      C.addChild(
        this.text(name, sl.fonts.tab, NOTICE_COLOR, l.x + l.w / 2, l.y + l.h / 2, 'center')
      )
    }
  }

  /** そうび画面の見出し行（2 枠の現在の装備）。選んだ人物の分 */
  private drawEquipHeader(
    C: Container,
    nav: ScreenNav,
    sl: ScreenLayout,
    content: ResolvedContent
  ): void {
    const pid = this.data?.party[nav.party]?.id
    const rows = (pid !== undefined ? content.headerByParty[pid] : undefined) ?? []
    sl.header.forEach((r, i) => {
      const row = rows[i]
      if (!row) return
      C.addChild(
        this.text(row.label, sl.fonts.row, NOTICE_COLOR, r.x + r.h * 0.5, r.y + r.h / 2, 'left')
      )
      C.addChild(
        this.text(row.value, sl.fonts.row, WHITE, r.x + r.w - r.h * 0.5, r.y + r.h / 2, 'right')
      )
    })
  }

  /** 買う確認窓の文（値段つき）。値段は一覧の右端の文字（`detail`）と同じ */
  private buyMessage(e: { label: string; detail?: string } | undefined): string {
    if (!e) return '買いますか？'
    return e.detail ? `「${e.label}」を ${e.detail}で買いますか？` : `「${e.label}」を買いますか？`
  }

  /** 一覧の画像の絵。URL が無い・読めなかったときは null（文字だけで出す） */
  private imageOf(url: string | undefined): Texture | null {
    if (!url) return null
    return this.data?.images?.[url] ?? null
  }

  /** 小さな絵（中心 (cx, cy)・一辺 size に収める）。選べない行は暗く */
  private placeThumb(
    C: Container,
    tex: Texture,
    cx: number,
    cy: number,
    size: number,
    dim: boolean
  ): void {
    const sp = new Sprite(tex)
    sp.anchor.set(0.5)
    sp.scale.set(size / Math.max(tex.width, tex.height, 1))
    sp.position.set(cx, cy)
    if (dim) sp.alpha = 0.45
    sp.eventMode = 'none'
    C.addChild(sp)
  }

  private drawStatus(
    C: Container,
    nav: ScreenNav,
    sl: ScreenLayout,
    lay: MenuLayout,
    interactive: boolean,
    content: ResolvedContent
  ): void {
    const p = this.data!.party[nav.party]
    const P = sl.primary
    const f = sl.fonts.row
    this.drawPersonNav(C, sl, lay, interactive)
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
    // 定義側・実状態にある項目だけ出す（無い項目は出さない）
    for (const row of content.statusByParty[p.id] ?? []) line(`${row.label}  ${row.value}`)
    this.placeArt(this.artDeep, p.texture, P.h * 0.5, P.x + P.w * 0.8, P.y + P.h * 0.9)
  }

  private artIndex = 0

  private drawPartySlot(
    C: Container,
    p: FieldMenuPartyView,
    r: Rect,
    lay: MenuLayout,
    emphasize: boolean,
    compact: boolean,
    art: Container,
    markLabel = '選択中'
  ): void {
    this.panel(C, r, lay, emphasize)
    if (emphasize)
      C.addChild(new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: WHITE, alpha: 0.16 }))
    this.placeArt(art, p.texture, r.h * 0.86, r.x + r.h * 0.65, r.y + r.h * 0.94)
    const tx = r.x + r.h * 1.4
    const size = compact ? lay.fonts.party * 0.8 : lay.fonts.party
    const right = r.x + r.w - r.h * 0.3
    const lv = p.level === undefined ? 'Lv --' : `Lv ${p.level}`
    const hp = `HP  ${p.hp} / ${p.maxHp}`
    // 「いま選択中」の表示（矢印でなくアクスタ側に出す。戦闘と同じ見方）
    const mark = emphasize ? markLabel : null
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
  private placeArt(
    layer: Container,
    tex: Texture | null,
    height: number,
    x: number,
    y: number
  ): void {
    if (!tex) return
    const idx = this.artIndex++
    if (this.useAcrylic) {
      let fig = this.figures[idx]
      if (!fig) {
        fig = new FieldAcrylicFigure()
        this.figures[idx] = fig
      }
      fig.update(tex, height, false, x, y)
      layer.addChild(fig.display)
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
    layer.addChild(sp)
  }

  private drawBand(
    S: Container,
    st: FieldMenuState,
    lay: MenuLayout,
    data: FieldMenuOpenData
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

  /** 手の形カーソル (#744・#1067)。戦闘の手と同じ共通部品（右向き）を行の高さに合わせて拡大する。画像があれば画像、無ければドット絵 */
  private hand(x: number, cy: number, height: number): Container {
    return createHandCursor(x, cy - height / 2, height, 'right', this.data?.handTexture ?? null)
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
