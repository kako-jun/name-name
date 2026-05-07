import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createApiClient, type ProjectInfo } from '../api/client'

// kako-jun/name-name#109: トップページ（ジャンプ風メニュー）。
//
// 位置づけ:
//   - name-name は「ハード」、各ゲームリポは「ソフト（カートリッジ）」。
//     このトップ画面は「ハードを起動したときのゲーム選択画面」に相当する。
//   - タイル状にゲームを並べ、選択 → /play/:projectName。
//   - ログイン中（dev_auth_token あり）なら各タイルに「編集」ボタンを出して
//     /edit/:projectName へも飛ばせる。
//
// 設計メモ:
//   - キーボード操作（矢印キー / Enter）に対応。アクセシビリティのため各タイルは
//     `role="button"` + tabIndex で focus 可能にしてある。
//   - サウンドは Web Audio API ベースの薄いラッパで「ファイルが無くても動く」を
//     最優先にしている。BGM / SE のファイルパスは props や props 由来ではなく、
//     後で /assets/ 配下に置けば自然に鳴る形（暫定）。
//   - 過度なアニメーションは避け、Tailwind トークン + transition だけで済ませる。
//   - 「キャッチコピー」と「サムネ」は別 Issue (#110+) でリポ毎に用意する想定。
//     今は repo 名・gradation 枠で代替。

interface JumpTopScreenProps {
  apiBaseUrl: string
  isDark: boolean
  onToggleDark: () => void
  onOpenSettings: () => void
  /** ゲーム選択時の遷移ハンドラ（/play/:projectName） */
  onPlayProject: (projectName: string) => void
  /** 編集モード遷移ハンドラ（/edit/:projectName）。ログイン時のみ呼ばれる */
  onEditProject: (projectName: string) => void
  /** 管理画面（/admin = 旧 ProjectListScreen）への遷移 */
  onOpenAdmin: () => void
  /**
   * テスト・SSR から差し替え可能なログイン判定。本番では既定の
   * `defaultIsEditor` （localStorage の dev_auth_token を見る）を使う。
   * #110 で本実装の認証フローに置き換える前提。
   */
  isEditor?: () => boolean
}

/**
 * 既定のログイン判定。`dev_auth_token` が localStorage にあれば編集者扱い。
 * `apiClient.authHeaders()` と一致する判定にしている（同じキーを参照）。
 * #110 で本番認証に置き換える際はこの関数だけ差し替える。
 */
function defaultIsEditor(): boolean {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem('dev_auth_token')
  } catch {
    return false
  }
}

/**
 * ハードロゴの色を repo 名から決める雑なハッシュ。サムネ画像が無い間の
 * 視覚的な区別用なので、可逆性も衝突回避も求めない。
 */
function gradientFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  const hue1 = h % 360
  const hue2 = (hue1 + 60) % 360
  return `linear-gradient(135deg, hsl(${hue1}, 70%, 55%), hsl(${hue2}, 70%, 45%))`
}

/**
 * 選択 SE。Web Audio で短いサイン波を鳴らすだけ。サウンドファイルが
 * 無くても動かしたいので、外部 mp3/ogg は読み込まない。AudioContext が
 * 使えない（SSR / 古い jsdom）環境では何もしない。
 *
 * BGM は仕様上「常駐」だが、無音 BGM はユーザーストレスになりやすいので
 * 自動再生はせず、ユーザーが最初の操作（キー / クリック）をしたときに
 * 一度だけ薄い和音を鳴らす形にしてある。本格 BGM は別 Issue で差し替え。
 */
