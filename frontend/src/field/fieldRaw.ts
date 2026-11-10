/**
 * 一枚絵フィールドの記法から `?config=` と同じスキーマの raw(JSON 形)を組む (#1127 / 親 #1096 S3d)。
 *
 * 入力は S3c の `collectFieldNotation` の返り値 `FieldNotation`。出力 `raw` は既存 `parseConfig`(config.ts)にそのまま通せる。
 * 純関数(IO なし・決定的)。入力の `scenes[].map`・`npcs`・`npcEvents` などは参照共有なので読み取りのみで、raw には必ずコピーして入れる。
 * JSON 化できる(関数・Map を含まない)。
 *
 * ここは「組む」だけ。人物の形態の導出(`expandCharacterForms`)・`parseConfig`・警告の統合(JSON パス → 記法の言い方)は S3e の仕事。
 * 参照切れ(閉包に入らない行き先・持ち主のいない売り物・未知のモンスターを指す群など)は、parseConfig が致命にするので手前で落として警告にする。
 * 致命(`ok: false`)にするのは「開始できない」場合だけ。
 */
import { resolveRpgDataPath } from '../game/battleEffectsLoader'
import { parseEncounterGroup } from '../game/enemyGroup'
import { hasOwn, safeAssign } from '../game/ownProperty'
import type {
  Direction,
  FieldEdgeData,
  FieldWalkSpriteData,
  FieldWarpData,
  NpcData,
  PartyMemberDef,
} from '../types'
import { frontmatterRaw } from './fieldRawBattle'
import {
  gearEntriesRaw,
  itemsRaw,
  monstersRaw,
  partyRaw,
  skillsRaw,
  spellsRaw,
  statusesRaw,
} from './fieldRawMaster'
import { buildMenuRaw } from './fieldRawMenu'
import type { FieldNotation, FieldSceneNotation, FieldTriggerData } from './fieldNotation'

type Raw = Record<string, unknown>

export interface BuildFieldRawInput {
  /** `${apiBase}/api/projects/<name>/assets/raw`。raw.assetBaseUrl にそのまま入る */
  assetBaseUrl: string
  /** ホストが持つ現在のフラグ値。`[フラグ:]` で宣言済みの名前だけ初期値に重ねる。省略 = 全部 false */
  flags?: Readonly<Record<string, boolean>>
  /** 事前取得した JSON の中身(取得は呼び側の仕事)。無ければ該当機能は警告して無効 */
  aux?: {
    /** frontmatter `battle_effects` の JSON の中身 */
    battleEffects?: unknown
    /** `[メニュー項目 … 中身=path]` の path → JSON の中身 */
    menuContents?: Readonly<Record<string, unknown>>
  }
}

export type BuildFieldRawResult =
  | { ok: true; raw: Raw; warnings: string[] }
  | { ok: false; error: string; warnings: string[] }

const FACING: Record<Direction, 'up' | 'down' | 'left' | 'right'> = {
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
}
const EDGE_OF: Record<Direction, 'top' | 'bottom' | 'left' | 'right'> = {
  Up: 'top',
  Down: 'bottom',
  Left: 'left',
  Right: 'right',
}
const DIRECTION_JA: Record<Direction, string> = { Up: '上', Down: '下', Left: '左', Right: '右' }

function put(out: Raw, key: string, v: unknown): void {
  if (v !== undefined) out[key] = v
}

