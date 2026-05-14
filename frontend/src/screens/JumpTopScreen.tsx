import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createApiClient, type ProjectInfo } from '../api/client'

interface JumpTopScreenProps {
  apiBaseUrl: string
  isDark: boolean
  onToggleDark: () => void
  onOpenSettings: () => void
  onPlayProject: (projectName: string) => void
  onEditProject: (projectName: string) => void
  onOpenAdmin: () => void
  isEditor?: () => boolean
}

function defaultIsEditor(): boolean {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem('dev_auth_token')
  } catch {
    return false
  }
}

function gradientFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  const hue1 = h % 360
  const hue2 = (hue1 + 42) % 360
  const hue3 = (hue1 + 320) % 360
  return `linear-gradient(135deg, hsl(${hue1}, 92%, 58%), hsl(${hue2}, 88%, 52%) 52%, hsl(${hue3}, 84%, 44%))`
}

function formatFakeCount(base: number): string {
  return new Intl.NumberFormat('en-US').format(base)
}

function buildFakeStats(index: number): { views: string; comments: string } {
  const viewBase = Math.max(1, 752_773 - index * 92_441)
  const commentBase = Math.max(1, 1_672 - index * 184)
  return {
    views: formatFakeCount(viewBase),
    comments: formatFakeCount(commentBase),
  }
}

function shouldIgnoreGlobalKeydown(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.closest('[data-testid="game-tile"]')) return false
  return !!el.closest('button, a, input, textarea, select, summary, [contenteditable="true"]')
}

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
      osc.type = 'square'
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
    playSelect: () => tone(660, 55, 0.045),
    playConfirm: () => tone(880, 110, 0.06),
    resumeOnUserGesture: () => {
      const c = ensureCtx()
      if (!c) return
      if (c.state === 'suspended') {
        c.resume().catch(() => {})
      }
      if (!bgmStarted) {
        bgmStarted = true
        tone(523.25, 170, 0.035)
        setTimeout(() => tone(659.25, 170, 0.035), 90)
      }
    },
  }
}

function EyeIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.4 12C4.6 7.8 8 5.7 12 5.7s7.4 2.1 9.6 6.3C19.4 16.2 16 18.3 12 18.3S4.6 16.2 2.4 12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function CommentIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 6.5h14v9H9l-4 3v-12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FooterIcon({ type }: { type: 'home' | 'ticket' | 'search' | 'hat' | 'user' }) {
  if (type === 'home') {
    return (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4 11.5 12 5l8 6.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.5 10.5V19h11v-8.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (type === 'ticket') {
    return (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M5 8.5h14v7H5v-7Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M9 8.5v7" stroke="currentColor" strokeWidth="2" strokeDasharray="1.8 1.8" />
        <path d="M12 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (type === 'search') {
    return (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="10.5" cy="10.5" r="5.5" stroke="currentColor" strokeWidth="2" />
        <path d="m15 15 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (type === 'hat') {
    return (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4 12c2.5-1.7 5.2-2.6 8-2.6s5.5.9 8 2.6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M7 13.8c1 2 2.8 3.2 5 3.2s4-.9 5-3.2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M9.2 8.7 12 6l2.8 2.7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5.5 19c1.7-2.8 4-4.2 6.5-4.2s4.8 1.4 6.5 4.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
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
  const tileRefs = useRef<Array<HTMLElement | null>>([])
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
        return next
      })
    },
    [projects.length, sound]
  )

  useEffect(() => {
    if (projects.length === 0) return
    focusTile(activeIndex)
  }, [activeIndex, projects.length, focusTile])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (projects.length === 0) return
      if (shouldIgnoreGlobalKeydown(e.target)) return
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

  const rankingProjects = projects.map((project, index) => ({
    project,
    index,
    stats: buildFakeStats(index),
  }))

  const featured = rankingProjects[0] ?? null
  const rest = rankingProjects.slice(1)
  const pageBgClass = isDark ? 'bg-[#242424] text-white' : 'bg-[#f6f1e8] text-[#161616]'
  const panelBgClass = isDark ? 'bg-[#242424]' : 'bg-[#f9f4ec]'
  const sectionBgClass = isDark ? 'border-white/10 bg-[#1f1f1f]' : 'border-black/10 bg-[#2b2725]'
  const subTextClass = 'text-white/55'
  const emptyTextClass = isDark ? 'text-white/65' : 'text-[#161616]/72'
  const metaTextClass = isDark ? 'text-white/52' : 'text-[#161616]/62'
  const footerBgClass = isDark ? 'bg-white text-[#666]' : 'bg-[#161616] text-white/70'
  const footerInactiveTextClass = isDark ? 'text-[#666]' : 'text-white/70'

  return (
    <div className={`min-h-screen ${pageBgClass}`} onMouseDown={() => sound.resumeOnUserGesture()}>
      <div
        className={`mx-auto min-h-screen w-full max-w-[820px] ${panelBgClass} shadow-[0_0_0_1px_rgba(255,255,255,0.04)]`}
      >
        <header className="sticky top-0 z-30">
          <div className="bg-[#fb322f] px-4 py-4 text-white">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="leading-none">
                  <div className="text-[1.9rem] font-black tracking-[-0.08em]">ネーム＋</div>
                  <div className="text-[0.76rem] font-bold tracking-[0.18em]">連載ゲーム！</div>
                </div>
                <div className="hidden text-[2rem] font-black tracking-[-0.05em] text-[#ffe54d] sm:block">
                  初回全部遊べる
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onOpenAdmin}
                  className="rounded-full border border-white/30 bg-black/20 px-3 py-1.5 text-xs font-bold"
                  title="管理"
                >
                  管理
                </button>
                <button
                  type="button"
                  onClick={onToggleDark}
                  className="rounded-full border border-white/30 bg-black/20 px-3 py-1.5 text-xs font-bold"
                  title={isDark ? 'Light Mode' : 'Dark Mode'}
                  aria-label={isDark ? 'Light Mode' : 'Dark Mode'}
                >
                  {isDark ? 'LIGHT' : 'DARK'}
                </button>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-full border border-white/30 bg-black/20 px-3 py-1.5 text-xs font-bold"
                  title="Settings"
                  aria-label="Settings"
                >
                  設定
                </button>
              </div>
            </div>
            <div className="mt-2 text-sm font-bold text-[#ffe54d] sm:hidden">初回全部遊べる</div>
          </div>

          <div className={`border-b px-4 py-4 ${sectionBgClass}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-[2rem] font-black text-[#fb322f] shadow-[0_0_0_4px_rgba(255,255,255,0.05)]">
                  名
                </div>
                <div>
                  <div className="text-[2rem] font-black tracking-[-0.06em] leading-none text-white">
                    ネームのランキング
                  </div>
                  <div
                    className={`mt-1 text-xs font-semibold uppercase tracking-[0.18em] ${subTextClass}`}
                  >
                    Fixed Order Now / Most Played Later
                  </div>
                </div>
              </div>
              <div className={`text-5xl font-thin ${subTextClass}`}>›</div>
            </div>
          </div>
        </header>

        <main className="px-4 pb-36 pt-4" role="main" aria-label="ゲーム選択">
          {loading ? (
            <div className="flex min-h-[40vh] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-[#fb322f]" />
                <p className="text-sm font-semibold text-white/70">読み込み中...</p>
              </div>
            </div>
          ) : error ? (
            <div role="alert" className="py-16 text-center">
              <p className="text-lg font-black text-[#ff807d]">{error}</p>
              <p className="mt-2 text-sm text-white/55">設定から API URL を確認してください</p>
            </div>
          ) : projects.length === 0 ? (
            <div className={`py-16 text-center ${emptyTextClass}`}>
              <p className="text-lg font-black">ゲームがまだありません</p>
              <p className="mt-2 text-sm">「管理」からプロジェクトを追加してください</p>
            </div>
          ) : (
            <div role="grid" aria-label="ゲーム一覧" className="space-y-8">
              {featured && (
                <article
                  key={featured.project.name}
                  id="tile-0"
                  ref={(el) => {
                    tileRefs.current[0] = el
                  }}
                  role="button"
                  aria-label={`${featured.project.title || featured.project.name} をプレイ`}
                  aria-pressed={activeIndex === 0}
                  tabIndex={0}
                  onClick={() => {
                    sound.resumeOnUserGesture()
                    setActiveIndex(0)
                    handleSelect(0)
                  }}
                  onFocus={() => setActiveIndex(0)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      sound.resumeOnUserGesture()
                      handleSelect(0)
                    }
                  }}
                  className={`group block cursor-pointer outline-none ${
                    activeIndex === 0 ? 'scale-[1.01]' : ''
                  }`}
                  data-testid="game-tile"
                  data-project={featured.project.name}
                >
                  <div className="relative overflow-hidden bg-black">
                    <div className="absolute left-0 top-0 z-10 bg-[#fb322f] px-4 py-2 text-4xl font-black leading-none">
                      1
                    </div>
                    <div
                      className={`relative aspect-[16/8.2] w-full overflow-hidden border border-white/6 transition-transform duration-150 ${
                        activeIndex === 0 ? 'scale-[1.01]' : 'group-hover:scale-[1.01]'
                      }`}
                      style={{ background: gradientFor(featured.project.name) }}
                      aria-hidden
                    >
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_24%,rgba(255,255,255,0.24),transparent_22%),radial-gradient(circle_at_82%_18%,rgba(255,255,255,0.26),transparent_20%),linear-gradient(0deg,rgba(0,0,0,0.04),rgba(0,0,0,0.04))]" />
                      <div className="absolute inset-y-0 right-0 w-[32%] bg-[linear-gradient(180deg,rgba(255,255,255,0.24),rgba(0,0,0,0.12))]" />
                      <div className="absolute left-4 top-4 rounded-full bg-black px-4 py-3 text-sm font-black leading-tight tracking-[-0.04em] text-white shadow-lg">
                        人気沸騰
                        <br />
                        kako-jun の
                        <br />
                        ゲーム置き場
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.82))] p-4 pt-12">
                        <div className="inline-flex bg-[#fb322f] px-3 py-1 text-xl font-black text-white">
                          全話￥0
                        </div>
                        <div className="mt-3 text-[clamp(2.5rem,6vw,5.2rem)] font-black tracking-[-0.08em] text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.35)]">
                          {(featured.project.title || featured.project.name).toUpperCase()}
                        </div>
                        <div className="mt-1 text-sm font-semibold uppercase tracking-[0.22em] text-white/78">
                          {featured.project.repo}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 py-3">
                    <h2 className="text-[2.2rem] font-black tracking-[-0.06em] leading-none">
                      {featured.project.title || featured.project.name}
                    </h2>
                    <div className="flex items-center gap-8 text-[1.1rem] font-semibold">
                      <div className="flex items-center gap-2">
                        <EyeIcon />
                        <span>{featured.stats.views}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CommentIcon />
                        <span>{featured.stats.comments}</span>
                      </div>
                    </div>
                    {editor && (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={(e) => handleEdit(e, featured.project.name)}
                          className="rounded-full bg-white px-4 py-2 text-sm font-black text-black"
                          aria-label={`${featured.project.title || featured.project.name} を編集`}
                        >
                          編集
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              )}

              <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2">
                {rest.map(({ project, index, stats }) => {
                  // rankingProjects 側で保持した元の project index。slice(1) 後の連番ではない。
                  const rank = index + 1
                  const isActive = activeIndex === index
                  return (
                    <article
                      key={project.name}
                      id={`tile-${index}`}
                      ref={(el) => {
                        tileRefs.current[index] = el
                      }}
                      role="button"
                      aria-label={`${project.title || project.name} をプレイ`}
                      aria-pressed={isActive}
                      tabIndex={0}
                      onClick={() => {
                        sound.resumeOnUserGesture()
                        setActiveIndex(index)
                        handleSelect(index)
                      }}
                      onFocus={() => setActiveIndex(index)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          sound.resumeOnUserGesture()
                          handleSelect(index)
                        }
                      }}
                      className={`group cursor-pointer outline-none transition-transform duration-150 ${
                        isActive ? 'scale-[1.01]' : ''
                      }`}
                      data-testid="game-tile"
                      data-project={project.name}
                    >
                      <div
                        className={`relative aspect-[1/1.02] overflow-hidden border border-white/6 transition-transform duration-150 ${
                          isActive ? 'scale-[1.01]' : 'group-hover:scale-[1.01]'
                        }`}
                        style={{ background: gradientFor(project.name) }}
                        aria-hidden
                      >
                        <div className="absolute left-0 top-0 z-10 bg-[#fb322f] px-4 py-2 text-4xl font-black leading-none text-white">
                          {rank}
                        </div>
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(255,255,255,0.23),transparent_18%),linear-gradient(180deg,transparent_34%,rgba(0,0,0,0.28)_78%,rgba(0,0,0,0.58))]" />
                        <div className="absolute bottom-0 left-0 right-0 p-4">
                          <div className="inline-flex bg-[#fb322f] px-3 py-1 text-base font-black text-white">
                            全話￥0
                          </div>
                          <div className="mt-3 break-words text-[clamp(2rem,5vw,3.5rem)] font-black tracking-[-0.08em] leading-none text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.35)]">
                            {(project.title || project.name).toUpperCase()}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1 py-3">
                        <h2 className="text-[1.1rem] font-black tracking-[-0.04em]">
                          {project.title || project.name}
                        </h2>
                        <div
                          className={`text-xs font-semibold uppercase tracking-[0.15em] ${metaTextClass}`}
                        >
                          {project.repo}
                        </div>
                        <div className="flex items-center gap-6 pt-1 text-base font-semibold">
                          <div className="flex items-center gap-2">
                            <EyeIcon />
                            <span>{stats.views}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <CommentIcon />
                            <span>{stats.comments}</span>
                          </div>
                        </div>
                        {editor && (
                          <div className="pt-1">
                            <button
                              type="button"
                              onClick={(e) => handleEdit(e, project.name)}
                              className="rounded-full border border-white/18 px-3 py-1.5 text-xs font-black text-white"
                              aria-label={`${project.title || project.name} を編集`}
                            >
                              編集
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          )}
        </main>

        <footer
          className={`fixed bottom-0 left-0 right-0 z-40 border-t border-black/10 ${footerBgClass}`}
        >
          <div className="mx-auto flex max-w-[820px] items-stretch justify-between px-2 pt-2">
            {[
              { label: 'ホーム', icon: 'home', active: true },
              { label: '無料作品', icon: 'ticket', active: false },
              { label: 'さがす', icon: 'search', active: false },
              { label: '少年ネーム', icon: 'hat', active: false },
              { label: 'マイページ', icon: 'user', active: false },
            ].map((item) => (
              <div
                key={item.label}
                className="flex min-w-0 flex-1 flex-col items-center gap-1 px-1 pb-3 pt-1 text-center"
                aria-hidden="true"
              >
                <div
                  className={`flex h-16 w-16 items-center justify-center rounded-full ${
                    item.active ? 'bg-[#fb322f] text-white' : footerInactiveTextClass
                  }`}
                >
                  <FooterIcon type={item.icon as 'home' | 'ticket' | 'search' | 'hat' | 'user'} />
                </div>
                <span
                  className={`text-[0.95rem] font-black tracking-[-0.03em] ${
                    item.active ? 'text-[#fb322f]' : footerInactiveTextClass
                  }`}
                >
                  {item.label}
                </span>
              </div>
            ))}
          </div>
          <div className="mx-auto h-1.5 w-36 rounded-full bg-black/40" />
          <div className="h-2" />
        </footer>
      </div>
    </div>
  )
}

export default JumpTopScreen
