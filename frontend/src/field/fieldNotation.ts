/**
 * 一枚絵フィールドの記法の収集 (#1120 / 親 #1096 S3c)。
 *
 * parse 済みの複数 EventDocument から、フィールドを組むのに要る宣言を集める純関数。
 * IO・副作用なし(`mergeMasterDataFromDocs` が内部で出す既存の console.warn だけは別)。
 * 結果は docs の与え順に依存しない(エントリ md → path 昇順に整列してから走る)。
 *
 * ここは「集める」だけで、JSON 形(raw)への変換・検証は後段(buildFieldRaw / parseConfig)の仕事:
 * - 作品全体の設定(補助通行・フィールド設定・人物の形態・メニュー・メニュー項目・操作画像・通貨名・歩行絵)は
 *   全 md から集め、重複は先頭の md のものを採って警告する
 * - 場面ごとの中身は、エントリ場面から `[端]`/`[ワープ]` を辿って届く場面(到達閉包)の分だけ集める
 * - 閉包の外へ出る行き先は、場面があるが FieldMap を持たないもの → `exits`、docs に無いもの → `missingScenes`
 *   (どちらも警告にはしない。落とす・警告する判断は後段。missingScenes は追加ロードして再実行するための印)
 */
import type {
  CharacterFormsDecl,
  Event,
  EventCommand,
  EventDocument,
  EventScene,
  FieldAssistData,
  FieldEdgeData,
  FieldMapData,
  FieldMenuData,
  FieldMenuItemData,
  FieldSettingsData,
  FieldWalkSpriteData,
  FieldWarpData,
  NpcData,
  PlayerStartData,
  UiImagesData,
  Direction,
} from '../types'
import { collectFieldEvents, type FieldScriptEvents } from '../game/fieldScript'
import { mergeMasterDataFromDocs } from '../game/rpgProjectFromDoc'
import { safeAssign } from '../game/ownProperty'

/** 1 つの md。path は決定的な順序づけと警告文に使う */
export interface FieldSourceDoc {
  path: string
  doc: EventDocument
}

/** フィールドに入る位置(`[フィールド: 場面ID @x,y 向き=]` の中身)。x,y 省略 = その場面の [プレイヤー] */
export interface FieldEntry {
  sceneId: string
  x?: number
  y?: number
  /** `Direction`('Up'…)の小文字化('up'…)で渡す */
  facing?: 'up' | 'down' | 'left' | 'right'
}

export interface CollectFieldNotationInput {
  /** 読み込み済みの md 全部(hidden な data.md 相当も含む)。順序は問わない */
  docs: readonly FieldSourceDoc[]
  entryPath: string
  entry: FieldEntry
}

/** 到達閉包に入った場面 1 つ分の中身 */
export interface FieldSceneNotation {
  id: string
  title: string
  /** この場面を採った md */
  path: string
  map: FieldMapData
  playerStart?: PlayerStartData
  /** `[端]`(書いた順) */
  edges: FieldEdgeData[]
  /** `[揺れ:]` */
  shake?: { amplitude_y: number; period_ms?: number }
  /** `[窓の景色:]` */
  scroll?: { image: string; speed: number; y?: number }
  /** `[NPC]`(書いた順) */
  npcs: NpcData[]
}

export type FieldMasterData = ReturnType<typeof mergeMasterDataFromDocs>

/**
 * 注意: `scenes[].map`・`npcs`・`npcEvents` の commands などは入力 docs の参照を共有する(コピーしない)。
 * 後段(buildFieldRaw 等)は読み取りのみで、書き換えないこと。
 */
