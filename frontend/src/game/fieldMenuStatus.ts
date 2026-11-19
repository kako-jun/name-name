/**
 * フィールドメニューのステータス画面の配置 (#1191)。計算だけ（PixiJS の描画には触れない）。
 * `field_menu_status_layout: ff` のとき、FF5・FF6 のように領域に分けて並べる（左に人物の絵の枠、右に
 * 名前・Lv / HP・MP の大きな数字 / 能力値の 2 列の表 / 定義側の追加行、最下段に全幅の帯）。
 *
 * 領域は `StatusRegion`（id・矩形・中の項目）の配列で返す。描画側は領域を順に描くだけなので、
 * 項目を足す (#1186: 固有素質・装備・想像の刃・経験値・次のレベルまで) ときは、この関数の
 * 入力（`extraRows`・`bandRows`）に行を渡すか、領域を 1 つ（id・矩形・項目）ここに足すだけで済む。
 * 行が増えても表・帯の文字は `STATUS_MIN_FONT_RATIO`（基準の文字の 0.7 倍）を下回らない。入り切らないときは先に
 * 行の高さ・HP/MP の枠・隙間を詰め、それでも入らなければ追加行を 3 列にする。
 */
import { fitAcrylicGeometry } from '../field/acrylicFigure'
import type { Rect } from './fieldMenu'
import type { StatusRow } from './fieldMenuScreens'
import { DEFAULT_ACRYLIC_PARAMS } from './spriteStyle'

/** ステータス画面の配置。`line` = 従来（左揃えの 1 列）、`ff` = 領域に分けた配置 */
export type StatusLayoutKind = 'line' | 'ff'
export const STATUS_LAYOUT_KINDS: readonly StatusLayoutKind[] = ['line', 'ff']

/** 表・帯の文字の大きさの下限（基準の文字 `font` に対する比）。行を足してもこれより小さくしない */
export const STATUS_MIN_FONT_RATIO = 0.7

export type StatusRegionId = 'portrait' | 'identity' | 'vitals' | 'stats' | 'extras' | 'band'

/** 「現在 / 最大」を、現在値・「/」・最大値それぞれの位置に右揃えで置くための座標（HP と MP で桁がそろう） */
export interface StatusPair {
  cur: string
  max: string
  /** 現在値の右端の x */
  curRight: number
  /** 「/」の中心の x */
  slashX: number
  /** 最大値の右端の x */
  maxRight: number
}

/** 領域の中の 1 項目。ラベルは左、値は右揃え */
export interface StatusCell {
  label: string
  value: string
  rect: Rect
  /** ラベルの文字の大きさ (px) */
  labelSize: number
  /** 値の文字の大きさ (px) */
  valueSize: number
  /** `name` = 名前（白）、`label` = 項目名（強調色） */
  tone: 'name' | 'label'
  /** 値の右端の x。省略は rect の右端（能力値の表はラベル寄りに置く） */
  valueRight?: number
  /** あれば `value` の代わりに 3 つに分けて置く（HP・MP） */
  pair?: StatusPair
}

export interface StatusRegion {
  id: StatusRegionId
  rect: Rect
  cells: StatusCell[]
}

/** 配置に必要な人物の値（描画用の表示値。未定義は「--」で出す） */
export interface StatusPerson {
  name: string
  level?: number
  hp: number
  maxHp: number
  mp?: number
  maxMp?: number
  atk?: number
  def?: number
  agi?: number
}

export interface StatusLayoutInput {
  /** 本体の窓の中で、人物の前・次ボタンの下の領域 */
  area: Rect
  /** 基準の文字の大きさ（`fonts.row`） */
  font: number
  person: StatusPerson
  /** 定義側の追加行（`statusByParty`）。無ければ領域を出さない */
  extraRows?: readonly StatusRow[]
  /** 最下段の帯の行（経験値・次のレベルまで等）。無ければ帯を出さず高さも取らない */
  bandRows?: readonly StatusRow[]
}

/** 本体の窓（primary）から、前・次ボタンの下の領域を切り出す */
export function statusArea(primary: Rect, baseH: number): Rect {
  const top = 0.1 * baseH
  const pad = 0.015 * baseH
  return {
    x: primary.x + pad,
    y: primary.y + top,
    w: primary.w - pad * 2,
    h: primary.h - top - pad,
  }
}

