/**
 * 一枚絵フィールドの NPC (#841 段階1) の純粋関数群。DOM / PixiJS には触れない。
 *
 * 座標は fieldWalk.ts と同じ背景ピクセル。NPC の位置 = 足元の 1 点。
 * - 当たり判定: NPC の足元を中心とする半径 NPC_BLOCK_RADIUS の円に、主人公の足元が入れない。
 * - 話しかけ: 向いた方向（円錐）の近傍 NPC を 1 人選ぶ。クリックされた NPC は近づいてから話しかける。
 * - 会話中は歩行入力・ポインタ移動・エンカウント・ワープ・端リンクを止める（呼び出し側が acceptsWalkInput で判定）。
 */
import {
  isWalkable,
  stepMove,
  type Facing8,
  type MoveResult,
  type Vec,
  type WalkMask,
} from './fieldWalk'

/** NPC の足元を中心に主人公が入れない半径（背景ピクセル） */
export const NPC_BLOCK_RADIUS = 32
/** 話しかけられる距離（足元どうし。背景ピクセル） */
export const NPC_TALK_REACH = 90
/** クリックで近づくとき、この距離まで来たら歩きを止めて話しかける（NPC_TALK_REACH より小さい） */
export const NPC_APPROACH_STOP = 72
/** 向いた方向から左右にこの角度（度）までを「向いている」とみなす */
export const NPC_TALK_CONE_DEG = 60
/** クリックで近づく間、この時間（ms）動けなければ諦める */
export const NPC_APPROACH_STUCK_MS = 600

export interface NpcPoint {
  id: string
  x: number
  y: number
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/** その足元の点が、いずれかの NPC の当たり（円）に入っているか */
export function blockedByNpc(
  npcs: readonly NpcPoint[],
  p: Vec,
  radius: number = NPC_BLOCK_RADIUS
): boolean {
  for (const n of npcs) if (dist(n, p) < radius) return true
  return false
}

function nearestNpcDistance(npcs: readonly NpcPoint[], p: Vec): number {
  let d = Infinity
  for (const n of npcs) d = Math.min(d, dist(n, p))
  return d
}

/** 円周へ押し戻すときの余裕（`< radius` で塞ぐ判定に、浮動小数の誤差で入らないための量） */
const PUSH_EPS = 1e-6
/** 「触れている」とみなす円周からの余裕 (px)。円周で止まる位置からでも向きを問わず話せるように */
const NPC_TOUCH_SLACK = 2

function nearestNpc(npcs: readonly NpcPoint[], p: Vec): NpcPoint {
  let best = npcs[0]
  let bd = dist(best, p)
  for (const n of npcs) {
    const d = dist(n, p)
    if (d < bd) {
      best = n
      bd = d
    }
  }
  return best
}

/**
 * stepMove に NPC の当たりを足したもの。NPC の円に入る歩みは、円の外側（円周）へ射影して円に沿って滑らせる
 * （斜めに押しつけても止まらず、正面でも円周ぴったりまで寄れる）。射影先が歩行マスク外・別の NPC の円内なら
 * x のみ・y のみに滑らせ、それも駄目ならその歩みだけ止まる。歩みは 1px 以下に刻むのですり抜けない。
 * すでに NPC の円の中にいるとき（開始位置・ワープ着地が重なった場合）は、最寄りの NPC から離れる向きだけ許す。
 * NPC が無い・円に当たらないときは stepMove と同一の結果。
 */
export function stepMoveAroundNpcs(
  mask: WalkMask,
  pos: Vec,
  vec: Vec,
  speed: number,
  dtMs: number,
  npcs: readonly NpcPoint[],
  radius: number = NPC_BLOCK_RADIUS
): MoveResult {
  const full = stepMove(mask, pos, vec, speed, dtMs)
  if (npcs.length === 0) return full
  const accepts = (from: Vec, to: Vec): boolean =>
    !blockedByNpc(npcs, to, radius) ||
    (blockedByNpc(npcs, from, radius) &&
      nearestNpcDistance(npcs, to) >= nearestNpcDistance(npcs, from))
  if (accepts(pos, full.pos)) return full

  const total = (speed * dtMs) / 1000
  if (total <= 0 || (vec.x === 0 && vec.y === 0)) return { pos, distance: 0 }
  const steps = Math.max(1, Math.ceil(total / 1))
  const dx = (vec.x * total) / steps
  const dy = (vec.y * total) / steps
  let cur = pos
  let moved = 0
  for (let i = 0; i < steps; i++) {
    const cands: Vec[] = [{ x: cur.x + dx, y: cur.y + dy }]
    const t = cands[0]
    if (!blockedByNpc(npcs, cur, radius) && blockedByNpc(npcs, t, radius)) {
      // 円周へ押し戻す（円の中心から t へ向かう向きに、半径の外側）。
      // 円にほぼ正面から押すと、射影の不安定平衡で約 90° 横へ回り込む（仕様。円周に沿って滑る向きは入力の微小なずれで決まる）
      const n = nearestNpc(npcs, t)
      const d = dist(n, t)
      if (d > 1e-9)
        cands.push({
          x: n.x + ((t.x - n.x) / d) * (radius + PUSH_EPS),
          y: n.y + ((t.y - n.y) / d) * (radius + PUSH_EPS),
        })
    }
    cands.push({ x: cur.x + dx, y: cur.y }, { x: cur.x, y: cur.y + dy })
    let next: Vec | null = null
    for (const c of cands) {
      if (c.x === cur.x && c.y === cur.y) continue
      if (isWalkable(mask, c.x, c.y) && accepts(cur, c)) {
        next = c
        break
      }
    }
    if (!next) break
    moved += dist(cur, next)
    cur = next
  }
  // 円周ぴったりでの浮動小数の揺れ（1e-3px 未満）は動いたことにしない
  return moved > 1e-3 ? { pos: cur, distance: moved } : { pos, distance: 0 }
}

const DIAG = Math.SQRT1_2
const FACING_VEC: Record<Facing8, Vec> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  upLeft: { x: -DIAG, y: -DIAG },
  upRight: { x: DIAG, y: -DIAG },
  downLeft: { x: -DIAG, y: DIAG },
  downRight: { x: DIAG, y: DIAG },
}

