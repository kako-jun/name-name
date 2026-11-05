/**
 * `buildFieldRaw` のうち frontmatter(`battle_*`・`sprite_style`・`dialog_style` など)の部分 (#1127 / 親 #1096 S3d)。純関数。
 *
 * `parseConfig` は `battle.*` の不正値を致命にするが、frontmatter は寛容に既定へ倒す文化なので、
 * ここで先に値域を検査して「不正 → 警告して出さない」にする。FieldBattleConfig に受け口が無いキーは「効きません」と警告する。
 */
import { parseCommandIds } from '../game/battleCommands'
import { resolveRpgDataPath } from '../game/battleEffectsLoader'
import type { EventDocument } from '../types'

type Raw = Record<string, unknown>

/** frontmatter の文字列列挙を検査する。未指定(null/undefined)は undefined。不正は警告して undefined */
function enumOf(
  doc: EventDocument,
  key: keyof EventDocument,
  allowed: readonly string[],
  warnings: string[]
): string | undefined {
  const v = doc[key]
  if (v === null || v === undefined) return undefined
  // RPG 側(battleLayout.ts など)と同じく前後の空白と大小を無視して読み、raw には正規化後の値を出す
  const norm = typeof v === 'string' ? v.trim().toLowerCase() : undefined
  if (norm !== undefined && allowed.includes(norm)) return norm
  warnings.push(
    `frontmatter の ${key} は ${allowed.map((a) => `"${a}"`).join(' / ')} のどれかにしてください: ${JSON.stringify(v)}（無視します）`
  )
  return undefined
}

/** FieldBattleConfig に受け口が無い frontmatter キー(RPG 経路専用)。指定されていたら効かないことを知らせる */
const UNSUPPORTED_KEYS = [
  'battle_background_tone',
  'battle_background_dof',
  'battle_log_typewriter',
  'battle_horizon',
  'battle_perspective',
  'battle_foreground',
  'battle_command_labels',
] as const

export interface FrontmatterRaw {
  /** `raw.battle` に入れる分(`logicalSize` を含む) */
  battle: Raw
  /** `raw` の最上位に入れる分(`dialogStyle` `spriteStyle` `emotionsUrl`) */
  top: Raw
}

export function frontmatterRaw(
  doc: EventDocument | undefined,
  assetBaseUrl: string,
  battleEffects: unknown,
  warnings: string[]
): FrontmatterRaw {
  // 一枚絵フィールドは 1920x1080 固定の世界(決定 SIT.battle-canvas-1920x1080-single-logical)。`aspect_ratio` の既定 16:9 と未指定は区別できないので常に出す
  const battle: Raw = { logicalSize: '1920x1080' }
  const top: Raw = {}
  if (!doc) return { battle, top }

  const set = (key: string, v: string | undefined) => {
    if (v !== undefined) battle[key] = v
  }
  set('layout', enumOf(doc, 'battle_layout', ['front', 'side'], warnings))
  set('windowStyle', enumOf(doc, 'window_style', ['dark', 'ff-blue'], warnings))
  set('presentation', enumOf(doc, 'battle_presentation', ['dq', 'ff'], warnings))
  set('motion', enumOf(doc, 'battle_motion', ['default', 'snappy'], warnings))
  set('enemyList', enumOf(doc, 'battle_enemy_list', ['off', 'window'], warnings))
  set('commandLayout', enumOf(doc, 'battle_command_layout', ['grid', 'cross'], warnings))
  set('transition', enumOf(doc, 'battle_transition', ['none', 'ff', 'ff-mosaic'], warnings))
  set('atb', enumOf(doc, 'battle_atb', ['on', 'off'], warnings))
  set('atbMode', enumOf(doc, 'battle_atb_mode', ['wait', 'active'], warnings))
  if (typeof doc.battle_enemy_grid === 'string') battle.enemyGrid = doc.battle_enemy_grid
  if (typeof doc.battle_background === 'string' && doc.battle_background !== '')
    battle.background = doc.battle_background

  // 歩行・戦闘で共用(KJ 決定)。同じ値を両方に出す
  const spriteStyle = enumOf(doc, 'sprite_style', ['none', 'acrylic'], warnings)
  if (spriteStyle !== undefined) {
    top.spriteStyle = spriteStyle
    battle.spriteStyle = spriteStyle
  }
  if (doc.dialog_style !== null && doc.dialog_style !== undefined) {
    const ds =
      typeof doc.dialog_style === 'string' ? doc.dialog_style.trim().toLowerCase() : undefined
    if (ds === 'ff') top.dialogStyle = 'ff'
    // adv / novel はノベル場面向けの正当な値なので黙る
    else if (ds !== 'adv' && ds !== 'novel')
      warnings.push(
        `frontmatter の dialog_style は "ff" / "adv" / "novel" のどれかにしてください: ${JSON.stringify(doc.dialog_style)}（無視します）`
      )
  }
  if (typeof doc.field_emotions === 'string' && doc.field_emotions !== '')
    top.emotionsUrl = resolveRpgDataPath(assetBaseUrl, doc.field_emotions)

  // 戦闘のコマンド構成。未知・重複は警告して出さない
  if (typeof doc.battle_commands === 'string') {
    const ids: string[] = []
    for (const part of doc.battle_commands.split(/[,，]/)) {
      const t = part.trim()
      if (t === '') continue
      const parsed = parseCommandIds(t)
      if (!parsed) {
        warnings.push(`frontmatter の battle_commands の '${t}' は未知のコマンドです（省きます）`)
      } else if (ids.includes(parsed[0])) {
        warnings.push(`frontmatter の battle_commands の '${t}' は重複しています（省きます）`)
      } else ids.push(parsed[0])
    }
    if (ids.length > 0) battle.commands = ids
  }

  // 数値で渡す(parseConfig は number だけ受ける)
  if (typeof doc.battle_enemy_window_overlap === 'string') {
    const s = doc.battle_enemy_window_overlap.trim()
    const n = Number(s)
    if (s !== '' && Number.isFinite(n)) battle.enemyWindowOverlap = n
    else
      warnings.push(
        `frontmatter の battle_enemy_window_overlap は数値にしてください: ${JSON.stringify(doc.battle_enemy_window_overlap)}（無視します）`
      )
  }

  if (typeof doc.battle_effects === 'string' && doc.battle_effects !== '') {
    if (battleEffects !== undefined) battle.effects = structuredClone(battleEffects)
    else
      warnings.push(
        `frontmatter の battle_effects '${doc.battle_effects}' の中身を読めていません（戦闘のエフェクトは無効にします）`
      )
  }

  if (doc.aspect_ratio !== undefined && doc.aspect_ratio !== null && doc.aspect_ratio !== '16:9')
    warnings.push(
      `frontmatter の aspect_ratio ${JSON.stringify(doc.aspect_ratio)} は一枚絵フィールドでは使えません（16:9 の 1920x1080 で動きます）`
    )
  for (const k of UNSUPPORTED_KEYS) {
    if (doc[k] !== null && doc[k] !== undefined)
      warnings.push(`frontmatter の ${k} は一枚絵フィールドでは効きません（無視します）`)
  }
  if (doc.pixel_art === true)
    warnings.push('frontmatter の pixel_art は一枚絵フィールドでは効きません（無視します）')
  return { battle, top }
}
