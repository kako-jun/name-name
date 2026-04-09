const STORAGE_KEY = 'name-name'

interface StorageData {
  darkMode?: boolean
  apiBaseUrl?: string
}

function load(): StorageData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as StorageData
  } catch {
    return {}
  }
}

function save(data: StorageData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // storage full or unavailable
  }
}

export function get<K extends keyof StorageData>(key: K): StorageData[K] {
  return load()[key]
}

export function set<K extends keyof StorageData>(key: K, value: StorageData[K]): void {
  const data = load()
  data[key] = value
  save(data)
}