export interface FieldNotation {
  /** 整列後の先頭 doc(エントリ md があればそれ)。frontmatter(`battle_*` 等)の読み先 */
  entryDoc?: EventDocument
  entry: FieldEntry
  // 作品全体の設定(全 md から。無ければ undefined)
  assist?: FieldAssistData
  settings?: FieldSettingsData
  characterForms?: CharacterFormsDecl
  menu?: FieldMenuData
  /** `[メニュー項目]`(id ごとに先勝ち。優先順) */
  menuItems: FieldMenuItemData[]
  uiImages?: UiImagesData
  currency?: string
  playerWalk?: FieldWalkSpriteData
  companionWalk?: FieldWalkSpriteData
  /** 到達閉包に入った場面(優先順 = エントリ md → path 昇順 → md 内の出現順) */
  scenes: FieldSceneNotation[]
  /** `[ワープ]`(閉包の場面から。名前ごとに先勝ち。優先順) */
  warps: FieldWarpData[]
  /** マスター。同 ID は優先順の先頭(エントリ md が最優先)。キー順・partyOrder も優先順 */
  master: FieldMasterData
  /** `[フラグ:]` の名前(入れ子の条件の中も含む。全 md。優先順・重複なし) */
  flags: string[]
  /** 全 md の `[イベント]`(同名は優先順の先頭) */
  npcEvents: FieldScriptEvents
  /** 行き先として出たが FieldMap を持たない場面 ID(昇順・重複なし) */
  exits: string[]
  /** 行き先として出たが docs に無い場面 ID(昇順・重複なし) */
  missingScenes: string[]
}

export interface CollectFieldNotationResult {
  notation: FieldNotation
  warnings: string[]
}

const DIRECTION_FACING: Record<Direction, 'up' | 'down' | 'left' | 'right'> = {
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
}

