/**
 * 一枚絵フィールドサンプルページ (#807) のブラウザ側エントリ。本編からはリンクしない開発用ページ。
 * 計算は game/fieldWalk.ts と ./config.ts の純粋関数に任せ、ここは DOM と PixiJS の配線だけを持つ。
 */
import { Application, Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js'
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
  arrivalPosition,
  detectEdgeLink,
  foregroundCoverage,
  isAssistCell,
  foregroundFromRgba,
  facingFromVector,
  isOutward,
  keysToVector,
  maskFromRgba,
  maskWithAssist,
  playerScale,
  pointerToVector,
  resolvePlayerHeight,
  snapToWalkable,
  stepMove,
  walkFrame,
  type DirectionKeys,
  type Facing,
  type Facing8,
  type FieldLink,
  type ForegroundMask,
  type Vec,
  type WalkMask,
} from '../game/fieldWalk'
import {
  activeMask,
  assistSpeed,
  blockedAttempt,
  companionDisplayAlpha,
  companionPosition,
  companionWanted,
  evalAssist,
  facing4,
  stepCompanionAlpha,
} from '../game/fieldAssist'
import { scrollOffset, shakeOffset } from '../game/fieldMotion'
import { WARP_COLOR, sampleWarp } from '../game/fieldWarp'
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
  type FieldSampleConfig,
  type FieldWarp,
} from './config'
import defaultConfigText from './teramachi.sample.json?raw'
import { buildBattleMenu } from './battleMenu'
import { buildDummyFixture } from './dummyFixture'

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

interface LoadedScene {
  id: string
  background: Texture
  mask: WalkMask
  /** 条件付き（橙）のセルも歩ける扱いにしたマスク (#862)。橙が無ければ mask と同じ */
  maskAssist: WalkMask
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
    text = JSON.stringify(buildDummyFixture())
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
  // 条件付き通行の同行者 (#862)。#861（アクスタ化）までの暫定で、歩行絵のスプライトで出す
  const companionTex = {} as Partial<Record<Facing, Texture[]>>
  if (config.companion)
    for (const f of FACINGS) companionTex[f] = await loadFrames(config.companion.sprites[f])

  let scene = await ensureScene(config.startScene)
  let sceneId = config.startScene

