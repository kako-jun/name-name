/**
 * 戦闘の候補窓（じゅもん・どうぐの一覧）と対象選択の状態機械 (#204)。純粋関数のみ（this / PixiJS に触れない）。
 *
 * FF5/6 風の「窓の階層」: コマンド窓の上に、一覧の窓、さらに対象選択（手のカーソル）が重なって開く。
 * キャンセルで一つ前の窓に戻る。この「何枚目の窓を開いていて、カーソルがどこか」は画面の一時的な状態なので、
 * BattleScreen が `MenuStack` として持つだけで GameState / BattleState には持たない（ADR 0002）。
 * 確定したときだけ `MenuAction` が出て、BattleScreen がエンジン（selectSpell / selectItem）へ渡す。
 *
 * - 「わざ」(#873) の一覧は呪文と同じ窓で、MP は持たない（コスト列は空）。対象は特技と同じ相対表現（`相手単体` など）
 * - 呪文・アイテムの一覧は呼び出し側（ゲームの設定）が渡す。エンジンは汎用のまま
 * - 消費 MP が足りない呪文は `disabled`（グレー）。確定しようとすると `blocked` を返し、窓は閉じない
 * - 対象は呪文の `target` 文字列（味方単体 / 敵全体 など）から決まる。単体は手が 1 本、全体は対象の全員に同時に手が立つ
 */
import type { ItemExecution, SkillExecution, SpellExecution, SummonExecution } from './battleEngine'
import { parseEffect, type BattleEntity } from './spellDsl'

export type MenuKind = 'spell' | 'item' | 'skill' | 'summon'
export type TargetSide = 'enemy' | 'party'
/** single = 手で 1 体選ぶ / all = 側の全員 / self = 使用者本人 / none = 対象なし（マップ用など。選択を挟まず即実行） */
export type TargetScope = 'single' | 'all' | 'self' | 'none'

export interface TargetSpec {
  side: TargetSide
  scope: TargetScope
  /** single のとき、指せるのが倒れた味方だけ（蘇生）か。それ以外は生きている者だけ。蘇生の呪文・アイテムだけ true */
  revive?: boolean
}

/** 呪文の候補。`SpellExecution`（エンジンへ渡す形）に一覧用の id を足したもの */
export interface BattleSpellEntry extends SpellExecution {
  id: string
}

/** アイテムの候補。`count` を渡すと「×n」を表示し、0 ならグレー。使うと BattleScreen がこの entry の count を書き換えるので、呼び出し側は戦闘ごとに複製を渡すこと */
export interface BattleItemEntry extends ItemExecution {
  id: string
  count?: number
}

/** 「わざ」(#873) の候補。`SkillExecution`（エンジンへ渡す形）に一覧用の id を足したもの。MP は持たない */
export interface BattleSkillEntry extends SkillExecution {
  id: string
}

/** 「しょうかん」(#889) の候補。`SummonExecution`（エンジンへ渡す形。名前は召喚獣の表示名）に一覧用の魔石の id を足したもの */
export interface BattleSummonEntry extends SummonExecution {
  id: string
}

/** 候補窓に出すデータ。呪文・わざ・召喚は味方の id ごと（覚えているもの・装備している魔石が人によって違う）、アイテムは全員共通 */
export interface BattleMenuData {
  spells?: Readonly<Record<string, readonly BattleSpellEntry[]>>
  /** 「わざ」(#873)。味方の id ごと（装備中の刀のアビリティなど） */
  skills?: Readonly<Record<string, readonly BattleSkillEntry[]>>
  /** 「しょうかん」(#889)。味方の id ごと（装備中の魔石の召喚獣。枠の順） */
  summons?: Readonly<Record<string, readonly BattleSummonEntry[]>>
  items?: readonly BattleItemEntry[]
}

/** 候補窓の 1 件（呪文・わざ・召喚・アイテムのどれか） */
export type BattleMenuEntry =
  | BattleSpellEntry
  | BattleSkillEntry
  | BattleSummonEntry
  | BattleItemEntry

