/**
 * 内部トレースログ (#1197)。画面には何も出さない。「何が起きたか」を後から追えるよう、遊んだ人の端末の中だけに
 * 直近 N 件の記録を持つ。frontmatter `trace: on` のときだけ働く（既定 off = 何も記録せず、乱数の流れも変えない）。
 *
 * - 記録: `traceRec(kind, data)`。off のときは 1 回の真偽判定だけで戻る。呼び出し側は重い組み立ての前に `traceOn()` で確かめる
 * - 保存: 変更があれば 3 秒ごとに IndexedDB、ページを離れる・例外のときは localStorage に同期書き出し。再読み込みしても直前の分が残る
 * - 取り出し: コンソール `window.nameNameTrace.dump()`、URL に `?trace`（前回＋今回を JSON ファイルにして保存）
 * - プライバシー: 自由文のキー（名前・台詞・合言葉など）は記録しない。外へは送らない
 */
import { TRACE_CAPACITY, TraceRing, sanitizeTraceValue, type TraceEntry } from './traceRing'
import {
  createBrowserTraceStorage,
  parsePersisted,
  type TraceSession,
  type TraceStorage,
} from './traceStorage'

export type { TraceEntry, TraceValue } from './traceRing'

/** 起動のたびに必ず出る記録。これだけのセッションは「中身のある前回」とみなさない（#1197 レビュー） */
const STARTUP_KINDS = new Set(['trace.on', 'f.scene', 'f.move'])

/** 起動時の記録か。場面の auto トリガーが起こすイベント（`f.event` の `auto: 1`）も、操作由来ではないので起動の記録に数える */
function isStartupEntry(e: TraceEntry): boolean {
  if (STARTUP_KINDS.has(e.k)) return true
  return (
    e.k === 'f.event' && !!e.d && typeof e.d === 'object' && (e.d as { auto?: number }).auto === 1
  )
}

/** 取り出す JSON の形。version は将来の形式変更用 */
export interface TraceDump {
  version: 1
  /** 直前までのセッション（再読み込み前の分）。無ければ null */
  prev: TraceSession | null
  /** このページ表示の記録 */
  session: TraceSession
}

const FLUSH_INTERVAL_MS = 3000

let ring: TraceRing | null = null
let enabled = false
let sessionId = ''
let startedAt = 0
let t0 = 0
let prev: TraceSession | null = null
let dirty = false
let storage: TraceStorage | null = null
let timer: ReturnType<typeof setInterval> | null = null
let listenersAttached = false
/** このゲームの識別。別のゲームの記録を前回分に混ぜない */
let gameId = ''
/** 前回分の JSON（不変なので 1 回だけ文字列化して持つ。保存のたびに文字列化し直さない） */
let prevJson = 'null'
/** 例外起因の同期保存の最終時刻。毎フレーム例外でも書き込みを間引く */
let lastErrFlushAt = -Infinity
const ERR_FLUSH_MIN_MS = 2000
const onPageHide = (): void => traceFlush(true)
const onVisibility = (): void => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') traceFlush(true)
}
const onError = (e: Event): void => {
  const ev = e as ErrorEvent
  traceRec('err', { msg: String(ev.message ?? ''), at: `${ev.lineno ?? 0}:${ev.colno ?? 0}` })
  flushAfterError()
}
const onRejection = (e: Event): void => {
  const r = (e as PromiseRejectionEvent).reason
  traceRec('err', { msg: String(r instanceof Error ? r.message : r), promise: true })
  flushAfterError()
}
function flushAfterError(): void {
  const now = nowMs()
  if (now - lastErrFlushAt < ERR_FLUSH_MIN_MS) return
  lastErrFlushAt = now
  traceFlush(true)
}
let pendingLoad: Promise<void> = Promise.resolve()
/** 前回分の読み戻しが済んだか。済む前に保存すると、読み戻す前の prev（null）で保存済みの前回分を潰すので保留する */
let loaded = true

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

/** トレースが働いているか。記録点は重い組み立ての前にこれで確かめる */
export function traceOn(): boolean {
  return enabled
}

/** 記録する。off のときは何もしない。data は無害化される（自由文のキーは落ちる） */
export function traceRec(kind: string, data?: unknown): void {
  if (!enabled || !ring) return
  const d = data === undefined ? undefined : sanitizeTraceValue(data)
  ring.push(Math.round((nowMs() - t0) * 10) / 10, kind, d)
  dirty = true
}

/** 乱数の種を新しく作る（戦闘の再現用。トレース on のときだけ使う） */
export function traceNewSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0 || 1
}

function currentSession(): TraceSession {
  return {
    id: sessionId,
    game: gameId,
    startedAt,
    savedAt: Date.now(),
    total: ring?.total ?? 0,
    entries: ring?.toArray() ?? [],
  }
}

/** 取り出し用の全体 */
export function traceDump(): TraceDump {
  return { version: 1, prev, session: currentSession() }
}

/** JSON 文字列で取り出す */
export function traceDumpJson(space?: number): string {
  return JSON.stringify(traceDump(), null, space)
}

/** いまの記録を保存先へ書く。sync = ページを離れる・例外のとき（localStorage にも同期で書く） */
export function traceFlush(sync = false): void {
  if (!enabled || !storage || !ring || !loaded) return
  if (!dirty && !sync) return
  dirty = false
  // 前回分は不変なので、文字列化済みのものをそのまま継ぎ足す（今回分だけ都度文字列化する）
  const json = `{"v":1,"session":${JSON.stringify(currentSession())},"prev":${prevJson}}`
  if (sync) storage.saveSync(json)
  void storage.saveAsync(json)
}

