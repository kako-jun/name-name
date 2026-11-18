/**
 * 戦闘の内部トレース (#1197)。`BattleEngine` の公開メソッドを包んで「入力・経過時間・結果の差分」を記録し、
 * `BattleScreen` から「演出の再生位置・解決されたポーズ・窓の開閉・入力」を受け取る。エンジンの本体は変えない
 * （包むのは instance だけで、トレース off の戦闘には何も付かない）。
 *
 * 記録は `trace/trace.ts` のリングバッファへ（再現テストでは `sink` で差し替える）。毎フレームは取らない:
 * tick は経過 ms を合算して 250ms ごと・入力の直前にまとめて 1 件、状態は変わったときと 1 秒ごとの snap だけ。
 */
import type { BattleEngine, BattleActionEvent, BattlePhase } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { MenuStack } from './battleMenu'
import { traceOn, traceOnPreFlush, traceRec, type TraceValue } from '../trace/trace'

/** 記録の出力先。既定は共通のリングバッファ。再現テストが差し替える */
export type TraceSink = (kind: string, data?: unknown) => void

/** 経過 ms をまとめて 1 件にする間隔 */
const ADV_FLUSH_MS = 250
/** 状態の定期スナップショットの間隔（戦闘の時計） */
const SNAP_EVERY_MS = 1000

let battleSeq = 0
const tracers = new WeakMap<BattleEngine, BattleTracer>()

/** 記録対象のエンジンメソッド（入力）。名前は b.cmd の `c` に出る */
type CmdName =
  | 'selectAttack'
  | 'selectSummon'
  | 'selectEscape'
  | 'selectSpell'
  | 'selectSkill'
  | 'selectItem'
  | 'notifyBlocked'

const SIDE = { party: 0, enemy: 1 } as const

function hitKind(k: string): string {
  return k === 'damage' ? 'd' : k === 'heal' ? 'h' : 'm'
}

/** エンジン 1 戦闘ぶんのトレース。`attachBattleTrace` で作る */
export class BattleTracer {
  readonly bid: number
  private readonly sink: TraceSink
  private advMs = 0
  private clock = 0
  private lastSnapAt = 0
  /** エンジンの公開メソッドの入れ子の深さ。内側の呼び出し（select 同士）を二重に記録しない */
  depth = 0
  private lastHold = false
  /** 保存前の端数書き出しの解除（end で外す）。既定の出力先のときだけ付く (#1215) */
  private unhook: (() => void) | null = null
  private seenEvents: number
  private lastPhase: BattlePhase
  private lastHead = -2
  private lastQLen = -1
  private lastHp: { party: number[]; enemy: number[] } = { party: [], enemy: [] }
  private lastStatus: { party: string[]; enemy: string[] } = { party: [], enemy: [] }
  private lastSnap = ''
  private lastWin = ''
  /** ポーズ比較用の控え（陣営ごとに index 引き。毎フレーム文字列を作らない） */
  private readonly lastPose: { party: PoseMemo[]; enemy: PoseMemo[] } = { party: [], enemy: [] }

  constructor(
    private readonly engine: BattleEngine,
    sink: TraceSink,
    info: Record<string, unknown>
  ) {
    this.bid = ++battleSeq
    this.sink = sink
    const s = engine.getState()
    this.seenEvents = s.eventTotal
    this.lastPhase = s.phase
    const ent = (e: BattleEntity): unknown => JSON.parse(JSON.stringify(e))
    this.sink('b.start', {
      bid: this.bid,
      seed: engine.getRngSeed() ?? null,
      party: s.party.map(ent),
      enemies: s.enemies.map(ent),
      // ATB の方式と、開始時のゲージ・コマンド待ちの順（セーブからの再開は途中のゲージから始まる）
      atb: s.atb
        ? {
            mode: s.atb.mode,
            g: [s.atb.partyGauge.map(r3), s.atb.enemyGauge.map(r3)],
            q: [...s.atb.queue],
          }
        : null,
      ...info,
    })
    this.syncBaseline()
  }

  /** 以降の差分の基準を今の状態に合わせる（記録はしない） */
  private syncBaseline(): void {
    const s = this.engine.getState()
    this.lastHp = { party: s.party.map((e) => e.hp), enemy: s.enemies.map((e) => e.hp) }
    this.lastStatus = {
      party: s.party.map((e) => statusSig(e)),
      enemy: s.enemies.map((e) => statusSig(e)),
    }
    this.lastHead = this.head()
    this.lastQLen = s.atb?.queue.length ?? 0
  }

  private head(): number {
    return this.engine.getCurrentActorIndex()
  }

  // ===== エンジンを包む =====

