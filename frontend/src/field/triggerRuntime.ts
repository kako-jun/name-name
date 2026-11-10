/**
 * 一枚絵フィールドの脚本トリガー (#1072) の判定。副作用のない純関数だけ（startFieldGame.ts が呼ぶ）。
 * 発火のあとの実行（待ち行列・イベントの実行・once の記録）は呼び出し側の仕事。
 */
import type { FieldTrigger } from './config'

/** 発火するトリガー 1 件。`key` は once の記録用（`<場面ID>#<添字>`）、`event` は脚本の `[イベント]` の名前 */
export interface FiredTrigger {
  key: string
  event: string
  once: boolean
}

/** once の記録用キー。場面 ID と、その場面の `triggers` の添字 */
export function triggerKey(sceneId: string, index: number): string {
  return `${sceneId}#${index}`
}

/** 足元 `pos` が円（中心 `(x, y)`・半径 `radius`）の中か。円周上は内側（`<=`） */
export function isInsideCircle(
  pos: { x: number; y: number },
  center: { x: number; y: number },
  radius: number
): boolean {
  return Math.hypot(pos.x - center.x, pos.y - center.y) <= radius
}

/**
 * 踏み込みトリガー（`auto: false`）の入退場を 1 歩ぶん進める。
 * - 返す `inside` は新しい集合（入力は変更しない）。いま円の中にあるトリガーの添字だけが入る
 * - 前の `inside` に無く、いま円の中に入ったものが `fired`（添字順）。中にいる間は繰り返さず、出てから入り直すと再び出る
 * - `once` で `onceFired` に `triggerKey(sceneId, 添字)` があるものは、`inside` には入るが `fired` には出さない
 * - 場面に入った直後は `inside` を空にして呼ぶ（その地点がすでに円の中なら入った扱いで発火する）
 */
export function stepTriggers(input: {
  sceneId: string
  pos: { x: number; y: number }
  triggers: readonly FieldTrigger[]
  inside: ReadonlySet<number>
  onceFired: ReadonlySet<string>
}): { inside: Set<number>; fired: FiredTrigger[] } {
  const inside = new Set<number>()
  const fired: FiredTrigger[] = []
  input.triggers.forEach((t, i) => {
    if (t.auto || !isInsideCircle(input.pos, t, t.radius)) return
    inside.add(i)
    if (input.inside.has(i)) return
    const key = triggerKey(input.sceneId, i)
    if (t.once && input.onceFired.has(key)) return
    fired.push({ key, event: t.event, once: t.once })
  })
  return { inside, fired }
}

/**
 * 場面に入ったときに起こす `auto: true` のトリガーを、書いた順に返す。
 * `once` で `onceFired` に記録済みのものは除く。`resumedStart` が true（セーブから再開した直後の最初の場面）なら空
 * （始まりの演出を再生し直さない。踏み込みの `stepTriggers` には影響しない）。
 */
export function autoTriggers(input: {
  sceneId: string
  triggers: readonly FieldTrigger[]
  onceFired: ReadonlySet<string>
  resumedStart: boolean
}): FiredTrigger[] {
  if (input.resumedStart) return []
  const out: FiredTrigger[] = []
  input.triggers.forEach((t, i) => {
    if (!t.auto) return
    const key = triggerKey(input.sceneId, i)
    if (t.once && input.onceFired.has(key)) return
    out.push({ key, event: t.event, once: t.once })
  })
  return out
}