/** 一覧の 1 行 */
export interface MenuRow {
  label: string
  /** 右端に出す消費の表示（呪文は MP の数字だけ `3`、アイテムは `×2`、なければ空） */
  cost: string
  disabled: boolean
}

/** 呪文の `target` 文字列 → 対象。未指定・未知は敵単体（エンジンの既定と同じ） */
export function parseSpellTarget(raw: string | undefined): TargetSpec {
  // エンジンの resolveSpellTargets と同じく前後の空白は無視する
  switch (typeof raw === 'string' ? raw.trim() : '') {
    case '味方単体':
      return { side: 'party', scope: 'single' }
    case '味方全体':
      return { side: 'party', scope: 'all' }
    case '敵全体':
      return { side: 'enemy', scope: 'all' }
    case '自分':
      return { side: 'party', scope: 'self' }
    case 'マップ':
      return { side: 'enemy', scope: 'none' }
    default:
      return { side: 'enemy', scope: 'single' }
  }
}

/**
 * 特技（わざ）の `target`（使う側から見た相対表現）→ 対象 (#873)。味方が使うので「相手」は敵側、「仲間」は味方側。
 * 未指定・未知は相手単体（エンジンの `performSkill` の既定と同じ）
 */
export function parseSkillTarget(raw: string | undefined): TargetSpec {
  switch (typeof raw === 'string' ? raw.trim() : '') {
    case '仲間単体':
      return { side: 'party', scope: 'single' }
    case '仲間全体':
      return { side: 'party', scope: 'all' }
    case '相手全体':
      return { side: 'enemy', scope: 'all' }
    case '自分':
      return { side: 'party', scope: 'self' }
    default:
      return { side: 'enemy', scope: 'single' }
  }
}

/** アイテムの対象。エンジンの `selectItem` は味方単体だけを扱うので常に味方単体 */
export const ITEM_TARGET: TargetSpec = { side: 'party', scope: 'single' }

/** 一覧の行を作る。MP が足りない呪文・所持数 0 のアイテムは disabled */
export function buildMenuRows(
  kind: MenuKind,
  entries: ReadonlyArray<BattleMenuEntry>,
  actor: Pick<BattleEntity, 'mp' | 'summoned'> | undefined
): MenuRow[] {
  return entries.map((e) => {
    // わざ (#873) は MP も所持数も無い。常に選べる（コスト列は空）
    if (kind === 'skill') return { label: e.name, cost: '', disabled: !actor }
    // 召喚 (#889): MP を使うのは 0 より大きいときだけ表示する。呼び済み（1 人 1 バトル 1 回）・MP 不足はグレー
    if (kind === 'summon') {
      const mp = (e as BattleSummonEntry).mp
      return {
        label: e.name,
        cost: mp > 0 ? String(mp) : '',
        disabled: !actor || !!actor.summoned || actor.mp < mp,
      }
    }
    if (kind === 'spell') {
      const mp = (e as BattleSpellEntry).mp
      return {
        label: e.name,
        cost: String(mp), // FF6 風に数字だけ（MP の消費であることは窓の文脈で分かる）
        // 対象なし（マップ用）の呪文は戦闘では使えない。MP 不足もグレー
        disabled:
          !actor ||
          actor.mp < mp ||
          parseSpellTarget((e as BattleSpellEntry).target).scope === 'none',
      }
    }
    const count = (e as BattleItemEntry).count
    return {
      label: e.name,
      cost: typeof count === 'number' ? `×${count}` : '',
      disabled: typeof count === 'number' && count <= 0,
    }
  })
}

export function targetSpecOf(kind: MenuKind, entry: BattleMenuEntry): TargetSpec {
  const spec =
    kind === 'spell'
      ? parseSpellTarget((entry as BattleSpellEntry).target)
      : kind === 'skill' || kind === 'summon'
        ? parseSkillTarget((entry as BattleSkillEntry).target)
        : ITEM_TARGET
  return spec.scope === 'single' && isReviveEntry(kind, entry) ? { ...spec, revive: true } : spec
}

