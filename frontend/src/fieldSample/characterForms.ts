/**
 * 人物の形態（時期・車椅子）から、戦闘ポーズ `poses` と歩行絵 `player.sprites` を命名規則で導く (#1020)。DOM / PixiJS に依存しない純関数。
 *
 * 絵のファイル名は sit-by-me の規則 `{C}-{form}-{pose}.webp`（`poses/`）・`{C}-{form}-walk-{dir}-{n}.webp`（`walk/`）に従う。
 * `form` は時期（kindergarten / elementary / uniform / teen / adult / midlife）に、車椅子なら `-wheelchair` を続けたもの。
 * 人物単体版（刀・演出の絵を含まない）は `{C}-{form}-character-{pose}.webp`。
 *
 * 「どの形態にどの絵があるか」は台帳駆動の目録（`sit-character-forms.json`。`frontend/scripts/gen_sit_character_forms.py` が
 * sit-by-me のファイルから生成する）で決める。絵のファイル名を設定 JSON に手で並べない。
 *
 * 設定の `characterForms`（`{ root, manifestUrl }`）が宣言されたとき、読み込み前の生の設定 JSON に対して
 * `expandCharacterForms` が `party[].poses` と `player.sprites`（歩行周期つき）を埋める。形態は次の順で決まる:
 *   1. セーブ（`rpg.party[].form`）の指定  2. 設定の `party[].form`（既定）
 * 設定の party 側 `form` を書いた者は、セーブで形態を差し替えられる（時期・車椅子が変わった局面の再開）。
 */
import { BATTLE_POSES, type BattlePose } from '../game/battleMotion'
import { hasOwn } from '../game/ownProperty'

/** 導出に使うポーズ（エンジンが受理する全種。special・swing-* は #1026） */
export const DERIVED_POSES: readonly BattlePose[] = BATTLE_POSES

/** 「揃っている」の基準になる基本の 8 ポーズ。special・swing-* は無くても揃っている扱い（あれば導出に含め、無ければエンジンが近い絵に落とす） */
export const CORE_POSES: readonly BattlePose[] = [
  'idle',
  'ready',
  'step',
  'slash',
  'cast',
  'hurt',
  'down',
  'victory',
]

/** 人物単体版（-character）か、そうでない版（plain）か */
export type PoseVariant = 'character' | 'plain'

export interface FormEntry {
  /** 版ごとに、実在するポーズ名（DERIVED_POSES の部分集合） */
  poses: Partial<Record<PoseVariant, BattlePose[]>>
  /** 歩行 8 方向×3 コマが揃っているか */
  walk: boolean
}

export interface CharacterFormsManifest {
  characters: Record<
    string,
    {
      /**
       * plain（`-character` でない版）に、刀・斬撃の軌跡を絵へ焼き込んだ版が混じり得る人物（C001）。
       * true の人物は plain を使わない（人物単体版が 8 ポーズ揃った形態だけ導出する）。無い・false は plain も使える
       */
      plainBaked?: boolean
      forms: Record<string, FormEntry>
    }
  >
}

/** 歩行の向き（設定のキー）→ ファイル名の向き */
export const WALK_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['up', 'up'],
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
  ['upLeft', 'upleft'],
  ['upRight', 'upright'],
  ['downLeft', 'downleft'],
  ['downRight', 'downright'],
]

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 目録 JSON を検証して型にする。不正なら理由つきで失敗（不正な項目は黙って落とさず失敗にする） */
export function parseCharacterFormsManifest(
  raw: unknown
): { ok: true; value: CharacterFormsManifest } | { ok: false; error: string } {
  if (!isObj(raw) || !isObj(raw.characters)) return { ok: false, error: 'characters が必要です' }
  const characters: CharacterFormsManifest['characters'] = {}
  for (const [cid, c] of Object.entries(raw.characters)) {
    if (!isObj(c) || !isObj(c.forms))
      return { ok: false, error: `characters.${cid}.forms が必要です` }
    const forms: Record<string, FormEntry> = {}
    for (const [fid, f] of Object.entries(c.forms)) {
      if (!isObj(f) || !isObj(f.poses) || typeof f.walk !== 'boolean')
        return { ok: false, error: `characters.${cid}.forms.${fid} は { poses, walk } が必要です` }
      const poses: FormEntry['poses'] = {}
      for (const v of ['character', 'plain'] as const) {
        const list = f.poses[v]
        if (list === undefined) continue
        if (
          !Array.isArray(list) ||
          !list.every(
            (p) => typeof p === 'string' && (DERIVED_POSES as readonly string[]).includes(p)
          )
        )
          return {
            ok: false,
            error: `characters.${cid}.forms.${fid}.poses.${v} は ${DERIVED_POSES.join(' / ')} の配列が必要です`,
          }
        poses[v] = list as BattlePose[]
      }
      forms[fid] = { poses, walk: f.walk }
    }
    if (c.plainBaked !== undefined && typeof c.plainBaked !== 'boolean')
      return { ok: false, error: `characters.${cid}.plainBaked は真偽値が必要です` }
    characters[cid] = { ...(c.plainBaked ? { plainBaked: true } : {}), forms }
  }
  return { ok: true, value: { characters } }
}

