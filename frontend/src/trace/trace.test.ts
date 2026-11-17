import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureTrace,
  resetTraceForTest,
  traceClear,
  traceDump,
  traceFlush,
  traceOn,
  traceReady,
  traceRec,
  wantsTraceDownload,
} from './trace'
import { createBrowserTraceStorage, createMemoryTraceStorage } from './traceStorage'
import { normalizeTrace } from './traceOption'

afterEach(() => {
  resetTraceForTest()
  delete (globalThis as { nameNameTrace?: unknown }).nameNameTrace
})

describe('trace (#1197)', () => {
  it('既定は off: 何も記録せず、コンソール API も生やさない', () => {
    expect(traceOn()).toBe(false)
    traceRec('x', { a: 1 })
    expect(traceDump().session.entries).toEqual([])
    expect((globalThis as { nameNameTrace?: unknown }).nameNameTrace).toBeUndefined()
  })

  it('on: 記録でき、window.nameNameTrace.dump() で JSON が取れる', () => {
    configureTrace(true, { storage: null, search: '' })
    traceRec('b.hp', { i: 0, from: 5, to: 0, name: '消える' })
    const api = (globalThis as { nameNameTrace?: { dump(): string } }).nameNameTrace
    expect(api).toBeDefined()
    const parsed = JSON.parse(api!.dump())
    expect(parsed.version).toBe(1)
    const kinds = parsed.session.entries.map((e: { k: string }) => e.k)
    expect(kinds).toEqual(['trace.on', 'b.hp'])
    expect(parsed.session.entries[1].d).toEqual({ i: 0, from: 5, to: 0 })
  })

  it('off に戻すと記録が止まる', () => {
    configureTrace(true, { storage: null })
    configureTrace(false)
    traceRec('x')
    expect(traceDump().session.entries.map((e) => e.k)).toEqual(['trace.on'])
  })

  it('保存→再読み込み: 直前のセッションが prev に残る', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '' })
    await traceReady()
    traceRec('f.talk', { npc: 'a', open: 1 })
    traceFlush(true)
    const firstId = traceDump().session.id

    resetTraceForTest() // ページの再読み込み相当
    configureTrace(true, { storage: st, search: '' })
    await traceReady()
    const d = traceDump()
    expect(d.session.id).not.toBe(firstId)
    expect(d.prev?.id).toBe(firstId)
    expect(d.prev?.entries.map((e) => e.k)).toEqual(['trace.on', 'f.talk'])
  })

  it('何も起きなかった再読み込みは、古い prev を潰さない', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '' })
    await traceReady()
    traceRec('b.end', { out: 'victory' })
    traceFlush(true)
    const firstId = traceDump().session.id
    for (let i = 0; i < 2; i++) {
      resetTraceForTest()
      configureTrace(true, { storage: st, search: '' })
      await traceReady()
      traceFlush(true)
    }
    expect(traceDump().prev?.id).toBe(firstId)
  })

  it('固定長: 容量を超えたら古い分から捨てる', () => {
    configureTrace(true, { storage: null, capacity: 5 })
    for (let i = 0; i < 20; i++) traceRec('k', i)
    const e = traceDump().session.entries
    expect(e).toHaveLength(5)
    expect(e[4].d).toBe(19)
    expect(traceDump().session.total).toBe(21)
  })

  it('clear: 今回も前回も保存済みも消える', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '' })
    await traceReady()
    traceRec('k')
    traceClear()
    expect(traceDump().session.entries).toEqual([])
    expect(traceDump().prev).toBeNull()
    expect(JSON.parse(st.value as string).session.entries).toEqual([])
  })
})

