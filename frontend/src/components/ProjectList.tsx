import { useEffect, useState } from 'react'

interface Project {
  name: string
  path: string
  branch: string
}

interface ProjectListProps {
  apiBaseUrl: string
  isDark: boolean
  onSelectProject: (projectName: string) => void
}

function ProjectList({ apiBaseUrl, isDark, onSelectProject }: ProjectListProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadProjects = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects`)
        if (!response.ok) {
          throw new Error(`Failed to load projects: ${response.status}`)
        }
        const data = await response.json()
        setProjects(data.projects)
      } catch (error) {
        console.error('Failed to load projects:', error)
      } finally {
        setLoading(false)
      }
    }
    loadProjects()
  }, [apiBaseUrl])

  if (loading) {
    return (
      <div className={`flex items-center justify-center h-full ${isDark ? 'bg-gray-900 text-white' : 'bg-white text-gray-900'}`}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p>読み込み中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col items-center justify-center h-full p-8 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      <div className={`w-full max-w-2xl ${isDark ? 'bg-gray-800' : 'bg-white'} rounded-lg shadow-xl p-8`}>
        <h2 className={`text-2xl font-bold mb-6 ${isDark ? 'text-white' : 'text-gray-900'}`}>
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
              <button
                key={project.name}
                onClick={() => onSelectProject(project.name)}
                className={`w-full text-left p-4 rounded-lg border transition-colors ${
                  isDark
                    ? 'border-gray-700 bg-gray-700 hover:bg-gray-600 text-white'
                    : 'border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-900'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-lg">{project.name}</h3>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      ブランチ: {project.branch}
                    </p>
                  </div>
                  <svg
                    className={`w-6 h-6 ${isDark ? 'text-gray-400' : 'text-gray-400'}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ProjectList
