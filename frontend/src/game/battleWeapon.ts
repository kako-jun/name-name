/**
 * 戦闘の武器レイヤー (#1027)。立ち絵（人物だけの絵）の上に、刀の絵をポーズごとの変換で別レイヤーとして重ねる。
 *
 * **これは実装メモで、契約の正本ではない。** 変換値の契約（座標系・適用順・回転符号・柄アンカー・レイヤー順・union 規則・
 * ready の正本・swing の置き場所・刀なしポーズ・C001 の例外）の正本は sit-by-me の `docs/assets-policy.md`「戦闘人物と刀の合成」。
 * 食い違ったら sit-by-me が正しい。ここには契約を再掲せず、どの関数がどの規則を実装しているかだけを書く。
 *
 * 実装の対応（規則の中身は正本を見る）:
 * - `normalizeWeaponSpec` / `pickWeaponKeys` / `weaponField`: `poses` の予約キー（weapon / weapon-structure / weapon-anchor /
 *   weapon-layers / weapon-catalog / weapon-overrides）を読む。name-name 側の指定口で、sit-by-me の契約には無い。
 * - `buildWeaponRig`: layers JSON（人物ごとの `battle-layers.json`）の `pose_layers` と `ready_weapon_transform` から構造ごとの
 *   変換を組む。union 規則は `pick`（構造キーがあればその構造・無ければ全構造）、構造別サブオブジェクトは `readTransformEntry`、
 *   ready は `ready_weapon_transform` を `pose_layers.ready` に重ねる。刀ごとの上書きは任意の overrides（C001 の
 *   `*-blade-candidates.json` 向け。`shared_pose_transforms.poses.<pose>.candidate_overrides.<刀の絵>`）。catalog は柄アンカーと既定の刀だけ読む。
 * - `resolveWeaponForPose`: 刀なしポーズ（layers に weapon が無い・`weapon: "none..."`）と、変換が無い構えのポーズの ready への倒し。
 * - `computeWeaponPlacement`: 適用順（縮小 → 反転 → 回転 → 柄アンカーを handle_target へ）を Pixi の anchor / scale / rotation で表す。
 *   回転の符号は Pixi が時計回り正なので反転する。
 * - `alphaBoundsFraction`: 透過を切り詰めていない絵を、切り詰め済みの座標に合わせる（`BattleScreen.opaqueBounds` が使う）。
 *
 * 実データでの固定: `battleWeaponSitByMe.test.ts`（sit-by-me の C001〜C004 の抜粋を `__fixtures__` に複写）。
 * この関数群は純粋（PixiJS・DOM に触れない）。画面（`BattleScreen`）が JSON を読み、毎フレーム置き場所を決める。
 */
import type { BattlePose } from './battleMotion'

export type WeaponStructure = 'standing' | 'wheelchair'

export interface Point {
  x: number
  y: number
}

/** 味方が持つ刀の指定（URL / パスは解決前のまま。画像・JSON の読み込みは画面側） */
export interface BattleWeaponSpec {
  /** 刀の絵。省略時は catalog の先頭の刀（`firstCatalogImage`） */
  image?: string
  /** 人物の構造。既定 standing */
  structure: WeaponStructure
  /** 柄アンカー（刀の絵の比）。省略時は catalog の同じファイル名の `handle_center_normalized` */
  anchor?: Point
  /** layers JSON（`pose_layers` / `ready_weapon_transform`） */
  layers?: string
  /** 刀カタログ JSON（`weapons` / `shared_pose_transforms`） */
  catalog?: string
  /**
   * 刀ごとの変換の上書き JSON（任意）。layers と同じ形（`pose_layers` / `ready_weapon_transform`）か、刀カタログと同じ形
   * （`shared_pose_transforms.poses.<pose>` と、その中の `candidate_overrides.<刀の絵のファイル名>`）。layers の上に項目単位で重なる。
   * 人物の layers が全刀共通の変換しか持たないとき、刀ごとの差（刃の長い刀の高さ比・柄ターゲットなど）を設定側から渡す口
   */
  overrides?: string
}

/** ポーズ 1 つ分の刀の変換 */
export interface WeaponTransform {
  /** 刀の絵の高さ ÷ 人物の絵の高さ */
  heightRatio: number
  /** 度。正 = 反時計回り（画面で見て）。左右反転のあとに回す */
  rotationDeg: number
  /** 柄アンカーを置く人物の絵上の点（比） */
  handleTarget: Point
  flipX: boolean
}

export type WeaponLayerName = 'character' | 'weapon'

