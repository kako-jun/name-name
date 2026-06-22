import { useEffect, useMemo, useState } from 'react'
import NovelPlayer from '../components/NovelPlayer'
import RPGPlayer from '../components/RPGPlayer'
import TitleOverlay from '../components/TitleOverlay'
import type { Event, EventDocument, EventScene } from '../types'
import type { RPGProject } from '../types/rpg'
import { parseMarkdown } from '../wasm/parser'
import { findRpgSceneIndex, rpgProjectFromDoc } from '../game/rpgProjectFromDoc'
import { ApiError, createApiClient, type ProjectInfo } from '../api/client'
import { loadReadProgress, clearReadProgress } from '../game/readProgress'

// kako-jun/name-name#108: 一般ユーザー向けの再生専用画面。
//   - 編集 UI / 保存 / アセット管理 / デバッグは一切表示しない
//   - script.md は **main ブランチ**を参照する
//     （ADR #105: 一般ユーザーは未完成原稿（develop）を見ない）
//   - 戻るボタンとタイトル表示のみのシンプルなヘッダー
//   - データ取得失敗時は「ゲームデータが見つかりません」を表示
const SCRIPT_PATH = 'script.md'
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
 *
 * #284: scenes 経路（setScenes）に乗せたあとは未使用になるが、scenes が 1 件も
 * 取れない退化ケースのフォールバックとして残す。
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

/**
 * EventDocument の全章の全シーンを 1 本の EventScene[] にフラット化する (#284)。
 * 章境界は捨てる（シーンジャンプは sceneId だけで解決されるため章の概念は不要）。
 */
function flattenDocumentScenes(doc: EventDocument): EventScene[] {
  const scenes: EventScene[] = []
  for (const chapter of doc.chapters) {
    for (const scene of chapter.scenes) {
      scenes.push(scene)
    }
  }
  return scenes
}

/**
 * 連結後のシーン ID 重複を検出して警告する (#284)。
 * シーン ID は全 MD でグローバル一意が前提。`findSceneById` は先勝ち
 * （novelLayout.ts）なので、重複があると後ろの同 ID シーンに到達できなくなる。
 * 挙動は壊さない（先勝ちのまま）が、原稿側のミスに気づけるよう warning を出す。
 */
function warnDuplicateSceneIds(scenes: EventScene[]): void {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const s of scenes) {
    if (seen.has(s.id)) dups.add(s.id)
    else seen.add(s.id)
  }
  if (dups.size > 0) {
    console.warn(
      `[name-name] シーン ID が複数 MD で重複しています（先勝ちで解決。後ろの同 ID シーンには到達できません）: ${Array.from(
        dups
      ).join(', ')}`
    )
  }
}

