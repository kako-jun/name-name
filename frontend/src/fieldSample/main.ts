/**
 * 一枚絵フィールドサンプルページ (#807) のブラウザ側エントリ。本編からはリンクしない開発用ページ。
 * 計算は game/fieldWalk.ts と ./config.ts の純粋関数に任せ、ここは DOM と PixiJS の配線だけを持つ。
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
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
import { resolveUrl } from '../battleSample/config'
import { findReturnLink, parseConfigText, type FieldSampleConfig } from './config'
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

/** CORS 付きで配信された画像を取得し、テクスチャと（必要なら）ピクセルの両方に使える ImageBitmap にする */
async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url)
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
    console.warn(`[field-sample] ${id}: 背景とマスクの大きさが違います`)
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
  if (parsed.ok) return parsed.value
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

  let pos: Vec = snapToWalkable(scene.mask, config.start, 80) ?? config.start
  let facing: Facing = 'down'
  let movingMs = 0
  let disarmed: FieldLink | null = null
  let debug = false
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
    if (!k || ev.ctrlKey || ev.altKey || ev.metaKey) return
    ev.preventDefault()
    keys[k] = down
  }
  window.addEventListener('keydown', onKey(true))
  window.addEventListener('keyup', onKey(false))
  window.addEventListener('blur', () => {
    keys.up = keys.down = keys.left = keys.right = false
    pointer = null
  })

  let pointer: Vec | null = null
  const canvas = app.canvas as HTMLCanvasElement
  const toScene = (ev: PointerEvent): Vec => {
    const r = canvas.getBoundingClientRect()
    return {
      x: ((ev.clientX - r.left) / r.width) * scene.mask.width,
      y: ((ev.clientY - r.top) / r.height) * scene.mask.height,
    }
  }
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId)
    pointer = toScene(ev)
  })
  canvas.addEventListener('pointermove', (ev) => {
    if (pointer) pointer = toScene(ev)
  })
  const endPointer = () => {
    pointer = null
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)

  $<HTMLInputElement>('tb-debug').addEventListener('change', (ev) => {
    debug = (ev.target as HTMLInputElement).checked
  })

  const currentVector = (): Vec => {
    const kv = keysToVector(keys)
    if (kv.x !== 0 || kv.y !== 0) return kv
    return pointer ? pointerToVector(pos, pointer, POINTER_DEADZONE) : { x: 0, y: 0 }
  }

  // ---- フレーム更新 ----
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS, 50)
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
              sceneId = link.to
              applyScene(dst)
              pos = arrived ?? fallback ?? pos
              disarmed = back
              movingMs = 0
              transition = { phase: 'in', t: 0 }
              showError(null)
            })
            .catch((e) => {
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
      `scene=${sceneId}  foot=(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})  facing=${facing}`
  })
}

main().catch((e) => {
  showError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
