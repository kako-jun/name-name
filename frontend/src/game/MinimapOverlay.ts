/**
 * RPG 向け 2D ミニマップオーバーレイ (#149)。
 *
 * 画面端（既定: 右上）にマップ全体の俯瞰図を常駐表示する。
 * - 壁 (TREE / WATER) と床 (GRASS / ROAD) を色塗り
 * - プレイヤー位置を赤丸 + 向き矢印で示す
 * - NPC を NpcData.color の単色ドットで示す
 *
 * TopDownRenderer / RaycastRenderer の両方で使う。Raycast は連続位置 + 角度、
 * TopDown はグリッド位置 + 4 方向 enum なので入力は別 API で受ける。
 *
 * 1 フレーム毎に再描画する用途のため、Graphics は使い回し（毎フレ destroy しない）。
 */

import { Container, Graphics } from 'pixi.js'
import { TileType, TILE_COLORS_HEX } from '../types/rpg'
import type { UiNpcData } from '../types/rpg'

export type MinimapCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'

export interface MinimapOptions {
  /** ミニマップ全体の最大ピクセル辺長（正方形）。デフォルト 120 */
  size?: number
  /** 画面端からのマージン px。デフォルト 12 */
  margin?: number
  /** 配置位置。デフォルト 'top-right' */
  corner?: MinimapCorner
}

const DEFAULT_SIZE = 120
const DEFAULT_MARGIN = 12

/** プレイヤー / NPC マーカーの半径（タイル px の倍率）。1 タイル一杯に近い大きさ */
const MARKER_RADIUS_RATIO = 0.45
/** プレイヤー三角形の前頂点までの距離（マーカー半径の倍率）。前向きを示す矢印感 */
const PLAYER_TIP_REACH = 1.6
/**
 * プレイヤー三角形の左右底点角度（前向きから 0.75π = 135° の後方斜め）。
 * 0.5π（真横）だと矢じりが鋭すぎ、π（真後ろ）だと針状で底辺が無くなるため
 * 0.75π を採用してそれっぽい矢印形状にする。
 */
const PLAYER_BACK_ANGLE = Math.PI * 0.75

export class MinimapOverlay extends Container {
  private bg: Graphics
  private tiles: Graphics
  private npcsLayer: Graphics
  private playerLayer: Graphics

  private screenWidth: number
  private screenHeight: number
  private size: number
  private margin: number
  private corner: MinimapCorner

  /** 計算済みの origin（左上座標）と 1 タイル px サイズ。タイルレイアウト変更時に再計算 */
  private originX = 0
  private originY = 0
  private tilePx = 0
  /** 直近の map 寸法（再描画判定に使う） */
  private mapW = 0
  private mapH = 0

  constructor(screenWidth: number, screenHeight: number, options: MinimapOptions = {}) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.size = options.size ?? DEFAULT_SIZE
    this.margin = options.margin ?? DEFAULT_MARGIN
    this.corner = options.corner ?? 'top-right'