/** 前回までの記録を読み戻したあとに解決する（テスト用） */
export function traceReady(): Promise<void> {
  return pendingLoad
}

function attachListeners(): void {
  if (listenersAttached || typeof globalThis.addEventListener !== 'function') return
  listenersAttached = true
  globalThis.addEventListener('pagehide', onPageHide)
  globalThis.addEventListener('visibilitychange', onVisibility)
  // 例外は記録して、すぐ保存する（落ちたあとに追えるよう。毎フレーム例外でも 2 秒に 1 回まで）
  globalThis.addEventListener('error', onError)
  globalThis.addEventListener('unhandledrejection', onRejection)
}

function detachListeners(): void {
  if (!listenersAttached) return
  listenersAttached = false
  globalThis.removeEventListener('pagehide', onPageHide)
  globalThis.removeEventListener('visibilitychange', onVisibility)
  globalThis.removeEventListener('error', onError)
  globalThis.removeEventListener('unhandledrejection', onRejection)
}

/** 取り出しの隠し操作をコンソールに生やす */
function installConsoleApi(): void {
  const api = {
    dump: (): string => traceDumpJson(),
    json: (): TraceDump => traceDump(),
    copy: async (): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(traceDumpJson())
        return true
      } catch {
        return false
      }
    },
    download: (): boolean => traceDownload(),
    clear: (): void => traceClear(),
  }
  ;(globalThis as { nameNameTrace?: typeof api }).nameNameTrace = api
}

/** JSON をファイルとして保存させる（ブラウザのダウンロード）。DOM が無ければ false */
export function traceDownload(): boolean {
  try {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const blob = new Blob([traceDumpJson(1)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `name-name-trace-${sessionId}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch {
    return false
  }
}

/** 記録を全部捨てる（前回分も、保存済みも） */
export function traceClear(): void {
  ring?.clear()
  prev = null
  prevJson = 'null'
  dirty = true
  traceFlush(true)
}

/** URL に `?trace` があるか（`?trace=0`・`?trace=off`・`?trace=false` は無し扱い） */
export function wantsTraceDownload(search: string): boolean {
  const v = new URLSearchParams(search).get('trace')
  return v !== null && v !== '0' && v !== 'off' && v !== 'false'
}

/**
 * トレースを入れる / 切る。ゲームの読み込み（frontmatter `trace:`）が呼ぶ。on のとき:
 * リングを作り、前回分を `prev` に読み戻し、定期保存とページ離脱の保存を仕掛け、コンソール API を生やす。
 * 既に on なら何もしない（読み込みのたびに呼ばれても記録は続く）。off にすると記録を止める（保存済みには触らない）。
 *
 * `opts` はテスト用。
 */
export function configureTrace(
  on: boolean,
  opts: { storage?: TraceStorage | null; capacity?: number; search?: string; game?: string } = {}
): void {
  const game = opts.game ?? ''
  if (!on || (enabled && game !== gameId)) {
    // off に替わった・別のゲームに替わった: 記録を止め、コンソール API とイベント受け口を外す（保存済みには触らない）
    traceFlush(true)
    enabled = false
    if (timer) clearInterval(timer)
    timer = null
    detachListeners()
    delete (globalThis as { nameNameTrace?: unknown }).nameNameTrace
    if (!on) return
  }
  if (enabled) return
  enabled = true
  gameId = game
  ring = new TraceRing(opts.capacity ?? TRACE_CAPACITY)
  sessionId = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  startedAt = Date.now()
  t0 = nowMs()
  prev = null
  prevJson = 'null'
  dirty = false
  lastErrFlushAt = -Infinity
  storage = opts.storage === undefined ? createBrowserTraceStorage() : opts.storage
  traceRec('trace.on', { v: 1, cap: ring.capacity })
  installConsoleApi()
  attachListeners()
  if (storage) {
    loaded = false
    pendingLoad = storage.load().then((json) => {
      const old = parsePersisted(json)
      if (old) {
        // 前回のセッションに「起動の印以外」の記録があれば、それを prev にする。無ければ（空の再読み込みの連続）前の prev を残す
        // 起動のたびに必ず出る記録（起動・場面・最初の移動）だけのセッションは前回とみなさない（戦闘 → 再読み込み 2 回でも戦闘が残る）。
        // 別のゲームの記録は混ぜない
        const meaningful = old.session.entries.some((e) => !isStartupEntry(e))
        const cand = meaningful ? old.session : old.prev
        prev = cand && (cand.game ?? '') === gameId ? cand : null
        prevJson = JSON.stringify(prev)
      }
      const search = opts.search ?? (typeof location !== 'undefined' ? location.search : '')
      if (wantsTraceDownload(search)) traceDownload()
      loaded = true
      dirty = true
      traceFlush()
    })
    // 読み戻しが失敗しても、保存は再開する（前回分は無いものとして）
    pendingLoad = pendingLoad
      .catch(() => {})
      .finally(() => {
        loaded = true
      })
    timer = setInterval(() => traceFlush(), FLUSH_INTERVAL_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }
}

/** テスト用: すべて初期状態に戻す */
export function resetTraceForTest(): void {
  enabled = false
  if (timer) clearInterval(timer)
  timer = null
  ring = null
  prev = null
  prevJson = 'null'
  gameId = ''
  detachListeners()
  delete (globalThis as { nameNameTrace?: unknown }).nameNameTrace
  storage = null
  dirty = false
  pendingLoad = Promise.resolve()
  loaded = true
}
