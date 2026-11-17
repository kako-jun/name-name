import { afterEach, describe, expect, it } from 'vitest'
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
import { createMemoryTraceStorage } from './traceStorage'
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
    traceRec('f.scene', { id: 'a' })
    traceFlush(true)
    const firstId = traceDump().session.id

    resetTraceForTest() // ページの再読み込み相当
    configureTrace(true, { storage: st, search: '' })
    await traceReady()
    const d = traceDump()
    expect(d.session.id).not.toBe(firstId)
    expect(d.prev?.id).toBe(firstId)
    expect(d.prev?.entries.map((e) => e.k)).toEqual(['trace.on', 'f.scene'])
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
