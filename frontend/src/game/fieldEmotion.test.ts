/**
 * フィールドの感情吹き出し (#937) の純粋関数: 設定の検証・時間で消える・コマ送り・動き・置き換え・位置。
 */
import { describe, expect, it } from 'vitest'
import {
  EMOTION_DEFAULT_DURATION_MS,
  EMOTION_DEFAULT_FRAME_MS,
  EMOTION_MAX_DURATION_MS,
  EMOTION_POP_MS,
  INITIAL_EMOTION_STATE,
  emotionAnchor,
  emotionFrameAt,
  emotionFrameRect,
  emotionMotionScale,
  emotionView,
  hasEmotions,
  isCompanionShown,
  isEmotionTarget,
  normalizeEmotionDuration,
  npcEmotionTarget,
  parseEmotions,
  startEmotion,
  stepEmotions,
  type EmotionSheet,
  type EmotionSheets,
} from './fieldEmotion'

const sheet = (over: Partial<EmotionSheet> = {}): EmotionSheet => ({
  image: 'a.png',
  frames: 1,
  columns: 1,
  frameMs: 100,
  durationMs: 1000,
  offset: { x: 0, y: 0 },
  scale: 1,
  motion: 'none',
  ...over,
})
const sheets: EmotionSheets = { '!': sheet(), '?': sheet({ durationMs: 500 }) }

describe('parseEmotions', () => {
  it('未指定は空・警告なし', () => {
    expect(parseEmotions(undefined)).toEqual({ emotions: {}, warnings: [] })
    expect(parseEmotions(null)).toEqual({ emotions: {}, warnings: [] })
  })

  it('最小宣言（image だけ）は 1 枚絵・既定値で読める', () => {
    const r = parseEmotions({ '!': { image: 'bang.png' } })
    expect(r.warnings).toEqual([])
    expect(r.emotions['!']).toEqual({
      image: 'bang.png',
      frames: 1,
      columns: 1,
      frameMs: EMOTION_DEFAULT_FRAME_MS,
      durationMs: EMOTION_DEFAULT_DURATION_MS,
      offset: { x: 0, y: 0 },
      scale: 1,
      motion: 'none',
    })
  })

  it('全項目を宣言できる。resolve で URL が解決される', () => {
    const r = parseEmotions(
      {
        '...': {
          image: 'dots.png',
          frames: 6,
          columns: 3,
          frameMs: 90,
          durationMs: 2000,
          offset: { x: 4, y: -10 },
          scale: 2,
          motion: 'pop',
        },
      },
      (u) => `http://x/${u}`
    )
    expect(r.warnings).toEqual([])
    expect(r.emotions['...']).toEqual({
      image: 'http://x/dots.png',
      frames: 6,
      columns: 3,
      frameMs: 90,
      durationMs: 2000,
      offset: { x: 4, y: -10 },
      scale: 2,
      motion: 'pop',
    })
  })

  it('不正な種類だけ警告して無視し、正しい種類は残る', () => {
    const r = parseEmotions({
      ok: { image: 'a.png' },
      noImage: {},
      badFrames: { image: 'a.png', frames: 0 },
      badColumns: { image: 'a.png', frames: 2, columns: 3 },
      badMs: { image: 'a.png', frameMs: -1 },
      badDur: { image: 'a.png', durationMs: 0 },
      badDurBig: { image: 'a.png', durationMs: 999999 },
      badOffset: { image: 'a.png', offset: { x: 1 } },
      badScale: { image: 'a.png', scale: 0 },
      badMotion: { image: 'a.png', motion: 'spin' },
      notObj: 5,
      '': { image: 'a.png' },
      thisKeyIsFarTooLongToUse: { image: 'a.png' },
    })
    expect(Object.keys(r.emotions)).toEqual(['ok'])
    expect(r.warnings).toHaveLength(12)
    expect(r.warnings.join('\n')).toContain('emotions.badMotion.motion')
  })

  it('種類名の長さはコードポイントで数える（絵文字は 1 文字）', () => {
    const ok = '😀'.repeat(16)
    const ng = '😀'.repeat(17)
    const r = parseEmotions({ [ok]: { image: 'a.png' }, [ng]: { image: 'a.png' } })
    expect(Object.keys(r.emotions)).toEqual([ok])
    expect(r.warnings).toHaveLength(1)
  })

  it('URL を解決できない種類は無視する', () => {
    const r = parseEmotions({ '!': { image: 'a.png' } }, () => null)
    expect(r.emotions).toEqual({})
    expect(r.warnings[0]).toContain('URL を解決できません')
  })

  it('オブジェクトでない emotions は警告して無視する。__proto__ は種類にしない', () => {
    expect(parseEmotions([]).warnings).toHaveLength(1)
    expect(parseEmotions('x').emotions).toEqual({})
    const r = parseEmotions(JSON.parse('{"__proto__":{"image":"a.png"}}'))
    expect(Object.keys(r.emotions)).toEqual([])
    expect(({} as Record<string, unknown>).image).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
  })

  it('hasEmotions: 宣言があるときだけ true', () => {
    expect(hasEmotions(undefined)).toBe(false)
    expect(hasEmotions({})).toBe(false)
    expect(hasEmotions(sheets)).toBe(true)
  })
})

