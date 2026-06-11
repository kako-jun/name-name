import { describe, it, expect } from 'vitest'
import {
  computeCoverFit,
  parseHexColor,
  resolveAssetUrl,
  saveSlotToGameState,
  resolveFontFamily,
  formatCounterText,
  computeSeekBarPosition,
  describeEventForDebug,
  findSceneById,
  resolveSceneTitle,
} from './novelLayout'
import type { SaveSlotData } from './SaveManager'
import type { BackgroundFade } from './GameState'
import type { EventScene } from '../types'

describe('computeCoverFit', () => {
  // 注意: これは「抽出後の computeCoverFit と同一の直接計算式」であって、
  // 抽出前の PIXI set/read-back 経路の再現ではない（両者は同じ式なので一致して当然）。
  // applyCoverFit が実際に通る set→read-back round-trip の等価性は、後段の
  // 「round-trip 等価性」テストで pixiReadBack オラクルを使って別途縛る。
  function directCoverFit(texW: number, texH: number, screenW: number, screenH: number) {
    const scaleX = screenW / texW
    const scaleY = screenH / texH
    const scale = Math.max(scaleX, scaleY)
    const width = texW * scale
    const height = texH * scale
    return {
      width,
      height,
      x: (screenW - width) / 2,
      y: (screenH - height) / 2,
    }
  }

  // PIXI v8 Sprite の set→read-back 経路を数値で再現するオラクル。
  // applyCoverFit は computeCoverFit の戻り値を Object.assign(sprite, {...}) で
  // sprite.{width,height,x,y} に流し込む。width/height は「実 px」ではなく scale を
  // 介して保持・読み戻されるため、抽出前から実際に画面へ出ていた寸法はこの round-trip 後の値。
  //
  //   set width(v):  scale.x = (origW !== 0) ? v/origW * sign : sign   // sign = Math.sign(scale.x) || 1
  //   get width():   Math.abs(scale.x) * origW
  //
  // 生成直後の Sprite は scale.x = scale.y = 1 なので sign = 1。x/y は position の素通し setter
  // （read-back 変換なし）。よって画面に出る寸法は下記のとおり。
  // 参照: node_modules/pixi.js/lib/scene/container/container-mixins/measureMixin.mjs (_setWidth/_setHeight)
  //        node_modules/pixi.js/lib/scene/sprite/Sprite.mjs (get/set width, get/set height)
  function pixiReadBack(origW: number, origH: number, screenW: number, screenH: number) {
    const fit = computeCoverFit(origW, origH, screenW, screenH)
    // width setter → scale.x（sign=1 で初期化された Sprite を前提）
    const scaleX = origW !== 0 ? fit.width / origW : 1
    const scaleY = origH !== 0 ? fit.height / origH : 1
    // getter で読み戻した実表示寸法
    return {
      width: Math.abs(scaleX) * origW,
      height: Math.abs(scaleY) * origH,
      x: fit.x, // position はそのまま
      y: fit.y,
    }
  }

  it('リファレンス等価性: 抽出後 computeCoverFit と直接計算式が数値完全一致', () => {
    const cases: Array<[number, number, number, number]> = [
      [1920, 1080, 1920, 1080], // 完全一致（scale=1, x=y=0）
      [1000, 1000, 1920, 1080], // 縦長画面 → 幅基準でカバー
      [1920, 1080, 1000, 1000], // 横長画像 → 高さ基準でカバー
      [800, 600, 1920, 1080], // 拡大
      [4000, 3000, 1920, 1080], // 縮小
      [1280, 720, 1920, 1080], // 同アスペクト拡大（scale=1.5, x=y=0）
      [333, 777, 1920, 1080], // 半端な比
    ]
    for (const [tw, th, sw, sh] of cases) {
      expect(computeCoverFit(tw, th, sw, sh)).toEqual(directCoverFit(tw, th, sw, sh))
    }
  })

  it('round-trip 等価性: PIXI set→read-back 経路後も寸法が保たれる', () => {
    // PR #265 が同値性を疑った当の経路（sprite.width=v で scale.x=v/origW を設定し、
    // get width=abs(scale.x)*origW で読み戻す）を pixiReadBack で再現し、
    // computeCoverFit が「設定→読み戻し」を生き残ることを複数入力で機械的に確認する。
    // 小/大/極端アスペクト比 + 実画面解像度数種を網羅。
    const cases: Array<[number, number, number, number]> = [
      [1920, 1080, 1920, 1080], // 等倍
      [1, 1, 1920, 1080], // 極小テクスチャ → 巨大拡大
      [8000, 6000, 1366, 768], // 巨大テクスチャ → 縮小（ノートPC解像度）
      [3840, 2160, 2560, 1440], // 4K → WQHD
      [100, 4000, 1920, 1080], // 極端な縦長アスペクト
      [4000, 100, 1280, 720], // 極端な横長アスペクト
      [1242, 2688, 375, 812], // モバイル縦（iPhone 系）
      [375, 812, 1920, 1080], // モバイル画像を横画面へ
      [333, 777, 800, 600], // 半端な比 + SVGA
    ]
    for (const [tw, th, sw, sh] of cases) {
      const fit = computeCoverFit(tw, th, sw, sh)
      const readBack = pixiReadBack(tw, th, sw, sh)
      // computeCoverFit の生出力と、PIXI 経路を通した後の表示寸法が一致する
      // （cover-fit の width/height は常に非負なので abs を通しても値は変わらない）。
      expect(fit.width).toBeCloseTo(readBack.width, 6)
      expect(fit.height).toBeCloseTo(readBack.height, 6)
      expect(fit.x).toBeCloseTo(readBack.x, 6)
      expect(fit.y).toBeCloseTo(readBack.y, 6)
      // round-trip 後も「画面を必ず覆う」cover 不変条件が崩れない
      expect(readBack.width).toBeGreaterThanOrEqual(sw - 1e-6)
      expect(readBack.height).toBeGreaterThanOrEqual(sh - 1e-6)
    }
  })

  it('退化入力: 抽出前後で同じ式 → 同じ結果（texW=0 / NaN / 負値）', () => {
    // 本体ロジックは不変なので「直接計算式と同じ結果を返す」ことだけを縛る。
    // raycastProjection 系テストが NaN/Infinity を網羅する流儀に揃える。
    const degenerate: Array<[number, number, number, number]> = [
      [0, 1080, 1920, 1080], // texW=0 → scaleX=Infinity → scale=Infinity → width=NaN(0*Inf)
      [1920, 0, 1920, 1080], // texH=0 → scaleY=Infinity
      [0, 0, 1920, 1080], // 両方 0
      [1920, 1080, 0, 0], // 画面 0 → scale=0 → width=0
      [NaN, 1080, 1920, 1080], // texW NaN
      [1920, NaN, 1920, 1080], // texH NaN
      [1920, 1080, NaN, 1080], // screenW NaN
      [-1920, 1080, 1920, 1080], // 負のテクスチャ幅
      [1920, 1080, -1920, -1080], // 負の画面
      [Infinity, 1080, 1920, 1080], // texW Infinity → scaleX=0
      [1920, 1080, Infinity, 1080], // screenW Infinity → scale=Infinity
    ]
    for (const [tw, th, sw, sh] of degenerate) {
      // toEqual は NaN 同士を一致と見なす（Object.is ベース）ので退化系でも縛れる
      expect(computeCoverFit(tw, th, sw, sh)).toEqual(directCoverFit(tw, th, sw, sh))
    }
  })

  it('カバー（contain ではない）: 画面を必ず覆い、長辺がはみ出す', () => {
    // 1000x1000 の正方形画像を 1920x1080 にカバー → 幅 1920 を満たす scale=1.92
    const fit = computeCoverFit(1000, 1000, 1920, 1080)
    expect(fit.width).toBe(1920)
    expect(fit.height).toBe(1920) // 高さは画面(1080)を超えてはみ出す
    expect(fit.x).toBe(0)
    expect(fit.y).toBe((1080 - 1920) / 2) // 上下に等分してはみ出し中央寄せ（負値）
  })

  it('同サイズなら scale=1・原点 (0,0)', () => {
    expect(computeCoverFit(1920, 1080, 1920, 1080)).toEqual({
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
    })
  })

  it('中央寄せ: はみ出し分を左右/上下で等分する', () => {
    // 横長画像 4000x1080 を 1920x1080 にカバー → 高さ基準 scale=1, 幅 4000 がはみ出す
    const fit = computeCoverFit(4000, 1080, 1920, 1080)
    expect(fit.height).toBe(1080)
    expect(fit.width).toBe(4000)
    expect(fit.x).toBe((1920 - 4000) / 2) // 左右均等（負値）
    expect(fit.y).toBe(0)
  })
})

