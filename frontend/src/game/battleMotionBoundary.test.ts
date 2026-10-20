/**
 * 戦闘演出 (#745) の時間計算の境界値・同値分割テスト。
 * battleMotion.test.ts が正常系の代表値を見るのに対し、ここは「切れ目の前後 1ms」「未設定・空・非有限」を見る。
 */
import { describe, it, expect } from 'vitest'
import {
  ACTION_GAP_MS,
  ATTACK_RETURN_MS,
  ATTACK_SLASH_MS,
  ATTACK_STEP_DISTANCE,
  ATTACK_STEP_MS,
  CAST_HIT_MS,
  CAST_MS,
  DOWN_MS,
  POPUP_ARC1_MS,
  POPUP_ARC2_MS,
  POPUP_FADE_MS,
  POPUP_HOLD_MS,
  POPUP_TOTAL_MS,
  RECOIL_MS,
  STANDING,
  advancePlayback,
  buildActionTimeline,
  emptyPlayback,
  enqueueEvents,
  eventTimeline,
  isPlaybackBusy,
  messageWindowText,
  normalizePoses,
  fitPopupFontSize,
  popupCenterOffset,
  popupFontSize,
  POPUP_FONT_MIN,
  POPUP_FONT_MAX,
  POPUP_FONT_RATIO,
  popupText,
  posesField,
  resolvePose,
  sampleActor,
  sampleDamagePopup,
  sampleTarget,
} from './battleMotion'
import type { BattleActionEvent, BattleHit } from './battleEngine'

const hit = (over: Partial<BattleHit> = {}): BattleHit => ({
  target: { side: 'enemy', index: 0 },
  kind: 'damage',
  amount: 5,
  hpBefore: 10,
  hpAfter: 5,
  ...over,
})
const ev = (
  seq: number,
  kind: BattleActionEvent['kind'],
  hits: BattleHit[] = [hit()]
): BattleActionEvent => ({ seq, actor: { side: 'party', index: 0 }, kind, hits })

describe('eventTimeline: 受ける側の動きで長さが変わる条件の同値分割', () => {
  const attackEnd = ATTACK_STEP_MS + ATTACK_SLASH_MS + ATTACK_RETURN_MS
  it.each([
    ['heal だけ', [hit({ kind: 'heal', hpBefore: 5, hpAfter: 10 })], false, false],
    ['miss だけ', [hit({ kind: 'miss', amount: 0, hpAfter: 10 })], false, false],
    ['hits が空', [], false, false],
    ['damage（生存）', [hit()], true, false],
    ['damage（HP 0）', [hit({ hpAfter: 0 })], true, true],
    ['heal で HP 0 以下は倒れ扱いにしない', [hit({ kind: 'heal', hpAfter: 0 })], false, false],
    ['複数対象: 1 体生存 + 1 体 HP 0', [hit(), hit({ hpAfter: 0 })], true, true],
  ] as const)('attack / %s', (_n, hits, damages, downs) => {
    expect(eventTimeline(ev(0, 'attack', [...hits]))).toEqual(
      buildActionTimeline('attack', { damages, downs })
    )
  })

  it('攻撃で damage（生存）: モーションの方が長ければ モーション + 間隔', () => {
    const tl = buildActionTimeline('attack', { damages: true })
    expect(tl.duration).toBe(Math.max(attackEnd, tl.hitAt + RECOIL_MS) + ACTION_GAP_MS)
  })

  it('呪文で damage（生存）: のけぞり終わりの方が長いので、構えより後まで待つ', () => {
    const tl = buildActionTimeline('spell', { damages: true })
    expect(tl.hitAt).toBe(CAST_HIT_MS)
    expect(tl.duration).toBe(Math.max(CAST_MS, CAST_HIT_MS + RECOIL_MS) + ACTION_GAP_MS)
  })

  it('何も受けない行動は モーション + 間隔 だけ（攻撃・呪文とも）', () => {
    expect(buildActionTimeline('attack').duration).toBe(attackEnd + ACTION_GAP_MS)
    expect(buildActionTimeline('spell').duration).toBe(CAST_MS + ACTION_GAP_MS)
    expect(buildActionTimeline('item').duration).toBe(CAST_MS + ACTION_GAP_MS)
  })

  it('倒れる行動は常に のけぞり + 倒れ を待つ（行動種別によらず）', () => {
    for (const kind of ['attack', 'spell', 'item'] as const) {
      const tl = buildActionTimeline(kind, { damages: true, downs: true })
      expect(tl.duration).toBeGreaterThanOrEqual(tl.hitAt + RECOIL_MS + DOWN_MS + ACTION_GAP_MS)
    }
  })
})