export function buildFieldRaw(
  notation: FieldNotation,
  input: BuildFieldRawInput
): BuildFieldRawResult {
  const warnings: string[] = []
  const fail = (error: string): BuildFieldRawResult => ({ ok: false, error, warnings })
  const { entry } = notation

  // ---- 開始位置(致命になりうる) ----
  const entryScene = notation.scenes.find((s) => s.id === entry.sceneId)
  if (!entryScene)
    return fail(
      `[フィールド: ${entry.sceneId}] の場面が一枚絵のフィールド（[フィールドマップ] のある場面）として見つかりません`
    )
  let start: { x: number; y: number }
  let startFacing: Raw['startFacing']
  if (entry.x !== undefined && entry.y !== undefined) {
    start = { x: entry.x, y: entry.y }
    startFacing = entry.facing
  } else if (entryScene.playerStart) {
    start = { x: entryScene.playerStart.x, y: entryScene.playerStart.y }
    startFacing = entry.facing ?? FACING[entryScene.playerStart.direction]
  } else {
    return fail(
      `開始位置が決まりません（[フィールド: ${entry.sceneId} @x,y] か、場面 ${entry.sceneId} の [プレイヤー @x,y] が必要です）`
    )
  }
  const player = notation.playerWalk
  if (!player || player.character === undefined)
    return fail('主人公の歩行絵が決まりません（[歩行絵 主人公 人物=… 形態=…] が必要です）')
  if (!notation.characterForms)
    return fail(
      '[歩行絵 主人公] で人物を指すには [人物の形態 目録=… 素材=…] が必要です（歩行絵を導けません）'
    )

  const raw: Raw = { assetBaseUrl: input.assetBaseUrl }
  raw.startScene = entry.sceneId
  raw.start = start
  put(raw, 'startFacing', startFacing)

  // ---- フィールド設定 ----
  const settings = notation.settings
  if (settings) {
    put(raw, 'speed', settings.speed)
    put(raw, 'edgeThreshold', settings.edge_threshold)
    if (settings.edge_contact) raw.edgeContact = settings.edge_contact === 'Body' ? 'body' : 'foot'
    put(raw, 'dialogMsPerChar', settings.ms_per_char)
  }

  // ---- 味方・マスター ----
  const master = notation.master
  const partyDefs: PartyMemberDef[] = master.partyOrder
    .filter((id) => hasOwn(master.party, id))
    .map((id) => master.party[id])
  const partyList = partyRaw(master.party, master.partyOrder, warnings)
  if (partyList.length > 0) raw.party = partyList

  // ---- 主人公・同行者・人物の形態 ----
  const cf = notation.characterForms
  raw.characterForms = {
    root: cf.assets,
    manifestUrl: resolveRpgDataPath(input.assetBaseUrl, cf.catalog),
    ...(cf.weapon_assets !== undefined ? { weaponRoot: cf.weapon_assets } : {}),
  }
  raw.player = walkRaw(player, '[歩行絵 主人公]', partyDefs, warnings)
  if (notation.companionWalk) {
    const c = notation.companionWalk
    if (!notation.assist)
      warnings.push('[歩行絵 同行者] は [補助通行] が無いと使えません（同行者は省きます）')
    else if (c.character === undefined)
      warnings.push('[歩行絵 同行者] に 人物= がありません（同行者は省きます）')
    else {
      const comp = walkRaw(c, '[歩行絵 同行者]', partyDefs, warnings)
      put(comp, 'name', c.name)
      raw.companion = comp
    }
  }

  // ---- フラグ・補助通行 ----
  const flags: Record<string, boolean> = {}
  for (const name of notation.flags) {
    const v = input.flags && hasOwn(input.flags, name) ? input.flags[name] : false
    safeAssign(flags, name, v)
  }
  const implicitFlag = (name: string, where: string) => {
    if (hasOwn(flags, name)) return
    warnings.push(
      `${where} '${name}' がどの [フラグ:] にもありません（綴りを確認。false として扱います）`
    )
    safeAssign(flags, name, false)
  }
  const a = notation.assist
  if (a) {
    for (const f of a.conditions) implicitFlag(f, '[補助通行] の 条件=')
    if (a.except !== undefined) implicitFlag(a.except, '[補助通行] の 除く=')
    if (a.ghost !== undefined) implicitFlag(a.ghost, '[補助通行] の 幽霊=')
    const assist: Raw = { requires: [...a.conditions] }
    put(assist, 'unless', a.except)
    put(assist, 'ghostWhen', a.ghost)
    put(assist, 'speedFactor', a.speed_scale)
    put(assist, 'ghostAlpha', a.opacity)
    put(assist, 'offset', a.behind_px)
    put(assist, 'fadeMs', a.fade_ms)
    raw.assist = assist
  }

  // ---- 売り物 ----
  const gear = gearEntriesRaw(master.items, partyDefs, warnings)
  for (const f of gear.unlockFlags) {
    if (!hasOwn(flags, f)) {
      warnings.push(`売り物の 解禁 '${f}' がどの [フラグ:] にもありません（false として補います）`)
      safeAssign(flags, f, false)
    }
  }
  if (gear.entries.length > 0) {
    const shop: Raw = { entries: gear.entries }
    put(shop, 'multiplier', settings?.weapon_scale)
    raw.gearShop = shop
  } else if (settings?.weapon_scale !== undefined) {
    warnings.push('[フィールド設定] の 刀の倍率 は売り物が無いので無視します')
  }
  if (Object.keys(flags).length > 0) raw.flags = flags

  // ---- マスター配列 ----
  raw.monsters = monstersRaw(master.monsters)
  const bladeAbilities = gear.entries
    .filter((e) => e.kind === 'blade')
    .flatMap((e) => (e.abilities as string[] | undefined) ?? [])
  raw.spells = spellsRaw(master, partyDefs, warnings)
  raw.skills = skillsRaw(master, partyDefs, bladeAbilities, warnings)
  raw.items = itemsRaw(master.items)
  raw.statuses = statusesRaw(master.statuses)

  // ---- 場面・ワープ ----
  const inClosure = new Set(notation.scenes.map((s) => s.id))
  const scenes: Record<string, Raw> = {}
  for (const s of notation.scenes)
    safeAssign(scenes, s.id, sceneRaw(s, notation, inClosure, warnings))
  raw.scenes = scenes
  const warps = warpsRaw(notation.warps, inClosure, notation.exits, warnings)
  if (Object.keys(warps).length > 0) raw.warps = warps

  // ---- 見た目・メニュー・操作画像 ----
  raw.tiltShift = 'on'
  const ui = notation.uiImages
  if (ui) {
    const u: Raw = {}
    put(u, 'handImage', ui.hand)
    put(u, 'selectMarkImage', ui.select_mark)
    put(u, 'markScale', ui.scale)
    if (Object.keys(u).length > 0) raw.ui = u
  }
  const menu = buildMenuRaw(
    notation.menu,
    notation.menuItems,
    notation.scenes,
    input.aux?.menuContents,
    warnings
  )
  if (menu) raw.menu = menu

  // ---- frontmatter(戦闘・歩行絵の見せ方・会話窓・感情) ----
  const fm = frontmatterRaw(
    notation.entryDoc,
    input.assetBaseUrl,
    input.aux?.battleEffects,
    warnings
  )
  Object.assign(raw, fm.top)
  if (notation.currency !== undefined) fm.battle.currencyName = notation.currency
  raw.battle = fm.battle

  return { ok: true, raw, warnings }
}