function createSoundController(): {
  playSelect: () => void
  playConfirm: () => void
  resumeOnUserGesture: () => void
} {
  let ctx: AudioContext | null = null
  let bgmStarted = false

  function ensureCtx(): AudioContext | null {
    if (ctx) return ctx
    try {
      const Ctor =
        typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined
      if (!Ctor) return null
      ctx = new Ctor()
      return ctx
    } catch (e) {
      // AudioContext が使えない環境（SSR / 古い jsdom）。サイレントに諦める。
      console.warn('[JumpTopScreen] AudioContext unavailable; sound disabled', e)
      return null
    }
  }

  function tone(freq: number, durationMs: number, volume = 0.05): void {
    const c = ensureCtx()
    if (!c) return
    try {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.frequency.value = freq
      osc.type = 'sine'
      gain.gain.setValueAtTime(volume, c.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + durationMs / 1000)
      osc.connect(gain).connect(c.destination)
      osc.start()
      osc.stop(c.currentTime + durationMs / 1000)
    } catch (e) {
      console.warn('[JumpTopScreen] tone failed', e)
    }
  }

  return {
    playSelect: () => tone(660, 60),
    playConfirm: () => tone(880, 120, 0.07),
    resumeOnUserGesture: () => {
      const c = ensureCtx()
      if (!c) return
      if (c.state === 'suspended') {
        c.resume().catch(() => {})
      }
      if (!bgmStarted) {
        // ごく薄い「起動音」。常駐 BGM のスタブ。
        bgmStarted = true
        tone(523.25, 200, 0.04)
        setTimeout(() => tone(659.25, 200, 0.04), 80)
      }
    },
  }
}

