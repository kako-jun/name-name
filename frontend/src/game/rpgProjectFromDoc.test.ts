import { describe, it, expect } from 'vitest'
import { rpgProjectFromDoc, applyRpgProjectToDoc, findAllRpgScenes } from './rpgProjectFromDoc'
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

describe('findAllRpgScenes', () => {
  it('単一 RPG シーンを列挙できる', () => {
    const list = findAllRpgScenes(makeDoc())
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('map-village')
    expect(list[0].title).toBe('村')
    expect(list[0].view).toBe('topdown')
    expect(list[0].chapterIndex).toBe(0)
    expect(list[0].sceneIndex).toBe(0)
  })

  it('複数章にまたがる RPG シーンを列挙できる', () => {
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'Ch1',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'village',
              title: '村',
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
            {
              id: 'intro',
              title: 'イントロ',
              view: 'TopDown',
              events: [{ Narration: { text: ['ノベル'] } }],
            },
          ],
        },
        {
          number: 2,
          title: 'Ch2',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'dungeon',
              title: 'ダンジョン',
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
    const list = findAllRpgScenes(doc)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('village')
    expect(list[0].view).toBe('topdown')
    expect(list[0].chapterIndex).toBe(0)
    expect(list[0].sceneIndex).toBe(0)
    expect(list[1].id).toBe('dungeon')
    expect(list[1].view).toBe('raycast')
    expect(list[1].chapterIndex).toBe(1)
    expect(list[1].sceneIndex).toBe(0)
  })

  it('RPG シーンが無ければ空配列', () => {
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
              events: [{ Narration: { text: ['novel only'] } }],
            },
          ],
        },
      ],
    }
    expect(findAllRpgScenes(doc)).toEqual([])
  })

  it('RpgMap を含まないシーン（view だけ指定されたノベルシーン等）は列挙されない', () => {
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
              id: 'novel-raycast',
              title: 'ノベルでも view=Raycast',
              view: 'Raycast',
              events: [{ Narration: { text: ['マップは無い'] } }],
            },
            {
              id: 'rpg',
              title: 'RPG',
              view: 'TopDown',
              events: [
                {
                  RpgMap: {
                    width: 1,
                    height: 1,
                    tile_size: 32,
                    tiles: [[0]],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const list = findAllRpgScenes(doc)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('rpg')
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
      view: 'topdown' as const,
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
      view: 'topdown' as const,
    }
    const updated = applyRpgProjectToDoc(doc, project, 'new-rpg-scene')
    expect(updated.chapters[0].scenes).toHaveLength(2)
    const newScene = updated.chapters[0].scenes[1]
    expect(newScene.id).toBe('new-rpg-scene')
    expect(newScene.events[0]).toHaveProperty('RpgMap')
  })

  it('同一章の非RPGシーンの view は書き換えられない', () => {
    // チャプター1内に「ノベルのみシーン (view=TopDown)」と「RPGシーン (view=Raycast)」が混在
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
              id: 'novel-only',
              title: 'ノベルのみ',
              view: 'TopDown',
              events: [{ Narration: { text: ['ノベルです'] } }],
            },
            {
              id: 'rpg-scene',
              title: 'RPG',
              view: 'Raycast',
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
    // RPGProject 側で view=topdown に変更
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
      view: 'topdown',
    }
    const updated = applyRpgProjectToDoc(doc, project, 'rpg-scene')
    // RPGシーン側は view が TopDown に書き換わる
    expect(updated.chapters[0].scenes[1].view).toBe('TopDown')
    // ノベル側シーンの view は TopDown のまま保持される（= 書き換えられない）
    expect(updated.chapters[0].scenes[0].view).toBe('TopDown')
    // ノベル側のイベントも保持される
    expect(updated.chapters[0].scenes[0].events).toHaveLength(1)
    expect(updated.chapters[0].scenes[0].events[0]).toHaveProperty('Narration')
  })

  it('章をまたぐ複数 RPG シーンで、対象シーン以外（マップ・view・NPC）を書き換えない', () => {
    // Ch1 に村シーン、Ch2 にダンジョンシーン（どちらも RpgMap を持つ）
    const doc: EventDocument = {
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'Ch1',
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
                    width: 2,
                    height: 1,
                    tile_size: 32,
                    tiles: [[0, 0]],
                  },
                },
                { PlayerStart: { x: 0, y: 0, direction: 'Down' } },
                {
                  Npc: {
                    id: 'elder',
                    name: '長老',
                    x: 1,
                    y: 0,
                    color: 0xff0000,
                    message: ['村のNPC'],
                  },
                },
              ],
            },
          ],
        },
        {
          number: 2,
          title: 'Ch2',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'map-dungeon',
              title: 'ダンジョン',
              view: 'Raycast',
              events: [
                {
                  RpgMap: {
                    width: 3,
                    height: 3,
                    tile_size: 32,
                    tiles: [
                      [2, 2, 2],
                      [2, 0, 2],
                      [2, 2, 2],
                    ],
                  },
                },
                { PlayerStart: { x: 1, y: 1, direction: 'Up' } },
                {
                  Npc: {
                    id: 'boss',
                    name: 'ボス',
                    x: 1,
                    y: 1,
                    color: 0x000000,
                    message: ['ダンジョンのNPC'],
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    // Ch1 村の rpgProject を書き戻す（view を raycast に変更、NPC 差し替え）
    const project: RPGProject = {
      name: 'test',
      version: '1.0.0',
      map: {
        width: 4,
        height: 1,
        tileSize: 32,
        tiles: [[1, 1, 1, 1]],
      },
      player: { x: 2, y: 0, direction: 'left' },
      npcs: [
        { id: 'new-villager', name: '新村人', x: 3, y: 0, color: 0x00ff00, message: 'updated' },
      ],
      view: 'raycast',
    }
    const updated = applyRpgProjectToDoc(doc, project, 'map-village')

    // Ch1 村の view が書き戻した値になっている
    expect(updated.chapters[0].scenes[0].view).toBe('Raycast')
    const villageEvents = updated.chapters[0].scenes[0].events
    expect(villageEvents[0]).toHaveProperty('RpgMap')
    if ('RpgMap' in villageEvents[0]) {
      expect(villageEvents[0].RpgMap.width).toBe(4)
      expect(villageEvents[0].RpgMap.tiles[0]).toEqual([1, 1, 1, 1])
    }
    // Ch1 村の NPC が差し替わっている
    const villageNpc = villageEvents.find(
      (e) => typeof e !== 'string' && 'Npc' in e
    )
    expect(villageNpc).toBeDefined()
    if (villageNpc && typeof villageNpc !== 'string' && 'Npc' in villageNpc) {
      expect(villageNpc.Npc.id).toBe('new-villager')
    }

    // Ch2 ダンジョンのマップ・view・NPC は無変更
    const dungeonScene = updated.chapters[1].scenes[0]
    expect(dungeonScene.id).toBe('map-dungeon')
    expect(dungeonScene.view).toBe('Raycast')
    const dungeonEvents = dungeonScene.events
    expect(dungeonEvents[0]).toHaveProperty('RpgMap')
    if ('RpgMap' in dungeonEvents[0]) {
      expect(dungeonEvents[0].RpgMap.width).toBe(3)
      expect(dungeonEvents[0].RpgMap.height).toBe(3)
      expect(dungeonEvents[0].RpgMap.tiles).toEqual([
        [2, 2, 2],
        [2, 0, 2],
        [2, 2, 2],
      ])
    }
    const dungeonNpc = dungeonEvents.find(
      (e) => typeof e !== 'string' && 'Npc' in e
    )
    expect(dungeonNpc).toBeDefined()
    if (dungeonNpc && typeof dungeonNpc !== 'string' && 'Npc' in dungeonNpc) {
      expect(dungeonNpc.Npc.id).toBe('boss')
      expect(dungeonNpc.Npc.name).toBe('ボス')
    }
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
