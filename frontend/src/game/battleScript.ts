/**
 * 脚本制御の戦闘 (#741、拡張 #863)。`[戦闘 id]` の `rules`（parser が生文字列で透過した `キー: 値` の行）をここで解釈し、
 * 戦闘の状態から「いま発動するルール」を決める。**純粋関数だけ**を持つ（PixiJS・DOM・エンジンに触れない・乱数を使わない）。
 * エンジン（`battleEngine.ts`）は宣言をオプションで受け、ステップのたびにここへ状態の写し（`ScriptView`）を渡して決定を受け取り、自分の公開操作で適用する。
 *
 * 書式（`enemyAi.ts` の `行動:` と同じ流儀。1 行 = 1 ルール。値にスペースを書いてよい。不正な行は警告して無視する）:
 *   `<キー>: 条件=<式>[, <式>...] 名前=値 ...`
 * - 条件は `,` 区切りの AND。省略か `常に` は常に成立。式の先頭の `!` で否定
 * - 式: `開始`（= `ターン=0`）/ `ターン<op>N` / `HP[id]<op>N` / `HP[id]<op>P%` / `倒れた[id]` / `生存[id]` /
 *   `味方数<op>N` / `敵数<op>N`（生存数）/ `参戦[id]`（戦闘中に参戦した）。op は `<` `<=` `>` `>=` `=`
 * - `ターン` ＝経過ターン数。従来ターン制は「味方の行動 → 敵の行動」の 1 巡、ATB は味方の行動 1 回で 1 ターン（`ターン>=3` は 3 ターン進んだあと）
 * - `HP[id]` の id は味方（先頭から）→ 敵の順に最初に見つかった者。いなければ不成立
 * - 台詞 / 参戦 / 復活 / 逃走 / 終了 のルールは**1 回だけ**発動する（繰り返しは条件の `ターン=N` で書く）。成立したルールが複数なら宣言順に 1 つずつ
 *   - `台詞: [条件=…] [話者=名前] 文=本文`（`文=` は最後に書く。行末までが本文で、本文の中の `HP=` などはキーとして読まない）
 *   - `参戦: [条件=…] 対象=<味方id> [文=…]` / `復活: [条件=…] 対象=<味方id> [HP=N|P%] [MP=N|P%] [付与=<状態id>] [文=…]`（対象が HP0 のときに発動。既定は HP 全回復）
 *   - `逃走: [条件=…] 対象=<敵id> [文=…]`（その敵が戦闘から消える。経験値・ドロップなし）/ `終了: [条件=…] 結果=勝利|敗北|中断 [文=…]`
 * - 下限 は発動でなく**状態**: `下限: [条件=…] 対象=<id>|味方全員|敵全員 HP=N` は、条件が真の間その者の HP を N 未満にしない（すでに N 未満の者は上げない）
 * - `固定: 結果=勝利|敗北|中断 [上限ターン=N]` は「勝利＝味方全員 HP 下限 1 / 敗北＝敵全員 HP 下限 1 / 中断＝両方」と
 *   「上限ターン（既定 99）に達したらその結果で終了」に展開する。**倒れない・倒せない状態を作っても、有限ターンで必ず決着する**
 * - `勝利時` `敗北時` `中断時` `逃走時`: `[フラグ=名前=値, ...] [次=<イベント名>]`。ホストへ返す `BattleResult.script` になる
 *   （値は `true`/`false`・数値・引用符つきまたは裸の文字列。`[フラグ:]` と同じ種類）
 * - `にげる: 不可`（`可` は既定）: 戦闘中の「にげる」を禁じる
 */
import { compareNumbers, type CompareOp } from './numberPredicate'
import { hasOwn, safeAssign } from './ownProperty'

/** 戦闘の終わり方。`escaped` は「にげる」成功 */
export type ScriptOutcome = 'victory' | 'defeat' | 'interrupted' | 'escaped'
/** `終了` / `固定` で指せる結果（逃走は脚本が決めるものでなくプレイヤーの選択） */
export type ScriptEndResult = 'victory' | 'defeat' | 'interrupted'

