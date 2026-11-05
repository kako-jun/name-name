/**
 * 全画面メニューの各項目画面 (#880 / wireframe §3-5)。DOM / PixiJS に触れない純粋関数だけを持つ。
 * 画面の種類（どうぐ / 人物→一覧 / アプリストア / ステータス / セーブ / せってい）ごとの
 * 窓の配置・フォーカス移動・選択/戻る の状態遷移と、定義側から差し込む中身（content）の型・既定値。
 *
 * 中身のデータ（所持品・魔法・装備・商品など）は定義側（設定の `menu.items[].content`）から差し込む。
 * 装備の持ち替え・購入・使用の実処理はここには無い（選んだ結果は説明バーの通知として返すだけ）。
 * 寸法は 16:9 基準面の比率でテーマに依らない。
 */

import { TIME_LIMIT_AREA } from './fieldTimeLimit'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type ScreenKind =
  | 'item'
  | 'party-list'
  | 'equip'
  | 'appstore'
  | 'status'
  | 'save'
  | 'config'
  | 'empty'

export const SCREEN_KINDS: readonly ScreenKind[] = [
  'item',
  'party-list',
  'equip',
  'appstore',
  'status',
  'save',
  'config',
  'empty',
]

/** アプリストアのどれかのタブが人物別の一覧（`entriesByParty`。空オブジェクトは「無い」）を持つか。持つときだけ人物の切り替え（帯・上下キー・案内）を出す */
export function appstoreHasParty(content: Pick<ResolvedContent, 'tabs'>): boolean {
  return content.tabs.some((t) => Object.keys(t.entriesByParty ?? {}).length > 0)
}

/** 既定の項目 id → 画面の種類。それ以外の id（定義側が足した項目）は `empty`（`kind` で指定できる） */
export function defaultScreenKind(id: string): ScreenKind {
  switch (id) {
    case 'item':
      return 'item'
    case 'magic':
    case 'magicite':
    case 'job':
      return 'party-list'
    case 'equip':
      return 'equip'
    case 'appstore':
      return 'appstore'
    case 'status':
      return 'status'
    case 'save':
      return 'save'
    case 'config':
      return 'config'
    default:
      return 'empty'
  }
}

// ---------------------------------------------------------------------------
// 中身（定義側から差し込む）
// ---------------------------------------------------------------------------

export interface MenuEntry {
  label: string
  /** 右端に出す補足（所持数・値段など） */
  detail?: string
  /** false = 暗く表示して選べない */
  enabled?: boolean
  /** 説明バーに出す文 */
  description?: string
  /** 実行時の元データへの対応（所持品・魔法・店の品の id）。使う処理（`onUse`）へ渡る */
  id?: string
  /** 一覧に小さく出す画像の URL（アプリストアの品）。省略・読み込み失敗は文字だけ */
  image?: string
  /**
   * 使うときの対象の取り方。`single` = 左のパーティから1人選ぶ / `all` = 全員（選ばない）/ `self` = 使い手本人（選ばない）。
   * 未指定は従来どおり（まほう等では選んでも説明バーの通知だけ。どうぐの「つかう」は `single`）
   */
  target?: 'single' | 'all' | 'self'
}
/** タブの働き。`use` = 選んで使う / `sort` = 選ぶと並べ替える / `info` = 一覧と説明バーだけ（使用・整理不可）。未指定のどうぐは先頭を `use`、他は通知だけ */
/** `sell` はアプリストアの「売る」タブ（確認窓の文と選択肢が「売る」になる）。アプリストア専用で、設定 JSON からは書けない（差し込みの中身だけが持つ） */
export type MenuTabAction = 'use' | 'sort' | 'info' | 'sell'
export interface MenuTab {
  label: string
  entries: MenuEntry[]
  action?: MenuTabAction
  /** 人物ごとの一覧（人物の id → entries）。アプリストアの刀のように、タブの中身が選んだ人物で変わるとき。無い人物は `entries` */
  entriesByParty?: Record<string, MenuEntry[]>
}
/** ステータス画面に足す1行（固有素質など、定義側が人物ごとに差し込む） */
export interface StatusRow {
  label: string
  value: string
}
export interface MenuOption {
  key: string
  label: string
  choices: string[]
  /** 初期の選択肢 index（既定 0） */
  initial?: number
  /** その行にカーソルがあるとき説明バーに出す文（効く範囲・未接続の注記など） */
  description?: string
}
export interface FieldMenuContentDef {
  description?: string
  tabs?: MenuTab[]
  entries?: MenuEntry[]
  /** 人物ごとの一覧（人物の id → entries）。人物を選ぶ画面（まほう・そうび等）で、選んだ人物のものを出す。無い人物は `entries` */
  entriesByParty?: Record<string, MenuEntry[]>
  options?: MenuOption[]
  /** 人物ごとのステータス画面の追加行（人物の id → 行）。無い項目は出さない */
  statusByParty?: Record<string, StatusRow[]>
  /** そうび画面の見出し行（人物の id → 行。2 枠の現在の装備）。実状態から作る値で、定義 JSON には書かない */
  headerByParty?: Record<string, StatusRow[]>
}

