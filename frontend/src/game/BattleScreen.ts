/**
 * RPG 戦闘画面 (#173)。
 *
 * Undertale 風レイアウト + DQ1/DQ5 風の「フィールド背景を残す」方針:
 *
 *   +-----------------------+
 *   |                       |  ← フィールドのフレーム（暗くする）
 *   |    [敵スプライト]       |
 *   |                       |
 *   +---+-------+-----------+
 *   |HP/MP|たたかう|じゅもん|どうぐ|にげる|
 *   +-----+-------+----------------------+
 *   |  > スライムがあらわれた！          |  ← 戦闘ログ（最新数行）
 *   |  > ゆうしゃのこうげき！...          |
 *   +-----+-------+----------------------+
 *
 * BattleEngine（状態機械）を観測して描画する責務だけ持つ。コマンド入力は
 * 4 つのボタン (たたかう/じゅもん/どうぐ/にげる) を直接タップで決定。
 *
 * Phase 1 では呪文 / アイテムは「準備中」のログを出すだけ（パーティ #175 と
 * セットで Phase 2）。たたかう / にげる だけ動作する。
 */

import { Container, Graphics, Rectangle, Text as PixiText, TextStyle } from 'pixi.js'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

const BG_DIM_ALPHA = 0.55
const PANEL_BG = 0x000000
const PANEL_BG_ALPHA = 0.85
const PANEL_STROKE = 0xffffff
const TEXT_COLOR = 0xffffff
const HP_COLOR = 0x88ee88
const MP_COLOR = 0x88aaff

const STAGE_PADDING = 16
const COMMAND_HEIGHT = 60
const LOG_HEIGHT = 100
const LOG_VISIBLE_LINES = 4

const NAME_FONT_SIZE = 18
const COMMAND_FONT_SIZE = 18
const LOG_FONT_SIZE = 16
const HP_FONT_SIZE = 16

const TEXT_STYLE_NAME = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: NAME_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_COMMAND = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: COMMAND_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_LOG = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: LOG_FONT_SIZE,
  fill: TEXT_COLOR,
})
const TEXT_STYLE_HP = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: HP_FONT_SIZE,
  fill: TEXT_COLOR,
})

type CommandId = 'attack' | 'spell' | 'item' | 'escape'

interface CommandButton {
  id: CommandId
  hit: Container
  text: PixiText
}

export interface BattleScreenOptions {
  /** バトル終了（victory / defeat / escaped）時に呼ばれる */
  onClose?: (outcome: 'victory' | 'defeat' | 'escaped') => void
}

export class BattleScreen extends Container {
  private engine: BattleEngine
  private screenWidth: number
  private screenHeight: number
  private opts: BattleScreenOptions

  private dim: Graphics // フィールドを暗くする半透明黒
  private enemyNameText: PixiText
  private enemyHpText: PixiText
  private heroStatsText: PixiText
  private commandPanel: Graphics
  private logPanel: Graphics
  private logLines: PixiText[] = []
  private commands: CommandButton[] = []

