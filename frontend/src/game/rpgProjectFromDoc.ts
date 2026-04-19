import type { EventDocument, Event, SceneView } from '../types'
import type { RPGProject, MapData, NPCData, PlayerData } from '../types/rpg'

/**
 * Document から RPGProject を導出する。
 *
 * - 最初に RpgMap を含むシーンを探す（sceneId 指定があればそれを優先）
 * - そのシーンから RpgMap / PlayerStart / Npc を抽出して RPGProject を組み立てる
 * - マップが無ければ null を返す
 */
export function rpgProjectFromDoc(
  doc: EventDocument,
  sceneId?: string,
  projectName = 'rpg-project'
): RPGProject | null {
  const targetScene = findRpgScene(doc, sceneId)
  if (!targetScene) return null

  let map: MapData | null = null
  let player: PlayerData | null = null
  const npcs: NPCData[] = []
  const view: 'topdown' | 'raycast' = targetScene.view === 'Raycast' ? 'raycast' : 'topdown'

  for (const ev of targetScene.events) {
    if (typeof ev === 'string') continue
    if ('RpgMap' in ev) {
      // Issue #90: Markdown の `[壁高さ]` / `[床高さ]` / `[天井高さ]` ブロックを
      // MapData の wallHeights / floorHeights / ceilingHeights に詰め替える。
      // parser.ts 側で null 正規化済みなので、null→undefined に落とす。
      map = {
        width: ev.RpgMap.width,
        height: ev.RpgMap.height,
        tileSize: ev.RpgMap.tile_size,
        tiles: ev.RpgMap.tiles.map((row) => [...row]),
        wallHeights: ev.RpgMap.wall_heights
          ? ev.RpgMap.wall_heights.map((row) => [...row])
          : undefined,
        floorHeights: ev.RpgMap.floor_heights
          ? ev.RpgMap.floor_heights.map((row) => [...row])
          : undefined,
        ceilingHeights: ev.RpgMap.ceiling_heights
          ? ev.RpgMap.ceiling_heights.map((row) => [...row])
          : undefined,
      }
    } else if ('PlayerStart' in ev) {
      player = {
        x: ev.PlayerStart.x,
        y: ev.PlayerStart.y,
        direction: directionToLower(ev.PlayerStart.direction),
      }
    } else if ('Npc' in ev) {
      npcs.push({
        id: ev.Npc.id,
        name: ev.Npc.name,
        x: ev.Npc.x,
        y: ev.Npc.y,
        color: ev.Npc.color,
        message: ev.Npc.message.join('\n'),
        sprite: ev.Npc.sprite,
        frames: ev.Npc.frames,
        direction: ev.Npc.direction ? directionToLower(ev.Npc.direction) : undefined,
      })
    }
  }

  if (!map) return null

  return {
    name: projectName,
    version: '1.0.0',
    map,
    player: player ?? { x: 0, y: 0, direction: 'down' },
    npcs,
    view,
  }
}

/**
 * RpgMap イベントを含むシーンを探す。
 *
 * - sceneId 指定がある場合: その id を持つシーンのみを探す。
 *   該当シーンが RpgMap を持たなければ null を返す（= 先頭フォールバックは行わない）。
 * - sceneId 未指定の場合: 先頭から走査して最初にマップを持つシーンを返す。
 */
function findRpgScene(
  doc: EventDocument,
  sceneId?: string
): {
  chapterIndex: number
  sceneIndex: number
  events: Event[]
  view: SceneView
} | null {
  for (let ci = 0; ci < doc.chapters.length; ci++) {
    const chapter = doc.chapters[ci]
    for (let si = 0; si < chapter.scenes.length; si++) {
      const scene = chapter.scenes[si]
      if (sceneId !== undefined) {
        if (scene.id !== sceneId) continue
      }
      const hasMap = scene.events.some((e) => typeof e !== 'string' && 'RpgMap' in e)
      if (hasMap) {
        return {
          chapterIndex: ci,
          sceneIndex: si,
          events: scene.events,
          view: scene.view ?? 'TopDown',
        }
      }
    }
  }
  return null
}

/**
 * Document 内で最初にマップを含むシーンのインデックスを返す。
 * 書き戻し用。無ければ null。
 */
export function findRpgSceneIndex(
  doc: EventDocument,
  sceneId?: string
): { chapterIndex: number; sceneIndex: number } | null {
  const found = findRpgScene(doc, sceneId)
  if (!found) return null
  return { chapterIndex: found.chapterIndex, sceneIndex: found.sceneIndex }
}

/**
 * エディタのシーン選択ドロップダウン等で使う RPG シーン要約。
 */
export type RpgSceneSummary = {
  chapterIndex: number
  sceneIndex: number
  id: string
  title: string
  view: 'topdown' | 'raycast'
}