function PlayerScreen({ projectName, apiBaseUrl, isDark, onBack }: PlayerScreenProps) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  // doc: エントリ script.md のドキュメント。RPG 判定・aspect_ratio 等の
  // per-game 設定の供給元として使う（これらは作品単位の設定なのでエントリに従う）。
  const [doc, setDoc] = useState<EventDocument | null>(null)
  // allScenes: 全 .md（エントリ + 各シナリオ）の全シーンを連結したもの (#284)。
  // NovelPlayer に scenes= で渡すと NovelRenderer.allScenes が埋まり、
  // クロスファイルのシーンジャンプ（→ シーンID）が解決する。
  const [allScenes, setAllScenes] = useState<EventScene[]>([])
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // script.md がまだリポに無い「未投入」状態。エラーではなく案内として扱う。
  const [unpopulated, setUnpopulated] = useState(false)

  // タイトル画面の表示状態 (#141)
  const [titleDismissed, setTitleDismissed] = useState(false)
  // 「つづきから」で開始した場合 true: ゲーム開始直後にスキップモードで未読位置まで進める
  const [startWithSkip, setStartWithSkip] = useState(false)

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

        // external_url が設定されているプロジェクトはゲームサイトに直接リダイレクト
        // （PlayerScreen はノベル/RPG 専用。外部ゲームはここを経由しない）
        if (found?.external_url) {
          window.location.replace(found.external_url)
          return
        }

        // 2. main ブランチからシナリオを取得。404 はリポにまだ script.md
        //    が無い「未投入」状態として扱い、エラーではなく案内表示にする。
        let data
        try {
          data = await api.getContents(projectName, SCRIPT_PATH, PUBLIC_BRANCH)
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

        // 3. WASM で Markdown → EventDocument（エントリ）
        const entryDoc = await parseMarkdown(markdown)
        if (cancelled) return
        setDoc(entryDoc)

        // 4. マルチ MD ロード (#284)
        //    listScripts で全 .md を列挙し、script.md 以外＝各シナリオ MD を
        //    並列取得 → parse → 全シーンを 1 本に連結する。
        //    連結順はエントリ script.md のシーンを先頭にする（先頭シーン＝開始シーン）。
        //
        //    listScripts が無い / 失敗するケース（単一 script のプロジェクト・
        //    旧 Worker・テストのスタブ等）では従来どおりエントリ 1 本だけで再生する。
        let extraDocs: EventDocument[] = []
        try {
          const scripts = await api.listScripts(projectName, PUBLIC_BRANCH)
          if (cancelled) return
          const extraPaths = scripts
            // hidden は再生対象外
            .filter((s) => !s.hidden)
            // エントリ script.md は別途取得済みなので除外
            .filter((s) => s.path !== SCRIPT_PATH)
            .map((s) => s.path)

          const fetched = await Promise.all(
            extraPaths.map(async (path) => {
              try {
                const c = await api.getContents(projectName, path, PUBLIC_BRANCH)
                return await parseMarkdown(c.content || '')
              } catch (err) {
                // 個別 .md の取得・parse 失敗は全体を落とさずスキップ
                console.warn(`PlayerScreen: failed to load script ${path}:`, err)
                return null
              }
            })
          )
          if (cancelled) return
          extraDocs = fetched.filter((d): d is EventDocument => d !== null)
        } catch (err) {
          // listScripts 自体が使えない/失敗 → 単一 script フォールバック
          console.warn('PlayerScreen: listScripts unavailable, single-script mode:', err)
        }

        // 全シーンを連結（エントリ先頭 → 各シナリオ）。
        const scenes: EventScene[] = [
          ...flattenDocumentScenes(entryDoc),
          ...extraDocs.flatMap((d) => flattenDocumentScenes(d)),
        ]
        warnDuplicateSceneIds(scenes)
        if (cancelled) return
        setAllScenes(scenes)
      } catch (e) {
        console.error('PlayerScreen: failed to load project:', e)
        if (!cancelled) {
          setError('ゲームデータの読み込みに失敗しました')
          setDoc(null)
          setAllScenes([])
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

  // 再生用のフラット Event[]（#284: scenes= 経路に乗るので通常は未使用。
  // allScenes が空の退化ケース用のエントリ単体フォールバック）
  const novelEvents = useMemo(() => (doc ? flattenDocumentEvents(doc) : []), [doc])

  // RPG シーン（最初の RPG シーンのみ採用 — 編集と違いプレイヤーは選択 UI を出さない）
  const rpgProject: RPGProject | null = useMemo(() => {
    if (!doc) return null
    const found = findRpgSceneIndex(doc)
    if (!found) return null
    const sceneId = doc.chapters[found.chapterIndex]?.scenes[found.sceneIndex]?.id ?? undefined
    return rpgProjectFromDoc(doc, sceneId, projectName)
  }, [doc, projectName])

  // assets のベース URL は Worker proxy 経由（private repo でも動作する）
  // /api/projects/:name/assets/raw/:path で GitHub Contents API を経由して取得する
  const assetBaseUrl = `${apiBaseUrl}/api/projects/${projectName}/assets/raw`

  const title = projectInfo?.title || projectName

  // 「つづきから」ボタンの有効判定: 既読データが存在するか (#141)
  const [hasSaveData, setHasSaveData] = useState(() => loadReadProgress(projectName).size > 0)

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

      <main className="flex-1 overflow-hidden relative">
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
              シナリオ（script.md）が公開されると、ここで再生できるようになります。
            </p>
          </div>
        ) : rpgProject !== null ? (
          // RPG シーンを含むプロジェクトは RPGPlayer を優先する。
          // ノベル+RPG の遷移制御は #108 本統合で扱う。
          <RPGPlayer gameData={rpgProject} view={rpgProject.view} />
        ) : (
          <>
            <NovelPlayer
              // #284: 全 MD のシーンを scenes= で渡す（setScenes 経路）。
              // これで NovelRenderer.allScenes が全 MD 横断で埋まり、
              // クロスファイルのシーンジャンプが解決する。events= は scenes が
              // 1 件も取れなかった退化ケースのフォールバックとしてのみ効く。
              scenes={allScenes}
              events={novelEvents}
              assetBaseUrl={assetBaseUrl}
              aspectRatio={doc?.aspect_ratio}
              choiceStyle={doc?.choice_style ?? null}
              fontFamily={doc?.font_family ?? null}
              docKey={projectName}
              initialSkipMode={startWithSkip}
            />
            {/* タイトル画面オーバーレイ (#141): ゲーム開始前に表示 */}
            {!titleDismissed && (
              <TitleOverlay
                title={title}
                titleImageUrl={`${assetBaseUrl}/images/title.png`}
                hasSaveData={hasSaveData}
                isDark={isDark}
                onNewGame={() => {
                  // 新規開始: 既読データをクリアして最初から
                  clearReadProgress(projectName)
                  setHasSaveData(false)
                  setStartWithSkip(false)
                  setTitleDismissed(true)
                  // user gesture を使って AudioContext を起動する (#issue-pending)。
                  // autoMode で進行する動画モードでは handleAdvance / handleKeyDown が呼ばれず
                  // AudioContext が永久 null になるため、ここで明示的に起動する
                  // さらに scenario は TitleOverlay 表示中に既に最初の text event まで進行している
                  // ため、AudioContext 起動後に setEvents で再リセットして最初から走らせる
                  // (これをしないと冒頭の voice 付き Narration/Dialog が AudioContext null のまま
                  // 発火済みで再生されない)。
                  const renderer = (
                    window as {
                      __renderer?: {
                        audioManager?: { ensureContext?: () => void }
                        restart?: () => void
                      }
                    }
                  ).__renderer
                  renderer?.audioManager?.ensureContext?.()
                  renderer?.restart?.()
                }}
                onContinue={() => {
                  // つづきから: スキップモードで未読位置まで高速進行
                  setStartWithSkip(true)
                  setTitleDismissed(true)
                  // さらに scenario は TitleOverlay 表示中に既に最初の text event まで進行している
                  // ため、AudioContext 起動後に setEvents で再リセットして最初から走らせる
                  // (これをしないと冒頭の voice 付き Narration/Dialog が AudioContext null のまま
                  // 発火済みで再生されない)。
                  const renderer = (
                    window as {
                      __renderer?: {
                        audioManager?: { ensureContext?: () => void }
                        restart?: () => void
                      }
                    }
                  ).__renderer
                  renderer?.audioManager?.ensureContext?.()
                  renderer?.restart?.()
                }}
                onOpenSettings={() => {
                  // TODO (#141): NovelPlayer の設定パネルを外部から開く ref を追加して
                  // タイトル画面の「設定」ボタンからダイレクトに設定を開けるようにする。
                  // 現時点ではタイトルを閉じてゲーム内の設定ボタン（⚙）から開く。
                  setTitleDismissed(true)
                }}
                onBack={onBack}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default PlayerScreen