describe('emotionFrameAt / emotionFrameRect', () => {
  it('コマを frameMs ごとに送り、表示時間が長ければ繰り返す', () => {
    const s = { frames: 3, frameMs: 100 }
    expect(emotionFrameAt(s, 0)).toBe(0)
    expect(emotionFrameAt(s, 99)).toBe(0)
    expect(emotionFrameAt(s, 100)).toBe(1)
    expect(emotionFrameAt(s, 299)).toBe(2)
    expect(emotionFrameAt(s, 300)).toBe(0)
  })
  it('1 枚絵は常に 0 コマ目。負・非有限は 0', () => {
    expect(emotionFrameAt({ frames: 1, frameMs: 100 }, 5000)).toBe(0)
    expect(emotionFrameAt({ frames: 3, frameMs: 100 }, -5)).toBe(0)
    expect(emotionFrameAt({ frames: 3, frameMs: 100 }, NaN)).toBe(0)
  })
  it('矩形はエフェクトと同じ割り方（左→右・上→下）', () => {
    expect(emotionFrameRect({ frames: 4, columns: 2 }, 64, 64, 3)).toEqual({
      x: 32,
      y: 32,
      w: 32,
      h: 32,
    })
  })
})

describe('emotionMotionScale / emotionView', () => {
  it('none は常に 1', () => {
    expect(emotionMotionScale('none', 0)).toBe(1)
  })
  it('pop は小さい所から始まり、いったん大きくなって 1 に収まる', () => {
    expect(emotionMotionScale('pop', 0)).toBeCloseTo(0.4)
    expect(emotionMotionScale('pop', EMOTION_POP_MS * 0.6)).toBeCloseTo(1.2)
    expect(emotionMotionScale('pop', EMOTION_POP_MS)).toBe(1)
    expect(emotionMotionScale('pop', 5000)).toBe(1)
    expect(emotionMotionScale('pop', -3)).toBeCloseTo(0.4)
  })
  it('view: コマと拡大（宣言の scale × 動き）', () => {
    const s = sheet({ frames: 2, columns: 2, frameMs: 50, scale: 2, motion: 'pop' })
    expect(emotionView({ kind: '!', elapsed: 0 }, s)).toEqual({ frame: 0, scale: 2 * 0.4 })
    expect(emotionView({ kind: '!', elapsed: 500 }, s)).toEqual({ frame: 0, scale: 2 })
    expect(emotionView({ kind: '!', elapsed: 60 }, s).frame).toBe(1)
  })
})