/**
 * 人物単体版（character）か plain かを、形態ごとに丸ごと 1 つ選ぶ。
 * 優先: 基本 8 ポーズが揃った character → 基本 8 ポーズが揃った plain → 実在ポーズの多い方（同数は plain）。
 * 版を混ぜない（同じ戦闘で味方の絵の方式が揃わなくなるため）。無ければ undefined。
 * `plainBaked`（plain に刀・軌跡の焼き込み版が混じり得る人物）は、plain へ降格しない: 8 ポーズ揃った character だけ、無ければ undefined
 */
export function pickPoseVariant(
  entry: FormEntry,
  opts: { plainBaked?: boolean } = {}
): PoseVariant | undefined {
  const c = entry.poses.character ?? []
  const p = entry.poses.plain ?? []
  const complete = (list: readonly BattlePose[]) => CORE_POSES.every((x) => list.includes(x))
  if (complete(c)) return 'character'
  if (opts.plainBaked) return undefined
  if (complete(p)) return 'plain'
  if (c.length === 0 && p.length === 0) return undefined
  return c.length > p.length ? 'character' : 'plain'
}

/** 形態が目録に載っているのに poses を導けない理由（警告文用）。導ける・載っていないときは null */
export function explainNoPoses(
  manifest: CharacterFormsManifest,
  character: string,
  form: string
): string | null {
  const entry = lookupForm(manifest, character, form)
  if (!entry) return null
  const baked = !!manifest.characters[character].plainBaked
  if (baked && pickPoseVariant(entry, { plainBaked: true }) === undefined)
    return '人物単体版（-character）が 8 ポーズ揃っておらず、焼き込み版（plain）は使いません'
  return pickPoseVariant(entry) === undefined ? '戦闘ポーズの絵がありません' : null
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/** `{root}/{C}/poses/{C}-{form}[-character]-{pose}.webp` を実在するポーズだけ並べる。無ければ undefined */
export function derivePoses(
  manifest: CharacterFormsManifest,
  root: string,
  character: string,
  form: string
): Partial<Record<BattlePose, string>> | undefined {
  const entry = lookupForm(manifest, character, form)
  if (!entry) return undefined
  const variant = pickPoseVariant(entry, {
    plainBaked: !!manifest.characters[character].plainBaked,
  })
  if (!variant) return undefined
  const infix = variant === 'character' ? '-character' : ''
  const out: Partial<Record<BattlePose, string>> = {}
  for (const pose of entry.poses[variant] ?? [])
    out[pose] = `${trimSlash(root)}/${character}/poses/${character}-${form}${infix}-${pose}.webp`
  return out
}

/** 歩行 8 方向×3 コマの URL。歩行絵が揃っていない形態は undefined */
export function deriveWalkSprites(
  manifest: CharacterFormsManifest,
  root: string,
  character: string,
  form: string
): Record<string, [string, string, string]> | undefined {
  const entry = lookupForm(manifest, character, form)
  if (!entry?.walk) return undefined
  const out: Record<string, [string, string, string]> = {}
  for (const [key, dir] of WALK_DIRS)
    out[key] = [1, 2, 3].map(
      (n) => `${trimSlash(root)}/${character}/walk/${character}-${form}-walk-${dir}-${n}.webp`
    ) as [string, string, string]
  return out
}

/**
 * 歩行周期。立位（車椅子でない形態）は 1・3 コマ目が接地・2 コマ目が通過なので [0, 1, 2, 1]・止まりは 1。
 * 車椅子はこぐ 3 コマなので既定（[0, 1, 2]・止まりは 0）のまま（undefined）。sit-by-me docs/assets-policy.md の歩行 3 コマの規則
 */
export function walkGait(form: string): { cycle: number[]; idleFrame: number } | undefined {
  return isWheelchair(form) ? undefined : { cycle: [0, 1, 2, 1], idleFrame: 1 }
}

export const isWheelchair = (form: string): boolean => form.split('-').includes('wheelchair')

function lookupForm(
  manifest: CharacterFormsManifest,
  character: string,
  form: string
): FormEntry | undefined {
  if (!hasOwn(manifest.characters, character)) return undefined
  const forms = manifest.characters[character].forms
  return hasOwn(forms, form) ? forms[form] : undefined
}

/** セーブの `rpg.party[]` から、形態の指定（メンバー id → form）を取り出す。形式が違う項目は読み飛ばす */
export function savedFormsOf(rpg: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(rpg) || !Array.isArray(rpg.party)) return out
  for (const m of rpg.party)
    if (isObj(m) && typeof m.id === 'string' && typeof m.form === 'string' && m.form !== '')
      out[m.id] = m.form
  return out
}

