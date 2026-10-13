/**
 * 戦闘画面サンプルページ (#749) の設定まわりの純粋関数。
 * ブラウザ API には触れない（URL 解決の基準 URL は引数で受ける）。
 */
import type { BattleEntity } from '../game/spellDsl'
import type { BattleLayoutMode } from '../game/battleLayout'
import type { SpriteStyle } from '../game/spriteStyle'

export const SCREEN_SIZES = [
  { id: '360x640', width: 360, height: 640 },
  { id: '800x450', width: 800, height: 450 },
  { id: '1280x720', width: 1280, height: 720 },
  { id: '640x360', width: 640, height: 360 },
] as const
export type ScreenSizeId = (typeof SCREEN_SIZES)[number]['id']

/**
 * 描画解像度。main = 本編相当（本編の app.init は resolution 未指定 = 1）、dpr = 実 DPR。
 * 既定は main（本編と同じ見た目を確認するため）。
 */
export const RESOLUTION_MODES = ['main', 'dpr'] as const
export type ResolutionMode = (typeof RESOLUTION_MODES)[number]
export const DEFAULT_RESOLUTION_MODE: ResolutionMode = 'main'

export const DEFAULT_SIZE_ID: ScreenSizeId = '800x450'
export const MAX_PARTY = 4
export const MAX_ENEMIES = 4

/** 検証・補完・URL 解決済みの設定 */
export interface BattleSampleConfig {
  layout: BattleLayoutMode
  spriteStyle: SpriteStyle
  /** 絶対 URL。なしは null */
  background: string | null
  party: BattleEntity[]
  enemies: BattleEntity[]
}

/** ツールバーで切り替える表示状態（ブリンク比較の単位） */
export interface BattleSampleView {
  layout: BattleLayoutMode
  spriteStyle: SpriteStyle
  backgroundOn: boolean
  partyCount: number
  enemyCount: number
  sizeId: ScreenSizeId
  resolutionMode: ResolutionMode
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 内蔵既定の味方（sprite なし = 色四角） */
export function defaultParty(): BattleEntity[] {
  const names = ['ゆうしゃ', 'まほうつかい', 'そうりょ', 'せんし']
  return names.map((name, i) => ({
    id: `party${i + 1}`,
    name,
    hp: 30 - i * 3,
    maxHp: 30,
    mp: 8 + i,
    maxMp: 12,
    atk: 8,
    def: 4,
    agi: 5,
  }))
}

/** 内蔵既定の敵（sprite なし = 色四角） */
export function defaultEnemies(): BattleEntity[] {
  const names = ['スライム', 'ドラキー', 'ゴースト', 'ドラゴン']
  return names.map((name, i) => ({
    id: `enemy${i + 1}`,
    name,
    hp: 20 + i * 10,
    maxHp: 20 + i * 10,
    mp: 0,
    maxMp: 0,
    atk: 6,
    def: 2,
    agi: 3,
    exp: 5,
    gold: 3,
  }))
}

export function defaultConfig(): BattleSampleConfig {
  return {
    layout: 'side',
    spriteStyle: 'none',
    background: null,
    party: defaultParty(),
    enemies: defaultEnemies(),
  }
}

/** 絶対 URL または基準 URL からの相対 URL を絶対 URL にする。解決できなければ null */
export function resolveUrl(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).href
  } catch {
    return null
  }
}

/** location.search から `config` パラメータ（設定 JSON の URL）を取り出し、基準 URL で解決する */
export function extractConfigUrl(search: string, baseUrl: string): string | null {
  const raw = new URLSearchParams(search).get('config')
  if (!raw || !raw.trim()) return null
  return resolveUrl(raw.trim(), baseUrl)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number, min = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback
}

