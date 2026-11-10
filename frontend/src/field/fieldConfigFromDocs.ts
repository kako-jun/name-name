/**
 * parse 済みの複数 md から一枚絵フィールドの `FieldConfig` を作る統合 (#1129 / 親 #1096 S3e)。
 *
 * 流れ: docs → `collectFieldNotation`(S3c)→ `buildFieldRaw`(S3d)→ `expandCharacterForms`(目録は `aux`)→ `parseConfig`
 * (`scriptProvided`)。警告は全部 `config.warnings` に入れ、JSON パス表記は md の書き方に言い換える(`describeWarning`)。
 *
 * - `fieldConfigFromDocs` … 同期・純関数。取得は一切しない(目録・`battle_effects`・メニューの `中身=` は `aux` で受ける)
 * - `loadFieldConfig` … 非同期。取得処理は `deps` で注入する。hidden を含む全 md を集め、`missingScenes` が空になるまで
 *   (上限つきで)追加ロードし、必要な JSON を取って `fieldConfigFromDocs` を呼ぶ
 *
 * 返り値の `raw` は展開前の raw で、`field.html?config=` にそのまま渡せる(手書き JSON との A/B に使う)。
 */
import { resolveRpgDataPath } from '../game/battleEffectsLoader'
import type { FieldScriptEvents } from '../game/fieldScript'
import type { BattleScriptDef } from '../types'
import {
  expandCharacterForms,
  parseCharacterFormsManifest,
  type CharacterFormsManifest,
} from './characterForms'
import { parseConfig, type FieldConfig } from './config'
import { describeWarnings } from './describeWarning'
import {
  collectFieldNotation,
  type FieldEntry,
  type FieldNotation,
  type FieldSourceDoc,
} from './fieldNotation'
import { buildFieldRaw } from './fieldRaw'

export type { FieldEntry, FieldSourceDoc } from './fieldNotation'

/** 追加ロード(`missingScenes` の解消)を繰り返す上限。これを超えたら警告して止める */
export const MAX_SCENE_LOAD_ROUNDS = 10

export interface FieldConfigInput {
  /** 読み込み済みの md 全部。順序は関数内で「エントリ(entryPath)→path 昇順」に整える(遅延ロードの到着順に依存させない) */
  docs: readonly FieldSourceDoc[]
  entryPath: string
  entry: FieldEntry
  /** `${apiBase}/api/projects/<name>/assets/raw`。raw.assetBaseUrl にそのまま入る */
  assetBaseUrl: string
  /** 相対 URL の解決基準(通常 location.href)。parseConfig の第2引数 */
  baseUrl: string
  /** ホストが持つ現在のフラグ値。宣言済みの名前だけ初期値に重ねる。省略 = 全部 false */
  flags?: Readonly<Record<string, boolean>>
  /** セーブの形態指定(メンバー id → form)。expandCharacterForms に渡す。省略 = {} */
  savedForms?: Readonly<Record<string, string>>
  /** 事前取得した JSON(取得は loadFieldConfig の仕事)。無ければ該当機能は警告して無効 */
  aux?: {
    /** 人物の形態の目録(`[人物の形態 目録=…]` の中身) */
    characterForms?: CharacterFormsManifest
    /** frontmatter `battle_effects` の JSON の中身 */
    battleEffects?: unknown
    /** `[メニュー項目 … 中身=path]` の path → JSON の中身 */
    menuContents?: Readonly<Record<string, unknown>>
  }
}

/** 取得が要るもの 1 件。`path` は md に書かれたデータパス(`aux.menuContents` のキー)、`url` は取得先 */
export interface FieldAuxNeed {
  path: string
  url: string
}

export interface FieldAuxNeeds {
  /** 人物の形態の目録 */
  manifest?: FieldAuxNeed
  /** frontmatter `battle_effects` */
  battleEffects?: FieldAuxNeed
  /** `[メニュー項目 … 中身=path]`(path の重複なし) */
  menuContents: FieldAuxNeed[]
}

