/**
 * 戦闘のエフェクト重ね (#936)。詠唱・物理ヒット・魔法ヒットの「コマ割りシート」を、対象の位置へ重ねて再生するための純粋関数群。
 * ブラウザ API にも PixiJS にも触れない。描画は `BattleScreen` が担う（シートの読み込み・コマの切り出し・重ね）。
 *
 * - 設定（`battle.effects`）は種類ごとのシート宣言。宣言した種類だけが再生され、1 つも宣言しないゲームでは何も起きない（従来と同一）
 * - 何をいつ・どこへ出すかは、行動の記録（`BattleActionEvent`）から `planEventEffects` が導く。エンジンの状態・乱数は読まず・変えない
 * - 種類の拡張点: `BATTLE_EFFECT_KINDS` と `planEventEffects`（属性ごとのヒット素材の出し分けなどは今後ここへ足す）
 */
import type { BattleActionEvent, BattleActorRef } from './battleEngine'
import { eventTimeline, hitRound, hitTimeOf } from './battleMotion'
import { hasOwn } from './ownProperty'

/** エフェクトの種類: 詠唱（通常）/ 召喚詠唱 / 打撃 / 斬撃 / 魔法ヒット */
export const BATTLE_EFFECT_KINDS = ['cast', 'summon', 'impact', 'slash', 'magic'] as const
export type BattleEffectKind = (typeof BATTLE_EFFECT_KINDS)[number]

/** 置き場所: 使い手の手元（相手側へ寄せた位置）/ 対象の中心 / 足元 / 画面中央 */
export const BATTLE_EFFECT_ANCHORS = ['hand', 'center', 'foot', 'screen'] as const
export type BattleEffectAnchor = (typeof BATTLE_EFFECT_ANCHORS)[number]

/** 1 種類のシート宣言（検証済み・URL 解決済み） */
export interface BattleEffectSheet {
  /** シート画像（透過のコマ割り）の URL / 相対パス */
  image: string
  /** コマ数（1 以上の整数） */
  frames: number
  /** 1 行に並ぶコマ数。横一列（既定）は `frames` と同じ。行は `ceil(frames / columns)` で左上から右へ・上から下へ数える */
  columns: number
  /** 1 コマを見せる ms */
  frameMs: number
  anchor: BattleEffectAnchor
  /** 拡大率。1 = セルの幅が対象の枠の一辺と同じ大きさ */
  scale: number
}

export type BattleEffects = Partial<Record<BattleEffectKind, BattleEffectSheet>>

export const EFFECT_MAX_FRAMES = 256
export const EFFECT_DEFAULT_FRAME_MS = 80
export const EFFECT_MAX_FRAME_MS = 5000
export const EFFECT_MAX_SCALE = 10

