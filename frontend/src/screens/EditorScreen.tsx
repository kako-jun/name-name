import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import CanvasEditor from '../components/CanvasEditor'
import NovelPlayer from '../components/NovelPlayer'
import MapEditor from '../components/MapEditor'
import NPCEditor from '../components/NPCEditor'
import RPGPlayer from '../components/RPGPlayer'
import SaveDiscardButtons from '../components/SaveDiscardButtons'
import type { Mode, Event, EventDocument, EventRef, EventScene } from '../types'
import { RPGProject, MapData, UiNpcData } from '../types/rpg'
import { parseMarkdown, emitMarkdown } from '../wasm/parser'
import {
  rpgProjectFromDoc,
  applyRpgProjectToDoc,
  findRpgSceneIndex,
  findAllRpgScenes,
} from '../game/rpgProjectFromDoc'
import { createApiClient, type ContentsResponse, type ScriptInfo } from '../api/client'
import type { NovelRenderer } from '../game/NovelRenderer'
import {
  exportVideo,
  buildVideoExportOptions,
  downloadBlob,
  pickSupportedMimeType,
  sanitizeFilename,
  type VideoExportOptions,
} from '../game/VideoExporter'
import VideoExportModal from '../components/VideoExportModal'
import {
  flattenDocumentScenes,
  buildSceneIndex,
  resolveMissingSceneAcrossDocs,
  basename,
  withInheritedEventImageTransition,
} from '../game/crossFileScenes'

// kako-jun/name-name#107: 旧 FastAPI モデルでは autosave 1s debounce で
// ワーキングディレクトリに PUT し、commit ボタンで Git push していた。
// Worker モデルでは「保存ボタン押下 = PUT contents = 即 commit」になるため、
// 編集中の値は localStorage に退避し、サーバ保存は明示「保存」のみとする。
// UI の本格的な改修（保存ボタン名変更・autosave 表示など）は #108 で行う。
// #237: 既定で開くファイル。プロジェクト直下に script.md がある前提（旧挙動踏襲）。
// listScripts 経由で取れる .md があれば、UI のタブ操作で切り替えられる。
const DEFAULT_SCRIPT_PATH = 'script.md'
const DEFAULT_BRANCH = 'develop'
// #778: プレビューの遅延ロードで #607 の event_image_transition 継承元にする再生時のエントリ（/play と同じ basename 規則）
const SCRIPT_BASENAME = 'script.md'
const LOAD_FAILED_MESSAGE = 'プロジェクトの読み込みに失敗しました。再読み込みしてください。'

/**
 * draft の localStorage キー。#237 でファイル単位に分離（path を含む）。
 * 旧キー `name-name:editor-draft:${projectName}` は無視され、新キーで管理される。
 * 旧キーを明示的に migrate せず放置するのは、サーバ側に最新がある以上ローカル draft が
 * 1 セッション失われても致命的ではないため（破壊的でない単方向移行）。
 */
