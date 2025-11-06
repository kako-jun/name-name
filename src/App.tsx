import { useState, useEffect } from 'react'
import ScriptEditor from './components/ScriptEditor'
import NovelPlayer from './components/NovelPlayer'
import { ScriptRow, Mode } from './types'

// サンプルデータ
const initialScriptData: ScriptRow[] = [
  { id: 1, character: 'ナレーター', text: '物語が始まる...', expression: '' },
  { id: 2, character: '主人公', text: 'こんにちは、世界！', expression: '笑顔' },
  { id: 3, character: 'ヒロイン', text: 'よろしくね！', expression: '照れ' },
]

function App() {
  const [mode, setMode] = useState<Mode>('edit')
  const [scriptData, setScriptData] = useState<ScriptRow[]>(initialScriptData)
  const [selectedIndex, setSelectedIndex] = useState<number>(0)
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('darkMode')
    return saved ? JSON.parse(saved) : false
  })

  useEffect(() => {
    localStorage.setItem('darkMode', JSON.stringify(isDark))
  }, [isDark])

  return (
    <div className={`flex flex-col h-screen ${isDark ? 'dark bg-gray-900' : 'bg-white'}`}>
      <header
        className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
      >
        <div className="px-6 py-2 flex items-center justify-between">
          <h1 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Name × Name
          </h1>
          {/* テーマ切り替えスイッチ */}
          <button
            onClick={() => setIsDark(!isDark)}
            className={`w-10 h-10 flex items-center justify-center rounded transition-colors ${
              isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
            }`}
            title={isDark ? 'Light Mode' : 'Dark Mode'}
          >
            {isDark ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* モード切替ボタン（画面右下隅に縦並び固定） */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        <button
          className={`w-12 h-12 flex items-center justify-center transition-colors rounded-lg shadow-md border ${
            mode === 'edit'
              ? isDark
                ? 'bg-gray-700 text-white border-gray-600'
                : 'bg-gray-900 text-white border-gray-800'
              : isDark
                ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 border-gray-700'
                : 'bg-white text-gray-600 hover:bg-gray-100 border-gray-300'
          }`}
          onClick={() => setMode('edit')}
          title="Edit Mode"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </button>
        <button
          className={`w-12 h-12 flex items-center justify-center transition-colors rounded-lg shadow-md border ${
            mode === 'play'
              ? isDark
                ? 'bg-gray-700 text-white border-gray-600'
                : 'bg-gray-900 text-white border-gray-800'
              : isDark
                ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 border-gray-700'
                : 'bg-white text-gray-600 hover:bg-gray-100 border-gray-300'
          }`}
          onClick={() => setMode('play')}
          title="Play Mode"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      </div>

      <main className="flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <ScriptEditor
            scriptData={scriptData}
            setScriptData={setScriptData}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            isDark={isDark}
          />
        ) : (
          <NovelPlayer scriptData={scriptData} startIndex={selectedIndex} />
        )}
      </main>
    </div>
  )
}

export default App
