/**
 * directives/ の構造とハンドラ単体 (#829)。呼び出し列の旧実装との一致は directives.equivalence.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { audioDirectives } from './audioDirectives'
import { characterDirectives } from './characterDirectives'
import {
  directiveTable,
  dispatchDirective,
  signalDirectiveTable,
  type DirectiveContext,
} from './index'
import { stageDirectives, stageSignalDirectives } from './stageDirectives'
import { on, type ObjectDirectiveTable } from './types'

const E = (e: unknown): Event => e as Event

/** 触られたら記録する偽物。呼ばれたメソッド名を `${port}.${method}` で積む。 */
function fake() {
  const calls: string[] = []
  const port = (name: string) =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, p) => {
        if (typeof p === 'symbol' || p === 'then') return undefined
        if (p in t) return t[p]
        return () => {
          calls.push(`${name}.${String(p)}`)
        }
      },
    })
  const ctx = {
    stage: Object.assign(port('stage'), {
      background: port('bg'),
      effects: port('fx'),
      cameraMode: 'Novel',
    }),
    audio: port('audio'),
    characters: port('char'),
    layers: {
      video: port('video'),
      backgroundBoard: port('bboard'),
      wall: port('wall'),
      stageFront: port('stageFront'),
      prop: port('prop'),
      curtain: port('curtain'),
      lighting: port('lighting'),
      eventImage: port('eventImage'),
      telop: port('telop'),
      dialogBox: port('dialog'),
      choiceOverlay: port('choice'),
    },
    env: {
      skipMode: false,
      initialized: true,
      assetBaseUrl: '/a',
      fullscreenImage: false,
      eventImageFadeMs: 0,
      eventImageTransitionDefault: 'Fade',
      gameDefaultFontFamily: null,
      gameDefaultFontSize: null,
      runtimeDefaultFontFamily: 'x',
      runtimeDefaultFontSize: 40,
      telopAccentColorNum: 0,
      telopClearEpoch: 0,
    },
    hooks: {
      applyEventImageVisibility: () => calls.push('hooks.applyEventImageVisibility'),
      clearTelopLayer: () => calls.push('hooks.clearTelopLayer'),
      setCurtainZOrder: () => calls.push('hooks.setCurtainZOrder'),
      resolveNovelRoleXRatio: () => undefined,
      setCurrentBgmPath: () => calls.push('hooks.setCurrentBgmPath'),
    },
  } as unknown as DirectiveContext
  return { ctx, calls }
}

