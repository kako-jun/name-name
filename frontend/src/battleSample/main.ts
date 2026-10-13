/**
 * 戦闘画面サンプルページ (#749) のブラウザ側エントリ。本編からはリンクしない開発用ページ。
 * 計算は config.ts の純粋関数に任せ、ここは DOM と PixiJS の配線だけを持つ。
 */
import { Application } from 'pixi.js'
import { BattleEngine } from '../game/battleEngine'
import { BattleScreen } from '../game/BattleScreen'
import {
  SCREEN_SIZES,
  MAX_PARTY,
  MAX_ENEMIES,
  RESOLUTION_MODES,
  buildBattleSetup,
  defaultConfig,
  describeView,
  effectivePartyCount,
  extractConfigUrl,
  initialView,
  parseConfigText,
  pushView,
  resolveResolution,
  resolveSize,
  swapView,
  type BattleSampleConfig,
  type BlinkHistory,
  type BattleSampleView,
  type ResolutionMode,
  type ScreenSizeId,
} from './config'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// 設定 JSON のエラーと描画エラーは別々に持つ（描画が成功したら描画エラーだけ消す）
let configError: string | null = null
let renderError: string | null = null

function refreshError(): void {
  const msg = [configError, renderError].filter((m): m is string => m !== null).join('\n\n')
  const el = $('error')
  el.textContent = msg
  el.hidden = msg === ''
}
function showConfigError(msg: string | null): void {
  configError = msg
  refreshError()
}
function showRenderError(msg: string | null): void {
  renderError = msg
  refreshError()
}

async function loadConfig(): Promise<BattleSampleConfig> {
  const base = location.href
  const url = extractConfigUrl(location.search, base)
  if (!url) return defaultConfig()
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = parseConfigText(await res.text(), url)
    if (parsed.ok) return parsed.value
    showConfigError(`設定 JSON が不正です（内蔵既定で表示します）\n${url}\n${parsed.error}`)
  } catch (e) {
    showConfigError(
      `設定 JSON を読み込めません（内蔵既定で表示します）\n${url}\n${e instanceof Error ? e.message : String(e)}`
    )
  }
  return defaultConfig()
}

