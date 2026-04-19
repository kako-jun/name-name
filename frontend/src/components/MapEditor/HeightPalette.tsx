// 高さ編集タブのパレット（プリセット値 + カスタム入力）。
// Issue #91。
import {
  formatHeightLabel,
  HeightField,
  HEIGHT_PRESETS,
  heightToBackgroundColor,
} from './heightUtils'

interface HeightPaletteProps {
  field: HeightField
  selectedValue: number
  customValue: number
  onSelectValue: (value: number) => void
  onCustomValueChange: (value: number) => void
  isDark: boolean
}

function HeightPalette({
  field,
  selectedValue,
  customValue,
  onSelectValue,
  onCustomValueChange,
  isDark,
}: HeightPaletteProps) {
  const presets = HEIGHT_PRESETS[field]

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
        高さ選択:
      </span>
      <div className="flex gap-2">
        {presets.map((value) => {
          const isSelected = Math.abs(value - selectedValue) < 1e-9
          return (
            <button
              key={value}
              type="button"
              onClick={() => onSelectValue(value)}
              className={`px-3 py-2 rounded flex items-center gap-2 transition-colors ${
                isSelected
                  ? isDark
                    ? 'bg-blue-600 text-white'
                    : 'bg-blue-500 text-white'
                  : isDark
                    ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <div
                className="w-4 h-4 border border-black"
                style={{ backgroundColor: heightToBackgroundColor(field, value) }}
              />
              <span className="text-sm">{formatHeightLabel(value)}</span>
            </button>
          )
        })}
      </div>
      <div
        className={`flex items-center gap-1 ml-2 pl-2 border-l ${
          isDark ? 'border-gray-600' : 'border-gray-300'
        }`}
      >
        <label
          className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
          htmlFor="height-custom-input"
        >
          カスタム:
        </label>
        <input
          id="height-custom-input"
          type="number"
          step="0.25"
          min="0"
          value={customValue}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value)
            if (!Number.isNaN(parsed)) {
              onCustomValueChange(parsed)
            } else if (e.target.value === '') {
              onCustomValueChange(0)
            }
          }}
          className={`w-20 px-2 py-1 rounded border text-sm ${
            isDark
              ? 'bg-gray-700 border-gray-600 text-gray-200'
              : 'bg-white border-gray-300 text-gray-900'
          }`}
        />
        <button
          type="button"
          onClick={() => onSelectValue(customValue)}
          className={`px-2 py-1 rounded text-sm transition-colors ${
            isDark
              ? 'bg-gray-600 text-gray-200 hover:bg-gray-500'
              : 'bg-gray-300 text-gray-800 hover:bg-gray-400'
          }`}
        >
          選択
        </button>
      </div>
    </div>
  )
}

export default HeightPalette