  constructor(
    engine: BattleEngine,
    screenWidth: number,
    screenHeight: number,
    opts: BattleScreenOptions = {}
  ) {
    super()
    this.engine = engine
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.opts = opts

    this.dim = new Graphics()
    this.commandPanel = new Graphics()
    this.logPanel = new Graphics()
    this.enemyNameText = new PixiText({ text: '', style: TEXT_STYLE_NAME })
    this.enemyHpText = new PixiText({ text: '', style: TEXT_STYLE_HP })
    this.heroStatsText = new PixiText({ text: '', style: TEXT_STYLE_HP })

    this.addChild(this.dim)
    this.addChild(this.enemyNameText)
    this.addChild(this.enemyHpText)
    this.addChild(this.commandPanel)
    this.addChild(this.heroStatsText)
    this.addChild(this.logPanel)
    this.buildCommandButtons()
    this.buildLogLines()
    this.layout()
    this.refresh()
  }

  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.layout()
    this.refresh()
  }

  /** UI からコマンドが選ばれたとき呼ばれる。エンジン側を進めて refresh */
  private handleCommand(id: CommandId): void {
    if (this.engine.isOver()) return
    switch (id) {
      case 'attack':
        this.engine.selectAttack()
        break
      case 'escape':
        this.engine.selectEscape()
        break
      case 'spell':
      case 'item':
        // Phase 1: パーティ / マスターアクセスが #175 で揃ってから実装
        // 現状は識別ログのみ（戦闘エンジン側の log には積まない）
        console.info(`[BattleScreen] command '${id}' は #175 で実装`)
        break
    }
    this.refresh()
    if (this.engine.isOver()) {
      const outcome = this.engine.getState().phase
      // outcome は victory / defeat / escaped のいずれか（isOver がガード）
      this.opts.onClose?.(outcome as 'victory' | 'defeat' | 'escaped')
    }
  }

  private buildCommandButtons(): void {
    const labels: Array<{ id: CommandId; label: string }> = [
      { id: 'attack', label: 'たたかう' },
      { id: 'spell', label: 'じゅもん' },
      { id: 'item', label: 'どうぐ' },
      { id: 'escape', label: 'にげる' },
    ]
    for (const item of labels) {
      const text = new PixiText({ text: item.label, style: TEXT_STYLE_COMMAND })
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointertap', () => this.handleCommand(item.id))
      this.addChild(hit)
      this.addChild(text)
      this.commands.push({ id: item.id, hit, text })
    }
  }

  private buildLogLines(): void {
    for (let i = 0; i < LOG_VISIBLE_LINES; i++) {
      const text = new PixiText({ text: '', style: TEXT_STYLE_LOG })
      this.logLines.push(text)
      this.addChild(text)
    }
  }

  private layout(): void {
    const W = this.screenWidth
    const H = this.screenHeight

    // フィールド全体を暗くする半透明黒
    this.dim.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: BG_DIM_ALPHA })

    // 敵スプライト領域: 上半分の中央。スプライトは未実装、名前と HP テキストだけ
    this.enemyNameText.anchor.set(0.5, 0)
    this.enemyNameText.x = W / 2
    this.enemyNameText.y = H * 0.15
    this.enemyHpText.anchor.set(0.5, 0)
    this.enemyHpText.x = W / 2
    this.enemyHpText.y = H * 0.15 + NAME_FONT_SIZE + 8

    // コマンドパネル（画面下部）
    const commandY = H - LOG_HEIGHT - COMMAND_HEIGHT - STAGE_PADDING
    const commandW = W - STAGE_PADDING * 2
    this.commandPanel
      .clear()
      .roundRect(STAGE_PADDING, commandY, commandW, COMMAND_HEIGHT, 6)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ color: PANEL_STROKE, width: 2 })

    // HP/MP（コマンドパネル内左端）
    this.heroStatsText.x = STAGE_PADDING + 12
    this.heroStatsText.y = commandY + (COMMAND_HEIGHT - HP_FONT_SIZE) / 2

    // 4 コマンドを HP/MP の右側に均等割
    const cmdAreaX = STAGE_PADDING + 180
    const cmdAreaW = W - cmdAreaX - STAGE_PADDING
    const cmdW = cmdAreaW / this.commands.length
    for (let i = 0; i < this.commands.length; i++) {
      const node = this.commands[i]
      const cellX = cmdAreaX + i * cmdW
      node.hit.hitArea = new Rectangle(cellX, commandY, cmdW, COMMAND_HEIGHT)
      node.text.anchor.set(0.5, 0.5)
      node.text.x = cellX + cmdW / 2
      node.text.y = commandY + COMMAND_HEIGHT / 2
    }

    // ログパネル（画面最下部）
    const logY = H - LOG_HEIGHT - STAGE_PADDING
    this.logPanel
      .clear()
      .roundRect(STAGE_PADDING, logY, commandW, LOG_HEIGHT, 6)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ color: PANEL_STROKE, width: 2 })
    for (let i = 0; i < this.logLines.length; i++) {
      const text = this.logLines[i]
      text.x = STAGE_PADDING + 12
      text.y = logY + 8 + i * (LOG_FONT_SIZE + 4)
    }
  }

  /** エンジン状態を読み取り、テキストを更新する */
  private refresh(): void {
    const s = this.engine.getState()
    const aliveEnemy: BattleEntity | undefined = s.enemies.find((e) => e.hp > 0) ?? s.enemies[0]
    if (aliveEnemy) {
      this.enemyNameText.text = aliveEnemy.name
      this.enemyHpText.text = `HP ${aliveEnemy.hp}/${aliveEnemy.maxHp}`
      this.enemyHpText.style.fill = aliveEnemy.hp > 0 ? HP_COLOR : 0x666666
    }
    const hero: BattleEntity | undefined = s.party[0]
    if (hero) {
      this.heroStatsText.text = `${hero.name}\nHP ${hero.hp}/${hero.maxHp}  MP ${hero.mp}/${hero.maxMp}`
      this.heroStatsText.style.fill = hero.hp > 0 ? TEXT_COLOR : 0x888888
    }
    // ログ末尾 LOG_VISIBLE_LINES 件
    const tail = s.log.slice(-LOG_VISIBLE_LINES)
    for (let i = 0; i < this.logLines.length; i++) {
      this.logLines[i].text = tail[i] ?? ''
    }
    // 暫定: コマンド入力不可なら見た目で示す（alpha 半分）
    const inputEnabled = s.phase === 'party-input'
    for (const cmd of this.commands) {
      cmd.hit.alpha = inputEnabled ? 1 : 0.4
      cmd.text.alpha = inputEnabled ? 1 : 0.4
      cmd.hit.eventMode = inputEnabled ? 'static' : 'none'
    }
    void MP_COLOR // MP バー実装は将来。現状 unused 警告抑制（将来の HP/MP バー UI で使用）
  }
}
