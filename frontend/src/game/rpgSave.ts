/**
 * RPG 状態のセーブ形式 (#1021)。パーティ・所持品・装備・所持金・フィールド現在地・戦闘中状態を
 * 宣言的な JSON で表す。`SaveSlotData.rpg` に載せて保存し、`StartFromOptions.rpg` でも同じ形を受ける
 * （セーブ形式が正で、startFrom は同じ形式を受けるだけ）。
 *
 * 純粋な型と検証・合成の関数だけを持つ（DOM / PixiJS に依存しない）。ADR 0002 のとおり
 * 「次の操作を待つ安定した状態」だけを持ち、演出の中間状態（ダメージ数字・モーション）は持たない。
 */
import type { BattleEntity } from './spellDsl'
import type { ScriptState } from './battleScript'
import type { EnemyMemory } from './enemyAi'
import type { SaveSlotData } from './SaveManager'
import { hasOwn } from './ownProperty'

export const RPG_SAVE_VERSION = 1

/** 歩行の向き（8 方向）。fieldWalk の Facing8 と同じ値域 */
export const RPG_FACINGS = [
  'up',
  'down',
  'left',
  'right',
  'upLeft',
  'upRight',
  'downLeft',
  'downRight',
] as const
export type RpgFacing = (typeof RPG_FACINGS)[number]

/** フィールドの現在地。どの絵（シーン）のどの座標（足元・背景ピクセル）でどちらを向いているか */
export interface RpgFieldState {
  sceneId: string
  x: number
  y: number
  facing: RpgFacing
  /** 名前つきの真偽値（フィールドのフラグ）。設定で宣言済みの名前だけ効く。省略は設定の初期値 */
  flags?: Record<string, boolean>
}

/** 者の差分。`id` で設定のマスター（味方なら設定のパーティ、敵ならモンスターのマスター）と突き合わせ、書いたキーだけ上書きする */
export type RpgEntityPatch = { id: string } & Partial<Omit<BattleEntity, 'id'>>

/** 戦闘中の状態。味方の HP / MP / 状態異常は `RpgSaveState.party` 側（同じ者）に持つ */
export interface RpgBattleState {
  /**
   * 敵。`id` はモンスターのマスター id（同じ id が複数いてよい）。いまの HP・状態異常などマスターと違うキーだけ書く。
   * `hp <= 0` の者は倒れた状態で残す（並びが ATB ゲージの添字になる）
   */
  enemies: RpgEntityPatch[]
  /** ATB。ゲージは 0〜1000、`queue` はコマンド待ちの味方の party index（溜まった順）。ターン制は省略 */
  atb?: { partyGauge: number[]; enemyGauge: number[]; queue: number[] }
  /** 脚本制御の戦闘の進行（経過ターン・発動済みルール・参戦・逃走）。普通の戦闘は省略 */
  script?: Omit<ScriptState, 'id'>
  /** 敵ごとの記憶（`行動:` を持つ敵の行動回数など）。省略は初期状態 */
  enemyMemory?: EnemyMemory[]
  /** 戦闘背景の URL（省略はシーン・既定の背景） */
  background?: string
}

