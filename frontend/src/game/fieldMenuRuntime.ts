/**
 * 全画面メニュー (#880) の実行時の配線（どうぐ・まほう・せいとん・せってい）。PixiJS / DOM に触れず、狭い依存 `FieldMenuRuntimeDeps` だけを受けるので単体テストできる
 * （`fieldSample/main.ts` が実物の RPG 状態を渡す）。計算そのものは `fieldMenuLive.ts`（中身・使う）と `fieldSettings.ts`（せってい）の純粋関数。
 *
 * 持ち物の正本は呼び出し側（パーティ・所持品。戦闘へも持ち越す）。ここが持つのは「せってい」の選択値とせいとんの並びだけで、
 * どちらもセーブ対象（`RpgSaveState.menu`）。
 */
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
import type { AtbMode } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { RpgMenuState } from './rpgSave'

export interface FieldMenuRuntimeDeps {
  menu: FieldMenuConfig
  items: readonly BattleItemEntry[]
  spells: readonly BattleSpellEntry[]
  skills: readonly BattleSkillEntry[]
  /** 戦闘が ATB のときのバトルモードの既定。無ければターン制（バトルモード・スピードは効かない） */
  atb?: { mode?: AtbMode }
  /** BGM・SE を再生する面があるか（いまは一枚絵フィールド・戦闘とも無い） */
  audio: boolean
  getParty(): BattleEntity[]
  setParty(party: BattleEntity[]): void
  getInventory(): Record<string, number>
  setInventory(inv: Record<string, number>): void
  getEquipment(): Record<string, string[]>
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
    this.settings = normalizeSettings(saved?.settings)
    this.itemOrder = Array.isArray(saved?.itemOrder) ? [...saved.itemOrder] : []
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

  private rpg(): LiveRpg {
    return {
      party: this.d.getParty(),
      items: this.d.items,
      inventory: this.d.getInventory(),
      itemOrder: this.itemOrder,
      spells: this.d.spells,
      skills: this.d.skills,
      equipment: this.d.getEquipment(),
    }
  }

  /** メニュー項目の定義（実状態から作った content 込み）。開くとき・使ったあとに作り直す */
  items() {
    return applyLiveContent(this.d.menu.items, (d) => screenKindOfItem(d), {
      rpg: this.rpg(),
      configOptions: buildConfigOptions(
        { atb: !!this.d.atb, audio: this.d.audio },
        this.d.atb?.mode ?? 'wait'
      ),
    })
  }

  private partyStats(): FieldMenuPartyStat[] {
    return this.d.getParty().map((p) => ({
      id: p.id,
      hp: p.hp,
      maxHp: p.maxHp,
      mp: p.mp,
      maxMp: p.maxMp,
      ...(p.level !== undefined ? { level: p.level } : {}),
    }))
  }

  private outcome(r: FieldUseResult): FieldUseOutcome {
    if (r.ok) {
      this.d.setParty(r.party)
      this.d.setInventory(r.inventory)
    }
    return { ok: r.ok, notice: r.notice, items: this.items(), party: this.partyStats() }
  }

  /** どうぐ・まほうを使う。対応しない項目・要求は null（画面は「まだありません」を出す） */
  use(req: FieldUseRequest): FieldUseOutcome | null {
    const def = this.d.menu.items.find((i) => i.id === req.screen)
    if (!def || req.entryId === undefined) return null
    const rpg = this.rpg()
    const rng = this.d.rng ?? Math.random
    if (screenKindOfItem(def) === 'item')
      return this.outcome(useFieldItem(rpg, req.entryId, req.targetId, rng))
    if (def.id === 'magic' && req.casterId !== undefined)
      return this.outcome(useFieldSpell(rpg, req.entryId, req.casterId, req.targetId, rng))
    return null
  }

  /** せいとん: 種類別に並べ替える（所持品の順を覚える） */
  sort(): FieldMenuRefresh {
    this.itemOrder = sortItemsByCategory(this.d.items, this.itemOrder)
    return { items: this.items() }
  }

  /** せっていが変わった */
  setSetting(key: string, value: number): void {
    const next = normalizeSettings({ ...this.settings, [key]: value })
    this.settings = next
    this.d.onSettingsChanged?.(this.settings)
  }
}
