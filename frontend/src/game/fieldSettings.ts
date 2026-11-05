/**
 * 全画面メニュー「せってい」(#880) の値 → 実際の挙動への変換。DOM / PixiJS に触れない純粋関数だけを持つ。
 *
 * 値は `FieldMenuState.settings`（key → 選択肢 index）。表示する項目は既定が `DEFAULT_CONFIG_OPTIONS`（`fieldMenuScreens.ts`）で、
 * セーブ・復元で許可するキーと選択肢数は**実際に使う options**（定義側の独自 options を含む。`normalizeSettings`）で決まる。
 *
 * 注意: `settingIndex` / 既定 index / 選択肢数の判定（`battleModeOf` `battleSpeedFactor` `messageMsPerChar` など標準キーの解釈）は
 * `DEFAULT_CONFIG_OPTIONS` の選択肢数を前提にする。定義側が標準キー（`messageSpeed` など）を別の選択肢数で再利用すると、
 * 範囲外の値は既定に落ちる等、表示と挙動が食い違う。標準キーは既定の選択肢数のまま使い、別の意味の項目は独自キーにすること。
 * 値が無いキーは「設定の既定」（ATB の方式はゲーム設定の `battle.atbMode`、速さ・メッセージは 3 = 等倍）のまま動く。
 *
 * 接続先（2026-11 時点）:
 * - バトルモード・バトルスピード: 戦闘の ATB（`BattleEngine` の `atb.mode` / `atb.speed`）。ターン制の戦闘には効かない
 * - メッセージスピード: 会話窓の 1 文字あたり ms（`DialogBox.setMsPerChar`）。戦闘ログの文字送りは dq 表示だけで速度の口が無いので未接続
 * - カーソル: 戦闘の候補窓（じゅもん・どうぐ・わざ）を開くとき前回選んだ行から始める（`BattleScreen` の `cursorMemory`）
 * - BGM / SE 音量: 一枚絵フィールド・戦闘に音の再生が無いので未接続（値は保存する）
 * - キー割当（PC）: メニュー内の決定/戻る（`fieldMenu.ts` の `menuKeyEvent`）だけ。会話送り・戦闘は未接続
 */
import type { AtbMode } from './battleEngine'
import type { MenuOption } from './fieldMenuScreens'
import { DEFAULT_CONFIG_OPTIONS } from './fieldMenuScreens'

export type MenuSettings = Readonly<Record<string, number>>

/** 設定の既定の選択肢 index（選択肢の `initial`。ATB の方式だけゲーム設定が決める） */
const defaultIndex = (key: string): number =>
  DEFAULT_CONFIG_OPTIONS.find((o) => o.key === key)?.initial ?? 0

const choiceCount = (key: string): number =>
  DEFAULT_CONFIG_OPTIONS.find((o) => o.key === key)?.choices.length ?? 0

/** その key の選択 index。無い・範囲外は既定 */
export function settingIndex(settings: MenuSettings, key: string): number {
  const v = settings[key]
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < choiceCount(key)
    ? v
    : defaultIndex(key)
}

/** バトルモード。値が無いときは `fallback`（ゲーム設定の `battle.atbMode`）。0 = ウェイト / 1 = アクティブ */
export function battleModeOf(settings: MenuSettings, fallback: AtbMode): AtbMode {
  const v = settings.battleMode
  if (v === 0) return 'wait'
  if (v === 1) return 'active'
  return fallback
}

/** バトルスピード（1〜5 の index 0〜4）→ ATB の速さの倍率。既定の 3（index 2）が等倍 */
export const BATTLE_SPEED_FACTORS: readonly number[] = [0.5, 0.75, 1, 1.5, 2]

export function battleSpeedFactor(settings: MenuSettings): number {
  return BATTLE_SPEED_FACTORS[settingIndex(settings, 'battleSpeed')]
}

/** メッセージスピード（1〜5）→ 1 文字あたり ms にかける倍率。大きい番号ほど速い（ms は小さい）。既定の 3 が等倍 */
export const MESSAGE_MS_FACTORS: readonly number[] = [2, 1.5, 1, 0.6, 0.25]

/**
 * 会話窓の 1 文字あたり ms。`base` は窓の既定（ゲーム設定を反映した、メニューが何も変える前の値。**最初に 1 回だけ捕捉して**毎回渡す。
 * 変更済みの現在値を渡すと設定のたびに倍率が積み重なる）。0（即時表示）は倍率に関係なく 0。倍率 1（既定の 3）は `base` に戻る
 */
