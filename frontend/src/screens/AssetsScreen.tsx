import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import SaveDiscardButtons from '../components/SaveDiscardButtons'
import { createApiClient, type AssetEntry } from '../api/client'

type AssetType = 'images' | 'sounds' | 'movies' | 'ideas'

// kako-jun/name-name#107: 旧 FastAPI は assets を { name, size, url, tags } で返し、
// `${apiBaseUrl}${url}` で raw bytes を直接返していた。Worker は AssetEntry
// (`{ name, path, sha, size, type, download_url }`) を返し、bytes は
// download_url (raw.githubusercontent.com) から直接取る。
// ローカル UI 用に旧 Asset 型と互換のあるラッパを作る。tags は #108 で再設計予定。
interface Asset {
  name: string
  size: number
  url: string // 表示・再生用 URL（download_url ?? '' のフォールバック）
  tags: string[] // 暫定で常に []
}

const DEFAULT_BRANCH = 'develop'

function entryToAsset(entry: AssetEntry): Asset {
  return {
    name: entry.name,
    size: entry.size,
    url: entry.download_url ?? '',
    tags: [],
  }
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
  const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [allTags, setAllTags] = useState<string[]>([])
  const [newTagInput, setNewTagInput] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // apiBaseUrl が変わるたびにクライアントを作り直す
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])

  // 検索入力のデバウンス (300ms)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(value), 300)
  }, [])

  // アンマウント時にデバウンスタイマーをクリア
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // kako-jun/name-name#107: Worker モデルでは「未コミット変更」概念無し。
  //   旧 5 秒間隔の git status ポーリングは廃止。hasUnsavedChanges は常に false 維持。
  //   保存/破棄ボタンは UI として残すが、押しても no-op + 一覧再取得のみ
  //   （UI 統合は #108 で行う）。
  useEffect(() => {
    setHasUnsavedChanges(false)
  }, [projectName])

  // セーブボタン: Worker モデルではアップロード時点で commit 済み。no-op + フラグクリア
  const handleSave = async () => {
    setIsSaving(true)
    try {
      // PUT contents が即 commit する設計のため、ここで個別に何かをする必要はない。
      setHasUnsavedChanges(false)
    } finally {
      setIsSaving(false)
    }
  }

  // 変更を破棄: Worker では「未コミット差分」が無いので一覧再取得だけ
  const handleDiscard = async () => {
    setShowDiscardConfirm(false)
    setIsSaving(true)
    try {
      await fetchAssets()
      setHasUnsavedChanges(false)
    } catch (error) {
      console.error('Failed to refresh assets:', error)
    } finally {
      setIsSaving(false)
    }
  }

  // タブ切り替え時に選択とフィルターをクリア
  useEffect(() => {
    setSelectedAsset(null)
    setSearchInput('')
    setDebouncedQuery('')
    setSelectedTag(null)
    setNewTagInput('')
  }, [selectedType])

  // アセット選択変更時にタグ入力をクリア
  useEffect(() => {
    setNewTagInput('')
  }, [selectedAsset?.name])

  // kako-jun/name-name#107: タグは Worker 側未実装。暫定で空配列。
  //   別 Issue (assets メタ再設計) で本実装する予定。
  const fetchTags = useCallback(async () => {
    setAllTags([])
  }, [])

  useEffect(() => {
    fetchTags()
  }, [fetchTags])

  // アセット一覧を取得。
  // 旧 FastAPI は q / tag をサーバ側で絞り込んでいたが、Worker は単純な
  // ディレクトリリストしか返さないため、検索とタグ絞り込みは クライアント側で行う。
  // tags は #108 で再導入予定なので現状は空。
  const fetchAssets = useCallback(async () => {
    setLoading(true)
    try {
      const entries = await api.listAssets(projectName, selectedType, { ref: DEFAULT_BRANCH })
      const all = entries.filter((e) => e.type === 'file').map(entryToAsset)
      const filtered = debouncedQuery
        ? all.filter((a) => a.name.toLowerCase().includes(debouncedQuery.toLowerCase()))
        : all
      // tag フィルタは現状空なので素通し（selectedTag が null のまま）
      setAssets(filtered)
    } catch (error) {
      console.error('Failed to load assets:', error)
      setAssets([])
    } finally {
      setLoading(false)
    }
  }, [api, projectName, selectedType, debouncedQuery])

  useEffect(() => {
    fetchAssets()
  }, [fetchAssets])

  // File を base64 に変換（FileReader.readAsDataURL の prefix を剥がす）
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result !== 'string') {
          reject(new Error('FileReader returned non-string result'))
          return
        }
        const idx = result.indexOf(',')
        resolve(idx >= 0 ? result.slice(idx + 1) : result)
      }
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.readAsDataURL(file)
    })
  }

  // ファイルアップロード（Worker は JSON + base64 を受け取る）
  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const base64 = await fileToBase64(file)
        await api.uploadAsset(projectName, selectedType, file.name, base64, DEFAULT_BRANCH, {
          message: `upload ${file.name}`,
        })
      }
      // アップロード成功後、一覧を再取得
      await fetchAssets()
    } catch (error) {
      console.error('Failed to upload files:', error)
    } finally {
      setUploading(false)
    }
  }

  // PR #120 review S1: 削除・タグ管理は Worker 側に DELETE / tag エンドポイントが
  //   無いので、ボタンを disabled にして「ローカルだけ消えてサーバには残る」詐欺 UI を
  //   防ぐ。実装は #108 以降。確認ダイアログ・追加ハンドラは disabled なので
  //   実行経路に到達しないが、防御として早期 return も残す。
  const DISABLED_DELETE_HINT = '削除は #108 以降で実装予定です'
  const DISABLED_TAG_HINT = 'タグ管理は #108 以降で実装予定です'

  // ファイル削除の確認ダイアログを表示（現状 disabled なので呼ばれない想定）
  const handleDeleteClick = (asset: Asset) => {
    setDeletingAsset(asset)
  }

  // 削除実行（disabled で UI 上到達しないが、保険として no-op）
  const handleDeleteConfirm = async () => {
    if (!deletingAsset) return
    // disabled UI なので通常はここに来ない。万一来てもサーバを触らないだけにする。
    console.warn('[AssetsScreen] delete is disabled until #108; ignoring', deletingAsset.name)
    setDeletingAsset(null)
  }

  // タグ追加（disabled で UI 上到達しない）
  const handleAddTag = async (_asset: Asset, _tagName: string) => {
    void _asset
    void _tagName
    console.warn('[AssetsScreen] tag add is disabled until #108')
  }

  // タグ削除（disabled で UI 上到達しない）
  const handleRemoveTag = async (_asset: Asset, _tagName: string) => {
    void _asset
    void _tagName
    console.warn('[AssetsScreen] tag remove is disabled until #108')
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
      <header
        className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
      >
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1
              className={`text-lg font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}
            >
              <span>Name × Name</span>
              <span className={isDark ? 'text-gray-500' : 'text-gray-400'}>-</span>
              <button
                onClick={onBack}
                className={`transition-colors hover:underline ${isDark ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-900'}`}
              >
                {projectName}
              </button>
              <span className={isDark ? 'text-gray-500' : 'text-gray-400'}>-</span>
              <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>アセット管理</span>
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* タブ */}
        <div
          className={`flex items-center border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
        >
          <div className="flex flex-1">
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
          <button
            onClick={onBack}
            className={`px-4 py-3 transition-colors ${
              isDark ? 'text-gray-400 hover:text-gray-300' : 'text-gray-600 hover:text-gray-900'
            }`}
            title="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden flex">
        {/* アセット一覧 */}
        <div
          className={`w-96 border-r ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'} flex flex-col`}
        >
          {/* 検索・フィルター領域 */}
          <div className={`p-4 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="relative">
              <svg
                className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                placeholder="検索..."
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                className={`w-full pl-10 pr-3 py-2 rounded border ${
                  isDark
                    ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400'
                    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500'
                }`}
              />
            </div>
            {/* タグフィルター */}
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                    className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                      selectedTag === tag
                        ? 'bg-blue-500 text-white'
                        : isDark
                          ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* アセット一覧（スクロール可能） */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto"></div>
              </div>
            ) : (
              <div className="space-y-2">
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
                    <div className="flex items-center gap-3">
                      {/* サムネイル（画像のみ） */}
                      {selectedType === 'images' && (
                        <img
                          src={asset.url}
                          alt={asset.name}
                          className="w-12 h-12 object-cover rounded flex-shrink-0"
                        />
                      )}

                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-sm font-medium truncate ${isDark ? 'text-gray-200' : 'text-gray-900'}`}
                        >
                          {asset.name}
                        </div>
                        <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                          {formatFileSize(asset.size)}
                        </div>
                        {asset.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {asset.tags.map((tag) => (
                              <span
                                key={tag}
                                className={`px-1.5 py-0 text-[10px] rounded-full ${
                                  isDark ? 'bg-gray-600 text-gray-300' : 'bg-gray-200 text-gray-600'
                                }`}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteClick(asset)
                        }}
                        disabled
                        aria-label={DISABLED_DELETE_HINT}
                        className={`p-1 rounded transition-colors flex-shrink-0 cursor-not-allowed opacity-40 ${
                          isDark ? 'text-gray-400' : 'text-gray-500'
                        }`}
                        title={DISABLED_DELETE_HINT}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
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

          {/* アップロード領域（一番下） */}
          <div className={`p-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
            <label
              className={`block w-full px-4 py-6 text-center rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
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
                className={`w-6 h-6 mx-auto mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
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
                {uploading ? 'アップロード中...' : 'ファイルを追加'}
              </span>
            </label>
          </div>
        </div>

        {/* プレビューエリア */}
        <div className="flex-1 overflow-y-auto">
          {selectedAsset ? (
            <div className="p-8">
              <h2
                className={`text-xl font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}
              >
                {selectedAsset.name}
              </h2>

              {selectedType === 'images' && (
                <div className="flex justify-center">
                  <img
                    src={selectedAsset.url}
                    alt={selectedAsset.name}
                    className="max-w-full max-h-[600px] rounded-lg shadow-lg"
                  />
                </div>
              )}

              {selectedType === 'sounds' && (
                <div className="flex justify-center">
                  <audio controls className="w-full max-w-md">
                    <source src={selectedAsset.url} />
                    お使いのブラウザは音声の再生に対応していません。
                  </audio>
                </div>
              )}

              {selectedType === 'movies' && (
                <div className="flex justify-center">
                  <video controls className="max-w-full max-h-[600px] rounded-lg shadow-lg">
                    <source src={selectedAsset.url} />
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
                    src={selectedAsset.url}
                    className="w-full min-h-[600px] border-none"
                    title={selectedAsset.name}
                  />
                </div>
              )}

              {/* タグ管理 */}
              <div className={`mt-6 p-4 rounded-lg ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
                <h3
                  className={`text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
                >
                  タグ
                </h3>
                <div className="flex flex-wrap gap-1 mb-2">
                  {selectedAsset.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${
                        isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                      }`}
                    >
                      {tag}
                      <button
                        onClick={() => handleRemoveTag(selectedAsset, tag)}
                        disabled
                        aria-label={DISABLED_TAG_HINT}
                        title={DISABLED_TAG_HINT}
                        className={`cursor-not-allowed opacity-40 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={DISABLED_TAG_HINT}
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    disabled
                    aria-label={DISABLED_TAG_HINT}
                    title={DISABLED_TAG_HINT}
                    className={`flex-1 px-3 py-1.5 text-sm rounded border cursor-not-allowed opacity-50 ${
                      isDark
                        ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400'
                        : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500'
                    }`}
                  />
                  <button
                    onClick={() => {
                      if (newTagInput.trim()) handleAddTag(selectedAsset, newTagInput)
                    }}
                    disabled
                    aria-label={DISABLED_TAG_HINT}
                    title={DISABLED_TAG_HINT}
                    className={`px-3 py-1.5 text-sm rounded transition-colors cursor-not-allowed opacity-50 ${
                      isDark ? 'bg-blue-600 text-white' : 'bg-blue-500 text-white'
                    }`}
                  >
                    追加
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className={`text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {selectedType === 'images' && (
                  <svg
                    className="w-16 h-16 mx-auto mb-4 opacity-50"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                )}
                {selectedType === 'sounds' && (
                  <svg
                    className="w-16 h-16 mx-auto mb-4 opacity-50"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                    />
                  </svg>
                )}
                {selectedType === 'movies' && (
                  <svg
                    className="w-16 h-16 mx-auto mb-4 opacity-50"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
                    />
                  </svg>
                )}
                {selectedType === 'ideas' && (
                  <svg
                    className="w-16 h-16 mx-auto mb-4 opacity-50"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                )}
                <p>アセットを選択してプレビュー</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 削除確認ダイアログ */}
      {deletingAsset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
          <div
            className={`p-6 rounded-lg shadow-xl max-w-md w-full ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
          >
            <h2 className="text-xl font-bold mb-4">削除の確認</h2>
            <p className={`mb-6 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              <span className="font-semibold">{deletingAsset.name}</span> を削除しますか？
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeletingAsset(null)}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                キャンセル
              </button>
              <button
                onClick={handleDeleteConfirm}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-red-500 hover:bg-red-600 text-white'
                }`}
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 変更を破棄の確認ダイアログ */}
      {showDiscardConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
          <div
            className={`p-6 rounded-lg shadow-xl max-w-md w-full ${
              isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'
            }`}
          >
            <h2 className="text-xl font-bold mb-4">変更を破棄しますか？</h2>
            <p className={`mb-6 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              未コミットの変更がすべて失われます。この操作は取り消せません。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDiscardConfirm(false)}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                キャンセル
              </button>
              <button
                onClick={handleDiscard}
                className={`px-4 py-2 rounded font-medium transition-colors ${
                  isDark
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-red-500 hover:bg-red-600 text-white'
                }`}
              >
                破棄
              </button>
            </div>
          </div>
        </div>
      )}

      {/* セーブ/アンドゥボタン */}
      <SaveDiscardButtons
        hasUnsavedChanges={hasUnsavedChanges}
        isSaving={isSaving}
        isDark={isDark}
        onSave={handleSave}
        onDiscard={() => setShowDiscardConfirm(true)}
      />
    </div>
  )
}

export default AssetsScreen
