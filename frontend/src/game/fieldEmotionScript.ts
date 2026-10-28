/**
 * 脚本・frontmatter からフィールドの感情吹き出し (#937) を呼ぶための純粋関数群 (#943)。
 *
 * - frontmatter `field_emotions: <JSONパス>` の JSON は、フィールドサンプルの設定の `emotions`（種類名 → 絵の宣言）と同じ形。
 *   読み込んだ中身は `parseEmotions` に通して同じ検証をする。JSON として読めない・形が違うときは警告して無視（吹き出しなし）。
 * - 脚本 `[感情: 対象, 種類, 持続=ms]`（`Event.Emotion`）は `resolveEmotion` で `showEmotion` に渡せる形へ解決する。
 *   対象は `主人公`（または frontmatter `protagonist` の名前）→ `player`、同行者の話者名 → `companion`、NPC の話者名 → `npc:<id>`。
 *   解決できない対象・未宣言の種類は警告して無視する（フィールドは止めない）。
 *
 * ブラウザ API にも PixiJS にも触れない。実行文脈（フィールドの `showEmotion`）への接続は呼び出し側の責務で、
 * 通常のノベル再生にはフィールドが無いため `[感情:]` は無視される（開発ビルドで警告）。
 */
import {
  hasEmotions,
  normalizeEmotionDuration,
  npcEmotionTarget,
  parseEmotions,
  type EmotionSheets,
  type EmotionTarget,
} from './fieldEmotion'
import { hasOwn } from './ownProperty'

/**
 * 設定のインライン `emotions` と外部 JSON（`emotionsUrl`、#946）の種類をマージする。同名はインラインが優先。
 * どちらも空なら undefined（吹き出しなし＝層を作らない）
 */
export function mergeEmotionSheets(
  inline: EmotionSheets | undefined,
  external: EmotionSheets | undefined
): EmotionSheets | undefined {
  const merged: EmotionSheets = { ...(external ?? {}), ...(inline ?? {}) }
  return hasEmotions(merged) ? merged : undefined
}

/** 脚本中の主人公を指す固定の対象名 */
export const EMOTION_PROTAGONIST_TARGET = '主人公'

/** 脚本中の同行者を指す固定の対象名（話者名が無くても指せる。#946） */
export const EMOTION_COMPANION_TARGET = '同行者'

/** `field_emotions` の JSON テキストを検証する。不正は警告して空にする（ゲームは止めない） */
export function parseFieldEmotionsText(
  text: string,
  resolve?: (url: string) => string | null
): { emotions: EmotionSheets; warnings: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      emotions: {},
      warnings: [
        `field_emotions: JSON として読めません（無視します）: ${e instanceof Error ? e.message : String(e)}`,
      ],
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      emotions: {},
      warnings: [
        'field_emotions: 最上位は種類名 → 宣言のオブジェクトである必要があります（無視します）',
      ],
    }
  }
  return parseEmotions(raw, resolve)
}

/** 解決済みの吹き出し指示 */
export interface EmotionCommand {
  target: EmotionTarget
  kind: string
  /** 表示時間の上書き（ms。0 超 〜 `EMOTION_MAX_DURATION_MS`）。未指定は設定の `durationMs` */
  durationMs?: number
}

export interface EmotionResolveContext {
  /** 宣言済みの種類（`parseFieldEmotionsText` の結果） */
  emotions: EmotionSheets
  /** frontmatter `protagonist`（主人公の話者名）。あれば `主人公` と同じく player を指す */
  protagonist?: string | null
  /** 同行者の話者名。あればその名前が companion を指す */
  companionName?: string | null
  /** いまのシーンにいる NPC（話者名 = `name`）。話者名が一致すれば `npc:<id>` を指す（同名は先勝ち）。#946 */
  npcs?: ReadonlyArray<{ id: string; name: string }>
}

/** `Event.Emotion` の中身を解決する。解決できなければ警告つきで null（呼び出し側は無視する） */
export function resolveEmotion(
  ev: { target: string; kind: string; duration_ms?: number | null },
  ctx: EmotionResolveContext
): { command: EmotionCommand | null; warnings: string[] } {
  const warnings: string[] = []
  let target: EmotionTarget | null = null
  if (
    ev.target === EMOTION_PROTAGONIST_TARGET ||
    (ctx.protagonist && ev.target === ctx.protagonist)
  )
    target = 'player'
  else if (
    ev.target === EMOTION_COMPANION_TARGET ||
    (ctx.companionName && ev.target === ctx.companionName)
  )
    target = 'companion'
  else {
    const npc = ctx.npcs?.find((n) => n.name === ev.target)
    if (npc) target = npcEmotionTarget(npc.id)
  }
  if (!target) {
    warnings.push(
      `[感情:] の対象 "${ev.target}" は主人公・同行者・このシーンの NPC のどれでもありません（無視します）`
    )
    return { command: null, warnings }
  }
  if (!hasOwn(ctx.emotions, ev.kind)) {
    warnings.push(`[感情:] の種類 "${ev.kind}" は field_emotions に宣言がありません（無視します）`)
    return { command: null, warnings }
  }
  const command: EmotionCommand = { target, kind: ev.kind }
  const dur = normalizeEmotionDuration(ev.duration_ms)
  if (dur !== undefined) command.durationMs = dur
  return { command, warnings }
}

/**
 * 感情吹き出しの種類を集める (#946)。設定のインライン `emotions` と、`emotionsUrl` の外部 JSON（`emotionsSource`）をマージする
 * （同名はインラインが優先）。外部 JSON の取得失敗・不正は警告して無視（インラインだけで続ける）。
 * どちらも無ければ undefined＝層を作らない（従来と同一）。`fetchFn` は差し替え可能（テスト用）
 */
export async function loadEmotionSheets(
  config: {
    emotions?: EmotionSheets
    emotionsSource?: { url: string; resolveImage: (url: string) => string | null }
  },
  fetchFn: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  warn: (msg: string) => void = (m) => console.warn(m)
): Promise<EmotionSheets | undefined> {
  let external: EmotionSheets = {}
  const src = config.emotionsSource
  if (src) {
    try {
      const res = await fetchFn(src.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = parseFieldEmotionsText(await res.text(), src.resolveImage)
      for (const w of parsed.warnings) warn(`[field-sample] emotionsUrl: ${w}`)
      external = parsed.emotions
    } catch (e) {
      warn(
        `[field-sample] emotionsUrl を読めません（無視します）: ${src.url} ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return mergeEmotionSheets(config.emotions, external)
}
