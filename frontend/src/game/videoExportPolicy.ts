/**
 * 動画書き出し (#228) の終了・自動選択まわりの純粋計算 (#780)。
 * レンダラ・タイマー・DOM に触れない。VideoExporter が配線し、ここで境界値をテストする。
 */

/** 選択肢に到達して自動で選ぶ遷移先が無いとき、選択肢を映してから録画を終えるまでの時間 ms */
export const EXPORT_CHOICE_HOLD_MS = 3000
/** 本文・選択肢が一切進まない状態がこの時間続いたら、録画を終える ms */
export const EXPORT_STALL_TIMEOUT_MS = 60_000
/** 範囲内へ自動で選ぶ選択肢を、選ぶ前に映しておく時間 ms（視聴者が選択肢を目にできるようにする） */
export const EXPORT_AUTO_CHOICE_DISPLAY_MS = 1500
/** 書き出し中に選択肢到達・停滞を見張る間隔 ms */
export const EXPORT_POLL_MS = 250
/** 1回の書き出しで自動選択する選択肢の上限（範囲内を行き来するループで録画が終わらなくなるのを防ぐ） */
export const EXPORT_MAX_AUTO_CHOICES = 50

/** 録画が終わった理由 */
export type ExportEndReason =
  /** 終了シーンを抜けた */
  | 'scene-end'
  /** 全イベントを完走した */
  | 'story-end'
  /** 選択肢で、範囲内に進む遷移先が無かった（または自動選択の上限に達した） */
  | 'choice-end'
  /** 一定時間進まなかった */
  | 'stalled'

/**
 * `sceneId` が書き出し範囲（開始〜終了、両端を含む）にあるか。順序は `orderedSceneIds`（シーン一覧）。
 * 終了が開始より前に並んでいても、2つの間を範囲とする。一覧に無いシーンは範囲外。
 */
export function isSceneInExportRange(
  sceneId: string,
  startSceneId: string,
  endSceneId: string,
  orderedSceneIds: readonly string[]
): boolean {
  const i = orderedSceneIds.indexOf(sceneId)
  const s = orderedSceneIds.indexOf(startSceneId)
  const e = orderedSceneIds.indexOf(endSceneId)
  if (i < 0 || s < 0 || e < 0) return false
  return i >= Math.min(s, e) && i <= Math.max(s, e)
}

/**
 * 選択肢の「辺」の記憶。辺は「選択肢の位置 × 遷移先」。位置は `sceneId:eventIndex`。
 * 自動選択がどの辺を選んだか（`selected`）と、これまでに見た選択肢（`observed`）を持つ。
 */
export interface ExportChoiceMemory {
  /** 選んだ辺（`${choiceKey}→${jump}`） */
  selected: Set<string>
  /** 見た選択肢。キーは choiceKey。遷移先はロックされていないものだけ */
  observed: Map<string, { sceneId: string | null; jumps: string[] }>
}

export function createChoiceMemory(): ExportChoiceMemory {
  return { selected: new Set(), observed: new Map() }
}

const edgeKey = (choiceKey: string, jump: string): string => `${choiceKey}→${jump}`

/** 見た選択肢を記録する（同じ位置は上書き。何度呼んでもよい）。 */
export function recordChoice(
  memory: ExportChoiceMemory,
  choiceKey: string,
  sceneId: string | null,
  options: ReadonlyArray<{ jump: string; locked: boolean }>
): void {
  memory.observed.set(choiceKey, {
    sceneId,
    jumps: options.filter((o) => !o.locked).map((o) => o.jump),
  })
}

/** 選んだ辺を記録する。 */
export function markChoiceSelected(
  memory: ExportChoiceMemory,
  choiceKey: string,
  jump: string
): void {
  memory.selected.add(edgeKey(choiceKey, jump))
}

/** `sceneId` から先に、まだ選んでいない範囲内の辺へ辿り着ける（既に見た選択肢をたどって）か。 */
function hasUnexploredRoute(
  sceneId: string,
  memory: ExportChoiceMemory,
  inRange: (id: string) => boolean,
  seen: Set<string>
): boolean {
  if (seen.has(sceneId)) return false
  seen.add(sceneId)
  for (const [key, choice] of memory.observed) {
    if (choice.sceneId !== sceneId) continue
    for (const jump of choice.jumps) {
      if (!inRange(jump)) continue
      if (!memory.selected.has(edgeKey(key, jump))) return true
      if (hasUnexploredRoute(jump, memory, inRange, seen)) return true
    }
  }
  return false
}

/**
 * 選択肢のうち自動で選ぶ遷移先を返す。無ければ null（＝終端扱い）。
 * ロックされておらず遷移先が書き出し範囲内の option のうち、
 * 1. まだ選んでいない辺（この選択肢の位置 × 遷移先）の先頭を優先する。
 * 2. 無ければ、選び済みの辺でも、その先にまだ選んでいない範囲内の辺へ辿り着けるものを選ぶ。
 * 辺単位にするのは、ハブ→サブメニュー→各ルート→ハブの構成で、サブメニューの2つ目以降のルートを
 * 取りこぼさず、かつ同じ辺を延々選び続けないため。
 */
export function pickAutoChoice(
  options: ReadonlyArray<{ jump: string; locked: boolean }>,
  startSceneId: string,
  endSceneId: string,
  orderedSceneIds: readonly string[],
  memory: ExportChoiceMemory,
  choiceKey: string
): string | null {
  const inRange = (id: string) =>
    isSceneInExportRange(id, startSceneId, endSceneId, orderedSceneIds)
  const candidates = options.filter((o) => !o.locked && inRange(o.jump))
  const fresh = candidates.find((o) => !memory.selected.has(edgeKey(choiceKey, o.jump)))
  if (fresh) return fresh.jump
  const route = candidates.find((o) => hasUnexploredRoute(o.jump, memory, inRange, new Set()))
  return route ? route.jump : null
}

/**
 * 停滞とみなすまでの時間 ms。`[待機: N]`（`waitMs`）中は、指定時間ぶんを加えた長さにする
 * （長い待機を停滞と誤認しない）。
 */
export function computeStallLimitMs(stallTimeoutMs: number, waitMs: number | null): number {
  return stallTimeoutMs + (waitMs !== null && waitMs > 0 ? waitMs : 0)
}

/** 進行位置の署名。前回と同じなら「進んでいない」。 */
export function exportProgressSignature(pos: {
  sceneId: string | null
  eventIndex: number
  textIndex: number
  sentenceIndex: number
}): string {
  return `${pos.sceneId ?? ''}:${pos.eventIndex}:${pos.textIndex}:${pos.sentenceIndex}`
}
