/**
 * 一枚絵フィールドサンプルページ (#807) のブラウザ側エントリ。本編からはリンクしない開発用ページ。
 * 計算は game/fieldWalk.ts と ./config.ts の純粋関数に任せ、ここは DOM と PixiJS の配線だけを持つ。
 */
import { Application, Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js'
import { createFieldStands } from './acrylicFigure'
import { createFlagStore } from './flagStore'
import {
  WORLD_Z,
  companionZ,
  emotionHostOf,
  npcZ,
  orderedLayers,
  syncEmotionLayerHost,
} from './layers'
import { BattleEngine } from '../game/battleEngine'
import { BattleScreen } from '../game/BattleScreen'
import {
  advanceEncounter,
  afterBattleState,
  initialEncounterState,
  type EncounterWalkState,
} from '../game/fieldEncounter'
import type { BattleEntity } from '../game/spellDsl'
import {
  detectEdgeLink,
  foregroundCoverage,
  foregroundFromRgba,
  facingFromVector,
  isOutward,
  keysToVector,
  maskFromRgba,
  isAssistCell,
  maskWithAssist,
  playerScale,
  pointerToVector,
  resolvePlayerHeight,
  snapToWalkable,
  fieldFrames,
  type DirectionKeys,
  type Facing,
  type Facing8,
  type FieldLink,
  type ForegroundMask,
  type Vec,
  type WalkMask,
} from '../game/fieldWalk'
import {
  INITIAL_ASSIST_RUNTIME,
  INITIAL_BLOCKED_GATE,
  arrivalMask,
  edgeArrivalPassable,
  resolveEdgeArrival,
  refuseEdgeLink,
  assistSpeed,
  companionDisplayAlpha,
  companionPosition,
  evalAssist,
  findLatchHoldWhite,
  facing4,
  stepAssistFrame,
  stepBlockedEvent,
  stepCompanionAlpha,
  type AssistRuntime,
  type BlockedGate,
} from '../game/fieldAssist'
import { scrollOffset, shakeOffset } from '../game/fieldMotion'
import { FieldEmotionLayer, type EmotionHeads } from '../game/FieldEmotionLayer'
import {
  EMOTION_NPC_PREFIX,
  EMOTION_TARGETS,
  isCompanionShown,
  isEmotionTarget,
  npcEmotionTarget,
} from '../game/fieldEmotion'
import { loadEmotionSheets } from '../game/fieldEmotionScript'
import {
  WARP_COLOR,
  WARP_LOAD_TIMEOUT_MS,
  canStartBattleNow,
  sampleWarp,
  withTimeout,
} from '../game/fieldWarp'
import {
  NPC_BLOCK_RADIUS,
  acceptsWalkInput,
  approachAfterMove,
  approachArrived,
  approachBeforeMove,
  canStartTalk,
  canStartWarp,
  decideTalkKey,
  dialogMetricsFor,
  facingToward,
  npcAtPoint,
  npcPlacementWarnings,
  stepMoveAroundNpcs,
  type NpcRect,
} from '../game/fieldNpc'
import { DialogBox } from '../game/DialogBox'
import { fieldDialogOptions } from '../game/ffDialog'
import { EventRunner } from '../game/eventRunner'
import {
  FieldConversation,
  createFieldBattleHost,
  createFieldEmotionHost,
  createFieldNpcMover,
  checkNpcScripts,
  loadFieldScript,
  resolveNpcCommands,
  type FieldScriptEvents,
} from '../game/fieldScript'
import { hasOwn } from '../game/ownProperty'
import { resolveUrl } from '../battleSample/config'
import {
  DIAGONAL_FACINGS,
  FACINGS,
  configNotice,
  findReturnLink,
  forceBattleCandidates,
  pickConfigSource,
  parseConfigText,
  type FieldNpc,
  type FieldSampleConfig,
  type FieldWarp,
} from './config'
import defaultConfigText from './teramachi.sample.json?raw'
import { buildBattleMenu } from './battleMenu'
import { fieldRenderResolution } from './renderResolution'
import { buildBattleEngineOptions, buildBattleScreenOptions } from './battleOptions'
import { buildDummyFixture } from './dummyFixture'
import { FieldBattleTransition } from '../game/fieldBattleTransition'
import {
  beginBattleWithTransition,
  buildTalkState,
  endBattleWithTransition,
} from './encounterTransition'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const FADE_MS = 180
const POINTER_DEADZONE = 10
const ARRIVAL_INSET_FACTOR = 3

function showError(msg: string | null): void {
  const el = $('error')
  el.textContent = msg ?? ''
  el.hidden = !msg
}

/**
 * CORS 付きで配信された画像を取得し、テクスチャと（必要なら）ピクセルの両方に使える ImageBitmap にする。
 * fetch にタイムアウトは付けない（開発用サンプルなので許容）。ImageBitmap を close() しないのは、
 * シーンの cache に永久保持する設計のため。
 */
async function loadBitmap(url: string): Promise<ImageBitmap> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new Error(
      `画像を取得できません: ${url}\nネットワーク失敗、または CORS（Access-Control-Allow-Origin）が無い可能性があります（${e instanceof Error ? e.message : String(e)}）`
    )
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return createImageBitmap(await res.blob())
}

/** 実行時の NPC (#841)。x / y は足元（背景ピクセル）。見た目は読み込めたものだけ（読めない NPC は警告して出さない） */
interface NpcRuntime {
  id: string
  x: number
  y: number
  def: FieldNpc
  sprite: Sprite
  /** 向きごとの立ち絵。`sprite` 単一画像のときは全向き同じ 1 枚 */
  textures: Record<Facing, Texture>
  facing: Facing
}

interface LoadedScene {
  id: string
  background: Texture
  mask: WalkMask
  /** 条件付き（橙）のセルも歩ける扱いにしたマスク (#862)。橙が無ければ mask と同じ */
  maskAssist: WalkMask
  /** 橙からしか入れない白（踊り場・橙に囲まれた島）のセル。ラッチ中はその上でラッチを保つ。無ければ undefined */
  hold: Uint8Array | undefined
  overlay: Texture
  /** 前面レイヤー (#866)。シーンに foreground が無ければ null */
  foreground: { texture: Texture; mask: ForegroundMask } | null
  /** 窓の外の流れる景色 (#864)。シーンに scroll が無ければ null */
  scroll: Texture | null
}