/** RPG 状態のセーブ */
export interface RpgSaveState {
  version: typeof RPG_SAVE_VERSION
  /**
   * パーティ。`id` は設定のパーティの id。ほかのキーは設定の値に上書きする（hp / mp / status / buffs / 能力値など）。
   * 載せなかった者は離脱している扱い。載せた順が並び順
   */
  party: RpgEntityPatch[]
  /** 所持品。id → 個数。載せなかった設定のアイテムは 0 個 */
  items: Record<string, number>
  /** 装備。メンバー id → アイテム id の配列（装備スロットの順）。保存と復元はするが、能力値への反映は呼び出し側 */
  equipment: Record<string, string[]>
  /** 所持金 */
  gold: number
  /** フィールドの現在地。省略は設定の開始位置 */
  field?: RpgFieldState
  /** 戦闘中の状態。ある場合は戦闘中の局面から再開する。省略はフィールド（歩行中） */
  battle?: RpgBattleState
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export type RpgParseResult = { ok: true; value: RpgSaveState } | { ok: false; error: string }

/** JSON 由来の値の複製（`__proto__` などの危険なキーを持ち込まない） */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function checkEntity(e: unknown, where: string, requireStats: boolean): string | null {
  if (!isObj(e)) return `${where} はオブジェクトが必要です`
  if (!isStr(e.id) || e.id === '') return `${where}.id は空でない文字列が必要です`
  const numeric = ['hp', 'maxHp', 'mp', 'maxMp', 'atk', 'def', 'agi'] as const
  for (const k of numeric) {
    if (e[k] === undefined) {
      if (requireStats) return `${where}.${k} がありません`
      continue
    }
    if (!isNum(e[k])) return `${where}.${k} は有限の数が必要です`
  }
  if (requireStats && !isStr(e.name)) return `${where}.name がありません`
  if (e.name !== undefined && !isStr(e.name)) return `${where}.name は文字列が必要です`
  if (e.form !== undefined && !isStr(e.form)) return `${where}.form は文字列が必要です`
  if (e.buffs !== undefined) {
    if (!isObj(e.buffs)) return `${where}.buffs はオブジェクトが必要です`
    for (const [k, v] of Object.entries(e.buffs))
      if (!isNum(v)) return `${where}.buffs.${k} は数が必要です`
  }
  if (e.status !== undefined) {
    if (!isObj(e.status)) return `${where}.status はオブジェクトが必要です`
    for (const [k, v] of Object.entries(e.status))
      if (!isNum(v)) return `${where}.status.${k} は数が必要です`
  }
  return null
}

/** 生の値を検証して `RpgSaveState` にする（複製を返す。不正なら理由つきで失敗） */
export function parseRpgSave(raw: unknown): RpgParseResult {
  const fail = (error: string): RpgParseResult => ({ ok: false, error: `rpg: ${error}` })
  if (!isObj(raw)) return fail('オブジェクトが必要です')
  if (raw.version !== RPG_SAVE_VERSION)
    return fail(`version は ${RPG_SAVE_VERSION} が必要です（${String(raw.version)}）`)
  if (!Array.isArray(raw.party)) return fail('party は配列が必要です')
  const seen = new Set<string>()
  for (let i = 0; i < raw.party.length; i++) {
    const err = checkEntity(raw.party[i], `party[${i}]`, false)
    if (err) return fail(err)
    const id = (raw.party[i] as Obj).id as string
    if (seen.has(id)) return fail(`party[${i}].id '${id}' が重複しています`)
    seen.add(id)
  }
  if (!isObj(raw.items)) return fail('items はオブジェクト（id → 個数）が必要です')
  for (const [k, v] of Object.entries(raw.items))
    if (!isNum(v) || v < 0 || !Number.isInteger(v))
      return fail(`items.${k} は 0 以上の整数が必要です`)
  if (!isObj(raw.equipment)) return fail('equipment はオブジェクトが必要です')
  for (const [k, v] of Object.entries(raw.equipment))
    if (!Array.isArray(v) || !v.every(isStr)) return fail(`equipment.${k} は文字列の配列が必要です`)
  if (!isNum(raw.gold) || raw.gold < 0) return fail('gold は 0 以上の数が必要です')
  if (raw.field !== undefined) {
    const f = raw.field
    if (!isObj(f)) return fail('field はオブジェクトが必要です')
    if (!isStr(f.sceneId) || f.sceneId === '')
      return fail('field.sceneId は空でない文字列が必要です')
    if (!isNum(f.x) || !isNum(f.y)) return fail('field.x / field.y は有限の数が必要です')
    if (!isStr(f.facing) || !(RPG_FACINGS as readonly string[]).includes(f.facing))
      return fail(`field.facing は ${RPG_FACINGS.join(' / ')} のどれかが必要です`)
    if (f.flags !== undefined) {
      if (!isObj(f.flags)) return fail('field.flags はオブジェクトが必要です')
      for (const [k, v] of Object.entries(f.flags))
        if (typeof v !== 'boolean') return fail(`field.flags.${k} は真偽値が必要です`)
    }
  }
  if (raw.battle !== undefined) {
    const b = raw.battle
    if (!isObj(b)) return fail('battle はオブジェクトが必要です')
    if (!Array.isArray(b.enemies) || b.enemies.length === 0)
      return fail('battle.enemies は 1 件以上の配列が必要です')
    for (let i = 0; i < b.enemies.length; i++) {
      const err = checkEntity(b.enemies[i], `battle.enemies[${i}]`, false)
      if (err) return fail(err)
    }
    if (b.atb !== undefined) {
      const a = b.atb
      if (!isObj(a)) return fail('battle.atb はオブジェクトが必要です')
      for (const k of ['partyGauge', 'enemyGauge', 'queue'] as const)
        if (!Array.isArray(a[k]) || !(a[k] as unknown[]).every(isNum))
          return fail(`battle.atb.${k} は数の配列が必要です`)
    }
    if (b.script !== undefined) {
      const s = b.script
      if (!isObj(s)) return fail('battle.script はオブジェクトが必要です')
      if (!isNum(s.turn)) return fail('battle.script.turn は数が必要です')
      for (const k of ['fired', 'fled'] as const)
        if (
          !Array.isArray(s[k]) ||
          !(s[k] as unknown[]).every((n) => isNum(n) && Number.isInteger(n) && n >= 0)
        )
          return fail(`battle.script.${k} は 0 以上の整数の配列が必要です`)
      if (!Array.isArray(s.joined) || !(s.joined as unknown[]).every(isStr))
        return fail('battle.script.joined は文字列の配列が必要です')
    }
    if (b.enemyMemory !== undefined) {
      if (!Array.isArray(b.enemyMemory)) return fail('battle.enemyMemory は配列が必要です')
      for (let i = 0; i < b.enemyMemory.length; i++) {
        const m = b.enemyMemory[i]
        const w = `battle.enemyMemory[${i}]`
        if (!isObj(m)) return fail(`${w} はオブジェクトが必要です`)
        if (!isNum(m.acted) || !Number.isInteger(m.acted) || m.acted < 0)
          return fail(`${w}.acted は 0 以上の整数が必要です`)
        for (const k of ['rule', 'pos'] as const)
          if (m[k] !== undefined && !isNum(m[k])) return fail(`${w}.${k} は数が必要です`)
        if (m.used !== undefined) {
          if (!isObj(m.used)) return fail(`${w}.used はオブジェクトが必要です`)
          for (const [k, v] of Object.entries(m.used))
            if (!isNum(v)) return fail(`${w}.used.${k} は数が必要です`)
        }
      }
    }
    if (b.background !== undefined && !isStr(b.background))
      return fail('battle.background は文字列が必要です')
  }
  return { ok: true, value: cloneJson(raw as unknown as RpgSaveState) }
}

/** 設定側の味方・アイテム・敵のマスター（合成の入力） */
export interface RpgBaseConfig {
  party: readonly BattleEntity[]
  items: ReadonlyArray<{ id: string; count?: number }>
  flags: Readonly<Record<string, boolean>>
  /** モンスターのマスター id → 満タン・無傷の敵（`buildEnemyEntities` と同じ組み立て）。無ければ undefined */
  enemy: (id: string) => BattleEntity | undefined
}

/** 実行時の戦闘中状態（敵は組み立て済みの完全な者） */
export interface RpgResolvedBattle extends Omit<RpgBattleState, 'enemies'> {
  enemies: BattleEntity[]
}

export interface RpgResolved {
  party: BattleEntity[]
  /** 設定のアイテムの id → 個数 */
  inventory: Record<string, number>
  equipment: Record<string, string[]>
  gold: number
  field?: RpgFieldState
  battle?: RpgResolvedBattle
  warnings: string[]
}

/**
 * セーブを設定に重ねて、実行時の状態にする。味方は id で設定と突き合わせ、設定に無い id は警告して捨てる。
 * 所持品は設定のアイテム（定義の持ち主）の個数だけをセーブの値に置き換える（セーブにあって設定に無い id は警告して捨てる）。
 * 戦闘中状態は、敵の id がマスターに 1 つでも無ければ警告して丸ごと捨てる（並びが ATB ゲージの添字なので一部だけ捨てられない）
 */
export function resolveRpg(rpg: RpgSaveState, base: RpgBaseConfig): RpgResolved {
  const warnings: string[] = []
  const party: BattleEntity[] = []
  for (const m of rpg.party) {
    const def = base.party.find((p) => p.id === m.id)
    if (!def) {
      warnings.push(`party '${m.id}' は設定のパーティにいません（無視）`)
      continue
    }
    party.push(applyPatch(def, m))
  }
  const inventory: Record<string, number> = {}
  for (const it of base.items) inventory[it.id] = hasOwn(rpg.items, it.id) ? rpg.items[it.id] : 0
  for (const id of Object.keys(rpg.items))
    if (!base.items.some((it) => it.id === id))
      warnings.push(`items '${id}' は設定のアイテムにありません（無視）`)
  const out: RpgResolved = {
    party,
    inventory,
    equipment: cloneJson(rpg.equipment),
    gold: rpg.gold,
    warnings,
  }
  if (rpg.field) out.field = cloneJson(rpg.field)
  if (rpg.battle) {
    const enemies: BattleEntity[] = []
    for (const patch of rpg.battle.enemies) {
      const def = base.enemy(patch.id)
      if (!def) {
        warnings.push(
          `battle.enemies '${patch.id}' はモンスターのマスターにいません（戦闘中状態を無視）`
        )
        break
      }
      enemies.push(applyPatch(def, patch))
    }
    if (enemies.length === rpg.battle.enemies.length)
      out.battle = { ...cloneJson({ ...rpg.battle, enemies: [] }), enemies }
  }
  return out
}

/** マスターに差分を重ねる。maxHp / maxMp は hp / mp が上回らないよう持ち上げる（hp だけ書いたセーブでも矛盾しない） */
function applyPatch(def: BattleEntity, patch: RpgEntityPatch): BattleEntity {
  const merged = { ...cloneJson(def), ...cloneJson(patch) } as BattleEntity
  if (merged.maxHp < merged.hp) merged.maxHp = merged.hp
  if (merged.maxMp < merged.mp) merged.maxMp = merged.mp
  return merged
}

/** 者とマスターの差分（`id` は必ず入る）。絵（sprite / poses）など設定由来の長い値はマスターと同じなので出ない */
export function diffEntity(entity: BattleEntity, def: BattleEntity | undefined): RpgEntityPatch {
  const out: Record<string, unknown> = { id: entity.id }
  for (const [k, v] of Object.entries(entity)) {
    if (k === 'id') continue
    if (def && JSON.stringify((def as unknown as Record<string, unknown>)[k]) === JSON.stringify(v))
      continue
    out[k] = cloneJson(v)
  }
  return out as RpgEntityPatch
}

/**
 * 実行時の状態（`resolveRpg` の逆）からセーブを作る。JSON にしたとき `parseRpgSave` を通る形。
 * 味方・敵はマスターとの差分だけを書く（絵のデータ URI などでセーブが太らない）
 */
export function snapshotRpg(
  s: {
    party: readonly BattleEntity[]
    inventory: Readonly<Record<string, number>>
    equipment: Readonly<Record<string, string[]>>
    gold: number
    field?: RpgFieldState
    battle?: RpgResolvedBattle
  },
  base: Pick<RpgBaseConfig, 'party' | 'enemy'>
): RpgSaveState {
  const out: RpgSaveState = {
    version: RPG_SAVE_VERSION,
    party: s.party.map((m) =>
      diffEntity(
        m,
        base.party.find((p) => p.id === m.id)
      )
    ),
    items: cloneJson(s.inventory) as Record<string, number>,
    equipment: cloneJson(s.equipment) as Record<string, string[]>,
    gold: s.gold,
  }
  if (s.field) out.field = cloneJson(s.field)
  if (s.battle) {
    // 敵のマスターは id だけで引ける満タン無傷の者。配置（col / row）は差分として残る
    out.battle = {
      ...cloneJson({ ...s.battle, enemies: [] }),
      enemies: s.battle.enemies.map((e) => diffEntity(e, base.enemy(e.id))),
    }
  }
  return out
}

/**
 * RPG 状態だけを持つセーブスロットを作る（ノベル側のフィールドは中立の既定値）。
 * 手で書くセーブ・テスト・ドキュメントの例が、`SaveSlotData` の必須キーを意識しなくて済むようにする
 */
export function buildRpgSaveSlot(
  rpg: RpgSaveState,
  meta: { slot?: number; savedAt?: string; sceneName?: string | null } = {}
): SaveSlotData {
  return {
    slot: meta.slot ?? 0,
    sceneId: null,
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: meta.savedAt ?? new Date(0).toISOString(),
    sceneName: meta.sceneName ?? rpg.field?.sceneId ?? null,
    rpg,
  }
}

/** URL の `?resume=` の値 → スロット指定。`0`〜`2` / `quick`。それ以外は null */
export function parseResumeParam(raw: string | null): number | 'quick' | null {
  if (raw === null) return null
  if (raw === 'quick') return 'quick'
  return /^[0-2]$/.test(raw) ? Number(raw) : null
}
