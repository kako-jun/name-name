/**
 * 一枚絵フィールドの「冒頭の戦闘」の素材の先読み (#1219)。DOM / PixiJS に依存しない純関数と、読み込み関数を注入する薄い実行部だけ。
 * 場面に入ったとたん（`auto` のトリガー）に必ず戦闘へ入る作品で、戦闘画面が開いてから素材を読み始めると、
 * 背景・敵・味方が数秒そろわず上半分が黒くなる。フィールドを見せている間に、同じ URL を先に読んでおく
 * （PixiJS の `Assets` は URL で読み込みをキャッシュ・合流させるので、戦闘画面の `Assets.load` はそれに乗る）。
 *
 * 先読みは「あれば得」だけの最適化。1 枚読めなくても・全部読めなくても、戦闘は従来どおり始まる（失敗は握りつぶして警告もしない。
 * 戦闘画面が自分で読み直して、従来どおりの警告とフォールバックを出す）。
 */
import type { BattleEntity } from '../game/spellDsl'
import type { BattleScriptDef, EventCommand, MonsterDef } from '../types'
import type { FieldTrigger } from './config'
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
 * 戦闘 1 つぶんの先読み対象 URL（重複なし・読みたい順）。順は 背景 → 敵 → 味方 → エフェクト・UI。
 * 敵は `敵:` に書かれた種類を個数の抽選なしで全部挙げる（個数が決まる前なので、抽選結果と食い違っても同じ絵を使うだけ）。
 * 味方は持ち越し中の全員（途中参戦も含む。戦闘画面が読むのと同じ集合）
 */
export function collectBattlePreloadUrls(input: {
  def: Pick<BattleScriptDef, 'enemies'>
  monsters: Readonly<Record<string, MonsterDef>>
  party: readonly Pick<BattleEntity, 'sprite' | 'poses' | 'weapon'>[]
  background?: string
  effectImages?: readonly string[]
  uiImages?: readonly (string | undefined)[]
}): string[] {
  const urls: string[] = []
  if (input.background) urls.push(input.background)
  if (input.def.enemies) {
    const group = parseEncounterGroup(input.def.enemies.replace(/[,、，]/g, '+'))
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
