/**
 * RPG モード（TopDownRenderer）への感情吹き出しの接続 (#943)。
 *
 * 脚本の `[イベント]` 内 `[感情: 対象, 種類(, 持続=ms)]` を、人物（NPC・主人公）の頭上に出す。吹き出しの時間・コマ・消去は
 * フィールドと同じ `fieldEmotion.ts` / `FieldEmotionLayer` を再利用する。ここは副作用の少ない薄い関数だけ
 * （対象名の解決は `fieldEmotionScript.resolveEmotion`、ホストは `fieldScript.createFieldEmotionHost` を使い回す）。
 *
 * - 種類の宣言は frontmatter `field_emotions: <JSONパス>`（`RPGProject.fieldEmotions`）。無い・読めないときは吹き出しなし
 *   （`[感情:]` は従来どおり警告して読み飛ばす）。JSON のパスは assets ルートから、絵のパスは `images/` 配下（`battle_effects` と同じ規則）
 * - TopDown に同行者はいない。`[感情: 同行者, …]` は出せず警告して読み飛ばす
 * - 戦闘中は出さない（戦闘画面には吹き出しを出さない）
 */
import {
  EMOTION_NPC_PREFIX,
  hasEmotions,
  type EmotionSheets,
  type EmotionTarget,
} from './fieldEmotion'
import type { EmotionHeads } from './FieldEmotionLayer'
import { parseFieldEmotionsText, type EmotionResolveContext } from './fieldEmotionScript'
import { resolveRpgDataPath } from './battleEffectsLoader'
import { resolveRpgImagePath } from './novelLayout'

/** `field_emotions` の JSON を取得して検証する。失敗はすべて警告のうえ `undefined`（吹き出しなし） */
export async function loadTopDownEmotionSheets(
  path: string | undefined,
  assetBaseUrl: string | undefined,
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  warn: (msg: string) => void = (m) => console.warn(m)
): Promise<EmotionSheets | undefined> {
  if (!path) return undefined
  const url = resolveRpgDataPath(assetBaseUrl, path)
  try {
    const res = await fetchFn(url)
    if (!res.ok) {
      warn(`[name-name] field_emotions: ${url} を読めません（HTTP ${res.status}。無視します）`)
      return undefined
    }
    const { emotions, warnings } = parseFieldEmotionsText(await res.text(), (u) =>
      resolveRpgImagePath(assetBaseUrl, u)
    )
    for (const w of warnings) warn(`[name-name] ${w}`)
    return hasEmotions(emotions) ? emotions : undefined
  } catch (e) {
    warn(
      `[name-name] field_emotions: ${url} を読めません（無視します）: ${e instanceof Error ? e.message : String(e)}`
    )
    return undefined
  }
}

/** 対象名の解決文脈。TopDown に同行者は無い（`companionName` は渡さない） */
export function topDownEmotionContext(
  emotions: EmotionSheets,
  protagonist: string | null | undefined,
  npcs: ReadonlyArray<{ id: string; name: string }>
): EmotionResolveContext {
  return { emotions, protagonist: protagonist ?? null, npcs }
}

/**
 * 吹き出しを出せる対象か。戦闘中は出さない。同行者は TopDown に居ない。
 * NPC は今のマップに居るものだけ（`npcIds`）
 */
export function canShowTopDownEmotion(
  target: EmotionTarget,
  state: { battleBusy: boolean; npcIds: ReadonlySet<string> }
): boolean {
  if (state.battleBusy) return false
  if (target === 'player') return true
  if (target.startsWith(EMOTION_NPC_PREFIX))
    return state.npcIds.has(target.slice(EMOTION_NPC_PREFIX.length))
  return false // companion
}

/**
 * 吹き出しの置き場所（人物の表示上端の中央、ワールド座標）。`x` / `y` は人物の中心、`height` は表示の高さ
 * （スプライトがあればその高さ、無ければ色四角の高さ）
 */
export function topDownEmotionHeads(
  player: { x: number; y: number; height: number } | null,
  npcs: ReadonlyArray<{ id: string; x: number; y: number; height: number }>
): EmotionHeads {
  const heads: EmotionHeads = {}
  if (player) heads.player = { x: player.x, y: player.y - player.height / 2 }
  for (const n of npcs) heads[`${EMOTION_NPC_PREFIX}${n.id}`] = { x: n.x, y: n.y - n.height / 2 }
  return heads
}
