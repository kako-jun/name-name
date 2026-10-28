/**
 * 旧 processDirective との等価性 (#829, #735 8/8)。
 *
 * `oldProcessDirective`（oldProcessDirective.oracle.ts）は #829 着手時の origin/main d4d21fd9 の
 * `NovelRenderer.processDirective` を呼び出し順のまま写した参照実装。新しい `dispatchDirective` は一切呼ばない。
 * 同じイベントを、同じ初期値の「記録用の偽物」の世界に旧/新で流し、Stage・CharacterLayer・AudioManager・
 * 各演出レイヤー・レンダラ側フックへの呼び出し列（メソッド名＋引数）が完全に一致することを確かめる。
 * 環境（skip / シアター / assetBaseUrl 無し / 全画面イベント絵 など）を総当たりで変える。
 *
 * 範囲の限界: 偽物はレイヤーの内部を持たない。実レイヤーとの結線は NovelRenderer.directives.test.ts、
 * 実描画の一致は実ブラウザの画素比較が担う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import {
  dispatchDirective,
  directiveTable,
  signalDirectiveTable,
  type DirectiveContext,
} from './index'
import {
  OLD_OBJECT_KEYS,
  OLD_STRING_KEYS,
  oldProcessDirective,
  type OldWorld,
} from './oldProcessDirective.oracle'

vi.mock('../FontLoader', () => ({
  ensureFontLoaded: vi.fn(() => Promise.resolve()),
}))
// 乱択は決定的にする（旧/新とも同じ関数を呼ぶ）。
vi.mock('../seSelection', () => ({
  selectAndShuffleSeFiles: (paths: string[], count?: number | null) =>
    [...paths].reverse().slice(0, count ?? paths.length),
}))

import { ensureFontLoaded } from '../FontLoader'

/* ------------------------------------------------------------------------------------------ */
/* 記録用の偽物                                                                                */
/* ------------------------------------------------------------------------------------------ */

function serialize(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    typeof x === 'function' ? '[fn]' : x === undefined ? '__undefined__' : x
  )
}

interface Recorder {
  log: string[]
  /** 呼び出しの引数に渡された関数（コールバック）。後で呼んでその先の呼び出しも比べる。 */
  callbacks: Array<() => void>
}

function recorder(rec: Recorder, name: string, returns: Record<string, unknown> = {}): never {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined
        return (...args: unknown[]) => {
          rec.log.push(`${name}.${prop}(${serialize(args)})`)
          for (const a of args) {
            if (typeof a === 'function') rec.callbacks.push(a as () => void)
            else if (a && typeof a === 'object') {
              for (const v of Object.values(a)) {
                if (typeof v === 'function') rec.callbacks.push(v as () => void)
              }
            }
          }
          return returns[prop]
        }
      },
    }
  ) as never
}

interface EnvOptions {
  skipMode: boolean
  cameraMode: 'Novel' | 'Theater'
  assetBaseUrl: string
  fullscreenImage: boolean
  initialized: boolean
}

