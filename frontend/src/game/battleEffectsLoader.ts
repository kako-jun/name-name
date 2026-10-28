/**
 * frontmatter `battle_effects: <JSONパス>` (#941) の JSON を読み込んで検証する。
 *
 * - 中身は戦闘画面サンプルの設定の `effects` と同じ形（種類名 → シート宣言）。検証は `parseBattleEffects`
 * - JSON のパスは `assetBaseUrl`（プロジェクトのアセットのルート）からの相対（`{base}/{path}`）。絶対指定（`scheme://`・先頭 `/`・
 *   `data:`・`blob:`）はそのまま読む。シート画像のパスは従来どおり `images/` 配下（`resolveRpgImagePath`）
 * - 読めない・JSON として不正・形が違うときは警告して無視（`undefined`。戦闘は従来どおり）。宣言が空なら `undefined`
 */
import { hasBattleEffects, parseBattleEffects, type BattleEffects } from './battleEffects'
import { resolveRpgImagePath } from './novelLayout'

/** JSON のパスを配信 URL に解決する。ベースが無ければそのまま */
export function resolveRpgDataPath(baseUrl: string | undefined, path: string): string {
  if (!baseUrl || path.startsWith('/') || /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|blob:)/i.test(path)) {
    return path
  }
  return `${baseUrl.replace(/\/+$/, '')}/${path}`
}

/** JSON テキストを検証する。不正は警告して `undefined`（宣言なしと同じ） */
export function parseBattleEffectsText(
  text: string,
  assetBaseUrl: string | undefined
): { effects: BattleEffects | undefined; warnings: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      effects: undefined,
      warnings: [
        `battle_effects: JSON として読めません（無視します）: ${e instanceof Error ? e.message : String(e)}`,
      ],
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      effects: undefined,
      warnings: [
        'battle_effects: 最上位は種類名 → 宣言のオブジェクトである必要があります（無視します）',
      ],
    }
  }
  const { effects, warnings } = parseBattleEffects(raw, (u) => resolveRpgImagePath(assetBaseUrl, u))
  return {
    effects: hasBattleEffects(effects) ? effects : undefined,
    warnings: warnings.map((w) => `battle_effects: ${w}`),
  }
}

/** `battle_effects` の JSON を取得して検証する。失敗はすべて警告のうえ `undefined` */
export async function loadBattleEffects(
  path: string | undefined,
  assetBaseUrl: string | undefined,
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u)
): Promise<BattleEffects | undefined> {
  if (!path) return undefined
  const url = resolveRpgDataPath(assetBaseUrl, path)
  try {
    const res = await fetchFn(url)
    if (!res.ok) {
      console.warn(
        `[name-name] battle_effects: ${url} を読めません（HTTP ${res.status}。無視します）`
      )
      return undefined
    }
    const { effects, warnings } = parseBattleEffectsText(await res.text(), assetBaseUrl)
    for (const w of warnings) console.warn(`[name-name] ${w}`)
    return effects
  } catch (e) {
    console.warn(
      `[name-name] battle_effects: ${url} を読めません（無視します）: ${e instanceof Error ? e.message : String(e)}`
    )
    return undefined
  }
}
