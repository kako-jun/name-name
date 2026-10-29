/**
 * 一枚絵フィールドサンプルページ (#807) の設定 JSON まわりの純粋関数。ブラウザ API には触れない。
 * 画像は URL で指す（相対 URL は設定 JSON の URL を基準に解決。assetBaseUrl があれば RPG の画像と同じく
 * `${base}/images/...` に解決する (#746/#785)）。
 */
import { hasOwn } from '../game/ownProperty'
import { parseEncounterGroup } from '../game/enemyGroup'
import {
  formatEncounterGroupErrors,
  validateEncounterGroups,
  type EncounterGroupError,
} from '../game/encounterGroupValidation'
import {
  normalizeEnemyGrid,
  normalizeEnemyWindowOverlapSetting,
  type EnemyGridSize,
} from '../game/enemyGrid'
import { resolveRpgImagePath } from '../game/novelLayout'
import { parseMenuList, parsePoses, resolveUrl, type ParseResult } from '../battleSample/config'
import type { DiagonalFacing, Edge, FieldLink, Facing, Vec } from '../game/fieldWalk'
import { WARP_DEFAULTS, type WarpEffectKind, type WarpTiming } from '../game/fieldWarp'
import { ASSIST_DEFAULTS, type AssistConfig } from '../game/fieldAssist'
import type { ShakeConfig } from '../game/fieldMotion'
import type { EncounterStepConfig, SceneEncounter } from '../game/fieldEncounter'
import type { MonsterDef } from '../types'
import type { BattleEntity } from '../game/spellDsl'
import type { BattleLayoutMode } from '../game/battleLayout'
import type { SpriteStyle } from '../game/spriteStyle'
import type { BattleMotionPreset, BattlePresentation } from '../game/battleMotion'
import { hasBattleEffects, parseBattleEffects, type BattleEffects } from '../game/battleEffects'
import { hasEmotions, parseEmotions, type EmotionSheets } from '../game/fieldEmotion'
import type { WindowStyle } from '../game/windowStyle'
import { normalizeDialogStyle, normalizeMsPerChar, type DialogStyle } from '../game/ffDialog'
import { parseCommandIds, type CommandId, type CommandLayout } from '../game/battleCommands'
import type { BattleAtbConfig } from '../game/battleAtb'
import type { BattleItemEntry, BattleSkillEntry, BattleSpellEntry } from '../game/battleMenu'

export const EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right']
export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right']
export const DIAGONAL_FACINGS: readonly DiagonalFacing[] = [
  'upLeft',
  'upRight',
  'downLeft',
  'downRight',
]

/** 斜めの向きの左右の相方（mirrorOf の反転元にできるのはこれだけ） */
export const MIRROR_PARTNER: Record<DiagonalFacing, DiagonalFacing> = {
  upLeft: 'upRight',
  upRight: 'upLeft',
  downLeft: 'downRight',
  downRight: 'downLeft',
}

/** 窓の外の流れる景色 (#864)。背景より奥に、横へタイル敷きして流す */
export interface SceneScrollConfig {
  /** 景色の画像 URL（横にタイルされる。高さは画像のまま） */
  image: string
  /** 1 秒に流れる量（背景ピクセル）。正で右へ、負で左へ。0 なら止まった景色 */
  speed: number
  /** 景色の上端の y（背景ピクセル）。既定 0 */
  y: number
}

/** ワープ先 (#864)。`warps.<id>`。遷移先のシーン・出現位置・向き・演出を固定する */
export interface FieldWarp {
  id: string
  to: string
  /** 遷移先の足元（背景ピクセル）。歩けない点なら近い歩ける点へずらす */
  at: Vec
  /** 到着後の向き。省略 = 向きを変えない */
  facing?: Facing
  effect: WarpEffectKind
  timing: WarpTiming
}

/** 同行者 (#862)。条件付き通行で主人公の後ろに現れて押す。歩行絵は主人公と同じ 4 方向×3 コマ（#861 でアクスタ化するまでの暫定の見た目） */
export interface FieldCompanion {
  sprites: Record<Facing, [string, string, string]>
  /** 表示高さ（背景ピクセル）。省略 = 主人公と同じ高さ */
  height?: number
  /** 脚本の `[感情: <name>, …]` で同行者を指す話者名 (#946)。省略時は固定の対象名 `同行者` だけで指せる */
  name?: string
  /** 歩行周期（`player.cycle` と同じ書式）。未指定は undefined＝従来の [0, 1, 2]。主人公の周期は引き継がない */
  cycle?: number[]
  /** 止まっているときのコマ番号 (0..2)。未指定は undefined＝従来の 0 */
  idleFrame?: number
}

/**
 * 一枚絵フィールドの NPC (#841 段階1)。`scenes.<id>.npcs[]`。位置は足元（背景ピクセル）。
 * 見た目は `sprites`（4 方向 × 3 コマの歩行絵。立ち止まりは 1 コマ目）か `sprite`（単一画像）のどちらか。台詞は固定の 1 行
 */
export interface FieldNpc {
  id: string
  name: string
  x: number
  y: number
  sprites?: Record<Facing, [string, string, string]>
  sprite?: string
  /** 表示する高さ（背景ピクセル）。省略 = そのシーンの主人公と同じ高さ */
  height?: number
  /** 最初に向く向き。省略 = down（`sprite` 単一画像のときは向きの見た目は変わらない） */
  facing: Facing
  /** 話しかけたとき DialogBox に出す 1 行（`scene` が無い・見つからないときの台詞） */
  line: string
  /** 脚本 `.md`（設定の `scriptUrl`）の `[イベント <name>]` の名前 (#841 段階2)。省略 = 固定の `line` だけ */
  scene?: string
}

export interface FieldSceneConfig {
  id: string
  /** 背景画像の URL */
  background: string
  /** 歩行マスク画像の URL（白=歩ける・黒=歩けない。背景と同じ大きさ） */
  mask: string
  /**
   * 前面レイヤー (#866)。背景と同じ大きさの透明 PNG の URL。主人公（と同行者）より手前に重ねて描く（天井から吊った物の下を歩くと隠れる）。
   * 見た目だけで、歩行マスク・リンク・エンカウントには関与しない。省略 = 従来どおり（前面なし）
   */
  foreground?: string
  /** 走行中の揺れ (#864)。描画だけを上下に揺らす（足元・マスク判定は動かない）。省略 = 揺れない */
  shake?: ShakeConfig
  /** 窓の外の流れる景色 (#864)。背景の透明な部分（窓）から見える。省略 = なし */
  scroll?: SceneScrollConfig
  links: FieldLink[]
  /** NPC (#841)。省略 = NPC なし（従来どおり） */
  npcs?: FieldNpc[]
  /** このシーンでの主人公の表示高さ（背景ピクセル）。省略 = 全体の `player.height` (#810) */
  playerHeight?: number
  /** ランダムエンカウント (#809)。省略 = エンカウントなし */
  encounter: (SceneEncounter & { background?: string }) | null
}

