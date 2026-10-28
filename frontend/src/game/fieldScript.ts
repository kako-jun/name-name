/**
 * 一枚絵フィールドの NPC 会話を脚本 `.md` で書く (#841 段階2)。
 * 設定 JSON の `scriptUrl`（脚本）と NPC の `scene`（`[イベント <name>]` の名前）を結び付け、
 * 話しかけた NPC のイベントを `EventRunner` で実行する。ここは副作用の少ない純関数・薄い関数だけ（main.ts から呼ぶ）。
 */
import type { EventCommand, EventDocument } from '../types'
import type { DialogBox } from './DialogBox'
import type { EventBattleHost, EventEmotionHost, EventRunner, NpcMover } from './eventRunner'
import { resolveEmotion, type EmotionResolveContext } from './fieldEmotionScript'

/** 脚本から集めた `[イベント <name>]`（名前 → コマンド列。同名は先勝ち） */
export type FieldScriptEvents = Map<string, EventCommand[]>

/** fieldSample が実行できるコマンド（台詞・ナレーション・待機・感情 #946）。NpcMove / Battle などは未対応 */
const SUPPORTED: readonly string[] = ['Dialog', 'Narration', 'Wait', 'Emotion']

/** パース済みドキュメントから `[イベント]` を集める（全章・全シーン） */
export function collectFieldEvents(doc: EventDocument): FieldScriptEvents {
  const out: FieldScriptEvents = new Map()
  for (const chapter of doc.chapters ?? []) {
    for (const scene of chapter.scenes ?? []) {
      for (const ev of scene.events ?? []) {
        if (typeof ev === 'string' || !('RpgEvent' in ev)) continue
        if (!out.has(ev.RpgEvent.name))
          out.set(ev.RpgEvent.name, ev.RpgEvent.commands as EventCommand[])
      }
    }
  }
  return out
}

/**
 * 脚本 `.md` を取得して `[イベント]` を集める。取得・パースの失敗は警告して空（呼び出し側は固定 `line` で動く）。
 * fetch とパーサは差し替え可能（テスト用・wasm の遅延 import 用）
 */
export async function loadFieldScript(
  url: string,
  fetchText: (url: string) => Promise<string>,
  parse: (markdown: string) => Promise<EventDocument>,
  warn: (msg: string) => void = (m) => console.warn(m)
): Promise<FieldScriptEvents> {
  try {
    return collectFieldEvents(await parse(await fetchText(url)))
  } catch (e) {
    warn(
      `[field-sample] scriptUrl を読めません（無視します）: ${url} ${e instanceof Error ? e.message : String(e)}`
    )
    return new Map()
  }
}

/**
 * fieldSample で実行できないコマンド（NpcMove / Battle など）を警告して取り除く。
 * 台詞（Dialog / Narration）が 1 つも残らなければ undefined（呼び出し側は固定 `line` に戻る）
 */
export function supportedCommands(
  name: string,
  commands: readonly EventCommand[],
  warn: (msg: string) => void = (m) => console.warn(m)
): EventCommand[] | undefined {
  const out: EventCommand[] = []
  for (const c of commands) {
    if (SUPPORTED.includes(c.type)) out.push(c)
    else
      warn(
        `[field-sample] [イベント ${name}] の ${c.type} はフィールドでは未対応です（読み飛ばします）`
      )
  }
  // 台詞（Dialog / Narration）が 1 つも無いイベントは会話にならない（Wait だけで閉じてしまう）ので固定 line に戻す
  return out.some((c) => c.type === 'Dialog' || c.type === 'Narration') ? out : undefined
}

/**
 * NPC の `scene` から実行するコマンド列を選ぶ。
 * scene 未指定 → undefined（警告なし）。脚本・イベントが無い、または実行できる台詞が無い → 警告して undefined（固定 `line` に戻る）
 */
export function resolveNpcCommands(
  scene: string | undefined,
  events: FieldScriptEvents | undefined,
  warn: (msg: string) => void = (m) => console.warn(m)
): EventCommand[] | undefined {
  if (scene === undefined) return undefined
  const commands = events?.get(scene)
  if (!commands) {
    warn(
      `[field-sample] NPC の scene "${scene}" の [イベント] が見つかりません（固定の line で話します）`
    )
    return undefined
  }
  const ok = supportedCommands(scene, commands, warn)
  if (!ok)
    warn(
      `[field-sample] [イベント ${scene}] に実行できる台詞がありません（固定の line で話します）`
    )
  return ok
}

/**
 * 起動時（脚本の読み込み後）に 1 回だけ、各 NPC の `scene` を脚本と照合して警告する。
 * 話しかけるたびに同じ警告が出ないよう、実行時の `resolveNpcCommands` には警告を渡さない。
 * `scriptLoaded` が false（`scriptUrl` なし／読めなかった）のときは、scene 付き NPC ごとに「固定 line で話す」警告を返す
 */
