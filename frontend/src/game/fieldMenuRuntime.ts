/**
 * 全画面メニュー (#880) の実行時の配線（どうぐ・まほう・せいとん・せってい）。PixiJS / DOM に触れず、狭い依存 `FieldMenuRuntimeDeps` だけを受けるので単体テストできる
 * （`field/startFieldGame.ts` が実物の RPG 状態を渡す）。計算そのものは `fieldMenuLive.ts`（中身・使う）と `fieldSettings.ts`（せってい）の純粋関数。
 *
 * 持ち物の正本は呼び出し側（パーティ・所持品。戦闘へも持ち越す）。ここが持つのは「せってい」の選択値とせいとんの並びだけで、
 * どちらもセーブ対象（`RpgSaveState.menu`）。
 */
import type { LevelUpDef } from './levelUp'
import type { BattleItemEntry, BattleSkillEntry, BattleSpellEntry } from './battleMenu'
import { screenKindOfItem, type FieldMenuConfig } from './fieldMenu'
import type {
  FieldMenuPartyStat,
  FieldMenuRefresh,
  FieldUseOutcome,
  FieldUseRequest,
} from './FieldMenuScreen'
import {
  applyLiveContent,
  sortItemsByCategory,
  useFieldItem,
  useFieldSpell,
  type FieldUseResult,
  type LiveRpg,
} from './fieldMenuLive'
import { buildConfigOptions, normalizeSettings } from './fieldSettings'
import { safeAssign } from './ownProperty'
import { DEFAULT_CONFIG_OPTIONS, type MenuOption } from './fieldMenuScreens'
import type { AtbMode } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { RpgMenuState } from './rpgSave'
import { changeGear, purchase, saleOf, type GearMenuContext, type MemberDefLike } from './gearMenu'
import type { GearShopConfig, GearState } from './gearShop'
import {
  applyGearStats,
  removeGearStats,
  type GearStatDelta,
  type GearStatsInput,
} from './gearStats'

/** 刀・防具の購入・持ち替えの接続 (#881)。`gearShop` を設定したゲームだけ渡す。正本（状態・所持金・装備列）は呼び出し側 */
export interface FieldMenuGearDeps {
  cfg: GearShopConfig
  getState(): GearState
  setState(state: GearState): void
  getGold(): number
  setGold(gold: number): void
  /** 解禁フラグの現在値 */
  getFlags(): Readonly<Record<string, boolean>>
  /** 人物の装備列を書き換える（持ち替えの結果） */
  setEquipment(member: string, equipment: string[]): void
  /** 通貨名（設定の `battle.currencyName`。省略は「円」） */
  currencyName?: string
  /** 人物 id → 人物の定義（`equipmentSlots` など。装備の枠の計算に使う）。省略・無い人物は既定の枠 */
  memberDefs?(): Readonly<Record<string, MemberDefLike>>
  /** 店の外の装備の id → 種別（武器・防具・盾・兜）。装備列の店の外の品を同じ種類の枠に数える。省略は数えない */
  otherKinds?(): Readonly<Record<string, string>>
}