export interface WeaponRig {
  anchor: Point
  structure: WeaponStructure
  /** ポーズ → 人物と刀の重ね順（下から）。無いポーズは未定義（変換の有無だけで決める） */
  layers: Partial<Record<BattlePose, WeaponLayerName[]>>
  /** ポーズ → 変換。null は「刀なし」と明記されたもの */
  transforms: Partial<Record<BattlePose, WeaponTransform | null>>
}

// ---------------------------------------------------------------------------
// poses の予約キー

const WEAPON_KEYS = [
  'weapon',
  'weapon-structure',
  'weapon-anchor',
  'weapon-layers',
  'weapon-catalog',
  'weapon-overrides',
] as const

/** `poses` の値のうち URL でないもの（URL 解決の対象外にする） */
export const WEAPON_NON_URL_KEYS: readonly string[] = ['weapon-structure', 'weapon-anchor']

/** `poses` の予約キーを取り出す（解決前の生の Record）。刀の絵が無ければ undefined */
export function normalizeWeaponSpec(
  raw: Readonly<Record<string, string>> | null | undefined
): BattleWeaponSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const g: Partial<Record<(typeof WEAPON_KEYS)[number], string>> = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toLowerCase()
    if (!(WEAPON_KEYS as readonly string[]).includes(key)) continue
    if (typeof v !== 'string' || v.trim() === '') continue
    g[key as (typeof WEAPON_KEYS)[number]] = v.trim()
  }
  if (!g.weapon && !g['weapon-catalog']) return undefined
  const structure: WeaponStructure =
    g['weapon-structure']?.toLowerCase() === 'wheelchair' ? 'wheelchair' : 'standing'
  const spec: BattleWeaponSpec = { structure }
  if (g.weapon) spec.image = g.weapon
  const anchor = parseAnchor(g['weapon-anchor'])
  if (anchor) spec.anchor = anchor
  if (g['weapon-layers']) spec.layers = g['weapon-layers']
  if (g['weapon-catalog']) spec.catalog = g['weapon-catalog']
  if (g['weapon-overrides']) spec.overrides = g['weapon-overrides']
  return spec
}

/** `poses` の Record から刀の予約キーだけを抜く（生のまま。設定の読み取りで、正規化済みの poses と一緒に持ち回る用） */
export function pickWeaponKeys(
  raw: Readonly<Record<string, string>> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toLowerCase()
    if ((WEAPON_KEYS as readonly string[]).includes(key) && typeof v === 'string' && v.trim())
      out[key] = v.trim()
  }
  return out
}

/** BattleEntity に写すときのスプレッド用。無ければ何も足さない */
export function weaponField(raw: Readonly<Record<string, string>> | null | undefined): {
  weapon?: BattleWeaponSpec
} {
  const weapon = normalizeWeaponSpec(raw)
  return weapon ? { weapon } : {}
}

