/** 脚本制御の戦闘 (#741 / #863): 宣言の解釈・条件評価・発動の決定（純粋関数） */
import { describe, expect, it } from 'vitest'
import {
  computeFloors,
  conditionsHold,
  nextScriptAction,
  parseBattleScript,
  parseScriptFlags,
  resolveAmount,
  resultFor,
  SCRIPT_DEFAULT_MAX_TURNS,
  SCRIPT_MAX_TURNS,
  type ScriptView,
} from './battleScript'

function view(over: Partial<ScriptView> = {}): ScriptView {
  return {
    turn: 0,
    party: [{ id: 'hero', hp: 20, maxHp: 20 }],
    enemies: [{ id: 'boss', hp: 100, maxHp: 100 }],
    joined: [],
    ...over,
  }
}

describe('parseScriptFlags', () => {
  it('真偽・数値・引用符つき文字列・裸の文字列を読む。引用符の中の , は区切りにしない', () => {
    const r = parseScriptFlags('a=true, b=false, n=3, f=-1.5, s="x, y", t=\'z\', bare=word')
    expect(r.warnings).toEqual([])
    expect(r.flags).toEqual({ a: true, b: false, n: 3, f: -1.5, s: 'x, y', t: 'z', bare: 'word' })
  })

  it('同じ名前は後勝ち。不正な要素は警告にして残りは生かす', () => {
    const r = parseScriptFlags('a=1, a=2, =3, oops, sp ace=1')
    expect(r.flags).toEqual({ a: 2 })
    expect(r.warnings).toHaveLength(3)
  })

  it('__proto__ という名前でも own property として入る', () => {
    const r = parseScriptFlags('__proto__=1')
    expect(Object.getPrototypeOf(r.flags)).toBe(Object.prototype)
    expect(Object.keys(r.flags)).toEqual(['__proto__'])
  })
})