/**
 * Document 内のすべての RPG シーン（RpgMap を含むシーン）を列挙する。
 * エディタのシーン選択ドロップダウン等に使う。
 */
export function findAllRpgScenes(doc: EventDocument): RpgSceneSummary[] {
  const result: RpgSceneSummary[] = []
  for (let ci = 0; ci < doc.chapters.length; ci++) {
    const chapter = doc.chapters[ci]
    for (let si = 0; si < chapter.scenes.length; si++) {
      const scene = chapter.scenes[si]
      const hasMap = scene.events.some((e) => typeof e !== 'string' && 'RpgMap' in e)
      if (!hasMap) continue
      result.push({
        chapterIndex: ci,
        sceneIndex: si,
        id: scene.id,
        title: scene.title,
        view: scene.view === 'Raycast' ? 'raycast' : 'topdown',
      })
    }
  }
  return result
}

function directionToLower(d: 'Up' | 'Down' | 'Left' | 'Right'): 'up' | 'down' | 'left' | 'right' {
  switch (d) {
    case 'Up':
      return 'up'
    case 'Down':
      return 'down'
    case 'Left':
      return 'left'
    case 'Right':
      return 'right'
  }
}

function directionToUpper(d: 'up' | 'down' | 'left' | 'right'): 'Up' | 'Down' | 'Left' | 'Right' {
  switch (d) {
    case 'up':
      return 'Up'
    case 'down':
      return 'Down'
    case 'left':
      return 'Left'
    case 'right':
      return 'Right'
  }
}

/**
 * RPGProject の変更を Document に書き戻す。
 * 指定シーンの events[] から既存の RpgMap / PlayerStart / Npc をすべて除去し、
 * 現在の rpgProject の内容で置き換える。ノベル要素（Dialog など）はそのまま保持。
 * 対象シーンが存在しない場合、先頭章に新しいシーンを追加する。
 */
export function applyRpgProjectToDoc(
  doc: EventDocument,
  project: RPGProject,
  sceneId: string = 'rpg-map'
): EventDocument {
  const existing = findRpgSceneIndex(doc, sceneId) ?? findRpgSceneIndex(doc)

  const rpgEvents: Event[] = [
    {
      RpgMap: {
        width: project.map.width,
        height: project.map.height,
        tile_size: project.map.tileSize,
        tiles: project.map.tiles.map((row) => [...row]),
        // Issue #90: MapData の高さ配列を Markdown 側に書き戻せるよう Event にも含める。
        wall_heights: project.map.wallHeights
          ? project.map.wallHeights.map((row) => [...row])
          : null,
        floor_heights: project.map.floorHeights
          ? project.map.floorHeights.map((row) => [...row])
          : null,
        ceiling_heights: project.map.ceilingHeights
          ? project.map.ceilingHeights.map((row) => [...row])
          : null,
      },
    },
    {
      PlayerStart: {
        x: project.player.x,
        y: project.player.y,
        direction: directionToUpper(project.player.direction),
      },
    },
    ...project.npcs.map(
      (npc): Event => ({
        Npc: {
          id: npc.id,
          name: npc.name,
          x: npc.x,
          y: npc.y,
          color: npc.color,
          message: npc.message.split('\n'),
          sprite: npc.sprite,
          frames: npc.frames,
          direction: npc.direction ? directionToUpper(npc.direction) : undefined,
        },
      })
    ),
  ]

  const projectView: SceneView = project.view === 'raycast' ? 'Raycast' : 'TopDown'

  const newChapters = doc.chapters.map((chapter, ci) => ({
    ...chapter,
    scenes: chapter.scenes.map((scene, si) => {
      if (existing && ci === existing.chapterIndex && si === existing.sceneIndex) {
        // RpgMap / PlayerStart / Npc 以外のイベントはそのまま保持
        const preserved = scene.events.filter(
          (e) =>
            typeof e === 'string' || (!('RpgMap' in e) && !('PlayerStart' in e) && !('Npc' in e))
        )
        return {
          ...scene,
          view: projectView,
          events: [...rpgEvents, ...preserved],
        }
      }
      return scene
    }),
  }))

  // 対象シーンが存在しない場合、先頭章に新しいシーンを追加
  if (!existing) {
    if (newChapters.length === 0) {
      return {
        ...doc,
        chapters: [
          {
            number: 1,
            title: '',
            hidden: false,
            default_bgm: null,
            scenes: [
              {
                id: sceneId,
                title: 'RPG マップ',
                view: projectView,
                events: rpgEvents,
              },
            ],
          },
        ],
      }
    }
    const first = newChapters[0]
    return {
      ...doc,
      chapters: [
        {
          ...first,
          scenes: [
            ...first.scenes,
            {
              id: sceneId,
              title: 'RPG マップ',
              view: projectView,
              events: rpgEvents,
            },
          ],
        },
        ...newChapters.slice(1),
      ],
    }
  }

  return { ...doc, chapters: newChapters }
}
