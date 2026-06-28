import type { EventDocument } from '../types'

const DB_NAME = 'name-name-script-content-cache'
const DB_VERSION = 2
const CONTENT_STORE_NAME = 'scriptContents'
const DOCUMENT_STORE_NAME = 'scriptDocuments'
const PATH_INDEX = 'byPathKey'
export const PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION = 1

export interface ScriptContentCacheKey {
  projectName: string
  ref: string
  path: string
  sha: string
}

interface ScriptContentCacheRecord extends ScriptContentCacheKey {
  key: string
  pathKey: string
  content: string
  updatedAt: number
}

interface ParsedScriptDocumentCacheRecord extends ScriptContentCacheKey {
  key: string
  pathKey: string
  schemaVersion: number
  document: EventDocument
  updatedAt: number
}

function encodeKeyPart(part: string): string {
  return encodeURIComponent(part)
}

function buildKey({ projectName, ref, path, sha }: ScriptContentCacheKey): string {
  return [projectName, ref, path, sha].map(encodeKeyPart).join('|')
}

function buildDocumentKey(keyParts: ScriptContentCacheKey, schemaVersion: number): string {
  return `${buildKey(keyParts)}|schema:${schemaVersion}`
}

function buildPathKey({ projectName, ref, path }: Omit<ScriptContentCacheKey, 'sha'>): string {
  return [projectName, ref, path].map(encodeKeyPart).join('|')
}

function getIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  const dbFactory = getIndexedDB()
  if (!dbFactory) return Promise.resolve(null)

  return new Promise((resolve) => {
    const request = dbFactory.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      ensureStore(db, request.transaction, CONTENT_STORE_NAME)
      ensureStore(db, request.transaction, DOCUMENT_STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function ensureStore(
  db: IDBDatabase,
  transaction: IDBTransaction | null,
  storeName: string
): IDBObjectStore | null {
  const store = db.objectStoreNames.contains(storeName)
    ? transaction?.objectStore(storeName)
    : db.createObjectStore(storeName, { keyPath: 'key' })
  if (store && !store.indexNames.contains(PATH_INDEX)) {
    store.createIndex(PATH_INDEX, 'pathKey', { unique: false })
  }
  return store ?? null
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => resolve(null)
  })
}

export async function getCachedScriptContent(
  keyParts: ScriptContentCacheKey
): Promise<string | null> {
  const db = await openDatabase()
  if (!db) return null

  try {
    const tx = db.transaction(CONTENT_STORE_NAME, 'readonly')
    const store = tx.objectStore(CONTENT_STORE_NAME)
    const record = await requestResult<ScriptContentCacheRecord | undefined>(
      store.get(buildKey(keyParts))
    )
    return typeof record?.content === 'string' ? record.content : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

export async function putCachedScriptContent(
  keyParts: ScriptContentCacheKey,
  content: string
): Promise<void> {
  const db = await openDatabase()
  if (!db) return

  const pathKey = buildPathKey(keyParts)
  const record: ScriptContentCacheRecord = {
    ...keyParts,
    key: buildKey(keyParts),
    pathKey,
    content,
    updatedAt: Date.now(),
  }

  try {
    const tx = db.transaction(CONTENT_STORE_NAME, 'readwrite')
    const store = tx.objectStore(CONTENT_STORE_NAME)
    store.put(record)

    // 同じ path の古い sha はベストエフォートで掃除する。
    const index = store.index(PATH_INDEX)
    const oldRecords = await requestResult<ScriptContentCacheRecord[]>(
      index.getAll(IDBKeyRange.only(pathKey))
    )
    for (const oldRecord of oldRecords ?? []) {
      if (oldRecord.key !== record.key) store.delete(oldRecord.key)
    }
  } catch {
    // キャッシュは最適化なので、保存失敗で再生を止めない。
  } finally {
    db.close()
  }
}

export async function getCachedParsedScriptDocument(
  keyParts: ScriptContentCacheKey,
  schemaVersion = PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION
): Promise<EventDocument | null> {
  const db = await openDatabase()
  if (!db) return null

  try {
    const tx = db.transaction(DOCUMENT_STORE_NAME, 'readonly')
    const store = tx.objectStore(DOCUMENT_STORE_NAME)
    const record = await requestResult<ParsedScriptDocumentCacheRecord | undefined>(
      store.get(buildDocumentKey(keyParts, schemaVersion))
    )
    return record?.schemaVersion === schemaVersion && record.document ? record.document : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

export async function putCachedParsedScriptDocument(
  keyParts: ScriptContentCacheKey,
  document: EventDocument,
  schemaVersion = PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION
): Promise<void> {
  const db = await openDatabase()
  if (!db) return

  const pathKey = buildPathKey(keyParts)
  const record: ParsedScriptDocumentCacheRecord = {
    ...keyParts,
    key: buildDocumentKey(keyParts, schemaVersion),
    pathKey,
    schemaVersion,
    document,
    updatedAt: Date.now(),
  }

  try {
    const tx = db.transaction(DOCUMENT_STORE_NAME, 'readwrite')
    const store = tx.objectStore(DOCUMENT_STORE_NAME)
    store.put(record)

    const index = store.index(PATH_INDEX)
    const oldRecords = await requestResult<ParsedScriptDocumentCacheRecord[]>(
      index.getAll(IDBKeyRange.only(pathKey))
    )
    for (const oldRecord of oldRecords ?? []) {
      if (oldRecord.key !== record.key) store.delete(oldRecord.key)
    }
  } catch {
    // キャッシュは最適化なので、保存失敗で再生を止めない。
  } finally {
    db.close()
  }
}

export const __internal = {
  buildKey,
  buildDocumentKey,
  buildPathKey,
}