/**
 * 向いた方向の近傍にいる NPC の id（いちばん近い 1 人）。無ければ null。
 * 足元どうしの距離が reach 以内で、向きから coneDeg 以内の方角にいる NPC が対象。
 * 当たりの円に触れている・重なっている NPC は向きによらず対象にする。
 */
export function nearestTalkableNpc(
  npcs: readonly NpcPoint[],
  pos: Vec,
  facing: Facing8,
  reach: number = NPC_TALK_REACH,
  coneDeg: number = NPC_TALK_CONE_DEG
): string | null {
  const f = FACING_VEC[facing]
  const cosMin = Math.cos((coneDeg * Math.PI) / 180)
  // 円錐内を先に選ぶ（背後で円に触れているだけの NPC が、円錐内の少し遠い NPC より優先されないように）。円錐内が無ければ触れている NPC
  let bestCone: string | null = null
  let bestConeD = Infinity
  let bestTouch: string | null = null
  let bestTouchD = Infinity
  for (const n of npcs) {
    const d = dist(n, pos)
    if (d > reach) continue
    const inCone = d < 1e-6 || ((n.x - pos.x) * f.x + (n.y - pos.y) * f.y) / d >= cosMin - 1e-9
    if (inCone) {
      if (d < bestConeD) {
        bestCone = n.id
        bestConeD = d
      }
      continue
    }
    // 円に触れている（stepMoveAroundNpcs は円周 + 1e-6 で止めるので余裕を持たせる）なら向きによらず話せる
    if (d > NPC_BLOCK_RADIUS + NPC_TOUCH_SLACK) continue
    if (d < bestTouchD) {
      bestTouch = n.id
      bestTouchD = d
    }
  }
  return bestCone ?? bestTouch
}

/** クリックで近づく先に着いたか（足元どうしが NPC_APPROACH_STOP 以内） */
export function approachArrived(npc: Vec, pos: Vec): boolean {
  return dist(npc, pos) <= NPC_APPROACH_STOP
}