export interface FieldMenuRuntimeDeps {
  menu: FieldMenuConfig
  items: readonly BattleItemEntry[]
  spells: readonly BattleSpellEntry[]
  /** 味方ごとのレベルアップの定義 (#1161)。魔法の一覧を保存した Lv で味方ごとに絞る */
  levelUp?: Readonly<Record<string, LevelUpDef>>
  skills: readonly BattleSkillEntry[]
  /** 戦闘が ATB のときのバトルモードの既定。無ければターン制（バトルモード・スピードは効かない） */
  atb?: { mode?: AtbMode }
  /** BGM と SE がそれぞれ接続されているか */
  bgm: boolean
  se: boolean | (() => boolean)
  /** 味方の素の値（一枚絵フィールドの `partyState`。装備を含まない） */
  getParty(): BattleEntity[]
  /**
   * 装備の能力値の入力 (#1234)。渡すと、ステータスの表示・どうぐ / まほうの判定と効果を装備込みの味方（戦闘の実値と同じ）で行い、
   * `setParty` には装備を引いた素の値を返す（MP の判定がステータスと一致・回復の上限は装備込みの最大値）。省略は `getParty()` の値のまま
   */
  gearStats?(): GearStatsInput
  setParty(party: BattleEntity[]): void
  getInventory(): Record<string, number>
  setInventory(inv: Record<string, number>): void
  getEquipment(): Record<string, string[]>
  /** 刀・防具の売り物と購入・持ち替え (#881)。無いゲームは渡さない（アプリストア・そうびは枠だけ） */
  gear?: FieldMenuGearDeps
  /** 設定が変わったあとに呼ぶ（会話窓の速さなど、すぐ反映するもの） */
  onSettingsChanged?(settings: Readonly<Record<string, number>>): void
  rng?: () => number
}

export class FieldMenuRuntime {
  private settings: Record<string, number>
  private itemOrder: string[]

  constructor(
    private readonly d: FieldMenuRuntimeDeps,
    saved?: RpgMenuState
  ) {
    // options() が itemOrder を読むので先に入れる
    this.settings = {}
    this.itemOrder = Array.isArray(saved?.itemOrder) ? [...saved.itemOrder] : []
    this.settings = normalizeSettings(saved?.settings, this.options())
  }

  /** いまのせってい（key → 選択肢 index）。コピーを返す */
  get currentSettings(): Record<string, number> {
    return { ...this.settings }
  }

  /** セーブに書く持ち越し。何も変えていなければ undefined（セーブにキーを足さない） */
  saveState(): RpgMenuState | undefined {
    const out: RpgMenuState = {}
    if (Object.keys(this.settings).length > 0) out.settings = { ...this.settings }
    if (this.itemOrder.length > 0) out.itemOrder = [...this.itemOrder]
    return Object.keys(out).length > 0 ? out : undefined
  }

  /** アプリストア・そうびの入力（売り物の定義があるときだけ） */
  private gearCtx(): GearMenuContext | undefined {
    const g = this.d.gear
    if (!g) return undefined
    const names: Record<string, string> = {}
    const descriptions: Record<string, string> = {}
    for (const it of this.d.items) {
      safeAssign(names, it.id, it.name)
      if (it.description) safeAssign(descriptions, it.id, it.description)
    }
    return {
      cfg: g.cfg,
      state: g.getState(),
      gold: g.getGold(),
      flags: g.getFlags(),
      names,
      descriptions,
      ...(g.currencyName ? { currencyName: g.currencyName } : {}),
      ...(g.memberDefs ? { defs: g.memberDefs() } : {}),
      ...(g.otherKinds ? { otherKinds: g.otherKinds() } : {}),
      equipment: this.d.getEquipment(),
      members: this.d.getParty().map((p) => p.id),
    }
  }

  /** 装備込みの味方と足した分。`gearStats` が無ければ素の値のまま（足した分なし） */
  private equipped(): { party: BattleEntity[]; deltas: Record<string, GearStatDelta> } {
    const input = this.d.gearStats?.()
    return input
      ? applyGearStats(this.d.getParty(), input)
      : { party: this.d.getParty(), deltas: {} }
  }

  private rpg(party: BattleEntity[] = this.equipped().party): LiveRpg {
    const gear = this.gearCtx()
    return {
      ...(gear ? { gear } : {}),
      party,
      items: this.d.items,
      inventory: this.d.getInventory(),
      itemOrder: this.itemOrder,
      spells: this.d.spells,
      levelUp: this.d.levelUp,
      skills: this.d.skills,
      equipment: this.d.getEquipment(),
    }
  }