describe('parseBattleScript: ルールの解釈', () => {
  it('台詞: 話者・条件・文（文にスペースや = を含んでよい）', () => {
    const p = parseBattleScript(['台詞: 条件=開始 話者=水の召喚獣 文=……ふふ HP=3 だと？'])
    expect(p.warnings).toEqual([])
    expect(p.rules).toEqual([
      {
        kind: 'line',
        conds: [{ not: false, cond: { k: 'turn', op: '=', n: 0 } }],
        speaker: '水の召喚獣',
        text: '……ふふ HP=3 だと？',
      },
    ])
  })

  it('話者なし・条件なしの台詞（地の文）', () => {
    const p = parseBattleScript(['台詞: 文=地震だ！'])
    expect(p.rules).toEqual([{ kind: 'line', conds: [], text: '地震だ！' }])
  })

  it('参戦・復活・逃走・終了・下限', () => {
    const p = parseBattleScript([
      '参戦: 条件=HP[hero]<=1 対象=ally 文=とびこんだ',
      '復活: 条件=倒れた[hero] 対象=hero HP=50% MP=3 付与=fire 文=もえあがる',
      '逃走: 条件=倒れた[guard] 対象=cell',
      '終了: 条件=ターン>=5, !参戦[ally] 結果=中断 文=ゆれた',
      '下限: 対象=hero HP=1',
      '下限: 対象=敵全員 HP=2 条件=生存[boss]',
    ])
    expect(p.warnings).toEqual([])
    expect(p.rules.map((r) => r.kind)).toEqual(['join', 'revive', 'flee', 'end', 'floor', 'floor'])
    const revive = p.rules[1]
    expect(revive).toMatchObject({
      kind: 'revive',
      target: 'hero',
      hp: { value: 50, percent: true },
      mp: { value: 3, percent: false },
      status: 'fire',
      text: 'もえあがる',
    })
    expect(p.rules[3]).toMatchObject({ kind: 'end', result: 'interrupted', text: 'ゆれた' })
    expect(p.rules[5]).toMatchObject({ kind: 'floor', target: { kind: 'enemies' }, hp: 2 })
  })

  it('固定: 勝利 = 味方の下限 + 上限ターンで勝利 / 敗北 = 敵の下限 / 中断 = 両方。上限の既定は 99', () => {
    const win = parseBattleScript(['固定: 結果=勝利'])
    expect(win.rules).toEqual([
      { kind: 'floor', conds: [], target: { kind: 'party' }, hp: 1 },
      {
        kind: 'end',
        conds: [{ not: false, cond: { k: 'turn', op: '>=', n: SCRIPT_DEFAULT_MAX_TURNS } }],
        result: 'victory',
      },
    ])
    const lose = parseBattleScript(['固定: 結果=敗北 上限ターン=8'])
    expect(lose.rules.map((r) => r.kind)).toEqual(['floor', 'end'])
    expect(lose.rules[0]).toMatchObject({ target: { kind: 'enemies' } })
    expect(lose.rules[1]).toMatchObject({ result: 'defeat' })
    const stop = parseBattleScript(['固定: 結果=中断 上限ターン=3'])
    expect(stop.rules.map((r) => r.kind)).toEqual(['floor', 'floor', 'end'])
    // 固定は終了を必ず含むので、膠着の警告は出ない
    for (const p of [win, lose, stop]) expect(p.warnings).toEqual([])
  })

  it('上限ターンの境界: 1 と上限は有効、0・上限+1・非整数は不正（その行だけ捨てる）', () => {
    expect(parseBattleScript(['固定: 結果=中断 上限ターン=1']).rules).toHaveLength(3)
    expect(
      parseBattleScript([`固定: 結果=中断 上限ターン=${SCRIPT_MAX_TURNS}`]).rules
    ).toHaveLength(3)
    for (const bad of ['0', String(SCRIPT_MAX_TURNS + 1), '1.5', '-1', 'x']) {
      const p = parseBattleScript([`固定: 結果=中断 上限ターン=${bad}`])
      expect(p.rules, bad).toEqual([])
      expect(p.warnings, bad).toHaveLength(1)
    }
  })

  it('結果の宣言（勝利時・敗北時・中断時・逃走時）: フラグと次。同じ結果は統合して後勝ち', () => {
    const p = parseBattleScript([
      '勝利時: フラグ=won=true, score=3 次=after',
      '勝利時: フラグ=score=9',
      '敗北時: 次=black',
      '中断時: フラグ=cut="ok"',
      '逃走時: フラグ=ran=true',
    ])
    expect(p.warnings).toEqual([])
    expect(resultFor(p, 'victory')).toEqual({ flags: { won: true, score: 9 }, next: 'after' })
    expect(resultFor(p, 'defeat')).toEqual({ flags: {}, next: 'black' })
    expect(resultFor(p, 'interrupted')).toEqual({ flags: { cut: 'ok' } })
    expect(resultFor(p, 'escaped')).toEqual({ flags: { ran: true } })
    expect(resultFor(parseBattleScript([]), 'victory')).toBeUndefined()
  })

  it('にげる: 不可 / 可', () => {
    expect(parseBattleScript(['にげる: 不可']).noEscape).toBe(true)
    expect(parseBattleScript(['にげる: 不可', 'にげる: 可']).noEscape).toBe(false)
    const p = parseBattleScript(['にげる: たぶん'])
    expect(p.noEscape).toBe(false)
    expect(p.warnings).toHaveLength(1)
  })

  it('不正な行は警告して捨て、ほかの行は生きる', () => {
    const p = parseBattleScript([
      'ただの文',
      '未知: 文=x',
      '台詞: 話者=誰か',
      '台詞: 条件=変なやつ 文=x',
      '参戦: 文=対象なし',
      '復活: 対象=hero HP=abc',
      '復活: 対象=hero HP=150%',
      '終了: 結果=引き分け',
      '下限: 対象=hero HP=0',
      '台詞: 条件=開始 条件=開始 文=x',
      '台詞: おかしな 文=x',
      '台詞: 文=生きている',
    ])
    expect(p.rules).toEqual([{ kind: 'line', conds: [], text: '生きている' }])
    expect(p.warnings).toHaveLength(11)
  })

  it('下限があるのに終了・逃走・固定が無いと警告する（膠着の恐れ）', () => {
    const p = parseBattleScript(['下限: 対象=boss HP=1'])
    expect(p.rules).toHaveLength(1)
    expect(p.warnings.some((w) => w.includes('決着しない恐れ'))).toBe(true)
    // 逃走か終了があれば出ない
    expect(parseBattleScript(['下限: 対象=boss HP=1', '逃走: 対象=boss']).warnings).toEqual([])
    expect(parseBattleScript(['下限: 対象=boss HP=1', '終了: 結果=中断']).warnings).toEqual([])
  })

  it('固定が複数あると警告する', () => {
    const p = parseBattleScript(['固定: 結果=勝利', '固定: 結果=敗北'])
    expect(p.warnings.some((w) => w.includes('複数'))).toBe(true)
  })

  it('文= は行末までが本文。文= のあとに書いた対象= などはキーとして読まない（文は最後に書く）', () => {
    const p = parseBattleScript(['参戦: 文=とびこんだ 対象=ally'])
    expect(p.rules).toEqual([])
    expect(p.warnings).toHaveLength(1)
    const q = parseBattleScript(['台詞: 文=あ 条件=開始'])
    expect(q.rules).toEqual([{ kind: 'line', conds: [], text: 'あ 条件=開始' }])
  })

  it('全角コロンと、値の前後の空白も受理する', () => {
    const p = parseBattleScript(['台詞：  文=こんにちは  '])
    expect(p.rules).toEqual([{ kind: 'line', conds: [], text: 'こんにちは' }])
  })
})