/** Direction('Up'…)を FieldEntry.facing('up'…)にする。S3d/S3e が `[フィールド:]` から FieldEntry を作るときの補助 */
export function directionToFacing(d: Direction | undefined): FieldEntry['facing'] {
  return d === undefined ? undefined : DIRECTION_FACING[d]
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** エントリ md を先頭、残りを path 昇順(コード単位。ロケール非依存)に整える。同 path は中身の文字列順で決定的に並べて 2 つ目以降を捨てる */
function sortDocs(
  docs: readonly FieldSourceDoc[],
  entryPath: string,
  warnings: string[]
): FieldSourceDoc[] {
  // 同 path が無ければ path だけで順序が決まる。同 path があるときだけ中身の文字列で決める(JSON.stringify は重いので避ける)
  const pathsUnique = new Set(docs.map((d) => d.path)).size === docs.length
  const keyed = docs.map((d) => ({ d, json: pathsUnique ? '' : JSON.stringify(d.doc) }))
  keyed.sort((a, b) => {
    const ae = a.d.path === entryPath ? 0 : 1
    const be = b.d.path === entryPath ? 0 : 1
    return ae - be || cmp(a.d.path, b.d.path) || cmp(a.json, b.json)
  })
  const out: FieldSourceDoc[] = []
  const seen = new Set<string>()
  for (const { d } of keyed) {
    if (seen.has(d.path)) {
      warnings.push(`md '${d.path}' が複数渡されています。先頭のものを使い、残りは無視します`)
      continue
    }
    seen.add(d.path)
    out.push(d)
  }
  if (!seen.has(entryPath)) {
    warnings.push(`エントリの md '${entryPath}' が読み込まれていません`)
  }
  return out
}

interface Found<T> {
  path: string
  value: T
}

/** 先頭を採り、2 つ以上あれば警告する。無ければ undefined */
function firstWins<T>(label: string, found: Found<T>[], warnings: string[]): T | undefined {
  if (found.length === 0) return undefined
  if (found.length > 1)
    warnings.push(
      dupMessage(
        label,
        found.map((f) => f.path)
      )
    )
  return found[0].value
}

/** 重複の警告文。全部同じ md の中なら「同じ a.md の中で」、複数の md にまたがるなら path を並べる */
function dupMessage(label: string, paths: string[]): string {
  const unique = [...new Set(paths)]
  if (unique.length === 1) {
    return `同じ ${unique[0]} の中で ${label} が複数あります。先頭のものを使い、残りは無視します`
  }
  const rest = unique.slice(1)
  return `${label} が複数あります（${unique.join(' / ')}）。先頭の ${unique[0]} のものを使い、${rest.join(' / ')} のものは無視します`
}

/** Event を文字列 variant を除いて走査する(Condition の中は走査しない) */
function* objectEvents(scene: EventScene): Generator<Exclude<Event, string>> {
  for (const ev of scene.events) {
    if (typeof ev !== 'string') yield ev
  }
}

/** `Flag` の名前を入れ子の `Condition.events` も含めて集める */
function collectFlagNames(events: readonly Event[], out: string[]): void {
  for (const ev of events) {
    if (typeof ev === 'string') continue
    if ('Flag' in ev) out.push(ev.Flag.name)
    else if ('Condition' in ev) collectFlagNames(ev.Condition.events, out)
  }
}

/** マスターの種類(イベントのキー・記法名・ID の取り出し) */
const MASTER_KINDS: ReadonlyArray<{
  label: string
  record: keyof Omit<FieldMasterData, 'partyOrder'>
  id: (ev: Exclude<Event, string>) => string | undefined
}> = [
  {
    label: 'モンスター',
    record: 'monsters',
    id: (e) => ('Monster' in e ? e.Monster.id : undefined),
  },
  { label: 'アイテム', record: 'items', id: (e) => ('Item' in e ? e.Item.id : undefined) },
  { label: '呪文', record: 'spells', id: (e) => ('Spell' in e ? e.Spell.id : undefined) },
  { label: '特技', record: 'skills', id: (e) => ('Skill' in e ? e.Skill.id : undefined) },
  { label: '状態', record: 'statuses', id: (e) => ('Status' in e ? e.Status.id : undefined) },
  {
    label: '戦闘',
    record: 'battleScripts',
    id: (e) => ('BattleScript' in e ? e.BattleScript.id : undefined),
  },
  { label: '魔石', record: 'magicites', id: (e) => ('Magicite' in e ? e.Magicite.id : undefined) },
  { label: '召喚獣', record: 'summons', id: (e) => ('Summon' in e ? e.Summon.id : undefined) },
  { label: 'ジョブ', record: 'jobs', id: (e) => ('Job' in e ? e.Job.id : undefined) },
  {
    label: 'パーティ',
    record: 'party',
    id: (e) => ('PartyMember' in e ? e.PartyMember.id : undefined),
  },
]

function reorder<T>(rec: Record<string, T>, order: readonly string[]): Record<string, T> {
  const out: Record<string, T> = {}
  const seen = new Set<string>()
  for (const id of order) {
    if (seen.has(id) || !Object.prototype.hasOwnProperty.call(rec, id)) continue
    seen.add(id)
    safeAssign(out, id, rec[id])
  }
  for (const id of Object.keys(rec)) {
    if (!seen.has(id)) safeAssign(out, id, rec[id])
  }
  return out
}

/**
 * マスターを「エントリ md が最優先」で束ねる。
 * 既存の `mergeMasterDataFromDocs` は後ろの doc が勝つので、優先順の逆で渡して先頭を勝たせ、
 * キー順・partyOrder は優先順に直す。別の md に同じ ID があれば警告する(1 つの md 内の重複は既存の挙動のまま)。
 *
 * 注意: `mergeMasterDataFromDocs`(と内部の `collectMasterData`)は同 ID の重複時に console.warn を出す既存の副作用を持つ。
 * 文言は「後ろの宣言で上書きした」だが、本関数は逆順で渡すので実態(先頭の md が勝つ)と逆になり、自前の警告と二重にもなる。
 * 既存コードは触らない。抑制は S3d 以降で検討する。
 */
function collectMaster(sorted: readonly FieldSourceDoc[], warnings: string[]): FieldMasterData {
  const merged = mergeMasterDataFromDocs(sorted.map((s) => s.doc).reverse())
  const result = { ...merged } as FieldMasterData
  for (const kind of MASTER_KINDS) {
    const order: string[] = []
    const pathsById = new Map<string, string[]>()
    for (const { path, doc } of sorted) {
      const idsInDoc = new Set<string>()
      for (const chapter of doc.chapters) {
        for (const scene of chapter.scenes) {
          for (const ev of objectEvents(scene)) {
            const id = kind.id(ev)
            if (id !== undefined) idsInDoc.add(id)
          }
        }
      }
      for (const id of idsInDoc) {
        if (!pathsById.has(id)) {
          pathsById.set(id, [])
          order.push(id)
        }
        pathsById.get(id)!.push(path)
      }
    }
    for (const id of order) {
      const paths = pathsById.get(id)!
      if (paths.length > 1) {
        warnings.push(
          `[${kind.label} ${id}] が複数の md にあります（${paths.join(' / ')}）。先頭の ${paths[0]} のものを使います`
        )
      }
    }
    ;(result[kind.record] as Record<string, unknown>) = reorder(
      merged[kind.record] as Record<string, unknown>,
      order
    )
    if (kind.record === 'party')
      result.partyOrder = order.filter((id) => merged.party[id] !== undefined)
  }
  return result
}

interface SceneRef {
  /** 優先順での通し番号 */
  index: number
  path: string
  scene: EventScene
}

export function collectFieldNotation(input: CollectFieldNotationInput): CollectFieldNotationResult {
  const warnings: string[] = []
  const sorted = sortDocs(input.docs, input.entryPath, warnings)
  const entryDoc =
    sorted.length > 0 && sorted[0].path === input.entryPath ? sorted[0].doc : undefined

  // ---- 作品全体の設定(全 md・全場面から) ----
  const assist: Found<FieldAssistData>[] = []
  const settings: Found<FieldSettingsData>[] = []
  const characterForms: Found<CharacterFormsDecl>[] = []
  const menu: Found<FieldMenuData>[] = []
  const menuItems = new Map<string, Found<FieldMenuItemData>[]>()
  const uiImages: Found<UiImagesData>[] = []
  const currency: Found<string>[] = []
  const playerWalk: Found<FieldWalkSpriteData>[] = []
  const companionWalk: Found<FieldWalkSpriteData>[] = []
  const flagNames: string[] = []
  const allSceneRefs: SceneRef[] = []

  let sceneIndex = 0
  for (const { path, doc } of sorted) {
    for (const chapter of doc.chapters) {
      for (const scene of chapter.scenes) {
        allSceneRefs.push({ index: sceneIndex++, path, scene })
        collectFlagNames(scene.events, flagNames)
        for (const ev of objectEvents(scene)) {
          if ('FieldAssist' in ev) assist.push({ path, value: ev.FieldAssist })
          else if ('FieldSettings' in ev) settings.push({ path, value: ev.FieldSettings })
          else if ('CharacterForms' in ev) characterForms.push({ path, value: ev.CharacterForms })
          else if ('FieldMenu' in ev) menu.push({ path, value: ev.FieldMenu })
          else if ('FieldMenuItem' in ev) {
            const list = menuItems.get(ev.FieldMenuItem.id) ?? []
            list.push({ path, value: ev.FieldMenuItem })
            menuItems.set(ev.FieldMenuItem.id, list)
          } else if ('UiImages' in ev) uiImages.push({ path, value: ev.UiImages })
          else if ('Currency' in ev) currency.push({ path, value: ev.Currency })
          else if ('FieldWalkSprite' in ev) {
            const found = { path, value: ev.FieldWalkSprite }
            if (ev.FieldWalkSprite.kind === 'Player') playerWalk.push(found)
            else companionWalk.push(found)
          }
        }
      }
    }
  }

  const notation: FieldNotation = {
    entryDoc,
    entry: input.entry,
    assist: firstWins('[補助通行]', assist, warnings),
    settings: firstWins('[フィールド設定]', settings, warnings),
    characterForms: firstWins('[人物の形態]', characterForms, warnings),
    menu: firstWins('[メニュー]', menu, warnings),
    menuItems: [],
    uiImages: firstWins('[操作画像]', uiImages, warnings),
    currency: firstWins('[通貨名:]', currency, warnings),
    playerWalk: firstWins('[歩行絵 主人公]', playerWalk, warnings),
    companionWalk: firstWins('[歩行絵 同行者]', companionWalk, warnings),
    scenes: [],
    warps: [],
    master: undefined as unknown as FieldMasterData,
    flags: [...new Set(flagNames)],
    npcEvents: new Map(),
    exits: [],
    missingScenes: [],
  }
  for (const [id, found] of menuItems) {
    const v = firstWins(`[メニュー項目 ${id}]`, found, warnings)
    if (v !== undefined) notation.menuItems.push(v)
  }

  // ---- 場面の索引(FieldMap を持つ場面は ID ごとに先勝ち+警告) ----
  const byId = new Map<string, SceneRef[]>()
  for (const ref of allSceneRefs) {
    const list = byId.get(ref.scene.id) ?? []
    list.push(ref)
    byId.set(ref.scene.id, list)
  }
  const hasFieldMap = (s: EventScene) => objectEventsHave(s, 'FieldMap')
  const fieldScenes = new Map<string, SceneRef>()
  for (const [id, refs] of byId) {
    const fields = refs.filter((r) => hasFieldMap(r.scene))
    if (fields.length === 0) continue
    fieldScenes.set(id, fields[0])
    if (fields.length > 1) {
      warnings.push(
        dupMessage(
          `場面 ${id}`,
          fields.map((f) => f.path)
        )
      )
    }
  }

  // ---- 到達閉包(`[端]`/`[ワープ]` の行き先。重複で負けた宣言の行き先も辿る) ----
  const closure = new Set<string>()
  const exits = new Set<string>()
  const missing = new Set<string>()
  const queue: string[] = [input.entry.sceneId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (closure.has(id) || exits.has(id) || missing.has(id)) continue
    const ref = fieldScenes.get(id)
    if (ref) {
      closure.add(id)
      for (const ev of objectEvents(ref.scene)) {
        if ('FieldEdge' in ev) queue.push(ev.FieldEdge.target)
        else if ('FieldWarp' in ev) queue.push(ev.FieldWarp.target)
      }
    } else if (byId.has(id)) exits.add(id)
    else missing.add(id)
  }
  notation.exits = [...exits].sort(cmp)
  notation.missingScenes = [...missing].sort(cmp)

  // ---- 閉包の場面ごとの中身(優先順) ----
  const closureRefs = [...closure]
    .map((id) => fieldScenes.get(id)!)
    .sort((a, b) => a.index - b.index)
  const warpFound = new Map<string, Found<FieldWarpData>[]>()
  for (const { path, scene } of closureRefs) {
    const where = `場面 ${scene.id}（${path}）の`
    const maps: FieldMapData[] = []
    const starts: PlayerStartData[] = []
    const shakes: { amplitude_y: number; period_ms?: number }[] = []
    const scrolls: { image: string; speed: number; y?: number }[] = []
    const edges: FieldEdgeData[] = []
    const npcs: NpcData[] = []
    for (const ev of objectEvents(scene)) {
      if ('FieldMap' in ev) maps.push(ev.FieldMap)
      else if ('PlayerStart' in ev) starts.push(ev.PlayerStart)
      else if ('FieldShake' in ev) shakes.push(ev.FieldShake)
      else if ('FieldScroll' in ev) scrolls.push(ev.FieldScroll)
      else if ('FieldEdge' in ev) edges.push(ev.FieldEdge)
      else if ('Npc' in ev) npcs.push(ev.Npc)
      else if ('FieldWarp' in ev) {
        const list = warpFound.get(ev.FieldWarp.name) ?? []
        list.push({ path, value: ev.FieldWarp })
        warpFound.set(ev.FieldWarp.name, list)
      }
    }
    const once = <T>(label: string, list: T[]): T | undefined => {
      if (list.length > 1) {
        warnings.push(`${where} ${label} が複数あります。先頭のものを使い、残りは無視します`)
      }
      return list[0]
    }
    notation.scenes.push({
      id: scene.id,
      title: scene.title,
      path,
      map: once('[フィールドマップ]', maps)!,
      playerStart: once('[プレイヤー]', starts),
      edges,
      shake: once('[揺れ:]', shakes),
      scroll: once('[窓の景色:]', scrolls),
      npcs,
    })
  }
  for (const [name, found] of warpFound) {
    notation.warps.push(firstWins(`[ワープ ${name}]`, found, warnings)!)
  }

  // ---- マスター・NPC イベント(全 md) ----
  notation.master = collectMaster(sorted, warnings)
  const eventPaths = new Map<string, string>()
  for (const { path, doc } of sorted) {
    for (const [name, commands] of collectFieldEvents(doc)) {
      const first = eventPaths.get(name)
      if (first === undefined) {
        eventPaths.set(name, path)
        notation.npcEvents.set(name, commands as EventCommand[])
      } else if (first !== path) {
        warnings.push(
          `[イベント ${name}] が複数の md にあります（${first} / ${path}）。先頭の ${first} のものを使い、${path} のものは無視します`
        )
      }
    }
  }

  return { notation, warnings }
}

function objectEventsHave(scene: EventScene, key: string): boolean {
  for (const ev of objectEvents(scene)) {
    if (key in ev) return true
  }
  return false
}
