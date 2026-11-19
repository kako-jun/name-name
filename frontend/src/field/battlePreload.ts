/**
 * 一枚絵フィールドの戦闘・場面の素材の先読み。DOM / PixiJS に依存しない純関数と、読み込み関数を注入する薄い実行部だけ。
 *
 * - 冒頭の戦闘 (#1219): 場面に入ったとたん（`auto` のトリガー）に必ず戦闘へ入る作品で、戦闘画面が開いてから素材を読み始めると、
 *   背景・敵・味方が数秒そろわず上半分が黒くなる。フィールドを見せている間に、同じ URL を先に読んでおく。
 * - エンカウントと隣の場面 (#1241): いまの場面の `エンカウント群` の敵・戦闘背景・味方の絵を、場面に入ったら先に読む
 *   （初めての敵が読み込み前の色の四角で登場しないように）。続けて、端の出口（`links`）でつながる隣の場面の背景・マスク・前面と、
 *   その場面のエンカウントの絵も読む。隣より先は読まない（通信量の上限）。場面を移ったら、移った先を中心に読み直す。
 *
 * PixiJS の `Assets` は URL で読み込みをキャッシュ・合流させるので、戦闘画面の `Assets.load` は先読みに乗る。
 * 先読みは「あれば得」だけの最適化。1 枚読めなくても・全部読めなくても、戦闘も場面の移動も従来どおり始まる
 * （戦闘画面・場面の読み込みが自分で読み直して、従来どおりの警告とフォールバックを出す）。
 */
import type { BattleEntity } from '../game/spellDsl'
import type { EventCommand, MonsterDef } from '../types'
import type { FieldSceneConfig, FieldTrigger } from './config'
import { posesField } from '../game/battleMotion'
import { parseEncounterGroup } from '../game/enemyGroup'
import { hasOwn } from '../game/ownProperty'
import { autoTriggers } from './triggerRuntime'

/**
 * 開始場面に入った直後に起こす `auto` のトリガー（書いた順）が最初に始める戦闘の id。無ければ undefined。
 * 判定は本番と同じ `autoTriggers`（once の記録は空・再開直後は起こさない）。脚本の読み込み・警告は本番側の仕事なので、ここでは何も警告しない
 */
export function firstAutoBattleId(input: {
  sceneId: string
  triggers: readonly FieldTrigger[]
  events: ReadonlyMap<string, EventCommand[]> | undefined
  resumedStart: boolean
}): string | undefined {
  if (!input.events) return undefined
  const fired = autoTriggers({
    sceneId: input.sceneId,
    triggers: input.triggers,
    onceFired: new Set(),
    resumedStart: input.resumedStart,
  })
  for (const t of fired) {
    for (const c of input.events.get(t.event) ?? []) if (c.type === 'Battle') return c.id
  }
  return undefined
}

/** 戦闘画面が `Assets.load` で読む、1 体ぶんの絵（1 枚絵・ポーズ・刀の絵） */
function entityImages(e: {
  sprite?: string
  poses?: Readonly<Record<string, string | undefined>>
  weapon?: { image?: string }
}): string[] {
  const out: string[] = []
  if (e.sprite) out.push(e.sprite)
  for (const p of Object.values(e.poses ?? {})) if (p) out.push(p)
  if (e.weapon?.image) out.push(e.weapon.image)
  return out
}

/**
 * 戦闘の先読み対象 URL（重複なし・読みたい順）。順は 背景 → 敵 → 味方 → エフェクト・UI。
 * `enemyGroups` は敵の群の書式の文字列の並び（脚本の戦闘の `敵:`、場面の `エンカウント群` の各群。`,` `、` も `+` と同じに読む）。
 * 敵は群に書かれた種類を個数・群の抽選なしで全部挙げる（抽選の前なので、抽選結果と食い違っても同じ絵を使うだけ）。
 * 味方は持ち越し中の全員（途中参戦も含む。戦闘画面が読むのと同じ集合）
 */
export function collectBattlePreloadUrls(input: {
  enemyGroups: readonly (string | undefined)[]
  monsters: Readonly<Record<string, MonsterDef>>
  party: readonly Pick<BattleEntity, 'sprite' | 'poses' | 'weapon'>[]
  background?: string
  effectImages?: readonly string[]
  uiImages?: readonly (string | undefined)[]
}): string[] {
  const urls: string[] = []
  if (input.background) urls.push(input.background)
  for (const spec of input.enemyGroups) {
    if (!spec) continue
    const group = parseEncounterGroup(spec.replace(/[,、，]/g, '+'))
    for (const item of group.items)
      if (hasOwn(input.monsters, item.id)) {
        const m = input.monsters[item.id]
        // 敵の絵の指定は戦闘への組み立て（buildEnemyEntities）と同じ正規化を通す
        urls.push(...entityImages({ sprite: m.sprite, ...posesField(m.poses) }))
      }
  }
  for (const p of input.party) urls.push(...entityImages(p))
  urls.push(...(input.effectImages ?? []))
  for (const u of input.uiImages ?? []) if (u) urls.push(u)
  return [...new Set(urls)]
}

/**
 * 先読みを実行する。`load` は 1 URL を読んで解決する関数（本番は `Assets.load`）。
 * 返す Promise は必ず解決する（1 枚の失敗が他を止めない・呼び出し側へ例外を出さない）。読めた枚数を返す
 */
export async function preloadBattleImages(
  urls: readonly string[],
  load: (url: string) => Promise<unknown>
): Promise<number> {
  const results = await Promise.allSettled(urls.map((u) => load(u)))
  return results.filter((r) => r.status === 'fulfilled').length
}

