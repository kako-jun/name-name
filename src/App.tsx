import { useState } from 'react'
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

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 shadow-lg">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-4 gap-4">
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              Name <span className="text-pink-200">×</span> Name
            </h1>
            <div className="flex gap-2 bg-white/10 backdrop-blur-sm rounded-lg p-1">
              <button
                className={`px-4 py-2 rounded-md font-medium transition-all duration-200 ${
                  mode === 'edit'
                    ? 'bg-white text-indigo-600 shadow-md'
                    : 'text-white hover:bg-white/20'
                }`}
                onClick={() => setMode('edit')}
              >
                ✏️ エディット
              </button>
              <button
                className={`px-4 py-2 rounded-md font-medium transition-all duration-200 ${
                  mode === 'play'
                    ? 'bg-white text-purple-600 shadow-md'
                    : 'text-white hover:bg-white/20'
                }`}
                onClick={() => setMode('play')}
              >
                🎮 プレイ
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <ScriptEditor
            scriptData={scriptData}
            setScriptData={setScriptData}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
          />
        ) : (
          <NovelPlayer scriptData={scriptData} startIndex={selectedIndex} />
        )}
      </main>
    </div>
  )
}

export default App