function localStorageKey(projectName: string, path: string): string {
  return `name-name:editor-draft:${projectName}:${path}`
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
  // 動画エクスポート (#228)。プレビュー中の renderer 参照と、ダイアログ/進捗状態。
  const novelRendererRef = useRef<NovelRenderer | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportStartSceneId, setExportStartSceneId] = useState('')
  const [exportEndSceneId, setExportEndSceneId] = useState('')
  const [exportFps, setExportFps] = useState(30)
  const [exportInheritFlags, setExportInheritFlags] = useState(false)
  const [exportRunning, setExportRunning] = useState(false)
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
  // 保存の await 中に編集が進んだかを判定するため、常に最新の内容を指す
  const rawMarkdownRef = useRef('')
  rawMarkdownRef.current = rawMarkdown
  const [rpgSubTab, setRpgSubTab] = useState<'map' | 'npc' | 'play'>('map')
  // #237: 編集中ファイルパス + 利用可能なファイル一覧。
  const [currentScriptPath, setCurrentScriptPath] = useState<string>(DEFAULT_SCRIPT_PATH)
  const [availableScripts, setAvailableScripts] = useState<ScriptInfo[]>([])
  // listScripts の結果（成功・失敗とも）が出たか。最初に開く文書は一覧から決めるので、それまで初期ロードを待つ。
  // 一覧取得が済んだプロジェクト名。現在の projectName と一致して初めて「済み」とみなす
  // （プロジェクトが変わったら自動的に未済に戻る。古い一覧結果は反映しない）。
  const [settledProject, setSettledProject] = useState<string | null>(null)
  const scriptListSettled = settledProject === projectName
  // listScripts が失敗したか（先行取得の失敗を再取得せず使い回すかの判定用）
  const scriptListFailedRef = useRef(false)
  // #238: 編集中以外の .md (data.md 等) を解析した EventDocument。
  // RPG タブが master データ (モンスター / アイテム / 呪文 / パーティ) を data.md から
  // 参照できるよう、active doc とは別に並行ロードして保持する。
  // active doc 編集中も updated されない（保存時に再フェッチで十分）。
  const [otherDocs, setOtherDocs] = useState<EventDocument[]>([])
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
  // projectRepo は Worker proxy 移行により不要になった（raw.githubusercontent.com 廃止）

  // apiBaseUrl が変わるたびにクライアントを作り直す。
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  // 現在 RPG タブが編集対象としているシーン ID（doc 内の最初の RPG シーン）
  const [rpgSceneId, setRpgSceneId] = useState<string | null>(null)

  // doc 内の全 RPG シーン（シーン選択ドロップダウン用）
  const rpgScenes = useMemo(() => (doc ? findAllRpgScenes(doc) : []), [doc])

  // 動画エクスポート用シーンID一覧（順序保持）(#228)
  const allSceneIds = useMemo<string[]>(() => {
    if (!doc) return []
    const ids: string[] = []
    for (const ch of doc.chapters) {
      for (const sc of ch.scenes) ids.push(sc.id)
    }
    return ids
  }, [doc])

  // doc が更新されたら start/end が無効になっていないか同期する。
  // setter は React の同値検出で再 render を抑えるため、ガードなしで呼んで OK。
  useEffect(() => {
    if (allSceneIds.length === 0) return
    if (!allSceneIds.includes(exportStartSceneId)) {
      setExportStartSceneId(allSceneIds[0])
    }
    if (!allSceneIds.includes(exportEndSceneId)) {
      setExportEndSceneId(allSceneIds[allSceneIds.length - 1])
    }
  }, [allSceneIds, exportStartSceneId, exportEndSceneId])

  const handleStartVideoExport = useCallback(async () => {
    const renderer = novelRendererRef.current
    if (!renderer) {
      setExportStatus('プレビューを開いてから実行してください')
      return
    }
    if (!exportStartSceneId || !exportEndSceneId) {
      setExportStatus('開始シーンと終了シーンを選択してください')
      return
    }
    const mime = pickSupportedMimeType()
    if (!mime) {
      setExportStatus('このブラウザは video/webm の MediaRecorder をサポートしていません')
      return
    }
    if (exportRunning) {
      setExportStatus('既に録画中です')
      return
    }
    setExportRunning(true)
    setExportStatus('準備中...')
    const opts: VideoExportOptions = buildVideoExportOptions(renderer, {
      startSceneId: exportStartSceneId,
      endSceneId: exportEndSceneId,
      fps: exportFps,
      inheritFlags: exportInheritFlags,
      mimeType: mime,
      onProgress: (s) => setExportStatus(s),
    })
    try {
      const result = await exportVideo(renderer, opts)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const filename =
        sanitizeFilename(`${projectName}_${exportStartSceneId}_${exportEndSceneId}_${stamp}`) +
        '.webm'
      downloadBlob(result.blob, filename)
      const durSec = (result.durationMs / 1000).toFixed(1)
      const sizeMb = (result.blob.size / (1024 * 1024)).toFixed(2)
      setExportStatus(`完了: ${filename} (${durSec}s, ${sizeMb} MB)`)
    } catch (e) {
      console.error('[VideoExport] failed', e)
      setExportStatus(`失敗: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExportRunning(false)
    }
  }, [
    projectName,
    exportStartSceneId,
    exportEndSceneId,
    exportFps,
    exportInheritFlags,
    exportRunning,
  ])

  // doc から RPGProject を導出（メモ化・純粋な派生値計算）。
  // rpgSceneId が doc 内の RPG シーンと一致すればそのシーンを優先、
  // 未設定または doc に存在しない場合は最初の RPG シーンにフォールバックする。
  const rpgProject: RPGProject | null = useMemo(() => {
    if (!doc) return null
    const explicitFound = rpgSceneId !== null ? findRpgSceneIndex(doc, rpgSceneId) : null
    const found = explicitFound ?? findRpgSceneIndex(doc)
    if (!found) return null
    const sceneIdForThisDoc = doc.chapters[found.chapterIndex]?.scenes[found.sceneIndex]?.id ?? null
    // #238: data.md 等の他 .md からマスターデータを取り込む
    return rpgProjectFromDoc(doc, sceneIdForThisDoc ?? undefined, projectName, otherDocs)
  }, [doc, projectName, rpgSceneId, otherDocs])

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

  // PR #120 review S2: projectRepo（repo 名解決）は Worker proxy 移行で不要になった。

  // ---- 他の MD の取得（#238 RPG マスター参照 / #778 プレビューの遅延ロード 共通）----
  // 取得元は1本: そのタブの未保存の下書き（localStorage）があればそれ、無ければ develop の内容。
  // path をキーに結果と取得中 Promise を共有する（二重取得しない）。編集中の文書は含めない
  // （最新は doc state）。タブ切替・プロジェクト切替で捨てる（古い下書き/サーバ版を残さない）。
  const docRef = useRef<EventDocument | null>(null)
  docRef.current = doc
  // doc が「どのパスの文書か」。タブ切替直後は currentScriptPath が先に変わり、doc は
  // loadChapters 完了まで旧文書のままなので、両者の食い違いを検出するために持つ。
  const [docPath, setDocPath] = useState<string | null>(null)
  const docPathRef = useRef<string | null>(null)
  docPathRef.current = docPath
  const currentScriptPathRef = useRef(currentScriptPath)
  currentScriptPathRef.current = currentScriptPath
  const loadedOtherDocsRef = useRef<Map<string, EventDocument>>(new Map())
  const loadingOtherDocsRef = useRef<Map<string, Promise<EventDocument | null>>>(new Map())
  const otherDocsEpochRef = useRef(0)
  const switchEpochRef = useRef(0)
  const [lazyOtherScenes, setLazyOtherScenes] = useState<EventScene[]>([])
  // 遅延ロード探索の対象。hidden（data.md 等のマスター）は /play と同じく除く（編集中のものは残す）。
  const sortedScriptPaths = useMemo(() => {
    const paths = availableScripts
      .filter((s) => !s.hidden || s.path === currentScriptPath)
      .map((s) => s.path)
      .sort()
    return paths.includes(currentScriptPath) ? paths : [currentScriptPath, ...paths]
  }, [availableScripts, currentScriptPath])
  const sortedScriptPathsRef = useRef<string[]>([])
  sortedScriptPathsRef.current = sortedScriptPaths

  // switched: タブ・プロジェクトの切替による破棄か。継承値の変更による破棄（false）の場合は、
  // 進行中の解決が打ち切られても同じ文書のまま取り直せる（resolveMissingScene が1回だけやり直す）。
  const resetOtherDocsCache = useCallback((switched = true) => {
    otherDocsEpochRef.current++
    if (switched) switchEpochRef.current++
    loadedOtherDocsRef.current = new Map()
    loadingOtherDocsRef.current = new Map()
    setLazyOtherScenes([])
  }, [])
  // プロジェクト切替でも捨てる（現状は App が key で再マウントするが、念のため）
  useEffect(() => {
    resetOtherDocsCache()
  }, [api, projectName, resetOtherDocsCache])
  // タブ切替は取得キャッシュの破棄と同期して行う（epoch を先に進め、旧タブ向けの取得を無効化する）
  const switchScript = useCallback(
    (path: string) => {
      resetOtherDocsCache()
      setCurrentScriptPath(path)
    },
    [resetOtherDocsCache]
  )

  // script.md を編集中に event_image_transition を変えたら、継承して解析済みの他文書を捨てる
  // （古い継承値のまま残さない）。次の遅延ロードで新しい値を使って取り直す。
  const scriptTransition =
    doc && docPath === currentScriptPath && basename(currentScriptPath) === SCRIPT_BASENAME
      ? (doc.event_image_transition ?? null)
      : undefined
  const prevScriptTransitionRef = useRef<
    EventDocument['event_image_transition'] | null | undefined
  >(undefined)
  useEffect(() => {
    const prev = prevScriptTransitionRef.current
    prevScriptTransitionRef.current = scriptTransition
    if (prev !== undefined && scriptTransition !== undefined && prev !== scriptTransition) {
      resetOtherDocsCache(false)
    }
  }, [scriptTransition, resetOtherDocsCache])

  const loadOtherDoc = useCallback(
    function load(path: string): Promise<EventDocument | null> {
      // #607 の継承元（script.md）を編集中で、その doc がまだ確定していない（タブ切替直後）間は
      // 取得しない。継承なしの解析結果を作って共有・キャッシュしてしまうのを避ける
      // （再呼び出しされるのは otherDocs の effect だけ: docPath を依存に持ち、確定後に取り直す。
      // resolver 側は docPath 未確定の間そもそも呼ばず not-found にする＝ジャンプは入り直しで解決）。
      const inheritFrom = sortedScriptPathsRef.current.find((p) => basename(p) === SCRIPT_BASENAME)
      if (
        inheritFrom &&
        inheritFrom !== path &&
        inheritFrom === currentScriptPathRef.current &&
        docPathRef.current !== inheritFrom
      ) {
        return Promise.resolve(null)
      }
      const cached = loadedOtherDocsRef.current.get(path)
      if (cached) return Promise.resolve(cached)
      const inFlight = loadingOtherDocsRef.current.get(path)
      if (inFlight) return inFlight
      const epoch = otherDocsEpochRef.current
      const loading = loadingOtherDocsRef.current
      const promise = (async () => {
        let draft: string | null = null
        try {
          draft = localStorage.getItem(localStorageKey(projectName, path))
        } catch {
          draft = null
        }
        let markdown: string
        if (draft !== null && draft !== '') {
          markdown = draft
        } else {
          const data = await api.getContents(projectName, path, DEFAULT_BRANCH)
          markdown = data.content || ''
        }
        // #607: /play と同じく、script.md 以外は script.md の event_image_transition を継承してパースする
        // （プレビューは /play の再現が目的）。script.md が無い・読めない場合は継承なし。
        let inherited: EventDocument['event_image_transition'] | null = null
        if (inheritFrom && inheritFrom !== path) {
          if (inheritFrom === currentScriptPathRef.current) {
            inherited = docRef.current?.event_image_transition ?? null
          } else {
            inherited = (await load(inheritFrom))?.event_image_transition ?? null
          }
        }
        const parsed = await parseMarkdown(withInheritedEventImageTransition(markdown, inherited))
        // タブ切替・プロジェクト切替をまたいだ古い取得結果は捨てる
        if (otherDocsEpochRef.current === epoch) {
          loadedOtherDocsRef.current.set(path, parsed)
        }
        return parsed
      })()
        .catch((err) => {
          console.warn(`[EditorScreen] failed to load script ${path}:`, err)
          return null
        })
        .finally(() => {
          if (loading.get(path) === promise) loading.delete(path)
        })
      loading.set(path, promise)
      return promise
    },
    [api, projectName]
  )

  // 初回ロード: Worker (Contents API) から script.md を取得しWASMでパース。
  // 取得時の sha を shaRef に保持し、後続の PUT 時に楽観ロック用に渡す。
  // ロード前に localStorage の draft を見て、復元できる場合は draft を表示する
  // （draft があるが ref と sha の世代が古い場合は #108 でマージ UI を入れる予定。
  //  暫定では「ロード後に draft で上書き」する素直な復元のみ）。
  // 既定の script.md を listScripts と並列で先行して取りに行く。worker の listScripts は各 .md を
  // 順に fetch する（キャッシュ MISS 時）ので遅く、直列にすると起動が遅れる。一覧が「script.md あり」を
  // 確定したらこの結果を使い、一覧に無ければ捨てる（失敗は握りつぶす＝トーストを出さない）。
  // 先行取得するのは「既定の script.md」。scriptsDir を持つプロジェクト（skirts-colour の
  // content/scripts 等）は scriptsDir/script.md を取る（ルートの script.md は 404 になるため）。
  // scriptsDir は listProjects（静的な JSON）で分かる。取れなければルート直下を試す。
  const defaultPrefetchRef = useRef<{
    promise: Promise<{ path: string; data: ContentsResponse | null; error: unknown }>
  } | null>(null)
  useEffect(() => {
    const promise = (async () => {
      let path = DEFAULT_SCRIPT_PATH
      try {
        const projects = await api.listProjects()
        const dir = projects
          .find((pr) => pr.name === projectName)
          ?.scriptsDir?.replace(/^\/+|\/+$/g, '')
        if (dir) path = `${dir}/${DEFAULT_SCRIPT_PATH}`
      } catch {
        // 取れなければルート直下
      }
      try {
        return {
          path,
          data: await api.getContents(projectName, path, DEFAULT_BRANCH),
          error: null,
        }
      } catch (error) {
        return { path, data: null, error }
      }
    })()
    defaultPrefetchRef.current = { promise }
  }, [api, projectName])

  useEffect(() => {
    // #237 review M1: タブ切替で currentScriptPath が変わったとき、
    // 先に sha / 初期値を即座にリセットする。
    // 理由: 前ファイルの sha が shaRef に残ったまま loadChapters が catch に飛ぶと
    //   ユーザーが新パス向けに編集→保存 → 前ファイルの sha で別パス PUT → 409 か
    //   最悪のケースで意図しないファイルを上書きしうる。fetch 前に確実にクリアする。
    // 一覧の取得が済むまで待つ（既定の script.md を無条件に取りに行って 404 にならないように）。
    if (!scriptListSettled) return
    shaRef.current = null
    setHasSha(false)
    initialMarkdownRef.current = ''

    const loadChapters = async () => {
      try {
        // 先行取得済みの既定パスならその結果を使う（1 回限り）。取得に失敗していた場合は、
        // 一覧が成功していれば（一時的な失敗かもしれないので）取り直し、一覧も失敗していたら
        // 同じエラーを使い回す（同じ取得を2回しない。トーストは従来どおり1回）。
        let data: ContentsResponse | null = null
        const prefetch = defaultPrefetchRef.current
        if (prefetch) {
          const pre = await prefetch.promise
          defaultPrefetchRef.current = null
          if (pre.path === currentScriptPath) {
            if (pre.data) data = pre.data
            else if (scriptListFailedRef.current) throw pre.error
          }
        }
        data ??= await api.getContents(projectName, currentScriptPath, DEFAULT_BRANCH)
        const markdown = data.content || ''
        shaRef.current = data.sha
        setHasSha(Boolean(data.sha))
        setLoadFailed(false)
        initialMarkdownRef.current = markdown

        // localStorage に draft があれば復元、無ければサーバ値をそのまま使う。
        // 現状は単純復元。サーバ側が更新されている可能性は #108 で対処。
        let localDraft: string | null = null
        try {
          localDraft = localStorage.getItem(localStorageKey(projectName, currentScriptPath))
        } catch {
          localDraft = null
        }
        const startMarkdown = localDraft !== null && localDraft !== '' ? localDraft : markdown
        setRawMarkdown(startMarkdown)
        await parseAndSetDoc(startMarkdown)
        setDocPath(currentScriptPath)
        // 既定パス(script.md)の先行ロード失敗で出た読み込みエラーは、再ロード成功で消す
        setSaveError((prev) => (prev === LOAD_FAILED_MESSAGE ? null : prev))
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
        setDocPath(currentScriptPath)
        setSaveError(LOAD_FAILED_MESSAGE)
      }
    }
    loadChapters()
    // api は apiBaseUrl から派生する useMemo の値、projectName / currentScriptPath が
    // 変わったらもう一度ロード（#237: ファイルタブ切替で再ロード）。
  }, [api, projectName, currentScriptPath, scriptListSettled])

  // プロジェクトが変わったら、開くファイル・一覧・doc の所属を初期状態に戻す（通常は App が
  // key で再マウントするが、再マウントされなくても前のプロジェクトの状態を引きずらない）。
  // 初回マウントでは同じ値の再設定になるだけ。
  const projectRef = useRef(projectName)
  useEffect(() => {
    if (projectRef.current === projectName) return
    projectRef.current = projectName
    setCurrentScriptPath(DEFAULT_SCRIPT_PATH)
    setAvailableScripts([])
    setDocPath(null)
  }, [projectName])

  // #237: プロジェクト直下の .md 一覧（engine: name-name のみ）を取得してタブを構築。
  // 失敗しても致命的でない（script.md 単体運用に degrade する）ためエラーはコンソールのみ。
  useEffect(() => {
    let cancelled = false
    scriptListFailedRef.current = false
    const loadList = async () => {
      try {
        const scripts = await api.listScripts(projectName, DEFAULT_BRANCH)
        if (cancelled) return
        setAvailableScripts(scripts)
        // 最初に開く文書を一覧から決める。既定の script.md が一覧に無い場合（scriptsDir 構成等）は、
        // /play のエントリ選び（#284）と同じく basename が script.md のもの、無ければ先頭にする。
        // 一覧が空なら DEFAULT_SCRIPT_PATH のまま。
        if (scripts.length > 0 && !scripts.some((s) => s.path === DEFAULT_SCRIPT_PATH)) {
          const entry = scripts.find((s) => basename(s.path) === SCRIPT_BASENAME) ?? scripts[0]
          switchScript(entry.path)
        }
      } catch (err) {
        if (cancelled) return
        scriptListFailedRef.current = true
        console.warn('[EditorScreen] listScripts failed; falling back to single script.md', err)
        setAvailableScripts([])
      } finally {
        // 失敗時（単一 script.md の旧プロジェクト等）は従来どおり既定の script.md を試す
        if (!cancelled) setSettledProject(projectName)
      }
    }
    loadList()
    return () => {
      cancelled = true
    }
    // #237 review S1: listing 自体は repo 単位の情報なので projectName が変わったときだけ再取得する。
    // (listing 取得後の otherDocs ロードは別の useEffect が availableScripts を監視して行う)
    // currentScriptPath を依存に入れるとタブ切替の度に listing API が再叩きされて無駄。
    // 「現在 path が listing に無いなら先頭に切り替える」のは setCurrentScriptPath で
    //   currentScriptPath が変わる → このフックは再実行されない（次回 projectName 変更時のみ）が、
    //   listing は既に最新 (1 回前のフックで取得済み) なので問題なし。
  }, [api, projectName, switchScript])

  // #238: availableScripts から currentScriptPath 以外の .md を fetch + parse して
  //   otherDocs に詰める。RPG タブが data.md 等のマスター定義を参照できるようにする。
  //   取得は loadOtherDoc（#778 の遅延ロードと共有。下書き優先 → develop）。エディタでは
  //   編集中・未保存の内容を見るのが自然なので、マスターも下書き優先で参照する。
  // 失敗した個別ファイルはスキップ（致命的でない）。
  useEffect(() => {
    let cancelled = false
    // 編集中の文書が確定するまで待つ（#607 の継承元が未確定のまま解析しないため）
    if (docPath !== currentScriptPath) return
    const loadOthers = async () => {
      const others = availableScripts.filter((s) => s.path !== currentScriptPath)
      if (others.length === 0) {
        setOtherDocs([])
        return
      }
      const docs: EventDocument[] = []
      for (const s of others) {
        // 失敗した個別ファイルは loadOtherDoc 内で warn され null になる（スキップ）
        const parsed = await loadOtherDoc(s.path)
        if (parsed) docs.push(parsed)
      }
      if (!cancelled) setOtherDocs(docs)
    }
    loadOthers()
    return () => {
      cancelled = true
    }
  }, [loadOtherDoc, availableScripts, currentScriptPath, docPath])

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
  // 保留中の下書き書き込み。タイマー発火・タブ切替・アンマウントのいずれでも flushPendingDraft で確定する。
  // （従来は rawMarkdown の cleanup でタイマーごと捨てていたため、切替前 1 秒以内の編集が
  //  localStorage に残らなかった。#778 で他タブの下書きがプレビューの取得元になり表面化した）
  const pendingDraftRef = useRef<{ key: string; markdown: string } | null>(null)
  const flushPendingDraft = useCallback(() => {
    if (draftSaveTimeoutRef.current !== null) {
      clearTimeout(draftSaveTimeoutRef.current)
      draftSaveTimeoutRef.current = null
    }
    const pending = pendingDraftRef.current
    if (!pending) return
    pendingDraftRef.current = null
    try {
      if (pending.markdown === initialMarkdownRef.current) {
        // 変更が無ければ draft を消しておく
        localStorage.removeItem(pending.key)
      } else {
        localStorage.setItem(pending.key, pending.markdown)
      }
    } catch (error) {
      console.error('Failed to persist draft to localStorage:', error)
    }
  }, [])

  useEffect(() => {
    if (loadFailed) return
    if (!rawMarkdown && initialMarkdownRef.current === '') return

    if (draftSaveTimeoutRef.current !== null) {
      clearTimeout(draftSaveTimeoutRef.current)
    }
    pendingDraftRef.current = {
      key: localStorageKey(projectName, currentScriptPath),
      markdown: rawMarkdown,
    }
    draftSaveTimeoutRef.current = window.setTimeout(flushPendingDraft, 1000)

    return () => {
      // タイマーだけ止める。保留分は次の effect で上書きされるか、下の切替/アンマウントで flush される
      if (draftSaveTimeoutRef.current !== null) {
        clearTimeout(draftSaveTimeoutRef.current)
        draftSaveTimeoutRef.current = null
      }
    }
  }, [rawMarkdown, projectName, loadFailed, flushPendingDraft])

  // タブ（ファイル）切替・プロジェクト切替・アンマウントの直前に、保留中の下書きを即確定する。
  // cleanup は同じ commit の全 effect 本体より先に走るため、initialMarkdownRef がまだ旧文書の値のうちに比較できる。
  useEffect(() => flushPendingDraft, [projectName, currentScriptPath, flushPendingDraft])

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
    const savedPath = currentScriptPath
    try {
      const sha = shaRef.current
      const result = await api.putContents(projectName, savedPath, {
        content: rawMarkdown,
        sha: sha ?? undefined,
        branch: DEFAULT_BRANCH,
        message: '原稿保存',
      })
      const savedContent = rawMarkdown
      const savedKey = localStorageKey(projectName, savedPath)
      // 保存中（PUT の await 中）に別タブへ切り替わっていたら、いまのエディタ状態（sha・基準内容・
      // 未保存判定・保留中の下書き）は別文書のものなので触らない。旧タブの下書きキーだけ、
      // 保存した内容と一致するときに限って消す。
      if (currentScriptPathRef.current !== savedPath) {
        try {
          if (localStorage.getItem(savedKey) === savedContent) localStorage.removeItem(savedKey)
        } catch {
          // ignore
        }
        return
      }
      if (result.sha) {
        shaRef.current = result.sha
        setHasSha(true)
      }
      // 保存中（PUT の await 中）に追記された場合、保存したのは古い内容。下書きを消さず、
      // 未保存扱いのまま残す（保留中の下書き書き込みはそのまま走り、最新の内容を退避する）。
      initialMarkdownRef.current = savedContent
      if (rawMarkdownRef.current === savedContent) {
        setHasUnsavedChanges(false)
        try {
          localStorage.removeItem(savedKey)
        } catch {
          // ignore
        }
      } else {
        setHasUnsavedChanges(true)
        pendingDraftRef.current = {
          key: savedKey,
          markdown: rawMarkdownRef.current,
        }
        if (draftSaveTimeoutRef.current === null) {
          draftSaveTimeoutRef.current = window.setTimeout(flushPendingDraft, 1000)
        }
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
      const data = await api.getContents(projectName, currentScriptPath, DEFAULT_BRANCH)
      const markdown = data.content || ''

      // 2. 取得成功したら draft を消す（失敗時は draft を保持して再試行可能に）
      // 保留中の書き込み（タイマー）も捨てる。残すと破棄の 1 秒後に下書きが復活する。
      if (draftSaveTimeoutRef.current !== null) {
        clearTimeout(draftSaveTimeoutRef.current)
        draftSaveTimeoutRef.current = null
      }
      pendingDraftRef.current = null
      try {
        localStorage.removeItem(localStorageKey(projectName, currentScriptPath))
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
  // シーン索引。doc が変わる（ライブ再パース）たびに作り直し、NovelPlayer の jumpSceneIndex 用 effect が反映する。
  const currentDocScenes = useMemo(() => (doc ? flattenDocumentScenes(doc) : []), [doc])

  // 他の MD のシーンへ飛ぶ [ジャンプ:]・選択肢をプレビューで効かせる遅延ロード (#778)。
  // 遅延ロードの規則は PlayerScreen と共通（game/crossFileScenes.ts）。取得元は上の loadOtherDoc。
  const resolveMissingScene = useCallback(
    async (sceneId: string): Promise<EventScene[] | null> => {
      // script.md の継承値変更でキャッシュが破棄され解決が打ち切られた場合だけ、新しい epoch で1回やり直す
      // （タブ・プロジェクト切替による破棄は、もう不要な解決なのでやり直さない）
      for (let attempt = 0; attempt < 2; attempt++) {
        const entryPath = currentScriptPathRef.current
        // タブ切替の直後は doc がまだ旧文書のまま（loadChapters 完了まで）。そのまま entry に
        // すると別の文書を取り違えるので、doc が entryPath のものになるまでは解決しない（not-found）。
        if (!docRef.current || docPathRef.current !== entryPath) return null
        const epoch = otherDocsEpochRef.current
        const switchEpoch = switchEpochRef.current
        // 編集中の文書は最新の doc state を差し込んだ作業用 Map で引く（キャッシュ本体には入れない）
        const docs = new Map(loadedOtherDocsRef.current)
        docs.set(entryPath, docRef.current)
        const isStale = () => otherDocsEpochRef.current !== epoch
        const syncLazyIndex = () => {
          // 索引（jumpSceneIndex）にも反映する。編集中文書は含めない（currentDocScenes が別建て）。
          if (isStale()) return
          setLazyOtherScenes(
            buildSceneIndex(null, sortedScriptPathsRef.current, loadedOtherDocsRef.current)
          )
        }
        const result = await resolveMissingSceneAcrossDocs({
          sceneId,
          entryPath,
          sortedPaths: sortedScriptPathsRef.current,
          docs: () => docs,
          isCancelled: isStale,
          loadDoc: async (path) => {
            const loaded = await loadOtherDoc(path)
            if (loaded) docs.set(path, loaded)
            return loaded
          },
          onIndexUpdated: syncLazyIndex,
        })
        if (result) {
          // 他文書が（RPG マスター用の先行取得などで）既にキャッシュ済みで取得が走らなかった場合も、
          // 索引に反映する（onIndexUpdated は取得が走ったときしか呼ばれない）
          syncLazyIndex()
          return result
        }
        if (!isStale() || switchEpochRef.current !== switchEpoch) return null
      }
      return null
    },
    [loadOtherDoc]
  )

  // jumpSceneIndex: 編集中の文書（ライブ再パース）+ 遅延ロード済みの他文書。
  // doc の編集で currentDocScenes が変わっても、取得済みの他文書の索引は残る。
  const novelScenes = useMemo(
    () =>
      lazyOtherScenes.length === 0 ? currentDocScenes : [...currentDocScenes, ...lazyOtherScenes],
    [currentDocScenes, lazyOtherScenes]
  )

  return (
    // #239: 漫画家の机テーマ。エディタ全体に desk-paper 紙テクスチャを敷く。
    // ダーク時は .dark クラスで CSS 変数が深夜作業灯モードに切り替わる。
    <div className={`theme-desk desk-paper flex flex-col h-screen ${isDark ? 'dark' : ''}`}>
      <header
        className={`border-b ${isDark ? 'border-gray-700' : ''}`}
        style={{ borderColor: 'var(--desk-rule)' }}
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
            <h1 className="text-lg desk-heading">
              Name × Name <span style={{ color: 'var(--desk-ink-soft)' }}>- {projectName}</span>
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

        {/* #237: ファイルタブ（script.md / data.md / ...）。
            availableScripts が 2 件以上のときだけ表示する。1 件以下のときは UI を出さず、
            旧 script.md 単体運用の見た目を保つ。 */}
        {availableScripts.length > 1 && (
          <div
            className={`px-6 flex gap-1 border-t text-xs ${
              isDark ? 'border-gray-700' : 'border-blue-100'
            }`}
            role="tablist"
            aria-label="シナリオファイル"
          >
            {availableScripts.map((s) => {
              const isActive = s.path === currentScriptPath
              return (
                <button
                  key={s.path}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    if (s.path === currentScriptPath) return
                    if (
                      hasUnsavedChanges &&
                      !window.confirm(
                        '未保存の変更があります。破棄して別のファイルに切り替えますか？'
                      )
                    ) {
                      return
                    }
                    switchScript(s.path)
                    // 切替後の load は currentScriptPath を依存に入れた useEffect が処理する
                  }}
                  className="desk-tab"
                  title={s.title ?? s.path}
                >
                  {s.path}
                  {s.hidden && (
                    <span className="ml-1" style={{ color: 'var(--desk-ink-soft)' }}>
                      (hidden)
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* エディタタブ（ノベル / RPG）。
            #239 review S3: role=tab / role=tablist をファイルタブと一貫させる。 */}
        <div
          className={`px-6 flex gap-1 border-t ${isDark ? 'border-gray-700' : 'border-blue-100'}`}
          role="tablist"
          aria-label="エディタモード"
        >
          {(['novel', 'rpg'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setEditorTab(tab)}
              role="tab"
              aria-selected={editorTab === tab}
              className="desk-tab"
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
            <div className="relative w-full h-full">
              <NovelPlayer
                events={novelEvents}
                jumpSceneIndex={novelScenes}
                onResolveMissingScene={resolveMissingScene}
                aspectRatio={doc?.aspect_ratio}
                choiceStyle={doc?.choice_style ?? null}
                fontFamily={doc?.font_family ?? null}
                fontSize={doc?.font_size ?? null}
                dialogStyle={doc?.dialog_style ?? null}
                protagonist={doc?.protagonist ?? null}
                characterYRatio={doc?.character_y_ratio ?? null}
                characterHeightRatio={doc?.character_height_ratio ?? null}
                characterHeightRatios={doc?.character_height_ratios}
                characterScale={doc?.character_scale ?? null}
                characterFadeMs={doc?.character_fade_ms ?? null}
                characterMoveMs={doc?.character_move_ms ?? null}
                backgroundFadeMs={doc?.background_fade_ms ?? null}
                eventImageFadeMs={doc?.event_image_fade_ms ?? null}
                eventImageTransitionDefault={doc?.event_image_transition ?? null}
                backgroundColor={doc?.background_color ?? null}
                // SeekBar 色 (#440)。doc 由来・未指定は既定の水色。seekbar_color 指定作品は編集プレビューでも反映。
                seekbarColor={doc?.seekbar_color ?? null}
                // テロップ帯予約 (#674)。doc 由来・telop_reserve: true の作品は編集プレビューでも本文領域を狭める。
                telopReserve={doc?.telop_reserve ?? null}
                // Skip(S) は doc 由来（#310）。skip_enabled=false の作品は編集プレビューでも S を隠す。
                skipEnabled={doc?.skip_enabled ?? null}
                // デバッグ(D) は frontmatter 非依存で常時有効（編集者用 #310）。debug_enabled は /play 専用。
                debugEnabled={true}
                // 話者交代 nudge (#382)。doc 由来・既定オフの opt-in。speaker_nudge: true の作品だけ編集プレビューでも発火する。
                speakerNudge={doc?.speaker_nudge ?? null}
                // オート再生 (#436)。doc 由来・既定オフ。auto_play: true の作品だけ編集プレビューでも起動時オート ON。
                autoPlay={doc?.auto_play ?? null}
                // 画面比率に応じた画像/テキストの左右・上下分割配置 (#442)。doc 由来・既定オフ。
                // split_layout: true の作品だけ編集プレビューでも領域分割で表示する。
                splitLayout={doc?.split_layout ?? null}
                // フルキャンバス画像表示モード (#530)。doc 由来・既定オフ。
                fullscreenImage={doc?.fullscreen_image ?? null}
                // 文単位の厳密改頁 (#448)。doc 由来・既定オフ。sentence_per_page: true の作品だけ
                // 編集プレビューでも adv/novel 双方が 1 ページ=1 文で表示される。
                sentencePerPage={doc?.sentence_per_page ?? null}
                // テクスチャ拡大縮小フィルタ (#466)。doc 由来・既定オフ。pixel_art: true の作品だけ
                // 編集プレビューでも立ち絵・イベント絵が nearest-neighbor（ドット絵）表示になる。
                pixelArt={doc?.pixel_art ?? null}
                // Worker proxy 経由で assets を取得（private repo でも動作する）。
                // NOTE: EditorScreen は develop ブランチでスクリプトを編集するが、
                // assetBaseUrl はクエリパラメータを持てない設計のため ref=main 固定になる。
                // develop にしか存在しない素材は EditorScreen のプレビューに表示されない既知の制限。
                // 解決するには NovelRenderer に ref を個別パラメータとして渡す設計変更が必要（TODO）。
                assetBaseUrl={`${apiBaseUrl}/api/projects/${projectName}/assets/raw`}
                onRendererReady={(r) => {
                  novelRendererRef.current = r
                }}
              />
              {/* 動画エクスポート (#228) */}
              <button
                type="button"
                onClick={() => setExportOpen(true)}
                aria-label="動画エクスポート"
                title="動画エクスポート"
                className="absolute top-3 left-3 px-3 h-9 flex items-center gap-1 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white text-sm font-medium"
              >
                <span aria-hidden="true">●</span>
                <span>録画</span>
              </button>
              {exportOpen && (
                <VideoExportModal
                  isDark={isDark}
                  allSceneIds={allSceneIds}
                  startSceneId={exportStartSceneId}
                  endSceneId={exportEndSceneId}
                  fps={exportFps}
                  inheritFlags={exportInheritFlags}
                  status={exportStatus}
                  isRunning={exportRunning}
                  onChangeStart={setExportStartSceneId}
                  onChangeEnd={setExportEndSceneId}
                  onChangeFps={setExportFps}
                  onChangeInheritFlags={setExportInheritFlags}
                  onStart={handleStartVideoExport}
                  onClose={() => setExportOpen(false)}
                />
              )}
            </div>
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
                      onChange={(npcs: UiNpcData[]) => {
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
