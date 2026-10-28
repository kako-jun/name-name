/**
 * preloadPlan.ts（先読み URL の収集）のテスト (#822)。
 *
 * 切り出し前の `NovelRenderer.preloadUpcomingAssets` の URL 収集部を `referenceCollect` として
 * このファイルに写し（origin/main の実装そのまま・`this` を引数に置き換えただけ）、多入力で突き合わせる。
 * 個別の仕様ケースは URL をリテラルで書き、定数計算をテスト側に持ち込まない。
 */
import { describe, it, expect } from 'vitest'
import type { Event } from '../types'
import { collectUpcomingAssetUrls, PRELOAD_MAX_TEXT_EVENTS } from './preloadPlan'
import { getTextEvent } from './eventCursor'
import { resolveAssetUrl, resolveCharacterImageUrls } from './novelLayout'

const BASE = 'http://h/assets'

const narr = (s = 'n'): Event => ({ Narration: { text: [s] } })
const dlg = (
  character: string | null,
  expression: string | null,
  position: string | null
): Event => ({
  Dialog: { character, expression, position, text: ['x'] },
})
const exprChange = (character: string, expression: string): Event => ({
  ExpressionChange: { character, expression },
})
const bg = (path: string): Event => ({ Background: { path } })

/** origin/main `preloadUpcomingAssets` の URL 収集部を写したリファレンス（assetBaseUrl / eventIndex を引数化）。 */
function referenceCollect(
  resolvedEvents: Event[],
  eventIndex: number,
  assetBaseUrl: string
): string[] {
  if (!assetBaseUrl) return []
  const urls: string[] = []
  let textEventCount = 0
  for (let i = eventIndex; i < resolvedEvents.length; i++) {
    const event = resolvedEvents[i]
    if (typeof event !== 'object' || event === null) continue
    if ('Choice' in event || 'Condition' in event || 'Jump' in event) break
    if (getTextEvent(event) !== null) {
      if (textEventCount >= Infinity) break
      textEventCount++
    }
    if ('Dialog' in event) {
      const { character, expression, position } = event.Dialog
      if (expression && character && position) {
        for (const u of resolveCharacterImageUrls(assetBaseUrl, expression.replace(/^\//, ''))) {
          urls.push(u)
        }
      }
    } else if ('ExpressionChange' in event) {
      const { character, expression } = event.ExpressionChange
      if (expression && character) {
        for (const u of resolveCharacterImageUrls(assetBaseUrl, expression.replace(/^\//, ''))) {
          urls.push(u)
        }
      }
    } else if ('Enter' in event) {
      const { character, expression, position } = event.Enter
      if (expression && character && position) {
        for (const u of resolveCharacterImageUrls(assetBaseUrl, expression.replace(/^\//, ''))) {
          urls.push(u)
        }
      }
    } else if ('Background' in event) {
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Background.path))
    } else if ('BackgroundBoard' in event) {
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.BackgroundBoard.path))
    } else if ('Prop' in event) {
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Prop.path))
    } else if ('EventImage' in event) {
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.EventImage.path))
    } else if ('Image' in event) {
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Image.path))
    }
  }
  const seen = new Set<string>()
  return urls.filter((u) => {
    if (seen.has(u)) return false
    seen.add(u)
    return true
  })
}