describe('startEmotion / stepEmotions', () => {
  it('出すと経過 0 で始まる。宣言の無い種類・未知の人物・宣言なしは state を変えない', () => {
    const st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets)
    expect(st).toEqual({ player: { kind: '!', elapsed: 0 } })
    expect(startEmotion(st, 'player', 'zzz', sheets)).toBe(st)
    expect(startEmotion(st, 'player', 'toString', sheets)).toBe(st)
    expect(startEmotion(st, 'nobody' as 'player', '!', sheets)).toBe(st)
    expect(startEmotion(st, 'player', '!', undefined)).toBe(st)
    expect(startEmotion(st, 'player', '!', {})).toBe(st)
  })

  it('持続を渡すと 1 回だけ宣言の durationMs を上書きする（#946）', () => {
    let st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets, 300) // 宣言は 1000ms
    expect(st).toEqual({ player: { kind: '!', elapsed: 0, durationMs: 300 } })
    st = stepEmotions(st, 299, sheets)
    expect(st.player).toBeDefined()
    expect(stepEmotions(st, 1, sheets)).toEqual({})
    // 宣言より長くもできる
    let long = startEmotion(INITIAL_EMOTION_STATE, 'player', '?', sheets, 2000) // 宣言は 500ms
    long = stepEmotions(long, 1999, sheets)
    expect(long.player?.durationMs).toBe(2000)
    expect(stepEmotions(long, 1, sheets)).toEqual({})
  })

  it('持続は上限に収め、0 以下・非有限・省略は宣言どおり（キーも付かない）', () => {
    const over = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets, 999999)
    expect(over.player?.durationMs).toBe(EMOTION_MAX_DURATION_MS)
    for (const bad of [0, -5, NaN, Infinity, undefined, '300' as unknown as number]) {
      const st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets, bad)
      expect(st).toEqual({ player: { kind: '!', elapsed: 0 } })
      expect('durationMs' in st.player!).toBe(false)
    }
    // 上書きは次に出した吹き出しへ持ち越さない
    let st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets, 300)
    st = startEmotion(st, 'player', '!', sheets)
    expect(st.player?.durationMs).toBeUndefined()
    expect(stepEmotions(stepEmotions(st, 300, sheets), 600, sheets).player).toBeDefined()
  })

  it('元の state は書き換えない', () => {
    const before = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets)
    const copy = JSON.stringify(before)
    stepEmotions(before, 100, sheets)
    startEmotion(before, 'player', '?', sheets)
    expect(JSON.stringify(before)).toBe(copy)
    expect(INITIAL_EMOTION_STATE).toEqual({})
  })

  it('時間が進み、durationMs に達すると消える（種類ごとの長さ）', () => {
    let st = startEmotion(INITIAL_EMOTION_STATE, 'player', '?', sheets) // 500ms
    st = stepEmotions(st, 499, sheets)
    expect(st.player?.elapsed).toBe(499)
    st = stepEmotions(st, 1, sheets)
    expect(st).toEqual({})
    let st2 = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets) // 1000ms
    st2 = stepEmotions(st2, 999, sheets)
    expect(st2.player).toBeDefined()
    expect(stepEmotions(st2, 1, sheets)).toEqual({})
  })

  it('同じ人物に続けて出すと置き換わる（時間も 0 から）。別の人物は独立', () => {
    let st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets)
    st = stepEmotions(st, 700, sheets)
    st = startEmotion(st, 'companion', '?', sheets)
    st = startEmotion(st, 'player', '?', sheets)
    expect(st).toEqual({
      player: { kind: '?', elapsed: 0 },
      companion: { kind: '?', elapsed: 0 },
    })
    st = stepEmotions(st, 300, sheets)
    expect(st.player?.elapsed).toBe(300)
  })

  it('負・非有限の dt は 0 として扱う。宣言が無くなった種類は消す', () => {
    const st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets)
    expect(stepEmotions(st, -50, sheets).player?.elapsed).toBe(0)
    expect(stepEmotions(st, NaN, sheets).player?.elapsed).toBe(0)
    expect(stepEmotions(st, 10, undefined)).toEqual({})
  })
})