/** 種類ごとの既定のアンカー。詠唱は使い手、ヒットは対象の中心 */
const DEFAULT_ANCHOR: Record<BattleEffectKind, BattleEffectAnchor> = {
  cast: 'hand',
  summon: 'hand',
  impact: 'center',
  slash: 'center',
  magic: 'center',
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 設定の `effects`（`{ cast?: Sheet, summon?: Sheet, impact?: Sheet, slash?: Sheet, magic?: Sheet }`）を検証する。
 * 不正な種類・値は理由を警告に積んでその種類だけ無視し、戦闘は止めない。`resolve` は画像 URL の解決（解決できなければ無視）。
 * 未指定（undefined）は空・警告なし。
 */
export function parseBattleEffects(
  raw: unknown,
  resolve?: (url: string) => string | null
): { effects: BattleEffects; warnings: string[] } {
  const effects: BattleEffects = {}
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { effects, warnings }
  if (!isRecord(raw)) {
    warnings.push('effects はオブジェクトである必要があります（無視します）')
    return { effects, warnings }
  }
  for (const key of Object.keys(raw)) {
    if (!(BATTLE_EFFECT_KINDS as readonly string[]).includes(key)) {
      warnings.push(
        `effects.${key} は未知の種類です（${BATTLE_EFFECT_KINDS.join(' / ')} のどれか。無視します）`
      )
    }
  }
  for (const kind of BATTLE_EFFECT_KINDS) {
    if (!hasOwn(raw, kind) || raw[kind] === undefined) continue
    const path = `effects.${kind}`
    const r = raw[kind]
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
    const frames = r.frames
    if (
      typeof frames !== 'number' ||
      !Number.isInteger(frames) ||
      frames < 1 ||
      frames > EFFECT_MAX_FRAMES
    ) {
      warnings.push(
        `${path}.frames は 1〜${EFFECT_MAX_FRAMES} の整数である必要があります: ${JSON.stringify(frames)}（無視します）`
      )
      continue
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
    let frameMs = EFFECT_DEFAULT_FRAME_MS
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
    let anchor = DEFAULT_ANCHOR[kind]
    if (r.anchor !== undefined) {
      if (
        typeof r.anchor !== 'string' ||
        !(BATTLE_EFFECT_ANCHORS as readonly string[]).includes(r.anchor)
      ) {
        warnings.push(
          `${path}.anchor は ${BATTLE_EFFECT_ANCHORS.join(' / ')} のどれかである必要があります: ${JSON.stringify(r.anchor)}（無視します）`
        )
        continue
      }
      anchor = r.anchor as BattleEffectAnchor
    }
    let scale = 1
    if (r.scale !== undefined) {
      const s = r.scale
      if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > EFFECT_MAX_SCALE) {
        warnings.push(
          `${path}.scale は 0 より大きく ${EFFECT_MAX_SCALE} 以下の数値である必要があります: ${JSON.stringify(s)}（無視します）`
        )
        continue
      }
      scale = s
    }
    effects[kind] = { image, frames, columns, frameMs, anchor, scale }
  }
  return { effects, warnings }
}

/** 宣言が 1 つでもあるか（無ければ画面は何も作らない＝従来と同一） */
export function hasBattleEffects(effects: BattleEffects | undefined): boolean {
  return !!effects && BATTLE_EFFECT_KINDS.some((k) => effects[k] !== undefined)
}

/** シートの行数 */
export function effectRows(sheet: Pick<BattleEffectSheet, 'frames' | 'columns'>): number {
  return Math.ceil(sheet.frames / sheet.columns)
}

/** 再生の総時間（ms） */
export function effectTotalMs(sheet: Pick<BattleEffectSheet, 'frames' | 'frameMs'>): number {
  return sheet.frames * sheet.frameMs
}

/** 開始から t ms 時点のコマ番号。再生が終わっていれば null。負・非有限は 0 コマ目 */
export function effectFrameAt(
  sheet: Pick<BattleEffectSheet, 'frames' | 'frameMs'>,
  t: number
): number | null {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  if (time >= effectTotalMs(sheet)) return null
  return Math.min(sheet.frames - 1, Math.floor(time / sheet.frameMs))
}

/** シート画像（texW × texH）の中の、frame コマ目の矩形（整数 px。端数は切り捨て） */
export function effectFrameRect(
  sheet: Pick<BattleEffectSheet, 'frames' | 'columns'>,
  texW: number,
  texH: number,
  frame: number
): { x: number; y: number; w: number; h: number } {
  const w = Math.floor(texW / sheet.columns)
  const h = Math.floor(texH / effectRows(sheet))
  const col = frame % sheet.columns
  const row = Math.floor(frame / sheet.columns)
  return { x: col * w, y: row * h, w, h }
}

/** 描く大きさ: セルの幅が `unit * scale`、高さは縦横比を保つ。セルが空（0）なら 0 */
export function effectDrawSize(
  sheet: Pick<BattleEffectSheet, 'scale'>,
  cellW: number,
  cellH: number,
  unit: number
): { w: number; h: number } {
  if (!(cellW > 0) || !(cellH > 0) || !(unit > 0)) return { w: 0, h: 0 }
  const w = unit * sheet.scale
  return { w, h: (w * cellH) / cellW }
}

/** アンカーを画面の座標へ。`view` は対象の枠（中央 x・上半身の高さ y・一辺 unit）。`screen` は画面中央（unit は画面の高さの半分） */
export function effectAnchorPoint(
  anchor: BattleEffectAnchor,
  view: { side: 'party' | 'enemy'; x: number; y: number; unit: number },
  screen: { w: number; h: number }
): { x: number; y: number; unit: number } {
  switch (anchor) {
    case 'screen':
      return { x: screen.w / 2, y: screen.h * 0.4, unit: screen.h * 0.5 }
    case 'foot':
      return { x: view.x, y: view.y + view.unit * 0.65, unit: view.unit }
    case 'hand': {
      // 味方は右側にいて左の敵へ向く（召喚獣の絵と同じ約束）。手元は相手側へ寄せる
      const dx = view.unit * 0.3
      return { x: view.side === 'party' ? view.x - dx : view.x + dx, y: view.y, unit: view.unit }
    }
    default:
      return { x: view.x, y: view.y, unit: view.unit }
  }
}

/** 再生の予定 1 件: どの種類を、行動の開始から何 ms 後に、どの側の誰の位置へ */
export interface EffectPlan {
  kind: BattleEffectKind
  /** 行動の開始からの ms（詠唱は 0、ヒットは命中の瞬間） */
  atMs: number
  target: BattleActorRef
}

/**
 * 行動の記録から、再生するエフェクトの予定を作る。宣言の無い種類は出さない。順序は発動（詠唱）→ ヒット（round 順・hits の順）。
 *
 * 割り当て:
 * - 詠唱: 呪文（`spell`）の発動時に `cast` を使い手へ。召喚獣の演出（`summon`）のある行動は `summon` を使い手へ
 * - 打撃・斬撃: 通常攻撃（`attack`）の命中時（ダメージのヒット）に対象へ。使い手が `slash` ポーズの絵を持てば `slash`、無ければ `impact`
 *   （記録に武器・技の種類が無いので、絵の宣言で分ける暫定。属性・武器での出し分けは今後）
 * - 魔法ヒット: 呪文と召喚獣の演出のある行動の、ダメージのヒットに対象へ `magic`。回復・ミスには出さない
 * - アイテム・状態・知らせ・召喚獣の演出の無い特技には出さない
 */
export function planEventEffects(
  event: BattleActionEvent,
  effects: BattleEffects | undefined,
  opts: { usesSlashPose: (actor: BattleActorRef) => boolean }
): EffectPlan[] {
  if (!hasBattleEffects(effects)) return []
  const plans: EffectPlan[] = []
  const isSummon = event.summon !== undefined && event.kind === 'skill'
  const isSpell = event.kind === 'spell'
  const castKind: BattleEffectKind | null = isSummon ? 'summon' : isSpell ? 'cast' : null
  if (castKind && effects?.[castKind]) {
    plans.push({ kind: castKind, atMs: 0, target: event.actor })
  }
  let hitKind: BattleEffectKind | null = null
  if (event.kind === 'attack') hitKind = opts.usesSlashPose(event.actor) ? 'slash' : 'impact'
  else if (isSpell || isSummon) hitKind = 'magic'
  if (hitKind && effects?.[hitKind]) {
    const tl = eventTimeline(event)
    for (const hit of event.hits) {
      if (hit.kind !== 'damage') continue
      plans.push({
        kind: hitKind,
        atMs: hitTimeOf(tl.hitAt, hitRound(hit), tl.hitInterval),
        target: hit.target,
      })
    }
  }
  return plans
}
