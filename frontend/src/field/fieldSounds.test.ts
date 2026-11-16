import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFieldSoundPlayer, loadFieldSounds, playFieldSound } from './fieldSounds'
afterEach(() => vi.unstubAllGlobals())
describe('optional field sounds', () => {
  it('uses the current SE setting for encounter and battle sounds, and skips resumed battles', () => {
    const instances: Array<{ volume: number; play: ReturnType<typeof vi.fn> }> = []
    const audio = vi.fn(function () {
      const instance = { volume: 0, play: vi.fn().mockResolvedValue(undefined) }
      instances.push(instance)
      return instance
    })
    vi.stubGlobal('Audio', audio)
    let level: number | undefined = 3
    const player = createFieldSoundPlayer(
      { encounter: '/encounter.ogg', attack: '/attack.ogg' },
      () => level
    )
    player.battleStart(false)
    expect(audio).toHaveBeenCalledWith('/encounter.ogg')
    expect(instances[0].volume).toBe(0.6)
    expect(instances[0].play).toHaveBeenCalledOnce()
    player.battleStart(true)
    expect(audio).toHaveBeenCalledTimes(1)
    level = 1
    player.play('attack')
    expect(audio).toHaveBeenLastCalledWith('/attack.ogg')
    expect(instances[1].volume).toBe(0.2)
    level = 0
    player.battleStart(false)
    player.play('attack')
    expect(audio).toHaveBeenCalledTimes(2)
    level = undefined
    player.battleStart(false)
    expect(instances[2].volume).toBe(0.8)
  })
  it('accepts only simple names in the manifest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ cursor: 'cursor.ogg', attack: '../bad.ogg' }),
      })
    )
    expect(await loadFieldSounds('/api/assets/')).toEqual({
      cursor: '/api/assets/sounds/se/cursor.ogg',
    })
    expect(fetch).toHaveBeenCalledWith('/api/assets/sounds/se/cursor.ogg', { signal: undefined })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('leaves missing manifests silent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await loadFieldSounds('/api/assets')).toEqual({})
  })
  it.each([
    { ok: false, json: async () => ({ cursor: 'cursor.ogg' }) },
    { ok: true, json: async () => null },
    { ok: true, json: async () => [] },
    {
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json')
      },
    },
  ])('ignores invalid manifest responses', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    expect(await loadFieldSounds('/assets')).toEqual({})
  })
  it('keeps valid entries if prefetch fails and ignores unknown or invalid entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ cursor: 'cursor.ogg', confirm: 1, unknown: 'other.ogg' }),
        })
        .mockRejectedValue(new Error('prefetch failed'))
    )
    expect(await loadFieldSounds('/assets/')).toEqual({ cursor: '/assets/sounds/se/cursor.ogg' })
  })
  it('honours zero volume and plays at nonzero volume', () => {
    const play = vi.fn().mockResolvedValue(undefined)
    const audio = vi.fn(function () {
      return { volume: 0, play }
    })
    vi.stubGlobal('Audio', audio)
    playFieldSound({ cursor: '/c.ogg' }, 'cursor', 0)
    expect(audio).not.toHaveBeenCalled()
    playFieldSound({ cursor: '/c.ogg' }, 'cursor', 0.8)
    expect(audio).toHaveBeenCalledWith('/c.ogg')
    expect(play).toHaveBeenCalledOnce()
  })
  it('ignores missing keys and clamps excessive volume', () => {
    const play = vi.fn().mockResolvedValue(undefined)
    const instance = { volume: 0, play }
    const audio = vi.fn(function () {
      return instance
    })
    vi.stubGlobal('Audio', audio)
    playFieldSound({}, 'cursor', 1)
    playFieldSound({ cursor: '/c.ogg' }, 'cursor', -1)
    expect(audio).not.toHaveBeenCalled()
    playFieldSound({ cursor: '/c.ogg' }, 'cursor', 2)
    expect(instance.volume).toBe(1)
    expect(play).toHaveBeenCalledOnce()
  })
  it('tolerates a rejected playback or audio constructor', async () => {
    vi.stubGlobal(
      'Audio',
      vi.fn(function () {
        return { volume: 0, play: () => Promise.reject(new Error('blocked')) }
      })
    )
    expect(() => playFieldSound({ cursor: '/c.ogg' }, 'cursor', 1)).not.toThrow()
    await Promise.resolve()
    vi.stubGlobal(
      'Audio',
      vi.fn(function () {
        throw new Error('unsupported')
      })
    )
    expect(() => playFieldSound({ cursor: '/c.ogg' }, 'cursor', 1)).not.toThrow()
  })
})
