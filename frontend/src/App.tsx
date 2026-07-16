import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useParams, Navigate } from 'react-router-dom'
import ProjectListScreen from './screens/ProjectListScreen'
import EditorScreen from './screens/EditorScreen'
import AssetsScreen from './screens/AssetsScreen'
import PlayerScreen from './screens/PlayerScreen'
import JumpTopScreen from './screens/JumpTopScreen'
import { get, set } from './utils/storage'
import { defaultApiBaseUrl } from './api/client'

/**
 * 各ゲーム専用サブドメインからの直接アクセスを許可するための判定。
 * `<game>.llll-ll.com` を CF Pages の追加カスタムドメインに紐付けると、
 * その配下では問答無用で `/play/<game>` を表示する (URL バーは
 * サブドメインのまま、ブランディング用)。
 *
 * `name-name.llll-ll.com` と `localhost` / 開発用 IP は通常ルーティング。
 */
const RESERVED_HOSTS = new Set(['name-name', 'www', 'admin'])
function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function isLocalApiBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function initialApiBaseUrl(): string {
  const fallback = defaultApiBaseUrl()
  const stored = get('apiBaseUrl')
  if (!stored) return fallback

  const hostname = typeof window !== 'undefined' ? window.location.hostname : ''
  if (!isLocalHost(hostname) && isLocalApiBaseUrl(stored)) {
    return fallback
  }
  return stored
}

function detectGameSubdomain(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.hostname.match(/^([a-z0-9-]+)\.llll-ll\.com$/i)
  if (!m) return null
  const sub = m[1].toLowerCase()
  if (RESERVED_HOSTS.has(sub)) return null
  return sub
}

function App() {
  const [isDark, setIsDark] = useState(() => {
    return get('darkMode') ?? false
  })

  const [showSettings, setShowSettings] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)
  // kako-jun/name-name#107/#314: 公開ホストでは localStorage に残った
  // localhost API URL を捨て、本番 Worker を使う。VITE_API_URL があれば
  // それが既定値。
  const [apiBaseUrl, setApiBaseUrl] = useState(() => {
    return initialApiBaseUrl()
  })

  useEffect(() => {
    set('darkMode', isDark)
  }, [isDark])

  useEffect(() => {
    set('apiBaseUrl', apiBaseUrl)
  }, [apiBaseUrl])

  // <game>.llll-ll.com サブドメインからのアクセス時は問答無用で PlayerScreen
  // を表示する。BrowserRouter はマウントしない (URL バーをサブドメインのまま
  // 保つ + 全パスがプレイ画面に集約)。
  const gameSubdomain = detectGameSubdomain()
  if (gameSubdomain) {
    return (
      <PlayerScreen
        projectName={gameSubdomain}
        apiBaseUrl={apiBaseUrl}
        onBack={() => {
          // サブドメイン経由では戻る先が無いので name-name 本体トップに飛ばす
          window.location.href = 'https://name-name.llll-ll.com/'
        }}
      />
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* kako-jun/name-name#109: / は JumpTopScreen（ジャンプ風メニュー）。
            旧 ProjectListScreen は /admin に退避。 */}
        <Route
          path="/"
          element={
            <JumpTopScreenWrapper
              apiBaseUrl={apiBaseUrl}
              isDark={isDark}
              onToggleDark={() => setIsDark(!isDark)}
              onOpenSettings={() => setShowSettings(true)}
              onOpenAdmin={() => setShowAdmin(true)}
            />
          }
        />
        <Route
          path="/play/:projectName"
          element={<PlayerScreenWrapper apiBaseUrl={apiBaseUrl} />}
        />
        <Route
          path="/edit/:projectName"
          element={
            <EditorScreenWrapper
              apiBaseUrl={apiBaseUrl}
              isDark={isDark}
              onToggleDark={() => setIsDark(!isDark)}
              onOpenSettings={() => setShowSettings(true)}
            />
          }
        />
        <Route
          path="/edit/:projectName/assets"
          element={
            <AssetsScreenWrapper
              apiBaseUrl={apiBaseUrl}
              isDark={isDark}
              onToggleDark={() => setIsDark(!isDark)}
              onOpenSettings={() => setShowSettings(true)}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* 設定モーダル */}
      {showSettings && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowSettings(false)}
        >
          <div
            className={`max-h-[min(40rem,calc(100vh-2rem))] w-full max-w-md overflow-y-auto rounded-lg p-6 shadow-xl ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">設定</h2>
            <div className="space-y-4">
              <div>
                <label
                  className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
                >
                  API URL
                </label>
                <input
                  type="text"
                  value={apiBaseUrl}
                  onChange={(e) => setApiBaseUrl(e.target.value)}
                  className={`w-full px-3 py-2 border rounded ${
                    isDark
                      ? 'bg-gray-700 border-gray-600 text-white'
                      : 'bg-white border-gray-300 text-gray-900'
                  }`}
                  placeholder="http://localhost:8787"
                />
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className={`w-full py-2 px-4 rounded font-medium ${
                  isDark
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-blue-500 hover:bg-blue-600 text-white'
                }`}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdmin && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowAdmin(false)}
        >
          <div
            className={`max-h-[min(52rem,calc(100vh-2rem))] w-full max-w-5xl overflow-y-auto rounded-lg p-6 shadow-xl ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-xl font-bold">管理</h2>
            <ProjectListScreenWrapper
              apiBaseUrl={apiBaseUrl}
              isDark={isDark}
              onToggleDark={() => setIsDark(!isDark)}
              onOpenSettings={() => setShowSettings(true)}
              onClose={() => setShowAdmin(false)}
              embedded={true}
            />
          </div>
        </div>
      )}
    </BrowserRouter>
  )
}