/** 場面のランダムエンカウントで出うる群（率 0・エンカウントなしは空。戦闘の抽選と同じ `encounter.groups`） */
export function sceneEncounterGroups(scene: Pick<FieldSceneConfig, 'encounter'>): string[] {
  const enc = scene.encounter
  return enc && enc.rate > 0 ? [...enc.groups] : []
}

/**
 * 端の出口（`links`）でつながる隣の場面の id（重複なし・書いた順。自分自身と、設定に無い場面は除く）。
 * ワープ（`warps`）・脚本の `[場面移動:]` の行き先は含めない（端の隣だけを先読みの範囲にする）
 */
export function neighborSceneIds(
  scenes: Readonly<Record<string, Pick<FieldSceneConfig, 'links'>>>,
  sceneId: string
): string[] {
  if (!hasOwn(scenes, sceneId)) return []
  const out: string[] = []
  for (const l of scenes[sceneId].links)
    if (l.to !== sceneId && hasOwn(scenes, l.to) && !out.includes(l.to)) out.push(l.to)
  return out
}

/** 場面のまわりの先読みに使う読み込み関数（本番は startFieldGame が PixiJS・場面の cache につなぐ） */
export interface FieldPreloadDeps {
  /** 戦闘で使う絵の URL（場面ごと。いまの味方・エフェクト・UI も含めて組み立てる） */
  battleUrls: (sceneId: string) => string[]
  /** 1 枚読む（本番は `Assets.load`） */
  loadImage: (url: string) => Promise<unknown>
  /** 隣の場面（背景・マスク・前面・流れる景色）を読む（本番は場面の cache `ensureScene`。読めた場面は移動のときそのまま使う） */
  loadScene: (sceneId: string) => Promise<unknown>
  /** 隣の場面の id */
  neighbors: (sceneId: string) => string[]
  /** 先読みの失敗の警告（本番は console.warn） */
  warn: (message: string) => void
}

/**
 * 場面のまわりの素材の先読み (#1241)。`around(sceneId)` を場面に入るたびに呼ぶ。読む順は
 * ① いまの場面の戦闘の絵 → ② 隣の場面（背景・マスク・前面）→ ③ 隣の場面の戦闘の絵。段ごとに前の段を待つ（いまの場面を先に済ませる）。
 * 段の中は同時に読む。別の場面へ移って `around` が呼ばれ直したら、古い呼び出しは次の段へ進まない（読み始めた分は捨てない）。
 * 同じ URL・場面の読み込みは 1 本の Promise を共有する: 前の場面の呼び出しが読み始めた絵も、新しい呼び出しはその完了を待ってから次の段へ進む
 * （読み込み中だからと飛ばすと、いまの場面の絵と隣の素材が回線を取り合う）。読めたものは読み直さず、失敗したものは共有から外して次の呼び出しで読み直す。
 * 失敗は 1 件につき 1 回警告して先へ進む。返す Promise は必ず解決する。`stop()` のあとは何も読まない（フィールドの破棄時に呼ぶ）
 */
export function createFieldPreloader(deps: FieldPreloadDeps): {
  around: (sceneId: string) => Promise<void>
  stop: () => void
} {
  let generation = 0
  let stopped = false
  const images = new Map<string, Promise<void>>()
  const scenes = new Map<string, Promise<void>>()
  /** key の読み込みを共有する。失敗は警告して共有から外す（次の呼び出しで読み直す）。返す Promise は必ず解決する */
  const shared = (
    table: Map<string, Promise<void>>,
    key: string,
    load: () => Promise<unknown>,
    warning: (e: unknown) => string
  ): Promise<void> => {
    let p = table.get(key)
    if (!p) {
      p = Promise.resolve()
        .then(load)
        .then(
          () => {},
          (e: unknown) => {
            table.delete(key)
            deps.warn(warning(e))
          }
        )
      table.set(key, p)
    }
    return p
  }
  const loadImages = async (urls: readonly string[]): Promise<void> => {
    await Promise.all(
      [...new Set(urls)].map((u) =>
        shared(
          images,
          u,
          () => deps.loadImage(u),
          (e) =>
            `[field] 戦闘の絵を先読みできません（戦闘が開いたとき読み直します）: ${u} ${describe(e)}`
        )
      )
    )
  }
  const loadScenes = async (ids: readonly string[]): Promise<void> => {
    await Promise.all(
      ids.map((id) =>
        shared(
          scenes,
          id,
          () => deps.loadScene(id),
          (e) => `[field] 隣の場面 ${id} を先読みできません（移るとき読み直します）: ${describe(e)}`
        )
      )
    )
  }
  return {
    around: async (sceneId) => {
      if (stopped) return
      const gen = ++generation
      const current = () => !stopped && gen === generation
      try {
        await loadImages(deps.battleUrls(sceneId))
        if (!current()) return
        const next = deps.neighbors(sceneId)
        await loadScenes(next)
        if (!current()) return
        await loadImages(next.flatMap((id) => deps.battleUrls(id)))
      } catch (e) {
        // 読み込みの失敗は shared が警告して握るので、ここに来るのは組み立て側（battleUrls・neighbors）の想定外の例外だけ。
        // それも警告するだけ（歩行・戦闘を止めない）
        deps.warn(`[field] 先読みを中断しました: ${describe(e)}`)
      }
    },
    stop: () => {
      stopped = true
    },
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