function JumpTopScreen({
  apiBaseUrl,
  isDark,
  onToggleDark,
  onOpenSettings,
  onPlayProject,
  onEditProject,
  onOpenAdmin,
  isEditor = defaultIsEditor,
}: JumpTopScreenProps) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const editor = useMemo(() => isEditor(), [isEditor])
  const tileRefs = useRef<Array<HTMLDivElement | null>>([])
  const sound = useMemo(() => createSoundController(), [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const list = await api.listProjects()
        if (cancelled) return
        setProjects(list)
      } catch (e) {
        if (cancelled) return
        console.error('[JumpTopScreen] listProjects failed', e)
        setError('ゲーム一覧の取得に失敗しました')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [api])

  const handleSelect = useCallback(
    (index: number) => {
      const p = projects[index]
      if (!p) return
      sound.playConfirm()
      onPlayProject(p.name)
    },
    [projects, onPlayProject, sound]
  )

  const handleEdit = useCallback(
    (e: React.MouseEvent, projectName: string) => {
      e.stopPropagation()
      sound.playConfirm()
      onEditProject(projectName)
    },
    [onEditProject, sound]
  )

  const focusTile = useCallback((index: number) => {
    const el = tileRefs.current[index]
    if (el) el.focus()
  }, [])

  const moveBy = useCallback(
    (delta: number) => {
      if (projects.length === 0) return
      setActiveIndex((prev) => {
        const next = (prev + delta + projects.length) % projects.length
        sound.playSelect()
        // 次フレームで focus（state 更新後の DOM を待つ）
        setTimeout(() => focusTile(next), 0)
        return next
      })
    },
    [projects.length, sound, focusTile]
  )

  // 矢印キー / Enter のグローバルハンドラ。タイル個別の onKeyDown でも拾うが、
  // フォーカスがロゴ等にあるときも動かしたいので window で拾う。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (projects.length === 0) return
      // フォーム要素の中ではキー操作を奪わない
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        moveBy(1)
        sound.resumeOnUserGesture()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveBy(-1)
        sound.resumeOnUserGesture()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        sound.resumeOnUserGesture()
        handleSelect(activeIndex)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projects.length, moveBy, handleSelect, activeIndex, sound])

  return (
    <div
      className={`flex flex-col min-h-screen ${
        isDark
          ? 'dark bg-gradient-to-br from-gray-900 via-gray-950 to-black text-white'
          : 'bg-gradient-to-br from-blue-50 via-white to-purple-50 text-gray-900'
      }`}
      onMouseDown={() => sound.resumeOnUserGesture()}
    >
      <header
        className={`border-b ${
          isDark ? 'border-gray-800 bg-black/40' : 'border-blue-200 bg-white/60'
        } backdrop-blur`}
      >
        <div className="px-6 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-tight truncate">Name × Name</h1>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'} truncate`}>
              kako-jun のゲームを選んで遊ぼう
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenAdmin}
              className={`px-3 h-10 rounded transition-colors text-sm ${
                isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-700 hover:bg-gray-100'
              }`}
              title="管理画面"
            >
              管理
            </button>
            <button
              type="button"
              onClick={onToggleDark}
              className={`w-10 h-10 flex items-center justify-center rounded transition-colors ${
                isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
              }`}
              title={isDark ? 'Light Mode' : 'Dark Mode'}
              aria-label={isDark ? 'Light Mode' : 'Dark Mode'}
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
              type="button"
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
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-8" role="main" aria-label="ゲーム選択">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
              <p>読み込み中...</p>
            </div>
          </div>
        ) : error ? (
          <div role="alert" className="max-w-xl mx-auto text-center py-12">
            <p className={`text-lg font-semibold ${isDark ? 'text-red-300' : 'text-red-600'}`}>
              {error}
            </p>
            <p className={`text-sm mt-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              API URL を確認してください（設定 → API URL）
            </p>
          </div>
        ) : projects.length === 0 ? (
          <div className={`text-center py-12 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <p>ゲームがまだありません</p>
            <p className="text-sm mt-2">「管理」からプロジェクトを追加してください</p>
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="ゲーム一覧"
            aria-activedescendant={`tile-${projects[activeIndex]?.name ?? ''}`}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 max-w-7xl mx-auto"
          >
            {projects.map((project, index) => {
              const isActive = index === activeIndex
              const tileId = `tile-${project.name}`
              return (
                <div
                  key={project.name}
                  id={tileId}
                  ref={(el) => {
                    tileRefs.current[index] = el
                  }}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={0}
                  onClick={() => {
                    sound.resumeOnUserGesture()
                    setActiveIndex(index)
                    handleSelect(index)
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      sound.resumeOnUserGesture()
                      handleSelect(index)
                    }
                  }}
                  className={`group relative rounded-xl overflow-hidden cursor-pointer transition-all duration-150 outline-none ${
                    isActive
                      ? 'ring-2 ring-offset-2 ring-blue-500 scale-[1.02] shadow-2xl'
                      : 'shadow-md hover:shadow-xl'
                  } ${isDark ? 'bg-gray-800 ring-offset-gray-900' : 'bg-white ring-offset-white'}`}
                  data-testid="game-tile"
                  data-project={project.name}
                >
                  {/* サムネ枠（暫定: gradation のみ）。#110+ で cover 画像に差し替え */}
                  <div
                    className="aspect-[16/9] w-full"
                    style={{ background: gradientFor(project.name) }}
                    aria-hidden
                  >
                    <div className="w-full h-full flex items-center justify-center">
                      <span
                        className="text-white text-4xl font-black drop-shadow-lg select-none"
                        style={{ letterSpacing: '0.05em' }}
                      >
                        {(project.title || project.name).slice(0, 1).toUpperCase()}
                      </span>
                    </div>
                  </div>

                  <div className="p-4">
                    <h2
                      className={`text-lg font-bold truncate ${
                        isDark ? 'text-white' : 'text-gray-900'
                      }`}
                    >
                      {project.title || project.name}
                    </h2>
                    {/* キャッチコピー（暫定: repo 名）。#110+ で短いキャッチに差し替え */}
                    <p
                      className={`text-xs truncate mt-1 ${
                        isDark ? 'text-gray-400' : 'text-gray-500'
                      }`}
                    >
                      {project.repo}
                    </p>

                    {editor && (
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          onClick={(e) => handleEdit(e, project.name)}
                          className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                            isDark
                              ? 'bg-purple-600 hover:bg-purple-700 text-white'
                              : 'bg-purple-500 hover:bg-purple-600 text-white'
                          }`}
                          aria-label={`${project.title || project.name} を編集`}
                        >
                          編集
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>

      <footer
        className={`px-6 py-3 text-center text-xs border-t ${
          isDark ? 'border-gray-800 text-gray-500' : 'border-gray-200 text-gray-500'
        }`}
      >
        ↑↓←→ で選択 / Enter で決定
      </footer>
    </div>
  )
}

export default JumpTopScreen