function JumpTopScreenWrapper({
  apiBaseUrl,
  isDark,
  onToggleDark,
  onOpenSettings,
  onOpenAdmin,
}: {
  apiBaseUrl: string
  isDark: boolean
  onToggleDark: () => void
  onOpenSettings: () => void
  onOpenAdmin: () => void
}) {
  const navigate = useNavigate()

  useEffect(() => {
    document.title = 'Name × Name'
  }, [])

  return (
    <JumpTopScreen
      apiBaseUrl={apiBaseUrl}
      isDark={isDark}
      onToggleDark={onToggleDark}
      onOpenSettings={onOpenSettings}
      onPlayProject={(projectName) => navigate(`/play/${projectName}`)}
      onEditProject={(projectName) => navigate(`/edit/${projectName}`)}
      onOpenAdmin={onOpenAdmin}
    />
  )
}

function ProjectListScreenWrapper({
  apiBaseUrl,
  isDark,
  onToggleDark,
  onOpenSettings,
  onClose,
  embedded = false,
}: {
  apiBaseUrl: string
  isDark: boolean
  onToggleDark: () => void
  onOpenSettings: () => void
  onClose?: () => void
  embedded?: boolean
}) {
  const navigate = useNavigate()

  const handleSelectProject = (projectName: string) => {
    // 既定の選択操作は編集モードに遷移する。プレイ専用は ProjectList の
    // 「プレイ」ボタンから /play/:projectName に直接飛ばす（#108 step 3）。
    navigate(`/edit/${projectName}`)
  }

  const handlePlayProject = (projectName: string) => {
    navigate(`/play/${projectName}`)
  }

  return (
    <ProjectListScreen
      apiBaseUrl={apiBaseUrl}
      isDark={isDark}
      onSelectProject={handleSelectProject}
      onPlayProject={handlePlayProject}
      onToggleDark={onToggleDark}
      onOpenSettings={onOpenSettings}
      onClose={onClose}
      embedded={embedded}
    />
  )
}

function EditorScreenWrapper({
  apiBaseUrl,
  isDark,
  onToggleDark,
  onOpenSettings,
}: {
  apiBaseUrl: string
  isDark: boolean
  onToggleDark: () => void
  onOpenSettings: () => void
}) {
  const { projectName } = useParams<{ projectName: string }>()
  const navigate = useNavigate()

  if (!projectName) {
    navigate('/')
    return null
  }

  useEffect(() => {
    document.title = `${projectName} - Name × Name`
  }, [projectName])

  const handleBack = () => {
    navigate('/')
  }

  const handleNavigateToAssets = () => {
    navigate(`/edit/${projectName}/assets`)
  }

  return (
    <EditorScreen
      projectName={projectName}
      apiBaseUrl={apiBaseUrl}
      isDark={isDark}
      onBack={handleBack}
      onToggleDark={onToggleDark}
      onOpenSettings={onOpenSettings}
      onNavigateToAssets={handleNavigateToAssets}
    />
  )
}

function AssetsScreenWrapper({
  apiBaseUrl,
  isDark,
  onToggleDark,
  onOpenSettings,
}: {
  apiBaseUrl: string
  isDark: boolean
  onToggleDark: () => void
  onOpenSettings: () => void
}) {
  const { projectName } = useParams<{ projectName: string }>()
  const navigate = useNavigate()

  if (!projectName) {
    navigate('/')
    return null
  }

  useEffect(() => {
    document.title = `アセット管理 - ${projectName} - Name × Name`
  }, [projectName])

  const handleBack = () => {
    navigate(`/edit/${projectName}`)
  }

  return (
    <AssetsScreen
      projectName={projectName}
      apiBaseUrl={apiBaseUrl}
      isDark={isDark}
      onBack={handleBack}
      onToggleDark={onToggleDark}
      onOpenSettings={onOpenSettings}
    />
  )
}

function PlayerScreenWrapper({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { projectName } = useParams<{ projectName: string }>()
  const navigate = useNavigate()

  useEffect(() => {
    if (projectName) {
      document.title = `${projectName} - Name × Name`
    }
  }, [projectName])

  if (!projectName) {
    navigate('/')
    return null
  }

  const handleBack = () => {
    navigate('/')
  }

  return <PlayerScreen projectName={projectName} apiBaseUrl={apiBaseUrl} onBack={handleBack} />
}

export default App