/** 戦闘画面の設定 (#809) */
export interface FieldBattleConfig {
  layout: BattleLayoutMode
  spriteStyle: SpriteStyle
  /** 戦闘の既定の背景 URL（シーンの encounter.background で上書き可） */
  background?: string
  /** 戦闘中の画面の大きさ（戦闘サンプルの 800x450 と同じ既定） */
  width: number
  height: number
  /** 敵の見えないグリッド (#839)。`battle.enemyGrid: "6x2"`。不正値・未指定は undefined＝従来の配置 */
  enemyGrid?: EnemyGridSize
  /** 敵の絵と窓の重なり許容量 (#838/#839)。`battle.enemyWindowOverlap`（0〜0.5 に丸める）。未指定は既定 */
  enemyWindowOverlap?: number
  /** 演出方式 (#883)。`battle.presentation`: `dq` / `ff`。未指定は undefined＝BattleScreen の既定（dq） */
  presentation?: BattlePresentation
  /** 戦闘モーションのプリセット (#956 / sit-by-me#62)。`battle.motion`: `default` / `snappy`。`presentation: "ff"` かつ `layout: "side"` のときだけ効く。未指定は undefined＝BattleScreen の既定（default＝桁バウンスなし） */
  motion?: BattleMotionPreset
  /** 窓の配色 (#883)。`battle.windowStyle`: `dark` / `ff-blue`。未指定は undefined＝既定（dark） */
  windowStyle?: WindowStyle
  /** コマンド窓の配置 (#883)。`battle.commandLayout`: `grid` / `cross`。未指定は undefined＝既定（grid） */
  commandLayout?: CommandLayout
  /** コマンドの構成と順序 (#873)。`battle.commands`: `["skill", "spell", "item", "escape"]`。未指定は undefined＝既定（attack / spell / item / escape） */
  commands?: CommandId[]
  /** ATB (#883)。`battle.atb: "on"` のとき `{ mode: battle.atbMode ?? "wait" }`。未指定・"off" は undefined＝ターン制 */
  atb?: BattleAtbConfig
  /** 戦闘のエフェクト重ね (#936)。`battle.effects`（戦闘サンプルの `effects` と同じ書式）。不正な種類は警告して無視。`presentation: "ff"` のときだけ効く。未指定は undefined＝エフェクトなし */
  effects?: BattleEffects
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
    /** 向きごとに 3 コマの画像 URL。斜め 4 方向 (#811) は optional（`mirrorOf` で埋めた分は含まない） */
    sprites: Record<Facing, [string, string, string]> &
      Partial<Record<DiagonalFacing, [string, string, string]>>
    /**
     * 斜めの向きを、左右の相方（upLeft↔upRight、downLeft↔downRight）の画像の左右反転で済ませる指定 (#811)。例: `{ upLeft: 'upRight' }`。
     * 斜めの 4 方向がすべて（自前の画像か `mirrorOf` で）揃ったときだけ 8 方向で動く。揃っていなければ 4 方向
     */
    mirrorOf: Partial<Record<DiagonalFacing, DiagonalFacing>>
    /** 表示する高さ（背景ピクセル） */
    height: number
    /** 1 コマの長さ(ms) */
    frameMs: number
    /** 歩行周期（コマ番号 0..2 の並び）。未指定は undefined＝従来の [0, 1, 2]。立位は [0, 1, 2, 1]（接地→通過→接地→通過） */
    cycle?: number[]
    /** 止まっているときのコマ番号 (0..2)。未指定は undefined＝従来の 0。立位は 1（通過コマ） */
    idleFrame?: number
  }
  scenes: Record<string, FieldSceneConfig>
  /** ワープ先 (#864)。省略 = なし */
  warps: Record<string, FieldWarp>
  /** 名前つきの真偽値 (#862)。脚本が `window.fieldSample.setFlag` で変える。値は初期値。省略 = なし */
  flags: Record<string, boolean>
  /** 条件付き通行 (#862)。歩行マスクの橙（#FF9D00）を、フラグが成り立つ間だけ通れるようにする。省略 = 橙も黒と同じ */
  assist: AssistConfig | null
  /** 条件付き通行で現れる同行者 (#862)。省略 = 同行者は出さず、通れるだけ */
  companion: FieldCompanion | null
  /** 感情吹き出し (#937)。`emotions`（種類名 → 絵の宣言）。見た目だけで歩行・戦闘には関与しない。不正な種類は警告して無視。未指定は undefined＝吹き出しなし */
  emotions?: EmotionSheets
  /**
   * 感情吹き出しの外部 JSON (#946)。`emotionsUrl`（`field_emotions` 相当）。解決済みの URL と、中の画像 URL を解決する関数（インライン `emotions` と同じ規則）。
   * 読み込み（fetch）は main.ts の責務。未指定は undefined
   */
  emotionsSource?: { url: string; resolveImage: (u: string) => string | null }
  /**
   * NPC の会話を書いた脚本 `.md` の URL (#841 段階2)。`scriptUrl`。解決済みの URL。読み込み（fetch・パース）は main.ts の責務。未指定は undefined
   */
  scriptUrl?: string
  /**
   * 会話窓のスタイル (#840)。`dialogStyle`: `ff` = 画面上部に固定・ff-blue・1 文字ずつ。未指定は undefined＝従来の下部の窓。不正な値は警告して無視
   */
  dialogStyle?: DialogStyle
  /** 会話窓の 1 文字あたり ms (#840)。`dialogMsPerChar`（0 = 即時表示）。未指定は undefined＝窓の既定（ff は戦闘ログと同じ 30）。不正な値は警告して無視 */
  dialogMsPerChar?: number
  /** 歩数の刻みと連続エンカウント抑制 (#809) */
  encounter: EncounterStepConfig
  /** エンカウントで使うモンスターのマスター (#809) */
  monsters: Record<string, MonsterDef>
  /** 戦闘に出す味方 (#809)。主人公のポーズ画像を sprite に指す */
  party: BattleEntity[]
  battle: FieldBattleConfig
  /**
   * 戦闘の候補窓 (#890)。`spells`: 味方全員が使える呪文（戦闘サンプルと同じ書式）。`items`: 試作用の所持品（`count` が所持数。
   * 本編の inventory とは無関係で、戦闘のたびに設定の値から始まる）。どちらも `layout: "side"` の候補窓に出る（`commandLayout` は `grid` でも `cross` でも可）。
   * 未指定は空＝じゅもん・どうぐの窓が開かない（従来どおり）
   */
  spells: BattleSpellEntry[]
  items: BattleItemEntry[]
  /** 「わざ」の候補 (#873)。味方全員共通（`id` / `name` / `target`〔特技の相対表現。既定 `相手単体`〕/ `effect` / `builtin`）。MP なし。`battle.commands` に `skill` があると `layout: "side"` の候補窓に出る（`commandLayout` は `grid` でも `cross` でも可）。未指定は空 */
  skills: BattleSkillEntry[]
  /** 敵グリッドに収まらず無効化した群 (#839 段5)。`battle.enemyGrid` が有効で 1 件以上あるときだけ入る */
  groupErrors?: EncounterGroupError[]
  /** 設定は読めたが効かない組み合わせの警告 (#883)。`layout: "front"` と `presentation: "ff"`／`commandLayout: "cross"` など。無ければ省略 */
  warnings?: string[]
}

