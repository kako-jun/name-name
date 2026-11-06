/**
 * 一枚絵フィールドの全画面メニュー (#880) の計算部。DOM / PixiJS に触れない純粋関数だけを持つ。
 * 描画と入力の配線は `FieldMenuScreen.ts`、フィールド側の配線は `field/startFieldGame.ts`。
 *
 * 仕様の正本は sit-by-me の docs/field-ui-wireframe.md（§2-B・§3-3・§3-4・§3-5・§3-6）。
 * ここは「入れ物」だけ（項目の一覧・開閉・各項目画面の共通枠）。装備・購入などの中身は別 Issue。
 *
 * テーマ（配色）は `windowStyle.ts` が持つ色だけ。ここの寸法はすべて 16:9 基準面の比率で、テーマに依らない。
 */
import { containRect } from './battleLogicalSize'
import {
  defaultScreenKind,
  initialNav,
  MAX_PARTY_SLOTS,
  parseContentDef,
  stepScreen,
  SCREEN_KINDS,
  type FieldMenuContentDef,
  type Rect,
  type ResolvedContent,
  type ScreenCtx,
  type ScreenKind,
  type ScreenNav,
  type ScreenUse,
} from './fieldMenuScreens'
import { normalizeTransitionTiming, type MenuTransitionTiming } from './fieldMenuTransition'
import { TIME_LIMIT_AREA, formatClock } from './fieldTimeLimit'

export type { Rect }
export { formatClock }

// ---------------------------------------------------------------------------
// 項目の定義（定義側データ。増減できる）
// ---------------------------------------------------------------------------

/** メニュー項目の定義。`id` は一意。画面の種類は id で区別する（中身は別 Issue で id ごとに足す） */
export interface FieldMenuItemDef {
  id: string
  label: string
  /** false = 選べない（灰色）。既定 true */
  enabled?: boolean
  /** 選べないとき説明バーに出す理由。未指定は `DEFAULT_DISABLED_REASON` */
  disabledReason?: string
  /** true = 時間制限中は灰色にする（セーブなど） */
  blockedWhileTimed?: boolean
  /** 時間制限中に選んだときの理由。未指定は `「{label}」は時間制限中は使えません` */
  timedReason?: string
  /** 項目画面の種類。未指定は id から決まる（既定の10項目）。定義側が足した項目は未指定で `empty`（枠だけ） */
  kind?: ScreenKind
  /** 項目画面の中身（一覧・タブ・設定項目・説明）。未指定は既定（空の一覧） */
  content?: FieldMenuContentDef
}

export interface FieldMenuConfig {
  items: FieldMenuItemDef[]
  /** 画面遷移（枠スライド）の速さ。既定は `DEFAULT_MENU_TRANSITION` */
  transition: MenuTransitionTiming
  /** 場面 id → 情報帯に出す現在地の表示名。無い場面は id のまま */
  placeNames?: Record<string, string>
}

export const DEFAULT_DISABLED_REASON = 'まだ使えません'

/** 既定の10項目（wireframe §3-3 の順序。セーブの隣にロード）。設定の `menu.items` で差し替えられる */
export const DEFAULT_FIELD_MENU_ITEMS: readonly FieldMenuItemDef[] = [
  { id: 'item', label: 'どうぐ' },
  { id: 'magic', label: 'まほう' },
  { id: 'equip', label: 'そうび' },
  { id: 'appstore', label: 'アプリストア' },
  { id: 'magicite', label: 'ませき' },
  { id: 'job', label: 'ジョブ' },
  { id: 'status', label: 'ステータス' },
  {
    id: 'save',
    label: 'セーブ',
    blockedWhileTimed: true,
    timedReason: '時間制限中はセーブできません',
  },
  {
    id: 'load',
    label: 'ロード',
    blockedWhileTimed: true,
    timedReason: '時間制限中はロードできません',
  },
  { id: 'config', label: 'せってい' },
]

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `menu.placeNames`（場面 id → 表示名）の検証。不正な項目は警告して落とす。空なら undefined */
function parsePlaceNames(raw: unknown, warnings: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) {
    warnings.push('menu.placeNames はオブジェクト（場面 id → 表示名）にしてください（無視します）')
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v) out[k] = v
    else warnings.push(`menu.placeNames.${k} は空でない文字列にしてください（無視します）`)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 場面 id → 現在地の表示名（`menu.placeNames` に無ければ id のまま） */
