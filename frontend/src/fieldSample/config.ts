/**
 * 一枚絵フィールドサンプルページ (#807) の設定 JSON まわりの純粋関数。ブラウザ API には触れない。
 * 画像は URL で指す（相対 URL は設定 JSON の URL を基準に解決。assetBaseUrl があれば RPG の画像と同じく
 * `${base}/images/...` に解決する (#746/#785)）。
 */
import { resolveRpgImagePath } from '../game/novelLayout'
import { resolveUrl, type ParseResult } from '../battleSample/config'
import type { Edge, FieldLink, Facing, Vec } from '../game/fieldWalk'

export const EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right']
export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right']

export interface FieldSceneConfig {
  id: string
  /** 背景画像の URL */
  background: string
  /** 歩行マスク画像の URL（白=歩ける・黒=歩けない。背景と同じ大きさ） */
  mask: string
  links: FieldLink[]
}

export interface FieldSampleConfig {
  startScene: string
  /** 開始シーンでの足元の初期位置（背景のピクセル座標） */
  start: Vec
  /** 移動速度（背景ピクセル/秒） */
  speed: number
  /** 端のしきい値（背景ピクセル） */
  edgeThreshold: number
  player: {
    /** 向きごとに 3 コマの画像 URL */
    sprites: Record<Facing, [string, string, string]>
    /** 表示する高さ（背景ピクセル） */
    height: number
    /** 1 コマの長さ(ms) */
    frameMs: number
  }
  scenes: Record<string, FieldSceneConfig>
}

export const DEFAULTS = { speed: 260, edgeThreshold: 6, height: 150, frameMs: 140 } as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

export function parseConfigText(text: string, baseUrl: string): ParseResult<FieldSampleConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fail(`JSON として読めません: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseConfig(raw, baseUrl)
}

export function parseConfig(raw: unknown, baseUrl: string): ParseResult<FieldSampleConfig> {
  if (!isObj(raw)) return fail('設定はオブジェクトである必要があります')
  const assetBase =
    typeof raw.assetBaseUrl === 'string' && raw.assetBaseUrl.trim()
      ? raw.assetBaseUrl.trim()
      : undefined
  const url = (v: unknown, path: string): ParseResult<string> => {
    if (typeof v !== 'string' || !v.trim()) return fail(`${path} は URL 文字列である必要があります`)
    const u = resolveUrl(resolveRpgImagePath(assetBase, v.trim()), baseUrl)
    return u ? { ok: true, value: u } : fail(`${path} の URL を解決できません: ${v}`)
  }
  const positive = (v: unknown, def: number, path: string): ParseResult<number> => {
    if (v === undefined) return { ok: true, value: def }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
      return fail(`${path} は 0 より大きい数値: ${JSON.stringify(v)}`)
    return { ok: true, value: v }
  }

  if (!isObj(raw.scenes) || Object.keys(raw.scenes).length === 0)
    return fail('scenes は 1 件以上のオブジェクトが必要です')
  if (typeof raw.startScene !== 'string' || !(raw.startScene in raw.scenes))
    return fail(`startScene は scenes のキーのどれか: ${JSON.stringify(raw.startScene)}`)
  const s = raw.start
  if (
    !isObj(s) ||
    typeof s.x !== 'number' ||
    typeof s.y !== 'number' ||
    !Number.isFinite(s.x) ||
    !Number.isFinite(s.y)
  )
    return fail('start は { x, y }（数値）が必要です')

  const speed = positive(raw.speed, DEFAULTS.speed, 'speed')
  if (!speed.ok) return speed
  const edgeThreshold = positive(raw.edgeThreshold, DEFAULTS.edgeThreshold, 'edgeThreshold')
  if (!edgeThreshold.ok) return edgeThreshold

  if (!isObj(raw.player) || !isObj(raw.player.sprites)) return fail('player.sprites が必要です')
  const sprites = {} as Record<Facing, [string, string, string]>
  for (const f of FACINGS) {
    const arr = raw.player.sprites[f]
    if (!Array.isArray(arr) || arr.length !== 3)
      return fail(`player.sprites.${f} は 3 コマ分の URL 配列が必要です`)
    const urls: string[] = []
    for (let i = 0; i < 3; i++) {
      const u = url(arr[i], `player.sprites.${f}[${i}]`)
      if (!u.ok) return u
      urls.push(u.value)
    }
    sprites[f] = urls as [string, string, string]
  }
  const height = positive(raw.player.height, DEFAULTS.height, 'player.height')
  if (!height.ok) return height
  const frameMs = positive(raw.player.frameMs, DEFAULTS.frameMs, 'player.frameMs')
  if (!frameMs.ok) return frameMs

  const scenes: Record<string, FieldSceneConfig> = {}
  for (const [id, sc] of Object.entries(raw.scenes)) {
    if (!isObj(sc)) return fail(`scenes.${id} はオブジェクトが必要です`)
    const background = url(sc.background, `scenes.${id}.background`)
    if (!background.ok) return background
    const mask = url(sc.mask, `scenes.${id}.mask`)
    if (!mask.ok) return mask
    const links: FieldLink[] = []
    if (sc.links !== undefined) {
      if (!Array.isArray(sc.links)) return fail(`scenes.${id}.links は配列が必要です`)
      for (let i = 0; i < sc.links.length; i++) {
        const l: unknown = sc.links[i]
        const p = `scenes.${id}.links[${i}]`
        if (!isObj(l)) return fail(`${p} はオブジェクトが必要です`)
        if (!EDGES.includes(l.edge as Edge)) return fail(`${p}.edge は top/bottom/left/right`)
        const r = l.range
        if (
          !Array.isArray(r) ||
          r.length !== 2 ||
          typeof r[0] !== 'number' ||
          typeof r[1] !== 'number' ||
          r[0] > r[1]
        )
          return fail(`${p}.range は [小, 大] の数値 2 つが必要です`)
        if (typeof l.to !== 'string' || !(l.to in raw.scenes))
          return fail(`${p}.to は scenes のキーのどれか: ${JSON.stringify(l.to)}`)
        links.push({ edge: l.edge as Edge, range: [r[0], r[1]], to: l.to })
      }
    }
    scenes[id] = { id, background: background.value, mask: mask.value, links }
  }

  return {
    ok: true,
    value: {
      startScene: raw.startScene,
      start: { x: s.x, y: s.y },
      speed: speed.value,
      edgeThreshold: edgeThreshold.value,
      player: { sprites, height: height.value, frameMs: frameMs.value },
      scenes,
    },
  }
}

/**
 * srcId のシーンから link で出たとき、遷移先シーンで対応する（srcId へ戻る）リンクを返す。
 * 遷移先に複数あれば、辺が反対側のものを優先し、なければ最初のもの。無ければ null。
 */
export function findReturnLink(
  config: FieldSampleConfig,
  srcId: string,
  link: FieldLink
): FieldLink | null {
  const back = config.scenes[link.to]?.links.filter((l) => l.to === srcId) ?? []
  if (back.length === 0) return null
  return back.find((l) => l.edge === OPPOSITE[link.edge]) ?? back[0]
}

const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