/** `固定:` の `上限ターン` の既定。これを書かなくても必ず有限ターンで終わる */
export const SCRIPT_DEFAULT_MAX_TURNS = 99
/** `上限ターン` に書ける最大。これを超える値は不正として捨てる（実質無限＝膠着の温床にしない） */
export const SCRIPT_MAX_TURNS = 9999
/** 1 回の `scriptStep` で発動するルールの最大数の余裕（ルール数 + この値まで回して打ち切る。無限ループ防止の安全弁） */
export const SCRIPT_STEP_SLACK = 2

export type ScriptFlagValue = boolean | number | string

export interface ScriptOutcomeResult {
  flags: Record<string, ScriptFlagValue>
  next?: string
}

/** 脚本が持つ状態。`BattleState.script` に載る（数値・文字列・配列だけ。ADR 0002） */
export interface ScriptState {
  /** `[戦闘]` の id（結果に載る） */
  id: string
  /** 経過ターン数（0 始まり） */
  turn: number
  /** 発動済みのルールの通し番号（`ParsedBattleScript.rules` の index） */
  fired: number[]
  /** 参戦した味方の id（参戦した順） */
  joined: string[]
  /** 逃走した敵の index（`state.enemies` の添字） */
  fled: number[]
}

type Cond =
  | { k: 'turn'; op: CompareOp; n: number }
  | { k: 'hp'; id: string; op: CompareOp; n: number; percent: boolean }
  | { k: 'down'; id: string }
  | { k: 'alive'; id: string }
  | { k: 'party'; op: CompareOp; n: number }
  | { k: 'enemies'; op: CompareOp; n: number }
  | { k: 'joined'; id: string }

interface Condition {
  not: boolean
  cond: Cond
}

/** HP / MP の指定（`30` = 30、`50%` = 最大値の 50%） */
export interface ScriptAmount {
  value: number
  percent: boolean
}

type FloorTarget = { kind: 'id'; id: string } | { kind: 'party' } | { kind: 'enemies' }

export type ScriptRule =
  | { kind: 'line'; conds: Condition[]; speaker?: string; text: string }
  | { kind: 'join'; conds: Condition[]; target: string; text?: string }
  | {
      kind: 'revive'
      conds: Condition[]
      target: string
      hp?: ScriptAmount
      mp?: ScriptAmount
      status?: string
      text?: string
    }
  | { kind: 'flee'; conds: Condition[]; target: string; text?: string }
  | { kind: 'end'; conds: Condition[]; result: ScriptEndResult; text?: string }
  | { kind: 'floor'; conds: Condition[]; target: FloorTarget; hp: number }

export interface ParsedBattleScript {
  /** 解釈できたルール（宣言順。`固定` は floor と end に展開済み）。`fired` の index はこの配列の添字 */
  rules: ScriptRule[]
  results: Partial<Record<ScriptOutcome, ScriptOutcomeResult>>
  /** `にげる: 不可` */
  noEscape: boolean
  /** 不正な行・値、膠着の恐れの警告 */
  warnings: string[]
}

/** エンジンが渡す、戦闘の状態の写し（ルールの判定に必要な数字だけ） */
export interface ScriptView {
  turn: number
  party: ReadonlyArray<{ id: string; hp: number; maxHp: number }>
  enemies: ReadonlyArray<{ id: string; hp: number; maxHp: number }>
  /** 参戦した味方の id */
  joined: readonly string[]
}

/** `nextScriptAction` の決定。エンジンが適用する */
export type ScriptAction =
  | { index: number; kind: 'line'; speaker?: string; text: string }
  | { index: number; kind: 'join'; target: string; text?: string }
  | {
      index: number
      kind: 'revive'
      target: string
      hp?: ScriptAmount
      mp?: ScriptAmount
      status?: string
      text?: string
    }
  | { index: number; kind: 'flee'; target: string; text?: string }
  | { index: number; kind: 'end'; result: ScriptEndResult; text?: string }

