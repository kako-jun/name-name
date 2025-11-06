import { useState, useEffect } from 'react'
import CanvasEditor from './components/CanvasEditor'
import NovelPlayer from './components/NovelPlayer'
import { Chapter, Mode } from './types'

// サンプルデータ（Canvas風エディタ用）
const initialChapters: Chapter[] = [
  {
    id: 1,
    title: '出会い',
    scenes: [
      {
        id: 1,
        title: 'プロローグ',
        cuts: [
          { id: 1, character: 'ナレーター', text: '物語が始まる...', expression: '' },
          { id: 2, character: '主人公', text: 'こんにちは、世界！', expression: '笑顔' },
        ],
      },
      {
        id: 2,
        title: '初対面',
        cuts: [
          { id: 3, character: 'ヒロイン', text: 'よろしくね！', expression: '照れ' },
          { id: 4, character: '主人公', text: 'こちらこそ！', expression: '笑顔' },
        ],
      },
    ],
  },
  {
    id: 2,
    title: '事件発生',
    scenes: [
      {
        id: 3,
        title: '不穏な空気',
        cuts: [
          { id: 5, character: 'ナレーター', text: 'その日の夜、事件が起きた。', expression: '' },
          { id: 6, character: '主人公', text: 'これは...！', expression: '驚き' },
        ],
      },
    ],
  },
  {
    id: 3,
    title: '調査開始',
    scenes: [
      {
        id: 4,
        title: '手がかり',
        cuts: [
          { id: 7, character: '主人公', text: 'この手がかりは...', expression: '真剣' },
          { id: 8, character: 'ヒロイン', text: '何か見つけた？', expression: '心配' },
        ],
      },
      {
        id: 5,
        title: '証拠の分析',
        cuts: [
          { id: 9, character: '主人公', text: 'これは重要な証拠だ', expression: '真剣' },
          { id: 10, character: 'ナレーター', text: '事件の真相が見えてきた', expression: '' },
        ],
      },
    ],
  },
  {
    id: 4,
    title: '真実への接近',
    scenes: [
      {
        id: 6,
        title: '容疑者との対峙',
        cuts: [
          { id: 11, character: '主人公', text: 'あなたが犯人なのか？', expression: '疑い' },
          { id: 12, character: '容疑者', text: '私は何も知らない...', expression: '動揺' },
        ],
      },
      {
        id: 7,
        title: '新たな謎',
        cuts: [
          { id: 13, character: 'ヒロイン', text: 'この状況、おかしくない？', expression: '疑問' },
          {
            id: 14,
            character: '主人公',
            text: '確かに...何かが引っかかる',
            expression: '考え込む',
          },
        ],
      },
    ],
  },
  {
    id: 5,
    title: '真犯人',
    scenes: [
      {
        id: 8,
        title: '真相の解明',
        cuts: [
          { id: 15, character: '主人公', text: 'すべての謎が解けた！', expression: '確信' },
          { id: 16, character: 'ナレーター', text: '驚愕の真実が明かされる', expression: '' },
        ],
      },
      {
        id: 9,
        title: '対決',
        cuts: [
          { id: 17, character: '真犯人', text: 'よくぞここまで...', expression: '冷笑' },
          { id: 18, character: '主人公', text: '観念しろ！', expression: '怒り' },
          { id: 19, character: 'ヒロイン', text: 'そんな...まさか！', expression: '驚愕' },
        ],
      },
    ],
  },
  {
    id: 6,
    title: 'エピローグ',
    scenes: [
      {
        id: 10,
        title: '事件の終結',
        cuts: [
          { id: 20, character: 'ナレーター', text: '長い事件がついに終わった', expression: '' },
          { id: 21, character: '主人公', text: 'やっと終わった...', expression: '安堵' },
        ],
      },
      {
        id: 11,
        title: '新たな日常',
        cuts: [
          { id: 22, character: 'ヒロイン', text: 'これからどうする？', expression: '笑顔' },
          { id: 23, character: '主人公', text: 'また新しい物語が始まる', expression: '希望' },
          { id: 24, character: 'ナレーター', text: '二人の冒険は続く...', expression: '' },
        ],
      },
    ],
  },
]

function App() {
  const [mode, setMode] = useState<Mode>('edit')
  const [chapters, setChapters] = useState<Chapter[]>(initialChapters)
  const [selectedCutId, setSelectedCutId] = useState<number | null>(null)
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('darkMode')
    return saved ? JSON.parse(saved) : false
  })

  useEffect(() => {
    localStorage.setItem('darkMode', JSON.stringify(isDark))
  }, [isDark])

  // chapters から scriptData を生成
  const generateScriptFromChapters = (): ScriptRow[] => {
    return chapters.flatMap((chapter) =>
      chapter.scenes.flatMap((scene) =>
        scene.cuts.map((cut) => ({
          id: cut.id,
          character: cut.character,
          text: cut.text,
          expression: cut.expression,
        }))
      )
    )
  }

  // selectedCutId から startIndex を計算
  const getStartIndexFromSelectedCut = (): number => {
    if (selectedCutId === null) return 0

    const script = generateScriptFromChapters()
    const index = script.findIndex((row) => row.id === selectedCutId)
    return index !== -1 ? index : 0
  }

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
          <CanvasEditor
            chapters={chapters}
            setChapters={setChapters}
            isDark={isDark}
            selectedCutId={selectedCutId}
            setSelectedCutId={setSelectedCutId}
          />
        ) : (
          <NovelPlayer
            scriptData={generateScriptFromChapters()}
            startIndex={getStartIndexFromSelectedCut()}
          />
        )}
      </main>
    </div>
  )
}

export default App