  /** メニュー項目の定義（実状態から作った content 込み）。開くとき・使ったあとに作り直す */
  items() {
    return applyLiveContent(this.d.menu.items, (d) => screenKindOfItem(d), {
      rpg: this.rpg(),
      configOptions: buildConfigOptions(
        {
          atb: !!this.d.atb,
          bgm: this.d.bgm,
          se: typeof this.d.se === 'function' ? this.d.se() : this.d.se,
        },
        this.d.atb?.mode ?? 'wait'
      ),
    })
  }

  /** 実際に使う「せってい」の項目（定義側の独自 options を含む）。値の許可キー・選択肢数はこれで決める */
  private options(): readonly MenuOption[] {
    const cfg = this.items().find((d) => screenKindOfItem(d) === 'config')
    return cfg?.content?.options ?? DEFAULT_CONFIG_OPTIONS
  }

  private partyStats(): FieldMenuPartyStat[] {
    // 装備を持ち替えた直後も、ステータスの ちから・まもり・すばやさ が戦闘の実値と同じになる (#1234)
    return this.equipped().party.map((p) => ({
      id: p.id,
      hp: p.hp,
      maxHp: p.maxHp,
      mp: p.mp,
      maxMp: p.maxMp,
      atk: p.atk,
      def: p.def,
      agi: p.agi,
      ...(p.level !== undefined ? { level: p.level } : {}),
    }))
  }

  private outcome(r: FieldUseResult, deltas: Record<string, GearStatDelta>): FieldUseOutcome {
    if (r.ok) {
      // 装備込みで計算した結果から足した分を引いて素の値へ戻す（現在 HP / MP は絶対値のまま）
      this.d.setParty(removeGearStats(r.party, deltas))
      this.d.setInventory(r.inventory)
    }
    return { ok: r.ok, notice: r.notice, items: this.items(), party: this.partyStats() }
  }

  /** どうぐ・まほうを使う。対応しない項目・要求は null（画面は「まだありません」を出す） */
  use(req: FieldUseRequest): FieldUseOutcome | null {
    const def = this.d.menu.items.find((i) => i.id === req.screen)
    if (!def || req.entryId === undefined) return null
    const kind = screenKindOfItem(def)
    const g = this.d.gear
    if (g && (kind === 'appstore' || kind === 'equip')) {
      if (req.casterId === undefined) return null
      const ctx = this.gearCtx() as GearMenuContext
      if (kind === 'appstore') {
        const r =
          req.tabAction === 'sell'
            ? saleOf(ctx, req.casterId, req.entryId)
            : purchase(ctx, req.casterId, req.entryId)
        if (r.ok) {
          g.setState(r.state)
          g.setGold(r.gold)
        }
        return { ok: r.ok, notice: r.notice, items: this.items(), party: this.partyStats() }
      }
      const r = changeGear(ctx, req.casterId, req.entryId)
      if (r.ok) {
        g.setState(r.state)
        g.setEquipment(req.casterId, r.equipment)
      }
      return { ok: r.ok, notice: r.notice, items: this.items(), party: this.partyStats() }
    }
    const eq = this.equipped()
    const rpg = this.rpg(eq.party)
    const rng = this.d.rng ?? Math.random
    if (screenKindOfItem(def) === 'item')
      return this.outcome(useFieldItem(rpg, req.entryId, req.targetId, rng), eq.deltas)
    if (def.id === 'magic' && req.casterId !== undefined)
      return this.outcome(
        useFieldSpell(rpg, req.entryId, req.casterId, req.targetId, rng),
        eq.deltas
      )
    return null
  }

  /** せいとん: 種類別に並べ替える（所持品の順を覚える） */
  sort(): FieldMenuRefresh {
    this.itemOrder = sortItemsByCategory(this.d.items, this.itemOrder)
    return { items: this.items() }
  }

  /** せっていが変わった */
  setSetting(key: string, value: number): void {
    const next = normalizeSettings({ ...this.settings, [key]: value }, this.options())
    this.settings = next
    this.d.onSettingsChanged?.(this.settings)
  }
}