// ---------------------------------------------------------------------------
// 解釈
// ---------------------------------------------------------------------------

const PARAM_KEYS = [
  '条件',
  '話者',
  '文',
  '対象',
  'HP',
  'MP',
  '付与',
  '結果',
  '上限ターン',
  'フラグ',
  '次',
]
const PARAM_RE = new RegExp(`(?:^|\\s)(${PARAM_KEYS.join('|')})=`, 'g')
const RULE_KINDS = [
  '台詞',
  '参戦',
  '復活',
  '下限',
  '逃走',
  '終了',
  '固定',
  '勝利時',
  '敗北時',
  '中断時',
  '逃走時',
  'にげる',
] as const
const OP = '(<=|>=|<|>|==|=)'
const TURN_RE = new RegExp(`^ターン\\s*${OP}\\s*(\\d+)$`)
const HP_RE = new RegExp(`^HP\\[([^\\]]+)\\]\\s*${OP}\\s*(\\d+(?:\\.\\d+)?)\\s*(%?)$`, 'i')
const DOWN_RE = /^倒れた\[([^\]]+)\]$/
const ALIVE_RE = /^生存\[([^\]]+)\]$/
const PARTY_RE = new RegExp(`^味方数\\s*${OP}\\s*(\\d+)$`)
const ENEMIES_RE = new RegExp(`^敵数\\s*${OP}\\s*(\\d+)$`)
const JOINED_RE = /^参戦\[([^\]]+)\]$/
const RESULT_WORDS: Record<string, ScriptEndResult> = {
  勝利: 'victory',
  敗北: 'defeat',
  中断: 'interrupted',
}
const OUTCOME_KINDS: Record<string, ScriptOutcome> = {
  勝利時: 'victory',
  敗北時: 'defeat',
  中断時: 'interrupted',
  逃走時: 'escaped',
}

function toOp(raw: string): CompareOp {
  return raw === '==' ? '=' : (raw as CompareOp)
}

function parseCondition(raw: string): Condition | string {
  let text = raw.trim()
  if (text === '' || text === '常に') return { not: false, cond: { k: 'turn', op: '>=', n: 0 } }
  let not = false
  if (text.startsWith('!') || text.startsWith('！')) {
    not = true
    text = text.slice(1).trim()
  }
  if (text === '開始') return { not, cond: { k: 'turn', op: '=', n: 0 } }
  const turn = TURN_RE.exec(text)
  if (turn) return { not, cond: { k: 'turn', op: toOp(turn[1]), n: Number(turn[2]) } }
  const hp = HP_RE.exec(text)
  if (hp) {
    return {
      not,
      cond: {
        k: 'hp',
        id: hp[1].trim(),
        op: toOp(hp[2]),
        n: Number(hp[3]),
        percent: hp[4] === '%',
      },
    }
  }
  const down = DOWN_RE.exec(text)
  if (down) return { not, cond: { k: 'down', id: down[1].trim() } }
  const alive = ALIVE_RE.exec(text)
  if (alive) return { not, cond: { k: 'alive', id: alive[1].trim() } }
  const party = PARTY_RE.exec(text)
  if (party) return { not, cond: { k: 'party', op: toOp(party[1]), n: Number(party[2]) } }
  const enemies = ENEMIES_RE.exec(text)
  if (enemies) return { not, cond: { k: 'enemies', op: toOp(enemies[1]), n: Number(enemies[2]) } }
  const joined = JOINED_RE.exec(text)
  if (joined) return { not, cond: { k: 'joined', id: joined[1].trim() } }
  return `条件 '${raw.trim()}' は未対応です`
}

function parseConditions(raw: string | undefined): Condition[] | string {
  if (raw === undefined) return []
  const out: Condition[] = []
  for (const piece of raw.split(/[,、，]/)) {
    const c = parseCondition(piece)
    if (typeof c === 'string') return c
    out.push(c)
  }
  return out
}