describe('collectUpcomingAssetUrls: 仕様ケース (#822)', () => {
  it('上限は撤廃されたまま(Infinity)', () => {
    expect(PRELOAD_MAX_TEXT_EVENTS).toBe(Infinity)
  })

  it('各 variant の URL 形（立ち絵は webp/png 2 候補、拡張子付きは 1 つ、他は images/ 配下）', () => {
    const events: Event[] = [
      dlg('a', 'a/smile', 'Left'),
      { Enter: { character: 'b', expression: '/b/hi.png', position: 'Right' } } as Event,
      bg('bg/room.png'),
      { BackgroundBoard: { path: 'board.png', depth: 1 } },
      { Prop: { path: 'desk.png', depth: 1 } },
      { EventImage: { path: 'ev/1.png', back: 'Hide' } } as Event,
      { Image: { path: '/img/x.png' } } as Event,
    ]
    expect(collectUpcomingAssetUrls(events, 0, BASE)).toEqual([
      'http://h/assets/images/a/smile.webp',
      'http://h/assets/images/a/smile.png',
      'http://h/assets/images/b/hi.png',
      'http://h/assets/images/bg/room.png',
      'http://h/assets/images/board.png',
      'http://h/assets/images/desk.png',
      'http://h/assets/images/ev/1.png',
      'http://h/assets/images/img/x.png',
    ])
  })

  it('Choice / Condition で打ち切り、Jump はその手前まで集める', () => {
    for (const stop of [
      { Choice: { options: [] } } as Event,
      { Condition: { flag: 'f', events: [bg('after.png')] } } as Event,
      { Jump: { target: 's' } } as Event,
    ]) {
      const events: Event[] = [bg('before.png'), stop, bg('after.png')]
      expect(collectUpcomingAssetUrls(events, 0, BASE)).toEqual([
        'http://h/assets/images/before.png',
      ])
    }
  })

  it('近い順で、重複は初出を残す(Dialog と ExpressionChange の同じ表情も 1 回)', () => {
    const events: Event[] = [
      bg('1.png'),
      dlg('a', 'a/smile', 'Left'),
      bg('2.png'),
      exprChange('a', 'a/smile'),
      bg('1.png'),
    ]
    expect(collectUpcomingAssetUrls(events, 0, BASE)).toEqual([
      'http://h/assets/images/1.png',
      'http://h/assets/images/a/smile.webp',
      'http://h/assets/images/a/smile.png',
      'http://h/assets/images/2.png',
    ])
  })

  it('空文字 expression・空 character・position 欠落の Dialog/Enter は積まない（ExpressionChange は position 不要）', () => {
    const events: Event[] = [
      dlg('a', '', 'Left'),
      dlg('a', null, 'Left'),
      dlg('a', 'a/x', null),
      dlg('a', 'a/x', ''),
      dlg(null, 'a/x', 'Left'),
      { Enter: { character: 'a', expression: 'a/e', position: '' } } as Event,
      exprChange('a', ''),
      exprChange('', 'a/x'),
    ]
    expect(collectUpcomingAssetUrls(events, 0, BASE)).toEqual([])
    expect(collectUpcomingAssetUrls([exprChange('a', 'a/ok')], 0, BASE)).toEqual([
      'http://h/assets/images/a/ok.webp',
      'http://h/assets/images/a/ok.png',
    ])
  })

  it('assetBaseUrl が空なら空配列、文字列 variant は読み飛ばして走査を続ける', () => {
    expect(collectUpcomingAssetUrls([bg('a.png')], 0, '')).toEqual([])
    expect(
      collectUpcomingAssetUrls(['PageBreak', 'SceneTransition', 'VideoExit', bg('a.png')], 0, BASE)
    ).toEqual(['http://h/assets/images/a.png'])
  })

  it('fromIndex は含む起点: 手前は無視し、末尾・範囲外・空配列は空', () => {
    const events: Event[] = [bg('0.png'), bg('1.png'), bg('2.png')]
    expect(collectUpcomingAssetUrls(events, 1, BASE)).toEqual([
      'http://h/assets/images/1.png',
      'http://h/assets/images/2.png',
    ])
    expect(collectUpcomingAssetUrls(events, 3, BASE)).toEqual([])
    expect(collectUpcomingAssetUrls(events, 99, BASE)).toEqual([])
    expect(collectUpcomingAssetUrls([], 0, BASE)).toEqual([])
  })

  it('fromIndex が分岐そのものなら何も集めない', () => {
    const events: Event[] = [{ Choice: { options: [] } }, bg('a.png')]
    expect(collectUpcomingAssetUrls(events, 0, BASE)).toEqual([])
  })
})

