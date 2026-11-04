/**
 * 一枚絵フィールドのプレイ統計（プレイ時間・歩数）の純粋関数 (#880)。DOM / PixiJS に触れない。
 *
 * - プレイ時間 `playMs`: プレイ時間(ms)の累計。FF 同様、メニュー中・戦闘中も進む（呼び出し側は止めない）。
 * - 歩数 `steps`: 歩いた距離を `stepDistance`（背景ピクセル。ランダムエンカウントの「1 歩 = stepDistance の移動」と同じ値）で割った整数部の累計。
 *   エンカウントのないシーンを歩いたぶんも数える。壁に押しつけて動けていないとき（距離 0）は増えない。歩かないメニュー中・戦闘中は増えない。
 * 保存対象は `playMs` と `steps`（`RpgSaveState`）。次の1歩に満たない端数 `remainder` は保存せず、再開時は 0 から数える。
 */
export interface PlayStats {
  playMs: number
  steps: number
  /** 次の1歩までに貯めた距離（背景ピクセル）。保存しない */
  remainder: number
}

export function initialPlayStats(saved?: { playMs?: number; steps?: number }): PlayStats {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  return {
    playMs: ok(saved?.playMs) ? saved.playMs : 0,
    steps: ok(saved?.steps) ? Math.floor(saved.steps) : 0,
    remainder: 0,
  }
}

/** プレイ時間を dt(ms) 進める。非有限・0 以下は変えない */
export function advancePlayTime(s: PlayStats, dtMs: number): PlayStats {
  return Number.isFinite(dtMs) && dtMs > 0 ? { ...s, playMs: s.playMs + dtMs } : s
}

/** 歩いた距離 `walked` を歩数に反映する。`stepDistance` が 0 以下・非有限、`walked` が 0 以下・非有限なら変えない */
export function advanceSteps(s: PlayStats, walked: number, stepDistance: number): PlayStats {
  if (
    !(walked > 0) ||
    !Number.isFinite(walked) ||
    !(stepDistance > 0) ||
    !Number.isFinite(stepDistance)
  )
    return s
  const total = s.remainder + walked
  const gained = Math.floor(total / stepDistance)
  return { ...s, steps: s.steps + gained, remainder: total - gained * stepDistance }
}