function parseAmount(label: string, raw: string): ScriptAmount | string {
  const m = /^(\d+(?:\.\d+)?)\s*(%?)$/.exec(raw.trim())
  if (!m) return `${label}= '${raw}' は 数 か P% で書いてください`
  const value = Number(m[1])
  if (m[2] === '%' && value > 100) return `${label}= '${raw}' は 100% を超えられません`
  return { value, percent: m[2] === '%' }
}

/** `キー=値` の列を分ける。値の中のスペースは許す（次の既知のキーの手前まで） */
function splitParams(text: string): Map<string, string> | string {
  const parts: { key: string; start: number; valueStart: number }[] = []
  PARAM_RE.lastIndex = 0
  for (let m = PARAM_RE.exec(text); m !== null; m = PARAM_RE.exec(text)) {
    const start = m.index + (m[0].length - m[1].length - 1)
    parts.push({ key: m[1], start, valueStart: m.index + m[0].length })
  }
  if (parts.length > 0 && text.slice(0, parts[0].start).trim() !== '') {
    return 'キーの前に余計な文字があります'
  }
  if (parts.length === 0 && text.trim() !== '')
    return 'キー（条件= / 文= / 対象= など）がありません'
  const values = new Map<string, string>()
  for (let i = 0; i < parts.length; i++) {
    const { key, valueStart } = parts[i]
    if (values.has(key)) return `${key}= が重複しています`
    // `文=` は最後に書き、行末までが本文（本文の中の `HP=` などをキーと取り違えない）
    const end = key === '文' || i + 1 >= parts.length ? text.length : parts[i + 1].start
    values.set(key, text.slice(valueStart, end).trim())
    if (key === '文') break
  }
  return values
}

/** `a=true, b=3, c="x y"` をフラグの列にする。引用符の中の `,` は区切りにしない */
export function parseScriptFlags(raw: string): {
  flags: Record<string, ScriptFlagValue>
  warnings: string[]
} {
  const flags: Record<string, ScriptFlagValue> = {}
  const warnings: string[] = []
  const pieces: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of raw) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',' || ch === '、' || ch === '，') {
      pieces.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  pieces.push(cur)
  for (const piece of pieces) {
    const text = piece.trim()
    if (text === '') continue
    const eq = text.indexOf('=')
    if (eq <= 0) {
      warnings.push(`フラグ '${text}' は 名前=値 で書いてください`)
      continue
    }
    const name = text.slice(0, eq).trim()
    const rawValue = text.slice(eq + 1).trim()
    if (name === '' || /\s/.test(name)) {
      warnings.push(`フラグ名 '${name}' が不正です`)
      continue
    }
    let value: ScriptFlagValue
    if (rawValue === 'true') value = true
    else if (rawValue === 'false') value = false
    else if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) value = Number(rawValue)
    else if (
      rawValue.length >= 2 &&
      (rawValue[0] === '"' || rawValue[0] === "'") &&
      rawValue[rawValue.length - 1] === rawValue[0]
    ) {
      value = rawValue.slice(1, -1)
    } else value = rawValue
    safeAssign(flags, name, value)
  }
  return { flags, warnings }
}

function splitKindLine(line: string): { kind: string; body: string } | null {
  const m = /^\s*([^:：\s]+)\s*[:：]\s*(.*)$/s.exec(line)
  return m ? { kind: m[1], body: m[2] } : null
}

/**
 * `[戦闘]` の `rules`（`キー: 値` の生の行）を解釈する。解釈できない行は警告にして無視する（ほかの行は生きる）。
 * `固定` は floor と end に展開する。膠着の恐れ（倒せない敵・倒れない味方を作るのに終了条件が無い）は警告にする
 */
