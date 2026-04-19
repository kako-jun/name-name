// 高さ編集タブのグリッド描画。
// Issue #91。各セルは下地タイル色 + 他レイヤ半透明 + 現レイヤ不透明の三層構成。
import { memo, useEffect, useRef, useState } from 'react'
import { MapData, TILE_COLORS, TileType } from '../../types/rpg'
import {
  ensureHeightGrid,
  formatHeightLabel,
  HeightField,
  HEIGHT_FALLBACKS,
  HEIGHT_FIELDS,
  heightToBackgroundColor,
  heightToLabelColor,
} from './heightUtils'

interface HeightGridProps {
  mapData: MapData
  currentField: HeightField
  layerVisibility: Record<HeightField, boolean>
  onPaintCell: (x: number, y: number) => void
  isDark: boolean
}

function resolveCell(
  grid: number[][] | undefined,
  field: HeightField,
  x: number,
  y: number
): number {
  if (grid === undefined) return HEIGHT_FALLBACKS[field]
  const row = grid[y]
  if (row === undefined) return HEIGHT_FALLBACKS[field]
  const v = row[x]
  if (v === undefined) return HEIGHT_FALLBACKS[field]
  return v
}

// セル本体を React.memo で wrap することで、隣接セルだけが変わったときに
// 全セルの再 render を避ける。キー付き多層 absolute div の描画は軽くないため。
// - 他レイヤの値は field ごとに個別 prop として渡す（配列ではなくプリミティブで
//   shallow 比較が効くように）。表示されないレイヤは NaN を入れ、memo 内では
//   NaN === NaN を Number.isNaN 扱いで安定比較する。
interface HeightGridCellProps {
  x: number
  y: number
  tile: TileType
  currentField: HeightField
  currentValue: number
  currentColor: string
  wallValue: number // NaN なら非表示
  floorValue: number
  ceilingValue: number
  labelColor: string
  cellBorderClass: string
}

function cellPropsEqual(a: HeightGridCellProps, b: HeightGridCellProps): boolean {
  const numEq = (x: number, y: number) => x === y || (Number.isNaN(x) && Number.isNaN(y))
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.tile === b.tile &&
    a.currentField === b.currentField &&
    a.currentValue === b.currentValue &&
    a.currentColor === b.currentColor &&
    numEq(a.wallValue, b.wallValue) &&
    numEq(a.floorValue, b.floorValue) &&
    numEq(a.ceilingValue, b.ceilingValue) &&
    a.labelColor === b.labelColor &&
    a.cellBorderClass === b.cellBorderClass
  )
}

const HeightGridCell = memo(function HeightGridCell({
  x,
  y,
  tile,
  currentField,
  currentValue,
  currentColor,
  wallValue,
  floorValue,
  ceilingValue,
  labelColor,
  cellBorderClass,
}: HeightGridCellProps) {
  const tileColor = TILE_COLORS[tile]
  const otherEntries: Array<{ field: HeightField; value: number }> = []
  if (currentField !== 'wallHeights' && !Number.isNaN(wallValue)) {
    otherEntries.push({ field: 'wallHeights', value: wallValue })
  }
  if (currentField !== 'floorHeights' && !Number.isNaN(floorValue)) {
    otherEntries.push({ field: 'floorHeights', value: floorValue })
  }
  if (currentField !== 'ceilingHeights' && !Number.isNaN(ceilingValue)) {
    otherEntries.push({ field: 'ceilingHeights', value: ceilingValue })
  }
  return (
    <div
      data-cell-x={x}
      data-cell-y={y}
      className={`relative border ${cellBorderClass} cursor-pointer hover:opacity-90 transition-opacity overflow-hidden`}
      style={{ backgroundColor: tileColor }}
      title={`(${x}, ${y})=${formatHeightLabel(currentValue)}`}
    >
      {/* 他レイヤ（半透明） */}
      {otherEntries.map(({ field, value }) => (
        <div
          key={field}
          className="absolute inset-0"
          style={{
            backgroundColor: heightToBackgroundColor(field, value),
            opacity: 0.3,
            pointerEvents: 'none',
          }}
        />
      ))}
      {/* 現レイヤ（不透明寄り） */}
      <div
        className="absolute inset-0"
        style={{
          backgroundColor: currentColor,
          opacity: 0.85,
          pointerEvents: 'none',
        }}
      />
      {/* 数値ラベル */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          fontSize: '10px',
          color: labelColor,
          textShadow:
            '0 0 2px #000, 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000',
          fontWeight: 600,
        }}
      >
        {formatHeightLabel(currentValue)}
      </div>
    </div>
  )
}, cellPropsEqual)

