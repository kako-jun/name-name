import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import CanvasEditor from '../components/CanvasEditor'
import NovelPlayer from '../components/NovelPlayer'
import MapEditor from '../components/MapEditor'
import NPCEditor from '../components/NPCEditor'
import RPGPlayer from '../components/RPGPlayer'
import SaveDiscardButtons from '../components/SaveDiscardButtons'
import type { Mode, Event, EventDocument, EventRef } from '../types'
import { RPGProject, MapData, NPCData } from '../types/rpg'
import { parseMarkdown, emitMarkdown } from '../wasm/parser'
import {
  rpgProjectFromDoc,
  applyRpgProjectToDoc,
  findRpgSceneIndex,
  findAllRpgScenes,
} from '../game/rpgProjectFromDoc'
import { createApiClient, type ProjectInfo } from '../api/client'

// kako-jun/name-name#107: 旧 FastAPI モデルでは autosave 1s debounce で
// ワーキングディレクトリに PUT し、commit ボタンで Git push していた。
// Worker モデルでは「保存ボタン押下 = PUT contents = 即 commit」になるため、
// 編集中の値は localStorage に退避し、サーバ保存は明示「保存」のみとする。
// UI の本格的な改修（保存ボタン名変更・autosave 表示など）は #108 で行う。
const CHAPTERS_PATH = 'chapters/all.md'
const DEFAULT_BRANCH = 'develop'

function localStorageKey(projectName: string): string {
  return `name-name:editor-draft:${projectName}`
}

interface EditorScreenProps {
  projectName: string
  apiBaseUrl: string
  isDark: boolean
  onBack: () => void
  onToggleDark: () => void
  onOpenSettings: () => void
  onNavigateToAssets: () => void
}