describe('sampleActor: フェーズの切れ目', () => {
  const slashEnd = ATTACK_STEP_MS + ATTACK_SLASH_MS
  const returnEnd = slashEnd + ATTACK_RETURN_MS
  it('踏み出し終端の 1ms 前は step、ちょうどで slash に変わる', () => {
    expect(sampleActor('attack', ATTACK_STEP_MS - 1).pose).toBe('step')
    expect(sampleActor('attack', ATTACK_STEP_MS)).toEqual({
      forward: ATTACK_STEP_DISTANCE,
      pose: 'slash',
    })
  })
  it('斬り終端の 1ms 前は slash、ちょうどで戻りの step に変わり、前進量は最大のまま始まる', () => {
    expect(sampleActor('attack', slashEnd - 1).pose).toBe('slash')
    const s = sampleActor('attack', slashEnd)
    expect(s.pose).toBe('step')
    expect(s.forward).toBeCloseTo(ATTACK_STEP_DISTANCE, 5)
  })
  it('戻り終端の 1ms 前は前進量がほぼ 0 の step、ちょうどで idle', () => {
    const last = sampleActor('attack', returnEnd - 1)
    expect(last.pose).toBe('step')
    expect(last.forward).toBeGreaterThanOrEqual(0)
    expect(last.forward).toBeLessThan(ATTACK_STEP_DISTANCE * 0.01)
    expect(sampleActor('attack', returnEnd)).toEqual({ forward: 0, pose: 'idle' })
  })
  it('前進量は全区間で 0 以上 最大以下（単調に増えて単調に減る）', () => {
    let prev = -1
    for (let t = 0; t <= slashEnd; t += 5) {
      const f = sampleActor('attack', t).forward
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(f).toBeLessThanOrEqual(ATTACK_STEP_DISTANCE + 1e-9)
      prev = f
    }
    for (let t = slashEnd; t <= returnEnd; t += 5) {
      const f = sampleActor('attack', t).forward
      expect(f).toBeLessThanOrEqual(prev + 1e-9)
      expect(f).toBeGreaterThanOrEqual(0)
      prev = f
    }
  })
  it('呪文・アイテムの構え終端: 1ms 前は ready、ちょうどで idle', () => {
    for (const kind of ['spell', 'item'] as const) {
      expect(sampleActor(kind, CAST_MS - 1).pose).toBe(kind === 'spell' ? 'cast' : 'ready')
      expect(sampleActor(kind, CAST_MS).pose).toBe('idle')
    }
  })
  it('負・NaN・Infinity は開始時点として扱う（Infinity は 0 に倒す）', () => {
    expect(sampleActor('attack', -100)).toEqual(sampleActor('attack', 0))
    expect(sampleActor('attack', NaN)).toEqual(sampleActor('attack', 0))
    expect(sampleActor('attack', Infinity)).toEqual(sampleActor('attack', 0))
    expect(sampleActor('spell', -1).pose).toBe('cast')
  })
})