describe('parseHexColor', () => {
  // 抽出前 NovelRenderer.parseHexColor の inline 実装（リファレンス）。
  function inlineParseHexColor(hex: string): number {
    const clean = hex.replace('#', '')
    const n = parseInt(clean, 16)
    return isNaN(n) ? 0xffffff : n
  }

  it('リファレンス等価性: 抽出前 inline 実装と一致', () => {
    const cases = [
      '#ffffff',
      '#000000',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      'ffffff', // # なし
      '#abc', // 短縮
      '#FFFFFF', // 大文字
      'zzzzzz', // 不正 → 白フォールバック
      '#', // 空 → NaN → 白
      '', // 空文字 → NaN → 白
      '#12g', // 途中まで（parseInt の寛容な解釈）
    ]
    for (const c of cases) {
      expect(parseHexColor(c)).toBe(inlineParseHexColor(c))
    }
  })

  it('代表値', () => {
    expect(parseHexColor('#ffffff')).toBe(0xffffff)
    expect(parseHexColor('#000000')).toBe(0x000000)
    expect(parseHexColor('#ff0000')).toBe(0xff0000)
    expect(parseHexColor('ff0000')).toBe(0xff0000) // # 省略
  })

  it('不正値は白 (0xffffff) にフォールバック', () => {
    expect(parseHexColor('zzz')).toBe(0xffffff)
    expect(parseHexColor('#')).toBe(0xffffff)
    expect(parseHexColor('')).toBe(0xffffff)
  })

  it("先頭 '#' は 1 つだけ除去（replace の元挙動）", () => {
    // '##ff' → '#ff' → parseInt('#ff',16)=NaN → 白
    expect(parseHexColor('##ff')).toBe(0xffffff)
  })

  it("中間の '#' は最初の 1 つだけ除去（replace('#','') のセマンティクス固定）", () => {
    // replace(文字列, '') は最初の出現だけを置換する。中間 # でもこの挙動を縛る。
    // '1#2' → 先頭でなく中間の最初の # を 1 つ消して '12' → parseInt('12',16)=0x12=18
    expect(parseHexColor('1#2')).toBe(0x12)
    expect(parseHexColor('1#2')).toBe(inlineParseHexColor('1#2'))
    // '#1#2' → 最初の # だけ消えて '1#2' → parseInt('1#2',16) は '1' まで読んで 0x1
    expect(parseHexColor('#1#2')).toBe(0x1)
    expect(parseHexColor('#1#2')).toBe(inlineParseHexColor('#1#2'))
    // 'a#b#c' → 最初の # だけ消えて 'ab#c' → parseInt('ab#c',16)='ab' まで → 0xab
    expect(parseHexColor('a#b#c')).toBe(0xab)
    expect(parseHexColor('a#b#c')).toBe(inlineParseHexColor('a#b#c'))
  })
})