function parseEntity(
  raw: unknown,
  fallback: BattleEntity,
  baseUrl: string,
  path: string
): ParseResult<BattleEntity> {
  if (!isRecord(raw)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
  if (raw.sprite !== undefined && typeof raw.sprite !== 'string') {
    return { ok: false, error: `${path}.sprite は文字列である必要があります` }
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') {
    return { ok: false, error: `${path}.name は文字列である必要があります` }
  }
  const maxHp = Math.max(
    1,
    num(raw.maxHp, raw.hp !== undefined ? num(raw.hp, fallback.maxHp, 1) : fallback.maxHp)
  )
  const maxMp = num(raw.maxMp, raw.mp !== undefined ? num(raw.mp, fallback.maxMp) : fallback.maxMp)
  const entity: BattleEntity = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallback.name,
    hp: Math.min(maxHp, num(raw.hp, maxHp)),
    maxHp,
    mp: Math.min(maxMp, num(raw.mp, maxMp)),
    maxMp,
    atk: num(raw.atk, fallback.atk),
    def: num(raw.def, fallback.def),
    agi: num(raw.agi, fallback.agi),
    exp: fallback.exp,
    gold: fallback.gold,
  }
  if (typeof raw.sprite === 'string' && raw.sprite.trim()) {
    const url = resolveUrl(raw.sprite.trim(), baseUrl)
    if (!url) return { ok: false, error: `${path}.sprite の URL を解決できません: ${raw.sprite}` }
    entity.sprite = url
  }
  return { ok: true, value: entity }
}

function parseEntities(
  raw: unknown,
  defaults: BattleEntity[],
  max: number,
  baseUrl: string,
  key: string
): ParseResult<BattleEntity[]> {
  if (raw === undefined) return { ok: true, value: defaults }
  if (!Array.isArray(raw)) return { ok: false, error: `${key} は配列である必要があります` }
  if (raw.length === 0) return { ok: false, error: `${key} は 1 件以上必要です` }
  const out: BattleEntity[] = []
  for (let i = 0; i < Math.min(raw.length, max); i++) {
    const r = parseEntity(raw[i], defaults[i % defaults.length], baseUrl, `${key}[${i}]`)
    if (!r.ok) return r
    // id 重複を避ける（既定 id を流用した場合）
    const dup = out.some((e) => e.id === r.value.id)
    out.push(dup ? { ...r.value, id: `${r.value.id}-${i}` } : r.value)
  }
  return { ok: true, value: out }
}

/** 設定 JSON（パース済みの値）を検証し、既定値を補完し、URL を絶対化する */
export function parseConfig(raw: unknown, baseUrl: string): ParseResult<BattleSampleConfig> {
  if (!isRecord(raw))
    return { ok: false, error: '設定 JSON のルートはオブジェクトである必要があります' }
  const def = defaultConfig()
  let layout = def.layout
  if (raw.layout !== undefined) {
    if (raw.layout !== 'front' && raw.layout !== 'side') {
      return { ok: false, error: `layout は "front" か "side": ${JSON.stringify(raw.layout)}` }
    }
    layout = raw.layout
  }
  let spriteStyle = def.spriteStyle
  if (raw.spriteStyle !== undefined) {
    if (raw.spriteStyle !== 'none' && raw.spriteStyle !== 'acrylic') {
      return {
        ok: false,
        error: `spriteStyle は "none" か "acrylic": ${JSON.stringify(raw.spriteStyle)}`,
      }
    }
    spriteStyle = raw.spriteStyle
  }
  let background: string | null = null
  if (raw.background !== undefined && raw.background !== null && raw.background !== '') {
    if (typeof raw.background !== 'string') {
      return { ok: false, error: 'background は URL 文字列である必要があります' }
    }
    const bg = raw.background.trim()
    if (bg) {
      background = resolveUrl(bg, baseUrl)
      if (!background)
        return { ok: false, error: `background の URL を解決できません: ${raw.background}` }
    }
  }
  const party = parseEntities(raw.party, def.party, MAX_PARTY, baseUrl, 'party')
  if (!party.ok) return party
  const enemies = parseEntities(raw.enemies, def.enemies, MAX_ENEMIES, baseUrl, 'enemies')
  if (!enemies.ok) return enemies
  return {
    ok: true,
    value: { layout, spriteStyle, background, party: party.value, enemies: enemies.value },
  }
}