/**
 * 蘇生の呪文・アイテムか。効果 DSL が `revive`、または蘇生の builtin（呪文は ザオリク `zaorik`、
 * アイテムは せかいじゅのしずく `world_tree_drop`）。呪文の builtin はアイテムでは、逆もまた別の関数を指すので種別ごとに見る。
 * わざ (#873) はエンジンの特技と同じく呪文の builtin 表（`zaorik`）で見る
 */
export function isReviveEntry(
  kind: MenuKind,
  entry: { effect?: string; builtin?: string }
): boolean {
  if (kind === 'item' ? entry.builtin === 'world_tree_drop' : entry.builtin === 'zaorik') {
    return true
  }
  return typeof entry.effect === 'string' && parseEffect(entry.effect)?.kind === 'revive'
}

export interface ListWindow {
  type: 'list'
  kind: MenuKind
  cursor: number
  /** 見えている先頭の行（行数が窓に収まらないときのスクロール位置） */
  top: number
}

export interface TargetWindow {
  type: 'target'
  kind: MenuKind
  entryIndex: number
  spec: TargetSpec
  /** いま手が指している側（single のときだけ左右キーで切り替わる） */
  side: TargetSide
  /** single のとき手が指している index（side の配列の index）。all / self では使わない */
  cursor: number
}

export type MenuWindow = ListWindow | TargetWindow
/** 開いている窓（コマンド窓の上に重なるぶん）。空 = コマンド窓だけ */
export type MenuStack = readonly MenuWindow[]

export const EMPTY_STACK: MenuStack = []

/** 確定した操作。`targetId` は single のときだけ */
export interface MenuAction {
  kind: MenuKind
  entryIndex: number
  targetId?: string
}

export interface MenuResult {
  stack: MenuStack
  action?: MenuAction
  /** 確定できなかった理由。`disabled` = グレーの行（MP 不足など）/ `empty` = 指せる対象がいない */
  blocked?: 'disabled' | 'empty'
}

/** 窓の操作に必要な、いまの局面 */
export interface MenuContext {
  /** 一番上の一覧窓に対応する行 */
  rows: readonly MenuRow[]
  /** 一覧窓に同時に見える行数（画面の大きさで決まる） */
  maxRows: number
  /** 一覧窓の候補（対象の決定に使う） */
  entries: ReadonlyArray<BattleMenuEntry>
  party: readonly BattleEntity[]
  enemies: readonly BattleEntity[]
  /** いまコマンドを出している味方の index */
  actorIndex: number
}

export type MenuDirection = 'up' | 'down' | 'left' | 'right'

/** 行 `cursor` が見える `top` を返す（なるべく今の top を保つ） */
export function scrollTopFor(
  cursor: number,
  top: number,
  rowCount: number,
  maxRows: number
): number {
  const visible = Math.max(1, Math.floor(maxRows))
  const maxTop = Math.max(0, rowCount - visible)
  let t = Math.min(top, maxTop)
  if (cursor < t) t = cursor
  if (cursor >= t + visible) t = cursor - visible + 1
  return Math.max(0, Math.min(t, maxTop))
}

/** 一覧窓を開く。候補がない・すでに窓が開いているときは今のまま。カーソルは最初に選べる行 */
export function openList(stack: MenuStack, kind: MenuKind, ctx: MenuContext): MenuStack {
  if (stack.length > 0 || ctx.rows.length === 0) return stack
  const first = ctx.rows.findIndex((r) => !r.disabled)
  const cursor = first === -1 ? 0 : first
  return [
    { type: 'list', kind, cursor, top: scrollTopFor(cursor, 0, ctx.rows.length, ctx.maxRows) },
  ]
}