export function checkNpcScripts(
  npcs: ReadonlyArray<{ where: string; scene?: string }>,
  events: FieldScriptEvents | undefined
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of npcs) {
    if (n.scene === undefined) continue
    if (!events || events.size === 0) {
      out.push(
        `[field-sample] ${n.where} の scene "${n.scene}" は脚本を読めていません（固定の line で話します）`
      )
      continue
    }
    if (seen.has(n.scene)) continue
    seen.add(n.scene)
    resolveNpcCommands(n.scene, events, (m) => out.push(m))
  }
  return out
}

/** EventRunner が要求する NpcMover。フィールドでは動かさない（警告して即完了） */
export function createFieldNpcMover(
  warn: (msg: string) => void = (m) => console.warn(m)
): NpcMover {
  return {
    moveNpcTo(npc) {
      warn(`[field-sample] NpcMove(${npc}) はフィールドでは未対応です（読み飛ばします）`)
      return Promise.resolve()
    },
  }
}

/** EventRunner が要求する EventBattleHost。フィールドでは始めない（警告して null＝始められなかった） */
export function createFieldBattleHost(
  warn: (msg: string) => void = (m) => console.warn(m)
): EventBattleHost {
  return {
    startBattle(id) {
      warn(`[field-sample] Battle(${id}) はイベントからは未対応です（読み飛ばします）`)
      return Promise.resolve(null)
    },
  }
}

/**
 * EventRunner の `emotionHost` (#946)。脚本の `[感情:]` を `resolveEmotion` で解決し、`show`（= `showEmotion` 相当）へ渡す。
 * 解決できない対象・未宣言の種類は警告して無視（フィールドも会話も止めない）。`getContext` は呼ぶたびに最新の
 * シーン・同行者の状態を返す（シーンをまたいで NPC の一覧が変わるため）
 */
export function createFieldEmotionHost(
  getContext: () => EmotionResolveContext,
  show: (target: string, kind: string, durationMs?: number) => boolean,
  warn: (msg: string) => void = (m) => console.warn(m),
  tag = '[field-sample]'
): EventEmotionHost {
  return {
    showEmotion(target, kind, durationMs) {
      const { command, warnings } = resolveEmotion(
        { target, kind, duration_ms: durationMs },
        getContext()
      )
      for (const w of warnings) warn(`${tag} ${w}`)
      if (command && !show(command.target, command.kind, command.durationMs))
        warn(
          `${tag} [感情: ${target}, ${kind}] を出せませんでした（戦闘中・同行者が出ていない・別シーンの NPC・絵が読めない種類のいずれか）`
        )
    },
  }
}

/** 会話窓。DialogBox のうち会話に使う口だけ（テストでは偽物を渡す） */
export type TalkDialog = Pick<DialogBox, 'show' | 'hide' | 'isTyping' | 'skipTypewriter'>

/**
 * 1 回の会話。脚本のイベント（EventRunner）か、固定の 1 行（`line`）のどちらか。
 * `active` の間は呼び出し側が歩行入力などを止める。最後の台詞を送り終えたら窓を閉じて `onEnd` を呼ぶ
 */
export class FieldConversation {
  private lineActive = false
  private onEnd: (() => void) | undefined

  constructor(
    private readonly dialog: TalkDialog,
    private readonly runner: Pick<EventRunner, 'run' | 'advance' | 'isRunning' | 'destroy'>
  ) {}

  /** 会話中か（固定行の表示中、または脚本の実行中。Wait の待ち中も含む） */
  get active(): boolean {
    return this.lineActive || this.runner.isRunning
  }

  /** 脚本のイベントがあればそれを、無ければ固定の `line` を出す */
  start(name: string, line: string, commands: EventCommand[] | undefined, onEnd: () => void): void {
    if (this.active) return
    this.onEnd = onEnd
    if (commands && commands.length > 0) {
      this.runner.run(commands, () => this.finish())
      return
    }
    this.lineActive = true
    this.dialog.show(name, line)
  }

  /** 実行中の脚本を捨てる（ページ破棄時） */
  destroy(): void {
    this.runner.destroy()
    this.lineActive = false
    this.onEnd = undefined
  }

  /** 送り: 表示中なら全文表示、済んでいれば次の台詞（最後なら閉じる） */
  advance(): void {
    if (this.runner.isRunning) {
      this.runner.advance()
      return
    }
    if (!this.lineActive) return
    if (this.dialog.isTyping()) this.dialog.skipTypewriter()
    else {
      this.dialog.hide()
      this.lineActive = false
      this.finish()
    }
  }

  private finish(): void {
    const cb = this.onEnd
    this.onEnd = undefined
    cb?.()
  }
}