describe('条件の評価', () => {
  const cond = (text: string): Parameters<typeof conditionsHold>[0] => {
    const p = parseBattleScript([`台詞: 条件=${text} 文=x`])
    expect(p.warnings, text).toEqual([])
    const r = p.rules[0]
    if (r.kind !== 'line') throw new Error('line expected')
    return r.conds
  }

  it('開始 / ターン: 経過ターン数との比較（境界）', () => {
    expect(conditionsHold(cond('開始'), view({ turn: 0 }))).toBe(true)
    expect(conditionsHold(cond('開始'), view({ turn: 1 }))).toBe(false)
    expect(conditionsHold(cond('ターン>=3'), view({ turn: 2 }))).toBe(false)
    expect(conditionsHold(cond('ターン>=3'), view({ turn: 3 }))).toBe(true)
    expect(conditionsHold(cond('ターン=3'), view({ turn: 4 }))).toBe(false)
    expect(conditionsHold(cond('ターン<3'), view({ turn: 2 }))).toBe(true)
  })

  it('HP[id]: 絶対値と割合の境界、id が無ければ不成立（敵の id も引ける）', () => {
    const v = view({ party: [{ id: 'hero', hp: 1, maxHp: 20 }] })
    expect(conditionsHold(cond('HP[hero]<=1'), v)).toBe(true)
    expect(conditionsHold(cond('HP[hero]<1'), v)).toBe(false)
    expect(conditionsHold(cond('HP[hero]<=5%'), v)).toBe(true) // 1/20 = 5%
    expect(conditionsHold(cond('HP[hero]<5%'), v)).toBe(false)
    expect(conditionsHold(cond('HP[nobody]<=100'), v)).toBe(false)
    expect(conditionsHold(cond('HP[boss]>=100'), v)).toBe(true)
    // 最大 HP が 0 の者の割合は 0%
    expect(conditionsHold(cond('HP[z]<=0%'), view({ party: [{ id: 'z', hp: 0, maxHp: 0 }] }))).toBe(
      true
    )
  })

  it('倒れた[id] / 生存[id]: 同じ id が複数いるとき、倒れた=全員 / 生存=誰か', () => {
    const v = view({
      enemies: [
        { id: 'imp', hp: 0, maxHp: 5 },
        { id: 'imp', hp: 3, maxHp: 5 },
      ],
    })
    expect(conditionsHold(cond('倒れた[imp]'), v)).toBe(false)
    expect(conditionsHold(cond('生存[imp]'), v)).toBe(true)
    const all = view({ enemies: [{ id: 'imp', hp: 0, maxHp: 5 }] })
    expect(conditionsHold(cond('倒れた[imp]'), all)).toBe(true)
    expect(conditionsHold(cond('生存[imp]'), all)).toBe(false)
    // いない id は「倒れた」にならない
    expect(conditionsHold(cond('倒れた[ghost]'), v)).toBe(false)
  })

  it('味方数・敵数は生存数。参戦[id]。! で否定。複数条件は AND', () => {
    const v = view({
      party: [
        { id: 'hero', hp: 5, maxHp: 5 },
        { id: 'ally', hp: 0, maxHp: 5 },
      ],
      joined: ['ally'],
    })
    expect(conditionsHold(cond('味方数=1'), v)).toBe(true)
    expect(conditionsHold(cond('敵数>=1'), v)).toBe(true)
    expect(conditionsHold(cond('参戦[ally]'), v)).toBe(true)
    expect(conditionsHold(cond('!参戦[ally]'), v)).toBe(false)
    expect(conditionsHold(cond('参戦[ally], 味方数=1'), v)).toBe(true)
    expect(conditionsHold(cond('参戦[ally], 味方数=2'), v)).toBe(false)
  })

  it('条件なしは常に成立', () => {
    expect(conditionsHold([], view())).toBe(true)
    expect(conditionsHold(cond('常に'), view({ turn: 99 }))).toBe(true)
  })
})

