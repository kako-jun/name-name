const DB_NAME = 'name-name-script-content-cache'
const DB_VERSION = 1
const STORE_NAME = 'scriptContents'
const PATH_INDEX = 'byPathKey'

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

function encodeKeyPart(part: string): string {
  return encodeURIComponent(part)
}

function buildKey({ projectName, ref, path, sha }: ScriptContentCacheKey): string {
  return [projectName, ref, path, sha].map(encodeKeyPart).join('|')
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
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      if (store && !store.indexNames.contains(PATH_INDEX)) {
        store.createIndex(PATH_INDEX, 'pathKey', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
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
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
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
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
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

export const __internal = {
  buildKey,
  buildPathKey,
}