describe('resolveAssetUrl', () => {
  // 抽出前に 5 箇所で直書きされていた式（リファレンス）。
  function inlineResolveUrl(baseUrl: string, kind: 'images' | 'sounds', path: string): string {
    return `${baseUrl}/${kind}/${path.replace(/^\//, '')}`
  }

  it('リファレンス等価性: 抽出前 inline 式と一致', () => {
    const cases: Array<[string, 'images' | 'sounds', string]> = [
      ['/assets', 'images', 'bg/room.png'],
      ['/assets', 'images', '/bg/room.png'], // 先頭スラッシュ付き
      ['/assets', 'sounds', 'bgm/main.mp3'],
      ['/assets', 'sounds', '/se/click.wav'],
      ['https://cdn.example.com', 'sounds', 'voice/a.mp3'],
      ['', 'images', 'x.png'], // 空 baseUrl
    ]
    for (const [base, kind, path] of cases) {
      expect(resolveAssetUrl(base, kind, path)).toBe(inlineResolveUrl(base, kind, path))
    }
  })

  it('images / sounds の種別をパスに反映', () => {
    expect(resolveAssetUrl('/assets', 'images', 'bg.png')).toBe('/assets/images/bg.png')
    expect(resolveAssetUrl('/assets', 'sounds', 'bgm.mp3')).toBe('/assets/sounds/bgm.mp3')
  })

  it("path 先頭の '/' を 1 つだけ落とす", () => {
    expect(resolveAssetUrl('/assets', 'sounds', '/bgm.mp3')).toBe('/assets/sounds/bgm.mp3')
    // 二重スラッシュは 1 つだけ落ちる（元 replace(/^\//) の挙動）
    expect(resolveAssetUrl('/assets', 'sounds', '//bgm.mp3')).toBe('/assets/sounds//bgm.mp3')
  })
})

