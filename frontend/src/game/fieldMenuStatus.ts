/**
 * フィールドメニューのステータス画面の配置 (#1191)。純粋関数だけ（PixiJS に触れない）。
 * `field_menu_status_layout: ff` のとき、FF5・FF6 のように領域に分けて並べる（左に人物の絵の枠、右に
 * 名前・Lv / HP・MP の大きな数字 / 能力値の 2 列の表 / 定義側の追加行、最下段に全幅の帯）。
 *
 * 領域は `StatusRegion`（id・矩形・中の項目）の配列で返す。描画側は領域を順に描くだけなので、
 * 項目を足す (#1186: 固有素質・装備・想像の刃・経験値・次のレベルまで) ときは、この関数の
 * 入力（`extraRows`・`bandRows`）に行を渡すか、領域を 1 つ（id・矩形・項目）ここに足すだけで済む。
 */
import type { Rect } from './fieldMenu'
import type { StatusRow } from './fieldMenuScreens'

/** ステータス画面の配置。`line` = 従来（左揃えの 1 列）、`ff` = 領域に分けた配置 */
export type StatusLayoutKind = 'line' | 'ff'
export const STATUS_LAYOUT_KINDS: readonly StatusLayoutKind[] = ['line', 'ff']

export type StatusRegionId = 'portrait' | 'identity' | 'vitals' | 'stats' | 'extras' | 'band'

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
function emWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) < 0x100 ? 0.55 : 1
  return w
}

/** ラベルと値が枠に収まる文字の大きさ。収まるなら size のまま */
export function fitSize(size: number, width: number, label: string, value: string): number {
  const need = emWidth(label) + emWidth(value) + 1
  return need * size <= width ? size : Math.max(1, Math.floor(width / need))
}

export function computeStatusLayout(i: StatusLayoutInput): StatusRegion[] {
  const { area: A, font: f, person: p } = i
  const extras = i.extraRows ?? []
  const bandRows = i.bandRows ?? []
  const g = f * 0.4
  const pad = f * 0.3
  const rowH = f * 1.5
  const big = f * 1.5
  const out: StatusRegion[] = []

  // 最下段の帯（全幅）。行が無ければ出さない
  let bandH = 0
  if (bandRows.length > 0) {
    bandH = Math.min(A.h * 0.3, bandRows.length * rowH + pad * 2)
    const rect: Rect = { x: A.x, y: A.y + A.h - bandH, w: A.w, h: bandH }
    const bh = (bandH - pad * 2) / bandRows.length
    out.push({
      id: 'band',
      rect,
      cells: bandRows.map((r, k) => {
        const cell: Rect = { x: rect.x + pad, y: rect.y + pad + k * bh, w: rect.w - pad * 2, h: bh }
        const size = Math.min(f, bh * 0.72)
        return {
          label: r.label,
          value: r.value,
          rect: cell,
          labelSize: size,
          valueSize: fitSize(size, cell.w, r.label, r.value),
          tone: 'label',
        }
      }),
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

  const idH = f * 1.9
  const idRect: Rect = { x: rx, y, w: rw, h: idH }
  const idCell: Rect = { x: rx + pad, y, w: rw - pad * 2, h: idH }
  const lv = p.level === undefined ? 'Lv --' : `Lv ${p.level}`
  out.push({
    id: 'identity',
    rect: idRect,
    cells: [
      {
        label: p.name,
        value: lv,
        rect: idCell,
        labelSize: fitSize(f, idCell.w, p.name, lv),
        valueSize: fitSize(f, idCell.w, p.name, lv),
        tone: 'name',
      },
    ],
  })
  y += idH + g

  const vit: { label: string; value: string }[] = [{ label: 'HP', value: `${p.hp} / ${p.maxHp}` }]
  if (p.mp !== undefined) vit.push({ label: 'MP', value: `${p.mp} / ${p.maxMp ?? p.mp}` })
  const vRow = big * 1.4
  const vH = vit.length * vRow + pad * 2
  const vRect: Rect = { x: rx, y, w: rw, h: vH }
  out.push({
    id: 'vitals',
    rect: vRect,
    cells: vit.map((r, k) => {
      const cell: Rect = { x: rx + pad, y: y + pad + k * vRow, w: rw - pad * 2, h: vRow }
      return {
        label: r.label,
        value: r.value,
        rect: cell,
        labelSize: f,
        valueSize: fitSize(big, cell.w - f * 2, '', r.value),
        tone: 'label',
      }
    }),
  })
  y += vH + g

  // 能力値の 2 列の表と追加行。残りの高さに収まるよう行の高さを詰める
  const stats = [
    { label: 'ちから', value: num(p.atk) },
    { label: 'まもり', value: num(p.def) },
    { label: 'すばやさ', value: num(p.agi) },
  ]
  const statRows = Math.ceil(stats.length / 2)
  const left = A.y + mainH - y
  const regionCount = extras.length > 0 ? 2 : 1
  const avail = left - pad * 2 * regionCount - (regionCount - 1) * g
  const tRow = Math.max(1, Math.min(rowH, avail / (statRows + extras.length)))
  const tSize = Math.min(f, tRow * 0.72)
  const sH = statRows * tRow + pad * 2
  out.push({
    id: 'stats',
    rect: { x: rx, y, w: rw, h: sH },
    cells: stats.map((r, k) => {
      const colGap = f * 1.5
      const colW = (rw - pad * 2 + colGap) / 2
      const cell: Rect = {
        x: rx + pad + (k % 2) * colW,
        y: y + pad + Math.floor(k / 2) * tRow,
        w: colW - colGap,
        h: tRow,
      }
      return {
        label: r.label,
        value: r.value,
        rect: cell,
        labelSize: tSize,
        valueSize: tSize,
        tone: 'label',
      }
    }),
  })
  y += sH + g

  if (extras.length > 0) {
    const eH = extras.length * tRow + pad * 2
    out.push({
      id: 'extras',
      rect: { x: rx, y, w: rw, h: eH },
      cells: extras.map((r, k) => {
        const cell: Rect = { x: rx + pad, y: y + pad + k * tRow, w: rw - pad * 2, h: tRow }
        return {
          label: r.label,
          value: r.value,
          rect: cell,
          labelSize: tSize,
          valueSize: fitSize(tSize, cell.w, r.label, r.value),
          tone: 'label',
        }
      }),
    })
  }
  return out
}