export function placeNameOf(config: Pick<FieldMenuConfig, 'placeNames'>, sceneId: string): string {
  const n = config.placeNames
  return n && Object.prototype.hasOwnProperty.call(n, sceneId) ? n[sceneId] : sceneId
}

export interface ParsedFieldMenu {
  /** undefined = メニュー無し（設定に `menu` が無い・`false`） */
  value?: FieldMenuConfig
  warnings: string[]
}

/**
 * 設定の `menu` を検証する。未指定・`false` はメニュー無し（既存のゲームの挙動は不変）。
 * `true` / `{}` は既定の10項目。`items` を書くとその一覧に差し替わる（増減できる）。
 * 不正な項目は警告して落とす。落とした結果が空なら既定の10項目へ戻す。
 */
export function parseFieldMenuConfig(raw: unknown): ParsedFieldMenu {
  const warnings: string[] = []
  if (raw === undefined || raw === false || raw === null) return { warnings }
  const placeNames = parsePlaceNames(isObj(raw) ? raw.placeNames : undefined, warnings)
  const tr = normalizeTransitionTiming(isObj(raw) ? raw.transition : undefined)
  warnings.push(...tr.warnings)
  const defaults = (): FieldMenuConfig => ({
    items: DEFAULT_FIELD_MENU_ITEMS.map((x) => ({ ...x })),
    transition: tr.timing,
    ...(placeNames ? { placeNames } : {}),
  })
  if (raw === true) return { value: defaults(), warnings }
  if (!isObj(raw)) {
    warnings.push(`menu は true かオブジェクトにしてください: ${JSON.stringify(raw)}（無視します）`)
    return { warnings }
  }
  if (raw.items === undefined) return { value: defaults(), warnings }
  if (!Array.isArray(raw.items)) {
    warnings.push('menu.items は配列にしてください（既定の項目を使います）')
    return { value: defaults(), warnings }
  }
  const items: FieldMenuItemDef[] = []
  const seen = new Set<string>()
  raw.items.forEach((it, i) => {
    const where = `menu.items[${i}]`
    if (
      !isObj(it) ||
      typeof it.id !== 'string' ||
      !it.id ||
      typeof it.label !== 'string' ||
      !it.label
    ) {
      warnings.push(`${where} は id と label（文字列）が必要です（この項目は省きます）`)
      return
    }
    if (seen.has(it.id)) {
      warnings.push(`${where} の id "${it.id}" が重複しています（この項目は省きます）`)
      return
    }
    seen.add(it.id)
    const def: FieldMenuItemDef = { id: it.id, label: it.label }
    if (it.enabled === false) def.enabled = false
    if (typeof it.disabledReason === 'string' && it.disabledReason)
      def.disabledReason = it.disabledReason
    if (it.blockedWhileTimed === true) def.blockedWhileTimed = true
    if (typeof it.timedReason === 'string' && it.timedReason) def.timedReason = it.timedReason
    if (typeof it.kind === 'string') {
      if ((SCREEN_KINDS as readonly string[]).includes(it.kind)) def.kind = it.kind as ScreenKind
      else
        warnings.push(
          `${where}.kind は ${SCREEN_KINDS.join(' / ')} のどれかにしてください（無視します）`
        )
    }
    const content = parseContentDef(it.content, `${where}.content`, warnings)
    if (content) def.content = content
    items.push(def)
  })
  if (items.length === 0) {
    warnings.push('menu.items に有効な項目がありません（既定の項目を使います）')
    return { value: defaults(), warnings }
  }
  return {
    value: { items, transition: tr.timing, ...(placeNames ? { placeNames } : {}) },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 項目の有効判定
// ---------------------------------------------------------------------------

export interface FieldMenuItemView {
  id: string
  label: string
  enabled: boolean
  /** 選べないときの理由（有効なら null） */
  reason: string | null
}

/** 項目定義 → 表示用（有効判定済み）。時間制限中は `blockedWhileTimed` の項目が灰色になる */
export function resolveMenuItems(
  defs: readonly FieldMenuItemDef[],
  ctx: { timeLimited: boolean }
): FieldMenuItemView[] {
  return defs.map((d) => {
    if (d.enabled === false)
      return {
        id: d.id,
        label: d.label,
        enabled: false,
        reason: d.disabledReason ?? DEFAULT_DISABLED_REASON,
      }
    if (d.blockedWhileTimed && ctx.timeLimited)
      return {
        id: d.id,
        label: d.label,
        enabled: false,
        reason: d.timedReason ?? `「${d.label}」は時間制限中は使えません`,
      }
    return { id: d.id, label: d.label, enabled: true, reason: null }
  })
}

// ---------------------------------------------------------------------------
// 開閉・状態遷移
// ---------------------------------------------------------------------------

/** メニューを開けるか。会話中・イベント中・演出中・戦闘中は開けない（wireframe §3-6） */
export function canOpenMenu(ctx: {
  battle: boolean
  battleTransition: boolean
  talking: boolean
  transition: boolean
  warp: boolean
}): boolean {
  return !(ctx.battle || ctx.battleTransition || ctx.talking || ctx.transition || ctx.warp)
}

/** 最上位の画面 */
export const TOP_SCREEN = 'top'

export type FieldMenuState =
  | { open: false }
  | {
      open: true
      /** 'top' = 項目窓。それ以外 = 開いている項目の id */
      screen: string
      /** 項目窓のカーソル位置（項目画面から戻っても保つ） */
      cursor: number
      /** 説明バー・案内に出す通知（選べない項目を決定したとき等）。操作で消える */
      notice: string | null
      /** 項目画面の中の選択状態（最上位は null） */
      nav: ScreenNav | null
      /** せっていの選択値（key → 選択肢 index）。メニューを閉じても保つ（呼び出し側が持ち越す） */
      settings: Record<string, number>
    }

export const CLOSED_MENU: FieldMenuState = { open: false }

export function openMenuState(settings: Record<string, number> = {}): FieldMenuState {
  return { open: true, screen: TOP_SCREEN, cursor: 0, notice: null, nav: null, settings }
}

export type FieldMenuEvent =
  /** カーソルを動かす（dy = 上下、dx = 左右。最上位は dy だけ。端で回り込む） */
  | { type: 'move'; dx: number; dy: number }
  /** 項目の行を1タップ（カーソルを移して決定） */
  | { type: 'tap'; index: number }
  /** 項目画面の中の1タップ決定 */
  | {
      type: 'select'
      target: 'tab' | 'party' | 'list' | 'confirm' | 'prev' | 'next'
      index: number
    }
  /** 決定キー */
  | { type: 'confirm' }
  /** 戻る（キー・右クリック・「◀戻る」）。1階層ずつ。最上位ならメニューを閉じる */
  | { type: 'back' }

/** 遷移で起きたこと（呼び出し側が音・配線に使う） */
export type FieldMenuEffect =
  | 'none'
  | 'moved'
  | 'opened-screen'
  | 'back-to-top'
  | 'closed'
  | 'refused'
  | 'notice'
  | 'save'
  /** セーブ済みのスロットを読み込む要求（呼び出し側がフィールドを作り直す） */
  | 'load'
  | 'setting'
  /** どうぐ・まほうを使う要求（呼び出し側が実状態に適用する） */
  | 'use'
  /** せいとん（並べ替え）の要求 */
  | 'sort'

export interface FieldMenuStep {
  state: FieldMenuState
  effect: FieldMenuEffect
  /** effect = 'save' のスロット index */
  save?: number
  /** effect = 'load' のスロット index */
  load?: number
  /** effect = 'setting' の変更 */
  setting?: { key: string; value: number }
  /** effect = 'use' / 'sort' の要求 */
  use?: ScreenUse
}

/** 遷移の入力（開いているメニューの外から決まる値） */
export interface FieldMenuCtx {
  items: readonly FieldMenuItemView[]
  /** 項目 id → 画面の中身 */
  contents: Readonly<Record<string, ResolvedContent>>
  partyCount: number
  /** 人物の id（表示順）。省略は空 */
  partyIds?: readonly string[]
  slotFilled: readonly boolean[]
}

/** 項目定義 → 画面の種類 */
export function screenKindOfItem(d: FieldMenuItemDef): ScreenKind {
  return d.kind ?? defaultScreenKind(d.id)
}

/** 1つの入力に対する状態遷移（純粋）。閉じているときは何も起きない */
export function stepFieldMenu(
  state: FieldMenuState,
  ev: FieldMenuEvent,
  ctx: FieldMenuCtx
): FieldMenuStep {
  if (!state.open) return { state, effect: 'none' }
  const items = ctx.items
  if (state.screen !== TOP_SCREEN) {
    const content = ctx.contents[state.screen]
    const nav = state.nav
    if (!content || !nav) {
      // 中身が無い（未知の画面）: 戻るだけ受ける
      return ev.type === 'back'
        ? {
            state: { ...state, screen: TOP_SCREEN, nav: null, notice: null },
            effect: 'back-to-top',
          }
        : { state, effect: 'none' }
    }
    const sctx: ScreenCtx = {
      content,
      partyCount: Math.min(ctx.partyCount, MAX_PARTY_SLOTS),
      partyIds: ctx.partyIds,
      slotFilled: ctx.slotFilled,
      settings: state.settings,
    }
    const sev =
      ev.type === 'tap' ? ({ type: 'select', target: 'list', index: ev.index } as const) : ev
    const r = stepScreen(nav, sev as Parameters<typeof stepScreen>[1], sctx)
    if (r.effect === 'back-to-top')
      return {
        state: { ...state, screen: TOP_SCREEN, nav: null, notice: null },
        effect: 'back-to-top',
      }
    const settings =
      r.effect === 'setting' && r.setting
        ? { ...state.settings, [r.setting.key]: r.setting.value }
        : state.settings
    const next: FieldMenuState = { ...state, nav: r.nav, notice: r.notice ?? null, settings }
    const out: FieldMenuStep = {
      state: next,
      effect: r.effect === 'notice' ? 'notice' : r.effect,
    }
    if (r.save !== undefined) out.save = r.save
    if (r.load !== undefined) out.load = r.load
    if (r.setting) out.setting = r.setting
    if (r.use) out.use = r.use
    return out
  }
  if (ev.type === 'back') return { state: CLOSED_MENU, effect: 'closed' }
  const n = items.length
  if (n === 0) return { state, effect: 'none' }
  if (ev.type === 'move') {
    if (ev.dy === 0) return { state, effect: 'none' }
    const d = ev.dy < 0 ? -1 : 1
    const cursor = (((state.cursor + d) % n) + n) % n
    return { state: { ...state, cursor, notice: null }, effect: 'moved' }
  }
  if (ev.type === 'select') return { state, effect: 'none' }
  let cursor = state.cursor
  if (ev.type === 'tap') {
    if (!Number.isInteger(ev.index) || ev.index < 0 || ev.index >= n)
      return { state, effect: 'none' }
    cursor = ev.index
  }
  const item = items[cursor]
  if (!item.enabled)
    return {
      state: { ...state, cursor, notice: item.reason ?? DEFAULT_DISABLED_REASON },
      effect: 'refused',
    }
  const kind = ctx.contents[item.id]?.kind ?? 'empty'
  return {
    state: { ...state, cursor, screen: item.id, notice: null, nav: initialNav(kind) },
    effect: 'opened-screen',
  }
}

// ---------------------------------------------------------------------------
// キー
// ---------------------------------------------------------------------------

/** フィールドからメニューを開くキー（Esc / X / M）。修飾キー付き・リピートは別扱い（呼び出し側で除外する） */
export const MENU_OPEN_KEYS: readonly string[] = ['Escape', 'KeyX', 'KeyM']

export function isMenuOpenKey(code: string): boolean {
  return MENU_OPEN_KEYS.includes(code)
}

/**
 * キー割当（PC）の選択肢。`せってい` の `keys`（選択肢 index）。0 = Z 決定・X 戻る（既定）、1 = X 決定・Z 戻る。
 * Enter / Space は決定、Esc は戻るで固定。メニュー内だけに効く（フィールドの会話送り・戦闘は未接続）
 */
export const KEY_SCHEME_SWAPPED = 1

/** メニュー内のキー → 入力。M は開く専用なのでメニュー内では無効。対象外のキーは null。`keyScheme` はせっていの `keys` の値 */
export function menuKeyEvent(code: string, keyScheme = 0): FieldMenuEvent | null {
  const swapped = keyScheme === KEY_SCHEME_SWAPPED
  if (code === 'KeyZ') return swapped ? { type: 'back' } : { type: 'confirm' }
  if (code === 'KeyX') return swapped ? { type: 'confirm' } : { type: 'back' }
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return { type: 'move', dx: 0, dy: -1 }
    case 'ArrowDown':
    case 'KeyS':
      return { type: 'move', dx: 0, dy: 1 }
    case 'ArrowLeft':
    case 'KeyA':
      return { type: 'move', dx: -1, dy: 0 }
    case 'ArrowRight':
    case 'KeyD':
      return { type: 'move', dx: 1, dy: 0 }
    case 'Enter':
    case 'Space':
      return { type: 'confirm' }
    case 'Escape':
      return { type: 'back' }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 文字（案内・情報帯）
// ---------------------------------------------------------------------------

/** 操作の案内（常に画面下端に出す。暗黙の操作を作らない） */
export const MENU_HINT_TOP = '決定: Z / Enter / タップ　戻る(閉じる): X / Esc / 右クリック / ◀戻る'
export const MENU_HINT_SCREEN =
  '選ぶ: 矢印 / タップ　決定: Z / Enter　戻る: X / Esc / 右クリック / ◀戻る'
/** キー割当を入れ替えたとき（`KEY_SCHEME_SWAPPED`）の案内 */
export const MENU_HINT_TOP_SWAPPED =
  '決定: X / Enter / タップ　戻る(閉じる): Z / Esc / 右クリック / ◀戻る'
export const MENU_HINT_SCREEN_SWAPPED =
  '選ぶ: 矢印 / タップ　決定: X / Enter　戻る: Z / Esc / 右クリック / ◀戻る'
export const MENU_BACK_LABEL = '◀戻る'
/** 項目画面の一覧が空のとき枠の中に出す文言 */
export const MENU_EMPTY_BODY = 'なにもありません'

export function menuHint(state: FieldMenuState): string {
  const swapped = state.open && state.settings.keys === KEY_SCHEME_SWAPPED
  const inScreen = state.open && state.screen !== TOP_SCREEN
  if (swapped) return inScreen ? MENU_HINT_SCREEN_SWAPPED : MENU_HINT_TOP_SWAPPED
  return inScreen ? MENU_HINT_SCREEN : MENU_HINT_TOP
}

export interface FieldMenuInfo {
  /** 現在地の名前 */
  place: string
  /** 所持金（円） */
  gold: number
  /** プレイ時間(ms)。メニュー中・戦闘中も常に進む */
  playMs: number
  /** 歩数（`fieldPlayStats.ts` の定義）。歩行時のみ加算（メニュー中・戦闘中は加算しない） */
  steps: number
}

/**
 * 情報帯の文字: 現在地・円・プレイ時間・歩数。常にプレイ時間を出す（残り時間とは入れ替えない。
 * 制限時間の残りは別の最前面レイヤー `TimeLimitLayer`）
 */
export function formatInfoBand(info: FieldMenuInfo): string {
  const num = (v: number): string =>
    Math.max(0, Math.floor(Number.isFinite(v) ? v : 0)).toLocaleString('en-US')
  return `現在地 ${info.place}  |  円 ${num(info.gold)}  |  時間 ${formatClock(info.playMs)}  |  歩数 ${num(info.steps)}`
}

// ---------------------------------------------------------------------------
// レイアウト（最上位。16:9 基準面の比率。テーマに依らず共通）
// ---------------------------------------------------------------------------

/** 基準面の比率（wireframe §2-B-1） */
export const MENU_LAYOUT = {
  /** 上端・左右の余白 */
  marginTop: 0.02,
  marginX: 0.02,
  /** 両列の下端（%H） */
  columnBottom: 0.9,
  party: { x: 0.02, w: 0.62, slotH: 0.215, gap: 0.006 },
  items: { x: 0.72, w: 0.26, rowH: 0.093, padY: 0.02 },
  band: { y: 0.91, h: 0.08 },
  back: { x: 0.02, w: 0.14 },
  /** ≡ ボタン（フィールド面の右上隅） */
  menuButton: { side: 0.08, margin: 0.02, minCssPx: 24 },
  /** 文字の大きさ（%H） */
  font: { row: 0.04, party: 0.036, band: 0.03, hint: 0.028 },
} as const

export interface MenuLayout {
  /** 基準面（画面全体に contain で収めた 16:9） */
  base: Rect
  partySlots: Rect[]
  itemWindow: Rect
  itemRows: Rect[]
  /** 情報帯・操作の案内の領域（「◀戻る」の右） */
  band: Rect
  backButton: Rect
  /** 文字の大きさ (px) */
  fonts: { row: number; party: number; band: number; hint: number }
}

/**
 * 画面（キャンバス）の大きさ・項目数・パーティ人数 → 全画面メニューの配置。
 * 16:9 の基準面を画面へ等比 contain で収めたものの比率で決める（crop しない）。背景は呼び出し側が画面全体に敷く。
 * 項目が9個を超えるときは行高を縮めて窓に収める。`reserveTimer` のとき、左上の残り時間の予約領域
 * （`TIME_LIMIT_AREA`）に左のパーティ枠がかからないよう、左の列の上端を下げる。
 */
export function computeMenuLayout(
  canvasW: number,
  canvasH: number,
  itemCount: number,
  partyCount: number,
  reserveTimer = false
): MenuLayout {
  const c = containRect(canvasW, canvasH)
  const base: Rect = { x: c.x, y: c.y, w: c.w, h: c.h }
  const W = base.w
  const H = base.h
  const L = MENU_LAYOUT
  const colTop = L.marginTop * H
  const colH = L.columnBottom * H - colTop
  const partyTop = reserveTimer ? (TIME_LIMIT_AREA.y + TIME_LIMIT_AREA.h + 0.01) * H : colTop
  const partyH = L.columnBottom * H - partyTop
  const n = Math.max(1, Math.floor(partyCount))
  const slots = Math.max(1, Math.min(n, MAX_PARTY_SLOTS))
  const gap = L.party.gap * H
  const slotH = Math.min(L.party.slotH * H, (partyH - gap * (slots - 1)) / slots)
  const partySlots: Rect[] = []
  for (let i = 0; i < Math.min(n, MAX_PARTY_SLOTS); i++)
    partySlots.push({
      x: base.x + L.party.x * W,
      y: base.y + partyTop + i * (slotH + gap),
      w: L.party.w * W,
      h: slotH,
    })
  const itemWindow: Rect = {
    x: base.x + L.items.x * W,
    y: base.y + colTop,
    w: L.items.w * W,
    h: colH,
  }
  const rows = Math.max(1, Math.floor(itemCount))
  const pad = L.items.padY * H
  const rowH = Math.min(L.items.rowH * H, (colH - pad * 2) / rows)
  const itemRows: Rect[] = []
  for (let i = 0; i < Math.floor(itemCount); i++)
    itemRows.push({ x: itemWindow.x, y: itemWindow.y + pad + i * rowH, w: itemWindow.w, h: rowH })
  const backW = L.back.w * W
  const backButton: Rect = {
    x: base.x + L.back.x * W,
    y: base.y + L.band.y * H,
    w: backW,
    h: L.band.h * H,
  }
  const bandX = backButton.x + backW + 0.01 * W
  const band: Rect = {
    x: bandX,
    y: backButton.y,
    w: base.x + (1 - L.marginX) * W - bandX,
    h: backButton.h,
  }
  return {
    base,
    partySlots,
    itemWindow,
    itemRows,
    band,
    backButton,
    fonts: {
      row: L.font.row * H,
      party: L.font.party * H,
      band: L.font.band * H,
      hint: L.font.hint * H,
    },
  }
}

/**
 * フィールド面の右上隅の ≡ ボタンの矩形。一辺 8%H かつ表示上 24 css px 以上。
 * `cssScale` = 画面上の表示倍率（canvas の CSS 幅 / 論理幅）。0 以下・非有限は 1 とみなす。
 */
export function computeMenuButtonRect(faceW: number, faceH: number, cssScale: number): Rect {
  const L = MENU_LAYOUT.menuButton
  const scale = Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1
  const side = Math.max(L.side * faceH, L.minCssPx / scale)
  const margin = L.margin * faceH
  return { x: faceW - side - margin, y: margin, w: side, h: side }
}

export function pointInRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

/** 点 → 行 index（窓の幅いっぱいが押せる）。どの行でもなければ -1 */
export function itemRowAt(rows: readonly Rect[], x: number, y: number): number {
  return rows.findIndex((r) => pointInRect(r, x, y))
}