describe('nextScriptAction: 発動の決定', () => {
  it('宣言順に 1 つずつ。発動済みは飛ばす。条件が偽なら出ない', () => {
    const p = parseBattleScript([
      '台詞: 条件=ターン>=2 文=B',
      '台詞: 文=A',
      '台詞: 条件=ターン>=1 文=C',
    ])
    expect(nextScriptAction(p, { fired: [] }, view({ turn: 0 }))).toMatchObject({
      text: 'A',
      index: 1,
    })
    expect(nextScriptAction(p, { fired: [1] }, view({ turn: 0 }))).toBeNull()
    expect(nextScriptAction(p, { fired: [1] }, view({ turn: 1 }))).toMatchObject({ text: 'C' })
    expect(nextScriptAction(p, { fired: [1, 2] }, view({ turn: 2 }))).toMatchObject({ text: 'B' })
    expect(nextScriptAction(p, { fired: [0, 1, 2] }, view({ turn: 9 }))).toBeNull()
  })

  it('復活は対象が HP0 のときだけ。生きている間は保留（条件が真でも発動しない）', () => {
    const p = parseBattleScript(['復活: 対象=hero'])
    expect(nextScriptAction(p, { fired: [] }, view())).toBeNull()
    const down = view({ party: [{ id: 'hero', hp: 0, maxHp: 20 }] })
    expect(nextScriptAction(p, { fired: [] }, down)).toMatchObject({
      kind: 'revive',
      target: 'hero',
    })
  })

  it('逃走は対象の敵が生きているときだけ', () => {
    const p = parseBattleScript(['逃走: 対象=boss'])
    expect(nextScriptAction(p, { fired: [] }, view())).toMatchObject({ kind: 'flee' })
    expect(
      nextScriptAction(p, { fired: [] }, view({ enemies: [{ id: 'boss', hp: 0, maxHp: 9 }] }))
    ).toBeNull()
    expect(nextScriptAction(p, { fired: [] }, view({ enemies: [] }))).toBeNull()
  })

  it('floor は発動しない（状態）', () => {
    const p = parseBattleScript(['下限: 対象=hero HP=1', '終了: 条件=ターン>=9 結果=中断'])
    expect(nextScriptAction(p, { fired: [] }, view({ turn: 0 }))).toBeNull()
    expect(nextScriptAction(p, { fired: [] }, view({ turn: 9 }))).toMatchObject({
      kind: 'end',
      result: 'interrupted',
    })
  })

  it('参戦は対象がすでに味方にいても発動する（エンジンが何もしないで済ませる）', () => {
    const p = parseBattleScript(['参戦: 対象=hero'])
    expect(nextScriptAction(p, { fired: [] }, view())).toMatchObject({
      kind: 'join',
      target: 'hero',
    })
  })
})

describe('computeFloors', () => {
  it('id・味方全員・敵全員。重なれば大きいほう。最大 HP を超えない。条件が偽なら 0', () => {
    const p = parseBattleScript([
      '下限: 対象=hero HP=1',
      '下限: 対象=味方全員 HP=3',
      '下限: 対象=boss HP=500',
      '下限: 対象=敵全員 HP=2 条件=ターン>=5',
      '終了: 結果=中断',
    ])
    const v = view({
      party: [
        { id: 'hero', hp: 20, maxHp: 20 },
        { id: 'x', hp: 2, maxHp: 2 },
      ],
    })
    expect(computeFloors(p, v)).toEqual({ party: [3, 2], enemies: [100] })
    expect(computeFloors(p, { ...v, turn: 5 }).enemies).toEqual([100])
  })

  it('下限の対象が条件で外れると 0 に戻る（付け外し）', () => {
    const p = parseBattleScript(['下限: 対象=hero HP=1 条件=!参戦[ally]', '終了: 結果=中断'])
    expect(computeFloors(p, view()).party).toEqual([1])
    expect(computeFloors(p, view({ joined: ['ally'] })).party).toEqual([0])
  })
})

describe('resolveAmount', () => {
  it('省略は最大。% は切り捨て。min〜max に収める', () => {
    expect(resolveAmount(undefined, 20, 1)).toBe(20)
    expect(resolveAmount({ value: 50, percent: true }, 21, 1)).toBe(10)
    expect(resolveAmount({ value: 0, percent: true }, 21, 1)).toBe(1)
    expect(resolveAmount({ value: 0, percent: true }, 21, 0)).toBe(0)
    expect(resolveAmount({ value: 999, percent: false }, 20, 1)).toBe(20)
    expect(resolveAmount({ value: 7.9, percent: false }, 20, 1)).toBe(7)
    expect(resolveAmount(undefined, 0, 1)).toBe(0)
  })
})