export interface FieldBuildOutput {
  /** `warnings` を全部 `config.warnings` に入れてある(`configNotice` がそのまま使える) */
  config: FieldConfig
  /** parseConfig に渡す前の raw(展開前)。`field.html?config=` に流せる形 */
  raw: unknown
  /** 全 md の `[イベント]`(先勝ち)。startFieldGame の `scriptEvents` に渡す */
  npcEvents: FieldScriptEvents
  /** 全 md の `[戦闘 id]` の宣言(先勝ち)。startFieldGame の `battleScripts` に渡す (#1073) */
  battleScripts: Record<string, BattleScriptDef>
  /** 不足している取得物 */
  needs: FieldAuxNeeds
  /** 端/ワープの行き先で docs に無かった場面 ID(loadFieldConfig が追加ロードして再実行する) */
  missingScenes: string[]
}

export type FieldBuildResult =
  | { ok: true; value: FieldBuildOutput; warnings: string[] }
  | { ok: false; error: string; warnings: string[] }

/** 収集と、取得が要るものの洗い出しだけ(raw は組まない)。loadFieldConfig の再試行ループが使う */
export function planFieldNeeds(
  input: Pick<FieldConfigInput, 'docs' | 'entryPath' | 'entry' | 'assetBaseUrl'>
): { notation: FieldNotation; warnings: string[]; needs: FieldAuxNeeds; missingScenes: string[] } {
  const { notation, warnings } = collectFieldNotation({
    docs: input.docs,
    entryPath: input.entryPath,
    entry: input.entry,
  })
  const need = (path: string): FieldAuxNeed => ({
    path,
    url: resolveRpgDataPath(input.assetBaseUrl, path),
  })
  const needs: FieldAuxNeeds = { menuContents: [] }
  if (notation.characterForms) needs.manifest = need(notation.characterForms.catalog)
  const fx = notation.entryDoc?.battle_effects
  if (typeof fx === 'string' && fx !== '') needs.battleEffects = need(fx)
  const seen = new Set<string>()
  for (const o of notation.menuItems) {
    if (o.content === undefined || seen.has(o.content)) continue
    seen.add(o.content)
    needs.menuContents.push(need(o.content))
  }
  return { notation, warnings, needs, missingScenes: notation.missingScenes }
}

export function fieldConfigFromDocs(input: FieldConfigInput): FieldBuildResult {
  const plan = planFieldNeeds(input)
  const warnings: string[] = [...plan.warnings]
  const built = buildFieldRaw(plan.notation, {
    assetBaseUrl: input.assetBaseUrl,
    flags: input.flags,
    aux: { battleEffects: input.aux?.battleEffects, menuContents: input.aux?.menuContents },
  })
  warnings.push(...built.warnings)
  if (!built.ok) return { ok: false, error: built.error, warnings }
  if (!input.aux?.characterForms)
    return {
      ok: false,
      error: `人物の形態の目録${plan.needs.manifest ? ` '${plan.needs.manifest.path}'` : ''} を取得できません（[人物の形態 目録=…] のパスを確認してください）`,
      warnings,
    }

  const expanded = expandCharacterForms(built.raw, input.aux.characterForms, input.savedForms ?? {})
  warnings.push(...describeWarnings(expanded.warnings, built.raw))
  const parsed = parseConfig(expanded.raw, input.baseUrl, { scriptProvided: true })
  if (!parsed.ok)
    return {
      ok: false,
      error: describeWarnings([parsed.error], built.raw)[0],
      warnings,
    }
  warnings.push(...describeWarnings(parsed.value.warnings ?? [], built.raw))

  const config: FieldConfig = { ...parsed.value }
  if (warnings.length > 0) config.warnings = [...warnings]
  else delete config.warnings
  return {
    ok: true,
    value: {
      config,
      raw: built.raw,
      npcEvents: plan.notation.npcEvents,
      battleScripts: plan.notation.master.battleScripts,
      needs: plan.needs,
      missingScenes: plan.missingScenes,
    },
    warnings,
  }
}

export interface FieldLoadDeps {
  /** 場面 ID を含む md を探してロードする(PlayerScreen の resolveMissingSceneAcrossDocs 相当)。見つからなければ null */
  resolveScene(sceneId: string): Promise<FieldSourceDoc[] | null>
  /**
   * hidden な md も含む全 md(data.md など作品全体の設定の置き場)。
   * 取得の失敗は他の取得物と違い警告でなく error で止める(一覧が欠けたまま黙って進まないため。全 md の一覧取得の失敗だけ error)
   */
  loadAllDocs(): Promise<FieldSourceDoc[]>
  /** JSON の取得(目録・battle_effects・メニューの中身) */
  fetchJson(url: string): Promise<unknown>
}