describe('saveSlotToGameState', () => {
  function baseData(): SaveSlotData {
    return {
      slot: 1,
      sceneId: 'scene-1',
      eventIndex: 5,
      textIndex: 2,
      flags: { hasKey: { Bool: true } },
      backgroundPath: 'bg/room.png',
      isBlackout: true,
      characters: [{ name: 'A', expression: 'smile', position: 'center' }],
      currentBgmPath: 'bgm/main.mp3',
      savedAt: '2026-01-01T00:00:00.000Z',
      sceneName: 'Room',
    }
  }

  // 抽出前 NovelRenderer.loadFromSaveData 内の state 構築ブロック（リファレンス）。
  // fade は呼び出し側で正規化済みの値を渡す前提なので、ここでも正規化済み値をそのまま使う。
  function inlineState(data: SaveSlotData, normalizedFade: BackgroundFade | null) {
    return {
      sceneId: data.sceneId,
      eventIndex: data.eventIndex,
      textIndex: data.textIndex,
      flags: data.flags,
      backgroundPath: data.backgroundPath,
      backgroundColor: data.backgroundColor ?? null,
      backgroundFade: normalizedFade,
      video: data.video ?? null,
      isBlackout: data.isBlackout ?? false,
      characters: data.characters ?? [],
      currentBgmPath: data.currentBgmPath ?? null,
    }
  }

  it('リファレンス等価性: 抽出前 inline ブロックと一致（全フィールド指定）', () => {
    const data = baseData()
    const fade: BackgroundFade = { top: 0.5, bottom: 0, left: 0, right: 0 }
    expect(saveSlotToGameState(data, fade)).toEqual(inlineState(data, fade))
  })

  it('全フィールドが data から正しく写像される', () => {
    const data = baseData()
    const state = saveSlotToGameState(data, null)
    expect(state).toEqual({
      sceneId: 'scene-1',
      eventIndex: 5,
      textIndex: 2,
      flags: { hasKey: { Bool: true } },
      backgroundPath: 'bg/room.png',
      backgroundColor: null,
      backgroundFade: null,
      video: null,
      isBlackout: true,
      characters: [{ name: 'A', expression: 'smile', position: 'center' }],
      currentBgmPath: 'bgm/main.mp3',
    })
  })

  it('後方互換フォールバック: video 未定義 → null', () => {
    const data = baseData()
    delete (data as Partial<SaveSlotData>).video
    expect(saveSlotToGameState(data, null).video).toBeNull()
  })

  it('後方互換フォールバック: video あり → その値', () => {
    const data = baseData()
    data.video = { path: 'v/intro.mp4', loop: true } as SaveSlotData['video']
    expect(saveSlotToGameState(data, null).video).toEqual({ path: 'v/intro.mp4', loop: true })
  })

  it('正規化済み fade をそのまま採用（純粋関数は再正規化しない）', () => {
    const data = baseData()
    const fade: BackgroundFade = { top: 0, bottom: 0.3, left: 0, right: 0 }
    expect(saveSlotToGameState(data, fade).backgroundFade).toBe(fade)
    expect(saveSlotToGameState(data, null).backgroundFade).toBeNull()
  })

  it('sceneId は data の値をそのまま代入（呼び出し側が非 null を保証）', () => {
    const data = baseData()
    data.sceneId = 'other-scene'
    expect(saveSlotToGameState(data, null).sceneId).toBe('other-scene')
  })
})