/** `"0.85 0.84"`（空白かスラッシュ区切り）を 0〜1 の点にする。外れ・不正は undefined */
export function parseAnchor(s: string | undefined): Point | undefined {
  if (!s) return undefined
  const m = s
    .trim()
    .split(/[\s/]+/)
    .map(Number)
  if (m.length !== 2 || m.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return undefined
  return { x: m[0], y: m[1] }
}

// ---------------------------------------------------------------------------
// JSON の読み取り

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 構造キーを持つ値ならその構造の分、持たなければそのまま */
function pick(v: unknown, s: WeaponStructure): unknown {
  return isObj(v) && ('standing' in v || 'wheelchair' in v) ? v[s] : v
}

function isPoint(v: unknown): v is Point {
  return isObj(v) && isNum(v.x) && isNum(v.y)
}

/** 変換の部分（足りない項目は未定義）。`none` は刀なし */
type PartialTransform = Partial<WeaponTransform> & { none?: true }

/** 1 つのポーズの項目を構造 s で読む。構造別のサブオブジェクト（step の `standing: {...}`）にも対応 */
function readTransformEntry(entry: unknown, s: WeaponStructure): PartialTransform | undefined {
  if (!isObj(entry)) return undefined
  const sub = isObj(entry[s]) ? (entry[s] as Obj) : entry
  if (typeof sub.weapon === 'string' && /^none\b/i.test(sub.weapon)) return { none: true }
  const out: PartialTransform = {}
  const h = pick(sub.weapon_height_ratio, s)
  if (isNum(h) && h > 0) out.heightRatio = h
  const r = pick(sub.rotation_deg, s)
  if (isNum(r)) out.rotationDeg = r
  const t = pick(sub.handle_target, s)
  if (isPoint(t)) out.handleTarget = { x: t.x, y: t.y }
  if (typeof sub.flip_x === 'boolean') out.flipX = sub.flip_x
  return out
}

/** 重ね順（`["trail","character","weapon"]` や `{ layers: [...] }`、構造別）から character / weapon だけを抜く */
function readLayers(entry: unknown, s: WeaponStructure): WeaponLayerName[] | undefined {
  let arr: unknown = entry
  if (isObj(entry)) arr = isObj(entry[s]) ? (entry[s] as Obj).layers : entry.layers
  if (!Array.isArray(arr)) return undefined
  return arr.filter((x): x is WeaponLayerName => x === 'character' || x === 'weapon')
}

function mergeTransform(
  a: PartialTransform | undefined,
  b: PartialTransform | undefined
): PartialTransform | undefined {
  if (!a) return b
  if (!b) return a
  if (b.none) return b
  return { ...(a.none ? {} : a), ...b }
}

function baseName(path: string): string {
  const clean = path.split(/[?#]/)[0]
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/** カタログの先頭の刀の絵のパス（catalog の置き場所からの相対を、catalog のパスの dir に付けて返す）。無ければ undefined */
export function firstCatalogImage(catalog: unknown, catalogPath: string): string | undefined {
  if (!isObj(catalog) || !Array.isArray(catalog.weapons)) return undefined
  const w = catalog.weapons.find((x) => isObj(x) && typeof x.file === 'string')
  if (!isObj(w) || typeof w.file !== 'string') return undefined
  const i = catalogPath.search(/[^/]*$/)
  return `${catalogPath.slice(0, i)}${w.file}`
}

/** カタログから、刀の絵のファイル名に当たる柄アンカーを探す */
export function findCatalogAnchor(catalog: unknown, image: string): Point | undefined {
  if (!isObj(catalog) || !Array.isArray(catalog.weapons)) return undefined
  const name = baseName(image)
  for (const w of catalog.weapons) {
    if (isObj(w) && typeof w.file === 'string' && baseName(w.file) === name) {
      return isPoint(w.handle_center_normalized)
        ? { x: w.handle_center_normalized.x, y: w.handle_center_normalized.y }
        : undefined
    }
  }
  return undefined
}

/** ポーズ名の一覧は battleMotion の BATTLE_POSES と同じ綴り（循環 import を避けて、ここは JSON のキーをそのまま引く） */
const POSE_KEYS: readonly BattlePose[] = [
  'idle',
  'ready',
  'step',
  'swing-windup',
  'slash',
  'swing-followthrough',
  'cast',
  'special',
  'hurt',
  'down',
  'victory',
]

/**
 * 装備（rig）を組み立てる。変換は layers JSON だけから読む（catalog は柄アンカーと既定の刀だけ。変換は持たない）。
 * 刀ごとの差は任意の `overridesJson`（`BattleWeaponSpec.overrides`）で項目単位に上書きできる。
 * `ready_weapon_transform` は ready の変換として、`pose_layers.ready` の項目に項目単位で重なる。
 * 柄アンカーが決まらない（spec にも catalog にも無い）ときは null（刀を出さない）。
 */
export function buildWeaponRig(
  spec: BattleWeaponSpec,
  layersJson: unknown,
  catalogJson: unknown,
  overridesJson?: unknown
): WeaponRig | null {
  const s = spec.structure
  const anchor = spec.anchor ?? findCatalogAnchor(catalogJson, spec.image ?? '')
  if (!anchor) return null
  const layers: WeaponRig['layers'] = {}
  const partial: Partial<Record<BattlePose, PartialTransform>> = {}

  if (isObj(layersJson)) {
    const pl = isObj(layersJson.pose_layers) ? layersJson.pose_layers : {}
    for (const p of POSE_KEYS) {
      const l = readLayers(pl[p], s)
      if (l) layers[p] = l
      const t = readTransformEntry(pl[p], s)
      if (t) partial[p] = t
    }
    const rt = readTransformEntry(layersJson.ready_weapon_transform, s)
    if (rt) partial.ready = mergeTransform(partial.ready, rt)
  }
  if (overridesJson !== undefined && isObj(overridesJson)) {
    const name = baseName(spec.image ?? '')
    const pl = isObj(overridesJson.pose_layers) ? overridesJson.pose_layers : {}
    const sp =
      isObj(overridesJson.shared_pose_transforms) &&
      isObj(overridesJson.shared_pose_transforms.poses)
        ? overridesJson.shared_pose_transforms.poses
        : {}
    const rt = readTransformEntry(overridesJson.ready_weapon_transform, s)
    if (rt) partial.ready = mergeTransform(partial.ready, rt)
    for (const p of POSE_KEYS) {
      for (const entry of [pl[p], sp[p]]) {
        let t = readTransformEntry(entry, s)
        if (isObj(entry) && isObj(entry.candidate_overrides)) {
          t = mergeTransform(t, readTransformEntry(entry.candidate_overrides[name], s))
        }
        if (t) partial[p] = mergeTransform(partial[p], t)
      }
    }
  }

  const transforms: WeaponRig['transforms'] = {}
  for (const p of POSE_KEYS) {
    const t = partial[p]
    if (!t) continue
    if (t.none) transforms[p] = null
    else if (t.heightRatio !== undefined && t.handleTarget) {
      transforms[p] = {
        heightRatio: t.heightRatio,
        rotationDeg: t.rotationDeg ?? 0,
        handleTarget: t.handleTarget,
        flipX: t.flipX ?? false,
      }
    }
  }
  return { anchor, structure: s, layers, transforms }
}

// ---------------------------------------------------------------------------
// ポーズごとの解決

/** ready の変換に倒してよい（武器を構えるポーズ）。idle / hurt / down / victory / cast は刀なしが既定 */
const WEAPON_POSES: readonly BattlePose[] = [
  'ready',
  'step',
  'swing-windup',
  'slash',
  'swing-followthrough',
  'special',
]

export interface WeaponForPose {
  transform: WeaponTransform
  /** true = 人物の前（描画順で人物より後）。false = 人物の後ろ */
  front: boolean
}

/**
 * 表示中のポーズに刀を出すか、出すならどの変換でどの順か。
 * 1. layers に character/weapon の順が書いてあり weapon を含まない → 刀なし。
 * 2. 変換が `none` と明記 → 刀なし。変換があればそれ。
 * 3. 変換が無い: layers が weapon を含む、または構えるポーズ → ready の変換に倒す（ready も無ければ刀なし）。それ以外は刀なし。
 * 重ね順は layers の並び（weapon が character より後 = 前面）。layers が無ければ前面。
 */
export function resolveWeaponForPose(rig: WeaponRig, pose: BattlePose): WeaponForPose | null {
  const l = rig.layers[pose]
  if (l && !l.includes('weapon')) return null
  const front = !l || !l.includes('character') || l.indexOf('weapon') > l.indexOf('character')
  const t = rig.transforms[pose]
  if (t === null) return null
  if (t) return { transform: t, front }
  if (!(l || WEAPON_POSES.includes(pose))) return null
  const ready = rig.transforms.ready
  return ready ? { transform: ready, front } : null
}

export interface WeaponPlacement {
  /** 刀の絵の柄アンカーを置く点（container 座標） */
  x: number
  y: number
  /** 刀の絵の拡大率。左右反転は scaleX が負 */
  scaleX: number
  scaleY: number
  /** PixiJS の rotation（ラジアン・時計回りが正）。変換の度は反時計回りが正なので符号が逆 */
  rotation: number
}

/**
 * 刀の置き場所。`rect` は人物の絵（透過を切り詰めた範囲）の container 座標での矩形、`tex` は刀の絵の画素サイズ。
 * スプライトの anchor は rig.anchor に置く（拡大・反転・回転はこの点が中心なので、柄の位置は変換で動かない）
 */
export function computeWeaponPlacement(
  tr: WeaponTransform,
  tex: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number }
): WeaponPlacement {
  const s = tex.height > 0 ? (tr.heightRatio * rect.height) / tex.height : 0
  return {
    x: rect.x + tr.handleTarget.x * rect.width,
    y: rect.y + tr.handleTarget.y * rect.height,
    scaleX: tr.flipX ? -s : s,
    scaleY: s,
    rotation: (-tr.rotationDeg * Math.PI) / 180,
  }
}

/**
 * 画像の不透明部分の範囲（比）。透過を切り詰めていない絵（swing 系の大きな一枚絵など）でも、
 * 変換の座標（切り詰め後の人物の絵が基準）に合わせるために使う。画素が取れなければ全体
 */
export function alphaBoundsFraction(
  data: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 8
): { x: number; y: number; w: number; h: number } {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0 || width <= 0 || height <= 0) return { x: 0, y: 0, w: 1, h: 1 }
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX + 1 - minX) / width,
    h: (maxY + 1 - minY) / height,
  }
}