describe('trace: 前回分・ゲーム識別・解除・例外 (#1197 レビュー)', () => {
  /** 一枚絵フィールドの起動で必ず出る記録 */
  const boot = (): void => {
    traceRec('f.scene', { id: 'a' })
    traceRec('f.move', { x: 1, y: 2 })
  }

  it('戦闘 → 再読み込み → 再読み込み → 取り出し でも戦闘の記録が残る', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    boot()
    traceRec('b.end', { out: 'defeat' })
    traceFlush(true)
    const battleSession = traceDump().session.id
    for (let i = 0; i < 3; i++) {
      resetTraceForTest()
      configureTrace(true, { storage: st, search: '', game: 'g' })
      await traceReady()
      boot()
      traceFlush(true)
    }
    const d = traceDump()
    expect(d.prev?.id).toBe(battleSession)
    expect(d.prev?.entries.some((e) => e.k === 'b.end')).toBe(true)
  })

  it('開幕の auto イベント（f.event の auto: 1）があっても、戦闘が prev から消えない', async () => {
    const st = createMemoryTraceStorage()
    const autoBoot = (): void => {
      boot()
      traceRec('f.event', { id: 'intro', open: 1, auto: 1 })
      traceRec('f.event', { id: 'intro', open: 0, auto: 1 })
    }
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    autoBoot()
    traceRec('b.end', { out: 'defeat' })
    traceFlush(true)
    for (let i = 0; i < 3; i++) {
      resetTraceForTest()
      configureTrace(true, { storage: st, search: '', game: 'g' })
      await traceReady()
      autoBoot()
      traceFlush(true)
    }
    expect(traceDump().prev?.entries.some((e) => e.k === 'b.end')).toBe(true)
  })

  it('プレイヤーが起こしたイベント（auto なし）は操作由来として前回に残る', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    boot()
    traceRec('f.event', { id: 'talk', open: 1 })
    traceFlush(true)
    const id = traceDump().session.id
    resetTraceForTest()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    expect(traceDump().prev?.id).toBe(id)
  })

  it('前回分の読み戻しが済む前の離脱保存では、保存済みの前回分を潰さない', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    traceRec('b.end', { out: 'victory' })
    traceFlush(true)
    const savedBefore = st.value
    resetTraceForTest()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    // 読み戻し中（await していない）にページ離脱
    traceFlush(true)
    expect(st.value).toBe(savedBefore)
    await traceReady()
    expect(traceDump().prev?.entries.some((e) => e.k === 'b.end')).toBe(true)
  })

  it('別のゲームの記録は前回分に混ぜない', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '', game: 'a' })
    await traceReady()
    traceRec('b.end')
    traceFlush(true)
    resetTraceForTest()
    configureTrace(true, { storage: st, search: '', game: 'b' })
    await traceReady()
    expect(traceDump().prev).toBeNull()
  })

  it('同じページで別のゲームに替えると、前のゲームの記録は引き継がず作り直す', () => {
    configureTrace(true, { storage: null, game: 'a' })
    traceRec('x')
    configureTrace(true, { storage: null, game: 'b' })
    expect(traceDump().session.entries.map((e) => e.k)).toEqual(['trace.on'])
  })

  it('off に替えると、コンソール API とイベント受け口が外れる', () => {
    configureTrace(true, { storage: null })
    expect((globalThis as { nameNameTrace?: unknown }).nameNameTrace).toBeDefined()
    configureTrace(false)
    expect((globalThis as { nameNameTrace?: unknown }).nameNameTrace).toBeUndefined()
    globalThis.dispatchEvent(new ErrorEvent('error', { message: 'late' }))
    expect(traceDump().session.entries.some((e) => e.k === 'err')).toBe(false)
  })

  it('例外を記録し、毎フレーム例外でも同期保存は間引く', async () => {
    const st = createMemoryTraceStorage()
    let syncWrites = 0
    const origSync = st.saveSync
    st.saveSync = (j: string) => {
      syncWrites++
      origSync(j)
    }
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    for (let i = 0; i < 50; i++)
      globalThis.dispatchEvent(new ErrorEvent('error', { message: 'boom', lineno: 3 }))
    const errs = traceDump().session.entries.filter((e) => e.k === 'err')
    expect(errs).toHaveLength(50)
    expect(errs[0].d).toMatchObject({ msg: 'boom', at: '3:0' })
    expect(syncWrites).toBe(1)
  })

  it('保存先が使えない環境（localStorage が例外・IndexedDB 無し）でも本編を止めない', async () => {
    const ls = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    configureTrace(true, { storage: createBrowserTraceStorage(), search: '', game: 'g' })
    await traceReady()
    traceRec('b.end')
    expect(() => traceFlush(true)).not.toThrow()
    expect(traceDump().session.entries.map((e) => e.k)).toContain('b.end')
    ls.mockRestore()
    vi.restoreAllMocks()
  })

  it('保存される JSON は取り出しと同じ形（前回分はキャッシュした文字列を継ぎ足す）', async () => {
    const st = createMemoryTraceStorage()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    traceRec('b.end', { out: 'victory' })
    traceFlush(true)
    resetTraceForTest()
    configureTrace(true, { storage: st, search: '', game: 'g' })
    await traceReady()
    traceRec('b.start', { bid: 9 })
    traceFlush(true)
    const saved = JSON.parse(st.value as string)
    expect(saved.v).toBe(1)
    expect(saved.prev.entries.map((e: { k: string }) => e.k)).toContain('b.end')
    expect(saved.session.entries.map((e: { k: string }) => e.k)).toContain('b.start')
  })
})

describe('?trace と trace キー', () => {
  it('URL の ?trace を判定する', () => {
    expect(wantsTraceDownload('?trace')).toBe(true)
    expect(wantsTraceDownload('?a=1&trace=1')).toBe(true)
    expect(wantsTraceDownload('?trace=0')).toBe(false)
    expect(wantsTraceDownload('?trace=off')).toBe(false)
    expect(wantsTraceDownload('?x=1')).toBe(false)
  })

  it('normalizeTrace: 未指定・空・不正は off（不正は警告）', () => {
    expect(normalizeTrace(undefined)).toBe('off')
    expect(normalizeTrace(null)).toBe('off')
    expect(normalizeTrace('')).toBe('off')
    expect(normalizeTrace(' ON ')).toBe('on')
    expect(normalizeTrace('off')).toBe('off')
    expect(normalizeTrace('maybe', false)).toBe('off')
  })
})