/** NPC の表示矩形（背景ピクセル。left/top は左上、right/bottom は右下） */
export interface NpcRect {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

/** クリック位置にある NPC の id。重なっていれば足元が下（手前）のものを選ぶ。無ければ null */
export function npcAtPoint(rects: readonly NpcRect[], p: Vec): string | null {
  let best: NpcRect | null = null
  for (const r of rects) {
    if (p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) continue
    if (!best || r.bottom > best.bottom) best = r
  }
  return best ? best.id : null
}

/** 会話・戦闘・遷移・ワープの状態 */
export interface FieldTalkState {
  battle: boolean
  talking: boolean
  transition: boolean
  warping: boolean
}

/** 歩行・ポインタ移動の入力を受けてよいか。戦闘中と会話中は不可 */
export function acceptsWalkInput(s: Pick<FieldTalkState, 'battle' | 'talking'>): boolean {
  return !s.battle && !s.talking
}

/** 話しかけを始めてよいか。戦闘・会話・遷移・ワープのどれかの最中は不可 */
export function canStartTalk(s: FieldTalkState): boolean {
  return !s.battle && !s.talking && !s.transition && !s.warping
}

/** 会話を始める決定キー（Space / Enter / Z） */
export const TALK_KEY_CODES: readonly string[] = ['Space', 'Enter', 'NumpadEnter', 'KeyZ']

/** 向き合う向き（NPC → 主人公の方角を 4 方向で） */
export function facingToward(from: Vec, to: Vec): 'up' | 'down' | 'left' | 'right' {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'down' : 'up'
}

/** ワープを始めてよいか。戦闘・会話・遷移・別のワープの最中は不可 */
export function canStartWarp(s: FieldTalkState): boolean {
  return !s.battle && !s.talking && !s.transition && !s.warping
}

/** フォーカス中の要素の種類。text = 文字入力（text 系 input・textarea・select）。other = ボタン・チェック・無し */
export type FocusKind = 'text' | 'other'

/** 決定キーの結果。ignore = 何もしない（ブラウザの既定動作も触らない）、swallow = 既定動作だけ止める */
export type TalkKeyDecision =
  | { action: 'ignore' }
  | { action: 'swallow' }
  | { action: 'advance' }
  | { action: 'start'; npcId: string }

export interface TalkKeyInput {
  code: string
  ctrl: boolean
  alt: boolean
  meta: boolean
  repeat: boolean
  focus: FocusKind
  state: FieldTalkState
  npcs: readonly NpcPoint[]
  pos: Vec
  facing: Facing8
}

/**
 * 決定キー (Space / Enter / Z) の扱いを決める。ignore のときは、呼び出し側はフォーカスも既定動作も触らない
 * （npcs が無い・向いた先に NPC がいない場合は常に ignore で、ツールバーのボタンを Space で押せる）。
 * 話しかけが成立する（start）か会話中（advance / swallow）のときだけ、呼び出し側はフォーカス中の要素を外してよい。
 */
export function decideTalkKey(i: TalkKeyInput): TalkKeyDecision {
  if (!TALK_KEY_CODES.includes(i.code) || i.ctrl || i.alt || i.meta) return { action: 'ignore' }
  if (i.state.battle) return { action: 'ignore' }
  if (i.focus === 'text') return { action: 'ignore' }
  if (i.state.talking) return i.repeat ? { action: 'swallow' } : { action: 'advance' }
  // 押しっぱなしの連打で、閉じた直後に開き直さない
  if (i.repeat || !canStartTalk(i.state)) return { action: 'ignore' }
  const npcId = nearestTalkableNpc(i.npcs, i.pos, i.facing)
  return npcId ? { action: 'start', npcId } : { action: 'ignore' }
}

/** クリックで近づいている最中の状態 */
export interface ApproachState {
  id: string
  stuckMs: number
}

/**
 * 1 フレームの移動の前。近づき先が消えた・方向キーが押された → 取り消し。着いた → arrived（話しかける）。
 * それ以外は継続。
 */
export function approachBeforeMove(
  approach: ApproachState | null,
  target: Vec | undefined,
  pos: Vec,
  directionKeyHeld: boolean
): { approach: ApproachState | null; arrived: boolean } {
  if (!approach) return { approach: null, arrived: false }
  if (!target || directionKeyHeld) return { approach: null, arrived: false }
  if (approachArrived(target, pos)) return { approach: null, arrived: true }
  return { approach, arrived: false }
}

/**
 * 1 フレームの移動の後。動けた距離があれば stuck をリセット、動けなければ加算する。
 * NPC_APPROACH_STUCK_MS 以上動けなければ打ち切り、話しかけが届く距離なら talk = true（届かなければ諦める）。
 */
export function approachAfterMove(
  approach: ApproachState,
  target: Vec,
  pos: Vec,
  moved: number,
  dtMs: number
): { approach: ApproachState | null; talk: boolean } {
  const stuckMs = moved > 0 ? 0 : approach.stuckMs + dtMs
  if (stuckMs >= NPC_APPROACH_STUCK_MS)
    return { approach: null, talk: dist(target, pos) <= NPC_TALK_REACH }
  return { approach: { ...approach, stuckMs }, talk: false }
}

/** 会話窓の大きさ（シーンの高さに比例。シーンごとに高さが違っても文字・箱が追従するように） */
export function dialogMetricsFor(sceneHeight: number): { boxHeight: number; fontSize: number } {
  return {
    boxHeight: Math.round(sceneHeight * 0.22),
    fontSize: Math.max(16, Math.round(sceneHeight * 0.04)),
  }
}

/**
 * NPC の置き場所の点検。歩行マスク外（歩けない）の足元は、主人公が近づけず話しかけも届かないことがあるので警告する。
 * 警告だけで NPC は残す。戻り値は警告メッセージの配列
 */
export function npcPlacementWarnings(
  mask: WalkMask,
  npcs: readonly NpcPoint[],
  sceneId: string
): string[] {
  const out: string[] = []
  for (const n of npcs)
    if (!isWalkable(mask, n.x, n.y))
      out.push(
        `scenes.${sceneId}.npcs "${n.id}" の足元 (${n.x}, ${n.y}) は歩行マスクの外（歩けない位置）です。話しかけられない・画面外に出る可能性があります`
      )
  return out
}