function HeightGrid({
  mapData,
  currentField,
  layerVisibility,
  onPaintCell,
  isDark,
}: HeightGridProps) {
  const [isPainting, setIsPainting] = useState(false)
  // 直近で塗ったセルを覚えておき、同じセルに何度も onPaintCell を呼ばないようにする
  const lastPaintedRef = useRef<string | null>(null)

  // S1: window mouseup で isPainting を必ず false にする（セル外でボタンを離しても
  // drag 状態が残らないように）。
  useEffect(() => {
    const handleUp = () => {
      setIsPainting(false)
      lastPaintedRef.current = null
    }
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  // S2: イベントデリゲーション。親 div で onMouseDown/onMouseOver を受け、
  // e.target の data-cell-x / data-cell-y から座標を取り出す。
  const extractCoords = (target: EventTarget | null): { x: number; y: number } | null => {
    if (!(target instanceof Element)) return null
    const cell = target.closest('[data-cell-x]') as HTMLElement | null
    if (!cell) return null
    const xs = cell.getAttribute('data-cell-x')
    const ys = cell.getAttribute('data-cell-y')
    if (xs === null || ys === null) return null
    const x = Number(xs)
    const y = Number(ys)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  }

  const paintAt = (x: number, y: number) => {
    const key = `${x},${y}`
    if (lastPaintedRef.current === key) return
    lastPaintedRef.current = key
    onPaintCell(x, y)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    const coords = extractCoords(e.target)
    if (!coords) return
    setIsPainting(true)
    lastPaintedRef.current = null
    paintAt(coords.x, coords.y)
  }

  const handleMouseOver = (e: React.MouseEvent) => {
    if (!isPainting) return
    const coords = extractCoords(e.target)
    if (!coords) return
    paintAt(coords.x, coords.y)
  }

  // N2: 現タブで未初期化 (undefined) のフィールドも視覚表示のみ fallback で描く。
  // ペイント初回実行時に MapEditor の paintHeightCell が初期化してから塗るため、
  // onChange 経由で field が populated されるのは初回ペイント以降。
  const gridsByField: Record<HeightField, number[][]> = {
    wallHeights:
      mapData.wallHeights ?? ensureHeightGrid('wallHeights', mapData.width, mapData.height),
    floorHeights:
      mapData.floorHeights ?? ensureHeightGrid('floorHeights', mapData.width, mapData.height),
    ceilingHeights:
      mapData.ceilingHeights ?? ensureHeightGrid('ceilingHeights', mapData.width, mapData.height),
  }

  // 他レイヤ（layerVisibility が true で、現タブ以外のもの）
  const otherLayers = HEIGHT_FIELDS.filter((f) => f !== currentField && layerVisibility[f])

  const cellBorderClass = isDark ? 'border-gray-700' : 'border-gray-600'

  return (
    <div
      className={`border-2 ${isDark ? 'border-gray-500' : 'border-gray-400'}`}
      onMouseDown={handleMouseDown}
      onMouseOver={handleMouseOver}
      style={{
        display: 'grid',
        gridTemplateRows: `repeat(${mapData.height}, ${mapData.tileSize}px)`,
        gridTemplateColumns: `repeat(${mapData.width}, ${mapData.tileSize}px)`,
      }}
    >
      {mapData.tiles.map((row, y) =>
        row.map((tile, x) => {
          const currentValue = resolveCell(gridsByField[currentField], currentField, x, y)
          const currentColor = heightToBackgroundColor(currentField, currentValue)
          // 他レイヤの値は全フィールドぶん計算し、layerVisibility off のものは NaN を入れて
          // memo 内で「非表示」として扱う。NaN/プリミティブに展開しておくと shallow 比較が
          // 効くため、単一セル変更時に全セル再 render を回避できる。
          const wallValue = otherLayers.includes('wallHeights')
            ? resolveCell(gridsByField.wallHeights, 'wallHeights', x, y)
            : NaN
          const floorValue = otherLayers.includes('floorHeights')
            ? resolveCell(gridsByField.floorHeights, 'floorHeights', x, y)
            : NaN
          const ceilingValue = otherLayers.includes('ceilingHeights')
            ? resolveCell(gridsByField.ceilingHeights, 'ceilingHeights', x, y)
            : NaN
          const labelColor = heightToLabelColor(currentField, currentValue)
          return (
            <HeightGridCell
              key={y * mapData.width + x}
              x={x}
              y={y}
              tile={tile as TileType}
              currentField={currentField}
              currentValue={currentValue}
              currentColor={currentColor}
              wallValue={wallValue}
              floorValue={floorValue}
              ceilingValue={ceilingValue}
              labelColor={labelColor}
              cellBorderClass={cellBorderClass}
            />
          )
        })
      )}
    </div>
  )
}

export default HeightGrid