export function parseBattleScript(lines: readonly string[]): ParsedBattleScript {
  const rules: ScriptRule[] = []
  const results: Partial<Record<ScriptOutcome, ScriptOutcomeResult>> = {}
  const warnings: string[] = []
  let noEscape = false
  let fixedCount = 0
  const warn = (line: string, why: string): void => {
    warnings.push(`'${line.trim()}': ${why}`)
  }

  for (const line of lines) {
    const kl = splitKindLine(line)
    if (!kl) {
      warn(line, '「キー: 値」の形ではありません')
      continue
    }
    if (!(RULE_KINDS as readonly string[]).includes(kl.kind)) {
      warn(line, `未対応のキー '${kl.kind}' です`)
      continue
    }
    if (kl.kind === 'にげる') {
      const v = kl.body.trim()
      if (v === '不可') noEscape = true
      else if (v === '可') noEscape = false
      else warn(line, 'にげる: は 可 か 不可 です')
      continue
    }
    const params = splitParams(kl.body)
    if (typeof params === 'string') {
      warn(line, params)
      continue
    }
    const conds = parseConditions(params.get('条件'))
    if (typeof conds === 'string') {
      warn(line, conds)
      continue
    }
    const text = params.get('文')
    const target = params.get('対象')
    const needTarget = (): string | null => {
      if (target === undefined || target === '') {
        warn(line, '対象= がありません')
        return null
      }
      return target
    }
    switch (kl.kind) {
      case '台詞': {
        if (text === undefined || text === '') {
          warn(line, '文= がありません')
          break
        }
        const speaker = params.get('話者')
        rules.push({
          kind: 'line',
          conds,
          text,
          ...(speaker !== undefined && speaker !== '' ? { speaker } : {}),
        })
        break
      }
      case '参戦': {
        const t = needTarget()
        if (t === null) break
        rules.push({ kind: 'join', conds, target: t, ...(text ? { text } : {}) })
        break
      }
      case '復活': {
        const t = needTarget()
        if (t === null) break
        let hp: ScriptAmount | undefined
        let mp: ScriptAmount | undefined
        const hpRaw = params.get('HP')
        const mpRaw = params.get('MP')
        if (hpRaw !== undefined) {
          const a = parseAmount('HP', hpRaw)
          if (typeof a === 'string') {
            warn(line, a)
            break
          }
          hp = a
        }
        if (mpRaw !== undefined) {
          const a = parseAmount('MP', mpRaw)
          if (typeof a === 'string') {
            warn(line, a)
            break
          }
          mp = a
        }
        const status = params.get('付与')
        rules.push({
          kind: 'revive',
          conds,
          target: t,
          ...(hp ? { hp } : {}),
          ...(mp ? { mp } : {}),
          ...(status ? { status } : {}),
          ...(text ? { text } : {}),
        })
        break
      }
      case '逃走': {
        const t = needTarget()
        if (t === null) break
        rules.push({ kind: 'flee', conds, target: t, ...(text ? { text } : {}) })
        break
      }
      case '終了': {
        const r = params.get('結果')
        if (r === undefined || !hasOwn(RESULT_WORDS, r)) {
          warn(line, '結果= は 勝利 / 敗北 / 中断 のいずれかです')
          break
        }
        rules.push({ kind: 'end', conds, result: RESULT_WORDS[r], ...(text ? { text } : {}) })
        break
      }
      case '下限': {
        const t = needTarget()
        if (t === null) break
        const hpRaw = params.get('HP')
        if (hpRaw === undefined || !/^\d+$/.test(hpRaw) || Number(hpRaw) < 1) {
          warn(line, 'HP= は 1 以上の整数で書いてください')
          break
        }
        const ft: FloorTarget =
          t === '味方全員'
            ? { kind: 'party' }
            : t === '敵全員'
              ? { kind: 'enemies' }
              : { kind: 'id', id: t }
        rules.push({ kind: 'floor', conds, target: ft, hp: Number(hpRaw) })
        break
      }
      case '固定': {
        const r = params.get('結果')
        if (r === undefined || !hasOwn(RESULT_WORDS, r)) {
          warn(line, '結果= は 勝利 / 敗北 / 中断 のいずれかです')
          break
        }
        let turns = SCRIPT_DEFAULT_MAX_TURNS
        const tRaw = params.get('上限ターン')
        if (tRaw !== undefined) {
          if (!/^\d+$/.test(tRaw) || Number(tRaw) < 1 || Number(tRaw) > SCRIPT_MAX_TURNS) {
            warn(line, `上限ターン= は 1〜${SCRIPT_MAX_TURNS} の整数で書いてください`)
            break
          }
          turns = Number(tRaw)
        }
        fixedCount++
        const result = RESULT_WORDS[r]
        if (result !== 'defeat')
          rules.push({ kind: 'floor', conds: [], target: { kind: 'party' }, hp: 1 })
        if (result !== 'victory') {
          rules.push({ kind: 'floor', conds: [], target: { kind: 'enemies' }, hp: 1 })
        }
        rules.push({
          kind: 'end',
          conds: [{ not: false, cond: { k: 'turn', op: '>=', n: turns } }],
          result,
        })
        break
      }
      default: {
        // 勝利時 / 敗北時 / 中断時 / 逃走時
        const outcome = OUTCOME_KINDS[kl.kind]
        const cur = hasOwn(results, outcome) ? results[outcome] : undefined
        const entry: ScriptOutcomeResult = cur ?? { flags: {} }
        const flagsRaw = params.get('フラグ')
        if (flagsRaw !== undefined) {
          const f = parseScriptFlags(flagsRaw)
          for (const w of f.warnings) warn(line, w)
          for (const [k, v] of Object.entries(f.flags)) safeAssign(entry.flags, k, v)
        }
        const next = params.get('次')
        if (next !== undefined && next !== '') entry.next = next
        safeAssign(results, outcome, entry)
      }
    }
  }
  if (fixedCount > 1) {
    warnings.push(
      '固定: が複数あります（床と終了が重なるだけで、いちばん早い上限ターンで終わります）'
    )
  }
  const hasFloor = rules.some((r) => r.kind === 'floor')
  const hasExit = rules.some((r) => r.kind === 'end' || r.kind === 'flee')
  if (hasFloor && !hasExit) {
    warnings.push(
      '下限: を使っていますが、終了: / 逃走: / 固定: がありません。倒せない・倒れない者がいると決着しない恐れがあります'
    )
  }
  return { rules, results, noEscape, warnings }
}