describe('resolveFontFamily', () => {
  // 抽出前 NovelRenderer の 2 箇所に直書きされていた優先順チェーン（リファレンス）。
  // render() / processDirective(TitleShow) ともこの同形の式だった:
  //   <perLine> ?? this.gameDefaultFontFamily ?? RUNTIME_DEFAULT_FONT_FAMILY
  // これは抽出後関数のコピーではなく、元の inline 式そのものを `??` で再現したオラクル。
  const RUNTIME_DEFAULT = "'Noto Sans JP', sans-serif"
  function inlineResolve(
    perLine: string | null | undefined,
    perGame: string | null | undefined
  ): string {
    return perLine ?? perGame ?? RUNTIME_DEFAULT
  }

  it('リファレンス等価性: 抽出前 inline チェーン（?? ?? ??）と一致', () => {
    // perLine / perGame の全 (指定 / null / undefined) 組み合わせ + 空文字を網羅。
    const fontVals: Array<string | null | undefined> = [
      "'Serif', serif", // 指定あり
      "''", // 一見空に見えるが非空文字（指定扱い）
      '', // 空文字（?? は素通し → 指定扱い）
      null,
      undefined,
    ]
    for (const perLine of fontVals) {
      for (const perGame of fontVals) {
        expect(resolveFontFamily(perLine, perGame, RUNTIME_DEFAULT)).toBe(
          inlineResolve(perLine, perGame)
        )
      }
    }
  })

  it('per-line 指定があれば最優先', () => {
    expect(resolveFontFamily("'A', sans-serif", "'B', serif", RUNTIME_DEFAULT)).toBe(
      "'A', sans-serif"
    )
  })

  it('per-line 未指定なら per-game default に落ちる', () => {
    expect(resolveFontFamily(null, "'B', serif", RUNTIME_DEFAULT)).toBe("'B', serif")
    expect(resolveFontFamily(undefined, "'B', serif", RUNTIME_DEFAULT)).toBe("'B', serif")
  })

  it('per-line / per-game とも未指定なら runtime default', () => {
    expect(resolveFontFamily(null, null, RUNTIME_DEFAULT)).toBe(RUNTIME_DEFAULT)
    expect(resolveFontFamily(undefined, undefined, RUNTIME_DEFAULT)).toBe(RUNTIME_DEFAULT)
  })

  it("空文字 '' は「指定あり」として素通しする（?? の元挙動）", () => {
    // ?? は falsy ('') を素通しするため、空文字 per-line は default に落ちない。
    expect(resolveFontFamily('', "'B', serif", RUNTIME_DEFAULT)).toBe('')
    expect(resolveFontFamily(null, '', RUNTIME_DEFAULT)).toBe('')
  })
})