async function main(): Promise<void> {
  const config = await loadConfig()
  let history: BlinkHistory = { current: initialView(config), previous: null }
  let autoTimer: number | null = null

  const app = new Application()
  const first = resolveSize(history.current.sizeId)
  await app.init({
    width: first.width,
    height: first.height,
    background: 0x000000,
    antialias: false,
    // 既定は本編相当（本編の app.init は resolution 未指定 = 1）。ツールバーで実 DPR に切替可
    resolution: resolveResolution(history.current.resolutionMode, window.devicePixelRatio),
    autoDensity: true,
  })
  $('stage').appendChild(app.canvas as HTMLCanvasElement)

  let screen: BattleScreen | null = null

  const render = (): void => {
    const view = history.current
    try {
      const setup = buildBattleSetup(config, view)
      if (screen) {
        app.stage.removeChild(screen)
        screen.destroy({ children: true })
        screen = null
      }
      const resolution = resolveResolution(view.resolutionMode, window.devicePixelRatio)
      app.renderer.resize(setup.width, setup.height, resolution)
      const engine = new BattleEngine(setup.party, setup.enemies)
      screen = new BattleScreen(engine, setup.width, setup.height, setup.options)
      app.stage.addChild(screen)
      $('info').textContent = describeView(
        view,
        window.devicePixelRatio,
        setup,
        app.renderer.resolution
      )
      showRenderError(null)
    } catch (e) {
      showRenderError(
        `描画に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
      )
    }
    syncToolbar()
  }

  const change = (patch: Partial<BattleSampleView>): void => {
    history = pushView(history, { ...history.current, ...patch })
    render()
  }
  const blink = (): void => {
    const next = swapView(history)
    if (next === history) return // ひとつ前が無い: 何も変わらないので再描画しない
    history = next
    render()
  }

  // ---- ツールバー ----
  const tb = $('toolbar')
  const select = <T extends string>(
    label: string,
    id: string,
    options: readonly T[],
    on: (v: T) => void,
    labels: Partial<Record<T, string>> = {}
  ) => {
    const l = document.createElement('label')
    l.textContent = label
    const s = document.createElement('select')
    s.id = id
    for (const o of options) s.add(new Option(labels[o] ?? o, o))
    s.addEventListener('change', () => on(s.value as T))
    l.appendChild(s)
    tb.appendChild(l)
    return s
  }
  const layoutSel = select('layout', 'tb-layout', ['front', 'side'] as const, (v) =>
    change({ layout: v })
  )
  const styleSel = select('spriteStyle', 'tb-style', ['none', 'acrylic'] as const, (v) =>
    change({ spriteStyle: v })
  )
  const windowSel = select('windowStyle', 'tb-window', ['dark', 'ff-blue'] as const, (v) =>
    change({ windowStyle: v })
  )
  const bgLabel = document.createElement('label')
  const bgChk = document.createElement('input')
  bgChk.type = 'checkbox'
  bgChk.id = 'tb-bg'
  bgChk.disabled = config.background === null
  bgChk.addEventListener('change', () => change({ backgroundOn: bgChk.checked }))
  bgLabel.append(bgChk, '背景あり')
  tb.appendChild(bgLabel)
  const nums = ['1', '2', '3', '4']
  const partySel = select('味方', 'tb-party', nums.slice(0, MAX_PARTY), (v) =>
    change({ partyCount: Number(v) })
  )
  const enemySel = select('敵', 'tb-enemy', nums.slice(0, MAX_ENEMIES), (v) =>
    change({ enemyCount: Number(v) })
  )
  const resSel = select(
    '解像度',
    'tb-resolution',
    RESOLUTION_MODES,
    (v) => change({ resolutionMode: v as ResolutionMode }),
    { main: '本編相当(1)', dpr: '実DPR' }
  )
  const sizeSel = select(
    '画面サイズ',
    'tb-size',
    SCREEN_SIZES.map((s) => s.id),
    (v) => change({ sizeId: v as ScreenSizeId })
  )
  const blinkBtn = document.createElement('button')
  blinkBtn.textContent = '前の設定と切替 (Space)'
  blinkBtn.addEventListener('click', blink)
  tb.appendChild(blinkBtn)
  const autoLabel = document.createElement('label')
  const autoChk = document.createElement('input')
  autoChk.type = 'checkbox'
  autoChk.id = 'tb-auto'
  autoChk.addEventListener('change', () => {
    if (autoTimer !== null) {
      window.clearInterval(autoTimer)
      autoTimer = null
    }
    if (autoChk.checked && history.previous) autoTimer = window.setInterval(blink, 1000)
  })
  autoLabel.append(autoChk, '1秒ごとに自動交互')
  tb.appendChild(autoLabel)

  function syncToolbar(): void {
    const v = history.current
    layoutSel.value = v.layout
    styleSel.value = v.spriteStyle
    windowSel.value = v.windowStyle
    bgChk.checked = v.backgroundOn
    partySel.value = String(effectivePartyCount(v))
    enemySel.value = String(v.enemyCount)
    sizeSel.value = v.sizeId
    resSel.value = v.resolutionMode
    // front は本編どおり hero 1 人だけをエンジンに渡すので、味方人数は選べない
    const front = v.layout === 'front'
    partySel.disabled = front
    $('hint-party').hidden = !front
    // ひとつ前の設定が無い間は、ブリンクも自動交互もできない
    const noPrev = history.previous === null
    blinkBtn.disabled = noPrev
    autoChk.disabled = noPrev
    $('hint-prev').hidden = !noPrev
    if (noPrev && autoTimer !== null) {
      window.clearInterval(autoTimer)
      autoTimer = null
      autoChk.checked = false
    }
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.repeat) return
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return
    const t = ev.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) {
      t.blur()
    }
    ev.preventDefault()
    blink()
  })

  render()
}

main().catch((e) => {
  showRenderError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
