/**
 * 動画書き出し (#228) の終了・自動選択まわりの純粋計算 (#780)。
 * レンダラ・タイマー・DOM に触れない。VideoExporter が配線し、ここで境界値をテストする。
 */

/** 選択肢に到達して自動で選ぶ遷移先が無いとき、選択肢を映してから録画を終えるまでの時間 ms */
export const EXPORT_CHOICE_HOLD_MS = 3000
/** 本文・選択肢が一切進まない状態がこの時間続いたら、録画を終える ms */
export const EXPORT_STALL_TIMEOUT_MS = 60_000
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
 * 選択肢のうち自動で選ぶ遷移先を返す。ロックされていない option のうち、遷移先が書き出し範囲内の
 * 先頭のもの。無ければ null（＝終端扱い）。
 */
export function pickAutoChoice(
  options: ReadonlyArray<{ jump: string; locked: boolean }>,
  startSceneId: string,
  endSceneId: string,
  orderedSceneIds: readonly string[]
): string | null {
  for (const o of options) {
    if (o.locked) continue
    if (isSceneInExportRange(o.jump, startSceneId, endSceneId, orderedSceneIds)) return o.jump
  }
  return null
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