export function messageMsPerChar(base: number, settings: MenuSettings): number {
  const factor = MESSAGE_MS_FACTORS[settingIndex(settings, 'messageSpeed')]
  return base <= 0 ? 0 : Math.max(1, Math.round(base * factor))
}

/** せっていが実際の挙動に与える値（配線は `field/main.ts`。ここは計算だけ） */
export interface AppliedSettings {
  /** 会話窓の 1 文字あたり ms */
  dialogMsPerChar: number
  /** 戦闘の ATB。ターン制（`base.atbMode` が無い）では undefined */
  atb?: { mode: AtbMode; speed: number }
  /** 戦闘の候補窓のカーソル記憶（メモリ）。セッション内のみ（セーブしない） */
  cursorMemory: boolean
  bgmVolume: number
  seVolume: number
}

/**
 * せってい → 実際の挙動の値。`base.dialogMs` は窓の既定（最初に 1 回捕捉）、`base.atbMode` はゲーム設定の ATB の方式（ターン制は undefined）。
 * 何度呼んでも、同じ settings には同じ値を返す（前回の結果に依存しない）
 */
export function applySettings(
  settings: MenuSettings,
  base: { dialogMs: number; atbMode?: AtbMode }
): AppliedSettings {
  return {
    dialogMsPerChar: messageMsPerChar(base.dialogMs, settings),
    ...(base.atbMode
      ? {
          atb: {
            mode: battleModeOf(settings, base.atbMode),
            speed: battleSpeedFactor(settings),
          },
        }
      : {}),
    cursorMemory: cursorMemoryOn(settings),
    bgmVolume: volumeOf(settings, 'bgm'),
    seVolume: volumeOf(settings, 'se'),
  }
}

/** カーソル。0 = メモリ（既定）/ 1 = リセット */
export function cursorMemoryOn(settings: MenuSettings): boolean {
  return settingIndex(settings, 'cursor') === 0
}

/** 音量（0〜5 の index = 値）→ 0〜1 */
export function volumeOf(settings: MenuSettings, key: 'bgm' | 'se'): number {
  return settingIndex(settings, key) / 5
}

/**
 * セーブに書く・読む設定の検証。`options`（実際に使う項目。定義側の独自項目を含む。省略は既定の項目）の
 * キーで、範囲内の整数だけ残す（不正なものは捨てる）
 */
export function normalizeSettings(
  raw: unknown,
  options: readonly Pick<MenuOption, 'key' | 'choices'>[] = DEFAULT_CONFIG_OPTIONS
): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const o of options) {
    const v = (raw as Record<string, unknown>)[o.key]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < o.choices.length)
      out[o.key] = v
  }
  return out
}

/** 接続の状況（説明バーに「効かない」理由を出すため） */
export interface SettingsConnection {
  /** 戦闘が ATB か（ターン制なら バトルモード・スピードは効かない） */
  atb: boolean
  /** BGM・SE の再生があるか */
  audio: boolean
}

/**
 * 「せってい」の項目。既定の項目に、効く範囲・まだ効かない理由を説明バーの文として添える。
 * バトルモードの初期位置は、ゲーム設定の ATB の方式に合わせる
 */
export function buildConfigOptions(conn: SettingsConnection, atbMode: AtbMode): MenuOption[] {
  const turnBased = 'この作品の戦闘はターン制のため、まだ効きません'
  const noAudio = 'この作品には音の再生がないため、まだ効きません（値は保存されます）'
  const note: Record<string, string> = {
    battleMode: conn.atb
      ? 'ATB の進み方。ウェイト = コマンドを選ぶ間は止まる / アクティブ = 止まらない'
      : turnBased,
    battleSpeed: conn.atb ? 'ATB ゲージが溜まる速さ（1 遅い〜5 速い）' : turnBased,
    messageSpeed: '会話窓の文字が出る速さ（1 遅い〜5 速い）。戦闘のメッセージにはまだ効きません',
    cursor:
      'メモリ = 戦闘の じゅもん・どうぐ・わざ の窓で前回選んだ行から始める（セーブはしません）/ リセット = 毎回先頭から',
    bgm: conn.audio ? 'BGM の音量' : noAudio,
    se: conn.audio ? 'SE の音量' : noAudio,
    keys: 'メニュー内の 決定 / 戻る の Z・X を入れ替える。会話送り・戦闘にはまだ効きません',
  }
  return DEFAULT_CONFIG_OPTIONS.map((o) => ({
    ...o,
    choices: [...o.choices],
    ...(o.key === 'battleMode' ? { initial: atbMode === 'active' ? 1 : 0 } : {}),
    ...(note[o.key] ? { description: note[o.key] } : {}),
  }))
}