describe('formatCounterText', () => {
  // 抽出前 NovelRenderer.updateCounter の inline 式（リファレンス）:
  //   this.counterText.text = `${displayIndex} / ${this.displayEventCount}`
  function inlineCounter(displayIndex: number, total: number): string {
    return `${displayIndex} / ${total}`
  }

  it('リファレンス等価性: 抽出前 inline テンプレートと一致', () => {
    const cases: Array<[number, number]> = [
      [3, 13], // 通常
      [0, 0], // 空（先頭未到達 / イベントなし）
      [1, 1], // 1 件のみ
      [13, 13], // 末尾
      [100, 999], // 大きい値
    ]
    for (const [di, total] of cases) {
      expect(formatCounterText(di, total)).toBe(inlineCounter(di, total))
    }
  })

  it('"{displayIndex} / {total}" の書式（桁区切り等の整形はしない）', () => {
    expect(formatCounterText(3, 13)).toBe('3 / 13')
    expect(formatCounterText(0, 0)).toBe('0 / 0')
    expect(formatCounterText(1000, 2000)).toBe('1000 / 2000') // 桁区切りなし
  })
})

describe('computeSeekBarPosition', () => {
  // 抽出前 NovelRenderer.updateSeekBar の inline 式（リファレンス）:
  //   const current = Math.max(0, displayIndex - 1)
  //   const total = this.displayEventCount
  function inlineSeek(displayIndex: number, total: number): { current: number; total: number } {
    const current = Math.max(0, displayIndex - 1)
    return { current, total }
  }

  it('リファレンス等価性: 抽出前 inline 式（Math.max(0, displayIndex-1)）と一致', () => {
    const cases: Array<[number, number]> = [
      [3, 13], // 通常 → current=2
      [1, 13], // 先頭テキスト到達 → current=0
      [0, 13], // 未到達 (displayIndex=0) → max(0,-1)=0
      [13, 13], // 末尾 → current=12
      [0, 0], // 空シナリオ
      [1, 1], // 1 件のみ → current=0
    ]
    for (const [di, total] of cases) {
      expect(computeSeekBarPosition(di, total)).toEqual(inlineSeek(di, total))
    }
  })

  it('displayIndex を 0-based にし、先頭で負にならないようクランプ', () => {
    expect(computeSeekBarPosition(3, 13)).toEqual({ current: 2, total: 13 })
    expect(computeSeekBarPosition(1, 13)).toEqual({ current: 0, total: 13 }) // 1-1=0
    expect(computeSeekBarPosition(0, 13)).toEqual({ current: 0, total: 13 }) // max(0,-1)=0
  })

  it('total は displayEventCount をそのまま素通し', () => {
    expect(computeSeekBarPosition(5, 42).total).toBe(42)
    expect(computeSeekBarPosition(5, 0).total).toBe(0)
  })
})