/**
 * 歩行周期 `cycle`（0〜2 の整数を 1〜16 個）と停止コマ `idleFrame`（0〜2）の検証 (sit-by-me#59)。
 * 主人公（player）と同行者（companion）で共通。不正な項目は警告して落とす（既定へ戻る）。
 * `cycle` だけ書いて `idleFrame` を省くと停止は 0 のまま（立位は 2 つを組で書く）ので、その旨も警告する
 */
export function parseGait(
  obj: Obj,
  path: string,
  warnings: string[]
): { cycle?: number[]; idleFrame?: number } {
  const out: { cycle?: number[]; idleFrame?: number } = {}
  if (obj.cycle !== undefined) {
    const c = obj.cycle
    if (
      Array.isArray(c) &&
      c.length >= 1 &&
      c.length <= 16 &&
      c.every((n) => Number.isInteger(n) && n >= 0 && n <= 2)
    )
      out.cycle = c as number[]
    else
      warnings.push(
        `${path}.cycle は 0〜2 の整数を 1〜16 個並べた配列が必要です（無視して既定の [0, 1, 2] を使います）`
      )
  }
  if (obj.idleFrame !== undefined) {
    const i = obj.idleFrame
    if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= 2) out.idleFrame = i
    else warnings.push(`${path}.idleFrame は 0〜2 の整数が必要です（無視して既定の 0 を使います）`)
  }
  if (out.cycle && out.idleFrame === undefined && obj.idleFrame === undefined)
    warnings.push(
      `${path}.cycle だけで ${path}.idleFrame がありません（止まっているときは 0 コマ目になります。立位は cycle と idleFrame を組で書いてください）`
    )
  return out
}

