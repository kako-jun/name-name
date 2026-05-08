import { useEffect, useMemo, useState } from 'react'
import NovelPlayer from '../components/NovelPlayer'
import RPGPlayer from '../components/RPGPlayer'
import type { Event, EventDocument } from '../types'
import type { RPGProject } from '../types/rpg'
import { parseMarkdown } from '../wasm/parser'
import { findRpgSceneIndex, rpgProjectFromDoc } from '../game/rpgProjectFromDoc'
import { ApiError, createApiClient, type ProjectInfo } from '../api/client'

// kako-jun/name-name#108: 一般ユーザー向けの再生専用画面。
//   - 編集 UI / 保存 / アセット管理 / デバッグは一切表示しない
//   - chapters/all.md は **main ブランチ**を参照する
//     （ADR #105: 一般ユーザーは未完成原稿（develop）を見ない）
//   - 戻るボタンとタイトル表示のみのシンプルなヘッダー
//   - データ取得失敗時は「ゲームデータが見つかりません」を表示
const CHAPTERS_PATH = 'chapters/all.md'
const PUBLIC_BRANCH = 'main'

interface PlayerScreenProps {
  projectName: string
  apiBaseUrl: string
  isDark: boolean
  onBack: () => void
}

/**
 * EventDocument を NovelPlayer 用のフラット Event[] に変換する。
 * EditorScreen の同名関数と同じ整形（最初のシーン以外の前に SceneTransition を挟む）。
 * #108 の本格統合時に共通化予定。
 */
function flattenDocumentEvents(doc: EventDocument): Event[] {
  const events: Event[] = []
  let first = true
  for (const chapter of doc.chapters) {
    for (const scene of chapter.scenes) {
      if (!first) {
        events.push('SceneTransition')
      }
      first = false
      events.push(...scene.events)
    }
  }
  return events
}

function PlayerScreen({ projectName, apiBaseUrl, isDark, onBack }: PlayerScreenProps) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  const [doc, setDoc] = useState<EventDocument | null>(null)
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // chapters/all.md がまだリポに無い「未投入」状態。エラーではなく案内として扱う。
  const [unpopulated, setUnpopulated] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      setUnpopulated(false)
      try {
        // 1. プロジェクト情報を取得（タイトル表示・assets ベース URL 解決用）
        const projects = await api.listProjects()
        const found = projects.find((p) => p.name === projectName) ?? null
        if (cancelled) return
        setProjectInfo(found)

        // 2. main ブランチから章データを取得。404 はリポにまだ chapters/all.md
        //    が無い「未投入」状態として扱い、エラーではなく案内表示にする。
        let data
        try {
          data = await api.getContents(projectName, CHAPTERS_PATH, PUBLIC_BRANCH)
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            if (!cancelled) {
              setUnpopulated(true)
              setDoc(null)
            }
            return
          }
          throw e
        }
        if (cancelled) return
        const markdown = data.content || ''

        // 3. WASM で Markdown → EventDocument
        const parsed = await parseMarkdown(markdown)
        if (cancelled) return
        setDoc(parsed)
      } catch (e) {
        console.error('PlayerScreen: failed to load project:', e)
        if (!cancelled) {
          setError('ゲームデータの読み込みに失敗しました')
          setDoc(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [api, projectName])

  // 再生用のフラット Event[]
  const novelEvents = useMemo(() => (doc ? flattenDocumentEvents(doc) : []), [doc])

  // RPG シーン（最初の RPG シーンのみ採用 — 編集と違いプレイヤーは選択 UI を出さない）
  const rpgProject: RPGProject | null = useMemo(() => {
    if (!doc) return null
    const found = findRpgSceneIndex(doc)
    if (!found) return null
    const sceneId = doc.chapters[found.chapterIndex]?.scenes[found.sceneIndex]?.id ?? undefined
    return rpgProjectFromDoc(doc, sceneId, projectName)
  }, [doc, projectName])

  // assets のベース URL は main ブランチを参照（#108 で download_url ベースに統一予定）
  const assetBaseUrl = projectInfo
    ? `https://raw.githubusercontent.com/${projectInfo.repo}/${PUBLIC_BRANCH}/assets`
    : `https://raw.githubusercontent.com/kako-jun/${projectName}/${PUBLIC_BRANCH}/assets`

  const title = projectInfo?.title || projectName

  return (
    <div className={`flex flex-col h-screen ${isDark ? 'dark bg-gray-900' : 'bg-white'}`}>
      <header
        className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
      >
        <div className="px-6 py-2 flex items-center gap-3">
          <button
            onClick={onBack}
            aria-label="プロジェクト一覧に戻る"
            className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
              isDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
            }`}
            title="プロジェクト一覧に戻る"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <h1 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {title}
          </h1>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {loading ? (
          <div
            className={`flex items-center justify-center h-full ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
          >
            読み込み中...
          </div>
        ) : error !== null ? (
          <div
            className={`flex items-center justify-center h-full ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
          >
            <p role="alert">{error}</p>
          </div>
        ) : unpopulated ? (
          <div
            className={`flex flex-col items-center justify-center h-full gap-2 px-6 text-center ${
              isDark ? 'text-gray-300' : 'text-gray-700'
            }`}
          >
            <p className="text-lg font-semibold">{title} はまだ準備中です</p>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              シナリオ（chapters/all.md）が公開されると、ここで再生できるようになります。
            </p>
          </div>
        ) : rpgProject !== null ? (
          // RPG シーンを含むプロジェクトは RPGPlayer を優先する。
          // ノベル+RPG の遷移制御は #108 本統合で扱う。
          <RPGPlayer gameData={rpgProject} view={rpgProject.view} />
        ) : (
          <NovelPlayer
            events={novelEvents}
            assetBaseUrl={assetBaseUrl}
            aspectRatio={doc?.aspect_ratio}
            docKey={projectName}
          />
        )}
      </main>
    </div>
  )
}

export default PlayerScreen