describe('describeEventForDebug', () => {
  // 抽出前 NovelRenderer.getDebugState 内の inline 抽出ロジック（リファレンス）。
  // 抽出後関数のコピーではなく、元の getDebugState の文（current → kind/text 導出）を
  // そのまま貼り直したオラクル。
  function inlineDescribe(current: unknown): { kind: string; text: string | undefined } {
    let kind = '(none)'
    let text: string | undefined
    if (current && typeof current === 'object') {
      kind = Object.keys(current)[0] ?? '(unknown)'
      const v = (current as Record<string, unknown>)[kind]
      if (v && typeof v === 'object') {
        const maybeText = (
          v as { text?: unknown; line?: unknown; path?: unknown; target?: unknown }
        ).text
        if (Array.isArray(maybeText) && maybeText.length > 0)
          text = JSON.stringify(maybeText[0]).slice(0, 120)
        else if (typeof (v as { line?: unknown }).line === 'string')
          text = (v as { line: string }).line
        else if (typeof (v as { path?: unknown }).path === 'string')
          text = (v as { path: string }).path
        else if (typeof (v as { target?: unknown }).target === 'string')
          text = (v as { target: string }).target
      }
    }
    return { kind, text }
  }

  it('リファレンス等価性: 抽出前 getDebugState の inline 抽出と一致', () => {
    const cases: unknown[] = [
      { Dialog: { character: 'A', text: ['こんにちは', '2行目'] } }, // text 配列 → 先頭を JSON 化
      { Narration: { text: ['ナレーション'] } },
      { Background: { path: 'bg/room.png' } }, // path 経路
      { Bgm: { path: 'bgm/main.mp3', action: 'Play' } },
      { Choice: { target: 'scene-2' } }, // target 経路
      { Wait: { ms: 500 } }, // text/line/path/target いずれも無 → undefined
      { Dialog: { character: 'A', text: [] } }, // 空配列 → text 経路に乗らず undefined
      'SceneTransition', // 文字列 → object でない → '(none)'
      null, // null → '(none)'
      undefined, // undefined → '(none)'
      42, // number → '(none)'
      {}, // 空オブジェクト → keys[0] undefined → '(unknown)'
      { Dialog: 'not-an-object' }, // v が object でない → text なし
      { Foo: { line: 'ライン文字列' } }, // line 経路（line/path/target の優先順確認用）
      { Foo: { line: 'L', path: 'P', target: 'T' } }, // line が最優先
      { Foo: { path: 'P', target: 'T' } }, // path が target より優先
    ]
    for (const c of cases) {
      expect(describeEventForDebug(c)).toEqual(inlineDescribe(c))
    }
  })

  it('text 配列は先頭要素を JSON 化して 120 文字に切り詰める', () => {
    const long = 'あ'.repeat(300)
    const r = describeEventForDebug({ Dialog: { text: [long] } })
    // JSON.stringify でクォートが付くので、先頭は '"あああ...'。120 文字で切る。
    expect(r.text).toBe(JSON.stringify(long).slice(0, 120))
    expect(r.text!.length).toBe(120)
  })

  it('本文取り出し優先順: text 配列 > line > path > target', () => {
    expect(
      describeEventForDebug({ E: { text: ['T'], line: 'L', path: 'P', target: 'X' } }).text
    ).toBe(JSON.stringify('T'))
    expect(describeEventForDebug({ E: { line: 'L', path: 'P', target: 'X' } }).text).toBe('L')
    expect(describeEventForDebug({ E: { path: 'P', target: 'X' } }).text).toBe('P')
    expect(describeEventForDebug({ E: { target: 'X' } }).text).toBe('X')
  })

  it('object でない / 空オブジェクトの退化系', () => {
    expect(describeEventForDebug('str')).toEqual({ kind: '(none)', text: undefined })
    expect(describeEventForDebug(null)).toEqual({ kind: '(none)', text: undefined })
    expect(describeEventForDebug(undefined)).toEqual({ kind: '(none)', text: undefined })
    expect(describeEventForDebug({})).toEqual({ kind: '(unknown)', text: undefined })
  })
})

// EventScene の最小フィクスチャ（events は本テスト対象の find/title 解決に無関係なので空）。
function scene(id: string, title: string): EventScene {
  return { id, title, view: 'TopDown', events: [] }
}

describe('findSceneById', () => {
  // 抽出前 NovelRenderer の jumpToScene / loadFromSaveData / startFrom に同形で直書き
  // されていた式そのもの（抽出後関数のコピーではなく inline 式の貼り直し）:
  //   this.allScenes.find((s) => s.id === <id>)
  function inlineFind(scenes: EventScene[], sceneId: string): EventScene | undefined {
    return scenes.find((s) => s.id === sceneId)
  }

  const scenes: EventScene[] = [
    scene('intro', '導入'),
    scene('room-1', '部屋1'),
    scene('room-2', '部屋2'),
  ]

  it('リファレンス等価性: 抽出前 inline find と同一参照を返す', () => {
    const cases = ['intro', 'room-1', 'room-2', 'missing', '', 'INTRO']
    for (const id of cases) {
      // toBe で参照同値（同じ配列要素 or 同じ undefined）を縛る。値コピーではない。
      expect(findSceneById(scenes, id)).toBe(inlineFind(scenes, id))
    }
  })

  it('該当 id のシーン本体（同一参照）を返す', () => {
    expect(findSceneById(scenes, 'room-1')).toBe(scenes[1])
    expect(findSceneById(scenes, 'intro')).toBe(scenes[0])
  })

  it('該当なし → undefined（find の素の挙動）', () => {
    expect(findSceneById(scenes, 'nope')).toBeUndefined()
    expect(findSceneById([], 'intro')).toBeUndefined()
  })

  it('=== による厳密一致（大文字小文字・型を区別）', () => {
    expect(findSceneById(scenes, 'Intro')).toBeUndefined() // 大文字違いは不一致
    expect(findSceneById(scenes, '')).toBeUndefined()
  })

  it('id 重複時は先頭から最初の一致（先勝ち）を返す', () => {
    const dup: EventScene[] = [scene('dup', '先'), scene('dup', '後'), scene('x', 'X')]
    expect(findSceneById(dup, 'dup')).toBe(dup[0])
    expect(findSceneById(dup, 'dup')?.title).toBe('先')
  })
})