export const DEFAULTS = {
  speed: 260,
  edgeThreshold: 6,
  height: 96,
  frameMs: 140,
  stepDistance: 80,
  minSteps: 3,
  battleWidth: 800,
  battleHeight: 450,
  shakePeriodMs: 600,
} as const

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
  if (typeof raw.startScene !== 'string' || !hasOwn(raw.scenes, raw.startScene))
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
  const parseFrames = (v: unknown, path: string): ParseResult<[string, string, string]> => {
    if (!Array.isArray(v) || v.length !== 3) return fail(`${path} は 3 コマ分の URL 配列が必要です`)
    const urls: string[] = []
    for (let i = 0; i < 3; i++) {
      const u = url(v[i], `${path}[${i}]`)
      if (!u.ok) return u
      urls.push(u.value)
    }
    return { ok: true, value: urls as [string, string, string] }
  }
  const sprites = {} as FieldSampleConfig['player']['sprites']
  for (const f of FACINGS) {
    const r = parseFrames(raw.player.sprites[f], `player.sprites.${f}`)
    if (!r.ok) return r
    sprites[f] = r.value
  }
  // 斜め 4 方向 (#811)。未指定は 4 方向のまま（後方互換）
  for (const f of DIAGONAL_FACINGS) {
    if (raw.player.sprites[f] === undefined) continue
    const r = parseFrames(raw.player.sprites[f], `player.sprites.${f}`)
    if (!r.ok) return r
    sprites[f] = r.value
  }
  const mirrorOf: FieldSampleConfig['player']['mirrorOf'] = {}
  const mirrorRaw = raw.player.sprites.mirrorOf
  if (mirrorRaw !== undefined) {
    if (!isObj(mirrorRaw)) return fail('player.sprites.mirrorOf はオブジェクトが必要です')
    for (const [k, v] of Object.entries(mirrorRaw)) {
      if (!(DIAGONAL_FACINGS as readonly string[]).includes(k))
        return fail(
          `player.sprites.mirrorOf.${k} は斜めの向き（${DIAGONAL_FACINGS.join(' / ')}）のどれかにしてください`
        )
      // 左右反転は x だけを入れ替えるので、反転元は左右の相方（upLeft↔upRight / downLeft↔downRight）だけ
      const partner = MIRROR_PARTNER[k as DiagonalFacing]
      if (v !== partner)
        return fail(
          `player.sprites.mirrorOf.${k} は左右の相方 ${partner} だけを指せます（左右反転なので上下は変えられません）`
        )
      const to = partner
      if (sprites[k as DiagonalFacing])
        return fail(`player.sprites.${k} と player.sprites.mirrorOf.${k} は同時に指定できません`)
      mirrorOf[k as DiagonalFacing] = to
    }
    for (const [k, to] of Object.entries(mirrorOf)) {
      if (!sprites[to as DiagonalFacing])
        return fail(
          `player.sprites.mirrorOf.${k} の反転元 ${to} には、mirrorOf ではなく自前の画像（player.sprites.${to}）が必要です`
        )
    }
  }
  const diagCount = DIAGONAL_FACINGS.filter((f) => sprites[f] || mirrorOf[f]).length
  if (diagCount !== 0 && diagCount !== DIAGONAL_FACINGS.length)
    return fail(
      `斜めの向きは 4 方向（${DIAGONAL_FACINGS.join(' / ')}）すべてを、画像か mirrorOf で揃えてください（いまは ${diagCount} 方向）`
    )
  const height = positive(raw.player.height, DEFAULTS.height, 'player.height')
  if (!height.ok) return height
  const frameMs = positive(raw.player.frameMs, DEFAULTS.frameMs, 'player.frameMs')
  if (!frameMs.ok) return frameMs
  // 歩行周期（任意）。不正なら設定を落とさず警告して既定へ戻す
  const walkWarnings: string[] = []
  const playerGait = parseGait(raw.player, 'player', walkWarnings)

  const scenes: Record<string, FieldSceneConfig> = {}
  /** NPC の不正（その NPC だけ読み飛ばす）の警告 (#841)。後で warnings へ合流する */
  const npcWarnings: string[] = []
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
          !Number.isFinite(r[0]) ||
          !Number.isFinite(r[1]) ||
          r[0] > r[1]
        )
          return fail(`${p}.range は [小, 大] の数値 2 つが必要です`)
        if (typeof l.to !== 'string' || !hasOwn(raw.scenes, l.to))
          return fail(`${p}.to は scenes のキーのどれか: ${JSON.stringify(l.to)}`)
        links.push({ edge: l.edge as Edge, range: [r[0], r[1]], to: l.to })
      }
    }
    let foreground: string | undefined
    if (sc.foreground !== undefined) {
      const fg = url(sc.foreground, `scenes.${id}.foreground`)
      if (!fg.ok) return fg
      foreground = fg.value
    }
    let shake: ShakeConfig | undefined
    if (sc.shake !== undefined) {
      const p = `scenes.${id}.shake`
      if (!isObj(sc.shake)) return fail(`${p} はオブジェクトが必要です`)
      const amplitudeY = positive(sc.shake.amplitudeY, 0, `${p}.amplitudeY`)
      if (!amplitudeY.ok) return amplitudeY
      if (sc.shake.amplitudeY === undefined) return fail(`${p}.amplitudeY が必要です`)
      const periodMs = positive(sc.shake.periodMs, DEFAULTS.shakePeriodMs, `${p}.periodMs`)
      if (!periodMs.ok) return periodMs
      shake = { amplitudeY: amplitudeY.value, periodMs: periodMs.value }
    }
    let scroll: SceneScrollConfig | undefined
    if (sc.scroll !== undefined) {
      const p = `scenes.${id}.scroll`
      if (!isObj(sc.scroll)) return fail(`${p} はオブジェクトが必要です`)
      const image = url(sc.scroll.image, `${p}.image`)
      if (!image.ok) return image
      const speed = sc.scroll.speed
      if (typeof speed !== 'number' || !Number.isFinite(speed))
        return fail(
          `${p}.speed は数値（背景ピクセル/秒。正=右へ・負=左へ）: ${JSON.stringify(speed)}`
        )
      const sy = sc.scroll.y === undefined ? 0 : sc.scroll.y
      if (typeof sy !== 'number' || !Number.isFinite(sy))
        return fail(`${p}.y は数値: ${JSON.stringify(sy)}`)
      scroll = { image: image.value, speed, y: sy }
    }
    let playerHeight: number | undefined
    if (sc.playerHeight !== undefined) {
      const ph = positive(sc.playerHeight, 0, `scenes.${id}.playerHeight`)
      if (!ph.ok) return ph
      playerHeight = ph.value
    }
    let encounter: FieldSceneConfig['encounter'] = null
    if (sc.encounter !== undefined) {
      const e = sc.encounter
      const p = `scenes.${id}.encounter`
      if (!isObj(e)) return fail(`${p} はオブジェクトが必要です`)
      if (typeof e.rate !== 'number' || !Number.isFinite(e.rate) || e.rate < 0)
        return fail(`${p}.rate は 0 以上の数値（0=なし・N=1/N・1=毎回）: ${JSON.stringify(e.rate)}`)
      if (!Array.isArray(e.groups) || !e.groups.every((g) => typeof g === 'string'))
        return fail(`${p}.groups は文字列の配列が必要です`)
      let bg: string | undefined
      if (e.background !== undefined) {
        const u = url(e.background, `${p}.background`)
        if (!u.ok) return u
        bg = u.value
      }
      encounter = { rate: e.rate, groups: e.groups as string[], ...(bg ? { background: bg } : {}) }
    }
    const npcs = parseNpcs(sc.npcs, `scenes.${id}.npcs`, url, parseFrames, npcWarnings)
    scenes[id] = {
      id,
      background: background.value,
      mask: mask.value,
      ...(npcs.length > 0 ? { npcs } : {}),
      ...(foreground !== undefined ? { foreground } : {}),
      ...(shake ? { shake } : {}),
      ...(scroll ? { scroll } : {}),
      links,
      ...(playerHeight !== undefined ? { playerHeight } : {}),
      encounter,
    }
  }

  // ---- フラグと条件付き通行 (#862) ----
  const flags: Record<string, boolean> = {}
  if (raw.flags !== undefined) {
    if (!isObj(raw.flags)) return fail('flags はオブジェクトが必要です')
    for (const [name, v] of Object.entries(raw.flags)) {
      if (typeof v !== 'boolean') return fail(`flags.${name} は true / false: ${JSON.stringify(v)}`)
      flags[name] = v
    }
  }
  const flagName = (v: unknown, path: string): ParseResult<string> => {
    if (typeof v !== 'string' || !hasOwn(flags, v))
      return fail(`${path} は flags に宣言したフラグ名のどれか: ${JSON.stringify(v)}`)
    return { ok: true, value: v }
  }
  let companion: FieldCompanion | null = null
  if (raw.companion !== undefined) {
    const c = raw.companion
    if (!isObj(c) || !isObj(c.sprites)) return fail('companion.sprites が必要です')
    const cs = {} as FieldCompanion['sprites']
    for (const f of FACINGS) {
      const r = parseFrames(c.sprites[f], `companion.sprites.${f}`)
      if (!r.ok) return r
      cs[f] = r.value
    }
    let ch: number | undefined
    if (c.height !== undefined) {
      const h = positive(c.height, 0, 'companion.height')
      if (!h.ok) return h
      ch = h.value
    }
    let cn: string | undefined
    if (c.name !== undefined) {
      if (typeof c.name !== 'string' || !c.name.trim())
        return fail(`companion.name は空でない文字列が必要です: ${JSON.stringify(c.name)}`)
      cn = c.name.trim()
    }
    companion = {
      sprites: cs,
      ...(ch !== undefined ? { height: ch } : {}),
      ...(cn !== undefined ? { name: cn } : {}),
      ...parseGait(c, 'companion', walkWarnings),
    }
  }
  let assist: AssistConfig | null = null
  if (raw.assist !== undefined) {
    const a = raw.assist
    if (!isObj(a)) return fail('assist はオブジェクトが必要です')
    const reqRaw = Array.isArray(a.requires) ? a.requires : [a.requires]
    if (a.requires === undefined || reqRaw.length === 0)
      return fail('assist.requires（フラグ名か、その配列）が必要です')
    const requires: string[] = []
    for (let i = 0; i < reqRaw.length; i++) {
      const r = flagName(
        reqRaw[i],
        Array.isArray(a.requires) ? `assist.requires[${i}]` : 'assist.requires'
      )
      if (!r.ok) return r
      requires.push(r.value)
    }
    let unless: string | undefined
    if (a.unless !== undefined) {
      const r = flagName(a.unless, 'assist.unless')
      if (!r.ok) return r
      unless = r.value
    }
    let ghostWhen: string | undefined
    if (a.ghostWhen !== undefined) {
      const r = flagName(a.ghostWhen, 'assist.ghostWhen')
      if (!r.ok) return r
      ghostWhen = r.value
    }
    const speedFactor = positive(a.speedFactor, ASSIST_DEFAULTS.speedFactor, 'assist.speedFactor')
    if (!speedFactor.ok) return speedFactor
    const offset = positive(a.offset, ASSIST_DEFAULTS.offset, 'assist.offset')
    if (!offset.ok) return offset
    let ghostAlpha: number = ASSIST_DEFAULTS.ghostAlpha
    if (a.ghostAlpha !== undefined) {
      if (typeof a.ghostAlpha !== 'number' || !(a.ghostAlpha >= 0 && a.ghostAlpha <= 1))
        return fail(`assist.ghostAlpha は 0〜1 の数値: ${JSON.stringify(a.ghostAlpha)}`)
      ghostAlpha = a.ghostAlpha
    }
    let fadeMs: number = ASSIST_DEFAULTS.fadeMs
    if (a.fadeMs !== undefined) {
      if (typeof a.fadeMs !== 'number' || !Number.isFinite(a.fadeMs) || a.fadeMs < 0)
        return fail(`assist.fadeMs は 0 以上の数値(ms): ${JSON.stringify(a.fadeMs)}`)
      fadeMs = a.fadeMs
    }
    assist = {
      requires,
      ...(unless !== undefined ? { unless } : {}),
      ...(ghostWhen !== undefined ? { ghostWhen } : {}),
      speedFactor: speedFactor.value,
      ghostAlpha,
      offset: offset.value,
      fadeMs,
    }
  }
  if (companion && !assist)
    return fail('companion は assist（条件付き通行）と一緒に指定してください')

  // ---- ワープ (#864) ----
  const warps: Record<string, FieldWarp> = {}
  if (raw.warps !== undefined) {
    if (!isObj(raw.warps)) return fail('warps はオブジェクトが必要です')
    for (const [wid, w] of Object.entries(raw.warps)) {
      const p = `warps.${wid}`
      if (!isObj(w)) return fail(`${p} はオブジェクトが必要です`)
      if (typeof w.to !== 'string' || !hasOwn(scenes, w.to))
        return fail(`${p}.to は scenes のキーのどれか: ${JSON.stringify(w.to)}`)
      const at = w.at
      if (
        !isObj(at) ||
        typeof at.x !== 'number' ||
        typeof at.y !== 'number' ||
        !Number.isFinite(at.x) ||
        !Number.isFinite(at.y)
      )
        return fail(`${p}.at は { x, y }（数値）が必要です`)
      if (w.facing !== undefined && !FACINGS.includes(w.facing as Facing))
        return fail(`${p}.facing は ${FACINGS.join(' / ')} のどれか: ${JSON.stringify(w.facing)}`)
      const effect = w.effect === undefined ? 'fade' : w.effect
      if (effect !== 'fade' && effect !== 'flash')
        return fail(`${p}.effect は "fade" か "flash": ${JSON.stringify(effect)}`)
      const timing: WarpTiming = { ...WARP_DEFAULTS[effect] }
      for (const k of ['outMs', 'holdMs', 'inMs'] as const) {
        const v = w[k]
        if (v === undefined) continue
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
          return fail(`${p}.${k} は 0 以上の数値(ms): ${JSON.stringify(v)}`)
        timing[k] = v
      }
      warps[wid] = {
        id: wid,
        to: w.to,
        at: { x: at.x, y: at.y },
        ...(w.facing !== undefined ? { facing: w.facing as Facing } : {}),
        effect,
        timing,
      }
    }
  }

  // ---- ランダムエンカウント・戦闘 (#809) ----
  const stepRaw = raw.encounter === undefined ? {} : raw.encounter
  if (!isObj(stepRaw)) return fail('encounter はオブジェクトが必要です')
  const stepDistance = positive(
    stepRaw.stepDistance,
    DEFAULTS.stepDistance,
    'encounter.stepDistance'
  )
  if (!stepDistance.ok) return stepDistance
  const minSteps = stepRaw.minSteps === undefined ? DEFAULTS.minSteps : stepRaw.minSteps
  if (typeof minSteps !== 'number' || !Number.isInteger(minSteps) || minSteps < 0)
    return fail(`encounter.minSteps は 0 以上の整数: ${JSON.stringify(minSteps)}`)

  const monsters: Record<string, MonsterDef> = {}
  if (raw.monsters !== undefined) {
    if (!isObj(raw.monsters)) return fail('monsters はオブジェクトが必要です')
    for (const [mid, m] of Object.entries(raw.monsters)) {
      const e = parseEntity(m, mid, `monsters.${mid}`, url)
      if (!e.ok) return e
      const size = parseMonsterSize((m as Obj).size, `monsters.${mid}.size`)
      if (!size.ok) return size
      const scale = parseMonsterScale((m as Obj).scale, `monsters.${mid}.scale`)
      if (!scale.ok) return scale
      monsters[mid] = {
        id: mid,
        name: e.value.name,
        hp: e.value.hp,
        mp: e.value.mp,
        atk: e.value.atk,
        def: e.value.def,
        agi: e.value.agi,
        exp: e.value.exp ?? 0,
        gold: e.value.gold ?? 0,
        ...(e.value.sprite ? { sprite: e.value.sprite } : {}),
        ...(e.value.poses ? { poses: e.value.poses } : {}),
        ...(size.value ? { size: size.value } : {}),
        ...(scale.value !== undefined ? { scale: scale.value } : {}),
      }
    }
  }
  for (const sc of Object.values(scenes)) {
    for (const g of sc.encounter?.groups ?? []) {
      const parsed = parseEncounterGroup(g)
      if (parsed.warnings.length > 0)
        return fail(`scenes.${sc.id}.encounter.groups の "${g}": ${parsed.warnings[0]}`)
      for (const { id: mid } of parsed.items) {
        if (!hasOwn(monsters, mid))
          return fail(`scenes.${sc.id}.encounter.groups の "${mid}" が monsters にありません`)
      }
    }
  }

  const party: BattleEntity[] = []
  if (raw.party !== undefined) {
    if (!Array.isArray(raw.party)) return fail('party は配列が必要です')
    for (let i = 0; i < raw.party.length; i++) {
      const e = parseEntity(raw.party[i], `party${i + 1}`, `party[${i}]`, url)
      if (!e.ok) return e
      party.push(e.value)
    }
  }
  if (party.length === 0) {
    party.push({
      id: 'hero',
      name: '主人公',
      hp: 30,
      maxHp: 30,
      mp: 8,
      maxMp: 8,
      atk: 8,
      def: 4,
      agi: 5,
    })
  }

  // 戦闘の候補窓 (#890)。戦闘サンプルと同じ parser（spells は味方全員共通）
  const spells = parseMenuList<BattleSpellEntry>(raw.spells, [], 'spells')
  if (!spells.ok) return spells
  const items = parseMenuList<BattleItemEntry>(raw.items, [], 'items')
  if (!items.ok) return items
  const skills = parseMenuList<BattleSkillEntry>(raw.skills, [], 'skills')
  if (!skills.ok) return skills

  const b = raw.battle === undefined ? {} : raw.battle
  if (!isObj(b)) return fail('battle はオブジェクトが必要です')
  if (b.layout !== undefined && b.layout !== 'front' && b.layout !== 'side')
    return fail(`battle.layout は "front" か "side": ${JSON.stringify(b.layout)}`)
  if (b.spriteStyle !== undefined && b.spriteStyle !== 'none' && b.spriteStyle !== 'acrylic')
    return fail(`battle.spriteStyle は "none" か "acrylic": ${JSON.stringify(b.spriteStyle)}`)
  if (b.presentation !== undefined && b.presentation !== 'dq' && b.presentation !== 'ff')
    return fail(`battle.presentation は "dq" か "ff": ${JSON.stringify(b.presentation)}`)
  if (b.windowStyle !== undefined && b.windowStyle !== 'dark' && b.windowStyle !== 'ff-blue')
    return fail(`battle.windowStyle は "dark" か "ff-blue": ${JSON.stringify(b.windowStyle)}`)
  if (b.commandLayout !== undefined && b.commandLayout !== 'grid' && b.commandLayout !== 'cross')
    return fail(`battle.commandLayout は "grid" か "cross": ${JSON.stringify(b.commandLayout)}`)
  let commands: CommandId[] | undefined
  if (b.commands !== undefined) {
    if (!Array.isArray(b.commands) || b.commands.some((c) => typeof c !== 'string'))
      return fail(`battle.commands は文字列の配列が必要です: ${JSON.stringify(b.commands)}`)
    commands = parseCommandIds((b.commands as string[]).join(','))
    if (!commands || commands.length !== (b.commands as string[]).length)
      return fail(
        `battle.commands は attack / skill / summon / spell / item / escape を重複なく並べてください: ${JSON.stringify(b.commands)}`
      )
  }
  if (b.motion !== undefined && b.motion !== 'default' && b.motion !== 'snappy')
    return fail(`battle.motion は "default" か "snappy": ${JSON.stringify(b.motion)}`)
  if (b.atb !== undefined && b.atb !== 'on' && b.atb !== 'off')
    return fail(`battle.atb は "on" か "off": ${JSON.stringify(b.atb)}`)
  if (b.atbMode !== undefined && b.atbMode !== 'wait' && b.atbMode !== 'active')
    return fail(`battle.atbMode は "wait" か "active": ${JSON.stringify(b.atbMode)}`)
  // front では効かない設定の組（静かに無視されるので警告する。読み込みは成功のまま）
  const warnings: string[] = []
  if (b.layout === 'front') {
    if (b.presentation === 'ff')
      warnings.push(
        'battle.presentation "ff" は layout "side" のときだけ効きます（"front" では無視されます）'
      )
    if (b.commandLayout === 'cross')
      warnings.push(
        'battle.commandLayout "cross" は layout "side" のときだけ効きます（"front" では無視されます）'
      )
  }
  if (b.motion !== undefined && b.presentation !== 'ff')
    warnings.push('battle.motion は presentation "ff" のときだけ効きます（"dq" では無視されます）')
  warnings.push(...walkWarnings)
  warnings.push(...npcWarnings)
  // エフェクト重ね (#936)。不正な種類は読み込みを止めず警告にする（画像 URL は他の画像と同じく assetBaseUrl 基準）
  const fx = parseBattleEffects(b.effects, (u) =>
    resolveUrl(resolveRpgImagePath(assetBase, u), baseUrl)
  )
  warnings.push(...fx.warnings.map((w) => `battle.${w}`))
  if (hasBattleEffects(fx.effects) && b.presentation !== 'ff')
    warnings.push('battle.effects は presentation "ff" のときだけ効きます（"dq" では無視されます）')
  // 感情吹き出し (#937)。不正な種類は読み込みを止めず警告にする（画像 URL は他の画像と同じく assetBaseUrl 基準）
  const em = parseEmotions(raw.emotions, (u) =>
    resolveUrl(resolveRpgImagePath(assetBase, u), baseUrl)
  )
  warnings.push(...em.warnings)
  // 外部 JSON (#946)。URL は他のアセットと同じ規則で解決する。不正な値・解決できない URL は警告して無視（読み込みは成功のまま）
  let emotionsSource: FieldSampleConfig['emotionsSource']
  if (raw.emotionsUrl !== undefined) {
    const eu =
      typeof raw.emotionsUrl === 'string' && raw.emotionsUrl.trim()
        ? resolveUrl(resolveRpgImagePath(assetBase, raw.emotionsUrl.trim()), baseUrl)
        : null
    if (eu)
      emotionsSource = {
        url: eu,
        resolveImage: (u) => resolveUrl(resolveRpgImagePath(assetBase, u), baseUrl),
      }
    else
      warnings.push(
        `emotionsUrl は URL 文字列である必要があります: ${JSON.stringify(raw.emotionsUrl)}（無視します）`
      )
  }
  // NPC の脚本 (#841 段階2)。emotionsUrl と同じ規則。不正は警告して無視（固定の line で動く）
  let scriptUrl: string | undefined
  if (raw.scriptUrl !== undefined) {
    const su =
      typeof raw.scriptUrl === 'string' && raw.scriptUrl.trim()
        ? resolveUrl(resolveRpgImagePath(assetBase, raw.scriptUrl.trim()), baseUrl)
        : null
    if (su) scriptUrl = su
    else
      warnings.push(
        `scriptUrl は URL 文字列である必要があります: ${JSON.stringify(raw.scriptUrl)}（無視します）`
      )
  }
  // 会話窓のスタイル・速度 (#840)。不正は警告して無視（従来の窓・既定の速度で動く）
  let dialogStyle: DialogStyle | undefined
  if (raw.dialogStyle !== undefined) {
    dialogStyle = normalizeDialogStyle(raw.dialogStyle)
    if (!dialogStyle)
      warnings.push(
        `dialogStyle は "ff" のみ指定できます: ${JSON.stringify(raw.dialogStyle)}（無視します）`
      )
  }
  let dialogMsPerChar: number | undefined
  if (raw.dialogMsPerChar !== undefined) {
    dialogMsPerChar = normalizeMsPerChar(raw.dialogMsPerChar)
    if (dialogMsPerChar === undefined)
      warnings.push(
        `dialogMsPerChar は 0 以上 1000 以下の数値（ミリ秒/文字）である必要があります: ${JSON.stringify(raw.dialogMsPerChar)}（無視します）`
      )
  }
  // scriptUrl が無いのに scene を書いた NPC は、固定の line で話す（読み込み時に気づけるよう警告）
  if (!scriptUrl)
    for (const [sid, sc] of Object.entries(scenes))
      for (const n of sc.npcs ?? [])
        if (n.scene !== undefined)
          warnings.push(
            `scenes.${sid}.npcs の ${n.id} は scene "${n.scene}" を指していますが scriptUrl がありません（固定の line で話します）`
          )
  const bw = positive(b.width, DEFAULTS.battleWidth, 'battle.width')
  if (!bw.ok) return bw
  const bh = positive(b.height, DEFAULTS.battleHeight, 'battle.height')
  if (!bh.ok) return bh
  let battleBg: string | undefined
  if (b.background !== undefined) {
    const u = url(b.background, 'battle.background')
    if (!u.ok) return u
    battleBg = u.value
  }

  // 敵グリッド (#839)。不正値はエラーにせず無効（従来の配置）
  const enemyGrid = normalizeEnemyGrid(typeof b.enemyGrid === 'string' ? b.enemyGrid : undefined)
  const enemyWindowOverlap =
    typeof b.enemyWindowOverlap === 'number' && Number.isFinite(b.enemyWindowOverlap)
      ? normalizeEnemyWindowOverlapSetting(String(b.enemyWindowOverlap))
      : undefined

  // 収まらない群の検証 (#839 段5)。グリッドが有効なときだけ全シーンの群を検証し、収まらない群を除外する
  let groupErrors: EncounterGroupError[] | undefined
  if (enemyGrid) {
    const inputs = Object.values(scenes).flatMap((sc) =>
      (sc.encounter?.groups ?? []).map((spec) => ({ mapId: sc.id, spec }))
    )
    const result = validateEncounterGroups({ grid: enemyGrid, masters: monsters, groups: inputs })
    if (result.errors.length > 0) {
      groupErrors = result.errors
      console.error(`[name-name] ${formatEncounterGroupErrors(result.errors)}`)
      const bad = new Set(
        inputs.filter((_, i) => !result.valid[i]).map((g) => `${g.mapId}\u0000${g.spec}`)
      )
      for (const sc of Object.values(scenes)) {
        const enc = sc.encounter
        if (!enc) continue
        sc.encounter = {
          ...enc,
          groups: enc.groups.filter((spec) => !bad.has(`${sc.id}\u0000${spec}`)),
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      startScene: raw.startScene,
      start: { x: s.x, y: s.y },
      speed: speed.value,
      edgeThreshold: edgeThreshold.value,
      player: {
        sprites,
        mirrorOf,
        height: height.value,
        frameMs: frameMs.value,
        ...playerGait,
      },
      scenes,
      warps,
      flags,
      assist,
      companion,
      ...(hasEmotions(em.emotions) ? { emotions: em.emotions } : {}),
      ...(emotionsSource ? { emotionsSource } : {}),
      ...(scriptUrl ? { scriptUrl } : {}),
      ...(dialogStyle ? { dialogStyle } : {}),
      ...(dialogMsPerChar !== undefined ? { dialogMsPerChar } : {}),
      encounter: { stepDistance: stepDistance.value, minSteps },
      monsters,
      party,
      spells: spells.value,
      items: items.value,
      skills: skills.value,
      battle: {
        layout: b.layout ?? 'side',
        spriteStyle: b.spriteStyle ?? 'none',
        ...(battleBg ? { background: battleBg } : {}),
        width: bw.value,
        height: bh.value,
        ...(enemyGrid ? { enemyGrid } : {}),
        ...(enemyWindowOverlap !== undefined ? { enemyWindowOverlap } : {}),
        ...(b.presentation ? { presentation: b.presentation } : {}),
        ...(b.windowStyle ? { windowStyle: b.windowStyle } : {}),
        ...(b.motion ? { motion: b.motion } : {}),
        ...(b.commandLayout ? { commandLayout: b.commandLayout } : {}),
        ...(commands ? { commands } : {}),
        ...(b.atb === 'on' ? { atb: { mode: b.atbMode ?? 'wait' } } : {}),
        ...(hasBattleEffects(fx.effects) ? { effects: fx.effects } : {}),
      },
      ...(groupErrors ? { groupErrors } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  }
}

/** NPC 1 件で解釈するキー（これ以外は未知として警告） */
const NPC_KEYS: readonly string[] = [
  'id',
  'name',
  'x',
  'y',
  'sprite',
  'sprites',
  'height',
  'facing',
  'line',
  'scene',
]

/**
 * `scenes.<id>.npcs` を解釈する (#841)。配列でなければ警告して無視、1 件ずつ不正なら警告してその NPC だけ読み飛ばす
 * （フィールドは止めない）。未指定は空配列。id 重複は後のほうを警告して捨てる
 */
function parseNpcs(
  raw: unknown,
  path: string,
  url: (v: unknown, path: string) => ParseResult<string>,
  parseFrames: (v: unknown, path: string) => ParseResult<[string, string, string]>,
  warnings: string[]
): FieldNpc[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push(`${path} は配列が必要です（無視します）: ${JSON.stringify(raw)}`)
    return []
  }
  const out: FieldNpc[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const p = `${path}[${i}]`
    const skip = (why: string): void => {
      warnings.push(`${p} ${why}（この NPC は無視します）`)
    }
    const n: unknown = raw[i]
    if (!isObj(n)) {
      skip('はオブジェクトが必要です')
      continue
    }
    // スペルミス（例: `heigth`）が黙って無視されないよう、未知のキーは警告する（NPC は残す）
    for (const k of Object.keys(n))
      if (!NPC_KEYS.includes(k))
        warnings.push(`${p}.${k} は未知のキーです（無視します。スペルを確認してください）`)
    if (typeof n.id !== 'string' || !n.id.trim()) {
      skip('.id は空でない文字列が必要です')
      continue
    }
    if (seen.has(n.id)) {
      skip(`.id "${n.id}" が重複しています`)
      continue
    }
    if (typeof n.name !== 'string' || !n.name.trim()) {
      skip('.name は空でない文字列が必要です')
      continue
    }
    if (
      typeof n.x !== 'number' ||
      typeof n.y !== 'number' ||
      !Number.isFinite(n.x) ||
      !Number.isFinite(n.y)
    ) {
      skip('.x / .y は数値が必要です')
      continue
    }
    if (typeof n.line !== 'string' || !n.line.trim()) {
      skip('.line（台詞 1 行）は空でない文字列が必要です')
      continue
    }
    // scene は任意。不正（空・文字列でない）は警告してその項目だけ無視する（NPC は固定の line で残す）
    let scene: string | undefined
    if (n.scene !== undefined) {
      if (typeof n.scene === 'string' && n.scene.trim()) scene = n.scene.trim()
      else
        warnings.push(
          `${p}.scene は空でない文字列が必要です（無視します。固定の line で話します）: ${JSON.stringify(n.scene)}`
        )
    }
    let facing: Facing = 'down'
    if (n.facing !== undefined) {
      if (!FACINGS.includes(n.facing as Facing)) {
        skip(`.facing は up/down/left/right: ${JSON.stringify(n.facing)}`)
        continue
      }
      facing = n.facing as Facing
    }
    let height: number | undefined
    if (n.height !== undefined) {
      if (typeof n.height !== 'number' || !Number.isFinite(n.height) || n.height <= 0) {
        skip(`.height は 0 より大きい数値: ${JSON.stringify(n.height)}`)
        continue
      }
      height = n.height
    }
    if ((n.sprite === undefined) === (n.sprites === undefined)) {
      skip('は .sprite（単一画像）か .sprites（4 方向 × 3 コマ）のどちらか 1 つが必要です')
      continue
    }
    let sprite: string | undefined
    let sprites: FieldNpc['sprites']
    if (n.sprite !== undefined) {
      const u = url(n.sprite, `${p}.sprite`)
      if (!u.ok) {
        skip(`: ${u.error}`)
        continue
      }
      sprite = u.value
    } else {
      if (!isObj(n.sprites)) {
        skip('.sprites はオブジェクトが必要です')
        continue
      }
      const ss = {} as NonNullable<FieldNpc['sprites']>
      let bad: string | null = null
      for (const f of FACINGS) {
        const r = parseFrames(n.sprites[f], `${p}.sprites.${f}`)
        if (!r.ok) {
          bad = r.error
          break
        }
        ss[f] = r.value
      }
      if (bad) {
        skip(`: ${bad}`)
        continue
      }
      sprites = ss
    }
    seen.add(n.id)
    out.push({
      id: n.id,
      name: n.name,
      x: n.x,
      y: n.y,
      ...(sprites ? { sprites } : {}),
      ...(sprite ? { sprite } : {}),
      ...(height !== undefined ? { height } : {}),
      facing,
      line: n.line,
      ...(scene !== undefined ? { scene } : {}),
    })
  }
  return out
}

/** 全角の数字・x を半角へ（parser/src/master.rs の `to_halfwidth` と同じ範囲。`×` はそのまま） */
function toHalfwidth(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[ｘＸ]/g, 'x')
}

/**
 * `monsters.<id>.size`（"2x1" など。幅x高さ、整数 1 以上）を解釈する。Rust parser の `サイズ:`（master.rs `parse_size_pair`）と同じ書式:
 * x / X / × 区切り・全角数字可・符号や小数は不可・u32 の範囲。未指定は undefined。不正はエラー
 */
export function parseMonsterSize(
  raw: unknown,
  path: string
): ParseResult<{ w: number; h: number } | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  const bad = fail(`${path} は "2x1" のような 幅x高さ（整数 1 以上）: ${JSON.stringify(raw)}`)
  if (typeof raw !== 'string') return bad
  const parts = toHalfwidth(raw).split(/[xX×]/)
  if (parts.length < 2) return bad
  // Rust の split_once は最初の区切りで 2 つに割る。残りに区切りが含まれると数字だけの検査で落ちる
  if (parts.length > 2) return bad
  const [a, b] = parts.map((t) => t.trim())
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return bad
  const w = Number(a)
  const h = Number(b)
  const U32_MAX = 4294967295
  if (w < 1 || h < 1 || w > U32_MAX || h > U32_MAX) return bad
  return { ok: true, value: { w, h } }
}

