import { describe, it, expect } from 'vitest'
import { computeCoverFit, parseHexColor, resolveAssetUrl, saveSlotToGameState } from './novelLayout'
import type { SaveSlotData } from './SaveManager'
import type { BackgroundFade } from './GameState'

describe('computeCoverFit', () => {
  // 抽出前に NovelRenderer.applyCoverFit 内で直書きされていた式（リファレンス実装）。
  // sprite.{width,height,x,y} に代入していた値をそのまま再現する。
  function inlineCoverFit(texW: number, texH: number, screenW: number, screenH: number) {
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

  it('リファレンス等価性: 抽出前 inline 式と数値完全一致', () => {
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
      expect(computeCoverFit(tw, th, sw, sh)).toEqual(inlineCoverFit(tw, th, sw, sh))
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
