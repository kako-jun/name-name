import { useState, useEffect } from 'react'

type AssetType = 'images' | 'sounds' | 'movies' | 'ideas'

interface Asset {
  name: string
  size: number
  url: string
}

interface AssetsScreenProps {
  projectName: string
  apiBaseUrl: string
  isDark: boolean
  onBack: () => void
  onToggleDark: () => void
  onOpenSettings: () => void
}

function AssetsScreen({
  projectName,
  apiBaseUrl,
  isDark,
  onBack,
  onToggleDark,
  onOpenSettings,
}: AssetsScreenProps) {
  const [selectedType, setSelectedType] = useState<AssetType>('images')
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null)

  // アセット一覧を取得
  useEffect(() => {
    const loadAssets = async () => {
      setLoading(true)
      try {
        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/assets/${selectedType}`)
        if (!response.ok) {
          throw new Error(`Failed to load assets: ${response.status}`)
        }
        const data = await response.json()
        setAssets(data.assets)
      } catch (error) {
        console.error('Failed to load assets:', error)
      } finally {
        setLoading(false)
      }
    }
    loadAssets()
  }, [apiBaseUrl, projectName, selectedType])

  // ファイルアップロード
  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData()
        formData.append('file', file)

        const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/assets/${selectedType}`, {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          throw new Error(`Failed to upload ${file.name}: ${response.status}`)
        }
      }

      // アップロード成功後、一覧を再取得
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/assets/${selectedType}`)
      const data = await response.json()
      setAssets(data.assets)
    } catch (error) {
      console.error('Failed to upload files:', error)
    } finally {
      setUploading(false)
    }
  }

  // ファイル削除
  const handleDelete = async (asset: Asset) => {
    if (!confirm(`${asset.name}を削除しますか？`)) return

    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${projectName}/assets/${selectedType}/${asset.name}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(`Failed to delete ${asset.name}: ${response.status}`)
      }

      // 削除成功後、一覧を再取得
      setAssets(assets.filter((a) => a.name !== asset.name))
      if (selectedAsset?.name === asset.name) {
        setSelectedAsset(null)
      }
    } catch (error) {
      console.error('Failed to delete file:', error)
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const getAssetTypeLabel = (type: AssetType): string => {
    const labels = {
      images: '画像',
      sounds: '音声',
      movies: '動画',
      ideas: 'アイデア',
    }
    return labels[type]
  }

  return (
    <div className={`flex flex-col h-screen ${isDark ? 'dark bg-gray-900' : 'bg-white'}`}>
      <header className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}>
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="プロジェクトに戻る"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              アセット管理 <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- {projectName}</span>
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
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>

        {/* タブ */}
        <div className={`flex border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          {(['images', 'sounds', 'movies', 'ideas'] as AssetType[]).map((type) => (
            <button
              key={type}
              onClick={() => setSelectedType(type)}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                selectedType === type
                  ? isDark
                    ? 'border-b-2 border-blue-500 text-blue-400'
                    : 'border-b-2 border-blue-500 text-blue-600'
                  : isDark
                    ? 'text-gray-400 hover:text-gray-300'
                    : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {getAssetTypeLabel(type)}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-hidden flex">
        {/* アセット一覧 */}
        <div className={`w-96 border-r ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'} overflow-y-auto`}>
          <div className="p-4">
            <label
              className={`block w-full px-4 py-8 text-center rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
                isDark
                  ? 'border-gray-600 hover:border-gray-500 bg-gray-700 hover:bg-gray-600'
                  : 'border-gray-300 hover:border-gray-400 bg-white hover:bg-gray-50'
              }`}
            >
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files)}
                disabled={uploading}
              />
              <svg
                className={`w-8 h-8 mx-auto mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                {uploading ? 'アップロード中...' : 'ファイルを選択またはドロップ'}
              </span>
            </label>

            {loading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto"></div>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {assets.map((asset) => (
                  <div
                    key={asset.name}
                    onClick={() => setSelectedAsset(asset)}
                    className={`p-3 rounded-lg cursor-pointer transition-colors ${
                      selectedAsset?.name === asset.name
                        ? isDark
                          ? 'bg-blue-900/50 border border-blue-500'
                          : 'bg-blue-50 border border-blue-500'
                        : isDark
                          ? 'bg-gray-700 hover:bg-gray-600'
                          : 'bg-white hover:bg-gray-100 border border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${isDark ? 'text-gray-200' : 'text-gray-900'}`}>
                          {asset.name}
                        </div>
                        <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                          {formatFileSize(asset.size)}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(asset)
                        }}
                        className={`ml-2 p-1 rounded transition-colors ${
                          isDark
                            ? 'text-gray-400 hover:text-red-400 hover:bg-red-900/20'
                            : 'text-gray-500 hover:text-red-600 hover:bg-red-50'
                        }`}
                        title="削除"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* プレビューエリア */}
        <div className="flex-1 overflow-y-auto">
          {selectedAsset ? (
            <div className="p-8">
              <h2 className={`text-xl font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {selectedAsset.name}
              </h2>

              {selectedType === 'images' && (
                <div className="flex justify-center">
                  <img
                    src={`${apiBaseUrl}${selectedAsset.url}`}
                    alt={selectedAsset.name}
                    className="max-w-full max-h-[600px] rounded-lg shadow-lg"
                  />
                </div>
              )}

              {selectedType === 'sounds' && (
                <div className="flex justify-center">
                  <audio controls className="w-full max-w-md">
                    <source src={`${apiBaseUrl}${selectedAsset.url}`} />
                    お使いのブラウザは音声の再生に対応していません。
                  </audio>
                </div>
              )}

              {selectedType === 'movies' && (
                <div className="flex justify-center">
                  <video controls className="max-w-full max-h-[600px] rounded-lg shadow-lg">
                    <source src={`${apiBaseUrl}${selectedAsset.url}`} />
                    お使いのブラウザは動画の再生に対応していません。
                  </video>
                </div>
              )}

              {selectedType === 'ideas' && (
                <div
                  className={`p-6 rounded-lg font-mono whitespace-pre-wrap ${
                    isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-50 text-gray-900'
                  }`}
                >
                  <iframe
                    src={`${apiBaseUrl}${selectedAsset.url}`}
                    className="w-full min-h-[600px] border-none"
                    title={selectedAsset.name}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className={`text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                <p>アセットを選択してプレビュー</p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default AssetsScreen