async function loadScene(config: FieldSampleConfig, id: string): Promise<LoadedScene> {
  const sc = config.scenes[id]
  const [bg, maskBmp, fgBmp, scrollBmp] = await Promise.all([
    loadBitmap(sc.background),
    loadBitmap(sc.mask),
    sc.foreground ? loadBitmap(sc.foreground) : Promise.resolve(null),
    sc.scroll ? loadBitmap(sc.scroll.image) : Promise.resolve(null),
  ])
  const canvas = document.createElement('canvas')
  canvas.width = maskBmp.width
  canvas.height = maskBmp.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas を作れません')
  ctx.drawImage(maskBmp, 0, 0)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const mask = maskFromRgba(canvas.width, canvas.height, img.data)
  if (bg.width !== mask.width || bg.height !== mask.height)
    throw new Error(
      `シーン ${id}: 背景（${bg.width}x${bg.height}）とマスク（${mask.width}x${mask.height}）の大きさが違います`
    )
  // 前面レイヤー (#866): 背景と同じ大きさの透明 PNG。不透明領域は隠れ率の測定用に別途読む
  let foreground: LoadedScene['foreground'] = null
  if (fgBmp) {
    if (fgBmp.width !== mask.width || fgBmp.height !== mask.height)
      throw new Error(
        `シーン ${id}: 前面（${fgBmp.width}x${fgBmp.height}）と背景（${mask.width}x${mask.height}）の大きさが違います`
      )
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(fgBmp, 0, 0)
    const fgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    foreground = {
      texture: Texture.from(fgBmp),
      mask: foregroundFromRgba(canvas.width, canvas.height, fgData.data),
    }
  }
  // デバッグ用オーバーレイ: 歩ける所を半透明の緑に、条件付き（橙）の所を半透明の橙に
  const ov = ctx.createImageData(mask.width, mask.height)
  for (let i = 0; i < mask.walkable.length; i++) {
    if (mask.walkable[i]) {
      ov.data[i * 4 + 1] = 255
      ov.data[i * 4 + 3] = 90
    } else if (mask.assist?.[i]) {
      ov.data[i * 4] = 255
      ov.data[i * 4 + 1] = 157
      ov.data[i * 4 + 3] = 120
    }
  }
  ctx.putImageData(ov, 0, 0)
  return {
    id,
    background: Texture.from(bg),
    mask,
    maskAssist: maskWithAssist(mask),
    hold: holdFor(config, id, mask),
    overlay: Texture.from(canvas),
    foreground,
    scroll: scrollBmp ? Texture.from(scrollBmp) : null,
  }
}

