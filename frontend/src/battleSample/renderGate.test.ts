import { describe, expect, it } from 'vitest'
import { createRenderGate } from './renderGate'

/** unload を手動で完了させられるフェイク */
function fakeUnload() {
  const calls: string[] = []
  const done: Array<() => void> = []
  const unload = (url: string): Promise<void> => {
    calls.push(url)
    return new Promise<void>((resolve) => done.push(resolve))
  }
  return { unload, calls, finish: () => done.splice(0).forEach((f) => f()) }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createRenderGate (#760)', () => {
  it('unload が要らない描画はすぐ進める', async () => {
    const g = createRenderGate(fakeUnload().unload)
    const seq = g.begin([])
    expect(await g.wait(seq)).toBe(true)
  })

  it('unload が要る描画は、unload が終わってから進む', async () => {
    const f = fakeUnload()
    const g = createRenderGate(f.unload)
    const seq = g.begin(['a.png', 'b.png'])
    let passed = false
    void g.wait(seq).then(() => (passed = true))
    await tick()
    expect(f.calls).toEqual(['a.png', 'b.png'])
    expect(passed).toBe(false)
    f.finish()
    await tick()
    expect(passed).toBe(true)
  })

  it('A の unload 待ちの最中に始まった B（unload 不要）も、A の unload が終わるまで進まない。A は捨てられる', async () => {
    const f = fakeUnload()
    const g = createRenderGate(f.unload)
    const a = g.begin(['a.png'])
    const b = g.begin([])
    const order: string[] = []
    void g.wait(a).then((ok) => order.push(`A:${ok}`))
    void g.wait(b).then((ok) => order.push(`B:${ok}`))
    await tick()
    expect(order).toEqual([]) // B も待っている（unload 前のテクスチャを受け取らない）
    f.finish()
    await tick()
    expect(order).toEqual(['A:false', 'B:true'])
  })

  it('B も unload が要るときは、A の unload の後ろに続けて予約される（同時に走らない）', async () => {
    const f = fakeUnload()
    const g = createRenderGate(f.unload)
    g.begin(['a.png'])
    const b = g.begin(['b.png'])
    await tick()
    expect(f.calls).toEqual(['a.png']) // B の unload は A の完了後
    f.finish()
    await tick()
    expect(f.calls).toEqual(['a.png', 'b.png'])
    let ok: boolean | null = null
    void g.wait(b).then((v) => (ok = v))
    await tick()
    expect(ok).toBeNull() // B の unload がまだ
    f.finish()
    await tick()
    expect(ok).toBe(true)
  })

  it('unload が失敗しても描画は進む', async () => {
    const g = createRenderGate(() => Promise.reject(new Error('not loaded')))
    const seq = g.begin(['x.png'])
    expect(await g.wait(seq)).toBe(true)
  })
})
