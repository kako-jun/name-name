/**
 * 一枚絵フィールドをセーブデータから途中再開する (#1021)。DOM / PixiJS に依存しない純関数。
 *
 * 状態の与え方は一通り: localStorage に `SaveSlotData`（`rpg` 付き）を先に作ってから、
 * `field-sample.html?resume=<0|1|2|quick>` で開く。セーブ形式は `game/rpgSave.ts` が正本で、
 * このファイルは「設定（世界）にセーブ（状態）を重ねる」ことと「戦闘エンジンへ渡す形」だけを持つ。
 */
import { SaveManager } from '../game/SaveManager'
import {
  parseResumeParam,
  parseRpgSave,
  resolveRpg,
  type RpgBaseConfig,
  type RpgResolved,
  type RpgResolvedBattle,
} from '../game/rpgSave'
import { buildEnemyEntities } from '../game/encounter'
import { hasOwn } from '../game/ownProperty'
import type { BattleEngineOptions } from '../game/battleEngine'
import type { FieldBattleConfig, FieldSampleConfig } from './config'

/** セーブのキーの名前空間 (#578)。実キーは `name-name-save-field-sample-<slot>` / `…-quick` */
export const FIELD_SAMPLE_DOC_KEY = 'field-sample'

/** 設定（世界）から、セーブを重ねる土台を作る */
export function baseConfigOf(
  config: Pick<FieldSampleConfig, 'party' | 'items' | 'flags' | 'monsters'>
): RpgBaseConfig {
  return {
    party: config.party,
    items: config.items,
    flags: config.flags,
    enemy: (id) =>
      hasOwn(config.monsters, id) ? buildEnemyEntities([{ id }], config.monsters)[0] : undefined,
  }
}

export type ResumeLoad =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; slot: number | 'quick'; resolved: RpgResolved }

/**
 * `?resume=` を読んで、セーブを設定に重ねた状態にする。
 * - `?resume=` が無い → none（従来どおり設定の開始位置から）
 * - 値が不正・スロットが空・RPG 状態が無い・検証に失敗 → error（理由つき。呼び出し側が画面に出し、開始位置から始める）
 */
export function loadResume(
  search: string,
  config: Pick<FieldSampleConfig, 'party' | 'items' | 'flags' | 'monsters' | 'scenes'>,
  saves: SaveManager = new SaveManager(FIELD_SAMPLE_DOC_KEY)
): ResumeLoad {
  const raw = new URLSearchParams(search).get('resume')
  if (raw === null) return { kind: 'none' }
  const slot = parseResumeParam(raw)
  if (slot === null)
    return { kind: 'error', message: `?resume=${raw} は不正です（0 / 1 / 2 / quick のどれか）` }
  const data = slot === 'quick' ? saves.quickLoad() : saves.load(slot)
  if (!data) return { kind: 'error', message: `セーブ（${String(slot)}）がありません` }
  if (!data.rpg)
    return { kind: 'error', message: `セーブ（${String(slot)}）に rpg 状態がありません` }
  const parsed = parseRpgSave(data.rpg)
  if (!parsed.ok)
    return { kind: 'error', message: `セーブ（${String(slot)}）が不正です: ${parsed.error}` }
  const resolved = resolveRpg(parsed.value, baseConfigOf(config))
  if (resolved.party.length === 0)
    return { kind: 'error', message: `セーブ（${String(slot)}）のパーティが設定に 1 人もいません` }
  if (resolved.field && !hasOwn(config.scenes, resolved.field.sceneId)) {
    resolved.warnings.push(
      `field.sceneId '${resolved.field.sceneId}' は設定のシーンにありません（開始位置から始めます）`
    )
    delete resolved.field
  }
  return { kind: 'ok', slot, resolved }
}

/** 宣言済みのフラグだけを、設定の初期値に重ねる（未宣言の名前は無視） */
export function mergeFlags(
  initial: Readonly<Record<string, boolean>>,
  saved: Readonly<Record<string, boolean>> | undefined
): Record<string, boolean> {
  const out = { ...initial }
  for (const [k, v] of Object.entries(saved ?? {})) if (hasOwn(initial, k)) out[k] = v
  return out
}

/** 戦闘エンジンに渡すオプション。保存された戦闘中状態があれば ATB ゲージ・キュー・脚本の進行・敵の記憶を戻す */
export function resumeBattleEngineOptions(
  base: BattleEngineOptions,
  saved: RpgResolvedBattle | null
): BattleEngineOptions {
  if (!saved) return base
  const atb =
    base.atb && saved.atb
      ? {
          ...base.atb,
          initialGauges: { party: saved.atb.partyGauge, enemies: saved.atb.enemyGauge },
        }
      : base.atb
  return {
    ...base,
    ...(atb ? { atb } : {}),
    restore: {
      ...(saved.atb ? { atbQueue: saved.atb.queue } : {}),
      ...(saved.script ? { script: saved.script } : {}),
      ...(saved.enemyMemory ? { enemyMemory: saved.enemyMemory } : {}),
    },
  }
}

/** 戦闘設定 `battle` から背景を決める（保存された背景があれば優先） */
export function resumeBackground(
  saved: RpgResolvedBattle | null,
  fallback: FieldBattleConfig['background']
): string | undefined {
  return saved?.background ?? fallback
}

/** 画面に出す通知の組み立て。通常のエラーとセーブ再開の通知を、どちらかが消えることなく改行でつなぐ（空・null は出さない） */
export function composeNotice(base: string | null, resume: string | null): string {
  return [base, resume].filter((x): x is string => !!x).join('\n')
}

/** 候補窓に渡すアイテム（設定の定義に、持ち越した所持数を count として入れる）。設定そのものは書き換えない */
export function itemsWithCounts<T extends { id: string; count?: number }>(
  items: readonly T[],
  inventory: Readonly<Record<string, number>>
): T[] {
  return items.map((it) => ({ ...it, count: inventory[it.id] ?? 0 }))
}

/**
 * 戦闘の結果の持ち越し (#1021)。所持品は候補窓に残った数、所持金は獲得分を足し、味方は敗北以外なら戦闘後の HP/MP/状態異常に置き換える
 * （敗北では戦闘前のまま。全滅のまま次へ進めなくなるのを防ぐ。所持品・所持金は戻さない）。渡した値は書き換えない
 */
export function carryOverBattleResult<P>(input: {
  outcome: string
  earnedGold: number
  menuItems: ReadonlyArray<{ id: string; count?: number }>
  partyAfter: readonly P[]
  before: { inventory: Readonly<Record<string, number>>; gold: number; party: readonly P[] }
}): { inventory: Record<string, number>; gold: number; party: P[] } {
  const inventory = { ...input.before.inventory }
  for (const it of input.menuItems) inventory[it.id] = it.count ?? inventory[it.id] ?? 0
  return {
    inventory,
    gold: input.before.gold + input.earnedGold,
    party: structuredClone(
      (input.outcome === 'defeat' ? input.before.party : input.partyAfter) as P[]
    ),
  }
}