describe('sampleTarget: 境界と非有限', () => {
  it('命中の瞬間（sinceHit=0）から hurt。-1 は立っている', () => {
    expect(sampleTarget('damage', -1, false)).toEqual(STANDING)
    expect(sampleTarget('damage', 0, false)).toEqual({ recoil: 0, pose: 'hurt', downProgress: 0 })
  })
  it('生存: のけぞり終端の 1ms 前は hurt、ちょうどで idle', () => {
    expect(sampleTarget('damage', RECOIL_MS - 1, false).pose).toBe('hurt')
    expect(sampleTarget('damage', RECOIL_MS, false).pose).toBe('idle')
  })
  it('倒れ: のけぞり終端ちょうどで down ポーズ・進み 0、倒れ終端の後も 1 のまま', () => {
    expect(sampleTarget('damage', RECOIL_MS, true)).toEqual({
      recoil: 0,
      pose: 'down',
      downProgress: 0,
    })
    expect(sampleTarget('damage', RECOIL_MS + DOWN_MS + 10000, true).downProgress).toBe(1)
  })
  it('倒れの進みは単調に増える', () => {
    let prev = 0
    for (let t = RECOIL_MS; t <= RECOIL_MS + DOWN_MS; t += 10) {
      const p = sampleTarget('damage', t, true).downProgress
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })
  it('NaN / Infinity の sinceHit は立っている', () => {
    expect(sampleTarget('damage', NaN, true)).toEqual(STANDING)
    expect(sampleTarget('damage', Infinity, true)).toEqual(STANDING)
  })
})

describe('advancePlayback: 命中の瞬間 hit-1 / hit / hit+1 と二重実行', () => {
  const tl = buildActionTimeline('attack', { damages: true })
  const start = () => enqueueEvents(emptyPlayback(), [ev(0, 'attack')])

  it('hit-1 では発火せず、hit ちょうどで sinceHit=0 で発火、hit+1 では sinceHit=1', () => {
    expect(advancePlayback(start(), tl.hitAt - 1).fires).toHaveLength(0)
    const at = advancePlayback(start(), tl.hitAt)
    expect(at.fires).toHaveLength(1)
    expect(at.fires[0].sinceHit).toBe(0)
    expect(advancePlayback(start(), tl.hitAt + 1).fires[0].sinceHit).toBe(1)
  })

  it('細かい dt に分けても、全体で命中は 1 回だけ', () => {
    let pb = start()
    let total = 0
    for (let i = 0; i < tl.duration + 50; i++) {
      const r = advancePlayback(pb, 1)
      total += r.fires.length
      pb = r.state
    }
    expect(total).toBe(1)
    expect(isPlaybackBusy(pb)).toBe(false)
  })

  it('行動の終端ちょうどで active が空く。1ms 手前では残る', () => {
    expect(isPlaybackBusy(advancePlayback(start(), tl.duration - 1).state)).toBe(true)
    expect(isPlaybackBusy(advancePlayback(start(), tl.duration).state)).toBe(false)
  })

  it('1 回の dt が行動 2 つにまたがるとき、2 つ目の sinceHit は繰り越し分から数える', () => {
    const pb = enqueueEvents(emptyPlayback(), [ev(0, 'attack'), ev(1, 'attack')])
    const r = advancePlayback(pb, tl.duration + tl.hitAt + 3)
    expect(r.fires.map((f) => f.event.seq)).toEqual([0, 1])
    expect(r.fires[1].sinceHit).toBe(3)
  })

  it('dt=0 は何もしない（同じ state 参照）', () => {
    const pb = start()
    const r = advancePlayback(pb, 0)
    expect(r.state).toBe(pb)
    expect(r.fires).toEqual([])
  })

  it('空のキューは dt を進めても空のまま', () => {
    const r = advancePlayback(emptyPlayback(), 1000)
    expect(r.state).toEqual(emptyPlayback())
    expect(r.fires).toEqual([])
  })

  it('命中の発火後に別の行動を積んでも、実行中の行動の命中は再発火しない', () => {
    let pb = start()
    pb = advancePlayback(pb, tl.hitAt + 1).state
    pb = enqueueEvents(pb, [ev(1, 'attack')])
    const r = advancePlayback(pb, tl.duration)
    expect(r.fires.map((f) => f.event.seq)).toEqual([1])
  })

  it('MISS だけの行動・heal だけの行動でも命中の瞬間に発火する（数字を出すため）', () => {
    for (const kind of ['miss', 'heal'] as const) {
      const pb = enqueueEvents(emptyPlayback(), [ev(0, 'spell', [hit({ kind })])])
      const r = advancePlayback(pb, buildActionTimeline('spell').hitAt)
      expect(r.fires).toHaveLength(1)
    }
  })

  it('hits が空の行動も時間は消費するが発火内容は空', () => {
    const pb = enqueueEvents(emptyPlayback(), [ev(0, 'item', [])])
    const r = advancePlayback(pb, 100000)
    expect(r.fires[0].event.hits).toEqual([])
    expect(isPlaybackBusy(r.state)).toBe(false)
  })
})

describe('enqueueEvents / isPlaybackBusy', () => {
  it('空配列を積んでも同じ state 参照を返す', () => {
    const pb = emptyPlayback()
    expect(enqueueEvents(pb, [])).toBe(pb)
    expect(isPlaybackBusy(pb)).toBe(false)
  })
  it('実行中の active は積んでも保たれ、キューの後ろに足される', () => {
    let pb = enqueueEvents(emptyPlayback(), [ev(0, 'attack')])
    pb = advancePlayback(pb, 10).state
    const after = enqueueEvents(pb, [ev(1, 'attack')])
    expect(after.active).toBe(pb.active)
    expect(after.queue.map((e) => e.seq)).toEqual([1])
  })
})

describe('sampleDamagePopup: 区間の切れ目', () => {
  it('1 つ目の跳ね終端ちょうどで dy=0、2 つ目の跳ね中は上にいる', () => {
    expect(sampleDamagePopup(POPUP_ARC1_MS).dy).toBeCloseTo(0, 5)
    expect(sampleDamagePopup(POPUP_ARC1_MS + POPUP_ARC2_MS / 2).dy).toBeLessThan(0)
  })
  it('2 つ目の跳ね終端ちょうどから留まり（alpha 1・dy 0）、留まりの最後の 1ms 前も alpha 1', () => {
    const holdStart = POPUP_ARC1_MS + POPUP_ARC2_MS
    expect(sampleDamagePopup(holdStart)).toEqual({ dy: 0, alpha: 1, done: false })
    expect(sampleDamagePopup(holdStart + POPUP_HOLD_MS - 1).alpha).toBe(1)
  })
  it('フェードは留まり終端ちょうどから始まり、alpha は単調に減って終端で done', () => {
    const fadeStart = POPUP_ARC1_MS + POPUP_ARC2_MS + POPUP_HOLD_MS
    expect(sampleDamagePopup(fadeStart).alpha).toBe(1)
    let prev = 1
    for (let t = fadeStart; t < POPUP_TOTAL_MS; t += 10) {
      const s = sampleDamagePopup(t)
      expect(s.done).toBe(false)
      expect(s.alpha).toBeLessThanOrEqual(prev)
      prev = s.alpha
    }
    expect(POPUP_TOTAL_MS - fadeStart).toBe(POPUP_FADE_MS)
    expect(sampleDamagePopup(POPUP_TOTAL_MS - 1).done).toBe(false)
    expect(sampleDamagePopup(POPUP_TOTAL_MS).done).toBe(true)
    expect(sampleDamagePopup(POPUP_TOTAL_MS + 99999)).toEqual({ dy: 0, alpha: 0, done: true })
  })
  it('負・NaN は開始時点（done にならない）。dy は -0 にならない', () => {
    expect(sampleDamagePopup(-5)).toEqual({ dy: 0, alpha: 1, done: false })
    expect(sampleDamagePopup(NaN)).toEqual({ dy: 0, alpha: 1, done: false })
    expect(Object.is(sampleDamagePopup(0).dy, 0)).toBe(true)
  })
})

describe('popupText / popupFontSize: 境界', () => {
  it('小数は四捨五入、負は 0、0 ダメージは "0"', () => {
    expect(popupText({ kind: 'damage', amount: 12.5 })).toBe('13')
    expect(popupText({ kind: 'damage', amount: -3 })).toBe('0')
    expect(popupText({ kind: 'damage', amount: 0 })).toBe('0')
    expect(popupText({ kind: 'heal', amount: 0 })).toBe('0')
  })
  it('miss は amount に関わらず MISS', () => {
    expect(popupText({ kind: 'miss', amount: 99 })).toBe('MISS')
  })
  it('フォントサイズ: 下限・上限の境目と中間値', () => {
    expect(popupFontSize(0)).toBe(POPUP_FONT_MIN)
    expect(popupFontSize(Infinity)).toBe(POPUP_FONT_MIN)
    expect(popupFontSize(100)).toBe(Math.round(100 * POPUP_FONT_RATIO))
    expect(popupFontSize(POPUP_FONT_MAX / POPUP_FONT_RATIO)).toBe(POPUP_FONT_MAX)
    expect(popupFontSize(10000)).toBe(POPUP_FONT_MAX)
  })
})

describe('fitPopupFontSize: 桁数別 (#877)', () => {
  it('4 文字以下（上限 9999 まで・MISS）は基準のまま', () => {
    for (const t of ['0', '9', '99', '999', '9999', 'MISS']) {
      expect(fitPopupFontSize(t, 33)).toBe(33)
    }
  })
  it('5 桁以上は 4 桁ぶんの幅に収まるよう比例で縮む', () => {
    expect(fitPopupFontSize('99999', 40)).toBe(32)
    expect(fitPopupFontSize('999999', 36)).toBe(24)
    expect(fitPopupFontSize('9999999', 56)).toBe(32)
  })
  it('どの桁・基準でも幅（文字数×係数）は 4 桁の基準幅を越えない', () => {
    for (const base of [POPUP_FONT_MIN, 33, POPUP_FONT_MAX]) {
      for (let digits = 5; digits <= 12; digits++) {
        const f = fitPopupFontSize('9'.repeat(digits), base)
        expect(f * digits).toBeLessThanOrEqual(base * 4)
      }
    }
  })
  it('どの桁・基準でも 1 未満にならない', () => {
    for (const base of [POPUP_FONT_MIN, 33, POPUP_FONT_MAX]) {
      for (let digits = 5; digits <= 12; digits++) {
        expect(fitPopupFontSize('9'.repeat(digits), base)).toBeGreaterThanOrEqual(1)
      }
    }
  })
  it('極端に長い文字列（100 文字）でも下限 1 で止まる', () => {
    expect(fitPopupFontSize('9'.repeat(100), 20)).toBe(1)
  })
  it('popupText と組み合わせても 9999 以下は不変', () => {
    const t = popupText({ kind: 'damage', amount: 9999 })
    expect(fitPopupFontSize(t, popupFontSize(96))).toBe(popupFontSize(96))
  })
})

describe('popupCenterOffset: 縮んだ数字を基本サイズの段の中央に置く (#877)', () => {
  it('縮んでいない（実際 = 基本）ときは 0 で、位置は従来と完全に同じ（-0 でもない）', () => {
    for (const f of [20, 33, 56]) expect(Object.is(popupCenterOffset(f, f), 0)).toBe(true)
  })
  it('縮んだぶんの半分', () => {
    expect(popupCenterOffset(20, 16)).toBe(2)
    expect(popupCenterOffset(56, 32)).toBe(12)
  })
  it('実際が基本以上（想定外）でも負にならない', () => {
    expect(popupCenterOffset(20, 30)).toBe(0)
  })
  it('fitPopupFontSize と組み合わせて、4 文字以下は常に 0・5 文字以上は正', () => {
    for (const base of [20, 33, 56]) {
      for (const t of ['9', '9999', 'MISS']) {
        expect(popupCenterOffset(base, fitPopupFontSize(t, base))).toBe(0)
      }
      for (const t of ['99999', '9999999']) {
        expect(popupCenterOffset(base, fitPopupFontSize(t, base))).toBeGreaterThan(0)
      }
    }
  })
})

describe('normalizePoses / posesField / resolvePose: 未設定・部分・未知・空', () => {
  it('null・空オブジェクト・全部空文字は undefined', () => {
    expect(normalizePoses(null)).toBeUndefined()
    expect(normalizePoses({})).toBeUndefined()
    expect(normalizePoses({ idle: '', hurt: '   ' })).toBeUndefined()
  })
  it('キーの大小・前後空白を正規化し、未知キーは捨て、値は trim する', () => {
    expect(normalizePoses({ ' SLASH ': ' s.png ', idle: 'i.png', xx: 'x.png' })).toEqual({
      slash: 's.png',
      idle: 'i.png',
    })
  })
  it('文字列でない値は捨てる', () => {
    expect(normalizePoses({ idle: 5 as unknown as string, hurt: 'h.png' })).toEqual({
      hurt: 'h.png',
    })
  })
  it('posesField: 無ければ poses キー自体を足さない', () => {
    expect(posesField(undefined)).toEqual({})
    expect('poses' in posesField({ bogus: 'x' })).toBe(false)
    expect(posesField({ idle: 'a.png' })).toEqual({ poses: { idle: 'a.png' } })
  })
  it('resolvePose: 全ポーズについて、idle だけ持っていれば down 以外は idle に落ちる', () => {
    for (const p of ['idle', 'ready', 'step', 'slash', 'hurt', 'victory'] as const) {
      expect(resolvePose(p, { idle: 'i' })).toEqual({ pose: 'idle', value: 'i' })
    }
    expect(resolvePose('down', { idle: 'i' })).toBeNull()
  })
  it('resolvePose: 近い絵が優先される（slash は step より ready より idle）', () => {
    expect(resolvePose('slash', { idle: 'i', ready: 'r' })).toEqual({ pose: 'ready', value: 'r' })
    expect(resolvePose('victory', { idle: 'i', down: 'd' })).toEqual({ pose: 'idle', value: 'i' })
  })
  it('resolvePose: falsy な値（0・空でない扱い）でも undefined でなければ採用する', () => {
    expect(resolvePose('idle', { idle: 0 })).toEqual({ pose: 'idle', value: 0 })
  })
})

describe('messageWindowText: 境界', () => {
  it('空文字は null、前後空白は取り、内部の空白は保つ', () => {
    expect(messageWindowText('')).toBeNull()
    expect(messageWindowText('  ファイ ア  ')).toBe('ファイ ア')
  })
})
