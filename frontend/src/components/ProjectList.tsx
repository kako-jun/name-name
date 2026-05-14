import { useEffect, useMemo, useState } from 'react'
import { createApiClient, type ProjectInfo } from '../api/client'

interface ProjectListProps {
  apiBaseUrl: string
  isDark: boolean
  onSelectProject: (projectName: string) => void
  /**
   * 「プレイ」ボタン押下時のハンドラ。kako-jun/name-name#108 で追加。
   * 省略時は表示せず、行クリックで onSelectProject (編集モード) のみ動く。
   */
  onPlayProject?: (projectName: string) => void
  embedded?: boolean
}

function ProjectList({
  apiBaseUrl,
  isDark,
  onSelectProject,
  onPlayProject,
  embedded = false,
}: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [loading, setLoading] = useState(true)
  // apiBaseUrl が変わるたびにクライアントを作り直す。createApiClient は薄い
  // ファクトリなので毎回でも実コストは無いが、useMemo にしておけば
  // 依存配列のキー値として安定する。
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])

  useEffect(() => {
    const loadProjects = async () => {
      try {
        const list = await api.listProjects()
        setProjects(list)
      } catch (error) {
        console.error('Failed to load projects:', error)
      } finally {
        setLoading(false)
      }
    }
    loadProjects()
  }, [api])

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center h-full ${isDark ? 'bg-gray-900 text-white' : 'bg-white text-gray-900'}`}
      >
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p>読み込み中...</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-y-auto p-8 ${
        embedded
          ? 'bg-transparent p-0'
          : isDark
            ? 'items-center justify-center bg-gray-900'
            : 'items-center justify-center bg-gray-50'
      }`}
    >
      <div
        className={`w-full shrink-0 ${
          embedded
            ? 'max-w-none rounded-none bg-transparent p-0 shadow-none'
            : `${isDark ? 'bg-gray-800' : 'bg-white'} max-w-2xl rounded-lg p-8 shadow-xl`
        }`}
      >
        <h2
          className={`mb-6 ${embedded ? 'text-xl' : 'text-2xl'} font-bold ${
            isDark ? 'text-white' : 'text-gray-900'
          }`}
        >
          プロジェクトを選択
        </h2>

        {projects.length === 0 ? (
          <div className={`text-center py-12 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <p>プロジェクトがありません</p>
            <p className="text-sm mt-2">サーバーでプロジェクトをクローンまたは作成してください</p>
          </div>
        ) : (
          <div className="space-y-3">
            {projects.map((project) => (
              <div
                key={project.name}
                className={`p-4 rounded-lg border ${
                  isDark
                    ? 'border-gray-700 bg-gray-700 text-white'
                    : 'border-gray-200 bg-gray-50 text-gray-900'
                }`}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-lg truncate">
                      {project.title || project.name}
                    </h3>
                    <p className={`text-sm truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {project.repo}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {onPlayProject &&
                      (project.external_url ? (
                        <a
                          href={project.external_url}
                          aria-label={`${project.title || project.name} をプレイ`}
                          className={`px-3 py-1.5 rounded font-medium text-sm transition-colors ${
                            isDark
                              ? 'bg-green-600 hover:bg-green-700 text-white'
                              : 'bg-green-500 hover:bg-green-600 text-white'
                          }`}
                        >
                          プレイ
                        </a>
                      ) : (
                        <button
                          onClick={() => onPlayProject(project.name)}
                          aria-label={`${project.title || project.name} をプレイ`}
                          className={`px-3 py-1.5 rounded font-medium text-sm transition-colors ${
                            isDark
                              ? 'bg-green-600 hover:bg-green-700 text-white'
                              : 'bg-green-500 hover:bg-green-600 text-white'
                          }`}
                        >
                          プレイ
                        </button>
                      ))}
                    <button
                      onClick={() => onSelectProject(project.name)}
                      aria-label={`${project.title || project.name} を編集`}
                      className={`px-3 py-1.5 rounded font-medium text-sm transition-colors ${
                        isDark
                          ? 'bg-blue-600 hover:bg-blue-700 text-white'
                          : 'bg-blue-500 hover:bg-blue-600 text-white'
                      }`}
                    >
                      編集
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ProjectList