/** JSON 文字列から設定を作る。JSON 構文エラーも ParseResult で返す */
export function parseConfigText(text: string, baseUrl: string): ParseResult<BattleSampleConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      error: `JSON として読めません: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  return parseConfig(raw, baseUrl)
}

/** 設定から、ツールバーの初期表示状態を作る */
export function initialView(config: BattleSampleConfig): BattleSampleView {
  return {
    layout: config.layout,
    spriteStyle: config.spriteStyle,
    backgroundOn: config.background !== null,
    partyCount: config.party.length,
    enemyCount: config.enemies.length,
    sizeId: DEFAULT_SIZE_ID,
    resolutionMode: DEFAULT_RESOLUTION_MODE,
  }
}

/** 解像度モードから renderer.resolution の値を決める（dpr は呼び出し側が毎回読んだ window.devicePixelRatio） */
export function resolveResolution(mode: ResolutionMode, devicePixelRatio: number): number {
  if (mode === 'main') return 1
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
}

/**
 * 実際にエンジンへ渡す味方人数。front は本編（RaycastRenderer.startBattle）と同じく
 * hero 1 人だけを渡すので、ツールバーの味方人数に関わらず 1。side は選択どおり（1〜MAX_PARTY）。
 */
export function effectivePartyCount(view: BattleSampleView): number {
  if (view.layout === 'front') return 1
  return Math.max(1, Math.min(view.partyCount, MAX_PARTY))
}

export function resolveSize(id: ScreenSizeId): { width: number; height: number } {
  const s = SCREEN_SIZES.find((x) => x.id === id) ?? SCREEN_SIZES[1]
  return { width: s.width, height: s.height }
}

/** 表示状態 + 設定から、BattleScreen に渡す素材一式を作る（人数は先頭から切り出す。足りなければ既定で補う） */
export function buildBattleSetup(
  config: BattleSampleConfig,
  view: BattleSampleView
): {
  party: BattleEntity[]
  enemies: BattleEntity[]
  options: { layout: BattleLayoutMode; spriteStyle: SpriteStyle; background?: string }
  width: number
  height: number
} {
  const fill = (src: BattleEntity[], fallback: BattleEntity[], n: number, prefix: string) => {
    const count = Math.max(1, n)
    const out: BattleEntity[] = []
    for (let i = 0; i < count; i++) {
      const e = src[i] ?? { ...fallback[i % fallback.length], id: `${prefix}-extra${i + 1}` }
      // BattleEngine は状態を書き換えるので複製を渡す
      out.push({ ...e })
    }
    return out
  }
  const { width, height } = resolveSize(view.sizeId)
  return {
    party: fill(config.party, defaultParty(), effectivePartyCount(view), 'party'),
    enemies: fill(
      config.enemies,
      defaultEnemies(),
      Math.min(view.enemyCount, MAX_ENEMIES),
      'enemy'
    ),
    options: {
      layout: view.layout,
      spriteStyle: view.spriteStyle,
      ...(view.backgroundOn && config.background ? { background: config.background } : {}),
    },
    width,
    height,
  }
}

export function viewsEqual(a: BattleSampleView, b: BattleSampleView): boolean {
  return (
    a.layout === b.layout &&
    a.spriteStyle === b.spriteStyle &&
    a.backgroundOn === b.backgroundOn &&
    a.partyCount === b.partyCount &&
    a.enemyCount === b.enemyCount &&
    a.sizeId === b.sizeId &&
    a.resolutionMode === b.resolutionMode
  )
}

/** ブリンク比較の履歴。現在とひとつ前を保持する */
export interface BlinkHistory {
  current: BattleSampleView
  previous: BattleSampleView | null
}

/** 設定を変更したとき: 現在をひとつ前に送る（同一内容なら履歴は変えない） */
export function pushView(h: BlinkHistory, next: BattleSampleView): BlinkHistory {
  if (viewsEqual(h.current, next)) return h
  return { current: next, previous: h.current }
}

/** スペース等: 現在とひとつ前を入れ替える（ひとつ前がなければ何もしない） */
export function swapView(h: BlinkHistory): BlinkHistory {
  return h.previous ? { current: h.previous, previous: h.current } : h
}

/** 画面表示用の 1 行サマリ */
export function describeView(
  view: BattleSampleView,
  dpr: number,
  size: { width: number; height: number },
  /** 実際に適用中の app.renderer.resolution。渡すと DPR と別項目で併記し、physical はこちらで計算する */
  rendererResolution?: number
): string {
  const physRes = rendererResolution ?? dpr
  return [
    `layout=${view.layout}`,
    `spriteStyle=${view.spriteStyle}`,
    `background=${view.backgroundOn ? 'on' : 'off'}`,
    `party=${effectivePartyCount(view)}`,
    `enemies=${view.enemyCount}`,
    `size=${view.sizeId}`,
    `logical=${size.width}x${size.height}`,
    `DPR=${dpr}`,
    ...(rendererResolution === undefined
      ? []
      : [`resolution=${view.resolutionMode}(renderer.resolution=${rendererResolution})`]),
    `physical=${Math.round(size.width * physRes)}x${Math.round(size.height * physRes)}`,
  ].join('  ')
}