function aliveIndexes(list: readonly BattleEntity[]): number[] {
  const out: number[] = []
  list.forEach((e, i) => {
    if (e.hp > 0) out.push(i)
  })
  return out
}

/** single で手が指せる index。生きている者だけ。蘇生（`revive`）のときは倒れた味方だけ */
export function singleCandidates(
  side: TargetSide,
  party: readonly BattleEntity[],
  enemies: readonly BattleEntity[],
  revive = false
): number[] {
  if (revive && side === 'party') {
    const dead: number[] = []
    party.forEach((e, i) => {
      if (e.hp <= 0) dead.push(i)
    })
    return dead
  }
  return aliveIndexes(side === 'enemy' ? enemies : party)
}

/**
 * 「選択中」の印 ▼ を出す者 (#805)。対象選択窓が開いているあいだは、手が指す者だけ（行動者の ▼ は隠す。手との二重表示で
 * 誰が対象か分からなくなるため）。開いていなければ、ATB でコマンドを出す番の味方（`actorIndex` >= 0）だけ。
 * 倒れた者には出さない（蘇生の対象窓の候補だけは倒れた味方に出す）。範囲外の index（空き枠）は無視される
 */
export function selectMarkTargets(
  party: readonly BattleEntity[],
  enemies: readonly BattleEntity[],
  actorIndex: number,
  w: MenuWindow | undefined
): { party: boolean[]; enemy: boolean[] } {
  const out = { party: party.map(() => false), enemy: enemies.map(() => false) }
  if (w?.type === 'target') {
    for (const h of targetHands(w, party, enemies, actorIndex)) {
      if (h.side === 'enemy') {
        if ((enemies[h.index]?.hp ?? 0) > 0) out.enemy[h.index] = true
      } else if (party[h.index] && (party[h.index].hp > 0 || !!w.spec.revive)) {
        out.party[h.index] = true
      }
    }
    return out
  }
  if (actorIndex >= 0 && (party[actorIndex]?.hp ?? 0) > 0) out.party[actorIndex] = true
  return out
}

/** 窓に手が立つ位置（描画用）。single = 1 本 / all = 側の生存者全員 / self = 使用者 */
export function targetHands(
  w: TargetWindow,
  party: readonly BattleEntity[],
  enemies: readonly BattleEntity[],
  actorIndex: number
): Array<{ side: TargetSide; index: number }> {
  if (w.spec.scope === 'single') return [{ side: w.side, index: w.cursor }]
  if (w.spec.scope === 'self') return [{ side: 'party', index: actorIndex }]
  if (w.spec.scope === 'all') {
    const list = w.spec.side === 'enemy' ? enemies : party
    return aliveIndexes(list).map((index) => ({ side: w.spec.side, index }))
  }
  return []
}

/**
 * カーソル移動。一覧は上下で循環、対象は single のとき上下で候補の中を巡回する。
 * 側（敵 / 味方）は呪文・アイテムの target で決まっていて、左右キーでは切り替えない
 * （エンジンは target と逆の側の targetId を解決できず、MP とターンだけを消費してしまうため）
 */
export function moveCursor(stack: MenuStack, dir: MenuDirection, ctx: MenuContext): MenuStack {
  const w = stack[stack.length - 1]
  if (!w) return stack
  if (w.type === 'list') {
    const n = ctx.rows.length
    if (n === 0 || (dir !== 'up' && dir !== 'down')) return stack
    const cursor = (w.cursor + (dir === 'down' ? 1 : n - 1)) % n
    return [
      ...stack.slice(0, -1),
      { ...w, cursor, top: scrollTopFor(cursor, w.top, n, ctx.maxRows) },
    ]
  }
  if (w.spec.scope !== 'single') return stack
  if (dir === 'left' || dir === 'right') return stack
  const cands = singleCandidates(w.side, ctx.party, ctx.enemies, w.spec.revive)
  if (cands.length === 0) return stack
  const at = cands.indexOf(w.cursor)
  const next =
    at === -1 ? cands[0] : cands[(at + (dir === 'down' ? 1 : cands.length - 1)) % cands.length]
  return [...stack.slice(0, -1), { ...w, cursor: next }]
}

