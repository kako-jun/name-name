import { describe, expect, it } from 'vitest'
import {
  BATTLE_POSES,
  DEFAULT_MOTION_TIMING,
  SNAPPY_MOTION_TIMING,
  normalizePoses,
  resolvePose,
  sampleActor,
  type BattlePose,
} from './battleMotion'

const seq = (
  kind: Parameters<typeof sampleActor>[0],
  total: number,
  T = DEFAULT_MOTION_TIMING,
  avail: Partial<Record<BattlePose, unknown>> = {}
) => {
  const out: BattlePose[] = []
  for (let t = 0; t < total; t += 1) {
    const p = sampleActor(kind, t, T, avail).pose
    if (out[out.length - 1] !== p) out.push(p)
  }
  return out
}
const T = DEFAULT_MOTION_TIMING
const attackLen = T.attackStepMs + T.attackSlashMs + T.attackReturnMs + 10

describe('新ポーズ special / swing-windup / swing-followthrough (#1026)', () => {
  it('ポーズ名として受け付ける（大小・空白無視、未知は捨てる）', () => {
    expect(BATTLE_POSES).toEqual(
      expect.arrayContaining(['special', 'swing-windup', 'swing-followthrough'])
    )
    expect(
      normalizePoses({
        Special: 'a',
        ' swing-windup ': 'b',
        'swing-followthrough': 'c',
        bogus: 'x',
      })
    ).toEqual({ special: 'a', 'swing-windup': 'b', 'swing-followthrough': 'c' })
  })

  it('フォールバック: special→cast、windup→ready、followthrough→slash', () => {
    expect(resolvePose('special', { cast: 1 })?.pose).toBe('cast')
    expect(resolvePose('special', { special: 1, cast: 2 })?.pose).toBe('special')
    expect(resolvePose('swing-windup', { ready: 1 })?.pose).toBe('ready')
    expect(resolvePose('swing-followthrough', { slash: 1 })?.pose).toBe('slash')
  })

  it('絵が無ければ通常攻撃は従来どおり（default 不変）', () => {
    expect(seq('attack', attackLen)).toEqual(['step', 'slash', 'step', 'idle'])
    expect(seq('attack', attackLen, T, { slash: 1, ready: 1 })).toEqual([
      'step',
      'slash',
      'step',
      'idle',
    ])
  })

  it('両方あれば 5 段: ready→windup→slash→followthrough→ready→idle', () => {
    const a = { 'swing-windup': 1, 'swing-followthrough': 1 }
    expect(seq('attack', attackLen, T, a)).toEqual([
      'ready',
      'swing-windup',
      'slash',
      'swing-followthrough',
      'ready',
      'idle',
    ])
  })

  it('片方だけなら、無い段は飛ばす', () => {
    expect(seq('attack', attackLen, T, { 'swing-windup': 1 })).toEqual([
      'ready',
      'swing-windup',
      'slash',
      'step',
      'idle',
    ])
    expect(seq('attack', attackLen, T, { 'swing-followthrough': 1 })).toEqual([
      'step',
      'slash',
      'swing-followthrough',
      'ready',
      'idle',
    ])
  })

  it('段の境界は MotionTiming で設定できる（default 110ms / snappy 65ms）', () => {
    const a = { 'swing-windup': 1, 'swing-followthrough': 1 }
    expect(sampleActor('attack', T.attackStepMs - T.attackWindupMs - 1, T, a).pose).toBe('ready')
    expect(sampleActor('attack', T.attackStepMs - T.attackWindupMs, T, a).pose).toBe('swing-windup')
    const S = SNAPPY_MOTION_TIMING
    expect(S.attackWindupMs).toBe(65)
    expect(sampleActor('attack', S.attackStepMs - 65, S, a).pose).toBe('swing-windup')
    expect(sampleActor('attack', S.attackStepMs - 66, S, a).pose).toBe('ready')
    const f0 = S.attackStepMs + S.attackSlashMs
    expect(sampleActor('attack', f0 + 64, S, a).pose).toBe('swing-followthrough')
    expect(sampleActor('attack', f0 + 65, S, a).pose).toBe('ready')
  })

  it('絵の有無で位置（forward）は変わらない', () => {
    const a = { 'swing-windup': 1, 'swing-followthrough': 1 }
    for (let t = 0; t < attackLen; t += 7)
      expect(sampleActor('attack', t, T, a).forward).toBe(sampleActor('attack', t, T).forward)
  })

  it('windup だけ持ち ready が無い者は、前半を step にする（idle に退行しない）', () => {
    expect(seq('attack', attackLen, T, { 'swing-windup': 1, step: 1 })).toEqual([
      'step',
      'swing-windup',
      'slash',
      'step',
      'idle',
    ])
    // ready があれば ready。どちらも無ければ ready（resolvePose が idle に落とす）
    expect(seq('attack', attackLen, T, { 'swing-windup': 1, step: 1, ready: 1 })[0]).toBe('ready')
    expect(seq('attack', attackLen, T, { 'swing-windup': 1 })[0]).toBe('ready')
    expect(resolvePose('ready', { step: 1 })?.pose).not.toBe('step') // ready 自体の代替は従来どおり
  })

  it('窓が踏み出し・戻りより長い設定は、その長さにクランプされる', () => {
    const L = { ...T, attackWindupMs: 9999, attackFollowthroughMs: 9999 }
    const a = { 'swing-windup': 1, 'swing-followthrough': 1 }
    // windup は踏み出しの先頭から（ready の区間なし）、followthrough は戻りの終わりまで
    expect(seq('attack', attackLen, L, a)).toEqual([
      'swing-windup',
      'slash',
      'swing-followthrough',
      'idle',
    ])
  })

  it('special は特技（skill）の構え。spell は cast、item は ready', () => {
    expect(sampleActor('skill', 10, T).pose).toBe('special')
    expect(sampleActor('spell', 10, T).pose).toBe('cast')
    expect(sampleActor('item', 10, T).pose).toBe('ready')
    expect(sampleActor('skill', T.castMs + 1, T).pose).toBe('idle')
  })
})