  /** 入力（コマンド選択）。直前までの経過時間をまとめて書いてから、コマンドを書く */
  input(c: CmdName, ref: string | null, targetId: string | undefined, extra?: unknown): void {
    this.flushAdv()
    const s = this.engine.getState()
    this.sink('b.cmd', {
      bid: this.bid,
      c,
      ref,
      tg: targetId ?? null,
      actor: this.head(),
      ph: s.phase,
      ...(extra === undefined ? {} : { x: extra }),
    })
  }

  /**
   * 番の入れ替え（`switchAtbActor`。コマンド入力権を別の味方へ移す入力）。**切り替えが効いたときだけ**エンジンの包みから呼ぶ
   * （dq・コマンド待ちでない・対象が不適格で false の呼び出しは記録しない）。再実行は `b.switch` を入力として `switchAtbActor(to)` を呼ぶ
   * （`ReplayResolvers.switchActor` で差し替え可）
   */
  switched(data: Record<string, unknown>): void {
    this.flushAdv()
    this.sink('b.switch', { bid: this.bid, ...data })
  }

  /** 候補窓による ATB 停止の切り替え */
  hold(hold: boolean): void {
    if (hold === this.lastHold) return
    this.lastHold = hold
    this.flushAdv()
    this.sink('b.hold', { bid: this.bid, hold })
  }

  waitScope(scope: string): void {
    this.flushAdv()
    this.sink('b.scope', { bid: this.bid, scope })
  }

  /** tick の経過 ms を合算する（毎フレーム 1 件は取らない） */
  tickMs(ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return
    this.advMs += ms
    if (this.advMs >= ADV_FLUSH_MS) this.flushAdv()
  }

  /** ページを離れる・例外・取り出しの直前に、未書き出しの経過時間の端数を記録へ書く (#1215) */
  flushPending(): void {
    this.flushAdv()
  }

  /** 保存前の端数書き出しに登録する（end で自動解除） */
  hookPreFlush(): void {
    this.unhook ??= traceOnPreFlush(() => this.flushAdv())
  }

  private flushAdv(): void {
    if (this.advMs <= 0) return
    this.sink('b.adv', { bid: this.bid, ms: Math.round(this.advMs * 1000) / 1000 })
    this.advMs = 0
  }

  /** エンジンの呼び出しが済んだあと。増えた行動・HP の変化・倒れ・フェーズ・入力権の移動を差分で書く */
  after(): void {
    const s = this.engine.getState()
    // 行動（各ヒットの HP の前後・ダメージ・回復・即死）
    const added = s.eventTotal - this.seenEvents
    if (added > 0) {
      this.seenEvents = s.eventTotal
      const fresh = s.events.slice(Math.max(0, s.events.length - added))
      for (const ev of fresh) this.sink('b.act', actData(this.bid, ev))
    }
    // HP の変化・倒れ・復活（どの経路で変わっても拾う）
    this.diffHp('party', s.party)
    this.diffHp('enemy', s.enemies)
    // 状態異常の付け外し
    this.diffStatus('party', s.party)
    this.diffStatus('enemy', s.enemies)
    if (s.phase !== this.lastPhase) {
      this.sink('b.phase', { bid: this.bid, from: this.lastPhase, to: s.phase })
      this.lastPhase = s.phase
    }
    // コマンド入力権の移動（待ちキューの先頭・長さが変わったとき）
    const head = this.head()
    const qlen = s.atb?.queue.length ?? 0
    if (head !== this.lastHead || qlen !== this.lastQLen) {
      this.lastHead = head
      this.lastQLen = qlen
      this.sink('b.actor', { bid: this.bid, cur: head, q: s.atb ? [...s.atb.queue] : null })
    }
  }

  private diffHp(side: 'party' | 'enemy', list: readonly BattleEntity[]): void {
    const prev = this.lastHp[side]
    for (let i = 0; i < list.length; i++) {
      const hp = list[i].hp
      const was = prev[i]
      if (was === undefined) {
        this.sink('b.join', { bid: this.bid, s: SIDE[side], i, hp })
      } else if (hp !== was) {
        this.sink('b.hp', { bid: this.bid, s: SIDE[side], i, from: was, to: hp })
        if (was > 0 && hp <= 0) this.sink('b.ko', { bid: this.bid, s: SIDE[side], i })
        else if (was <= 0 && hp > 0) this.sink('b.rev', { bid: this.bid, s: SIDE[side], i, hp })
      }
      prev[i] = hp
    }
  }

  private diffStatus(side: 'party' | 'enemy', list: readonly BattleEntity[]): void {
    const prev = this.lastStatus[side]
    for (let i = 0; i < list.length; i++) {
      const sig = statusSig(list[i])
      if (sig !== (prev[i] ?? '')) {
        this.sink('b.st', { bid: this.bid, s: SIDE[side], i, st: { ...(list[i].status ?? {}) } })
      }
      prev[i] = sig
    }
  }