/** `[歩行絵 主人公|同行者]` → raw.player / raw.companion(歩行絵そのものは人物の形態の目録から後段が導く) */
function walkRaw(
  w: FieldWalkSpriteData,
  label: string,
  party: readonly PartyMemberDef[],
  warnings: string[]
): Raw {
  const r: Raw = {}
  put(r, 'character', w.character)
  put(r, 'form', w.form)
  put(r, 'height', w.height)
  put(r, 'frameMs', w.frame_ms)
  put(r, 'cycle', w.cycle ? [...w.cycle] : undefined)
  put(r, 'idleFrame', w.idle_frame)
  if (w.idle_frame !== undefined && w.cycle === undefined)
    warnings.push(
      `${label} に 停止= だけで 周期= がありません（人物の形態から歩行絵を導くとき、停止は周期の既定に合わせて上書きされます。周期= と 停止= を組で書いてください）`
    )
  // 同じ人物の味方に形態があると、そちらが優先される(expandCharacterForms の仕様)ので、食い違いを知らせる
  const mate = party.find((m) => m.character === w.character && m.form !== undefined)
  if (mate && w.form !== undefined && mate.form !== w.form)
    warnings.push(
      `${label} の形態 ${w.form} は、同じ人物の味方（[パーティ ${mate.id}]）の形態 ${mate.form} が優先されます`
    )
  return r
}

function warpsRaw(
  warps: readonly FieldWarpData[],
  inClosure: ReadonlySet<string>,
  exits: readonly string[],
  warnings: string[]
): Raw {
  const out: Record<string, Raw> = {}
  for (const w of warps) {
    if (!inClosure.has(w.target)) {
      warnings.push(
        `[ワープ ${w.name}] の行き先 '${w.target}' は${unreachable(w.target, exits)}（このワープは省きます）`
      )
      continue
    }
    const r: Raw = { to: w.target, at: { x: w.x, y: w.y } }
    if (w.direction) r.facing = FACING[w.direction]
    if (w.effect) r.effect = w.effect === 'Fade' ? 'fade' : 'flash'
    if (w.timing_ms) {
      r.outMs = w.timing_ms[0]
      r.holdMs = w.timing_ms[1]
      r.inMs = w.timing_ms[2]
    }
    safeAssign(out, w.name, r)
  }
  return out
}

/** 行き先が閉包に入らない理由(警告文の一部) */
const unreachable = (target: string, exits: readonly string[]): string =>
  exits.includes(target)
    ? '一枚絵のフィールドではありません（ノベルへの出口は未対応です）'
    : '場面が見つかりません'

function sceneRaw(
  s: FieldSceneNotation,
  notation: FieldNotation,
  inClosure: ReadonlySet<string>,
  warnings: string[]
): Raw {
  const where = `場面 ${s.id}（${s.path}）の`
  const r: Raw = { background: s.map.background, mask: s.map.mask }
  put(r, 'foreground', s.map.foreground)
  put(r, 'playerHeight', s.playerStart?.height)
  if (s.shake) {
    const shake: Raw = { amplitudeY: s.shake.amplitude_y }
    put(shake, 'periodMs', s.shake.period_ms)
    r.shake = shake
  }
  if (s.scroll) {
    const scroll: Raw = { image: s.scroll.image, speed: s.scroll.speed }
    put(scroll, 'y', s.scroll.y)
    r.scroll = scroll
  }
  const links = s.edges.flatMap((e) => linkRaw(e, where, inClosure, notation.exits, warnings))
  if (links.length > 0) r.links = links
  const encounter = encounterRaw(s, where, notation, warnings)
  if (encounter) r.encounter = encounter
  const npcs = s.npcs.flatMap((n) => npcRaw(n, where, warnings))
  if (npcs.length > 0) r.npcs = npcs
  const triggers = s.triggers.flatMap((t) => triggerRaw(t, where, warnings))
  if (triggers.length > 0) r.triggers = triggers
  return r
}