const num = (v: number | undefined): string => (v === undefined ? '--' : String(v))

/** 文字数から見積もる幅（全角 = 1 em、半角 = 0.55 em） */
export function emWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) < 0x100 ? 0.55 : 1
  return w
}

/** ラベルと値が枠に収まる文字の大きさ。収まるなら size のまま。`min` を下回らない */
export function fitSize(
  size: number,
  width: number,
  label: string,
  value: string,
  min = 1
): number {
  const need = emWidth(label) + emWidth(value) + 1
  return need * size <= width ? size : Math.max(min, Math.floor(width / need))
}

/** 項目名と値の最低の隙間（文字の大きさに対する比） */
export const STATUS_MIN_GAP_RATIO = 0.5

/**
 * 項目名と値を 1 つの枠に収める大きさ。まず共通の大きさ（`fitSize`、下限 `min`）で収め、下限でも入らないときは
 * 値を下限に止めたまま項目名を詰めて、最低の隙間（`STATUS_MIN_GAP_RATIO`）を残す。項目名を詰めても入らなければ、
 * 下限の 0.75 倍まで値も詰める。
 */
export function fitPair(
  size: number,
  width: number,
  label: string,
  value: string,
  min: number
): { labelSize: number; valueSize: number } {
  const s = fitSize(size, width, label, value, min)
  const lw = emWidth(label)
  const vw = emWidth(value)
  if ((lw + vw + 1) * s <= width) return { labelSize: s, valueSize: s }
  const hard = min * 0.75
  const gap = s * STATUS_MIN_GAP_RATIO
  const labelSize = Math.max(hard, Math.min(s, (width - gap - vw * s) / Math.max(lw, 1e-6)))
  if (lw * labelSize + vw * s + gap <= width + 1e-6) return { labelSize, valueSize: s }
  const valueSize = Math.max(hard, (width - gap - lw * labelSize) / Math.max(vw, 1e-6))
  return { labelSize, valueSize: Math.min(s, valueSize) }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** 人物の絵の置き場所。足元 (x, y) と絵の高さ。`frame` はアクスタの板・台座まで含めた外枠（アクスタ表示のときだけ） */
export interface PortraitFit {
  height: number
  x: number
  y: number
  frame: Rect | null
}

/**
 * メニュー（パーティ枠・ステータス画面）の人物の絵の URL (#1211)。`sprite` を優先し、無ければ戦闘の待機ポーズ `poses.idle`、
 * どちらも無ければ undefined（絵なしで枠だけ）。`人物:`/`形態:` で定義された人物は、形態から導いた `poses` だけを持ち
 * `sprite` は持たない（手書きの絵を導出で置き換えるため）ので、`poses.idle` が絵になる。空文字は無いものとして扱う。
 */
export function menuPortraitUrl(m: {
  sprite?: string
  poses?: { idle?: string }
}): string | undefined {
  return m.sprite || m.poses?.idle || undefined
}

/**
 * 人物の絵（テクスチャ寸法 texW x texH）を枠 R に収める。
 * 通常は枠の高さの 88%・幅の 90% 以内。アクスタ表示（`acrylic`）では板・台座を含む外枠（正方形）が枠に収まるよう、
 * 絵の高さを `fitAcrylicGeometry` の比率で縮める（台座が枠の下端や隣の領域にはみ出さない。斜めの影は描画側のクリップで止める）。
 */
export function fitPortrait(R: Rect, texW: number, texH: number, acrylic: boolean): PortraitFit {
  const cx = R.x + R.w / 2
  const plain = (): PortraitFit => {
    const byWidth = texW > 0 ? ((R.w * 0.9) / texW) * texH : 0
    return { height: Math.min(R.h * 0.88, byWidth), x: cx, y: R.y + R.h * 0.95, frame: null }
  }
  if (!acrylic) return plain()
  const fit = fitAcrylicGeometry(texW, texH, 100, DEFAULT_ACRYLIC_PARAMS)
  if (!fit) return plain()
  const g = fit.geometry
  // 外枠の一辺 side が枠に収まる倍率 sc。足元から外枠の下端までは (size - 絵の下端) × sc
  const side = Math.min(R.w, R.h) * 0.94
  const sc = side / fit.size
  const belowFoot = (fit.size - (g.sprite.y + g.sprite.height)) * sc
  const frame: Rect = { x: cx - side / 2, y: R.y + R.h - R.h * 0.03 - side, w: side, h: side }
  return { height: g.sprite.height * sc, x: cx, y: frame.y + side - belowFoot, frame }
}

interface Metrics {
  rowH: number
  vRow: number
  idH: number
  g: number
  pad: number
}

export function computeStatusLayout(i: StatusLayoutInput): StatusRegion[] {
  const { area: A, font: f, person: p } = i
  const extras = i.extraRows ?? []
  const bandRows = i.bandRows ?? []
  const minSize = f * STATUS_MIN_FONT_RATIO
  const out: StatusRegion[] = []

  const stats = [
    { label: 'ちから', value: num(p.atk) },
    { label: 'まもり', value: num(p.def) },
    { label: 'すばやさ', value: num(p.agi) },
  ]
  const statRowN = Math.ceil(stats.length / 2)
  const vit: { label: string; cur: string; max: string }[] = [
    { label: 'HP', cur: String(p.hp), max: String(p.maxHp) },
  ]
  if (p.mp !== undefined) vit.push({ label: 'MP', cur: String(p.mp), max: String(p.maxMp ?? p.mp) })
  // 帯は 2 列（経験値と次のレベルまでを 1 行に並べる）
  const bandCols = bandRows.length >= 2 ? 2 : 1
  const bandRowN = Math.ceil(bandRows.length / bandCols)

  // 入る大きさを、ゆったり → 詰めた順に探す（文字は下限まで）。それでも入らなければ追加行の列を増やす
  const metricsAt = (t: number): Metrics => ({
    rowH: lerp(minSize / 0.72, f * 1.5, t),
    vRow: lerp(f * 1.55, f * 2.1, t),
    idH: lerp(f * 1.5, f * 1.9, t),
    g: lerp(f * 0.2, f * 0.4, t),
    pad: lerp(f * 0.2, f * 0.3, t),
  })
  const total = (m: Metrics, extraRowN: number): number => {
    const band = bandRowN > 0 ? bandRowN * m.rowH + m.pad * 2 + m.g : 0
    return (
      band +
      m.idH +
      m.g +
      (vit.length * m.vRow + m.pad * 2) +
      m.g +
      (statRowN * m.rowH + m.pad * 2) +
      (extraRowN > 0 ? m.g + extraRowN * m.rowH + m.pad * 2 : 0)
    )
  }
  let extraCols = extras.length <= 2 ? 1 : 2
  let m = metricsAt(0)
  for (;;) {
    const extraRowN = Math.ceil(extras.length / extraCols)
    let found: Metrics | null = null
    for (let s = 10; s >= 0; s--) {
      const cand = metricsAt(s / 10)
      if (total(cand, extraRowN) <= A.h + 1e-6) {
        found = cand
        break
      }
    }
    if (found) {
      m = found
      break
    }
    if (extraCols >= 3) break // これ以上は詰められない（下限のまま）
    extraCols++
  }
  const { rowH, vRow, idH, g, pad } = m
  const extraRowN = Math.ceil(extras.length / extraCols)
  const tSize = Math.max(minSize, Math.min(f, rowH * 0.72))
  const colGap = f * 1.5

  // 最下段の帯（全幅）。行が無ければ出さない
  let bandH = 0
  if (bandRows.length > 0) {
    bandH = bandRowN * rowH + pad * 2
    const rect: Rect = { x: A.x, y: A.y + A.h - bandH, w: A.w, h: bandH }
    out.push({
      id: 'band',
      rect,
      cells: gridCells(bandRows, rect, pad, rowH, bandCols, colGap, tSize, minSize),
    })
  }
  const mainH = A.h - (bandH > 0 ? bandH + g : 0)

  // 左: 人物の絵の枠（縦長）
  const leftW = A.w * 0.3
  out.push({ id: 'portrait', rect: { x: A.x, y: A.y, w: leftW, h: mainH }, cells: [] })

  // 右: 上から identity / vitals / stats / extras
  const rx = A.x + leftW + g
  const rw = A.w - leftW - g
  let y = A.y

  const idCell: Rect = { x: rx + pad, y, w: rw - pad * 2, h: idH }
  const lv = p.level === undefined ? 'Lv --' : `Lv ${p.level}`
  // 名前と Lv は独立に大きさを決める（長い名前を縮めても Lv は縮めない）
  const idSize = Math.min(f, idH * 0.62)
  const nameW = idCell.w - emWidth(lv) * idSize - idSize
  out.push({
    id: 'identity',
    rect: { x: rx, y, w: rw, h: idH },
    cells: [
      {
        label: p.name,
        value: lv,
        rect: idCell,
        labelSize: fitSize(idSize, nameW, p.name, '', minSize),
        valueSize: idSize,
        tone: 'name',
      },
    ],
  })
  y += idH + g

  // HP・MP: 現在値・「/」・最大値を別々の位置に右揃え。桁数は HP と MP の長いほうに合わせる
  const bigSize = vRow / 1.4
  const dw = bigSize * 0.55
  const maxDigits = Math.max(...vit.map((r) => r.max.length))
  const vH = vit.length * vRow + pad * 2
  out.push({
    id: 'vitals',
    rect: { x: rx, y, w: rw, h: vH },
    cells: vit.map((r, k) => {
      const cell: Rect = { x: rx + pad, y: y + pad + k * vRow, w: rw - pad * 2, h: vRow }
      const maxRight = cell.x + cell.w
      const slashX = maxRight - maxDigits * dw - dw
      return {
        label: r.label,
        value: `${r.cur} / ${r.max}`,
        rect: cell,
        labelSize: Math.min(f, bigSize),
        valueSize: bigSize,
        tone: 'label',
        pair: { cur: r.cur, max: r.max, curRight: slashX - dw, slashX, maxRight },
      }
    }),
  })
  y += vH + g

  // 能力値の 2 列の表（数字はラベル寄り）と追加行
  const sH = statRowN * rowH + pad * 2
  const sRect: Rect = { x: rx, y, w: rw, h: sH }
  out.push({
    id: 'stats',
    rect: sRect,
    cells: gridCells(stats, sRect, pad, rowH, 2, colGap, tSize, minSize, true),
  })
  y += sH + g

  if (extras.length > 0) {
    const eH = extraRowN * rowH + pad * 2
    const eRect: Rect = { x: rx, y, w: rw, h: eH }
    out.push({
      id: 'extras',
      rect: eRect,
      cells: gridCells(extras, eRect, pad, rowH, extraCols, colGap, tSize, minSize),
    })
  }
  return out
}

/**
 * 領域の中に行を cols 列の表として並べる（行優先）。値は各列の右端に右揃え。
 * `near` のとき値をラベル寄り（最も長いラベルの直後）に置く（能力値の表）。
 */
function gridCells(
  rows: readonly StatusRow[],
  R: Rect,
  pad: number,
  rowH: number,
  cols: number,
  colGap: number,
  size: number,
  minSize: number,
  near = false
): StatusCell[] {
  const colW = (R.w - pad * 2 + colGap) / cols
  const labelW = near ? Math.max(...rows.map((r) => emWidth(r.label))) * size : 0
  const valueW = near ? Math.max(...rows.map((r) => emWidth(r.value))) * size : 0
  return rows.map((r, k) => {
    const cell: Rect = {
      x: R.x + pad + (k % cols) * colW,
      y: R.y + pad + Math.floor(k / cols) * rowH,
      w: colW - colGap,
      h: rowH,
    }
    const valueRight = near
      ? Math.min(cell.x + cell.w, cell.x + labelW + size * 0.8 + valueW)
      : undefined
    const fit = fitPair(size, cell.w, r.label, r.value, minSize)
    return {
      label: r.label,
      value: r.value,
      rect: cell,
      labelSize: fit.labelSize,
      valueSize: fit.valueSize,
      tone: 'label',
      ...(valueRight !== undefined ? { valueRight } : {}),
    }
  })
}