/** 一覧窓のカーソルを指定の行に置く（タップ用）。範囲外・一覧窓でないときは今のまま */
export function setListCursor(stack: MenuStack, index: number, ctx: MenuContext): MenuStack {
  const w = stack[stack.length - 1]
  if (!w || w.type !== 'list' || index < 0 || index >= ctx.rows.length) return stack
  return [
    ...stack.slice(0, -1),
    { ...w, cursor: index, top: scrollTopFor(index, w.top, ctx.rows.length, ctx.maxRows) },
  ]
}

/** 対象窓の手を指定の対象に置く（タップ用）。single のときだけ。指せない対象・target と違う側は今のまま */
export function setTargetCursor(
  stack: MenuStack,
  side: TargetSide,
  index: number,
  ctx: MenuContext
): MenuStack {
  const w = stack[stack.length - 1]
  if (!w || w.type !== 'target' || w.spec.scope !== 'single' || side !== w.side) return stack
  if (!singleCandidates(side, ctx.party, ctx.enemies, w.spec.revive).includes(index)) return stack
  return [...stack.slice(0, -1), { ...w, cursor: index }]
}

/**
 * 一覧窓を `delta` 行ぶんスクロールする（タップ用の▲▼）。カーソルは見えている範囲に収める。
 * 一覧窓でないときは今のまま
 */
export function scrollList(stack: MenuStack, delta: number, ctx: MenuContext): MenuStack {
  const w = stack[stack.length - 1]
  if (!w || w.type !== 'list') return stack
  const n = ctx.rows.length
  const visible = Math.max(1, Math.floor(ctx.maxRows))
  const maxTop = Math.max(0, n - visible)
  const top = Math.max(0, Math.min(maxTop, w.top + delta))
  const cursor = Math.max(top, Math.min(w.cursor, top + visible - 1, n - 1))
  return [...stack.slice(0, -1), { ...w, top, cursor }]
}

/** 画面の大きさが変わって見える行数が変わったとき、先頭行とカーソルを窓に収め直す */
export function refitList(stack: MenuStack, ctx: MenuContext): MenuStack {
  const w = stack[0]
  if (!w || w.type !== 'list') return stack
  const top = scrollTopFor(w.cursor, w.top, ctx.rows.length, ctx.maxRows)
  if (top === w.top) return stack
  return [{ ...w, top }, ...stack.slice(1)]
}

/** 決定。一覧 → （対象が要れば）対象窓を重ねる / 対象窓 → 確定した操作を返す。窓は確定で全部閉じる */
export function confirm(stack: MenuStack, ctx: MenuContext): MenuResult {
  const w = stack[stack.length - 1]
  if (!w) return { stack }
  if (w.type === 'list') {
    const row = ctx.rows[w.cursor]
    const entry = ctx.entries[w.cursor]
    if (!row || !entry) return { stack, blocked: 'empty' }
    if (row.disabled) return { stack, blocked: 'disabled' }
    const spec = targetSpecOf(w.kind, entry)
    if (spec.scope === 'none') {
      return { stack: EMPTY_STACK, action: { kind: w.kind, entryIndex: w.cursor } }
    }
    let cursor = 0
    if (spec.scope === 'single') {
      const cands = singleCandidates(spec.side, ctx.party, ctx.enemies, spec.revive)
      if (cands.length === 0) return { stack, blocked: 'empty' }
      cursor = spec.side === 'party' && cands.includes(ctx.actorIndex) ? ctx.actorIndex : cands[0]
    } else if (
      targetHands(
        { type: 'target', kind: w.kind, entryIndex: w.cursor, spec, side: spec.side, cursor: 0 },
        ctx.party,
        ctx.enemies,
        ctx.actorIndex
      ).length === 0
    ) {
      return { stack, blocked: 'empty' }
    }
    return {
      stack: [
        ...stack,
        { type: 'target', kind: w.kind, entryIndex: w.cursor, spec, side: spec.side, cursor },
      ],
    }
  }
  const action: MenuAction = { kind: w.kind, entryIndex: w.entryIndex }
  if (w.spec.scope === 'single') {
    const list = w.side === 'enemy' ? ctx.enemies : ctx.party
    const target = list[w.cursor]
    // 手が指している対象がまだ指せるか（倒れた敵への空撃ち防止）
    if (
      !target ||
      !singleCandidates(w.side, ctx.party, ctx.enemies, w.spec.revive).includes(w.cursor)
    ) {
      return { stack, blocked: 'empty' }
    }
    action.targetId = target.id
  }
  return { stack: EMPTY_STACK, action }
}

