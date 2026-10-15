/**
 * 一枚絵フィールドサンプルページ (#807) のブラウザ側エントリ。本編からはリンクしない開発用ページ。
 * 計算は game/fieldWalk.ts と ./config.ts の純粋関数に任せ、ここは DOM と PixiJS の配線だけを持つ。
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
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
  facingFromVector,
  isOutward,
  keysToVector,
  maskFromRgba,
  pointerToVector,
  snapToWalkable,
  stepMove,
  walkFrame,
  type DirectionKeys,
  type Facing,
  type FieldLink,
  type Vec,
  type WalkMask,
} from '../game/fieldWalk'
import { formatEncounterGroupErrors } from '../game/encounterGroupValidation'
import { resolveUrl } from '../battleSample/config'
import {
  findReturnLink,
  forceBattleCandidates,
  parseConfigText,
  type FieldSampleConfig,
} from './config'
import defaultConfigText from './teramachi.sample.json?raw'

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
  background: Texture
  mask: WalkMask
  overlay: Texture
}

async function loadScene(config: FieldSampleConfig, id: string): Promise<LoadedScene> {
  const sc = config.scenes[id]
  const [bg, maskBmp] = await Promise.all([loadBitmap(sc.background), loadBitmap(sc.mask)])
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
  // デバッグ用オーバーレイ: 歩ける所を半透明の緑に
  const ov = ctx.createImageData(mask.width, mask.height)
  for (let i = 0; i < mask.walkable.length; i++) {
    if (mask.walkable[i]) {
      ov.data[i * 4 + 1] = 255
      ov.data[i * 4 + 3] = 90
    }
  }
  ctx.putImageData(ov, 0, 0)
  return { background: Texture.from(bg), mask, overlay: Texture.from(canvas) }
}

async function loadConfig(): Promise<FieldSampleConfig> {
  const base = location.href
  const raw = new URLSearchParams(location.search).get('config')?.trim()
  const url = raw ? resolveUrl(raw, base) : null
  let text = defaultConfigText
  let textBase = base
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
    // 敵グリッドに収まらず無効化した群 (#839 段5)。console.error は parseConfig が出している
    const errs = parsed.value.groupErrors
    if (errs && errs.length > 0) showError(formatEncounterGroupErrors(errs))
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

  // 歩行スプライト（向き×3コマ）
  const walkTex = {} as Record<Facing, Texture[]>
  for (const f of ['up', 'down', 'left', 'right'] as const) {
    walkTex[f] = await Promise.all(
      config.player.sprites[f].map(async (u) => Texture.from(await loadBitmap(u)))
    )
  }

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

  const bgSprite = new Sprite(scene.background)
  const overlaySprite = new Sprite(scene.overlay)
  const player = new Sprite(walkTex.down[0])
  player.anchor.set(0.5, 1) // 足元 = スプライト下端中心
  const marker = new Graphics()
  const fade = new Graphics()
  const world = new Container()
  world.addChild(bgSprite, overlaySprite, player, marker)
  app.stage.addChild(world, fade)

  const startSnap = snapToWalkable(scene.mask, config.start, 80)
  if (!startSnap)
    showError(
      `start (${config.start.x}, ${config.start.y}) の近くに歩ける点がありません。マスクか start を確認してください`
    )
  let pos: Vec = startSnap ?? config.start
  let facing: Facing = 'down'
  let movingMs = 0
  let disarmed: FieldLink | null = null
  let debug = false
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
  let transition: {
    phase: 'out' | 'in'
    t: number
    link?: FieldLink
    next?: Promise<LoadedScene>
  } | null = null

  const applyScene = (s: LoadedScene): void => {
    scene = s
    bgSprite.texture = s.background
    overlaySprite.texture = s.overlay
    if (app.renderer.width !== s.mask.width || app.renderer.height !== s.mask.height)
      app.renderer.resize(s.mask.width, s.mask.height)
    fade.clear().rect(0, 0, s.mask.width, s.mask.height).fill(0x000000)
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

    if (transition) {
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
      const r = stepMove(scene.mask, pos, vec, config.speed, dt)
      pos = r.pos
      facing = facingFromVector(vec, facing)
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
    const tex = walkTex[facing][walkFrame(movingMs > 0, movingMs, config.player.frameMs)]
    player.texture = tex
    const s = config.player.height / tex.height
    player.scale.set(s)
    player.position.set(pos.x, pos.y)
    overlaySprite.visible = debug
    marker.clear()
    if (debug) {
      marker.circle(pos.x, pos.y, 5).fill(0xff0000)
      marker.rect(0, 0, w, h).stroke({ width: 2, color: 0xffff00, alpha: 0.5 })
    }
    $('info').textContent =
      `scene=${sceneId}  foot=(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})  facing=${facing}  encounter=${encState.distance.toFixed(0)}/${config.encounter.stepDistance} 抑制=${encState.stepsSinceBattle}/${config.encounter.minSteps}  lastBattle=${lastOutcome}`
  })

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
