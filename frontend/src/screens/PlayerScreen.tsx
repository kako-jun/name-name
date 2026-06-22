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
//   - スクリプトは **main ブランチ**を参照する
//     （ADR #105: 一般ユーザーは未完成原稿（develop）を見ない）
//   - 戻るボタンとタイトル表示のみのシンプルなヘッダー
//   - データ取得失敗時は「ゲームデータが見つかりません」を表示
//
// #284: エントリ MD の解決規則。
//   listScripts で全 .md を列挙し、**path の basename が `script.md` のもの**を
//   エントリ（開始 MD）とする。これでハブが直下 `script.md` でも
//   `content/scripts/script.md`（theo-hayami の scriptsDir 構成）でも解決できる。
//   basename 一致が無ければ sort 済み先頭をエントリにする。
const SCRIPT_BASENAME = 'script.md'
const PUBLIC_BRANCH = 'main'

/** path（'a/b/c.md'）の basename（'c.md'）を返す。空 path は '' */
function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

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
 * #284: これがエントリ MD の **通常再生ストリーム**。全シーンを 1 本に線形連結する
 * ことで、advance() が scene1 → scene2 → … と自動進行する（多シーン作品の線形再生を
 * 維持する経路。M2 退行修正の本体）。クロスファイルのシーンジャンプ索引は別建ての
 * `flattenDocumentScenes`（jumpSceneIndex）で供給する。
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
  // doc: エントリ MD のドキュメント。通常再生ストリーム（線形 events）の供給元であり、
  // かつ RPG 判定・aspect_ratio / choice_style / font_family 等の per-game 設定の
  // 供給元でもある (#284 S1)。これらは作品単位の設定なので **エントリ MD に従う**。
  // サブ MD 側の RPG シーン・frontmatter 設定は採用しない（未対応）。
  const [doc, setDoc] = useState<EventDocument | null>(null)
  // allScenes: 全 .md（エントリ + 各シナリオ）の全シーンを連結したもの (#284)。
  // NovelPlayer に jumpSceneIndex= で渡すと NovelRenderer.allScenes が埋まり、
  // 通常再生（events= の線形ストリーム）を変えないまま、クロスファイルのシーンジャンプ
  // （→ シーンID）・セーブ復元・debug startFrom がファイル横断で解決する。
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

        // 2. main ブランチの .md を列挙して **エントリ MD を解決する** (#284 M1)。
        //    エントリ = path の basename が `script.md` のもの。無ければ sort 済み先頭。
        //    listScripts が 0 件 or 取得不能のときだけ「準備中(unpopulated)」/単一
        //    フォールバックに分岐する（直下 script.md 固定だと scriptsDir 構成の
        //    theo-hayami 等が永久に再生できない退行になるため）。
        let scripts: Awaited<ReturnType<typeof api.listScripts>> | null = null
        try {
          scripts = await api.listScripts(projectName, PUBLIC_BRANCH)
        } catch (err) {
          // listScripts 自体が使えない/失敗（旧 Worker・テストスタブ等）
          //   → 従来の単一 `script.md` 直接取得にフォールバックする。
          console.warn('PlayerScreen: listScripts unavailable, single-script mode:', err)
          scripts = null
        }
        if (cancelled) return

        // 再生対象の .md パス一覧（hidden は除外）。
        const playablePaths = (scripts ?? []).filter((s) => !s.hidden).map((s) => s.path)

        if (scripts === null) {
          // --- listScripts 不能フォールバック: 単一 script.md だけで再生 ---
          //     404 はリポにまだ script.md が無い「未投入」状態として扱う。
          let data
          try {
            data = await api.getContents(projectName, SCRIPT_BASENAME, PUBLIC_BRANCH)
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) {
              if (!cancelled) {
                setUnpopulated(true)
                setDoc(null)
                setAllScenes([])
              }
              return
            }
            throw e
          }
          if (cancelled) return
          const entryDoc = await parseMarkdown(data.content || '')
          if (cancelled) return
          setDoc(entryDoc)
          setAllScenes(flattenDocumentScenes(entryDoc))
          return
        }

        if (playablePaths.length === 0) {
          // listScripts は応答したが再生対象 .md が 0 件 → 未投入案内。
          if (!cancelled) {
            setUnpopulated(true)
            setDoc(null)
            setAllScenes([])
          }
          return
        }

        // エントリ MD を解決: basename === 'script.md' を優先、無ければ sort 済み先頭。
        const sortedPaths = [...playablePaths].sort()
        const entryPath = sortedPaths.find((p) => basename(p) === SCRIPT_BASENAME) ?? sortedPaths[0]

        // 3. 全 .md を並列取得 → parse。エントリ doc を分離して保持する。
        const docByPath = new Map<string, EventDocument>()
        await Promise.all(
          sortedPaths.map(async (path) => {
            try {
              const c = await api.getContents(projectName, path, PUBLIC_BRANCH)
              const parsed = await parseMarkdown(c.content || '')
              docByPath.set(path, parsed)
            } catch (err) {
              // 個別 .md の取得・parse 失敗は全体を落とさずスキップ。
              console.warn(`PlayerScreen: failed to load script ${path}:`, err)
            }
          })
        )
        if (cancelled) return

        const entryDoc = docByPath.get(entryPath) ?? null
        if (!entryDoc) {
          // エントリ MD だけは必須。取得・parse できなければ再生不能。
          throw new Error(`PlayerScreen: entry script not loadable: ${entryPath}`)
        }

        // 4. RPG 判定・aspect_ratio / choice_style / font_family・通常再生ストリームの
        //    供給元はエントリ doc (#284 S1)。
        setDoc(entryDoc)

        // ジャンプ解決索引 = 全 .md の全シーン。連結順は **エントリ先頭** →
        //    残りのサブ MD（sort 済み path 順）。先頭シーン＝開始シーンの整合を取る。
        const scenes: EventScene[] = [
          ...flattenDocumentScenes(entryDoc),
          ...sortedPaths
            .filter((p) => p !== entryPath)
            .flatMap((p) => {
              const d = docByPath.get(p)
              return d ? flattenDocumentScenes(d) : []
            }),
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

  // 通常再生ストリーム = エントリ doc を線形に flatten した Event[] (#284 M2)。
  // これを NovelPlayer に events= で渡すことで多シーンの線形自動進行が成立する。
  // クロスファイルのジャンプ索引は別建ての allScenes（jumpSceneIndex=）で供給する。
  const novelEvents = useMemo(() => (doc ? flattenDocumentEvents(doc) : []), [doc])

  // RPG シーン（最初の RPG シーンのみ採用 — 編集と違いプレイヤーは選択 UI を出さない）。
  // #284 S1: RPG 判定は **エントリ doc 限定**。サブ MD に RPG シーンがあっても拾わない（未対応）。
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
              // #284: 通常再生は events=（エントリ doc の線形ストリーム）で行い、
              // 多シーンの自動進行（scene1→scene2→…）を維持する（M2 退行修正）。
              // jumpSceneIndex= には全 MD の全シーンを渡し、NovelRenderer.allScenes を
              // 全 MD 横断で埋めることでクロスファイルのシーンジャンプ（→ シーンID）・
              // セーブ復元・debug startFrom を解決する（再生ストリームは置換しない）。
              // ※ scenes= は使わない（setScenes は再生を scenes[0] だけに差し替えてしまう）。
              events={novelEvents}
              jumpSceneIndex={allScenes}
              assetBaseUrl={assetBaseUrl}
              aspectRatio={doc?.aspect_ratio}
              choiceStyle={doc?.choice_style ?? null}
              fontFamily={doc?.font_family ?? null}
              dialogStyle={doc?.dialog_style ?? null}
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