/** `monsters.<id>.scale`（数値。0.25〜1 に丸める。`倍率:` と同じ範囲）。未指定は undefined。数値でなければエラー */
export function parseMonsterScale(raw: unknown, path: string): ParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'number' || !Number.isFinite(raw))
    return fail(`${path} は数値（0.25〜1 に丸めます）: ${JSON.stringify(raw)}`)
  return { ok: true, value: Math.min(1, Math.max(0.25, raw)) }
}

/** 味方・モンスターの 1 件分の検証（ステータスは数値、sprite は URL に解決） */
function parseEntity(
  raw: unknown,
  id: string,
  path: string,
  url: (v: unknown, path: string) => ParseResult<string>
): ParseResult<BattleEntity> {
  if (!isObj(raw)) return fail(`${path} はオブジェクトが必要です`)
  if (typeof raw.name !== 'string' || !raw.name.trim()) return fail(`${path}.name が必要です`)
  const num = (k: string, def?: number, min = 0): ParseResult<number> => {
    const v = raw[k] === undefined ? def : raw[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min)
      return fail(`${path}.${k} は ${min} 以上の数値が必要です`)
    return { ok: true, value: v }
  }
  // hp 0 だと戦闘が即時終了して進行不能になるので 1 以上
  const hp = num('hp', undefined, 1)
  if (!hp.ok) return hp
  const mp = num('mp', 0)
  if (!mp.ok) return mp
  const atk = num('atk', 5)
  if (!atk.ok) return atk
  const def = num('def', 3)
  if (!def.ok) return def
  const agi = num('agi', 5)
  if (!agi.ok) return agi
  const exp = num('exp', 0)
  if (!exp.ok) return exp
  const gold = num('gold', 0)
  if (!gold.ok) return gold
  const e: BattleEntity = {
    id,
    name: raw.name,
    hp: hp.value,
    maxHp: hp.value,
    mp: mp.value,
    maxMp: mp.value,
    atk: atk.value,
    def: def.value,
    agi: agi.value,
    exp: exp.value,
    gold: gold.value,
  }
  if (raw.sprite !== undefined) {
    const u = url(raw.sprite, `${path}.sprite`)
    if (!u.ok) return u
    e.sprite = u.value
  }
  if (raw.poses !== undefined) {
    const poses = parsePoses(raw.poses, `${path}.poses`, (v) => {
      const r = url(v, `${path}.poses`)
      return r.ok ? r.value : null
    })
    if (!poses.ok) return poses
    if (poses.value) e.poses = poses.value
  }
  return { ok: true, value: e }
}

