/**
 * フィールドの感情吹き出し (#937)。人物の頭上に「！」「？」「…」などの絵を一定時間だけ出す、見た目だけの演出の純粋関数群。
 * ブラウザ API にも PixiJS にも触れない。描画は `FieldEmotionLayer` が担う。
 *
 * - 歩行・当たり判定・移動速度・エンカウントには関与しない（状態はこのモジュールの中だけで完結する）
 * - 種類は設定（`emotions`）で自由に宣言する。キーは任意の短い文字列（例: "!" "?" "..."）。宣言が無ければ何も起きない（従来と同一）
 * - 同じ人物に続けて出したときは、古い吹き出しを捨てて新しいものに置き換える（1 人物につき同時に 1 つ）
 * - コマ割りシートの扱い（frames / columns / frameMs）は戦闘のエフェクト (#936) と同じ流儀
 */
import { effectFrameRect, EFFECT_MAX_FRAMES, EFFECT_MAX_FRAME_MS } from './battleEffects'
import { hasOwn } from './ownProperty'

/** 出す先の固定の人物: 主人公 / 同行者 */
export const EMOTION_TARGETS = ['player', 'companion'] as const
export type FixedEmotionTarget = (typeof EMOTION_TARGETS)[number]

/** NPC の対象キーの接頭辞（#946）。NPC は `npc:<id>`（id は設定の NPC の id） */
export const EMOTION_NPC_PREFIX = 'npc:'
/** 出す先の人物: 主人公 / 同行者 / NPC (`npc:<id>`) */
export type EmotionTarget = FixedEmotionTarget | `npc:${string}`

/** NPC の id から対象キーを作る */
export function npcEmotionTarget(id: string): EmotionTarget {
  return `${EMOTION_NPC_PREFIX}${id}`
}

/** 対象キーとして有効か（固定の人物、または id が空でない `npc:<id>`） */
export function isEmotionTarget(target: string): target is EmotionTarget {
  return (
    (EMOTION_TARGETS as readonly string[]).includes(target) ||
    (target.startsWith(EMOTION_NPC_PREFIX) && target.length > EMOTION_NPC_PREFIX.length)
  )
}

/**
 * 表示時間の上書きの正規化（`resolveEmotion` と `startEmotion` で共通）: 有限の数を floor し、1 以上のときだけ採用して
 * `EMOTION_MAX_DURATION_MS` に収める。0 以下・非数・floor して 0（0<d<1）・省略は undefined（＝宣言どおり）
 */
export function normalizeEmotionDuration(d: unknown): number | undefined {
  if (typeof d !== 'number' || !Number.isFinite(d)) return undefined
  const n = Math.floor(d)
  return n > 0 ? Math.min(n, EMOTION_MAX_DURATION_MS) : undefined
}

/** 出現の動き: none = 出してそのまま / pop = 小さい所から跳ねるように大きくなる */
export const EMOTION_MOTIONS = ['none', 'pop'] as const
export type EmotionMotion = (typeof EMOTION_MOTIONS)[number]

/** 1 種類の吹き出しの宣言（検証済み・URL 解決済み） */
export interface EmotionSheet {
  /** 画像（1 枚絵ならコマ数 1。コマ割りシートも可）の URL / 相対パス */
  image: string
  /** コマ数（1 以上の整数。1 = 1 枚絵） */
  frames: number
  /** 1 行に並ぶコマ数。横一列（既定）は `frames` と同じ */
  columns: number
  /** 1 コマを見せる ms。表示時間のほうが長ければコマを繰り返す */
  frameMs: number
  /** 表示時間（ms）。経つと消える */
  durationMs: number
  /** 頭の真上（人物の表示上端の中央に吹き出しの下端中央を置く）からのずらし（背景ピクセル。y が負で上） */
  offset: { x: number; y: number }
  /** 拡大率。1 = 画像のコマの大きさ（背景ピクセル）のまま */
  scale: number
  motion: EmotionMotion
}

export type EmotionSheets = Record<string, EmotionSheet>

export const EMOTION_DEFAULT_FRAME_MS = 120
export const EMOTION_DEFAULT_DURATION_MS = 1200
export const EMOTION_MAX_DURATION_MS = 10000
export const EMOTION_MAX_SCALE = 10
export const EMOTION_MAX_OFFSET = 2000
/** 種類名の最大文字数（コードポイント数。絵文字は 1 文字） */
export const EMOTION_MAX_KEY_LENGTH = 16
/** pop の長さ（ms） */
export const EMOTION_POP_MS = 160

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 設定の `emotions`（`{ "!": Sheet, "?": Sheet, ... }`）を検証する。
 * 不正な種類・値は理由を警告に積んでその種類だけ無視し、フィールドは止めない。`resolve` は画像 URL の解決（解決できなければ無視）。
 * 未指定（undefined）は空・警告なし。
 */