  const app = new Application()
  await app.init({
    width: scene.mask.width,
    height: scene.mask.height,
    background: 0x000000,
    antialias: false,
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
  world.addChild(
    scrollSprite,
    bgSprite,
    overlaySprite,
    companionSprite,
    player,
    foregroundSprite,
    marker
  )
  // 同行者は主人公の後ろ（y が大きければ手前）に並べ替える。前面・マーカーは常に上
  world.sortableChildren = true
  scrollSprite.zIndex = 0
  bgSprite.zIndex = 1
  overlaySprite.zIndex = 2
  player.zIndex = 10
  foregroundSprite.zIndex = 20
  marker.zIndex = 30
  app.stage.addChild(world, fade)

  const startSnap = snapToWalkable(scene.mask, config.start, 80)
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
  const flags: Record<string, boolean> = { ...config.flags }
  const setFlag = (name: string, value: boolean): boolean => {
    if (!hasOwn(flags, name)) {
      console.warn(`[field-sample] 未宣言のフラグ: ${name}`)
      return false
    }
    flags[name] = value
    const box = document.querySelector<HTMLInputElement>(`input[data-flag="${name}"]`)
    if (box) box.checked = value
    return true
  }
  let companionAlpha = 0
  let assistArmed = true
  // ---- ランダムエンカウント・戦闘 (#809) ----
  let encState: EncounterWalkState = initialEncounterState(config.encounter)
  let battle: BattleScreen | null = null
  let lastOutcome = '-'
  const startBattle = (enemies: BattleEntity[]): void => {
    // 歩きの入力を捨てる（戦闘側は戦闘画面が自前で入力を受ける）。押しっぱなしの pointer capture も解放する
    keys.up = keys.down = keys.left = keys.right = false
    if (activePointerId !== null && canvas.hasPointerCapture(activePointerId))
      canvas.releasePointerCapture(activePointerId)
    activePointerId = null
    pointer = null
    movingMs = 0
    const b = config.battle
    const menu = buildBattleMenu(config)
    const bg = config.scenes[sceneId].encounter?.background ?? b.background
    const engine = new BattleEngine(
      config.party.map((p) => ({ ...p })),
      enemies.map((e) => ({ ...e })),
      b.atb ? { atb: b.atb } : {}
    )
    world.visible = false
    fade.visible = false
    app.renderer.resize(b.width, b.height)
    battle = new BattleScreen(engine, b.width, b.height, {
      layout: b.layout,
      spriteStyle: b.spriteStyle,
      ...(b.presentation ? { presentation: b.presentation } : {}),
      ...(b.windowStyle ? { windowStyle: b.windowStyle } : {}),
      ...(b.commandLayout ? { commandLayout: b.commandLayout } : {}),
      ...(bg ? { background: bg } : {}),
      // 候補窓 (#890)。戦闘ごとに複製して渡す（BattleScreen がアイテムの count を書き換えるため）
      ...(menu ? { menu } : {}),
      ...(b.enemyGrid ? { enemyGrid: b.enemyGrid } : {}),
      ...(b.enemyGrid && b.enemyWindowOverlap !== undefined
        ? { enemyWindowOverlap: b.enemyWindowOverlap }
        : {}),
      onClose: (outcome) => {
        lastOutcome = outcome
        endBattle()
      },
    })
    app.stage.addChild(battle)
  }
  const endBattle = (): void => {
    if (!battle) return
    app.stage.removeChild(battle)
    battle.destroy({ children: true })
    battle = null
    // 同じシーン・同じ位置に戻る（pos / facing / sceneId は戦闘中ずっと保持している）
    app.renderer.resize(scene.mask.width, scene.mask.height)
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
  /** ワープを始める。始められたら true（戦闘・遷移・別のワープの最中と、未知の id は false） */
  const startWarp = (id: string): boolean => {
    if (battle || transition || warpRun) return false
    if (!hasOwn(config.warps, id)) {
      console.warn(`[field-sample] 未知のワープ id: ${id}`)
      return false
    }
    const warp = config.warps[id]
    const run: WarpRun = { warp, t: 0, next: ensureScene(warp.to), ready: null, switched: false }
    run.next.then(
      (s) => {
        run.ready = s
      },
      (e) => {
        // 読み込み失敗: 元のシーンへ戻す
        if (warpRun === run) warpRun = null
        fade.alpha = 0
        showError(`ワープ先の読み込みに失敗しました\n${e instanceof Error ? e.message : String(e)}`)
      }
    )
    fade.tint = WARP_COLOR[warp.effect]
    keys.up = keys.down = keys.left = keys.right = false
    pointer = null
    movingMs = 0
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
        const landing = snapToWalkable(dst.mask, run.warp.at, 80)
        if (!landing) {
          showError(
            `ワープ先 ${run.warp.id} の at (${run.warp.at.x}, ${run.warp.at.y}) の近くに歩ける点がありません。ワープを中止しました`
          )
          warpRun = null
          fade.alpha = 0
          return
        }
        sceneId = dst.id
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

  const applyScene = (s: LoadedScene): void => {
    scene = s
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
    if (battle || !k || ev.ctrlKey || ev.altKey || ev.metaKey) return
    ev.preventDefault()
    keys[k] = down
  }
  const onKeyDown = onKey(true)
  const onKeyUp = onKey(false)
  const onBlur = () => {
    keys.up = keys.down = keys.left = keys.right = false
    pointer = null
    activePointerId = null
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
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
  const onPointerDown = (ev: PointerEvent) => {
    if (battle) return
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
    if (battle || transition) return
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
              const arrived = back
                ? arrivalPosition(
                    link,
                    pos,
                    back,
                    dst.mask,
                    config.edgeThreshold * ARRIVAL_INSET_FACTOR
                  )
                : null
              const fallback = snapToWalkable(
                dst.mask,
                { x: dst.mask.width / 2, y: dst.mask.height / 2 },
                Math.max(dst.mask.width, dst.mask.height)
              )
              const landing = arrived ?? fallback
              if (!landing) {
                // 新シーンに歩ける点が無い: 遷移を中止して元のシーンに留まる
                disarmed = link
                transition = null
                fade.alpha = 0
                showError(
                  `遷移先 ${link.to} に歩ける点が見つかりません。遷移を中止しました（マスクを確認してください）`
                )
                return
              }
              sceneId = link.to
              applyScene(dst)
              pos = landing
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
    } else {
      const vec = currentVector()
      // 到着直後の折り返し防止: その端へ向かう入力が途切れたら解除
      if (disarmed && !isOutward(disarmed.edge, vec)) disarmed = null
      // 条件付き通行 (#862): 橙のセルはフラグが成り立つ間だけ歩ける。橙の上は押されて少し遅い
      const ast = config.assist ? evalAssist(config.assist, flags) : null
      const walkMask = ast
        ? activeMask(scene.mask, scene.maskAssist, ast.passable, pos)
        : scene.mask
      const onAssist = ast !== null && ast.passable && isAssistCell(scene.mask, pos.x, pos.y)
      const speed =
        ast && config.assist
          ? assistSpeed(config.speed, onAssist, ast.ghost, config.assist.speedFactor)
          : config.speed
      const wantCompanion = ast ? companionWanted(scene.mask, pos, vec, ast.passable) : false
      if (ast) {
        // 通れない状態で橙へ進もうとした瞬間に 1 回だけ脚本へ知らせる（入力が途切れたら再武装）
        if (blockedAttempt(scene.mask, pos, vec, ast.passable)) {
          if (assistArmed) {
            assistArmed = false
            window.dispatchEvent(
              new CustomEvent('fieldsample:assist-blocked', {
                detail: { scene: sceneId, pos: { ...pos }, reason: ast.held ? 'held' : 'locked' },
              })
            )
          }
        } else assistArmed = true
      }
      companionAlpha = stepCompanionAlpha(
        companionAlpha,
        wantCompanion,
        dt,
        config.assist?.fadeMs ?? 0
      )
      const r = stepMove(walkMask, pos, vec, speed, dt)
      pos = r.pos
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
    const scrollCfg = config.scenes[sceneId].scroll
    if (scrollCfg && scene.scroll)
      scrollSprite.tilePosition.x = scrollOffset(scrollCfg.speed, clockMs, scene.scroll.width)
    const tex = walkTex[facing]![walkFrame(movingMs > 0, movingMs, config.player.frameMs)]
    player.texture = tex
    const s = playerScale(
      resolvePlayerHeight(config.scenes[sceneId].playerHeight, config.player.height),
      tex.height
    )
    player.scale.set(flipped.has(facing) ? -s : s, s)
    player.position.set(pos.x, pos.y)
    // 同行者 (#862): 主人公の後ろ。ghost（半透明）はフラグで切り替わる
    const ctex = config.companion ? companionTex[facing4(facing)] : undefined
    if (config.assist && config.companion && ctex && companionAlpha > 0) {
      const g = evalAssist(config.assist, flags).ghost
      const ct = ctex[walkFrame(movingMs > 0, movingMs, config.player.frameMs)]
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
      companionSprite.zIndex = cp.y > pos.y ? 11 : 9
      companionSprite.visible = true
    } else {
      companionSprite.visible = false
    }
    overlaySprite.visible = debug
    marker.clear()
    if (debug) {
      marker.circle(pos.x, pos.y, 5).fill(0xff0000)
      marker.rect(0, 0, w, h).stroke({ width: 2, color: 0xffff00, alpha: 0.5 })
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
    input.addEventListener('change', () => setFlag(name, input.checked))
    label.append(input, `フラグ: ${name}`)
    flagBox.appendChild(label)
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
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pagehide', onPageHide)
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', endPointer)
    canvas.removeEventListener('pointercancel', endPointer)
    app.destroy(true, { children: true })
  }
  window.addEventListener('pagehide', onPageHide)
  import.meta.hot?.dispose(dispose)
}

main().catch((e) => {
  showError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