/**
 * EventDocument を「最初のシーン以外の前に SceneTransition を挟んだ」フラット Event[] に変換する。
 * NovelPlayer に食わせるための整形。
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

function EditorScreen({
  projectName,
  apiBaseUrl,
  isDark,
  onBack,
  onToggleDark,
  onOpenSettings,
  onNavigateToAssets,
}: EditorScreenProps) {
  const [mode, setMode] = useState<Mode>('edit')
  const [editorTab, setEditorTab] = useState<'novel' | 'rpg'>('novel')
  const [doc, setDoc] = useState<EventDocument | null>(null)
  // CanvasEditor を再マウントしてエディタ内部 state を完全リセットするためのバージョン。
  // discard 成功時などにインクリメントする。
  const [docVersion, setDocVersion] = useState(0)
  const [selectedEvent, setSelectedEvent] = useState<EventRef | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const draftSaveTimeoutRef = useRef<number | null>(null)
  const initialMarkdownRef = useRef<string>('')
  // GitHub Contents API の sha。PUT 時の楽観ロックに必須。
  // ロード時に getContents() のレスポンスから設定し、PUT 成功時に新しい sha で更新する。
  const shaRef = useRef<string | null>(null)
  const [rawMarkdown, setRawMarkdown] = useState<string>('')
  const [rpgSubTab, setRpgSubTab] = useState<'map' | 'npc' | 'play'>('map')
  // PR #120 review Q1: shaRef.current を state にも反映して、保存ボタンの
  //   disabled 制御に使う。ref 単体だと React が再レンダリングしないため
  //   ボタンの enabled/disabled が更新されない。
  const [hasSha, setHasSha] = useState(false)
  // PR #120 review S4: 初期ロードに失敗したら autosave / 保存ボタンを止める。
  //   失敗時に空 doc で上書きすると localStorage の draft も '' で潰れて
  //   ユーザーの未保存原稿が消えるので、loadFailed のうちはサーバ書き戻し系を
  //   全部停止し、再読み込みを促すエラーメッセージを出す。
  const [loadFailed, setLoadFailed] = useState(false)
  // PR #120 review S2: NovelPlayer に渡す assets のベース URL。kako-jun ハードコードを
  //   やめ、Worker (listProjects) から取得した repo (`owner/name`) を使う。
  //   ロード前は null。
  const [projectRepo, setProjectRepo] = useState<string | null>(null)

  // apiBaseUrl が変わるたびにクライアントを作り直す。
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  // 現在 RPG タブが編集対象としているシーン ID（doc 内の最初の RPG シーン）
  const [rpgSceneId, setRpgSceneId] = useState<string | null>(null)

  // doc 内の全 RPG シーン（シーン選択ドロップダウン用）
  const rpgScenes = useMemo(() => (doc ? findAllRpgScenes(doc) : []), [doc])

  // doc から RPGProject を導出（メモ化・純粋な派生値計算）。
  // rpgSceneId が doc 内の RPG シーンと一致すればそのシーンを優先、
  // 未設定または doc に存在しない場合は最初の RPG シーンにフォールバックする。
  const rpgProject: RPGProject | null = useMemo(() => {
    if (!doc) return null
    const explicitFound = rpgSceneId !== null ? findRpgSceneIndex(doc, rpgSceneId) : null
    const found = explicitFound ?? findRpgSceneIndex(doc)
    if (!found) return null
    const sceneIdForThisDoc = doc.chapters[found.chapterIndex]?.scenes[found.sceneIndex]?.id ?? null
    return rpgProjectFromDoc(doc, sceneIdForThisDoc ?? undefined, projectName)
  }, [doc, projectName, rpgSceneId])

  // 現在の rpgSceneId が doc 内に存在しない場合、先頭の RPG シーンに切り替える。
  // useMemo 内で setState しないよう副作用を分離。
  useEffect(() => {
    if (!doc) return
    // rpgSceneId が既に doc 内に存在するシーンを指していれば何もしない
    if (rpgSceneId !== null && findRpgSceneIndex(doc, rpgSceneId) !== null) {
      return
    }
    // doc の先頭 RPG シーンにフォールバック
    const fallback = findRpgSceneIndex(doc)
    const nextSceneId =
      fallback !== null
        ? (doc.chapters[fallback.chapterIndex]?.scenes[fallback.sceneIndex]?.id ?? null)
        : null
    // 無限ループ防止: 同じ値なら setState しない
    if (nextSceneId !== rpgSceneId) {
      setRpgSceneId(nextSceneId)
    }
  }, [doc, rpgSceneId])

  // プロジェクト名が変わったら rpgSceneId をリセット（将来の再マウント無し
  // プロジェクト切替への備え。現状は App 側で key を変えて再マウントされる）
  useEffect(() => {
    setRpgSceneId(null)
  }, [projectName])

  // ユーザー操作で doc が変わったら emit し、rawMarkdown を更新する。
  // rawMarkdown の更新は autosave useEffect 経由で Worker に PUT される。
  // emit が失敗した場合は rawMarkdown と doc の desync を避けるため、doc を元に戻す。
  const handleDocChange = async (newDoc: EventDocument) => {
    const prev = doc
    setDoc(newDoc)
    try {
      const md = await emitMarkdown(newDoc)
      setRawMarkdown(md)
    } catch (err) {
      console.error('emitMarkdown failed:', err)
      setDoc(prev)
      setSaveError('Markdown生成に失敗したため変更を破棄しました')
    }
  }

  // Markdown を WASM でパースして doc を更新
  const parseAndSetDoc = async (markdown: string) => {
    try {
      const parsed = await parseMarkdown(markdown)
      setDoc(parsed)
    } catch (parseError) {
      console.error('WASM parse failed:', parseError)
      setSaveError('Markdownのパースに失敗しました')
      // 空のドキュメントでフォールバック
      setDoc({ engine: 'name-name', chapters: [] })
    }
  }

  // RPGProject の変更を doc に書き戻し、Markdown に反映する
  const persistRpgProject = async (updated: RPGProject) => {
    if (!doc) return
    // 既に doc 内で特定済みの RPG シーン ID を対象にする（未設定なら
    // applyRpgProjectToDoc 内のフォールバックで最初の RPG シーンに書き戻される）
    const targetSceneId = rpgSceneId ?? 'rpg-map'
    const newDoc = applyRpgProjectToDoc(doc, updated, targetSceneId)
    await handleDocChange(newDoc)
  }

  // MapEditor に渡す onChange を memoize する（M1: MapEditor 側 useEffect の依存
  // 安定化のため）。rpgProject が差し替わったときのみ新しい関数参照になる。
  // persistRpgProject は毎回新規生成だが、実質依存は rpgProject と doc。
  // rpgProject が変わる = doc が変わる、なので rpgProject 参照で十分（react-hooks
  // プラグインは未導入のため明示的な lint エラーは出ないが、意図を明記する）。
  // TODO: eslint-plugin-react-hooks 導入時に exhaustive-deps の警告が出るので、
  //   意図的 suppression (eslint-disable-next-line) を付けるか依存を追加するか再判断する。
  const handleMapChange = useCallback(
    (mapData: MapData) => {
      if (!rpgProject) return
      void persistRpgProject({ ...rpgProject, map: mapData })
    },
    [rpgProject]
  )

  // 空の RPG シーンを追加する。doc がロード済みでない間は呼ばない（ボタン側で disabled）
  const addEmptyRpgScene = async () => {
    if (!doc) return
    const mapWidth = 20
    const mapHeight = 15
    const emptyProject: RPGProject = {
      name: projectName,
      version: '1.0.0',
      map: {
        width: mapWidth,
        height: mapHeight,
        tileSize: 32,
        tiles: Array.from({ length: mapHeight }, (_, y) =>
          Array.from({ length: mapWidth }, (_, x) =>
            x === 0 || x === mapWidth - 1 || y === 0 || y === mapHeight - 1 ? 2 : 0
          )
        ),
      },
      player: { x: 5, y: 5, direction: 'down' },
      npcs: [],
      view: 'topdown',
    }
    const newSceneId = 'rpg-map'
    const newDoc = applyRpgProjectToDoc(doc, emptyProject, newSceneId)
    setRpgSceneId(newSceneId)
    await handleDocChange(newDoc)
  }

  // PR #120 review S2: projectName から repo (`owner/name`) を解決する。
  //   listProjects の結果は Worker の projects.ts に固定で入っており短いため、
  //   毎回呼んでも問題ない。失敗時は projectRepo=null のまま → assetBaseUrl は
  //   フォールバック（kako-jun/<name>）で動かす。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await api.listProjects()
        if (cancelled) return
        const found = list.find((p: ProjectInfo) => p.name === projectName)
        setProjectRepo(found?.repo ?? null)
      } catch (error) {
        console.error('Failed to resolve project repo:', error)
        if (!cancelled) setProjectRepo(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, projectName])

  // 初回ロード: Worker (Contents API) から chapters/all.md を取得しWASMでパース。
  // 取得時の sha を shaRef に保持し、後続の PUT 時に楽観ロック用に渡す。
  // ロード前に localStorage の draft を見て、復元できる場合は draft を表示する
  // （draft があるが ref と sha の世代が古い場合は #108 でマージ UI を入れる予定。
  //  暫定では「ロード後に draft で上書き」する素直な復元のみ）。
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const data = await api.getContents(projectName, CHAPTERS_PATH, DEFAULT_BRANCH)
        const markdown = data.content || ''
        shaRef.current = data.sha
        setHasSha(Boolean(data.sha))
        setLoadFailed(false)
        initialMarkdownRef.current = markdown

        // localStorage に draft があれば復元、無ければサーバ値をそのまま使う。
        // 現状は単純復元。サーバ側が更新されている可能性は #108 で対処。
        let localDraft: string | null = null
        try {
          localDraft = localStorage.getItem(localStorageKey(projectName))
        } catch {
          localDraft = null
        }
        const startMarkdown = localDraft !== null && localDraft !== '' ? localDraft : markdown
        setRawMarkdown(startMarkdown)
        await parseAndSetDoc(startMarkdown)
        setHasUnsavedChanges(localDraft !== null && localDraft !== markdown)
      } catch (error) {
        console.error('Failed to load chapters:', error)
        // PR #120 review S4: 失敗時に setRawMarkdown('') すると autosave 経由で
        //   localStorage の draft が空文字で潰れる。loadFailed フラグを立てて
        //   autosave と保存ボタンを止めることで、ユーザーが既に書いた原稿の
        //   draft を保護する。doc は空フォールバックで操作可能にだけしておく。
        shaRef.current = null
        setHasSha(false)
        setLoadFailed(true)
        setDoc({ engine: 'name-name', chapters: [] })
        setSaveError('プロジェクトの読み込みに失敗しました。再読み込みしてください。')
      }
    }
    loadChapters()
    // api は apiBaseUrl から派生する useMemo の値、projectName が変わったらもう一度ロード
  }, [api, projectName])

  // Markdown の変更を検出して未保存フラグを立てる。
  // Worker モデルでは status ポーリングは行わない（保存=即commit のためサーバに
  // 「未コミット差分」が存在しない）。
  useEffect(() => {
    if (initialMarkdownRef.current === '' && rawMarkdown === '') return
    setHasUnsavedChanges(rawMarkdown !== initialMarkdownRef.current)
  }, [rawMarkdown])

  // rawMarkdown が変更されたら localStorage に下書き退避（debounce 1s）。
  // サーバへの保存は handleSave で明示的に行う。
  // PR #120 review S4: 初期ロード失敗時 (loadFailed) は draft を一切触らない。
  //   失敗状態で空 doc を設定しているので、autosave すると既存 draft を上書きする。
  useEffect(() => {
    if (loadFailed) return
    if (!rawMarkdown && initialMarkdownRef.current === '') return

    if (draftSaveTimeoutRef.current !== null) {
      clearTimeout(draftSaveTimeoutRef.current)
    }

    draftSaveTimeoutRef.current = window.setTimeout(() => {
      try {
        if (rawMarkdown === initialMarkdownRef.current) {
          // 変更が無ければ draft を消しておく
          localStorage.removeItem(localStorageKey(projectName))
        } else {
          localStorage.setItem(localStorageKey(projectName), rawMarkdown)
        }
      } catch (error) {
        console.error('Failed to persist draft to localStorage:', error)
      }
    }, 1000)

    return () => {
      if (draftSaveTimeoutRef.current !== null) {
        clearTimeout(draftSaveTimeoutRef.current)
      }
    }
  }, [rawMarkdown, projectName, loadFailed])

  // 保存ボタン: Worker の PUT contents を直接叩く（保存 = 即 commit）。
  // Worker モデルでは独立した「commit」概念が無いので、PUT が成功した時点で
  // GitHub にコミットされている。
  // PR #120 review Q1: shaRef が null（初期ロード失敗 / 未取得）のときは保存を
  //   実行しない。ボタン側でも disabled にしているので通常はここに来ないが、
  //   保険として早期 return する。
  const handleSave = async () => {
    if (loadFailed || shaRef.current === null) {
      setSaveError('再読み込みしてから保存してください')
      return
    }
    setIsSaving(true)
    setSaveError(null)
    try {
      const sha = shaRef.current
      const result = await api.putContents(projectName, CHAPTERS_PATH, {
        content: rawMarkdown,
        sha: sha ?? undefined,
        branch: DEFAULT_BRANCH,
        message: '原稿保存',
      })
      if (result.sha) {
        shaRef.current = result.sha
        setHasSha(true)
      }
      initialMarkdownRef.current = rawMarkdown
      setHasUnsavedChanges(false)
      try {
        localStorage.removeItem(localStorageKey(projectName))
      } catch {
        // ignore
      }
    } catch (error) {
      console.error('Failed to save:', error)
      setSaveError('保存に失敗しました')
    } finally {
      setIsSaving(false)
    }
  }

  // 破棄ボタン: localStorage の draft を消し、サーバから最新を再取得して上書き。
  // Worker モデルでは「未コミット変更を捨てて HEAD に戻す」ではなく、
  // 「ローカルで持っている下書きを捨てて GitHub の最新を引き直す」になる。
  // PR #120 review S3: 先に localStorage を消すと、その直後に getContents が
  //   失敗したとき draft が消えた上にエディタも空のままになり、ユーザーの
  //   作業が完全に失われる。サーバから取り直しが成功した「後」で draft を消す
  //   順序にする。
  const handleDiscard = async () => {
    setShowDiscardConfirm(false)
    setIsSaving(true)
    setSaveError(null)
    try {
      // 1. 先にサーバから最新を取り直す
      const data = await api.getContents(projectName, CHAPTERS_PATH, DEFAULT_BRANCH)
      const markdown = data.content || ''

      // 2. 取得成功したら draft を消す（失敗時は draft を保持して再試行可能に）
      try {
        localStorage.removeItem(localStorageKey(projectName))
      } catch {
        // ignore
      }

      shaRef.current = data.sha
      setHasSha(Boolean(data.sha))
      setLoadFailed(false)
      initialMarkdownRef.current = markdown
      setRawMarkdown(markdown)
      await parseAndSetDoc(markdown)
      // discard で doc が差し替わるため、選択状態・CanvasEditor 内部 state を完全リセット
      setSelectedEvent(null)
      setRpgSceneId(null)
      setDocVersion((v) => v + 1)
      setHasUnsavedChanges(false)
    } catch (error) {
      console.error('Failed to discard changes:', error)
      setSaveError('変更の破棄に失敗しました')
    } finally {
      setIsSaving(false)
    }
  }

  // プレイモード用のフラット Event[]
  const novelEvents = useMemo(() => (doc ? flattenDocumentEvents(doc) : []), [doc])

  return (
    <div className={`flex flex-col h-screen ${isDark ? 'dark bg-gray-900' : 'bg-white'}`}>
      <header
        className={`border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
      >
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
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
              Name × Name{' '}
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- {projectName}</span>
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

        {/* エディタタブ（ノベル / RPG） */}
        <div
          className={`px-6 flex gap-1 border-t ${isDark ? 'border-gray-700' : 'border-blue-100'}`}
        >
          {(['novel', 'rpg'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setEditorTab(tab)}
              className={`px-4 py-1.5 text-sm font-medium rounded-t transition-colors ${
                editorTab === tab
                  ? isDark
                    ? 'bg-gray-700 text-white'
                    : 'bg-white text-gray-900 border border-b-white border-blue-200'
                  : isDark
                    ? 'text-gray-400 hover:text-gray-200'
                    : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'novel' ? 'ノベル' : 'RPG'}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {editorTab === 'novel' ? (
          mode === 'edit' ? (
            doc !== null ? (
              <CanvasEditor
                key={docVersion}
                doc={doc}
                onDocChange={handleDocChange}
                isDark={isDark}
                selectedEvent={selectedEvent}
                setSelectedEvent={setSelectedEvent}
                onNavigateToAssets={onNavigateToAssets}
              />
            ) : (
              <div
                className={`flex items-center justify-center h-full ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
              >
                読み込み中...
              </div>
            )
          ) : (
            <NovelPlayer
              events={novelEvents}
              aspectRatio={doc?.aspect_ratio}
              // PR #120 review S2: 旧 FastAPI は静的ファイルを直接返していたが、
              //   Worker は /assets/:type の一覧 API しか提供しない（個別ファイルは
              //   GitHub の download_url 経由になる）。
              //   暫定で raw.githubusercontent.com を直接指す。
              //   プロジェクトリポジトリ owner/name は listProjects() の結果
              //   (ProjectInfo.repo) から取得する。未取得時は kako-jun/<name> に
              //   フォールバックして動作互換を保つ（Editor/Player 統合 #108 で
              //   download_url ベースに置き換える）。
              assetBaseUrl={`https://raw.githubusercontent.com/${
                projectRepo ?? `kako-jun/${projectName}`
              }/${DEFAULT_BRANCH}/assets`}
            />
          )
        ) : (
          // RPGエディタ
          <div className="h-full flex flex-col">
            <div
              className={`flex gap-1 px-4 py-2 border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}
            >
              {(['map', 'npc', 'play'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setRpgSubTab(tab)}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    rpgSubTab === tab
                      ? isDark
                        ? 'bg-blue-600 text-white'
                        : 'bg-blue-500 text-white'
                      : isDark
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                  }`}
                >
                  {tab === 'map' ? 'マップ' : tab === 'npc' ? 'NPC' : 'プレイ'}
                </button>
              ))}
            </div>

            {/* シーン選択 + view 切替ツールバー（RPG シーンが存在するときのみ） */}
            {rpgProject !== null && (
              <div
                className={`flex items-center gap-4 px-4 py-2 border-b text-sm ${
                  isDark
                    ? 'border-gray-600 bg-gray-900 text-gray-200'
                    : 'border-gray-300 bg-white text-gray-700'
                }`}
              >
                {rpgScenes.length >= 2 && (
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="rpg-scene-select"
                      className={isDark ? 'text-gray-300' : 'text-gray-600'}
                    >
                      シーン:
                    </label>
                    <select
                      id="rpg-scene-select"
                      aria-label="RPGシーン選択"
                      value={rpgSceneId ?? ''}
                      onChange={(e) => setRpgSceneId(e.target.value)}
                      className={`px-2 py-1 rounded border text-sm ${
                        isDark
                          ? 'bg-gray-700 border-gray-600 text-gray-100'
                          : 'bg-white border-gray-300 text-gray-900'
                      }`}
                    >
                      {rpgScenes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title || s.id}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="rpg-view-select"
                    className={isDark ? 'text-gray-300' : 'text-gray-600'}
                  >
                    視点:
                  </label>
                  <select
                    id="rpg-view-select"
                    aria-label="RPG視点切替"
                    value={rpgProject.view}
                    onChange={(e) => {
                      const nextView = e.target.value as 'topdown' | 'raycast'
                      void persistRpgProject({ ...rpgProject, view: nextView })
                    }}
                    className={`px-2 py-1 rounded border text-sm ${
                      isDark
                        ? 'bg-gray-700 border-gray-600 text-gray-100'
                        : 'bg-white border-gray-300 text-gray-900'
                    }`}
                  >
                    <option value="topdown">見下ろし</option>
                    <option value="raycast">レイキャスト</option>
                  </select>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-hidden">
              {rpgProject === null ? (
                <div
                  className={`h-full flex flex-col items-center justify-center gap-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
                >
                  <p className="text-sm">このプロジェクトにはまだRPGシーンがありません。</p>
                  <button
                    onClick={addEmptyRpgScene}
                    disabled={!doc}
                    className={`px-4 py-2 rounded font-medium transition-colors ${
                      !doc
                        ? isDark
                          ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                          : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : isDark
                          ? 'bg-blue-600 hover:bg-blue-700 text-white'
                          : 'bg-blue-500 hover:bg-blue-600 text-white'
                    }`}
                  >
                    + RPGシーンを追加
                  </button>
                </div>
              ) : (
                <>
                  {rpgSubTab === 'map' && (
                    <MapEditor
                      mapData={rpgProject.map}
                      rpgProject={rpgProject}
                      onChange={handleMapChange}
                      isDark={isDark}
                    />
                  )}
                  {rpgSubTab === 'npc' && (
                    <NPCEditor
                      npcs={rpgProject.npcs}
                      mapData={rpgProject.map}
                      onChange={(npcs: NPCData[]) => {
                        void persistRpgProject({ ...rpgProject, npcs })
                      }}
                      isDark={isDark}
                    />
                  )}
                  {rpgSubTab === 'play' && (
                    <RPGPlayer gameData={rpgProject ?? undefined} view={rpgProject?.view} />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* 破棄確認ダイアログ */}
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

      {/* エラーメッセージ */}
      {saveError && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100]">
          <div
            className={`px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 ${
              isDark ? 'bg-red-900 text-red-200' : 'bg-red-100 text-red-800'
            }`}
          >
            <span className="text-sm">{saveError}</span>
            <button
              onClick={() => setSaveError(null)}
              className="ml-2 text-xs opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* プレイモード切替 & セーブ/アンドゥボタン */}
      <SaveDiscardButtons
        hasUnsavedChanges={hasUnsavedChanges}
        isSaving={isSaving}
        isDark={isDark}
        onSave={handleSave}
        onDiscard={() => setShowDiscardConfirm(true)}
        mode={editorTab === 'novel' ? mode : undefined}
        onModeChange={editorTab === 'novel' ? setMode : undefined}
        // PR #120 review Q1: shaRef 未取得（loadFailed / 未ロード）時は保存不可。
        saveDisabled={loadFailed || !hasSha}
        saveDisabledTitle={
          loadFailed ? '再読み込みしてから保存してください' : !hasSha ? '読み込み中…' : undefined
        }
      />
    </div>
  )
}

export default EditorScreen
