/**
 * 一枚絵フィールドの脚本 `[NPC移動:]` (#1073) の実行キューと NPC 検索。DOM / PixiJS には触れない純粋寄りの部品。
 * 座標は背景ピクセル。位置の更新は渡された NPC オブジェクトを直接書き換える（描画側が毎フレーム読む）。
 */
import { stepNpcToward } from './fieldNpc'
import type { Vec } from './fieldWalk'

type Facing4 = 'up' | 'down' | 'left' | 'right'

/** 動かされる NPC。`x` / `y` / `facing` を持つ可変オブジェクト */
export interface MovableNpc {
  x: number
  y: number
  facing: Facing4
}

/** 脚本の `速度=` が省略されたときの既定（パーサの既定と同じ。タイル/秒） */
export const DEFAULT_NPC_MOVE_SPEED = 3

/**
 * `速度=`（タイル/秒）を検証する。0 以下・非有限は警告して既定（3）を返す。有効なら `speed` をそのまま返す
 */
export function resolveNpcSpeed(speed: number, warn: (msg: string) => void = console.warn): number {
  if (Number.isFinite(speed) && speed > 0) return speed
  warn(`[field] [NPC移動:] の 速度=${speed} は不正です（${DEFAULT_NPC_MOVE_SPEED} を使います）`)
  return DEFAULT_NPC_MOVE_SPEED
}

/** 名前で NPC を探す。名前が合うものを優先（同名は先頭）、無ければ id が合うもの。居なければ undefined */
export function pickNpcByName<T extends { id: string; def: { name: string } }>(
  npcs: readonly T[],
  name: string
): T | undefined {
  return npcs.find((n) => n.def.name === name) ?? npcs.find((n) => n.id === name)
}

export interface NpcMoveQueue<N extends MovableNpc> {
  /**
   * `npc` を `target` へ秒速 `pxPerSec`（背景 px）で直線に歩かせ始める。着いたら resolve する Promise を返す。
   * 同じ NPC が移動中なら、前の Promise を（着いた扱いで）resolve して打ち切り、新しい目標へ
   */
  start(npc: N, target: Vec, pxPerSec: number): Promise<void>
  /** `dtMs` ミリ秒だけ全部を進める。着いたものは resolve して取り除く（同時に着いても取りこぼさない） */
  tick(dtMs: number): void
  /** 動いている移動の数 */
  size(): number
  /** 動いている移動を全部打ち切り、resolve する（場面が変わったときなど。イベントを止めたままにしない） */
  clear(): void
}

export function createNpcMoveQueue<N extends MovableNpc = MovableNpc>(): NpcMoveQueue<N> {
  interface Move {
    npc: N
    target: Vec
    pxPerSec: number
    done: () => void
  }
  let moves: Move[] = []
  return {
    start(npc, target, pxPerSec) {
      return new Promise<void>((resolve) => {
        const prev = moves.filter((m) => m.npc === npc)
        moves = moves.filter((m) => m.npc !== npc)
        moves.push({ npc, target, pxPerSec, done: resolve })
        for (const m of prev) m.done()
      })
    },
    tick(dtMs) {
      const finished: Move[] = []
      const remaining: Move[] = []
      for (const m of moves) {
        const r = stepNpcToward(m.npc, m.npc.facing, m.target, (m.pxPerSec * dtMs) / 1000)
        m.npc.x = r.x
        m.npc.y = r.y
        m.npc.facing = r.facing
        if (r.arrived) finished.push(m)
        else remaining.push(m)
      }
      moves = remaining
      for (const m of finished) m.done()
    },
    size: () => moves.length,
    clear() {
      const all = moves
      moves = []
      for (const m of all) m.done()
    },
  }
}