describe('emotionAnchor', () => {
  it('頭の位置に offset を足す（y が負で上）', () => {
    expect(emotionAnchor({ x: 100, y: 50 }, { offset: { x: 3, y: -8 } })).toEqual({ x: 103, y: 42 })
  })
})

describe('isCompanionShown', () => {
  it('assist・companion があり不透明度が正のときだけ true', () => {
    expect(isCompanionShown(true, true, 0.5)).toBe(true)
    expect(isCompanionShown(true, true, 1)).toBe(true)
  })
  it('不透明度 0 は false', () => {
    expect(isCompanionShown(true, true, 0)).toBe(false)
  })
  it('assist か companion が無ければ false', () => {
    expect(isCompanionShown(false, true, 1)).toBe(false)
    expect(isCompanionShown(true, false, 1)).toBe(false)
  })
})

describe('NPC 対象と持続の正規化 (#946)', () => {
  it('isEmotionTarget: 固定の人物と npc:<id>（id 非空）だけ有効', () => {
    expect(isEmotionTarget('player')).toBe(true)
    expect(isEmotionTarget('companion')).toBe(true)
    expect(isEmotionTarget('npc:neighbor-kid')).toBe(true)
    expect(isEmotionTarget('npc:')).toBe(false)
    expect(isEmotionTarget('npc')).toBe(false)
    expect(isEmotionTarget('hero')).toBe(false)
  })

  it('NPC にも出せて、固定の人物と独立に 1 件ずつ持ち、同じ NPC は置き換わる', () => {
    const t = npcEmotionTarget('kid')
    expect(t).toBe('npc:kid')
    let st = startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets)
    st = startEmotion(st, t, '?', sheets)
    expect(st.player?.kind).toBe('!')
    expect(st[t]?.kind).toBe('?')
    st = startEmotion(st, t, '!', sheets)
    expect(st[t]).toEqual({ kind: '!', elapsed: 0 })
    // 時間が経てば NPC の分も消える（?: 500ms ではなく置き換えた !: 1000ms）
    expect(stepEmotions(st, 999, sheets)[t]).toBeDefined()
    expect(stepEmotions(st, 1000, sheets)[t]).toBeUndefined()
  })

  it('不正な対象（npc: だけ・未知）は何もしない', () => {
    expect(startEmotion(INITIAL_EMOTION_STATE, 'npc:' as never, '!', sheets)).toBe(
      INITIAL_EMOTION_STATE
    )
    expect(startEmotion(INITIAL_EMOTION_STATE, 'x' as never, '!', sheets)).toBe(
      INITIAL_EMOTION_STATE
    )
  })

  it('normalizeEmotionDuration: floor して 1 以上のときだけ採用、上限に収める', () => {
    expect(normalizeEmotionDuration(1200.9)).toBe(1200)
    expect(normalizeEmotionDuration(1)).toBe(1)
    expect(normalizeEmotionDuration(0.5)).toBeUndefined() // floor して 0
    expect(normalizeEmotionDuration(0)).toBeUndefined()
    expect(normalizeEmotionDuration(-5)).toBeUndefined()
    expect(normalizeEmotionDuration(NaN)).toBeUndefined()
    expect(normalizeEmotionDuration('300')).toBeUndefined()
    expect(normalizeEmotionDuration(EMOTION_MAX_DURATION_MS + 1)).toBe(EMOTION_MAX_DURATION_MS)
  })

  it('startEmotion も同じ規則（小数は floor・0<d<1 は宣言どおり）', () => {
    expect(startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets, 300.7).player).toEqual({
      kind: '!',
      elapsed: 0,
      durationMs: 300,
    })
    expect(
      startEmotion(INITIAL_EMOTION_STATE, 'player', '!', sheets, 0.5).player?.durationMs
    ).toBeUndefined()
  })
})
