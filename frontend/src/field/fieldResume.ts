/**
 * 一枚絵フィールドをセーブデータから途中再開する (#1021)。DOM / PixiJS に依存しない純関数。
 *
 * 状態の与え方は一通り: localStorage に `SaveSlotData`（`rpg` 付き）を先に作ってから、
 * `field.html?resume=<0|1|2|quick>` で開く。セーブ形式は `game/rpgSave.ts` が正本で、
 * このファイルは「設定（世界）にセーブ（状態）を重ねる」ことと「戦闘エンジンへ渡す形」だけを持つ。
 */
import { SaveManager, type SaveSlotData } from '../game/SaveManager'
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
import type { FieldBattleConfig, FieldConfig } from './config'
import { savedFormsOf } from './characterForms'

/** セーブのキーの名前空間 (#578)。実キーは `name-name-save-field-<slot>` / `…-quick` */
export const FIELD_DOC_KEY = 'field'

/** 設定（世界）から、セーブを重ねる土台を作る */
export function baseConfigOf(
  config: Pick<FieldConfig, 'party' | 'items' | 'flags' | 'monsters'>
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
  config: Pick<FieldConfig, 'party' | 'items' | 'flags' | 'monsters' | 'scenes'>,
  saves: SaveManager = new SaveManager(FIELD_DOC_KEY)
): ResumeLoad {
  const raw = new URLSearchParams(search).get('resume')
  if (raw === null) return { kind: 'none' }
  const slot = parseResumeParam(raw)
  if (slot === null)
    return { kind: 'error', message: `?resume=${raw} は不正です（0 / 1 / 2 / quick のどれか）` }
  const data = slot === 'quick' ? saves.quickLoad() : saves.load(slot)
  return resumeFromSlotData(data, slot, config)
}

/**
 * セーブデータ 1 件を設定に重ねる。`loadResume`（`?resume=`）と、メニュー「ロード」の可否判定（`isLoadableSlot`）が共有する正本。
 * データ無し・RPG 状態無し・検証失敗・パーティ 0 人 → error（理由つき）
 */
export function resumeFromSlotData(
  data: SaveSlotData | null,
  slot: number | 'quick',
  config: Pick<FieldConfig, 'party' | 'items' | 'flags' | 'monsters' | 'scenes'>
): ResumeLoad {
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

/** そのスロットが「ロード」できるか（`loadResume` と同じ条件）。ノベルのセーブ・壊れたセーブ・パーティが設定に居ないセーブは false */
export function isLoadableSlot(
  data: SaveSlotData | null,
  slot: number,
  config: Pick<FieldConfig, 'party' | 'items' | 'flags' | 'monsters' | 'scenes'>
): boolean {
  return resumeFromSlotData(data, slot, config).kind === 'ok'
}

/**
 * `?resume=` のセーブから、味方の形態（時期・車椅子）の指定（メンバー id → form）だけを先に読む (#1020)。
 * 形態は絵（poses・歩行絵）の導出に使うので、設定を読み込む前に要る。`?resume=` が無い・読めない・形態の指定が無いときは空
 */
export function savedFormsFromResume(
  search: string,
  saves: SaveManager = new SaveManager(FIELD_DOC_KEY)
): Record<string, string> {
  const raw = new URLSearchParams(search).get('resume')
  const slot = parseResumeParam(raw)
  if (slot === null) return {}
  const data = slot === 'quick' ? saves.quickLoad() : saves.load(slot)
  return savedFormsOf(data?.rpg)
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

/** `?resume=<slot>` を差し替えた search（`?config=` などは維持）。メニューの「ロード」が `?resume=` の既存の入口へそのまま乗るための組み立て */
export function withResumeSlot(search: string, slot: number): string {
  const q = new URLSearchParams(search)
  q.set('resume', String(slot))
  return `?${q.toString()}`
}

/**
 * 脚本制御の戦闘 (#1073) の後の味方の持ち越し。戦闘に出たのは初期編成と途中参戦の味方だけなので、`after` に居る者は戦闘後の値、
 * 居ない者（出なかった味方）は戦闘前のままにする。順序は `before`。渡した値は書き換えない
 */
export function mergePartyById<P extends { id: string }>(
  before: readonly P[],
  after: readonly P[]
): P[] {
  return before.map((b) => structuredClone(after.find((a) => a.id === b.id) ?? b))
}

/**
 * セーブに書く味方 (#1073)。戦闘中でなければ持ち越し中の味方そのまま。戦闘中は、戦闘前の味方に戦闘中のエンジンの味方を `id` で重ねる
 * （脚本制御の戦闘は一部の味方しか出ないので、出なかった味方を落とさない。出た味方は戦闘中の値。順序は戦闘前のまま）。渡した値は書き換えない
 */
export function snapshotParty<P extends { id: string }>(
  partyState: readonly P[],
  engineParty: readonly P[],
  inBattle: boolean
): P[] {
  return inBattle ? mergePartyById(partyState, engineParty) : [...partyState]
}
