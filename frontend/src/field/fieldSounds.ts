/** Optional project sounds. Missing manifests leave existing projects silent. */
export type FieldSound =
  | 'cursor'
  | 'confirm'
  | 'cancel'
  | 'error'
  | 'encounter'
  | 'mosaic'
  | 'attack'
  | 'damage'
  | 'heal'

export async function loadFieldSounds(
  base: string,
  signal?: AbortSignal
): Promise<Partial<Record<FieldSound, string>>> {
  try {
    const root = `${base.replace(/\/$/, '')}/sounds/se/`
    const response = await fetch(`${root}manifest.json`, { signal })
    if (!response.ok) return {}
    const manifest: unknown = await response.json()
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return {}
    const result: Partial<Record<FieldSound, string>> = {}
    for (const key of [
      'cursor',
      'confirm',
      'cancel',
      'error',
      'encounter',
      'mosaic',
      'attack',
      'damage',
      'heal',
    ] as const) {
      const file = (manifest as Record<string, unknown>)[key]
      if (typeof file === 'string' && /^[a-z0-9_-]+\.ogg$/.test(file)) result[key] = root + file
    }
    // Warm the HTTP cache without delaying the game. Playback remains optional.
    if (!signal?.aborted)
      for (const url of new Set(Object.values(result))) void fetch(url, { signal }).catch(() => {})
    return result
  } catch {
    return {}
  }
}

export function playFieldSound(
  sounds: Partial<Record<FieldSound, string>>,
  key: FieldSound,
  volume: number
): void {
  const url = sounds[key]
  if (!url || volume <= 0) return
  try {
    const audio = new Audio(url)
    audio.volume = Math.max(0, Math.min(1, volume))
    void audio.play().catch(() => {})
  } catch {
    /* audio is optional */
  }
}

/** 戦闘開始と戦闘中で現在の設定を共有する。設定は再生のたびに読む。 */
export function createFieldSoundPlayer(
  sounds: Partial<Record<FieldSound, string>>,
  getLevel: () => number | undefined
): { play: (key: FieldSound) => void; battleStart: (resuming: boolean) => void } {
  const play = (key: FieldSound): void => playFieldSound(sounds, key, (getLevel() ?? 4) / 5)
  return {
    play,
    battleStart: (resuming) => {
      if (!resuming) play('encounter')
    },
  }
}
