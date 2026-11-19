import { describe, expect, it } from 'vitest'
import { firstRejection, settleStartup } from './startupSettle'

const ok = (value: unknown = 1): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value })
const ng = (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason })

describe('settleStartup: 並列読み込みの失敗の扱い', () => {
  it('全部成功なら失敗なし', () => {
    expect(settleStartup([ok(), ok()], ok())).toEqual({ failed: false })
  })
  it('複数失敗は、時間順でなく並べた順（従来の読み込み順）で最初のものを返す', () => {
    const first = new Error('walk')
    const later = new Error('scene')
    const r = settleStartup([ok(), ng(first), ng(later)], ok())
    expect(r).toMatchObject({ failed: true, reason: first })
  })
  it('素材が失敗し描画器が成功済みなら描画器を破棄させる', () => {
    expect(settleStartup([ng('x')], ok())).toMatchObject({ failed: true, destroyApp: true })
  })
  it('描画器の初期化が失敗したら破棄するものが無い（素材の失敗が先ならそちらを返す）', () => {
    expect(settleStartup([ok()], ng('gl'))).toEqual({
      failed: true,
      reason: 'gl',
      destroyApp: false,
    })
    expect(settleStartup([ng('asset')], ng('gl'))).toMatchObject({
      reason: 'asset',
      destroyApp: false,
    })
  })
})

describe('firstRejection: 向きごとなどの並列読み込みの失敗', () => {
  it('失敗が無ければ何も投げない', () => {
    expect(() => firstRejection([ok(), ok()])).not.toThrow()
  })
  it('複数失敗しても、並べた順で最初の失敗を投げる（先に失敗した方ではない）', () => {
    const up = new Error('up')
    const down = new Error('down')
    // 時間順なら down が先に失敗したが、向きの順では up が先
    expect(() => firstRejection([ng(up), ok(), ng(down)])).toThrow(up)
  })
})