describe('collectUpcomingAssetUrls: 旧実装リファレンスとの突き合わせ (#822)', () => {
  const pool: Event[] = [
    narr(),
    dlg('a', 'a/smile', 'Left'),
    dlg('a', 'a/smile', 'Left'),
    dlg('b', '/b/sad.png', 'Right'),
    dlg('a', '', 'Left'),
    dlg('a', 'a/x', null),
    exprChange('a', 'a/smile'),
    exprChange('b', 'b/angry'),
    exprChange('a', ''),
    { Enter: { character: 'c', expression: 'c/in', position: 'Center' } } as Event,
    { Enter: { character: 'c', expression: 'c/in', position: '' } } as Event,
    bg('bg/1.png'),
    bg('/bg/2.png'),
    { BackgroundBoard: { path: 'bb.png', depth: 2 } },
    { Prop: { path: 'p.png', depth: 2 } },
    { EventImage: { path: 'e.png', back: 'Hide' } } as Event,
    { Image: { path: 'i.png' } } as Event,
    'PageBreak',
    'SceneTransition',
    { Wait: { ms: 5 } },
    { Choice: { options: [] } },
    { Condition: { flag: 'f', events: [bg('c.png')] } },
    { Jump: { target: 's' } },
  ]

  // 固定シードの LCG（再現性のため Math.random を使わない）
  function lcg(seed: number): () => number {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    }
  }

  it('ランダム列 × 全 fromIndex × base 有無で一致する', () => {
    const rnd = lcg(822)
    let nonEmpty = 0
    for (let trial = 0; trial < 200; trial++) {
      const len = Math.floor(rnd() * 12)
      const events = Array.from({ length: len }, () => pool[Math.floor(rnd() * pool.length)])
      for (let from = 0; from <= len + 1; from++) {
        for (const base of [BASE, '', 'https://cdn.example/g']) {
          const actual = collectUpcomingAssetUrls(events, from, base)
          expect(actual).toEqual(referenceCollect(events, from, base))
          if (actual.length > 0) nonEmpty++
        }
      }
    }
    expect(nonEmpty).toBeGreaterThan(100) // 空虚な一致(全部空)でないこと
  })
})

describe('collectUpcomingAssetUrls: 壁 (#703)', () => {
  const wallEvent = (path: string): Event => ({ Wall: { path, loop: true, mute: true } })

  it('画像の壁は images/ の URL を先読み対象に積む', () => {
    expect(collectUpcomingAssetUrls([wallEvent('glow.webp'), narr()], 0, BASE)).toEqual([
      `${BASE}/images/glow.webp`,
    ])
  })

  it('動画の壁は積まない（Assets を通らず <video> が読む）', () => {
    expect(
      collectUpcomingAssetUrls(
        [wallEvent('a.webm'), wallEvent('b.MP4'), wallEvent('c.mov'), narr()],
        0,
        BASE
      )
    ).toEqual([])
  })

  it('解除 WallExit は先読み対象でも打ち切りでもない。前後の背景は積む', () => {
    expect(
      collectUpcomingAssetUrls([bg('a.png'), 'WallExit' as Event, bg('b.png')], 0, BASE)
    ).toEqual([`${BASE}/images/a.png`, `${BASE}/images/b.png`])
  })

  it('同じ画像の壁と背景板は重複除去される', () => {
    expect(
      collectUpcomingAssetUrls(
        [wallEvent('x.png'), { BackgroundBoard: { path: 'x.png', depth: 1 } }],
        0,
        BASE
      )
    ).toEqual([`${BASE}/images/x.png`])
  })

  it('assetBaseUrl が空なら何も積まない', () => {
    expect(collectUpcomingAssetUrls([wallEvent('a.png')], 0, '')).toEqual([])
  })
})