/** キャンセル。一つ前の窓に戻る（一番下の窓ならコマンド窓に戻る） */
export function cancel(stack: MenuStack): MenuStack {
  return stack.slice(0, -1)
}

/** 開いている窓の枚数（0 = コマンド窓だけ） */
export function depth(stack: MenuStack): number {
  return stack.length
}

/** 候補窓が開いている間のキー操作 */
export type MenuKeyAction =
  | { type: 'move'; dir: MenuDirection }
  | { type: 'confirm' }
  | { type: 'cancel' }

/**
 * `KeyboardEvent.key` → 候補窓の操作。矢印 = カーソル移動 / Enter・Z = 決定 / Escape・Backspace・X = キャンセル。
 * Space は使わない（battle-sample のブリンク切替と衝突するため）。それ以外は undefined
 */
export function menuKeyAction(key: string): MenuKeyAction | undefined {
  switch (key) {
    case 'ArrowUp':
      return { type: 'move', dir: 'up' }
    case 'ArrowDown':
      return { type: 'move', dir: 'down' }
    case 'ArrowLeft':
      return { type: 'move', dir: 'left' }
    case 'ArrowRight':
      return { type: 'move', dir: 'right' }
    case 'Enter':
    case 'z':
    case 'Z':
      return { type: 'confirm' }
    case 'Escape':
    case 'Backspace':
    case 'x':
    case 'X':
      return { type: 'cancel' }
    default:
      return undefined
  }
}

/**
 * 画面の下端に常に出す操作の案内 (#806。暗黙の操作を作らない)。`w` は一番上の窓（無ければコマンド窓の状態）。
 * `fits` は「その文字列が収まるか」の判定（画面幅から呼び出し側が渡す）。長い文は収まらなければ短い文に落とし、
 * 短い文も収まらなければ空文字（出さない）。キーとタップの両方を書く。
 * `commandKeys` は cross のときの矢印キーによるコマンド決定の案内を足す
 */
export function menuHint(
  w: MenuWindow | undefined,
  commandKeys: boolean,
  fits: (text: string) => boolean
): string {
  let long: string
  let short: string
  if (!w) {
    long = commandKeys ? '矢印キー・タップ: コマンドをえらぶ' : 'タップ: コマンドをえらぶ'
    short = commandKeys ? '矢印・タップ: コマンド' : 'タップ: コマンド'
  } else if (w.type === 'list') {
    long = '↑↓: えらぶ  Enter・タップ: けってい  Esc・そとをタップ: もどる'
    short = '↑↓ えらぶ  Enter けってい  Esc もどる'
  } else if (w.spec.scope === 'single') {
    long = '↑↓: たいしょう  Enter・タップ: けってい  Esc・そとをタップ: もどる'
    short = '↑↓ たいしょう  Enter けってい  Esc もどる'
  } else {
    long = 'Enter・タップ: けってい  Esc・そとをタップ: もどる'
    short = 'Enter けってい  Esc もどる'
  }
  return fits(long) ? long : fits(short) ? short : ''
}
