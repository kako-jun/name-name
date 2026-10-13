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
  buildBattleSetup,
  defaultConfig,
  describeView,
  extractConfigUrl,
  initialView,
  parseConfigText,
  pushView,
  resolveSize,
  swapView,
  type BattleSampleConfig,
  type BlinkHistory,
  type BattleSampleView,
  type ScreenSizeId,
} from './config'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function showError(msg: string | null): void {
  const el = $('error')
  el.textContent = msg ?? ''
  el.hidden = msg === null
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
    showError(`設定 JSON が不正です（内蔵既定で表示します）\n${url}\n${parsed.error}`)
  } catch (e) {
    showError(
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
    resolution: window.devicePixelRatio || 1,
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
      app.renderer.resize(setup.width, setup.height)
      const engine = new BattleEngine(setup.party, setup.enemies)
      screen = new BattleScreen(engine, setup.width, setup.height, setup.options)
      app.stage.addChild(screen)
      $('info').textContent = describeView(view, app.renderer.resolution, setup)
    } catch (e) {
      showError(`描画に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    }
    syncToolbar()
  }

  const change = (patch: Partial<BattleSampleView>): void => {
    history = pushView(history, { ...history.current, ...patch })
    render()
  }
  const blink = (): void => {
    history = swapView(history)
    render()
  }

  // ---- ツールバー ----
  const tb = $('toolbar')
  const select = <T extends string>(
    label: string,
    id: string,
    options: readonly T[],
    on: (v: T) => void
  ) => {
    const l = document.createElement('label')
    l.textContent = label
    const s = document.createElement('select')
    s.id = id
    for (const o of options) s.add(new Option(o, o))
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
    if (autoChk.checked) autoTimer = window.setInterval(blink, 1000)
  })
  autoLabel.append(autoChk, '1秒ごとに自動交互')
  tb.appendChild(autoLabel)

  function syncToolbar(): void {
    const v = history.current
    layoutSel.value = v.layout
    styleSel.value = v.spriteStyle
    bgChk.checked = v.backgroundOn
    partySel.value = String(v.partyCount)
    enemySel.value = String(v.enemyCount)
    sizeSel.value = v.sizeId
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space') return
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
  showError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