function makeWorld(o: EnvOptions) {
  const rec: Recorder = { log: [], callbacks: [] }
  const stage = {
    background: recorder(rec, 'bg'),
    effects: recorder(rec, 'fx'),
    cameraMode: o.cameraMode,
    setCamera: (...a: unknown[]) => rec.log.push(`stage.setCamera(${serialize(a)})`),
    setPaperDollOutline: (...a: unknown[]) =>
      rec.log.push(`stage.setPaperDollOutline(${serialize(a)})`),
  }
  const hooksRec = recorder(rec, 'self') as Record<string, (...a: unknown[]) => unknown>
  const hooks = {
    applyEventImageVisibility: () => hooksRec.applyEventImageVisibility(),
    clearTelopLayer: () => hooksRec.clearTelopLayer(),
    setCurtainZOrder: (f: boolean) => hooksRec.setCurtainZOrder(f),
    // 役割配置: 'A' は左(0.25)、'B' は右(0.75)、それ以外は未指定。
    resolveNovelRoleXRatio: (c: string | null) => {
      hooksRec.resolveNovelRoleXRatio(c)
      return c === 'A' ? 0.25 : c === 'B' ? 0.75 : undefined
    },
    setCurrentBgmPath: (p: string | null) => hooksRec.setCurrentBgmPath(p),
  }
  const env = {
    skipMode: o.skipMode,
    initialized: o.initialized,
    assetBaseUrl: o.assetBaseUrl,
    fullscreenImage: o.fullscreenImage,
    eventImageFadeMs: 450,
    eventImageTransitionDefault: 'Fade' as const,
    gameDefaultFontFamily: null as string | null,
    gameDefaultFontSize: null as number | null,
    runtimeDefaultFontFamily: "'Noto Sans JP', sans-serif",
    runtimeDefaultFontSize: 40,
    telopAccentColorNum: 0x123456,
    telopClearEpoch: 7,
  }
  const layers = {
    video: recorder(rec, 'video'),
    backgroundBoard: recorder(rec, 'bboard'),
    wall: recorder(rec, 'wall'),
    stageFront: recorder(rec, 'stageFront'),
    weather: recorder(rec, 'weather'),
    floor: recorder(rec, 'floor'),
    prop: recorder(rec, 'prop'),
    curtain: recorder(rec, 'curtain'),
    lighting: recorder(rec, 'lighting'),
    eventImage: recorder(rec, 'eventImage'),
    telop: recorder(rec, 'telop'),
    dialogBox: recorder(rec, 'dialog'),
    choiceOverlay: recorder(rec, 'choice'),
  }
  const audio = recorder(rec, 'audio')
  const characters = recorder(rec, 'char')

  const oldWorld = {
    background: stage.background,
    screenEffects: stage.effects,
    stage,
    videoLayer: layers.video,
    backgroundBoardLayer: layers.backgroundBoard,
    wallLayer: layers.wall,
    stageFrontLayer: layers.stageFront,
    weatherLayer: layers.weather,
    floorLayer: layers.floor,
    propLayer: layers.prop,
    curtainLayer: layers.curtain,
    lightingLayer: layers.lighting,
    eventImageLayer: layers.eventImage,
    telopLayer: layers.telop,
    characterLayer: characters,
    dialogBox: layers.dialogBox,
    choiceOverlay: layers.choiceOverlay,
    audioManager: audio,
    hooks,
    env,
  } as unknown as OldWorld
  const ctx = { stage, audio, characters, layers, env, hooks } as unknown as DirectiveContext
  return { rec, env, oldWorld, ctx }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/** 呼び出しを記録しきったあと、渡されたコールバックを順に呼び、その先の呼び出しも記録する。 */
function fireCallbacks(rec: Recorder): void {
  for (const cb of [...rec.callbacks]) cb()
}

/* ------------------------------------------------------------------------------------------ */
/* ケース: 全イベント種 × 省略/指定の違い                                                      */
/* ------------------------------------------------------------------------------------------ */

const E = (e: unknown): Event => e as Event

const CASES: Array<[string, Event]> = [
  ['SceneTransition', 'SceneTransition'],
  ['VideoExit', 'VideoExit'],
  ['WallExit', 'WallExit'],
  ['StageFrontExit', 'StageFrontExit'],
  ['WeatherExit', 'WeatherExit'],
  ['FloorExit', 'FloorExit'],
  ['SpotlightOff', 'SpotlightOff'],
  ['CurtainUp', 'CurtainUp'],
  [
    'Background(全指定)',
    E({
      Background: {
        path: 'bg/a.png',
        fade_top: 10,
        fade_bottom: 20,
        fade_left: 30,
        fade_right: 40,
        brightness: 0.5,
      },
    }),
  ],
  ['Background(省略)', E({ Background: { path: 'bg/b.png' } })],
  ['BackgroundBoard(depth)', E({ BackgroundBoard: { path: 'b/1.png', depth: 3 } })],
  ['BackgroundBoard(depth省略)', E({ BackgroundBoard: { path: 'b/2.png' } })],
  ['StageFront', E({ StageFront: { path: 'apron/hall.png' } })],
  ['Weather(強さ指定)', E({ Weather: { kind: 'Snow', intensity: 1.5 } })],
  ['Weather(強さ省略)', E({ Weather: { kind: 'Rain' } })],
  ['Floor(高さ指定)', E({ Floor: { path: 'floor/wood.png', height: 0.4 } })],
  ['Floor(高さ省略)', E({ Floor: { path: 'floor/wood.png' } })],
  ['Wall(既定)', E({ Wall: { path: 'w/1.webp', loop: true, mute: true } })],
  ['Wall(ループ/ミュートなし)', E({ Wall: { path: 'w/2.webm', loop: false, mute: false } })],
  ['Prop(depth)', E({ Prop: { path: 'p/1.png', depth: 2 } })],
  ['Prop(depth省略)', E({ Prop: { path: 'p/2.png' } })],
  ['BackgroundColor', E({ BackgroundColor: { color: '#112233' } })],
  [
    'Video(全指定)',
    E({
      Video: {
        path: 'v.mp4',
        position: 'center',
        scale: 1.5,
        loop: true,
        mute: false,
        fade_top: 1,
        fade_bottom: 2,
        fade_left: 3,
        fade_right: 4,
      },
    }),
  ],
  ['Video(省略)', E({ Video: { path: 'v2.mp4' } })],
  [
    'EventImage(全指定)',
    E({
      EventImage: {
        path: 'ei.png',
        back: 'Hide',
        fade_ms: 300,
        transition: 'Pixelate',
        effects: { rain: true },
      },
    }),
  ],
  ['EventImage(省略)', E({ EventImage: { path: 'ei2.png' } })],
  ['EventImageExit(fade指定)', E({ EventImageExit: { fade_ms: 120 } })],
  ['EventImageExit(省略)', E({ EventImageExit: {} })],
  ['Telop(全指定)', E({ Telop: { text: '字幕', position: 'TopLeft', seconds: 9, kind: 'note' } })],
  ['Telop(省略)', E({ Telop: { text: '字幕2' } })],
  ['Blackout On', E({ Blackout: { action: 'On' } })],
  ['Blackout Off', E({ Blackout: { action: 'Off' } })],
  [
    'CameraMode(全指定)',
    E({ CameraMode: { mode: 'Theater', orientation: 'Stage', elevation: 'LookUp' } }),
  ],
  ['CameraMode(省略)', E({ CameraMode: { mode: 'Novel' } })],
  [
    'PaperDollOutline(全指定)',
    E({ PaperDollOutline: { enabled: true, color: '#fff', thickness: 5 } }),
  ],
  ['PaperDollOutline(既定値)', E({ PaperDollOutline: { enabled: true } })],
  ['PaperDollOutline(解除)', E({ PaperDollOutline: { enabled: false, color: '#fff' } })],
  ['Curtain(手前)', E({ Curtain: { path: 'c.png', characters_in_front: true } })],
  ['Curtain(奥)', E({ Curtain: { path: 'c.png', characters_in_front: false } })],
  ['Bgm Play(fadeあり)', E({ Bgm: { path: 'a.mp3', action: 'Play', fade_ms: 800 } })],
  ['Bgm Play(fade省略)', E({ Bgm: { path: 'a.mp3', action: 'Play' } })],
  ['Bgm Play(path無し→停止扱い)', E({ Bgm: { path: null, action: 'Play' } })],
  ['Bgm Stop(fadeあり)', E({ Bgm: { path: null, action: 'Stop', fade_ms: 500 } })],
  ['Bgm Stop(fade省略)', E({ Bgm: { path: null, action: 'Stop' } })],
  ['Bgm Stop(fade=0)', E({ Bgm: { path: null, action: 'Stop', fade_ms: 0 } })],
  ['Se(単発)', E({ Se: { paths: ['s1.wav'] } })],
  [
    'Se(複数・全指定)',
    E({
      Se: {
        paths: ['s1.wav', 's2.wav', 's3.wav'],
        count: 2,
        gap_min_ms: 10,
        gap_max_ms: 30,
        fade_ms: 40,
      },
    }),
  ],
  ['Se(複数・省略)', E({ Se: { paths: ['s1.wav', 's2.wav'] } })],
  ['ExpressionChange', E({ ExpressionChange: { character: 'A', expression: 'smile' } })],
  ['Exit(全指定)', E({ Exit: { character: 'A', fade_ms: 90, exit_direction: 'Left' } })],
  ['Exit(省略)', E({ Exit: { character: 'A' } })],
  [
    'Enter(全指定)',
    E({
      Enter: {
        character: 'A',
        expression: 'smile',
        position: 'Left',
        fit: true,
        enter_direction: 'Right',
        depth: 4,
      },
    }),
  ],
  [
    'Enter(役割B・fit偽)',
    E({ Enter: { character: 'B', expression: 'sad', position: 'Right', fit: false } }),
  ],
  ['Enter(省略)', E({ Enter: { character: 'C', expression: 'e', position: 'Center' } })],
  ['Enter(表情欠落)', E({ Enter: { character: 'A', position: 'Left' } })],
  ['Enter(位置欠落)', E({ Enter: { character: 'A', expression: 'e' } })],
  ['Enter(キャラ空)', E({ Enter: { character: '', expression: 'e', position: 'Left' } })],
  [
    'Animate',
    E({
      Animate: {
        target: 'A',
        dx: 1,
        dy: 2,
        rotation: 3,
        scale: 1.2,
        duration_ms: 400,
        easing: 'EaseIn',
      },
    }),
  ],
  ['DialogBorderless true', E({ DialogBorderless: { borderless: true } })],
  ['DialogBorderless false', E({ DialogBorderless: { borderless: false } })],
  [
    'TitleShow(全指定)',
    E({
      TitleShow: {
        text: 'T',
        font_family: 'Serif',
        position: 'Center',
        color: '#ff0000',
        size: 80,
        x: 0.1,
        y: 0.2,
      },
    }),
  ],
  ['TitleShow(省略)', E({ TitleShow: { text: 'T2' } })],
  [
    'Label(全指定)',
    E({
      Label: {
        id: 'l1',
        text: 'L',
        color: '#00ff00',
        position: 'Top',
        size: 30,
        font_family: 'Mono',
        align: 'Left',
        after: 'l0',
        x: 5,
        y: 6,
      },
    }),
  ],
  ['Label(省略)', E({ Label: { text: 'L2' } })],
  [
    'Image(全指定)',
    E({
      Image: {
        id: 'i1',
        path: 'a.png',
        position: 'Left',
        shape: 'Circle',
        size: 100,
        x: 1,
        y: 2,
        transition: 'Pixelate',
        fade_ms: 250,
      },
    }),
  ],
  ['Image(省略)', E({ Image: { path: 'a.png' } })],
  [
    'TextEffect(全指定)',
    E({
      TextEffect: {
        target: 't',
        effect: 'Typewriter',
        stagger_ms: 1,
        ms_per_char: 2,
        dx: 3,
        dy: 4,
        rotation: 5,
        scale: 6,
        alpha: 0.5,
        duration_ms: 7,
        easing: 'Linear',
        cursor: true,
        blink_ms: 8,
        cursor_color: '#fff',
      },
    }),
  ],
  ['TextEffect(省略)', E({ TextEffect: { target: 't', effect: 'Explode' } })],
  [
    'Underline(全指定)',
    E({
      Underline: {
        target: 't',
        color: '#f00',
        thickness: 2,
        duration_ms: 300,
        offset: 4,
        easing: 'EaseOut',
      },
    }),
  ],
  ['Underline(省略)', E({ Underline: { target: 't' } })],
  ['Shake', E({ Shake: { intensity_px: 8, duration_ms: 400 } })],
  [
    'Flash(全指定)',
    E({
      Flash: {
        color: '#fff',
        alpha: 0.8,
        duration_ms: 200,
        area: { x: 0, y: 0, w: 1, h: 1 },
        strobe: true,
        interval_ms: 50,
      },
    }),
  ],
  ['Flash(省略)', E({ Flash: { color: '#fff', alpha: 1, duration_ms: 100 } })],
  [
    'Fade',
    E({
      Fade: { target: 'Screen', color: '#000', from_alpha: 0, to_alpha: 1, duration_ms: 600 },
    }),
  ],
  ['Spotlight(target)', E({ Spotlight: { target: 'A', color: '#ffeecc', radius: 120 } })],
  ['Spotlight(target省略)', E({ Spotlight: { color: '#ffeecc', radius: 120 } })],
]

/** 旧実装が処理しない（レンダラ側のフロー制御、またはテキスト、未知）イベント。新ディスパッチは何もしない。 */
const PASS_THROUGH: Array<[string, Event]> = [
  ['Flag', E({ Flag: { name: 'f', value: true } })],
  ['Choice', E({ Choice: { options: [] } })],
  ['Jump', E({ Jump: { target: 's' } })],
  ['Wait', E({ Wait: { ms: 100 } })],
  ['WaitDisplayComplete', 'WaitDisplayComplete'],
  ['Dialog', E({ Dialog: { character: 'A', text: ['x'] } })],
  ['Narration', E({ Narration: { text: ['x'] } })],
  ['PageBreak', 'PageBreak'],
  ['Condition', E({ Condition: { flag: 'f', events: [] } })],
  ['RpgMap', E({ RpgMap: {} })],
  ['未知の文字列', E('NoSuchEvent')],
  ['未知のオブジェクト', E({ NoSuchEvent: { a: 1 } })],
  ['空オブジェクト', E({})],
  ['null', E(null)],
]

const ENVS: EnvOptions[] = []
for (const skipMode of [false, true])
  for (const cameraMode of ['Novel', 'Theater'] as const)
    for (const assetBaseUrl of ['', '/assets'])
      for (const fullscreenImage of [false, true])
        ENVS.push({ skipMode, cameraMode, assetBaseUrl, fullscreenImage, initialized: true })

beforeEach(() => {
  vi.mocked(ensureFontLoaded).mockImplementation(() => Promise.resolve())
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('dispatchDirective は旧 processDirective と呼び出し列が一致する (#829)', () => {
  it('ケース数と環境数が十分（全種 × 全環境）', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60)
    expect(ENVS.length).toBe(16)
  })

  it.each(CASES)('%s', async (_name, event) => {
    for (const envOpts of ENVS) {
      const oldW = makeWorld(envOpts)
      const newW = makeWorld(envOpts)
      const oldHandled = oldProcessDirective(event, oldW.oldWorld)
      const newHandled = dispatchDirective(event, newW.ctx)
      await flush()
      fireCallbacks(oldW.rec)
      fireCallbacks(newW.rec)
      expect(newHandled, `handled ${serialize(envOpts)}`).toBe(oldHandled)
      expect(oldHandled).toBe(true)
      expect(newW.rec.log, `calls ${serialize(envOpts)}`).toEqual(oldW.rec.log)
    }
  })

  it('旧実装が呼び出しを記録している（オラクルが空振りしていない）', async () => {
    // Telop は skip 中・Video は assetBaseUrl 無し・Enter は不完全指定で何も呼ばないのが正。それ以外は必ず呼ぶ。
    const silentOk = new Set(['Enter(表情欠落)', 'Enter(位置欠落)', 'Enter(キャラ空)'])
    for (const [name, event] of CASES) {
      if (silentOk.has(name)) continue
      const w = makeWorld({
        skipMode: false,
        cameraMode: 'Novel',
        assetBaseUrl: '/assets',
        fullscreenImage: false,
        initialized: true,
      })
      oldProcessDirective(event, w.oldWorld)
      await flush()
      expect(w.rec.log.length, name).toBeGreaterThan(0)
    }
  })

  it.each(PASS_THROUGH)(
    '旧が処理しない %s は新も何もしない（false・呼び出しなし）',
    async (_n, event) => {
      for (const envOpts of ENVS) {
        const oldW = makeWorld(envOpts)
        const newW = makeWorld(envOpts)
        // 旧実装は null で例外を出さないため try で包まず直接呼ぶ（null は 'in' が TypeError になるので除外）
        const oldHandled = event === null ? false : oldProcessDirective(event, oldW.oldWorld)
        const newHandled = dispatchDirective(event, newW.ctx)
        await flush()
        expect(oldHandled).toBe(false)
        expect(newHandled).toBe(false)
        expect(newW.rec.log).toEqual([])
        expect(oldW.rec.log).toEqual([])
      }
    }
  )

  it('旧実装が処理するイベント種の集合と、新しい表のキー集合が一致する', () => {
    expect([...signalDirectiveTable.keys()].sort()).toEqual([...OLD_STRING_KEYS].sort())
    expect([...directiveTable.keys()].sort()).toEqual([...OLD_OBJECT_KEYS].sort())
  })

  it('CASES は旧実装が処理する全イベント種を網羅する', () => {
    const covered = new Set<string>()
    for (const [, e] of CASES) covered.add(typeof e === 'string' ? e : Object.keys(e)[0])
    for (const k of [...OLD_STRING_KEYS, ...OLD_OBJECT_KEYS]) {
      expect(covered.has(k), `ケース無し: ${k}`).toBe(true)
    }
  })
})

describe('Telop の非同期（フォント待ち）の割り込み (#679)', () => {
  const telop = E({ Telop: { text: 't' } })
  const base: EnvOptions = {
    skipMode: false,
    cameraMode: 'Novel',
    assetBaseUrl: '/assets',
    fullscreenImage: false,
    initialized: true,
  }

  async function run(mutate: (env: ReturnType<typeof makeWorld>['env']) => void) {
    const oldW = makeWorld(base)
    const newW = makeWorld(base)
    let resolveOld!: () => void
    let resolveNew!: () => void
    vi.mocked(ensureFontLoaded)
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveOld = r)))
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveNew = r)))
    oldProcessDirective(telop, oldW.oldWorld)
    dispatchDirective(telop, newW.ctx)
    mutate(oldW.env)
    mutate(newW.env)
    resolveOld()
    resolveNew()
    await flush()
    return { oldLog: oldW.rec.log, newLog: newW.rec.log }
  }

  it('待機中に何も起きなければ show される', async () => {
    const { oldLog, newLog } = await run(() => {})
    expect(oldLog.length).toBe(1)
    expect(newLog).toEqual(oldLog)
  })
  it('待機中に clearTelopLayer（世代が進む）されたら出さない', async () => {
    const { oldLog, newLog } = await run((env) => {
      env.telopClearEpoch++
    })
    expect(oldLog).toEqual([])
    expect(newLog).toEqual([])
  })
  it('待機中にスキップが始まったら出さない', async () => {
    const { oldLog, newLog } = await run((env) => {
      env.skipMode = true
    })
    expect(oldLog).toEqual([])
    expect(newLog).toEqual([])
  })
  it('待機中に破棄（initialized=false）されたら出さない', async () => {
    const { oldLog, newLog } = await run((env) => {
      env.initialized = false
    })
    expect(oldLog).toEqual([])
    expect(newLog).toEqual([])
  })
  it('フォントのロードに失敗しても警告して show する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const oldW = makeWorld(base)
    const newW = makeWorld(base)
    vi.mocked(ensureFontLoaded).mockImplementation(() => Promise.reject(new Error('x')))
    oldProcessDirective(telop, oldW.oldWorld)
    dispatchDirective(telop, newW.ctx)
    await flush()
    expect(oldW.rec.log.length).toBe(1)
    expect(newW.rec.log).toEqual(oldW.rec.log)
    expect(warn).toHaveBeenCalledTimes(2)
  })
  it('既定フォント・サイズ・強調色の解決が旧と一致する', async () => {
    const oldW = makeWorld(base)
    const newW = makeWorld(base)
    for (const w of [oldW, newW]) {
      w.env.gameDefaultFontFamily = 'Game Font'
      w.env.gameDefaultFontSize = 22
    }
    oldProcessDirective(telop, oldW.oldWorld)
    dispatchDirective(telop, newW.ctx)
    await flush()
    expect(newW.rec.log).toEqual(oldW.rec.log)
    expect(newW.rec.log[0]).toContain('Game Font')
    expect(newW.rec.log[0]).toContain('"fontSize":22')
  })
})
