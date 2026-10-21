/** 脚本の台詞・知らせ (#741) を見せる時間 */
import { describe, expect, it } from 'vitest'
import {
  ACTION_GAP_MS,
  LINE_BASE_MS,
  LINE_MAX_MS,
  LINE_PER_CHAR_MS,
  NOTICE_MS,
  eventTimeline,
  lineDurationMs,
} from './battleMotion'
import type { BattleActionEvent } from './battleEngine'

const notice = (label: string | undefined, line?: true): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind: 'notice',
  ...(label !== undefined ? { label } : {}),
  ...(line ? { line } : {}),
  hits: [],
})

describe('lineDurationMs', () => {
  it('基本 + 字数。上限で止まる。空・未指定は基本だけ（サロゲートペアも 1 字）', () => {
    expect(lineDurationMs('')).toBe(LINE_BASE_MS)
    expect(lineDurationMs(undefined)).toBe(LINE_BASE_MS)
    expect(lineDurationMs('あいう')).toBe(LINE_BASE_MS + 3 * LINE_PER_CHAR_MS)
    expect(lineDurationMs('𠮷𠮷')).toBe(LINE_BASE_MS + 2 * LINE_PER_CHAR_MS)
    expect(lineDurationMs('あ'.repeat(1000))).toBe(LINE_MAX_MS)
  })
})

describe('eventTimeline: line の notice', () => {
  it('line 付きは台詞の長さぶん、付かない notice は従来の固定時間（旧挙動不変）', () => {
    const plain = eventTimeline(notice('にげられない！'))
    expect(plain.duration).toBe(NOTICE_MS + ACTION_GAP_MS)
    const line = eventTimeline(notice('ボス「かかってこい」', true))
    expect(line.duration).toBe(lineDurationMs('ボス「かかってこい」') + ACTION_GAP_MS)
    expect(line.duration).toBeGreaterThan(plain.duration)
    expect(line.hitAt).toBe(0)
  })
})
