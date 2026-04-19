// MapEditor の高さ編集タブ統合テスト（Issue #91 レビュー M4/リサイズ動作確認用）。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MapEditor from './MapEditor'
import { MapData, RPGProject, TileType } from '../types/rpg'

// RPGPlayer は重いので mock（プレビューは開かない前提）
vi.mock('./RPGPlayer', () => ({
  default: () => null,
}))

function makeMap(width = 3, height = 2): MapData {
  return {
    width,
    height,
    tileSize: 16,
    tiles: Array.from({ length: height }, () =>
      Array.from({ length: width }, () => TileType.GRASS)
    ),
  }
}

function makeProject(map: MapData): RPGProject {
  return {
    name: 'test',
    version: '1.0.0',
    map,
    player: { x: 0, y: 0, direction: 'down' },
    npcs: [],
    view: 'topdown',
  }
}

describe('MapEditor 高さ編集タブ', () => {
  it('タブを wallHeights に切替えるだけでは onChange が呼ばれない（M4: タブ open 副作用廃止）', () => {
    const map = makeMap()
    const project = makeProject(map)
    const onChange = vi.fn()
    render(<MapEditor mapData={map} rpgProject={project} onChange={onChange} isDark={false} />)

    fireEvent.click(screen.getByRole('button', { name: '壁高さ' }))

    expect(onChange).not.toHaveBeenCalled()
  })

  it('wallHeights タブでセルを mousedown すると onChange が wallHeights を含んで発火する', () => {
    const map = makeMap(3, 2)
    const project = makeProject(map)
    const onChange = vi.fn()
    render(<MapEditor mapData={map} rpgProject={project} onChange={onChange} isDark={false} />)

    // 壁高さタブに切替（ここでは onChange は発火しない）
    fireEvent.click(screen.getByRole('button', { name: '壁高さ' }))
    expect(onChange).not.toHaveBeenCalled()

    // セル (1, 0) を mousedown（イベントデリゲーションのため親にバブリング）
    const cell = document.querySelector('[data-cell-x="1"][data-cell-y="0"]') as HTMLElement | null
    expect(cell).not.toBeNull()
    fireEvent.mouseDown(cell!)

    expect(onChange).toHaveBeenCalledTimes(1)
    const arg = onChange.mock.calls[0][0] as MapData
    expect(arg.wallHeights).toBeDefined()
    expect(arg.wallHeights!.length).toBe(2)
    expect(arg.wallHeights![0].length).toBe(3)
    // パレットのデフォルト選択値（wallHeights fallback = 1.0）が塗られている
    expect(arg.wallHeights![0][1]).toBe(1)
  })

  it('mapData.width を変えた mapData を再 render すると既存 wallHeights がリサイズされて onChange 発火', () => {
    // 3x2 + 既存 wallHeights の mapData を初回 render
    const initial: MapData = {
      ...makeMap(3, 2),
      wallHeights: [
        [0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
      ],
    }
    const project = makeProject(initial)
    const onChange = vi.fn()
    const { rerender } = render(
      <MapEditor mapData={initial} rpgProject={project} onChange={onChange} isDark={false} />
    )

    // 初回 mount でリサイズ不要のため onChange は呼ばれない
    expect(onChange).not.toHaveBeenCalled()

    // width を 4 に拡大した mapData で再 render
    const resized: MapData = {
      ...initial,
      width: 4,
      tiles: [
        [TileType.GRASS, TileType.GRASS, TileType.GRASS, TileType.GRASS],
        [TileType.GRASS, TileType.GRASS, TileType.GRASS, TileType.GRASS],
      ],
      // wallHeights はまだ 3 幅のまま
    }
    rerender(
      <MapEditor mapData={resized} rpgProject={project} onChange={onChange} isDark={false} />
    )

    // useEffect でリサイズが走り、onChange が 4 幅の wallHeights で呼ばれる
    expect(onChange).toHaveBeenCalledTimes(1)
    const arg = onChange.mock.calls[0][0] as MapData
    expect(arg.wallHeights).toBeDefined()
    expect(arg.wallHeights!.length).toBe(2)
    expect(arg.wallHeights![0].length).toBe(4)
    // 既存値 0.5 は保持、拡大部分は fallback (1.0)
    expect(arg.wallHeights![0].slice(0, 3)).toEqual([0.5, 0.5, 0.5])
    expect(arg.wallHeights![0][3]).toBe(1)
  })
})
