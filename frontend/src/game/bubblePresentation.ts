import { computeCameraProjection } from './cameraProjection'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'

/** `[吹き出し:]` で指定できる本文の表示スタイル (#698)。 */
export type BubbleStyle = '通常' | '静か' | '叫び' | '内心' | 'ナレーション'

export type BubbleFrameShape = 'rounded' | 'cloud' | 'zigzag'
export type BubbleLinePattern = 'solid' | 'dotted' | 'dashed'

/**
 * 描画層に依存しない吹き出しの視覚契約。
 *
 * - 静か: 雲形 + 点線で、小さく抑えた発話を表す
 * - 内心: 雲形 + 破線・紫灰色で、声に出ない思考を区別する
 * - 叫び: ギザギザ枠 + 太い暖色線で、強い発話を表す
 */
export interface BubblePresentation {
  shape: BubbleFrameShape
  linePattern: BubbleLinePattern
  fill: number
  stroke: number
  strokeWidth: number
  text: number
  fontSize: number
  paddingX: number
  paddingY: number
  wordWrapRatio: number
}

const PRESENTATIONS: Record<BubbleStyle, BubblePresentation> = {
  通常: {
    shape: 'rounded',
    linePattern: 'solid',
    fill: 0xffffff,
    stroke: 0x252525,
    strokeWidth: 2,
    text: 0x171717,
    fontSize: 28,
    paddingX: 48,
    paddingY: 32,
    wordWrapRatio: 0.32,
  },
  静か: {
    shape: 'cloud',
    linePattern: 'dotted',
    fill: 0xf2f7fb,
    stroke: 0x8da7bd,
    strokeWidth: 2,
    text: 0x41576b,
    fontSize: 27,
    paddingX: 52,
    paddingY: 36,
    wordWrapRatio: 0.32,
  },
  叫び: {
    shape: 'zigzag',
    linePattern: 'solid',
    fill: 0xfff7ed,
    stroke: 0xff5d47,
    strokeWidth: 5,
    text: 0x4a1710,
    fontSize: 30,
    paddingX: 52,
    paddingY: 36,
    wordWrapRatio: 0.34,
  },
  内心: {
    shape: 'cloud',
    linePattern: 'dashed',
    fill: 0xf5f1fb,
    stroke: 0x9c8bb5,
    strokeWidth: 2,
    text: 0x554866,
    fontSize: 27,
    paddingX: 52,
    paddingY: 36,
    wordWrapRatio: 0.32,
  },
  ナレーション: {
    shape: 'rounded',
    linePattern: 'solid',
    fill: 0xfffdf7,
    stroke: 0x756b5b,
    strokeWidth: 2,
    text: 0x2f2a23,
    fontSize: 30,
    paddingX: 48,
    paddingY: 32,
    wordWrapRatio: 0.62,
  },
}

export function getBubblePresentation(style: BubbleStyle): BubblePresentation {
  return PRESENTATIONS[style]
}

/** 指定のない既存台本は DialogBox、指定済みかつ本文がある行だけ吹き出しへ置換する。 */
export function resolveTextDisplay(
  style: BubbleStyle | null,
  text: string
): 'dialogBox' | 'bubble' {
  return style !== null && text.replace(/[\s\u3000]/g, '') !== '' ? 'bubble' : 'dialogBox'
}

export interface BubbleLayout {
  x: number
  y: number
  scale: number
  verticalOffset: number
}

/**
 * 本文の実測値から吹き出し枠の寸法を求める純粋関数。
 *
 * Pixi の Text 測定は実ブラウザの Canvas を必要とする。枠の余白計算そのものは
 * 描画器に依存しないため、測定結果を受け取る形にして headless テストでも同じ
 * 幾何契約を検証できるようにする。
 */
export function computeBubbleFrameSize(
  measured: { width: number; height: number },
  presentation: BubblePresentation
): { width: number; height: number } {
  return {
    width: measured.width + presentation.paddingX,
    height: measured.height + presentation.paddingY,
  }
}

/** Novel は正投影のまま、Theater だけ既存カメラ投影を共有する。 */
export function computeBubbleLayout(options: {
  style: BubbleStyle
  screenWidth: number
  screenHeight: number
  xRatio: number
  depth: number
  mode: CameraMode
  orientation: CameraOrientation
  elevation: CameraElevation | null
}): BubbleLayout {
  const narration = options.style === 'ナレーション'
  const projection = narration
    ? { scale: 1, verticalOffset: 0 }
    : computeCameraProjection(options.mode, options.orientation, options.elevation, options.depth)
  return {
    x: narration ? options.screenWidth / 2 : options.screenWidth * options.xRatio,
    y: narration
      ? options.screenHeight * 0.2
      : options.screenHeight * 0.32 + projection.verticalOffset,
    scale: projection.scale,
    verticalOffset: projection.verticalOffset,
  }
}
