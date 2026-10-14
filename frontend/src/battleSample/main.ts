/**
 * 戦闘画面サンプルページ (#749) のブラウザ側エントリ。本編からはリンクしない開発用ページ。
 * 計算は config.ts の純粋関数に任せ、ここは DOM と PixiJS の配線だけを持つ。
 */
import { Application, Assets } from 'pixi.js'
import { createRenderGate } from './renderGate'
import { BattleEngine } from '../game/battleEngine'
import { BattleScreen } from '../game/BattleScreen'
import {
  SCREEN_SIZES,
  MAX_PARTY,
  MAX_ENEMIES,
  FORMATION_MODES,
  RESOLUTION_MODES,
  assetsToUnload,
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
  type FormationMode,
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
  /** 前回描画した pixelArt。変わったときだけ Assets を unload する (#760) */
  let lastPixelArt: 'on' | 'off' | null = null
  // nearest↔linear（mipmap の有無）を切り替えるときは、キャッシュ済みのテクスチャを捨てて読み直させる。
  // 待っている間に別の描画が始まっても、unload 前のテクスチャを受け取らないよう順序を揃える
  const gate = createRenderGate((u) => Assets.unload(u))

  const render = async (): Promise<void> => {
    const view = history.current
    // 旧画面は先に破棄する（unload でテクスチャが壊れる前に、描画から外す）
    if (screen) {
      app.stage.removeChild(screen)
      screen.destroy({ children: true })
      screen = null
    }
    const stale = assetsToUnload(lastPixelArt, view, config)
    lastPixelArt = view.pixelArt
    const seq = gate.begin(stale)
    try {
      const setup = buildBattleSetup(config, view)
      if (!(await gate.wait(seq))) return // 待っている間に別の描画が始まった
      const resolution = resolveResolution(view.resolutionMode, window.devicePixelRatio)
      app.renderer.resize(setup.width, setup.height, resolution)
      const engine = new BattleEngine(setup.party, setup.enemies, {
        ...(setup.atb ? { atb: setup.atb } : {}),
        ...(Object.keys(setup.skills).length > 0 ? { skills: setup.skills } : {}),
      })
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
    void render()
  }
  const blink = (): void => {
    const next = swapView(history)
    if (next === history) return // ひとつ前が無い: 何も変わらないので再描画しない
    history = next
    void render()
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
    s.addEventListener('change', () => {
      on(s.value as T)
      // select にフォーカスが残ると cross の矢印キーがフォーム操作として扱われ効かないので、変更後は全 select で外す
      s.blur()
    })
    l.appendChild(s)
    tb.appendChild(l)
    return s
  }
  const layoutSel = select('layout', 'tb-layout', ['front', 'side'] as const, (v) =>
    change({ layout: v })
  )
  const cmdLayoutSel = select(
    'commandLayout',
    'tb-command-layout',
    ['grid', 'cross'] as const,
    (v) => change({ commandLayout: v }),
    { grid: 'grid（2x2）', cross: 'cross（十字・矢印キー）' }
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
  const toneLabel = document.createElement('label')
  const toneChk = document.createElement('input')
  toneChk.type = 'checkbox'
  toneChk.id = 'tb-tone'
  toneChk.addEventListener('change', () =>
    change({ backgroundTone: toneChk.checked ? 'on' : 'off' })
  )
  toneLabel.append(toneChk, '背景を落とす')
  tb.appendChild(toneLabel)
  const dofLabel = document.createElement('label')
  const dofChk = document.createElement('input')
  dofChk.type = 'checkbox'
  dofChk.id = 'tb-dof'
  dofChk.addEventListener('change', () => change({ backgroundDof: dofChk.checked ? 'on' : 'off' }))
  dofLabel.append(dofChk, '被写界深度（手前ぼかし）')
  tb.appendChild(dofLabel)
  const pixelLabel = document.createElement('label')
  const pixelChk = document.createElement('input')
  pixelChk.type = 'checkbox'
  pixelChk.id = 'tb-pixel-art'
  pixelChk.addEventListener('change', () => change({ pixelArt: pixelChk.checked ? 'on' : 'off' }))
  pixelLabel.append(pixelChk, 'ドット絵（nearest）')
  tb.appendChild(pixelLabel)
  const logTwLabel = document.createElement('label')
  const logTwChk = document.createElement('input')
  logTwChk.type = 'checkbox'
  logTwChk.id = 'tb-log-typewriter'
  logTwChk.addEventListener('change', () =>
    change({ logTypewriter: logTwChk.checked ? 'on' : 'off' })
  )
  logTwLabel.append(logTwChk, 'ログを1文字ずつ表示')
  tb.appendChild(logTwLabel)
  const presentationSel = select(
    '演出',
    'tb-presentation',
    ['dq', 'ff'] as const,
    (v) => change({ presentation: v }),
    { dq: 'dq（ログ・動かない）', ff: 'ff（モーション・ダメージ数字）' }
  )
  const atbLabel = document.createElement('label')
  const atbChk = document.createElement('input')
  atbChk.type = 'checkbox'
  atbChk.id = 'tb-atb'
  atbChk.addEventListener('change', () => change({ atb: atbChk.checked ? 'on' : 'off' }))
  atbLabel.append(atbChk, 'ATB（ゲージ順に行動）')
  tb.appendChild(atbLabel)
  const atbModeSel = select(
    'ATB 進行',
    'tb-atb-mode',
    ['wait', 'active'] as const,
    (v) => change({ atbMode: v }),
    { wait: '待機（コマンド選択中は停止）', active: 'アクティブ（止めない）' }
  )
  const restartBtn = document.createElement('button')
  restartBtn.id = 'tb-restart'
  restartBtn.textContent = '戦闘をやり直す'
  restartBtn.addEventListener('click', () => void render())
  tb.appendChild(restartBtn)
  const depthLabel = document.createElement('label')
  const depthChk = document.createElement('input')
  depthChk.type = 'checkbox'
  depthChk.id = 'tb-depth'
  depthChk.addEventListener('change', () => change({ depth: depthChk.checked ? 'on' : 'off' }))
  depthLabel.append(depthChk, '奥行き（行ごとの縮尺）')
  tb.appendChild(depthLabel)
  const fgLabel = document.createElement('label')
  const fgChk = document.createElement('input')
  fgChk.type = 'checkbox'
  fgChk.id = 'tb-fg'
  fgChk.disabled = config.foreground === null
  fgChk.addEventListener('change', () => change({ foregroundOn: fgChk.checked }))
  fgLabel.append(fgChk, '前景あり')
  tb.appendChild(fgLabel)
  const formationSel = select(
    '隊列',
    'tb-formation',
    FORMATION_MODES,
    (v) => change({ formation: v as FormationMode }),
    { config: '設定どおり', front: '全員前衛', backHalf: '後ろ半分を後衛' }
  )
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
    cmdLayoutSel.value = v.commandLayout
    styleSel.value = v.spriteStyle
    windowSel.value = v.windowStyle
    bgChk.checked = v.backgroundOn
    depthChk.checked = v.depth === 'on'
    fgChk.checked = v.foregroundOn
    formationSel.value = v.formation
    toneChk.checked = v.backgroundTone === 'on'
    dofChk.checked = v.backgroundDof === 'on'
    pixelChk.checked = v.pixelArt === 'on'
    logTwChk.checked = v.logTypewriter === 'on'
    presentationSel.value = v.presentation
    // ff は 1 文字ずつ表示を使わない（ff のとき無効）。ff は side のときだけ効く（front では選べない） (#745)
    logTwChk.disabled = v.presentation === 'ff' && v.layout === 'side'
    presentationSel.disabled = v.layout === 'front'
    atbChk.checked = v.atb === 'on'
    atbModeSel.value = v.atbMode
    atbModeSel.disabled = v.atb !== 'on'
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

  // ATB (#205): 時間は ticker から tick で渡す（エンジンは時計を持たない）。従来ターン制では何もしない
  app.ticker.add((ticker) => screen?.tick(ticker.deltaMS))

  void render()
}

main().catch((e) => {
  showRenderError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