async function loadConfig(): Promise<FieldSampleConfig> {
  const base = location.href
  const { configParam: raw, dummy } = pickConfigSource(location.search)
  const url = raw ? resolveUrl(raw, base) : null
  let text = defaultConfigText
  let textBase = base
  // 素材なしフィクスチャ (#890)。`?fixture=dummy`。?config= が同時にあれば config が優先
  if (dummy) {
    const acrylic = new URLSearchParams(location.search).get('spriteStyle') === 'acrylic'
    text = JSON.stringify(buildDummyFixture(acrylic ? { spriteStyle: 'acrylic' } : {}))
  }
  if (url) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
      textBase = url
    } catch (e) {
      showError(
        `設定 JSON を読み込めません（内蔵既定で表示します）\n${url}\n${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  const parsed = parseConfigText(text, textBase)
  if (parsed.ok) {
    // 群エラー (#839 段5。console.error は parseConfig が出している) と警告 (#883) は 1 回でまとめて出す
    // （showError は置換なので別々に呼ぶと後が前を消す）
    for (const w of parsed.value.warnings ?? []) console.warn(w)
    const notice = configNotice(parsed.value)
    if (notice) showError(notice)
    return parsed.value
  }
  showError(`設定 JSON が不正です\n${parsed.error}`)
  const fallback = parseConfigText(defaultConfigText, base)
  if (!fallback.ok) throw new Error(fallback.error)
  return fallback.value
}

/**
 * 橙からしか入れない白（start・リンクの帯・ワープの at のどれにも通じない白）を求める (#862, #928)。
 * 橙を通って入るしかないので、ラッチ中はその上でラッチを保つ（橙の途中で通れない状態になっても出られる）
 */
function holdFor(config: FieldSampleConfig, id: string, mask: WalkMask): Uint8Array | undefined {
  if (!mask.assist) return undefined
  const sc = config.scenes[id]
  const safe: Vec[] = []
  if (config.startScene === id) safe.push(config.start)
  for (const w of Object.values(config.warps)) if (w.to === id) safe.push(w.at)
  // 戻りリンクの無い（片道の）リンクの到着点は画面中心の近くの白
  for (const [srcId, src] of Object.entries(config.scenes))
    for (const l of src.links)
      if (l.to === id && findReturnLink(config, srcId, l) === null)
        safe.push({ x: mask.width / 2, y: mask.height / 2 })
  const edges = sc.links.map((l) => ({ edge: l.edge, band: config.edgeThreshold }))
  return findLatchHoldWhite(mask, safe, edges)
}

/**
 * NPC の脚本 `.md` (`scriptUrl`、#841 段階2)。取得・パースの失敗は警告して無視（NPC は固定の `line` で話す）。
 * wasm パーサは scriptUrl があるときだけ遅延 import する（無い設定では wasm を読まない）
 */
async function loadNpcScript(config: FieldSampleConfig): Promise<FieldScriptEvents | undefined> {
  const url = config.scriptUrl
  if (!url) return undefined
  return loadFieldScript(
    url,
    async (u) => {
      const res = await fetch(u)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    },
    async (md) => (await import('../wasm/parser')).parseMarkdown(md)
  )
}

async function main(): Promise<void> {
  const config = await loadConfig()
  const cache = new Map<string, Promise<LoadedScene>>()
  const ensureScene = (id: string): Promise<LoadedScene> => {
    let p = cache.get(id)
    if (!p) {
      p = loadScene(config, id)
      // 失敗は次回やり直せるようキャッシュから外す
      p.catch(() => cache.delete(id))
      cache.set(id, p)
    }
    return p
  }

  // 歩行スプライト（向き×3コマ）。斜め 4 方向 (#811) は、自前の画像か mirrorOf で 4 つ揃ったときだけ使う
  const loadFrames = async (urls: readonly string[]) =>
    Promise.all(urls.map(async (u) => Texture.from(await loadBitmap(u))))
  const walkTex = {} as Partial<Record<Facing8, Texture[]>>
  for (const f of FACINGS) walkTex[f] = await loadFrames(config.player.sprites[f])
  for (const f of DIAGONAL_FACINGS) {
    const own = config.player.sprites[f]
    if (own) walkTex[f] = await loadFrames(own)
  }
  /** 左右反転して描く向き (#811)。反転元の画像を共有する */
  const flipped = new Set<Facing8>()
  for (const f of DIAGONAL_FACINGS) {
    const src = config.player.mirrorOf[f]
    if (src) {
      walkTex[f] = walkTex[src]
      flipped.add(f)
    }
  }
  const diagonalWalk = DIAGONAL_FACINGS.every((f) => walkTex[f])
  // 条件付き通行の同行者 (#862)。歩行絵のスプライトで出す（`spriteStyle: "acrylic"` のときは足元にアクスタの部品を付ける）
  const companionTex = {} as Partial<Record<Facing, Texture[]>>
  if (config.companion)
    for (const f of FACINGS) companionTex[f] = await loadFrames(config.companion.sprites[f])

  // NPC (#841)。シーンごとに立ち絵を先に読む。読めない NPC は警告して省く（フィールドは止めない）
  const sceneNpcs = new Map<string, NpcRuntime[]>()
  await Promise.all(
    Object.entries(config.scenes).map(async ([sid, sc]) => {
      const list: NpcRuntime[] = []
      for (const def of sc.npcs ?? []) {
        try {
          const textures = {} as Record<Facing, Texture>
          if (def.sprites) {
            for (const f of FACINGS) textures[f] = Texture.from(await loadBitmap(def.sprites[f][0]))
          } else if (def.sprite) {
            const t = Texture.from(await loadBitmap(def.sprite))
            for (const f of FACINGS) textures[f] = t
          } else continue
          const sprite = new Sprite(textures[def.facing])
          sprite.anchor.set(0.5, 1)
          sprite.visible = false
          list.push({ id: def.id, x: def.x, y: def.y, def, sprite, textures, facing: def.facing })
        } catch (e) {
          console.warn(
            `[field-sample] NPC ${sid}/${def.id} の画像を読めません（この NPC は出しません）: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
      sceneNpcs.set(sid, list)
    })
  )
  const currentNpcs = (): NpcRuntime[] => sceneNpcs.get(sceneId) ?? []

  // 感情吹き出し (#937)。宣言した絵を先に読む。読めない種類は警告して省く（フィールドは止めない）
  const emotionSheets = await loadEmotionSheets(config, (url) => fetch(url))
  const scriptEvents = await loadNpcScript(config)
  // scene と脚本の照合は起動時に 1 回だけ（話しかけるたびに同じ警告を出さない）
  {
    const scriptWarnings = checkNpcScripts(
      Object.entries(config.scenes).flatMap(([sid, sc]) =>
        (sc.npcs ?? []).map((n) => ({ where: `NPC ${sid}/${n.id}`, scene: n.scene }))
      ),
      scriptEvents
    ).filter(() => !!config.scriptUrl) // scriptUrl 無しは config 段階で警告済み
    for (const w of scriptWarnings) console.warn(w)
    if (scriptWarnings.length > 0)
      showError([configNotice(config), ...scriptWarnings].filter(Boolean).join('\n'))
  }
  const emotionTextures = new Map<string, Texture | null>()
  await Promise.all(
    [...new Set(Object.values(emotionSheets ?? {}).map((sheet) => sheet.image))].map(
      async (image) => {
        try {
          emotionTextures.set(image, Texture.from(await loadBitmap(image)))
        } catch (e) {
          console.warn(
            `[field-sample] 感情吹き出しの画像を読めません（その種類は出しません）: ${e instanceof Error ? e.message : String(e)}`
          )
          emotionTextures.set(image, null)
        }
      }
    )
  )
  const emotionLayer = emotionSheets ? new FieldEmotionLayer(emotionSheets, emotionTextures) : null

  let scene = await ensureScene(config.startScene)
  let sceneId = config.startScene

  const app = new Application()
  await app.init({
    width: scene.mask.width,
    height: scene.mask.height,
    background: 0x000000,
    antialias: false,
    // #53: 高 DPR で canvas が CSS 拡大されてぼやけないよう、描画解像度を表示密度に合わせる（上限あり。起動時の DPR・起動シーンの大きさで固定）
    resolution: fieldRenderResolution(window.devicePixelRatio, scene.mask.width, scene.mask.height),
    autoDensity: true,
  })
  $('stage').appendChild(app.canvas as HTMLCanvasElement)

  // 窓の外の流れる景色 (#864): 背景より奥。背景の透明な部分から見える
  const scrollSprite = new TilingSprite({
    texture: Texture.EMPTY,
    width: scene.mask.width,
    height: scene.mask.height,
  })
  scrollSprite.visible = false
  const bgSprite = new Sprite(scene.background)
  const overlaySprite = new Sprite(scene.overlay)
  // 前面レイヤー (#866): 主人公より手前。シーンに前面が無ければ非表示
  const foregroundSprite = new Sprite(Texture.EMPTY)
  const player = new Sprite(walkTex.down![0])
  const companionSprite = new Sprite(Texture.EMPTY)
  companionSprite.anchor.set(0.5, 1)
  companionSprite.visible = false
  player.anchor.set(0.5, 1) // 足元 = スプライト下端中心
  const marker = new Graphics()
  const fade = new Graphics()
  const world = new Container()
  // 感情吹き出し (#937) の層。宣言が無いときは空の箱（zIndex は層の順序どおり常に付ける）
  const emotionLayerBox: Container = emotionLayer ?? new Container()
  // 描画順は layers.ts (テストで固定)
  world.addChild(
    ...orderedLayers<Container>({
      scroll: scrollSprite,
      background: bgSprite,
      overlay: overlaySprite,
      companion: companionSprite,
      player,
      foreground: foregroundSprite,
      emotion: emotionLayerBox,
      marker,
    })
  )
  // 同行者は主人公の後ろ（y が大きければ手前）に並べ替える。前面・マーカーは常に上
  world.sortableChildren = true
  // アクスタ (sit-by-me#58): `spriteStyle: "acrylic"` のときだけ、絵の直前（同じ zIndex なら奥）に板・台座・影の層を挿す。未指定は何も足さない（従来の描画）
  const stands = createFieldStands(config.spriteStyle, !!config.companion)
  const playerStand = stands.player
  const companionStand = stands.companion
  if (playerStand) world.addChildAt(playerStand.display, world.getChildIndex(player))
  if (companionStand) world.addChildAt(companionStand.display, world.getChildIndex(companionSprite))
  scrollSprite.zIndex = WORLD_Z.scroll
  bgSprite.zIndex = WORLD_Z.background
  overlaySprite.zIndex = WORLD_Z.overlay
  player.zIndex = WORLD_Z.player
  foregroundSprite.zIndex = WORLD_Z.foreground
  emotionLayerBox.zIndex = WORLD_Z.emotion
  marker.zIndex = WORLD_Z.marker
  for (const list of sceneNpcs.values()) for (const n of list) world.addChild(n.sprite)
  // 会話窓 (#841)。TopDown と同じ DialogBox。画面の大きさに合わせた箱と文字（シーンの大きさが変わると redraw で追従）
  const dialogBox = new DialogBox({
    screenWidth: scene.mask.width,
    screenHeight: scene.mask.height,
    ...dialogMetricsFor(scene.mask.height),
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
    // FF 風の窓 (#840)。未指定は従来の下部の窓（msPerChar も DialogBox の既定のまま）
    ...fieldDialogOptions(config),
  })
  // コンストラクタ直後は背景が可視なので、会話外では隠しておく（show() で出る・hide() で戻る）
  dialogBox.hide()
  // ff の窓を出している会話中だけ、感情吹き出しを窓より前へ出す（stage 最前面。揺れは world.y と同期） (#840)
  const emotionTop = new Container()
  app.stage.addChild(world, fade, dialogBox, emotionTop)
  const syncEmotionHost = (): void => {
    syncEmotionLayerHost({
      ffWindow: config.dialogStyle === 'ff',
      talking: !!talking,
      layer: emotionLayerBox,
      world,
      top: emotionTop,
    })
  }
  /** シーン（画面）の大きさが変わったら、会話窓の箱の高さ・文字サイズも合わせる */
  const applyDialogMetrics = (width: number, height: number): void => {
    const m = dialogMetricsFor(height)
    dialogBox.setBoxHeight(m.boxHeight)
    dialogBox.setFontSize(m.fontSize)
    dialogBox.redraw(width, height)
  }

  // 到着位置の計算は、通れる状態なら橙も歩ける扱いのマスクで行う（橙の階段が端に接していても近くの白へずらされない）
  const landingMask = (s: LoadedScene, flagValues: Readonly<Record<string, boolean>>): WalkMask =>
    arrivalMask(
      s.mask,
      s.maskAssist,
      config.assist ? evalAssist(config.assist, flagValues).passable : false
    )
  // ワープの at・開始位置が橙の上なのに通れない状態だと、近い白へずらされる（向こう側の白になりうる）。
  // 端リンクと違い「来た端」が無く橙の上に置けないので、設定の見直しを促す
  const warnOrangeShifted = (what: string, s: LoadedScene, p: Vec, passable: boolean): void => {
    if (!passable && isAssistCell(s.mask, p.x, p.y))
      console.warn(
        `[field-sample] ${what} (${p.x}, ${p.y}) は橙の上ですが、いまは通れない状態なので近い白へずらします。橙を避けた位置にしてください`
      )
  }
  warnOrangeShifted(
    'start',
    scene,
    config.start,
    config.assist ? evalAssist(config.assist, config.flags).passable : false
  )
  const startSnap = snapToWalkable(landingMask(scene, config.flags), config.start, 80)
  if (!startSnap)
    showError(
      `start (${config.start.x}, ${config.start.y}) の近くに歩ける点がありません。マスクか start を確認してください`
    )
  let pos: Vec = startSnap ?? config.start
  let facing: Facing8 = 'down'
  let movingMs = 0
  let disarmed: FieldLink | null = null
  let debug = false
  // ---- フラグ・条件付き通行 (#862) ----
  const flagStore = createFlagStore(config.flags)
  const flags = flagStore.flags
  const setFlag = (name: string, value: boolean): boolean => {
    const ok = flagStore.set(name, value)
    if (!ok) console.warn(`[field-sample] 未宣言のフラグ: ${name}`)
    return ok
  }
  let companionAlpha = 0
  let assistGate: BlockedGate = INITIAL_BLOCKED_GATE
  let assistRt: AssistRuntime = INITIAL_ASSIST_RUNTIME
  // ---- ランダムエンカウント・戦闘 (#809) ----
  let encState: EncounterWalkState = initialEncounterState(config.encounter)
  let battle: BattleScreen | null = null
  /** 戦闘の開始・終了の画面遷移 (sit-by-me#55)。`battle.transition` が none なら使われない。演出中は入力・移動・エンカウントを止める */
  const battleTransition = new FieldBattleTransition(() => app.stage)
  let lastOutcome = '-'
  // ---- NPC・会話 (#841) ----
  /** 会話中の NPC。会話中は歩行入力・ポインタ移動・エンカウント・ワープ・端リンクを止める */
  let talking: NpcRuntime | null = null
  /** クリックした NPC へ近づいている最中（着いたら話しかける。キー入力・別の場所のクリックで取り消す） */
  let approach: { id: string; stuckMs: number } | null = null
  const talkState = () =>
    buildTalkState({
      battle: !!battle,
      battleTransitionActive: battleTransition.active,
      talking: !!talking,
      transition: !!transition,
      warping: !!warpRun,
    })
  /** 歩きの入力を全部捨てる。押しっぱなしの pointer capture も解放する（戦闘・ワープの開始時） */
  const releaseWalkInput = (): void => {
    keys.up = keys.down = keys.left = keys.right = false
    if (activePointerId !== null && canvas.hasPointerCapture(activePointerId))
      canvas.releasePointerCapture(activePointerId)
    activePointerId = null
    pointer = null
    approach = null
    movingMs = 0
  }
  /** 感情吹き出しを出す (#937/#946)。`api.showEmotion` と脚本の `[感情:]`（emotionHost）の共通の入口 */
  const showEmotion = (target: string, kind: string, durationMs?: number): boolean => {
    if (!emotionLayer || battle || battleTransition.active) return false
    if (!isEmotionTarget(target)) return false
    // 同行者が出ていないときは出せない（見えないまま時間だけ進むのを防ぐ）
    if (
      target === 'companion' &&
      !isCompanionShown(!!config.assist, !!config.companion, companionAlpha)
    )
      return false
    // NPC はいまのシーンにいるものだけ（別シーンの NPC は頭上の位置が無い）
    if (target.startsWith(EMOTION_NPC_PREFIX)) {
      const id = target.slice(EMOTION_NPC_PREFIX.length)
      if (!currentNpcs().some((n) => n.id === id)) return false
    }
    return emotionLayer.show(target, kind, durationMs)
  }
  // 会話の実行器 (#841 段階2)。NpcMove / Battle は fieldSample では未対応（警告して読み飛ばす）
  const conversation = new FieldConversation(
    dialogBox,
    new EventRunner(
      dialogBox,
      createFieldNpcMover(),
      createFieldBattleHost(),
      createFieldEmotionHost(
        () => ({
          emotions: emotionSheets ?? {},
          companionName: config.companion?.name ?? null,
          npcs: currentNpcs().map((n) => ({ id: n.id, name: n.def.name })),
        }),
        showEmotion
      )
    )
  )
  const startTalk = (npc: NpcRuntime): void => {
    if (!canStartTalk(talkState())) return
    releaseWalkInput()
    // お互いに向き合う（主人公の向きは 8 方向なら斜めのまま近い向きへ）
    facing = facingFromVector({ x: npc.x - pos.x, y: npc.y - pos.y }, facing, diagonalWalk)
    npc.facing = facingToward(npc, pos)
    talking = npc
    conversation.start(
      npc.def.name,
      npc.def.line,
      resolveNpcCommands(npc.def.scene, scriptEvents, () => {}),
      () => {
        talking = null
      }
    )
  }
  /** 会話の送り: 表示中なら全文表示、済んでいれば閉じて歩行へ戻る */
  const advanceTalk = (): void => {
    if (!talking) return
    conversation.advance()
  }
  const startBattle = (enemies: BattleEntity[]): void => {
    // 演出中（開始・終了とも）の二重エンカウントは無視する
    if (battleTransition.active) return
    // 歩きの入力を捨てる（戦闘側は戦闘画面が自前で入力を受ける）
    releaseWalkInput()
    emotionLayer?.clear()
    const b = config.battle
    const menu = buildBattleMenu(config)
    const bg = config.scenes[sceneId].encounter?.background ?? b.background
    const open = (): void => {
      const engine = new BattleEngine(
        config.party.map((p) => ({ ...p })),
        enemies.map((e) => ({ ...e })),
        buildBattleEngineOptions(b)
      )
      world.visible = false
      fade.visible = false
      app.renderer.resize(b.width, b.height)
      battle = new BattleScreen(engine, b.width, b.height, {
        // 候補窓 (#890) は戦闘ごとに複製して渡す（BattleScreen がアイテムの count を書き換えるため）
        ...buildBattleScreenOptions(b, { background: bg, menu }),
        onClose: (outcome) => {
          lastOutcome = outcome
          // 終了も黒を経由して戻る（none なら即 endBattle）。演出中は battle を tick しない
          endBattleWithTransition({
            mode: b.transition,
            player: battleTransition,
            width: b.width,
            height: b.height,
            outcome,
            close: endBattle,
          })
        },
      })
      app.stage.addChild(battle)
    }
    // 開始の演出: 操作キャラ付近へ 2 段ズームして暗転 → 戦闘画面
    beginBattleWithTransition({
      mode: b.transition,
      player: battleTransition,
      width: scene.mask.width,
      height: scene.mask.height,
      focus: () => ({ x: world.x + pos.x, y: world.y + pos.y - player.height / 2 }),
      open,
    })
  }
  const endBattle = (): void => {
    if (!battle) return
    app.stage.removeChild(battle)
    battle.destroy({ children: true })
    battle = null
    // 同じシーン・同じ位置に戻る（pos / facing / sceneId は戦闘中ずっと保持している）
    app.renderer.resize(scene.mask.width, scene.mask.height)
    battleTransition.resize(scene.mask.width, scene.mask.height)
    applyDialogMetrics(scene.mask.width, scene.mask.height)
    world.visible = true
    fade.visible = true
    encState = afterBattleState()
  }
  /** 揺れ・景色の流れの時計（戦闘中は進まない） */
  let clockMs = 0
  let transition: {
    phase: 'out' | 'in'
    t: number
    link?: FieldLink
    next?: Promise<LoadedScene>
  } | null = null

  // ---- ワープ (#864) ----
  interface WarpRun {
    warp: FieldWarp
    t: number
    next: Promise<LoadedScene>
    /** 読み込めたシーン（out が終わるまでに届いていなければ、届くまで out の終端で待つ） */
    ready: LoadedScene | null
    switched: boolean
  }
  let warpRun: WarpRun | null = null
  /** ワープを中止して元のシーンへ戻す（覆いの色も黒に戻す。flash の白が端リンクのフェードに残らないように） */
  const abortWarp = (): void => {
    warpRun = null
    fade.alpha = 0
    fade.tint = 0x000000
  }
  /** ワープを始める。始められたら true（戦闘・遷移・別のワープの最中と、未知の id は false） */
  const startWarp = (id: string): boolean => {
    if (!canStartWarp(talkState())) return false
    if (!hasOwn(config.warps, id)) {
      console.warn(`[field-sample] 未知のワープ id: ${id}`)
      return false
    }
    const warp = config.warps[id]
    const run: WarpRun = {
      warp,
      t: 0,
      // 読み込みが終わらなくても暗転のまま待ち続けない（WARP_LOAD_TIMEOUT_MS で中止）
      next: withTimeout(
        ensureScene(warp.to),
        WARP_LOAD_TIMEOUT_MS,
        `読み込みが ${WARP_LOAD_TIMEOUT_MS / 1000} 秒以内に終わりませんでした`
      ),
      ready: null,
      switched: false,
    }
    run.next.then(
      (s) => {
        run.ready = s
      },
      (e) => {
        if (disposed) return
        // 読み込み失敗・タイムアウト: 元のシーンへ戻す
        if (warpRun === run) abortWarp()
        showError(`ワープ先の読み込みに失敗しました\n${e instanceof Error ? e.message : String(e)}`)
      }
    )
    fade.tint = WARP_COLOR[warp.effect]
    releaseWalkInput()
    warpRun = run
    return true
  }
  const tickWarp = (dt: number): void => {
    const run = warpRun
    if (!run) return
    const timing = run.warp.timing
    run.t += dt
    // 覆い切ったところで、遷移先が読めるまで待つ
    if (!run.switched && run.t >= timing.outMs) {
      if (!run.ready) run.t = timing.outMs
      else {
        const dst = run.ready
        warnOrangeShifted(
          `ワープ ${run.warp.id} の at`,
          dst,
          run.warp.at,
          config.assist ? evalAssist(config.assist, flags).passable : false
        )
        const landing = snapToWalkable(landingMask(dst, flags), run.warp.at, 80)
        if (!landing) {
          showError(
            `ワープ先 ${run.warp.id} の at (${run.warp.at.x}, ${run.warp.at.y}) の近くに歩ける点がありません。ワープを中止しました`
          )
          abortWarp()
          return
        }
        sceneId = dst.id
        emotionLayer?.clearNpcs() // NPC の吹き出しはシーンごと（同 id の別シーンの NPC に乗り移らない）
        applyScene(dst)
        fade.tint = WARP_COLOR[run.warp.effect]
        pos = landing
        if (run.warp.facing) facing = run.warp.facing
        disarmed = null
        movingMs = 0
        run.switched = true
        showError(null)
      }
    }
    const smp = sampleWarp(timing, run.t)
    fade.alpha = smp.alpha
    if (smp.phase === 'done' && run.switched) {
      warpRun = null
      fade.alpha = 0
      fade.tint = 0x000000
    }
  }

  /** NPC の置き場所を警告済みのシーン（入るたびに繰り返さない） */
  const npcChecked = new Set<string>()
  const applyScene = (s: LoadedScene): void => {
    scene = s
    // 同行者の表示とラッチはシーンをまたいで持ち越さない（ワープ・端リンクの暗転明けに残さない）
    companionAlpha = 0
    assistRt = INITIAL_ASSIST_RUNTIME
    bgSprite.texture = s.background
    overlaySprite.texture = s.overlay
    foregroundSprite.texture = s.foreground?.texture ?? Texture.EMPTY
    foregroundSprite.visible = s.foreground !== null
    // 景色: 画像の高さのまま横にタイル。高さは画像 1 枚分（y から下はなし）
    const sc = config.scenes[s.id]
    scrollSprite.visible = s.scroll !== null && !!sc.scroll
    if (s.scroll && sc.scroll) {
      scrollSprite.texture = s.scroll
      scrollSprite.width = s.mask.width
      scrollSprite.height = s.scroll.height
      scrollSprite.y = sc.scroll.y
    }
    if (app.renderer.width !== s.mask.width || app.renderer.height !== s.mask.height)
      app.renderer.resize(s.mask.width, s.mask.height)
    applyDialogMetrics(s.mask.width, s.mask.height)
    // NPC はそのシーンの分だけ出す（クリックで近づく途中の取り消しも）
    approach = null
    if (!npcChecked.has(s.id)) {
      npcChecked.add(s.id)
      for (const w of npcPlacementWarnings(s.mask, sceneNpcs.get(s.id) ?? [], s.id))
        console.warn(`[field-sample] ${w}`)
    }
    for (const [sid, list] of sceneNpcs) for (const n of list) n.sprite.visible = sid === s.id
    // 白で塗って tint で色を切り替える（暗転=黒・ワープの flash=白）
    fade.clear().rect(0, 0, s.mask.width, s.mask.height).fill(0xffffff)
    fade.tint = 0x000000
  }
  applyScene(scene)
  fade.alpha = 0

  // ---- 入力 ----
  const keys: DirectionKeys = { up: false, down: false, left: false, right: false }
  const KEYMAP: Record<string, keyof DirectionKeys> = {
    ArrowUp: 'up',
    KeyW: 'up',
    ArrowDown: 'down',
    KeyS: 'down',
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
  }
  const onKey = (down: boolean) => (ev: KeyboardEvent) => {
    const k = KEYMAP[ev.code]
    if (battle || battleTransition.active || !k || ev.ctrlKey || ev.altKey || ev.metaKey) return
    ev.preventDefault()
    // 会話中は歩きの入力を受けない（離すほうは受ける）
    if (down && !acceptsWalkInput({ battle: false, talking: !!talking })) return
    if (down) approach = null
    keys[k] = down
  }
  /** 決定キー (Space / Enter / Z): 向いた方向の近傍 NPC に話しかける。会話中は送る・閉じる */
  const onTalkKey = (ev: KeyboardEvent): void => {
    // 文字入力（text 系 input・textarea・select）にフォーカスがあるときは、そちらの操作を邪魔しない。
    // checkbox / radio / button 以外の input（range・color・file・submit 等も含む）は text 扱い＝安全側で無視する
    const a = document.activeElement
    const typing =
      a instanceof HTMLTextAreaElement ||
      a instanceof HTMLSelectElement ||
      (a instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(a.type))
    const d = decideTalkKey({
      code: ev.code,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      meta: ev.metaKey,
      repeat: ev.repeat,
      focus: typing ? 'text' : 'other',
      state: talkState(),
      npcs: currentNpcs(),
      pos,
      facing,
    })
    // 何も起きない決定キー（npcs 無し・向いた先に NPC がいない）は、フォーカスも既定動作も一切触らない
    if (d.action === 'ignore') return
    // 話しかけの成立・会話中だけ、ツールバーのボタン等のフォーカスを外して決定キーをゲームへ渡す（Space で二重に押されないように）
    if (a instanceof HTMLElement && a !== document.body) a.blur()
    ev.preventDefault()
    if (d.action === 'advance') advanceTalk()
    else if (d.action === 'start') {
      const npc = currentNpcs().find((n) => n.id === d.npcId)
      if (npc) startTalk(npc)
    }
  }
  const onKeyDown = onKey(true)
  const onKeyUp = onKey(false)
  const onBlur = () => {
    keys.up = keys.down = keys.left = keys.right = false
    pointer = null
    activePointerId = null
    approach = null
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('keydown', onTalkKey)
  window.addEventListener('blur', onBlur)

  let pointer: Vec | null = null
  let activePointerId: number | null = null
  let disposed = false
  const canvas = app.canvas as HTMLCanvasElement
  const toScene = (ev: PointerEvent): Vec => {
    const r = canvas.getBoundingClientRect()
    return {
      x: ((ev.clientX - r.left) / r.width) * scene.mask.width,
      y: ((ev.clientY - r.top) / r.height) * scene.mask.height,
    }
  }
  /** 各 NPC の表示矩形（クリックの当たり。背景ピクセル） */
  const npcRects = (): NpcRect[] =>
    currentNpcs().map((n) => {
      const w = Math.abs(n.sprite.width)
      const h = n.sprite.height
      return { id: n.id, left: n.x - w / 2, right: n.x + w / 2, top: n.y - h, bottom: n.y }
    })
  const onPointerDown = (ev: PointerEvent) => {
    if (battle || battleTransition.active) return
    // 会話中のタップは会話を送る（開いた直後の同じ操作では閉じない）
    if (talking) {
      if (!dialogBox.isJustShown(250)) advanceTalk()
      return
    }
    // NPC をクリック・タップ: 近づいて話しかける（歩きの入力は採用しない）
    if (activePointerId === null && canStartTalk(talkState())) {
      const hit = npcAtPoint(npcRects(), toScene(ev))
      const npc = hit ? currentNpcs().find((n) => n.id === hit) : undefined
      if (npc) {
        pointer = null
        if (approachArrived(npc, pos)) {
          approach = null
          startTalk(npc)
        } else approach = { id: npc.id, stuckMs: 0 }
        return
      }
    }
    approach = null
    // マルチタッチ: 最初の1本だけを歩きの入力にする
    if (activePointerId !== null) return
    canvas.setPointerCapture(ev.pointerId)
    activePointerId = ev.pointerId
    pointer = toScene(ev)
  }
  const onPointerMove = (ev: PointerEvent) => {
    // 歩きの入力に採用した指以外の move は無視する（activePointerId が null なら入力なし）
    if (ev.pointerId !== activePointerId) return
    if (pointer && !battle) pointer = toScene(ev)
  }
  const endPointer = (ev: PointerEvent) => {
    // 採用していない指の up/cancel で歩きを止めない
    if (ev.pointerId !== activePointerId) return
    pointer = null
    activePointerId = null
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)

  $<HTMLInputElement>('tb-debug').addEventListener('change', (ev) => {
    debug = (ev.target as HTMLInputElement).checked
  })

  $('tb-force-battle').addEventListener('click', () => {
    if (!canStartBattleNow(talkState())) return
    const groups = forceBattleCandidates(config, sceneId)
    if (groups.length === 0) return
    const r = advanceEncounter(
      initialEncounterState({ stepDistance: 1, minSteps: 0 }),
      1,
      { stepDistance: 1, minSteps: 0 },
      { rate: 1, groups },
      config.monsters,
      Math.random
    )
    if (r.enemies) startBattle(r.enemies)
  })

  const currentVector = (): Vec => {
    const kv = keysToVector(keys)
    if (kv.x !== 0 || kv.y !== 0) return kv
    return pointer ? pointerToVector(pos, pointer, POINTER_DEADZONE) : { x: 0, y: 0 }
  }

  // ---- フレーム更新 ----
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS, 50)
    if (battleTransition.active) {
      // 戦闘の開始・終了の演出中: 演出だけ進める（入力・移動・エンカウント・戦闘の時間は止める）
      battleTransition.tick(dt)
      $('info').textContent = `戦闘遷移中  scene=${sceneId}`
      return
    }
    if (battle) {
      // 戦闘の時間を進める。勝敗の待機（#745）・ATB・ff の演出は tick に依存する。onClose で battle が null になりうる
      battle.tick(dt)
      if (!battle) return
      $('info').textContent =
        `戦闘中  scene=${sceneId}  foot=(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`
      return
    }
    const w = scene.mask.width
    const h = scene.mask.height

    clockMs += dt
    if (warpRun) {
      // ワープ中は入力・移動・エンカウントを止める（描画の時計だけ進む）
      tickWarp(dt)
    } else if (transition) {
      transition.t += dt
      if (transition.phase === 'out') {
        fade.alpha = Math.min(1, transition.t / FADE_MS)
        if (transition.t >= FADE_MS && transition.link && transition.next) {
          const link = transition.link
          const next = transition.next
          transition.next = undefined // 二重実行を防ぐ
          next
            .then((dst) => {
              if (disposed) return
              const back = findReturnLink(config, sceneId, link)
              // 通れる状態は橙込みで着地点を探し、橙の上ならラッチして続ける。通れない状態は橙を除いて探し、
              // 来た端の帯から橙を通らずにたどれる白に着けないときは移動を断る
              const passableNow = config.assist ? evalAssist(config.assist, flags) : null
              const arrival = resolveEdgeArrival({
                link,
                back,
                srcPos: pos,
                base: dst.mask,
                assisted: dst.maskAssist,
                inset: config.edgeThreshold * ARRIVAL_INSET_FACTOR,
                // ラッチ中（橙の途中で通れない状態になって渡り切った）なら、橙の上にも着地できる
                passable: edgeArrivalPassable(passableNow, assistRt, scene.mask, pos, scene.hold),
                edgeBand: config.edgeThreshold,
              })
              if (arrival.kind !== 'ok') {
                // 遷移を中止して元のシーンに留まる（同じリンクは入力が途切れるまで再発火しない）
                const refused = refuseEdgeLink(link, arrival.kind, passableNow?.held ?? false)
                disarmed = refused.disarmed
                transition = null
                fade.alpha = 0
                if (refused.reason) {
                  // 通れない状態で、橙の向こう側へ置くことになる移動を断った: 脚本へ 1 回だけ知らせる
                  window.dispatchEvent(
                    new CustomEvent('fieldsample:assist-blocked', {
                      detail: { scene: sceneId, pos: { ...pos }, reason: refused.reason },
                    })
                  )
                } else {
                  showError(
                    `遷移先 ${link.to} に歩ける点が見つかりません。遷移を中止しました（マスクを確認してください）`
                  )
                }
                return
              }
              const landing = arrival.pos
              sceneId = link.to
              emotionLayer?.clearNpcs() // NPC の吹き出しはシーンごと
              applyScene(dst)
              pos = landing
              // 端リンクで橙の上に着いたら、押されて渡る状態でラッチして続ける
              assistRt = arrival.runtime
              disarmed = back
              movingMs = 0
              transition = { phase: 'in', t: 0 }
              showError(null)
            })
            .catch((e) => {
              if (disposed) return
              // 入力が途切れるまで同じリンクを再試行しない（フェードの明滅防止）
              disarmed = link
              transition = null
              fade.alpha = 0
              showError(
                `シーンの読み込みに失敗しました\n${e instanceof Error ? e.message : String(e)}`
              )
            })
        }
      } else {
        fade.alpha = Math.max(0, 1 - transition.t / FADE_MS)
        if (transition.t >= FADE_MS) transition = null
      }
    } else if (talking) {
      // 会話中は歩行・エンカウント・端リンクを止める（描画の時計だけ進む）
    } else {
      let vec = currentVector()
      // NPC をクリックして近づいている最中: その NPC へ向かう。着いたら話しかける
      const appNpc = approach ? currentNpcs().find((n) => n.id === approach!.id) : undefined
      const kv = keysToVector(keys)
      const pre = approachBeforeMove(approach, appNpc, pos, kv.x !== 0 || kv.y !== 0)
      approach = pre.approach
      if (pre.arrived && appNpc) {
        startTalk(appNpc)
        vec = { x: 0, y: 0 }
      } else if (approach && appNpc) vec = pointerToVector(pos, appNpc, POINTER_DEADZONE)
      // 到着直後の折り返し防止: その端へ向かう入力が途切れたら解除
      if (disarmed && !isOutward(disarmed.edge, vec)) disarmed = null
      // 条件付き通行 (#862): 橙のセルはフラグが成り立つ間だけ歩ける。橙の上は押されて少し遅い
      const ast = config.assist ? evalAssist(config.assist, flags) : null
      const frame = ast
        ? stepAssistFrame({
            base: scene.mask,
            assisted: scene.maskAssist,
            pos,
            vec,
            state: ast,
            runtime: assistRt,
            hold: scene.hold,
          })
        : null
      if (frame) assistRt = frame.runtime
      const walkMask = frame ? frame.walkMask : scene.mask
      const speed =
        ast && config.assist && frame
          ? assistSpeed(config.speed, frame.onAssist, ast.ghost, config.assist.speedFactor)
          : config.speed
      const wantCompanion = frame ? frame.wantCompanion : false
      if (ast && frame) {
        // 通れない状態で橙へ進もうとした瞬間に 1 回だけ脚本へ知らせる（入力が途切れたら再武装。橙の上では出さない）
        const ev = stepBlockedEvent(assistGate, frame.blocked, pos, vec)
        assistGate = ev.gate
        if (ev.emit)
          window.dispatchEvent(
            new CustomEvent('fieldsample:assist-blocked', {
              detail: { scene: sceneId, pos: { ...pos }, reason: ast.held ? 'held' : 'locked' },
            })
          )
      }
      companionAlpha = stepCompanionAlpha(
        companionAlpha,
        wantCompanion,
        dt,
        config.assist?.fadeMs ?? 0
      )
      const r = stepMoveAroundNpcs(walkMask, pos, vec, speed, dt, currentNpcs())
      pos = r.pos
      // 近づく途中で動けない（NPC や壁に阻まれた）なら、届く距離ならそのまま話しかけ、届かなければ諦める
      if (approach && appNpc) {
        const post = approachAfterMove(approach, appNpc, pos, r.distance, dt)
        approach = post.approach
        if (post.talk) startTalk(appNpc)
      }
      facing = facingFromVector(vec, facing, diagonalWalk)
      movingMs = r.distance > 0 ? movingMs + dt : 0
      const link = detectEdgeLink(
        pos,
        { width: w, height: h },
        config.scenes[sceneId].links,
        config.edgeThreshold,
        vec,
        disarmed
      )
      // 歩いた距離でエンカウント抽選（壁に押しつけて動けていないときは距離が進まない）
      const enc = advanceEncounter(
        encState,
        r.distance,
        config.encounter,
        config.scenes[sceneId].encounter,
        config.monsters,
        Math.random
      )
      encState = enc.state
      if (enc.enemies) {
        startBattle(enc.enemies)
        return
      }
      if (link) {
        transition = { phase: 'out', t: 0, link, next: ensureScene(link.to) }
      }
    }

    // ---- 描画 ----
    // 揺れ (#864): 描画だけを上下に揺らす。足元・マスク判定は動かない
    const shake = config.scenes[sceneId].shake
    world.y = shake ? shakeOffset(shake, clockMs) : 0
    syncEmotionHost()
    const scrollCfg = config.scenes[sceneId].scroll
    if (scrollCfg && scene.scroll)
      scrollSprite.tilePosition.x = scrollOffset(scrollCfg.speed, clockMs, scene.scroll.width)
    const frames = fieldFrames(
      movingMs > 0,
      movingMs,
      config.player.frameMs,
      config.player,
      config.companion
    )
    const tex = walkTex[facing]![frames.player]
    player.texture = tex
    const s = playerScale(
      resolvePlayerHeight(config.scenes[sceneId].playerHeight, config.player.height),
      tex.height
    )
    player.scale.set(flipped.has(facing) ? -s : s, s)
    player.position.set(pos.x, pos.y)
    if (playerStand) {
      playerStand.display.zIndex = player.zIndex
      playerStand.update(tex, tex.height * s, flipped.has(facing), pos.x, pos.y)
    }
    // NPC (#841): 足元 y で主人公との前後を決める（同行者と同じ考え方）。立ち止まりは 1 コマ目
    for (const n of currentNpcs()) {
      const ntex = n.textures[n.facing]
      n.sprite.texture = ntex
      const ns = playerScale(
        n.def.height ??
          resolvePlayerHeight(config.scenes[sceneId].playerHeight, config.player.height),
        ntex.height
      )
      n.sprite.scale.set(ns, ns)
      n.sprite.position.set(n.x, n.y)
      n.sprite.zIndex = npcZ(n.y, pos.y, h)
    }
    // 感情吹き出し (#937) の置き場所: 人物の表示上端の中央（人物が出ていなければ null）
    const heads: EmotionHeads = { player: { x: pos.x, y: pos.y - tex.height * s }, companion: null }
    // NPC の頭上 (#946)。足元 n.y から表示高さ分だけ上
    for (const n of currentNpcs())
      heads[npcEmotionTarget(n.id)] = {
        x: n.x,
        y: n.y - n.textures[n.facing].height * n.sprite.scale.y,
      }
    // 同行者 (#862): 主人公の後ろ。ghost（半透明）はフラグで切り替わる
    const ctex = config.companion ? companionTex[facing4(facing)] : undefined
    if (
      config.assist &&
      config.companion &&
      ctex &&
      isCompanionShown(!!config.assist, !!config.companion, companionAlpha)
    ) {
      const g = evalAssist(config.assist, flags).ghost
      const ct = ctex[frames.companion]
      companionSprite.texture = ct
      const cs = playerScale(
        config.companion.height ??
          resolvePlayerHeight(config.scenes[sceneId].playerHeight, config.player.height),
        ct.height
      )
      companionSprite.scale.set(cs, cs)
      const cp = companionPosition(pos, facing, config.assist.offset)
      companionSprite.position.set(cp.x, cp.y)
      companionSprite.alpha = companionDisplayAlpha(companionAlpha, g, config.assist.ghostAlpha)
      companionSprite.zIndex = companionZ(cp.y, pos.y, h)
      companionSprite.visible = true
      if (companionStand) {
        companionStand.display.zIndex = companionSprite.zIndex
        companionStand.display.alpha = companionSprite.alpha
        companionStand.update(ct, ct.height * cs, false, cp.x, cp.y)
      }
      heads.companion = { x: cp.x, y: cp.y - ct.height * cs, alpha: companionSprite.alpha }
    } else {
      companionSprite.visible = false
      if (companionStand) companionStand.display.visible = false
    }
    emotionLayer?.tick(dt, heads)
    overlaySprite.visible = debug
    marker.clear()
    if (debug) {
      marker.circle(pos.x, pos.y, 5).fill(0xff0000)
      marker.rect(0, 0, w, h).stroke({ width: 2, color: 0xffff00, alpha: 0.5 })
      for (const n of currentNpcs())
        marker.circle(n.x, n.y, NPC_BLOCK_RADIUS).stroke({ width: 2, color: 0x00ffff, alpha: 0.8 })
    }
    // 前面に隠れている割合（デバッグ表示用。判定には使わない）
    const hidden = scene.foreground
      ? foregroundCoverage(scene.foreground.mask, pos, Math.abs(tex.width * s), tex.height * s)
      : 0
    $('info').textContent =
      `scene=${sceneId}  foot=(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})  facing=${facing}  encounter=${encState.distance.toFixed(0)}/${config.encounter.stepDistance} 抑制=${encState.stepsSinceBattle}/${config.encounter.minSteps}  lastBattle=${lastOutcome}${scene.foreground ? `  前面に隠れる=${(hidden * 100).toFixed(0)}%` : ''}`
  })

  // ワープの呼び出し口 (#864)。脚本・出口ゾーン(#842)・テストが id だけでワープを起こす。開発用ページ専用
  const api = {
    warp: startWarp,
    /** 現在の状態（検証用の読み取り） */
    state: () => ({
      sceneId,
      pos: { ...pos },
      facing,
      warping: warpRun !== null,
      flags: { ...flags },
      /** 会話中の NPC の id（会話していなければ null）と、このシーンの NPC の足元・向き（検証用） */
      talking: talking ? talking.id : null,
      /** 会話窓（検証用）。会話外は showing / bgVisible とも false */
      dialog: {
        showing: dialogBox.isShowing,
        bgVisible: dialogBox.isBackgroundVisible,
        text: dialogBox.getVisibleText(),
        /** 文字送り中か（ff は 1 文字ずつ。全文表示済みなら false） */
        typing: dialogBox.isTyping(),
        /** 窓の矩形（検証用。ff は画面上部に固定） */
        rect: dialogBox.getBoxRect(),
        /** 台詞の何ページ目か・全部で何ページか（ff の改ページ。1 始まり。ff 以外・会話外は 0/0） */
        page: dialogBox.getPageInfo().page,
        pages: dialogBox.getPageInfo().pages,
        /** 次のページを待って ▼ を点滅している（文字が出きっていて最終ページではない） */
        awaitingPage: dialogBox.isAwaitingPage(),
      },
      /** 感情吹き出しの層の置き先。ff の窓で会話中だけ 'stage'（窓の手前）、それ以外は 'world' (#840) */
      emotionHost: emotionHostOf(emotionLayerBox, emotionTop),
      npcs: currentNpcs().map((n) => ({ id: n.id, x: n.x, y: n.y, facing: n.facing })),
      /** 橙のラッチの状態（検証用） */
      assist: { latched: assistRt.latched, walked: assistRt.walked },
      companion: {
        visible: companionSprite.visible,
        /** 現れる・消える進み具合 (0..1)。画面の不透明度は ghost のとき ghostAlpha 倍 */
        alpha: companionAlpha,
        displayAlpha: companionSprite.visible ? companionSprite.alpha : 0,
      },
    }),
    /** フラグを立てる・下ろす (#862)。宣言していない名前は false を返して何もしない */
    setFlag,
    getFlags: () => ({ ...flags }),
    /**
     * 感情吹き出し (#937)。人物（player / companion / NPC は `npc:<id>`）の頭上に、宣言した種類（"!" "?" など）を出す。見た目だけで歩行には関与しない。
     * 出せたら true。未宣言の種類・画像が読めない種類・戦闘中・同行者が出ていないとき（companion 指定時）・いまのシーンにいない NPC は false。同じ人物に続けて出すと置き換わる。
     * `durationMs`（任意・#946）はこの 1 回だけ表示時間を上書きする（floor して 1 以上のときだけ採用、10000ms を超えれば 10000 に収め、それ以外は宣言の `durationMs`）
     */
    showEmotion,
    /** 進行中の吹き出し（検証用の読み取り） */
    emotions: () => emotionLayer?.active() ?? {},
  }
  ;(window as unknown as { fieldSample?: typeof api }).fieldSample = api
  // フラグのチェック（開発用。脚本の代わりに手で切り替える）
  const flagBox = $('tb-flags')
  for (const name of Object.keys(config.flags)) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.dataset.flag = name
    input.checked = flags[name]
    flagStore.register(name, input)
    input.addEventListener('change', () => setFlag(name, input.checked))
    label.append(input, `フラグ: ${name}`)
    flagBox.appendChild(label)
  }
  // 感情吹き出しのボタン (#937。開発用。脚本の代わりに手で出す)
  const emotionBox = $('tb-emotions')
  for (const kind of Object.keys(emotionSheets ?? {})) {
    for (const target of config.companion ? EMOTION_TARGETS : (['player'] as const)) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = `${target === 'player' ? '' : '同行者 '}${kind}`
      b.dataset.emotion = kind
      b.dataset.target = target
      b.addEventListener('click', () => api.showEmotion(target, kind))
      emotionBox.appendChild(b)
    }
  }
  const warpBox = $('tb-warps')
  for (const id of Object.keys(config.warps)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = `ワープ: ${id}`
    b.dataset.warp = id
    b.addEventListener('click', () => startWarp(id))
    warpBox.appendChild(b)
  }

  // bfcache に入る場合（persisted）は破棄しない（pageshow で復帰したとき動かなくなるため）
  const onPageHide = (ev: PageTransitionEvent): void => {
    if (ev.persisted) return
    dispose()
  }
  // HMR・ページ離脱での二重登録を防ぐ
  const dispose = (): void => {
    disposed = true
    battleTransition.cancel()
    playerStand?.destroy()
    companionStand?.destroy()
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('keydown', onTalkKey)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pagehide', onPageHide)
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', endPointer)
    canvas.removeEventListener('pointercancel', endPointer)
    conversation.destroy()
    dialogBox.dispose()
    app.destroy(true, { children: true })
  }
  window.addEventListener('pagehide', onPageHide)
  import.meta.hot?.dispose(dispose)
}

main().catch((e) => {
  showError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