// ---------------------------------------------------------------------------
// 評価
// ---------------------------------------------------------------------------

/** id が一致する最初の者（味方 → 敵の順） */
function findById(view: ScriptView, id: string): { hp: number; maxHp: number } | undefined {
  return view.party.find((p) => p.id === id) ?? view.enemies.find((e) => e.id === id)
}

function condHolds(c: Cond, view: ScriptView): boolean {
  switch (c.k) {
    case 'turn':
      return compareNumbers(view.turn, c.op, c.n)
    case 'hp': {
      const e = findById(view, c.id)
      if (!e) return false
      const left = c.percent ? (e.maxHp > 0 ? (e.hp / e.maxHp) * 100 : 0) : e.hp
      return compareNumbers(left, c.op, c.n)
    }
    case 'down': {
      const all = [...view.party, ...view.enemies].filter((e) => e.id === c.id)
      return all.length > 0 && all.every((e) => e.hp <= 0)
    }
    case 'alive':
      return [...view.party, ...view.enemies].some((e) => e.id === c.id && e.hp > 0)
    case 'party':
      return compareNumbers(view.party.filter((p) => p.hp > 0).length, c.op, c.n)
    case 'enemies':
      return compareNumbers(view.enemies.filter((e) => e.hp > 0).length, c.op, c.n)
    case 'joined':
      return view.joined.includes(c.id)
  }
}

/** 条件の AND（空は常に成立） */
export function conditionsHold(conds: readonly Condition[], view: ScriptView): boolean {
  return conds.every((c) => condHolds(c.cond, view) !== c.not)
}

