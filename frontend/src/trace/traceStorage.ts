/**
 * 内部トレースログ (#1197) の保存先。遊んだ人の端末（IndexedDB / localStorage）の中だけに置き、外へは送らない。
 * 保存は「通常は IndexedDB に非同期」「ページを離れる・例外のときは localStorage に同期」の二段構え
 * （ページを離れる最中の非同期書き込みは完了しないことがあるため）。読み戻しは新しい方を採る。
 */
import type { TraceEntry } from './traceRing'

/** 1 回のページ表示（セッション）ぶんの記録 */
export interface TraceSession {
  /** セッションの識別（乱数。個人を表さない） */
  id: string
  /** 開始時刻（epoch ms）。複数セッションを並べるための目安 */
  startedAt: number
  /** 最後に保存した時刻（epoch ms）。読み戻しで新しい方を選ぶのに使う */
  savedAt: number
  /** 積んだ総数（リングが溢れて捨てた分も含む） */
  total: number
  entries: TraceEntry[]
}

/** 保存する全体。session = このページ表示、prev = 直前までの 1 セッション（再読み込みしても残す） */
export interface TracePersisted {
  v: 1
  session: TraceSession
  prev: TraceSession | null
}

export interface TraceStorage {
  /** 保存済みの JSON 文字列。無い・読めないときは null */
  load(): Promise<string | null>
  /** 非同期で書く（定期保存）。失敗は握りつぶす */
  saveAsync(json: string): Promise<void>
  /** 同期で書く（pagehide・例外）。失敗は握りつぶす */
  saveSync(json: string): void
}

const DB_NAME = 'name-name-trace'
const STORE = 'kv'
const KEY = 'trace'
export const TRACE_LS_KEY = 'name-name:trace'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function idbGet(db: IDBDatabase): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function idbPut(db: IDBDatabase, json: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(json, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** 保存済み JSON を読んで形を確かめる。壊れていたら null */
export function parsePersisted(json: string | null): TracePersisted | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Partial<TracePersisted> | null
    if (!p || p.v !== 1 || !p.session || !Array.isArray(p.session.entries)) return null
    return p as TracePersisted
  } catch {
    return null
  }
}

/** 実ブラウザの保存先（IndexedDB + localStorage）。どちらも使えない環境では黙って何も保存しない */
export function createBrowserTraceStorage(): TraceStorage {
  let dbPromise: Promise<IDBDatabase | null> | null = null
  const db = (): Promise<IDBDatabase | null> => (dbPromise ??= openDb())
  return {
    async load() {
      const fromIdb = await db().then((d) => (d ? idbGet(d) : null))
      let fromLs: string | null = null
      try {
        fromLs = localStorage.getItem(TRACE_LS_KEY)
      } catch {
        fromLs = null
      }
      // 新しい方（savedAt が大きい）を採る
      const a = parsePersisted(fromIdb)
      const b = parsePersisted(fromLs)
      if (a && b) return b.session.savedAt > a.session.savedAt ? fromLs : fromIdb
      return a ? fromIdb : b ? fromLs : null
    },
    async saveAsync(json) {
      const d = await db()
      if (d) await idbPut(d, json)
    },
    saveSync(json) {
      try {
        localStorage.setItem(TRACE_LS_KEY, json)
      } catch {
        // 容量超過・無効化: 諦める（トレースのために本編を止めない）
      }
    },
  }
}

/** メモリだけの保存先（テスト・保存先なしの環境用） */
export function createMemoryTraceStorage(): TraceStorage & { value: string | null } {
  const s = {
    value: null as string | null,
    async load() {
      return s.value
    },
    async saveAsync(json: string) {
      s.value = json
    },
    saveSync(json: string) {
      s.value = json
    },
  }
  return s
}