export function parseEmotions(
  raw: unknown,
  resolve?: (url: string) => string | null
): { emotions: EmotionSheets; warnings: string[] } {
  const emotions: EmotionSheets = {}
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { emotions, warnings }
  if (!isRecord(raw)) {
    warnings.push('emotions はオブジェクトである必要があります（無視します）')
    return { emotions, warnings }
  }
  for (const key of Object.keys(raw)) {
    const path = `emotions.${key}`
    if (key.trim() === '' || [...key].length > EMOTION_MAX_KEY_LENGTH || key === '__proto__') {
      warnings.push(
        `${path} は 1〜${EMOTION_MAX_KEY_LENGTH} 文字の種類名である必要があります（無視します）`
      )
      continue
    }
    const r = raw[key]
    if (!isRecord(r)) {
      warnings.push(`${path} はオブジェクトである必要があります（無視します）`)
      continue
    }
    if (typeof r.image !== 'string' || r.image.trim() === '') {
      warnings.push(`${path}.image は空でない文字列である必要があります（無視します）`)
      continue
    }
    const image = resolve ? resolve(r.image.trim()) : r.image.trim()
    if (image === null) {
      warnings.push(`${path}.image の URL を解決できません: ${r.image}（無視します）`)
      continue
    }
    let frames = 1
    if (r.frames !== undefined) {
      const f = r.frames
      if (typeof f !== 'number' || !Number.isInteger(f) || f < 1 || f > EFFECT_MAX_FRAMES) {
        warnings.push(
          `${path}.frames は 1〜${EFFECT_MAX_FRAMES} の整数である必要があります: ${JSON.stringify(f)}（無視します）`
        )
        continue
      }
      frames = f
    }
    let columns = frames
    if (r.columns !== undefined) {
      const c = r.columns
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > frames) {
        warnings.push(
          `${path}.columns は 1〜frames（${frames}）の整数である必要があります: ${JSON.stringify(c)}（無視します）`
        )
        continue
      }
      columns = c
    }
    let frameMs = EMOTION_DEFAULT_FRAME_MS
    if (r.frameMs !== undefined) {
      const m = r.frameMs
      if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > EFFECT_MAX_FRAME_MS) {
        warnings.push(
          `${path}.frameMs は 0 より大きく ${EFFECT_MAX_FRAME_MS} 以下の数値である必要があります: ${JSON.stringify(m)}（無視します）`
        )
        continue
      }
      frameMs = m
    }
    let durationMs = EMOTION_DEFAULT_DURATION_MS
    if (r.durationMs !== undefined) {
      const d = r.durationMs
      if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > EMOTION_MAX_DURATION_MS) {
        warnings.push(
          `${path}.durationMs は 0 より大きく ${EMOTION_MAX_DURATION_MS} 以下の数値である必要があります: ${JSON.stringify(d)}（無視します）`
        )
        continue
      }
      durationMs = d
    }
    let offset = { x: 0, y: 0 }
    if (r.offset !== undefined) {
      const o = r.offset
      const ok = (n: unknown): n is number =>
        typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= EMOTION_MAX_OFFSET
      if (!isRecord(o) || !ok(o.x) || !ok(o.y)) {
        warnings.push(
          `${path}.offset は { x, y }（絶対値 ${EMOTION_MAX_OFFSET} 以下の数値）である必要があります: ${JSON.stringify(o)}（無視します）`
        )
        continue
      }
      offset = { x: o.x, y: o.y }
    }
    let scale = 1
    if (r.scale !== undefined) {
      const s = r.scale
      if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > EMOTION_MAX_SCALE) {
        warnings.push(
          `${path}.scale は 0 より大きく ${EMOTION_MAX_SCALE} 以下の数値である必要があります: ${JSON.stringify(s)}（無視します）`
        )
        continue
      }
      scale = s
    }
    let motion: EmotionMotion = 'none'
    if (r.motion !== undefined) {
      if (
        typeof r.motion !== 'string' ||
        !(EMOTION_MOTIONS as readonly string[]).includes(r.motion)
      ) {
        warnings.push(
          `${path}.motion は ${EMOTION_MOTIONS.join(' / ')} のどれかである必要があります: ${JSON.stringify(r.motion)}（無視します）`
        )
        continue
      }
      motion = r.motion as EmotionMotion
    }
    emotions[key] = { image, frames, columns, frameMs, durationMs, offset, scale, motion }
  }
  return { emotions, warnings }
}

/** 宣言が 1 つでもあるか（無ければ層も作らない＝従来と同一） */
export function hasEmotions(emotions: EmotionSheets | undefined): boolean {
  return !!emotions && Object.keys(emotions).length > 0
}

/** 開始から t ms 時点のコマ番号。表示時間が長ければコマを繰り返す。負・非有限は 0 コマ目 */
export function emotionFrameAt(sheet: Pick<EmotionSheet, 'frames' | 'frameMs'>, t: number): number {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  return Math.floor(time / sheet.frameMs) % sheet.frames
}

/** シート画像の中の frame コマ目の矩形（戦闘のエフェクトと同じ割り方） */
export const emotionFrameRect = effectFrameRect