export interface ResolvedContent {
  kind: ScreenKind
  description: string
  tabs: MenuTab[]
  entries: MenuEntry[]
  entriesByParty: Record<string, MenuEntry[]>
  options: MenuOption[]
  statusByParty: Record<string, StatusRow[]>
  headerByParty: Record<string, StatusRow[]>
}

/** 「せってい」の既定項目（wireframe §3-5。ウィンドウ色は固定なので無い）。値の実効化は呼び出し側 */
export const DEFAULT_CONFIG_OPTIONS: readonly MenuOption[] = [
  { key: 'battleMode', label: 'バトルモード', choices: ['ウェイト', 'アクティブ'] },
  { key: 'battleSpeed', label: 'バトルスピード', choices: ['1', '2', '3', '4', '5'], initial: 2 },
  {
    key: 'messageSpeed',
    label: 'メッセージスピード',
    choices: ['1', '2', '3', '4', '5'],
    initial: 2,
  },
  { key: 'cursor', label: 'カーソル', choices: ['メモリ', 'リセット'] },
  { key: 'bgm', label: 'BGM音量', choices: ['0', '1', '2', '3', '4', '5'], initial: 4 },
  { key: 'se', label: 'SE音量', choices: ['0', '1', '2', '3', '4', '5'], initial: 4 },
  { key: 'keys', label: 'キー割当（PC）', choices: ['Z決定 X戻る', 'X決定 Z戻る'] },
]

export const SAVE_SLOT_COUNT = 3

/** 画面に並べる人物の枠の最大数（wireframe: 4人配置固定）。それ以上は選択も表示も先頭からここまで */
export const MAX_PARTY_SLOTS = 4

/** 人物別の一覧を持つアプリストアの既定の説明（人物の切り替えの案内を常に出す） */
const APPSTORE_PARTY_DESCRIPTION = 'アプリを選んでください（上下 / ◀前・次▶: 人物の切り替え）'

const DEFAULT_DESCRIPTION: Record<ScreenKind, string> = {
  item: 'つかう・せいとん・たいせつなもの から選びます',
  'party-list': '人物を選んでください',
  equip: 'そうびを変える人物を選んでください',
  appstore: 'アプリを選んでください',
  status: '人物ごとの能力を見ます',
  save: 'セーブするスロットを選んでください',
  config: '設定を変えます',
  empty: '',
}

/** 定義側の content に既定値を重ねて、その画面の中身にする */
export function resolveContent(
  label: string,
  kind: ScreenKind,
  def: FieldMenuContentDef | undefined
): ResolvedContent {
  let tabs = def?.tabs
  if (!tabs || tabs.length === 0) {
    if (kind === 'item')
      tabs = [
        { label: 'つかう', entries: [], action: 'use' },
        { label: 'せいとん', entries: [], action: 'sort' },
        { label: 'たいせつなもの', entries: [], action: 'info' },
      ]
    else if (kind === 'appstore')
      tabs = [
        { label: '刀', entries: [] },
        { label: '防具', entries: [] },
      ]
    else tabs = []
  }
  const options =
    def?.options && def.options.length > 0
      ? def.options
      : kind === 'config'
        ? DEFAULT_CONFIG_OPTIONS.map((o) => ({ ...o, choices: [...o.choices] }))
        : []
  return {
    kind,
    description:
      def?.description ??
      (kind === 'appstore' && appstoreHasParty({ tabs })
        ? APPSTORE_PARTY_DESCRIPTION
        : DEFAULT_DESCRIPTION[kind] || label),
    tabs,
    entries: def?.entries ?? [],
    entriesByParty: def?.entriesByParty ?? {},
    options,
    statusByParty: def?.statusByParty ?? {},
    headerByParty: def?.headerByParty ?? {},
  }
}