export interface ExpandResult {
  raw: unknown
  warnings: string[]
}

/**
 * 生の設定 JSON に、導出した `party[].poses` と `player.sprites`（+ cycle / idleFrame）を埋める。入力は書き換えない。
 * - `characterForms` が無い設定は何もしない（従来どおり）
 * - `party[].character`（人物 ID）を持つ者に、`form`（既定）またはセーブの指定の形態の poses を入れる。手書きの `poses` / `sprite` は導出で置き換える
 * - `player.character` を持ち `player.sprites` が無いとき、同じ人物の味方の形態（無ければ `player.form`）で歩行絵を導く
 * - 目録に無い形態・絵の足りない形態は警告し、その者は導出しない（セーブの指定が不正なら既定の形態に戻す）
 */
export function expandCharacterForms(
  rawConfig: unknown,
  manifest: CharacterFormsManifest,
  savedForms: Readonly<Record<string, string>> = {}
): ExpandResult {
  const warnings: string[] = []
  if (!isObj(rawConfig) || !isObj(rawConfig.characterForms)) return { raw: rawConfig, warnings }
  const root = rawConfig.characterForms.root
  if (typeof root !== 'string' || root.trim() === '') {
    warnings.push('characterForms.root は URL 文字列が必要です（人物の形態の導出をしません）')
    return { raw: rawConfig, warnings }
  }
  const out: Obj = { ...rawConfig }
  // 味方（既定の id は parseConfig と同じ party1, party2, …）。人物 ID → 実効の形態
  const effectiveForm: Record<string, string> = {}
  if (Array.isArray(rawConfig.party)) {
    out.party = rawConfig.party.map((m: unknown, i: number) => {
      if (!isObj(m) || typeof m.character !== 'string') return m
      const id = typeof m.id === 'string' && m.id ? m.id : `party${i + 1}`
      const declared = typeof m.form === 'string' ? m.form : undefined
      const saved = hasOwn(savedForms, id) ? savedForms[id] : undefined
      const tryForm = (f: string | undefined) =>
        f === undefined ? undefined : derivePoses(manifest, root, m.character as string, f)
      let form = saved ?? declared
      if (form === undefined) {
        warnings.push(`party[${i}] (${id}) に form がありません（絵の導出をしません）`)
        return m
      }
      if (!tryForm(form)) {
        warnings.push(
          `party[${i}] (${id}) の形態 ${m.character}/${form} の絵を導けません（${explainNoPoses(manifest, m.character as string, form) ?? '目録にありません'}）`
        )
        // セーブの指定が不正なら設定の既定の形態に戻す。既定も導出できなければ手書きのまま
        if (saved === undefined || !tryForm(declared)) return m
        form = declared as string
      }
      effectiveForm[m.character] ??= form
      const { sprite: _sprite, ...rest } = m
      void _sprite
      return { ...rest, poses: tryForm(form) }
    })
  }
  // 主人公の歩行絵
  if (isObj(rawConfig.player) && typeof rawConfig.player.character === 'string') {
    const character = rawConfig.player.character
    const declared = typeof rawConfig.player.form === 'string' ? rawConfig.player.form : undefined
    const form = effectiveForm[character] ?? declared
    if (form === undefined) {
      warnings.push(
        'player に form（または同じ人物の味方の form）がありません（歩行絵の導出をしません）'
      )
    } else {
      const sprites = deriveWalkSprites(manifest, root, character, form)
      if (!sprites)
        warnings.push(
          `player の歩行絵 ${character}/${form} がありません（目録に無い、または 8 方向×3 コマが揃っていません）`
        )
      else
        out.player = {
          ...rawConfig.player,
          sprites,
          ...(rawConfig.player.cycle === undefined ? (walkGait(form) ?? {}) : {}),
        }
    }
  }
  return { raw: out, warnings }
}