describe('ディスパッチ表の構造', () => {
  it('3 領域の表のキーは重複しない（結合すると合計と一致）', () => {
    const n =
      Object.keys(stageDirectives).length +
      Object.keys(characterDirectives).length +
      Object.keys(audioDirectives).length
    expect(directiveTable.size).toBe(n)
    expect(signalDirectiveTable.size).toBe(Object.keys(stageSignalDirectives).length)
  })

  it('領域ごとの所属: オーディオは Bgm/Se だけ、立ち絵系は CharacterLayer の担当だけ', () => {
    expect(Object.keys(audioDirectives).sort()).toEqual(['Bgm', 'Se'])
    expect(Object.keys(characterDirectives).sort()).toEqual(
      [
        'Animate',
        'Enter',
        'Exit',
        'ExpressionChange',
        'Image',
        'Label',
        'TextEffect',
        'TitleShow',
        'Underline',
      ].sort()
    )
  })

  it('フロー制御系・テキスト系は表に入っていない', () => {
    for (const k of [
      'Flag',
      'Choice',
      'Jump',
      'Wait',
      'WaitDisplayComplete',
      'Dialog',
      'Narration',
    ]) {
      expect(directiveTable.has(k), k).toBe(false)
      expect(signalDirectiveTable.has(k), k).toBe(false)
    }
  })

  it('文字列イベントはオブジェクト用の表を引かない（文字列 "Background" で例外にならない）', () => {
    const { ctx, calls } = fake()
    expect(dispatchDirective(E('Background'), ctx)).toBe(false)
    expect(dispatchDirective(E('Enter'), ctx)).toBe(false)
    expect(calls).toEqual([])
  })

  it('オブジェクトイベントは文字列用の表を引かない', () => {
    const { ctx, calls } = fake()
    expect(dispatchDirective(E({ SceneTransition: {} }), ctx)).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('DirectiveContext の最小性', () => {
  it('トップレベルのメンバーは 10 以内（現状 6）', () => {
    const { ctx } = fake()
    const top = Object.keys(ctx)
    expect(top.length).toBeLessThanOrEqual(10)
    expect(top.sort()).toEqual(['audio', 'characters', 'env', 'hooks', 'layers', 'stage'])
  })

  it('ハンドラが触る範囲: 領域ごとに触ってよいポートが限られる', () => {
    // オーディオ系は audio と hooks.setCurrentBgmPath しか触らない
    const a = fake()
    dispatchDirective(E({ Bgm: { path: 'x', action: 'Play' } }), a.ctx)
    dispatchDirective(E({ Se: { paths: ['s'] } }), a.ctx)
    expect(a.calls.every((c) => c.startsWith('audio.') || c.startsWith('hooks.'))).toBe(true)
    // 立ち絵系は characters / stage.effects(scrim 退避) / hooks 以外を触らない
    const c = fake()
    for (const e of [
      { ExpressionChange: { character: 'A', expression: 'e' } },
      { Exit: { character: 'A' } },
      { Enter: { character: 'A', expression: 'e', position: 'Left' } },
      { Animate: { target: 'A' } },
      { TitleShow: { text: 't' } },
      { Label: { text: 't' } },
      { Image: { path: 'p' } },
      { TextEffect: { target: 't', effect: 'Explode' } },
      { Underline: { target: 't' } },
    ])
      dispatchDirective(E(e), c.ctx)
    expect(c.calls.every((x) => x.startsWith('char.') || x === 'fx.retreatNovelScrim')).toBe(true)
  })
})

describe('ハンドラ単体', () => {
  it('Exit: ノベルでは方向を渡さず、シアターのときだけ渡す', () => {
    const run = (mode: 'Novel' | 'Theater') => {
      const { ctx } = fake()
      const remove = vi.fn()
      ;(ctx.characters as unknown as { remove: unknown }).remove = remove
      ;(ctx.stage as unknown as { cameraMode: string }).cameraMode = mode
      dispatchDirective(E({ Exit: { character: 'A', exit_direction: 'Left' } }), ctx)
      return remove.mock.calls[0][1].exitDirection
    }
    expect(run('Novel')).toBeUndefined()
    expect(run('Theater')).toBe('Left')
  })

  it('Enter: 不完全な指定は何も出さない', () => {
    const { ctx, calls } = fake()
    dispatchDirective(E({ Enter: { character: 'A', position: 'Left' } }), ctx)
    expect(calls).toEqual([])
  })

  it('Video: assetBaseUrl が空なら何もしない', () => {
    const { ctx, calls } = fake()
    ;(ctx.env as { assetBaseUrl: string }).assetBaseUrl = ''
    dispatchDirective(E({ Video: { path: 'v' } }), ctx)
    expect(calls).toEqual([])
  })

  it('EventImage: 全画面モードのときだけ文字窓と選択肢を隠す', () => {
    const a = fake()
    dispatchDirective(E({ EventImage: { path: 'p' } }), a.ctx)
    expect(a.calls).not.toContain('dialog.hide')
    const b = fake()
    ;(b.ctx.env as { fullscreenImage: boolean }).fullscreenImage = true
    dispatchDirective(E({ EventImage: { path: 'p' } }), b.ctx)
    expect(b.calls).toContain('dialog.hide')
    expect(b.calls).toContain('choice.hide')
  })

  it('Telop: スキップ中はフォントも待たず何もしない', () => {
    const { ctx, calls } = fake()
    ;(ctx.env as { skipMode: boolean }).skipMode = true
    expect(dispatchDirective(E({ Telop: { text: 't' } }), ctx)).toBe(true)
    expect(calls).toEqual([])
  })

  it('Se: 1件でも複数でも playSeSequence を1回呼ぶ', () => {
    const { ctx } = fake()
    const play = vi.fn()
    ;(ctx.audio as unknown as { playSeSequence: unknown }).playSeSequence = play
    dispatchDirective(E({ Se: { paths: ['a.wav'] } }), ctx)
    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.calls[0][0]).toEqual(['/a/sounds/a.wav'])
    expect(play.mock.calls[0].slice(1)).toEqual([50, 200, undefined])
  })

  it('Bgm: path 無しの Play は停止として扱う', () => {
    const { ctx, calls } = fake()
    dispatchDirective(E({ Bgm: { path: null, action: 'Play' } }), ctx)
    expect(calls).toEqual(['audio.stopBgm', 'hooks.setCurrentBgmPath'])
  })

  it('SceneTransition: クリア順は 背景→動画→背景板→壁→舞台前面→大道具→幕→照明→動画→イベント絵→…→暗転解除→scrim', () => {
    const { ctx, calls } = fake()
    dispatchDirective(E('SceneTransition'), ctx)
    expect(calls).toEqual([
      'bg.clearBackground',
      'video.remove',
      'bboard.clear',
      'wall.clear',
      'stageFront.clear',
      'prop.clear',
      'curtain.clear',
      'hooks.setCurtainZOrder',
      'lighting.clear',
      'video.remove',
      'eventImage.remove',
      'hooks.applyEventImageVisibility',
      'hooks.clearTelopLayer',
      'fx.setBlackout',
      'fx.retreatNovelScrim',
    ])
  })
})

describe('表のキーとハンドラの型の対応 (#829)', () => {
  it('キーと on<K> の K が食い違うと型エラーになる（型検査: npm run type-check）', () => {
    const ok: ObjectDirectiveTable = { Shake: on<'Shake'>(() => {}) }
    const bad: ObjectDirectiveTable = {
      // @ts-expect-error Shake のキーに Fade 用ハンドラは入れられない
      Shake: on<'Fade'>(() => {}),
    }
    const unknownKey: ObjectDirectiveTable = {
      // @ts-expect-error 存在しないイベント種はキーにできない
      NoSuchEvent: on<'Shake'>(() => {}),
    }
    expect([ok, bad, unknownKey]).toHaveLength(3)
  })
})