/** 設定の content の検証。不正な部分は警告して落とす */
export function parseContentDef(
  raw: unknown,
  where: string,
  warnings: string[]
): FieldMenuContentDef | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`${where} はオブジェクトにしてください（無視します）`)
    return undefined
  }
  const o = raw as Record<string, unknown>
  const out: FieldMenuContentDef = {}
  if (typeof o.description === 'string') out.description = o.description
  const entries = (v: unknown, w: string): MenuEntry[] => {
    if (!Array.isArray(v)) {
      warnings.push(`${w} は配列にしてください（無視します）`)
      return []
    }
    const list: MenuEntry[] = []
    v.forEach((e, i) => {
      if (typeof e !== 'object' || e === null || typeof (e as MenuEntry).label !== 'string') {
        warnings.push(`${w}[${i}] は label（文字列）が必要です（省きます）`)
        return
      }
      const x = e as Record<string, unknown>
      const entry: MenuEntry = { label: x.label as string }
      if (typeof x.detail === 'string') entry.detail = x.detail
      if (x.enabled === false) entry.enabled = false
      if (typeof x.description === 'string') entry.description = x.description
      if (typeof x.id === 'string') entry.id = x.id
      if (typeof x.image === 'string' && x.image) entry.image = x.image
      if (x.target === 'single' || x.target === 'all' || x.target === 'self')
        entry.target = x.target
      list.push(entry)
    })
    return list
  }
  if (o.entries !== undefined) out.entries = entries(o.entries, `${where}.entries`)
  if (o.entriesByParty !== undefined) {
    const v = o.entriesByParty
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      warnings.push(
        `${where}.entriesByParty はオブジェクト（人物 id → entries）にしてください（無視します）`
      )
    else {
      const by: Record<string, MenuEntry[]> = Object.create(null) as Record<string, MenuEntry[]>
      for (const [k, list] of Object.entries(v))
        by[k] = entries(list, `${where}.entriesByParty.${k}`)
      out.entriesByParty = { ...by }
    }
  }
  if (o.statusByParty !== undefined) {
    const v = o.statusByParty
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      warnings.push(
        `${where}.statusByParty はオブジェクト（人物 id → 行の配列）にしてください（無視します）`
      )
    else {
      const by: Record<string, StatusRow[]> = Object.create(null) as Record<string, StatusRow[]>
      for (const [k, list] of Object.entries(v)) {
        if (!Array.isArray(list)) {
          warnings.push(`${where}.statusByParty.${k} は配列にしてください（無視します）`)
          continue
        }
        const rows: StatusRow[] = []
        list.forEach((r, i) => {
          const x = r as Record<string, unknown> | null
          if (
            !x ||
            typeof x !== 'object' ||
            typeof x.label !== 'string' ||
            typeof x.value !== 'string'
          )
            warnings.push(
              `${where}.statusByParty.${k}[${i}] は label・value（文字列）が必要です（省きます）`
            )
          else rows.push({ label: x.label, value: x.value })
        })
        by[k] = rows
      }
      out.statusByParty = { ...by }
    }
  }
  if (o.tabs !== undefined) {
    if (!Array.isArray(o.tabs)) warnings.push(`${where}.tabs は配列にしてください（無視します）`)
    else {
      const tabs: MenuTab[] = []
      o.tabs.forEach((t, i) => {
        const x = t as Record<string, unknown> | null
        if (!x || typeof x !== 'object' || typeof x.label !== 'string') {
          warnings.push(`${where}.tabs[${i}] は label（文字列）が必要です（省きます）`)
          return
        }
        const tab: MenuTab = {
          label: x.label,
          entries: x.entries === undefined ? [] : entries(x.entries, `${where}.tabs[${i}].entries`),
        }
        if (x.action === 'use' || x.action === 'sort' || x.action === 'info') tab.action = x.action
        tabs.push(tab)
      })
      out.tabs = tabs
    }
  }
  if (o.options !== undefined) {
    if (!Array.isArray(o.options))
      warnings.push(`${where}.options は配列にしてください（無視します）`)
    else {
      const options: MenuOption[] = []
      o.options.forEach((t, i) => {
        const x = t as Record<string, unknown> | null
        if (
          !x ||
          typeof x !== 'object' ||
          typeof x.key !== 'string' ||
          typeof x.label !== 'string' ||
          !Array.isArray(x.choices) ||
          x.choices.length === 0 ||
          !x.choices.every((c) => typeof c === 'string')
        ) {
          warnings.push(
            `${where}.options[${i}] は key・label・choices（文字列の配列）が必要です（省きます）`
          )
          return
        }
        const opt: MenuOption = { key: x.key, label: x.label, choices: x.choices as string[] }
        if (typeof x.description === 'string') opt.description = x.description
        if (
          typeof x.initial === 'number' &&
          Number.isInteger(x.initial) &&
          x.initial >= 0 &&
          x.initial < opt.choices.length
        )
          opt.initial = x.initial
        options.push(opt)
      })
      out.options = options
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// フォーカスと状態遷移
// ---------------------------------------------------------------------------

export type NavFocus = 'tab' | 'party' | 'list' | 'target' | 'confirm'

export interface ScreenNav {
  focus: NavFocus
  tab: number
  party: number
  list: number
  /** 使う対象（左のパーティの index）。`target` フォーカスで動く */
  target: number
  /** 確認窓の選択（0 = はい/買う、1 = いいえ/やめる） */
  confirm: number
  /** 確認窓を開いた元のフォーカス（戻ると・閉じるとここへ） */
  confirmFrom: 'list'
}

/** 画面を開いたときの最初のフォーカス（＝戻るでメニュー最上位へ戻る階層） */
export function baseFocus(kind: ScreenKind): NavFocus {
  switch (kind) {
    case 'item':
    case 'appstore':
      return 'tab'
    case 'party-list':
    case 'equip':
    case 'status':
      return 'party'
    default:
      return 'list'
  }
}

export function initialNav(kind: ScreenKind): ScreenNav {
  return {
    focus: baseFocus(kind),
    tab: 0,
    party: 0,
    list: 0,
    target: 0,
    confirm: 0,
    confirmFrom: 'list',
  }
}

export type ScreenEvent =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'confirm' }
  | { type: 'back' }
  /** 1タップ決定（対象の窓と行） */
  | {
      type: 'select'
      target: 'tab' | 'party' | 'list' | 'confirm' | 'prev' | 'next'
      index: number
    }

export interface ScreenCtx {
  content: ResolvedContent
  partyCount: number
  /** 人物の id（表示順）。`entriesByParty` を引くのに使う。省略は空 */
  partyIds?: readonly string[]
  /** セーブスロットごとに既存のデータがあるか（上書き確認の判定） */
  slotFilled: readonly boolean[]
  /** せっていの選択値（key → 選択肢 index）。無ければ initial */
  settings: Readonly<Record<string, number>>
}

export type ScreenEffect =
  | 'none'
  | 'moved'
  | 'back-to-top'
  | 'notice'
  | 'save'
  | 'setting'
  | 'use'
  | 'sort'

/** 「使う」の要求（どうぐ・まほう）。`caster` は使い手の party index（どうぐは -1）、`target` は左のパーティの index（全体・本人は undefined） */
export interface ScreenUse {
  tab: number
  list: number
  caster: number
  target?: number
}

export interface ScreenStep {
  nav: ScreenNav
  effect: ScreenEffect
  /** 説明バーの通知。undefined = 通知を消す */
  notice?: string
  save?: number
  setting?: { key: string; value: number }
  use?: ScreenUse
}

const wrap = (i: number, n: number): number => (n <= 0 ? 0 : ((i % n) + n) % n)

/** その画面で現在の一覧の行（item / appstore はタブの中身、party-list・empty は entries） */
export function listEntries(ctx: ScreenCtx, nav: ScreenNav): MenuEntry[] {
  return entriesAt(ctx.content, ctx.partyIds, nav.tab, nav.party)
}

/** 一覧の行（タブと人物の位置から）。アプリストアはタブの人物別の一覧（`MenuTab.entriesByParty`）、人物を選ぶ画面は `entriesByParty` を引く */
function entriesAt(
  c: ResolvedContent,
  partyIds: readonly string[] | undefined,
  tab: number,
  party: number
): MenuEntry[] {
  const id = partyIds?.[party]
  const has = (o: Record<string, MenuEntry[]> | undefined): o is Record<string, MenuEntry[]> =>
    id !== undefined && o !== undefined && Object.prototype.hasOwnProperty.call(o, id)
  if (c.kind === 'item' || c.kind === 'appstore') {
    const t = c.tabs[tab]
    if (c.kind === 'appstore' && has(t?.entriesByParty)) return t.entriesByParty[id as string]
    return t?.entries ?? []
  }
  if ((c.kind === 'party-list' || c.kind === 'equip') && has(c.entriesByParty))
    return c.entriesByParty[id as string]
  return c.entries
}

export function listCount(ctx: ScreenCtx, nav: ScreenNav): number {
  const k = ctx.content.kind
  if (k === 'save') return SAVE_SLOT_COUNT
  if (k === 'config') return ctx.content.options.length
  return listEntries(ctx, nav).length
}

export function optionValue(ctx: ScreenCtx, o: MenuOption): number {
  const v = ctx.settings[o.key]
  return typeof v === 'number' && v >= 0 && v < o.choices.length ? v : (o.initial ?? 0)
}

const NOTHING = 'なにもありません'

/** アプリストアの「売る」タブか（確認窓の文・選択肢が「売る」になる） */
export function isSellTab(c: Pick<ResolvedContent, 'kind' | 'tabs'>, tab: number): boolean {
  return c.kind === 'appstore' && c.tabs[tab]?.action === 'sell'
}

/** 確認窓の選択肢（0 = 実行・1 = やめる／いいえ。既定の位置は呼び出し側で「やめる」に置く） */
export function confirmChoices(kind: ScreenKind, selling: boolean): [string, string] {
  if (kind === 'save') return ['はい', 'いいえ']
  return [selling ? '売る' : '買う', 'やめる']
}

/** 買う・売る確認窓の文（値段つき）。値段は一覧の右端の文字（`detail`）と同じ */
export function buyConfirmMessage(
  e: { label: string; detail?: string } | undefined,
  selling = false
): string {
  const verb = selling ? '売りますか？' : '買いますか？'
  if (!e) return verb
  if (selling)
    return e.detail ? `「${e.label}」を ${e.detail}で ${verb}` : `「${e.label}」を ${verb}`
  return e.detail ? `「${e.label}」を ${e.detail}で買いますか？` : `「${e.label}」を買いますか？`
}

/** そのタブの働き。定義が `action` を書かなければ、どうぐの先頭タブだけ `use`（従来どおり）。それ以外は undefined */
export function tabAction(c: ResolvedContent, tab: number): MenuTabAction | undefined {
  if (c.kind !== 'item') return undefined
  return c.tabs[tab]?.action ?? (tab === 0 ? 'use' : undefined)
}

function decideConfirm(ctx: ScreenCtx, nav: ScreenNav): ScreenStep {
  const k = ctx.content.kind
  const n = nav
  if (n.focus === 'tab') {
    if (ctx.content.tabs.length === 0) return { nav: n, effect: 'none' }
    const toList: ScreenNav = { ...n, focus: 'list', list: 0 }
    // 「せいとん」は選んだ時点で並べ替える（結果の一覧がそのまま下に見える）
    if (tabAction(ctx.content, n.tab) === 'sort')
      return { nav: toList, effect: 'sort', use: { tab: n.tab, list: 0, caster: -1 } }
    return { nav: toList, effect: 'moved', notice: undefined }
  }
  if (n.focus === 'party') {
    if (k === 'status' || ctx.partyCount === 0) return { nav: n, effect: 'none' }
    return { nav: { ...n, focus: 'list', list: 0 }, effect: 'moved' }
  }
  if (n.focus === 'target') {
    if (ctx.partyCount === 0) return { nav: n, effect: 'none' }
    const target = Math.min(Math.max(n.target, 0), ctx.partyCount - 1)
    return {
      nav: { ...n, focus: 'list' },
      effect: 'use',
      use: { tab: n.tab, list: n.list, caster: k === 'item' ? -1 : n.party, target },
    }
  }
  if (n.focus === 'list') {
    if (k === 'config') {
      const o = ctx.content.options[n.list]
      if (!o) return { nav: n, effect: 'none' }
      const value = wrap(optionValue(ctx, o) + 1, o.choices.length)
      return { nav: n, effect: 'setting', setting: { key: o.key, value } }
    }
    if (k === 'save') {
      if (ctx.slotFilled[n.list])
        return { nav: { ...n, focus: 'confirm', confirm: 1 }, effect: 'moved' }
      return {
        nav: n,
        effect: 'save',
        save: n.list,
        notice: `スロット${n.list + 1}にセーブしました`,
      }
    }
    const e = listEntries(ctx, n)[n.list]
    if (!e) return { nav: n, effect: 'notice', notice: NOTHING }
    if (e.enabled === false)
      return { nav: n, effect: 'notice', notice: e.description ?? 'いまは選べません' }
    // 買う確認の既定は「やめる」（誤タップで買わない）
    if (k === 'appstore') return { nav: { ...n, focus: 'confirm', confirm: 1 }, effect: 'moved' }
    // そうび: 選んだ人物の品へ持ち替える（確認なし。防具は装備中を選ぶと外す）。使い手 = 選んだ人物
    if (k === 'equip')
      return { nav: n, effect: 'use', use: { tab: n.tab, list: n.list, caster: n.party } }
    const kind = k === 'item' ? tabAction(ctx.content, n.tab) : undefined
    // 使い手は、どうぐは居ない（-1）、まほうは選んだ人物
    const caster = k === 'item' ? -1 : n.party
    const scope: MenuEntry['target'] =
      k === 'item' ? (kind === 'use' ? (e.target ?? 'single') : undefined) : e.target
    if (scope === 'single' && ctx.partyCount > 0)
      return {
        nav: { ...n, focus: 'target', target: k === 'item' ? 0 : Math.max(0, n.party) },
        effect: 'moved',
        notice: '使う相手を選んでください',
      }
    if (scope === 'all' || scope === 'self')
      return {
        nav: n,
        effect: 'use',
        use: { tab: n.tab, list: n.list, caster },
      }
    return {
      nav: n,
      effect: 'notice',
      notice: e.description ?? `「${e.label}」の処理はまだありません`,
    }
  }
  // confirm（確認窓）
  if (n.confirm === 0) {
    if (k === 'save')
      return {
        nav: { ...n, focus: 'list' },
        effect: 'save',
        save: n.list,
        notice: `スロット${n.list + 1}に上書きしました`,
      }
    // 購入。実処理は呼び出し側（`onUse`。`caster` = 買う人物）
    return {
      nav: { ...n, focus: 'list' },
      effect: 'use',
      use: { tab: n.tab, list: n.list, caster: n.party },
    }
  }
  return { nav: { ...n, focus: 'list' }, effect: 'moved' }
}

/** 「使う」の要求が指す一覧の行。どうぐは選んだタブの行、まほうは使い手の一覧の行。見つからなければ undefined */
export function entryForUse(
  content: ResolvedContent,
  partyIds: readonly string[] | undefined,
  use: ScreenUse
): MenuEntry | undefined {
  return entriesAt(content, partyIds, use.tab, use.caster)[use.list]
}

/** 一覧の中身が変わった（所持数が減った・並べ替えた）あとの選択位置の収め直し。一覧の範囲に収める */
export function clampNav(nav: ScreenNav, ctx: ScreenCtx): ScreenNav {
  const n = listCount(ctx, nav)
  const list = n <= 0 ? 0 : Math.min(Math.max(nav.list, 0), n - 1)
  return list === nav.list ? nav : { ...nav, list }
}

/** 項目画面の中での1つの入力に対する状態遷移（純粋）。「戻る」は1階層ずつで、最初の階層で戻るとメニュー最上位へ */
export function stepScreen(nav: ScreenNav, ev: ScreenEvent, ctx: ScreenCtx): ScreenStep {
  const k = ctx.content.kind
  if (ev.type === 'back') {
    if (nav.focus === 'confirm') return { nav: { ...nav, focus: 'list' }, effect: 'moved' }
    if (nav.focus === baseFocus(k)) return { nav, effect: 'back-to-top' }
    if (nav.focus === 'list') return { nav: { ...nav, focus: baseFocus(k) }, effect: 'moved' }
    // 使う相手の選択（target）→ 一覧
    return { nav: { ...nav, focus: 'list' }, effect: 'moved' }
  }
  if (ev.type === 'confirm') return decideConfirm(ctx, nav)
  if (ev.type === 'move') {
    const { dx, dy } = ev
    if (nav.focus === 'confirm') {
      const d = dx !== 0 ? dx : dy
      return d === 0
        ? { nav, effect: 'none' }
        : { nav: { ...nav, confirm: wrap(nav.confirm + (d < 0 ? -1 : 1), 2) }, effect: 'moved' }
    }
    if (nav.focus === 'tab') {
      // アプリストアは上下で人物を切り替える（人物ごとに一覧が違う。画面の人物の行に案内を常に出す）
      if (
        k === 'appstore' &&
        appstoreHasParty(ctx.content) &&
        dx === 0 &&
        dy !== 0 &&
        ctx.partyCount > 0
      )
        return {
          nav: { ...nav, party: wrap(nav.party + (dy < 0 ? -1 : 1), ctx.partyCount), list: 0 },
          effect: 'moved',
        }
      const d = dx !== 0 ? dx : 0
      if (d === 0 || ctx.content.tabs.length === 0) return { nav, effect: 'none' }
      return {
        nav: { ...nav, tab: wrap(nav.tab + (d < 0 ? -1 : 1), ctx.content.tabs.length), list: 0 },
        effect: 'moved',
      }
    }
    if (nav.focus === 'target') {
      if (dy === 0 || ctx.partyCount === 0) return { nav, effect: 'none' }
      return {
        nav: { ...nav, target: wrap(nav.target + (dy < 0 ? -1 : 1), ctx.partyCount) },
        effect: 'moved',
      }
    }
    if (nav.focus === 'party') {
      // status は左右で人物を切り替える。それ以外は上下
      const d = k === 'status' ? (dx !== 0 ? dx : dy) : dy
      if (d === 0 || ctx.partyCount === 0) return { nav, effect: 'none' }
      return {
        nav: { ...nav, party: wrap(nav.party + (d < 0 ? -1 : 1), ctx.partyCount) },
        effect: 'moved',
      }
    }
    // list
    if (k === 'config' && dx !== 0) {
      const o = ctx.content.options[nav.list]
      if (!o) return { nav, effect: 'none' }
      return {
        nav,
        effect: 'setting',
        setting: {
          key: o.key,
          value: wrap(optionValue(ctx, o) + (dx < 0 ? -1 : 1), o.choices.length),
        },
      }
    }
    const n = listCount(ctx, nav)
    if (dy === 0 || n === 0) return { nav, effect: 'none' }
    return { nav: { ...nav, list: wrap(nav.list + (dy < 0 ? -1 : 1), n) }, effect: 'moved' }
  }
  // select（1タップ決定）
  const { target, index } = ev
  if (nav.focus === 'confirm') {
    if (target !== 'confirm' || (index !== 0 && index !== 1)) return { nav, effect: 'none' }
    return decideConfirm(ctx, { ...nav, confirm: index })
  }
  if (target === 'prev' || target === 'next') {
    if (
      (k !== 'status' && !(k === 'appstore' && appstoreHasParty(ctx.content))) ||
      ctx.partyCount === 0
    )
      return { nav, effect: 'none' }
    return {
      nav: {
        ...nav,
        party: wrap(nav.party + (target === 'prev' ? -1 : 1), ctx.partyCount),
        // アプリストアは人物が変わると一覧が変わるので先頭へ戻す
        ...(k === 'appstore' ? { list: 0 } : {}),
      },
      effect: 'moved',
    }
  }
  if (target === 'tab') {
    if (index < 0 || index >= ctx.content.tabs.length) return { nav, effect: 'none' }
    return decideConfirm(ctx, { ...nav, focus: 'tab', tab: index })
  }
  if (target === 'party') {
    if (nav.focus === 'target') {
      if (index < 0 || index >= ctx.partyCount) return { nav, effect: 'none' }
      return decideConfirm(ctx, { ...nav, target: index })
    }
    const ok =
      ((k === 'party-list' || k === 'equip') && (nav.focus === 'party' || nav.focus === 'list')) ||
      k === 'status'
    if (!ok || index < 0 || index >= ctx.partyCount) return { nav, effect: 'none' }
    if (k === 'status') return { nav: { ...nav, party: index }, effect: 'moved' }
    return decideConfirm(ctx, { ...nav, focus: 'party', party: index })
  }
  if (target === 'list') {
    if (nav.focus === 'party' || nav.focus === 'target') return { nav, effect: 'none' }
    if (index < 0 || index >= listCount(ctx, nav)) return { nav, effect: 'none' }
    return decideConfirm(ctx, { ...nav, focus: 'list', list: index })
  }
  return { nav, effect: 'none' }
}

/** 説明バーの文: 通知があればそれ、なければ今のフォーカスの行の説明、なければ画面の説明 */
export function screenDescription(nav: ScreenNav, ctx: ScreenCtx, notice: string | null): string {
  if (notice) return notice
  const k = ctx.content.kind
  if (nav.focus === 'list' && k === 'config') {
    const d = ctx.content.options[nav.list]?.description
    if (d) return d
  }
  if (nav.focus === 'list' && k !== 'save' && k !== 'config') {
    const e = listEntries(ctx, nav)[nav.list]
    if (e?.description) return e.description
  }
  return ctx.content.description
}

// ---------------------------------------------------------------------------
// 窓の配置（16:9 基準面の比率）
// ---------------------------------------------------------------------------

export interface ScreenLayout {
  desc: Rect
  /** 再利用する枠（項目窓からスライド変形して来る先）。一覧窓／本体窓 */
  primary: Rect
  /** 左の人物の枠（人物を選ぶ画面だけ） */
  party: Rect[]
  /** タブ（サブコマンド）の矩形 */
  tabs: Rect[]
  /** 一覧窓の行（スクロールで見えている分） */
  rows: Rect[]
  /** rows[0] が一覧の何番目か */
  rowStart: number
  /** 確認窓の外枠と選択肢 */
  confirm: { frame: Rect; message: Rect; options: Rect[] } | null
  /** ステータス・アプリストアの人物の前・次ボタン（アプリストアは中央に人物名の枠 `label` も） */
  statusNav: { prev: Rect; next: Rect; label: Rect } | null
  /** そうび画面の見出し行（2 枠の現在の装備）の矩形。そうび以外は空 */
  header: Rect[]
  /** 文字の大きさ (px) */
  fonts: { row: number; desc: number; tab: number; small: number }
}

export interface ScreenLayoutInput {
  kind: ScreenKind
  base: Rect
  partyCount: number
  tabCount: number
  listCount: number
  /** 一覧の選択位置（見える範囲を決める） */
  cursor: number
  /** 残り時間の予約領域（左上）を避けるか */
  reserveTimer: boolean
  confirmOpen: boolean
  /** 前回の一覧の見える先頭（カーソルが範囲内ならそのまま保つ。省略は 0） */
  prevRowStart?: number
  /** そうび画面の見出し行の数（一覧の上に並べる。省略は 0） */
  headerCount?: number
  /** アプリストアが人物別の一覧を持つか（人物の切り替え帯を出す）。省略は false */
  perParty?: boolean
}

/** 見える先頭 index。カーソルが常に範囲に入るよう、必要最小限だけ送る */
export function scrollStart(count: number, cursor: number, visible: number, prev = 0): number {
  if (visible <= 0 || count <= visible) return 0
  const maxStart = count - visible
  let s = Math.min(Math.max(prev, 0), maxStart)
  if (cursor < s) s = cursor
  if (cursor >= s + visible) s = cursor - visible + 1
  return Math.min(Math.max(s, 0), maxStart)
}

/**
 * 項目画面の窓の配置。上端 2%H〜 の説明バー、下端 90%H までの本体、91〜99%H は共通の情報帯（別計算）。
 * `reserveTimer` のとき、左上の残り時間の予約領域（`fieldTimeLimit.ts`）に説明バーと左の人物枠がかからないよう避ける。
 */
export function computeScreenLayout(i: ScreenLayoutInput): ScreenLayout {
  const { base: b, kind } = i
  const W = b.w
  const H = b.h
  const X = (f: number): number => b.x + f * W
  const Y = (f: number): number => b.y + f * H
  const reserveW = i.reserveTimer ? TIME_LIMIT_AREA.x + TIME_LIMIT_AREA.w : 0
  const descX = 0.02 + reserveW
  const desc: Rect = { x: X(descX), y: Y(0.02), w: (0.98 - descX) * W, h: 0.08 * H }
  const bottom = 0.9
  const hasParty = kind === 'item' || kind === 'party-list' || kind === 'equip'
  const rightX = hasParty ? 0.35 : 0.02
  const rightW = 0.98 - rightX
  const hasTabs = kind === 'item' || kind === 'appstore'
  const tabsY = 0.12
  const tabs: Rect[] = []
  if (hasTabs && i.tabCount > 0) {
    const tw = (rightW * W) / i.tabCount
    for (let t = 0; t < i.tabCount; t++)
      tabs.push({ x: X(rightX) + t * tw, y: Y(tabsY), w: tw, h: 0.08 * H })
  }
  const listTop = hasTabs ? 0.22 : 0.12
  const primary: Rect = { x: X(rightX), y: Y(listTop), w: rightW * W, h: (bottom - listTop) * H }
  const party: Rect[] = []
  if (hasParty) {
    // 説明バー（2〜10%H）の下（12%H〜）。reserveTimer の有無で変えない（9% 始まりだと x 16%W 以降で説明バーと重なっていた）
    const top = 0.12
    const gap = 0.006 * H
    const n = Math.max(1, Math.min(i.partyCount, MAX_PARTY_SLOTS))
    const colH = (bottom - top) * H
    const slotH = Math.min(0.21 * H, (colH - gap * (n - 1)) / n)
    for (let p = 0; p < Math.min(i.partyCount, MAX_PARTY_SLOTS); p++)
      party.push({ x: X(0.02), y: Y(top) + p * (slotH + gap), w: 0.3 * W, h: slotH })
  }
  const rowH = (kind === 'save' ? 0.16 : kind === 'config' ? 0.09 : 0.07) * H
  const pad = 0.015 * H
  // 一覧の上に取る帯: アプリストアは人物の切り替え行、そうびは 2 枠の見出し行
  const headerN = kind === 'equip' ? Math.max(0, Math.floor(i.headerCount ?? 0)) : 0
  const personBar = kind === 'appstore' && i.perParty === true
  const topBand = personBar ? 0.09 * H : headerN > 0 ? headerN * rowH + pad : 0
  const header: Rect[] = []
  for (let h = 0; h < headerN; h++)
    header.push({ x: primary.x, y: primary.y + pad + h * rowH, w: primary.w, h: rowH })
  const visible = Math.max(1, Math.floor((primary.h - pad * 2 - topBand) / rowH))
  const rowStart = scrollStart(i.listCount, i.cursor, visible, i.prevRowStart ?? 0)
  const rows: Rect[] = []
  for (let r = 0; r < Math.min(visible, Math.max(0, i.listCount - rowStart)); r++)
    rows.push({ x: primary.x, y: primary.y + pad + topBand + r * rowH, w: primary.w, h: rowH })
  let confirm: ScreenLayout['confirm'] = null
  if (i.confirmOpen) {
    const cw = 0.4 * W
    const ch = 0.26 * H
    const frame: Rect = { x: X(0.5) - cw / 2, y: Y(0.5) - ch / 2, w: cw, h: ch }
    const oh = ch * 0.28
    confirm = {
      frame,
      message: { x: frame.x, y: frame.y + ch * 0.1, w: cw, h: oh },
      options: [0, 1].map((o) => ({ x: frame.x, y: frame.y + ch * 0.4 + o * oh, w: cw, h: oh })),
    }
  }
  const statusNav =
    kind === 'status' || personBar
      ? {
          prev: { x: primary.x + 0.01 * W, y: primary.y + 0.01 * H, w: 0.12 * W, h: 0.08 * H },
          next: {
            x: primary.x + primary.w - 0.13 * W,
            y: primary.y + 0.01 * H,
            w: 0.12 * W,
            h: 0.08 * H,
          },
          label: {
            x: primary.x + 0.14 * W,
            y: primary.y + 0.01 * H,
            w: primary.w - 0.28 * W,
            h: 0.08 * H,
          },
        }
      : null
  return {
    desc,
    primary,
    party,
    tabs,
    rows,
    rowStart,
    confirm,
    statusNav,
    header,
    fonts: { row: 0.04 * H, desc: 0.04 * H, tab: 0.036 * H, small: 0.03 * H },
  }
}
