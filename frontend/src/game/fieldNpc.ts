/**
 * 一枚絵フィールドの NPC (#841 段階1) の純粋関数群。DOM / PixiJS には触れない。
 *
 * 座標は fieldWalk.ts と同じ背景ピクセル。NPC の位置 = 足元の 1 点。
 * - 当たり判定: NPC の足元を中心とする半径 NPC_BLOCK_RADIUS の円に、主人公の足元が入れない。
 * - 話しかけ: 向いた方向（円錐）の近傍 NPC を 1 人選ぶ。クリックされた NPC は近づいてから話しかける。
 * - 会話中は歩行入力・ポインタ移動・エンカウント・ワープ・端リンクを止める（呼び出し側が acceptsWalkInput で判定）。
 */
import { stepMove, type Facing8, type MoveResult, type Vec, type WalkMask } from './fieldWalk'

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

/**
 * stepMove に NPC の当たりを足したもの。進めなければ x のみ・y のみに滑らせ、それも NPC に入るなら動かない。
 * すでに NPC の円の中にいるとき（開始位置・ワープ着地が重なった場合）は、最寄りの NPC から離れる向きだけ許す。
 * NPC が無ければ stepMove と同一の結果。
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
  const inside = blockedByNpc(npcs, pos, radius)
  const ok = (p: Vec): boolean =>
    !blockedByNpc(npcs, p, radius) ||
    (inside && nearestNpcDistance(npcs, p) >= nearestNpcDistance(npcs, pos))
  if (ok(full.pos)) return full
  const tries: Vec[] = [
    { x: vec.x, y: 0 },
    { x: 0, y: vec.y },
  ]
  for (const v of tries) {
    if (v.x === 0 && v.y === 0) continue
    const r = stepMove(mask, pos, v, speed, dtMs)
    if (r.distance > 0 && ok(r.pos)) return r
  }
  return { pos, distance: 0 }
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
 * 当たりの円に重なっている（ほぼ真上にいる）NPC は向きによらず対象にする。
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
  let best: string | null = null
  let bestD = Infinity
  for (const n of npcs) {
    const d = dist(n, pos)
    if (d > reach) continue
    const inCone = d < 1e-6 || ((n.x - pos.x) * f.x + (n.y - pos.y) * f.y) / d >= cosMin - 1e-9
    if (!inCone && d >= NPC_BLOCK_RADIUS) continue
    if (d < bestD) {
      best = n.id
      bestD = d
    }
  }
  return best
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

/**
 * NPC の zIndex。主人公（WORLD_Z.player = 10）より足元が下なら手前（10.5〜）、上なら奥（〜9.9）。
 * NPC どうしは足元 y が大きいほど手前。範囲は 9.5〜10.9 に収まり、前面レイヤー (20) より常に奥
 */
export function npcZ(npcFeetY: number, playerFeetY: number, sceneHeight: number): number {
  const t = sceneHeight > 0 ? Math.min(1, Math.max(0, npcFeetY / sceneHeight)) : 0
  const base = npcFeetY > playerFeetY ? 10.5 : 9.5
  return base + t * 0.4
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