/**
 * いま発動する（まだ発動していない）ルールのうち、宣言順で最初の 1 つを返す。無ければ null。
 * 発動は 1 回だけ（`state.fired` に入ったルールは返さない）。`復活` は対象が HP0 のとき、`逃走` は対象の敵が生きているときだけ成立し、
 * 成立しなければ（条件が真でも）発動を保留する。`参戦` は対象が既に味方にいても発動する扱い（エンジンが何もしないで済ませる）
 */
export function nextScriptAction(
  parsed: ParsedBattleScript,
  state: Pick<ScriptState, 'fired'>,
  view: ScriptView
): ScriptAction | null {
  for (let index = 0; index < parsed.rules.length; index++) {
    if (state.fired.includes(index)) continue
    const rule = parsed.rules[index]
    if (rule.kind === 'floor') continue
    if (!conditionsHold(rule.conds, view)) continue
    switch (rule.kind) {
      case 'line':
        return {
          index,
          kind: 'line',
          text: rule.text,
          ...(rule.speaker !== undefined ? { speaker: rule.speaker } : {}),
        }
      case 'join':
        return {
          index,
          kind: 'join',
          target: rule.target,
          ...(rule.text !== undefined ? { text: rule.text } : {}),
        }
      case 'revive': {
        const downed = view.party.some((p) => p.id === rule.target && p.hp <= 0)
        if (!downed) continue
        return {
          index,
          kind: 'revive',
          target: rule.target,
          ...(rule.hp ? { hp: rule.hp } : {}),
          ...(rule.mp ? { mp: rule.mp } : {}),
          ...(rule.status ? { status: rule.status } : {}),
          ...(rule.text !== undefined ? { text: rule.text } : {}),
        }
      }
      case 'flee': {
        const alive = view.enemies.some((e) => e.id === rule.target && e.hp > 0)
        if (!alive) continue
        return {
          index,
          kind: 'flee',
          target: rule.target,
          ...(rule.text !== undefined ? { text: rule.text } : {}),
        }
      }
      case 'end':
        return {
          index,
          kind: 'end',
          result: rule.result,
          ...(rule.text !== undefined ? { text: rule.text } : {}),
        }
    }
  }
  return null
}

/**
 * 条件が真の `下限` ルールから、味方・敵ごとの HP 下限を求める（重なれば大きいほう）。下限が無い者は 0。
 * 下限は最大 HP を超えない（最大 HP 1 の者の下限 5 は 1）
 */
export function computeFloors(
  parsed: ParsedBattleScript,
  view: ScriptView
): { party: number[]; enemies: number[] } {
  const party = view.party.map(() => 0)
  const enemies = view.enemies.map(() => 0)
  for (const rule of parsed.rules) {
    if (rule.kind !== 'floor' || !conditionsHold(rule.conds, view)) continue
    const t = rule.target
    const apply = (list: number[], side: ReadonlyArray<{ id: string; maxHp: number }>): void => {
      side.forEach((e, i) => {
        if (t.kind === 'id' && e.id !== t.id) return
        list[i] = Math.max(list[i], Math.min(rule.hp, Math.max(0, e.maxHp)))
      })
    }
    if (t.kind !== 'enemies') apply(party, view.party)
    if (t.kind !== 'party') apply(enemies, view.enemies)
  }
  return { party, enemies }
}

/** 終わり方に対応する `勝利時` などの宣言（無ければ undefined） */
export function resultFor(
  parsed: ParsedBattleScript,
  outcome: ScriptOutcome
): ScriptOutcomeResult | undefined {
  return hasOwn(parsed.results, outcome) ? parsed.results[outcome] : undefined
}

/** `復活` の HP / MP の量（最大値に対する指定を実数にする）。HP は 1 以上・最大値以下に収める */
export function resolveAmount(a: ScriptAmount | undefined, max: number, min: number): number {
  const raw = a ? (a.percent ? Math.floor((max * a.value) / 100) : Math.floor(a.value)) : max
  return Math.min(max, Math.max(min, raw))
}