describe('resolveSceneTitle', () => {
  // 抽出前 NovelRenderer の quickSave / openSaveMenu に**バイト単位で重複**していた式
  // そのもの（抽出後関数のコピーではない）:
  //   this.currentSceneId
  //     ? (this.allScenes.find((s) => s.id === this.currentSceneId)?.title ?? null)
  //     : null
  function inlineResolveTitle(
    scenes: EventScene[],
    sceneId: string | null | undefined
  ): string | null {
    return sceneId ? (scenes.find((s) => s.id === sceneId)?.title ?? null) : null
  }

  const scenes: EventScene[] = [scene('intro', '導入'), scene('room-1', '部屋1')]

  it('リファレンス等価性: 抽出前 inline 三項式と一致', () => {
    const cases: Array<string | null | undefined> = [
      'intro', // 一致 → title
      'room-1', // 別の一致 → title
      'missing', // scene 無し → null（?.title が undefined → ?? null）
      '', // 空文字 → falsy → 即 null（scene を引かない）
      null, // null → 即 null
      undefined, // undefined → 即 null
    ]
    for (const id of cases) {
      expect(resolveSceneTitle(scenes, id)).toBe(inlineResolveTitle(scenes, id))
    }
  })

  it('該当シーンの title を返す', () => {
    expect(resolveSceneTitle(scenes, 'intro')).toBe('導入')
    expect(resolveSceneTitle(scenes, 'room-1')).toBe('部屋1')
  })

  it('sceneId が null / undefined / 空文字 → null（scene を引かず即 return）', () => {
    expect(resolveSceneTitle(scenes, null)).toBeNull()
    expect(resolveSceneTitle(scenes, undefined)).toBeNull()
    expect(resolveSceneTitle(scenes, '')).toBeNull()
  })

  it('該当 scene が無い → null', () => {
    expect(resolveSceneTitle(scenes, 'no-such-scene')).toBeNull()
    expect(resolveSceneTitle([], 'intro')).toBeNull()
  })

  it('title が（型上はあり得ないが）実行時 undefined/null でも ?? null で null に落とす', () => {
    // 元 inline 式の `?.title ?? null` の防御を保つ。型を欺いて undefined/null title を作る。
    const undef: EventScene[] = [
      { id: 'x', title: undefined as unknown as string, view: 'TopDown', events: [] },
    ]
    const nul: EventScene[] = [
      { id: 'y', title: null as unknown as string, view: 'TopDown', events: [] },
    ]
    expect(resolveSceneTitle(undef, 'x')).toBeNull()
    expect(resolveSceneTitle(nul, 'y')).toBeNull()
  })

  it('空文字 title は素通し（?? null は falsy の "" を落とさない）', () => {
    // ?? は '' を素通しするので、空タイトルは null ではなく '' を返す（元 inline と同じ）。
    const empty: EventScene[] = [scene('e', '')]
    expect(resolveSceneTitle(empty, 'e')).toBe('')
    expect(resolveSceneTitle(empty, 'e')).toBe(inlineResolveTitle(empty, 'e'))
  })

  it('複数 scene から正しい 1 件の title を選ぶ', () => {
    const many: EventScene[] = [scene('a', 'A'), scene('b', 'B'), scene('c', 'C')]
    expect(resolveSceneTitle(many, 'b')).toBe('B')
    expect(resolveSceneTitle(many, 'c')).toBe('C')
  })
})
