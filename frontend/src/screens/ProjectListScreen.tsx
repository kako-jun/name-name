import ProjectList from '../components/ProjectList'

interface ProjectListScreenProps {
  apiBaseUrl: string
  isDark: boolean
  onSelectProject: (projectName: string) => void
  /**
   * 「プレイ」ボタン押下時の遷移先。kako-jun/name-name#108 で追加。
   * 省略時は onSelectProject にフォールバック（編集モードに飛ぶ）。
   */
  onPlayProject?: (projectName: string) => void
  onToggleDark: () => void
  onOpenSettings: () => void
  onClose?: () => void
  embedded?: boolean
}

function ProjectListScreen({
  apiBaseUrl,
  isDark,
  onSelectProject,
  onPlayProject,
  onToggleDark,
  onOpenSettings,
  onClose,
  embedded = false,
}: ProjectListScreenProps) {
  return (
    <div
      className={`flex flex-col ${embedded ? 'h-full min-h-0' : 'h-screen'} ${
        isDark ? 'dark bg-gray-900' : 'bg-white'
      }`}
    >
      {!embedded && (
        <header
          className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
        >
          <div className="px-6 py-2 flex items-center justify-between">
            <div className="min-w-0">
              <h1 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Name × Name
                <span
                  className={`ml-2 text-xs font-normal ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                >
                  管理画面
                </span>
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleDark}
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
              <button
                onClick={onOpenSettings}
                className={`w-10 h-10 flex items-center justify-center rounded transition-colors ${
                  isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
                }`}
                title="Settings"
                aria-label="Settings"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
              {onClose && (
                <button
                  onClick={onClose}
                  className={`w-10 h-10 flex items-center justify-center rounded transition-colors ${
                    isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
                  }`}
                  title="閉じる"
                  aria-label="閉じる"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 6l12 12M18 6l-12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </header>
      )}

      <main className="flex-1 min-h-0 overflow-hidden">
        <ProjectList
          apiBaseUrl={apiBaseUrl}
          isDark={isDark}
          onSelectProject={onSelectProject}
          onPlayProject={onPlayProject}
          embedded={embedded}
        />
      </main>
    </div>
  )
}

export default ProjectListScreen