    this.bg = new Graphics()
    this.tiles = new Graphics()
    this.npcsLayer = new Graphics()
    this.playerLayer = new Graphics()
    this.addChild(this.bg)
    this.addChild(this.tiles)
    this.addChild(this.npcsLayer)
    this.addChild(this.playerLayer)
  }

  /**
   * 画面サイズ変更時に呼ぶ。マップ寸法は変わらない前提なら、タイル/NPC 再描画はコール側で。
   *
   * 高負荷経路で呼ばれるため、origin / tilePx に変化が無いときは内部再計算もスキップする
   * （タイル数 100×100 のマップでは setMap を毎回呼ぶと無視できないコストになる）。
   */
  resize(screenWidth: number, screenHeight: number): void {
    if (screenWidth === this.screenWidth && screenHeight === this.screenHeight) return
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.recomputeOrigin()
  }

  /**
   * マップ寸法とタイルデータが変わったときに呼ぶ（load 時 1 回 + リサイズ時に各 renderer から呼ぶ想定）。
   * 内部で origin 再計算 + 背景パネル + タイル描画。
   */
  setMap(mapWidth: number, mapHeight: number, tiles: ReadonlyArray<ReadonlyArray<number>>): void {
    this.mapW = mapWidth
    this.mapH = mapHeight
    this.recomputeOrigin()
    this.drawBackground()
    this.drawTiles(tiles)
  }

  /**
   * NPC の色付きドットを描く。マップ寸法を変えていなければ毎フレでも安価。
   */
  setNpcs(npcs: ReadonlyArray<UiNpcData>): void {
    this.npcsLayer.clear()
    if (this.tilePx <= 0) return
    const r = Math.max(1, this.tilePx * MARKER_RADIUS_RATIO)
    for (const npc of npcs) {
      const cx = this.originX + (npc.x + 0.5) * this.tilePx
      const cy = this.originY + (npc.y + 0.5) * this.tilePx
      this.npcsLayer.circle(cx, cy, r).fill({ color: npc.color, alpha: 1 })
    }
  }

  /**
   * プレイヤー位置と向きを描く（TopDown 用、グリッド + 4 方向）。毎フレ呼ぶ。
   */
  setPlayerGrid(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right'): void {
    if (this.tilePx <= 0) return
    const cx = this.originX + (x + 0.5) * this.tilePx
    const cy = this.originY + (y + 0.5) * this.tilePx
    const angleRad =
      direction === 'right'
        ? 0
        : direction === 'down'
          ? Math.PI / 2
          : direction === 'left'
            ? Math.PI
            : -Math.PI / 2
    this.drawPlayerAt(cx, cy, angleRad)
  }

  /**
   * プレイヤー位置と向きを描く（Raycast 用、float 位置 + ラジアン角）。毎フレ呼ぶ。
   */
  setPlayerAngle(x: number, y: number, angleRad: number): void {
    if (this.tilePx <= 0) return
    const cx = this.originX + x * this.tilePx
    const cy = this.originY + y * this.tilePx
    this.drawPlayerAt(cx, cy, angleRad)
  }

  private drawPlayerAt(cx: number, cy: number, angleRad: number): void {
    this.playerLayer.clear()
    const r = Math.max(1.5, this.tilePx * MARKER_RADIUS_RATIO)
    // 三角形（向き矢印兼）。前頂点 + 左右底点で正三角形に近い矢じり形
    const tipX = cx + Math.cos(angleRad) * r * PLAYER_TIP_REACH
    const tipY = cy + Math.sin(angleRad) * r * PLAYER_TIP_REACH
    const leftAngle = angleRad + PLAYER_BACK_ANGLE
    const rightAngle = angleRad - PLAYER_BACK_ANGLE
    const lx = cx + Math.cos(leftAngle) * r
    const ly = cy + Math.sin(leftAngle) * r
    const rx = cx + Math.cos(rightAngle) * r
    const ry = cy + Math.sin(rightAngle) * r
    this.playerLayer
      .poly([tipX, tipY, lx, ly, rx, ry])
      .fill({ color: 0xff3344, alpha: 1 })
      .stroke({ color: 0xffffff, width: 1 })
  }

  private recomputeOrigin(): void {
    if (this.mapW <= 0 || this.mapH <= 0) return
    // タイル px は max(mapW, mapH) に基づく内接サイズ
    this.tilePx = Math.floor(this.size / Math.max(this.mapW, this.mapH))
    if (this.tilePx <= 0) this.tilePx = 1
    const actualW = this.tilePx * this.mapW
    const actualH = this.tilePx * this.mapH
    // 画面端からの実位置（パネル全体の左上）
    let panelX: number
    let panelY: number
    if (this.corner === 'top-right' || this.corner === 'bottom-right') {
      panelX = this.screenWidth - actualW - this.margin
    } else {
      panelX = this.margin
    }
    if (this.corner === 'top-right' || this.corner === 'top-left') {
      panelY = this.margin
    } else {
      panelY = this.screenHeight - actualH - this.margin
    }
    this.originX = panelX
    this.originY = panelY
  }

  private drawBackground(): void {
    if (this.tilePx <= 0) return
    const w = this.tilePx * this.mapW
    const h = this.tilePx * this.mapH
    this.bg.clear()
    // 半透明黒の枠（DQ 風 UI と統一）。少し外側に padding を取る
    const pad = 3
    this.bg
      .roundRect(this.originX - pad, this.originY - pad, w + pad * 2, h + pad * 2, 4)
      .fill({ color: 0x000000, alpha: 0.55 })
      .stroke({ color: 0xffffff, width: 1, alpha: 0.6 })
  }

  private drawTiles(tiles: ReadonlyArray<ReadonlyArray<number>>): void {
    this.tiles.clear()
    if (this.tilePx <= 0) return
    // 同色のタイルをまとめて 1 回 fill する単純な最適化。TileType は現状 4 種
    // （GRASS / ROAD / TREE / WATER）なので fill 呼び出しは最大 4 回に収まる。
    // タイル毎に fill すると O(W*H) 回の fill 呼び出しになるためそれを回避。
    const byColor = new Map<number, Array<[number, number]>>()
    for (let y = 0; y < this.mapH; y++) {
      const row = tiles[y]
      if (!row) continue
      for (let x = 0; x < this.mapW; x++) {
        const t = row[x] as TileType
        const color = TILE_COLORS_HEX[t] ?? TILE_COLORS_HEX[TileType.GRASS]
        const list = byColor.get(color) ?? []
        list.push([x, y])
        byColor.set(color, list)
      }
    }
    for (const [color, cells] of byColor) {
      for (const [x, y] of cells) {
        this.tiles.rect(
          this.originX + x * this.tilePx,
          this.originY + y * this.tilePx,
          this.tilePx,
          this.tilePx
        )
      }
      this.tiles.fill({ color, alpha: 0.85 })
    }
  }
}

/**
 * テスト容易性のため、ミニマップの origin / tilePx 計算を純関数として export する。
 * MinimapOverlay インスタンス内のロジックと同等の計算式を持つ。
 */
export function computeMinimapLayout(input: {
  screenWidth: number
  screenHeight: number
  mapWidth: number
  mapHeight: number
  size?: number
  margin?: number
  corner?: MinimapCorner
}): { originX: number; originY: number; tilePx: number } {
  const size = input.size ?? DEFAULT_SIZE
  const margin = input.margin ?? DEFAULT_MARGIN
  const corner = input.corner ?? 'top-right'
  if (input.mapWidth <= 0 || input.mapHeight <= 0) {
    return { originX: 0, originY: 0, tilePx: 0 }
  }
  let tilePx = Math.floor(size / Math.max(input.mapWidth, input.mapHeight))
  if (tilePx <= 0) tilePx = 1
  const actualW = tilePx * input.mapWidth
  const actualH = tilePx * input.mapHeight
  const originX =
    corner === 'top-right' || corner === 'bottom-right'
      ? input.screenWidth - actualW - margin
      : margin
  const originY =
    corner === 'top-right' || corner === 'top-left' ? margin : input.screenHeight - actualH - margin
  return { originX, originY, tilePx }
}