  // ===== 画面（BattleScreen）から受ける =====

  /** 画面が受けた入力（キー/タップ）。何を押したかだけ（文字入力のフォームは対象外） */
  screenInput(src: 'key' | 'tap' | 'cmd', v: string): void {
    this.sink('b.in', { bid: this.bid, src, v })
  }

  /** 演出の発火: 命中の瞬間に表示 HP（hpOverride）が確定値へ進む */
  fire(
    seq: number,
    sinceHit: number,
    round: number | undefined,
    hits: readonly { s: 'party' | 'enemy'; i: number; after: number }[],
    override: ReadonlyMap<string, number>
  ): void {
    this.sink('b.fire', {
      bid: this.bid,
      seq,
      since: sinceHit,
      r: round ?? 0,
      hits: hits.map((h) => [SIDE[h.s], h.i, h.after]),
      ov: [...override].map(([k, v]) => [k, v]),
    })
  }

  /** 演出が追いつき、表示 HP の控え（hpOverride）を捨てた */
  overrideCleared(): void {
    this.sink('b.fire', { bid: this.bid, clear: true })
  }

  /** ポーズの解決。変わったときだけ書く（毎フレーム呼んでよい） */
  pose(
    side: 'party' | 'enemy',
    index: number,
    requested: string,
    resolved: string | null,
    path: string | null,
    look: string | null = null
  ): void {
    const list = this.lastPose[side]
    const m = list[index]
    if (m && m.req === requested && m.res === resolved && m.path === path && m.look === look) return
    list[index] = { req: requested, res: resolved, path, look }
    this.sink('b.pose', {
      bid: this.bid,
      s: SIDE[side],
      i: index,
      req: requested,
      res: resolved,
      img: path,
      // 倒れの絵が無い者の見せ方（`sink` = 沈み込み / `tilt` = 傾き）。絵で表す者は null
      ...(look ? { look } : {}),
    })
  }

  /** ポーズ絵（基本の絵を含む）の読み込みの成否 */
  load(side: 'party' | 'enemy', index: number, pose: string, ok: boolean, path: string): void {
    this.sink('b.load', { bid: this.bid, s: SIDE[side], i: index, pose, ok, img: path })
  }

  /** 候補窓の開閉・段。変わったときだけ書く */
  windows(stack: MenuStack): void {
    const sig = stack.map((w) => `${w.type}:${'kind' in w ? w.kind : ''}`).join('>')
    if (sig === this.lastWin) return
    const opened = this.lastWin === '' && sig !== ''
    const closed = this.lastWin !== '' && sig === ''
    this.lastWin = sig
    this.sink('b.win', {
      bid: this.bid,
      ev: opened ? 'open' : closed ? 'close' : 'move',
      stack: sig,
    })
  }

  /** 画面の時計を進める（定期スナップショットの間隔用。エンジンの tick とは別。毎フレーム呼んでよい） */
  clockTick(dt: number): void {
    this.clock += dt
  }

  /**
   * 状態の全体像。periodic = 戦闘の時計で 1 秒ごと（変わらなくても書く）、そうでなければ前回から変わったときだけ。
   * shown = 画面が見せている HP（hpOverride 込み）。busy = 演出の再生中
   */
  snap(
    shown: (side: 'party' | 'enemy', i: number, cur: number) => number,
    busy: boolean,
    winDepth: number,
    periodic: boolean
  ): void {
    if (periodic && this.clock - this.lastSnapAt < SNAP_EVERY_MS) return
    const s = this.engine.getState()
    const hpRow = (side: 'party' | 'enemy', e: BattleEntity, i: number): number[] => [
      e.hp,
      shown(side, i, e.hp),
    ]
    const p = s.party.map((e, i) => hpRow('party', e, i))
    const en = s.enemies.map((e, i) => hpRow('enemy', e, i))
    const q = s.atb ? [...s.atb.queue] : null
    const cur = this.head()
    const busyN = busy ? 1 : 0
    // ゲージの揺れだけで書かないよう、署名はゲージを除く
    const sig = JSON.stringify([s.phase, p, en, q, cur, winDepth, busyN])
    if (!periodic && sig === this.lastSnap) return
    this.lastSnap = sig
    this.lastSnapAt = this.clock
    this.sink('b.snap', {
      bid: this.bid,
      ph: s.phase,
      p,
      e: en,
      g: s.atb ? [s.atb.partyGauge.map(Math.round), s.atb.enemyGauge.map(Math.round)] : null,
      q,
      cur,
      w: winDepth,
      busy: busyN,
    })
  }

  /** 戦闘が閉じた */
  end(outcome: string): void {
    this.unhook?.()
    this.unhook = null
    this.flushAdv()
    const s = this.engine.getState()
    this.sink('b.end', {
      bid: this.bid,
      out: outcome,
      p: s.party.map((e) => e.hp),
      e: s.enemies.map((e) => e.hp),
    })
  }