/** `[トリガー]` 1 行 → raw (#1072)。座標つき(`@x,y`)も `auto` も持たない行は parser が作らないが、念のため警告して落とす */
function triggerRaw(t: FieldTriggerData, where: string, warnings: string[]): Raw[] {
  if (t.auto) {
    const r: Raw = { auto: true, event: t.scene }
    if (t.once) r.once = true
    return [r]
  }
  if (t.x === undefined || t.y === undefined) {
    warnings.push(
      `${where} [トリガー scene=${t.scene}] に auto も @x,y もありません（このトリガーは省きます）`
    )
    return []
  }
  const r: Raw = { x: t.x, y: t.y, event: t.scene }
  put(r, 'radius', t.radius)
  if (t.once) r.once = true
  return [r]
}

function linkRaw(
  e: FieldEdgeData,
  where: string,
  inClosure: ReadonlySet<string>,
  exits: readonly string[],
  warnings: string[]
): Raw[] {
  if (!inClosure.has(e.target)) {
    warnings.push(
      `${where} [端 ${DIRECTION_JA[e.direction]} → ${e.target}] の行き先は${unreachable(e.target, exits)}（この端は省きます）`
    )
    return []
  }
  return [{ edge: EDGE_OF[e.direction], range: [e.range_from, e.range_to], to: e.target }]
}

function encounterRaw(
  s: FieldSceneNotation,
  where: string,
  notation: FieldNotation,
  warnings: string[]
): Raw | undefined {
  const rate = s.map.encounter_rate
  const declared = s.map.encounter_groups ?? []
  if (rate === undefined && declared.length === 0) return undefined
  if (declared.length === 0) {
    warnings.push(`${where} [エンカウント率:] だけで敵の群がありません（エンカウントなしにします）`)
    return undefined
  }
  if (rate === undefined) {
    warnings.push(
      `${where} 敵の群だけで [エンカウント率:] がありません（エンカウントなしにします）`
    )
    return undefined
  }
  const groups: string[] = []
  for (const g of declared) {
    const parsed = parseEncounterGroup(g)
    if (parsed.warnings.length > 0) {
      warnings.push(`${where} 敵の群 "${g}" は ${parsed.warnings[0]}（この群は省きます）`)
      continue
    }
    const unknown = parsed.items.find((i) => !hasOwn(notation.master.monsters, i.id))
    if (unknown) {
      warnings.push(
        `${where} 敵の群 "${g}" の '${unknown.id}' が [モンスター] にありません（この群は省きます）`
      )
      continue
    }
    groups.push(g)
  }
  const r: Raw = { rate, groups }
  put(r, 'background', s.map.battle_background)
  return r
}

/** NPC 1 人 → raw。描けない・話せない NPC は警告して落とす(空配列) */
function npcRaw(n: NpcData, where: string, warnings: string[]): Raw[] {
  const who = `${where} NPC '${n.name}'`
  const hasWalk = n.walk_sprites !== undefined && n.walk_sprites !== ''
  const hasSprite = n.sprite !== undefined && n.sprite !== ''
  if (!hasWalk && !hasSprite) {
    warnings.push(
      `${who} は sprite= も 絵= もありません（一枚絵のフィールドでは色の四角を描けないので、この NPC は省きます）`
    )
    return []
  }
  const scene = n.scene !== undefined && n.scene.trim() !== '' ? n.scene : undefined
  let line = n.message.join('\n')
  if (line.trim() === '') {
    if (scene === undefined) {
      warnings.push(`${who} は台詞も scene もありません（この NPC は省きます）`)
      return []
    }
    // scene があれば固定の台詞はイベントが読めないときの保険。空のままだと parseConfig が NPC を捨てるので埋める
    line = '…'
  }
  const r: Raw = { id: n.id, name: n.name, x: n.x, y: n.y, line }
  if (hasWalk) {
    if (hasSprite)
      warnings.push(
        `${who} は sprite= と 絵= の両方があります。絵=（4 方向）を使い sprite= は無視します`
      )
    const sprites: Raw = {}
    for (const dir of ['up', 'down', 'left', 'right'])
      sprites[dir] = [1, 2, 3].map((i) => `${n.walk_sprites}-walk-${dir}-${i}.webp`)
    r.sprites = sprites
  } else r.sprite = n.sprite
  put(r, 'height', n.height)
  if (n.direction) r.facing = FACING[n.direction]
  put(r, 'scene', scene)
  return [r]
}
