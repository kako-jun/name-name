import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom'
import ProjectListScreen from './screens/ProjectListScreen'
import EditorScreen from './screens/EditorScreen'
import AssetsScreen from './screens/AssetsScreen'

function App() {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('darkMode')
    return saved ? JSON.parse(saved) : false
  })

  const [showSettings, setShowSettings] = useState(false)
  const [apiBaseUrl, setApiBaseUrl] = useState(() => {
    return localStorage.getItem('apiBaseUrl') || 'http://localhost:7373'
  })

  useEffect(() => {
    localStorage.setItem('darkMode', JSON.stringify(isDark))
  }, [isDark])

  useEffect(() => {
    localStorage.setItem('apiBaseUrl', apiBaseUrl)
  }, [apiBaseUrl])

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ProjectListScreenWrapper
              apiBaseUrl={apiBaseUrl}
              isDark={isDark}
              onToggleDark={() => setIsDark(!isDark)}
              onOpenSettings={() => setShowSettings(true)}
            />
          }
        />
        <Route
          path="/:projectName"
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
          path="/:projectName/assets"
          element={
            <AssetsScreenWrapper
              apiBaseUrl={apiBaseUrl}
              isDark={isDark}
              onToggleDark={() => setIsDark(!isDark)}
              onOpenSettings={() => setShowSettings(true)}
            />
          }
        />
      </Routes>

      {/* 設定モーダル */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100]">
          <div
            className={`p-6 rounded-lg shadow-xl max-w-md w-full ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
          >
            <h2 className="text-xl font-bold mb-4">設定</h2>
            <div className="space-y-4">
              <div>
                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
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
                  placeholder="http://localhost:7373"
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
    </BrowserRouter>
  )
}

function ProjectListScreenWrapper({
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
  const navigate = useNavigate()

  const handleSelectProject = (projectName: string) => {
    navigate(`/${projectName}`)
  }

  return (
    <ProjectListScreen
      apiBaseUrl={apiBaseUrl}
      isDark={isDark}
      onSelectProject={handleSelectProject}
      onToggleDark={onToggleDark}
      onOpenSettings={onOpenSettings}
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
    navigate(`/${projectName}/assets`)
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
    navigate(`/${projectName}`)
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

export default App