/** 出現の動きによる拡大の倍率（pop: 0.4 → 1.2 → 1 を `EMOTION_POP_MS` で）。none・pop 後は 1 */
export function emotionMotionScale(motion: EmotionMotion, t: number): number {
  if (motion !== 'pop') return 1
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  if (time >= EMOTION_POP_MS) return 1
  const p = time / EMOTION_POP_MS
  // 前半で 0.4 → 1.2、後半で 1.2 → 1
  return p < 0.6 ? 0.4 + (0.8 * p) / 0.6 : 1.2 - (0.2 * (p - 0.6)) / 0.4
}

/** 進行中の吹き出し 1 件 */
export interface ActiveEmotion {
  kind: string
  /** 出してから経った ms */
  elapsed: number
  /** この 1 回だけの表示時間（ms。0 超〜`EMOTION_MAX_DURATION_MS`）。無ければ宣言の `durationMs` */
  durationMs?: number
}

/** 人物ごとの進行中の吹き出し（1 人物につき最大 1 件。NPC は `npc:<id>` キー） */
export type EmotionState = Partial<Record<EmotionTarget, ActiveEmotion>>

export const INITIAL_EMOTION_STATE: EmotionState = {}

/**
 * 人物に吹き出しを出す。同じ人物の古い吹き出しは置き換える（時間も 0 から）。
 * 宣言の無い種類・未知の人物は何もしない（state をそのまま返す）。
 * `durationMs` はこの 1 回だけ宣言の表示時間を上書きする（`normalizeEmotionDuration`: floor して 1 以上のときだけ採用、`EMOTION_MAX_DURATION_MS` を超えれば上限に収め、それ以外は宣言どおり）。
 */
export function startEmotion(
  state: EmotionState,
  target: EmotionTarget,
  kind: string,
  emotions: EmotionSheets | undefined,
  durationMs?: number
): EmotionState {
  if (!isEmotionTarget(target)) return state
  if (!emotions || !hasOwn(emotions, kind)) return state
  const active: ActiveEmotion = { kind, elapsed: 0 }
  const dur = normalizeEmotionDuration(durationMs)
  if (dur !== undefined) active.durationMs = dur
  return { ...state, [target]: active }
}

/**
 * NPC (`npc:<id>`) の吹き出しだけ消す（シーン遷移用）。NPC はシーンごとに別の人物なので、遷移後に同じ id の別シーンの NPC へ
 * 乗り移らないようにする。主人公・同行者の吹き出しは持ち越す。消すものが無ければ state をそのまま返す
 */
export function clearNpcEmotions(state: EmotionState): EmotionState {
  const keys = Object.keys(state) as EmotionTarget[]
  if (!keys.some((k) => k.startsWith(EMOTION_NPC_PREFIX))) return state
  const next: EmotionState = {}
  for (const k of keys) if (!k.startsWith(EMOTION_NPC_PREFIX)) next[k] = state[k]
  return next
}

/** dt ms 進め、表示時間を過ぎた吹き出しを消す。負・非有限の dt は 0 として扱う */
export function stepEmotions(
  state: EmotionState,
  dt: number,
  emotions: EmotionSheets | undefined
): EmotionState {
  const d = Number.isFinite(dt) ? Math.max(0, dt) : 0
  const next: EmotionState = {}
  for (const target of Object.keys(state) as EmotionTarget[]) {
    const a = state[target]
    if (!a) continue
    if (!emotions || !hasOwn(emotions, a.kind)) continue
    const elapsed = a.elapsed + d
    if (elapsed >= (a.durationMs ?? emotions[a.kind].durationMs)) continue
    next[target] = a.durationMs === undefined ? { kind: a.kind, elapsed } : { ...a, elapsed }
  }
  return next
}

/** 描画に要る値: コマ・拡大の倍率（動き込み） */
export function emotionView(
  active: ActiveEmotion,
  sheet: EmotionSheet
): { frame: number; scale: number } {
  return {
    frame: emotionFrameAt(sheet, active.elapsed),
    scale: sheet.scale * emotionMotionScale(sheet.motion, active.elapsed),
  }
}

/**
 * 吹き出しの置き場所。`head` は人物の表示上端の中央、吹き出しは下端中央をそこ（+ offset）に置く。
 * 返すのは下端中央の座標。
 */
export function emotionAnchor(
  head: { x: number; y: number },
  sheet: Pick<EmotionSheet, 'offset'>
): { x: number; y: number } {
  return { x: head.x + sheet.offset.x, y: head.y + sheet.offset.y }
}

/**
 * 同行者が出ているか（描画と同じ条件）。前フレームの描画結果（sprite.visible）ではなく、設定と現在の不透明度で判定する。
 * シーン遷移直後に古い visible が残っていても、見えないまま吹き出しの時間だけ進むのを防ぐ。
 */
export function isCompanionShown(
  hasAssist: boolean,
  hasCompanion: boolean,
  companionAlpha: number
): boolean {
  return hasAssist && hasCompanion && companionAlpha > 0
}
