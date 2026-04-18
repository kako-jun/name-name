import { describe, it, expect } from 'vitest'
import { rpgProjectFromDoc, applyRpgProjectToDoc } from './rpgProjectFromDoc'
import type { EventDocument } from '../types'
import type { RPGProject } from '../types/rpg'

function makeDoc(): EventDocument {
  return {
    engine: 'name-name',
    chapters: [
      {
        number: 1,
        title: 'RPG',
        hidden: false,
        default_bgm: null,
        scenes: [
          {
            id: 'map-village',
            title: '村',
            view: 'TopDown',
            events: [
              {
                RpgMap: {
                  width: 3,
                  height: 2,
                  tile_size: 32,
                  tiles: [
                    [0, 1, 0],
                    [0, 0, 0],
                  ],
                },
              },
              { PlayerStart: { x: 1, y: 0, direction: 'Down' } },
              {
                Npc: {
                  id: 'elder',
                  name: '長老',
                  x: 2,
                  y: 1,
                  color: 0xff0000,
                  message: ['こんにちは', '旅人よ'],
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('rpgProjectFromDoc', () => {
  it('doc から RPGProject を導出できる', () => {
    const project = rpgProjectFromDoc(makeDoc())
    expect(project).not.toBeNull()
    expect(project!.map.width).toBe(3)
    expect(project!.map.height).toBe(2)
    expect(project!.map.tileSize).toBe(32)
    expect(project!.map.tiles[0]).toEqual([0, 1, 0])
    expect(project!.player).toEqual({ x: 1, y: 0, direction: 'down' })
    expect(project!.npcs).toHaveLength(1)
    expect(project!.npcs[0].id).toBe('elder')
    expect(project!.npcs[0].message).toBe('こんにちは\n旅人よ')
  })

  it('view=Raycast のシーンから RPGProject.view === raycast になる', () => {
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: '',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'rc',
              title: 'レイキャスト村',
              view: 'Raycast',
              events: [
                {
                  RpgMap: {
                    width: 2,
                    height: 2,
                    tile_size: 32,
                    tiles: [
                      [2, 2],
                      [2, 0],
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const project = rpgProjectFromDoc(doc)
    expect(project).not.toBeNull()
    expect(project!.view).toBe('raycast')
  })

  it('view=TopDown のシーンから RPGProject.view === topdown になる', () => {
    const project = rpgProjectFromDoc(makeDoc())
    expect(project!.view).toBe('topdown')
  })

  it('マップを含むシーンが無ければ null', () => {
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: '',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 's1',
              title: '',
              view: 'TopDown',
              events: [{ Narration: { text: ['only novel'] } }],
            },
          ],
        },
      ],
    }
    expect(rpgProjectFromDoc(doc)).toBeNull()
  })
})

describe('applyRpgProjectToDoc', () => {
  it('RPGProject を既存シーンに書き戻せる（ノベル要素は保持）', () => {
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: '',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'map-village',
              title: '村',
              view: 'TopDown',
              events: [
                // 既存の RPG 要素（置き換え対象）
                {
                  RpgMap: {
                    width: 2,
                    height: 2,
                    tile_size: 32,
                    tiles: [
                      [0, 0],
                      [0, 0],
                    ],
                  },
                },
                // ノベル要素（保持されるべき）
                { Narration: { text: ['ナレーションは保持'] } },
              ],
            },
          ],
        },
      ],
    }

    const project = {
      name: 'test',
      version: '1.0.0',
      map: {
        width: 3,
        height: 2,
        tileSize: 32,
        tiles: [
          [1, 1, 1],
          [0, 0, 0],
        ],
      },
      player: { x: 0, y: 0, direction: 'up' as const },
      npcs: [{ id: 'a', name: 'A', x: 1, y: 1, color: 0xff00ff, message: 'hi' }],
    }

    const updated = applyRpgProjectToDoc(doc, project, 'map-village')
    const events = updated.chapters[0].scenes[0].events
    // 先頭3つは RPG 要素
    expect(events[0]).toHaveProperty('RpgMap')
    expect(events[1]).toHaveProperty('PlayerStart')
    expect(events[2]).toHaveProperty('Npc')
    // 最後にナレーションが保持されている
    const lastEvent = events[events.length - 1]
    expect(lastEvent).toHaveProperty('Narration')
    // マップサイズ確認
    if ('RpgMap' in events[0]) {
      expect(events[0].RpgMap.width).toBe(3)
      expect(events[0].RpgMap.tiles[0]).toEqual([1, 1, 1])
    }
  })

  it('RPG シーンが存在しない doc に新シーンを追加できる', () => {
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: '',
          hidden: false,
          default_bgm: null,
          scenes: [{ id: 's1', title: '', view: 'TopDown', events: [] }],
        },
      ],
    }
    const project = {
      name: 'test',
      version: '1.0.0',
      map: {
        width: 2,
        height: 1,
        tileSize: 32,
        tiles: [[0, 0]],
      },
      player: { x: 0, y: 0, direction: 'down' as const },
      npcs: [],
    }
    const updated = applyRpgProjectToDoc(doc, project, 'new-rpg-scene')
    expect(updated.chapters[0].scenes).toHaveLength(2)
    const newScene = updated.chapters[0].scenes[1]
    expect(newScene.id).toBe('new-rpg-scene')
    expect(newScene.events[0]).toHaveProperty('RpgMap')
  })

  it('RPGProject.view=raycast を Doc の scene.view=Raycast に書き戻せる', () => {
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: '',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'rc',
              title: 'レイキャスト村',
              view: 'TopDown',
              events: [
                {
                  RpgMap: {
                    width: 2,
                    height: 1,
                    tile_size: 32,
                    tiles: [[0, 0]],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const project: RPGProject = {
      name: 'test',
      version: '1.0.0',
      map: {
        width: 2,
        height: 1,
        tileSize: 32,
        tiles: [[0, 0]],
      },
      player: { x: 0, y: 0, direction: 'down' },
      npcs: [],
      view: 'raycast',
    }
    const updated = applyRpgProjectToDoc(doc, project, 'rc')
    expect(updated.chapters[0].scenes[0].view).toBe('Raycast')
  })
})