export type FieldLoadInput = Omit<FieldConfigInput, 'docs' | 'aux'> & {
  /** 既に読んでいる md(エントリなど)。無くても loadAllDocs が全部返せばよい */
  docs?: readonly FieldSourceDoc[]
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * docs 集め → 不足場面の追加ロード(`MAX_SCENE_LOAD_ROUNDS` 回まで)→ 必要な JSON の取得 → `fieldConfigFromDocs`。
 * 取得の失敗は致命にせず警告にする(目録だけは無いと主人公の歩行絵を導けないので、`fieldConfigFromDocs` が error にする)。
 */
export async function loadFieldConfig(
  input: FieldLoadInput,
  deps: FieldLoadDeps
): Promise<FieldBuildResult> {
  const loadWarnings: string[] = []
  const byPath = new Map<string, FieldSourceDoc>()
  const add = (list: readonly FieldSourceDoc[]) => {
    for (const d of list) if (!byPath.has(d.path)) byPath.set(d.path, d)
  }
  add(input.docs ?? [])
  try {
    add(await deps.loadAllDocs())
  } catch (e) {
    return {
      ok: false,
      error: `md の一覧を読めません: ${errText(e)}`,
      warnings: loadWarnings,
    }
  }

  // 不足している場面を、増えなくなるか上限まで追加ロードする
  const tried = new Set<string>()
  let plan = planFieldNeeds({ ...input, docs: [...byPath.values()] })
  for (let round = 0; ; round++) {
    const pending = plan.missingScenes.filter((id) => !tried.has(id))
    if (pending.length === 0) break
    if (round >= MAX_SCENE_LOAD_ROUNDS) {
      loadWarnings.push(
        `場面の追加ロードが上限（${MAX_SCENE_LOAD_ROUNDS} 回）に達したため止めました（まだ見つからない場面: ${pending.join(', ')}）`
      )
      break
    }
    for (const id of pending) {
      tried.add(id)
      try {
        const found = await deps.resolveScene(id)
        if (found) add(found)
      } catch (e) {
        loadWarnings.push(`場面 '${id}' を含む md を読めませんでした: ${errText(e)}`)
      }
    }
    plan = planFieldNeeds({ ...input, docs: [...byPath.values()] })
  }

  // 必要な JSON を取る
  const fetched = async (need: FieldAuxNeed, what: string): Promise<unknown> => {
    try {
      return await deps.fetchJson(need.url)
    } catch (e) {
      loadWarnings.push(`${what} '${need.path}' を取得できませんでした: ${errText(e)}`)
      return undefined
    }
  }
  const aux: NonNullable<FieldConfigInput['aux']> = {}
  if (plan.needs.manifest) {
    const json = await fetched(plan.needs.manifest, '人物の形態の目録')
    if (json !== undefined) {
      const m = parseCharacterFormsManifest(json)
      if (m.ok) aux.characterForms = m.value
      else
        loadWarnings.push(`人物の形態の目録 '${plan.needs.manifest.path}' が不正です: ${m.error}`)
    }
  }
  if (plan.needs.battleEffects)
    aux.battleEffects = await fetched(plan.needs.battleEffects, 'battle_effects')
  if (plan.needs.menuContents.length > 0) {
    const contents: Record<string, unknown> = {}
    for (const n of plan.needs.menuContents) {
      const json = await fetched(n, 'メニューの中身')
      if (json !== undefined)
        Object.defineProperty(contents, n.path, { value: json, enumerable: true })
    }
    aux.menuContents = contents
  }

  const result = fieldConfigFromDocs({ ...input, docs: [...byPath.values()], aux })
  if (loadWarnings.length === 0) return result
  const warnings = [...loadWarnings, ...result.warnings]
  if (!result.ok) return { ...result, warnings }
  return {
    ok: true,
    value: { ...result.value, config: { ...result.value.config, warnings: [...warnings] } },
    warnings,
  }
}