/**
 * 「今すぐエンカウント（確認用）」の抽選候補（群の文字列の配列）。
 * シーンに群があればそれ。群が空（最初から無い・全群が敵グリッドに収まらず無効化された）なら全モンスターを 1 体ずつの群として使うが、
 * 敵グリッドが有効なときは、1 体でも収まらない（サイズ超過など）モンスターは候補から外す (#839 段5)。
 */
export function forceBattleCandidates(config: FieldSampleConfig, sceneId: string): string[] {
  const groups = hasOwn(config.scenes, sceneId)
    ? (config.scenes[sceneId].encounter?.groups ?? [])
    : []
  if (groups.length > 0) return groups
  const ids = Object.keys(config.monsters)
  const grid = config.battle.enemyGrid
  if (!grid) return ids
  return ids.filter(
    (id) =>
      validateEncounterGroups({
        grid,
        masters: config.monsters,
        groups: [{ mapId: sceneId, spec: id }],
      }).errors.length === 0
  )
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
  const back =
    (hasOwn(config.scenes, link.to) ? config.scenes[link.to] : undefined)?.links.filter(
      (l) => l.to === srcId
    ) ?? []
  if (back.length === 0) return null
  return back.find((l) => l.edge === OPPOSITE[link.edge]) ?? back[0]
}

const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** 読み込み成功時に画面へ出す通知（群エラーの一覧＋警告）。無ければ null。showError は置換なので 1 つにまとめる */
export function configNotice(config: FieldSampleConfig): string | null {
  const parts: string[] = []
  if (config.groupErrors && config.groupErrors.length > 0)
    parts.push(formatEncounterGroupErrors(config.groupErrors))
  if (config.warnings) parts.push(...config.warnings)
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * URL の検索文字列から、設定の読み元を決める (#890)。`?config=` が与えられていれば（URL として解決できなくても）
 * それが優先で、`?fixture=dummy` は `?config=` が無いときだけ効く
 */
export function pickConfigSource(search: string): {
  configParam: string | undefined
  dummy: boolean
} {
  const q = new URLSearchParams(search)
  const configParam = q.get('config')?.trim() || undefined
  return { configParam, dummy: !configParam && q.get('fixture') === 'dummy' }
}
