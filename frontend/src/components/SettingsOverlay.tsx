import { useEffect } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../game/settings'
import { parseColorToNumber, numberToHexColor } from '../game/novelLayout'
import { DEFAULT_BAR_FILL_COLOR } from '../game/SeekBar'

interface SettingsOverlayProps {
  open: boolean
  onClose: () => void
  settings: Settings
  onChange: (s: Settings) => void
  /** SeekBar（シナリオスライダ）と揃える設定ポップアップ内スライダーの色 (#601)。
   *  frontmatter `seekbar_color:` から流す。null/undefined/不正値は SeekBar の既定色
   *  `DEFAULT_BAR_FILL_COLOR`（水色）にフォールバックし、未設定プロジェクトの見た目を変えない。 */
  seekbarColor?: string | null
}

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
  /** 数値表示の整形 */
  format?: (v: number) => string
  /** accent-color に使う CSS カラー文字列（例: "#a8dadc"）。 */
  accentColor: string
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  format,
  accentColor,
}: SliderRowProps) {
  const display = format ? format(value) : `${value}${unit ?? ''}`
  return (
    <label className="flex flex-col gap-1 text-sm">
      <div className="flex justify-between items-baseline">
        <span className="text-gray-200">{label}</span>
        <span className="text-gray-400 tabular-nums text-xs">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        style={{ accentColor }}
      />
    </label>
  )
}

/**
 * 設定オーバーレイ (Issue #138)
 *
 * テキスト速度 / オート wait time / BGM 音量 / SE 音量 / Voice 音量。
 * ESC で閉じる、デフォルトに戻すボタン付き。
 */
export function SettingsOverlay({
  open,
  onClose,
  settings,
  onChange,
  seekbarColor,
}: SettingsOverlayProps) {
  // ESC で閉じる
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })

  // スライダーの accent-color。SeekBar と揃える (#601)。未設定/不正値は SeekBar の既定色
  // DEFAULT_BAR_FILL_COLOR（水色）にフォールバックし、seekbar_color 未指定プロジェクトの
  // 見た目を変えない（非回帰）。
  const sliderAccentColor = numberToHexColor(
    parseColorToNumber(seekbarColor ?? undefined, DEFAULT_BAR_FILL_COLOR)
  )

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-label="設定"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-4 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white">設定</h2>

        <div className="flex flex-col gap-4">
          <SliderRow
            label="テキスト表示速度"
            value={settings.msPerChar}
            min={0}
            max={200}
            step={5}
            onChange={(v) => update({ msPerChar: v })}
            format={(v) =>
              v === 0
                ? '瞬間表示'
                : v <= 15
                  ? `速い (${v}ms)`
                  : v >= 60
                    ? `遅い (${v}ms)`
                    : `${v}ms/字`
            }
            accentColor={sliderAccentColor}
          />

          <SliderRow
            label="オート進行ウェイト"
            value={settings.autoWaitMs}
            min={500}
            max={8000}
            step={100}
            onChange={(v) => update({ autoWaitMs: v })}
            format={(v) => `${(v / 1000).toFixed(1)}秒`}
            accentColor={sliderAccentColor}
          />

          <SliderRow
            label="BGM 音量"
            value={settings.bgmVolume}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ bgmVolume: v })}
            format={(v) => `${Math.round(v * 100)}%`}
            accentColor={sliderAccentColor}
          />

          <SliderRow
            label="SE 音量"
            value={settings.seVolume}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ seVolume: v })}
            format={(v) => `${Math.round(v * 100)}%`}
            accentColor={sliderAccentColor}
          />

          <SliderRow
            label="ボイス音量 (将来用)"
            value={settings.voiceVolume}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ voiceVolume: v })}
            format={(v) => `${Math.round(v * 100)}%`}
            accentColor={sliderAccentColor}
          />
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-gray-700">
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
            className="text-sm text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800"
          >
            デフォルトに戻す
          </button>
        </div>

        <p className="text-xs text-gray-500 text-center">外側クリックか ESC で閉じられます</p>
      </div>
    </div>
  )
}

export default SettingsOverlay