  /** 画面の作り直しなどで、エンジンの現在値を基準にし直す */
  resync(): void {
    this.seenEvents = this.engine.getState().eventTotal
    this.syncBaseline()
  }
}

interface PoseMemo {
  req: string
  res: string | null
  path: string | null
  look: string | null
}

/** 小数 3 桁まで（開始ゲージは丸めない。再実行で満タンの時刻がずれないように） */
const r3 = (n: number): number => Math.round(n * 1000) / 1000

function statusSig(e: BattleEntity): string {
  const st = e.status
  if (!st) return ''
  let out = ''
  for (const k of Object.keys(st)) out += `${k}=${st[k]};`
  return out
}

function actData(bid: number, ev: BattleActionEvent): TraceValue {
  return {
    bid,
    seq: ev.seq,
    a: [SIDE[ev.actor.side], ev.actor.index],
    k: ev.kind,
    // 脚本の台詞・知らせ（notice）の label は本文なので記録しない。呪文・道具などマスター名だけ残す
    ref: ev.line || ev.kind === 'notice' ? null : (ev.label ?? null),
    hits: ev.hits.map((h) => [
      SIDE[h.target.side],
      h.target.index,
      hitKind(h.kind),
      h.amount,
      h.hpBefore,
      h.hpAfter,
      (h.instantDeath ? 1 : 0) | (h.reversed ? 2 : 0),
      h.round ?? 0,
    ]),
  }
}

/** 引数から b.cmd の ref（呪文・特技・道具の名前。ゲームのマスター定義の名前で、遊んだ人の入力ではない）を取り出す */
function refOf(args: unknown[]): string | null {
  const a = args[0] as { name?: unknown } | undefined
  return a && typeof a === 'object' && typeof a.name === 'string' ? a.name : null
}

/**
 * エンジンにトレースを付ける。トレース off なら何もせず null。同じエンジンに二度付けても 1 つ（画面の作り直し）。
 * `sink` / `force` は再現テスト用（off でも付ける）
 */
export function attachBattleTrace(
  engine: BattleEngine,
  info: Record<string, unknown> = {},
  opts: { sink?: TraceSink; force?: boolean } = {}
): BattleTracer | null {
  if (!opts.force && !traceOn()) return null
  const existing = tracers.get(engine)
  if (existing) {
    existing.resync()
    return existing
  }
  const tracer = new BattleTracer(engine, opts.sink ?? traceRec, info)
  tracers.set(engine, tracer)
  if (!opts.sink) tracer.hookPreFlush()
  const e = engine as unknown as Record<string, (...a: unknown[]) => unknown>
  const wrapCmd = (name: CmdName): void => {
    const orig = e[name].bind(engine)
    e[name] = (...args: unknown[]): unknown => {
      if (tracer.depth > 0) return orig(...args)
      tracer.depth++
      try {
        tracer.input(
          name,
          refOf(args),
          typeof args[0] === 'string' ? args[0] : (args[1] as string | undefined),
          name === 'selectSpell' ? args[2] : undefined
        )
        const r = orig(...args)
        tracer.after()
        return r
      } finally {
        tracer.depth--
      }
    }
  }
  for (const n of [
    'selectAttack',
    'selectSummon',
    'selectEscape',
    'selectSpell',
    'selectSkill',
    'selectItem',
    'notifyBlocked',
  ] as const)
    wrapCmd(n)
  const origTick = e.tick.bind(engine)
  e.tick = (ms: unknown): unknown => {
    if (tracer.depth > 0) return origTick(ms)
    tracer.depth++
    try {
      tracer.tickMs(ms as number)
      const r = origTick(ms)
      tracer.after()
      return r
    } finally {
      tracer.depth--
    }
  }
  const origSwitch = e.switchAtbActor.bind(engine)
  e.switchAtbActor = (index: unknown): unknown => {
    if (tracer.depth > 0) return origSwitch(index)
    tracer.depth++
    try {
      const from = engine.getCurrentActorIndex()
      const ok = origSwitch(index)
      if (ok) {
        tracer.switched({ from, to: index as number })
        tracer.after()
      }
      return ok
    } finally {
      tracer.depth--
    }
  }
  const origHold = e.setAtbHold.bind(engine)
  e.setAtbHold = (h: unknown): unknown => {
    if (tracer.depth === 0 && engine.getState().atb) tracer.hold(!!h)
    return origHold(h)
  }
  const origScope = e.setAtbWaitScope.bind(engine)
  e.setAtbWaitScope = (sc: unknown): unknown => {
    if (tracer.depth === 0 && engine.getState().atb) tracer.waitScope(String(sc))
    return origScope(sc)
  }
  return tracer
}
