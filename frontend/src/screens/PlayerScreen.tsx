import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NovelPlayer from '../components/NovelPlayer'
import RPGPlayer from '../components/RPGPlayer'
import TitleOverlay from '../components/TitleOverlay'
import type { Event, EventDocument, EventScene } from '../types'
import type { RPGProject } from '../types/rpg'
import { parseMarkdown } from '../wasm/parser'
import { findRpgSceneIndex, rpgProjectFromDoc } from '../game/rpgProjectFromDoc'
import { ApiError, createApiClient, type ProjectInfo, type ScriptInfo } from '../api/client'
import { clearReadProgress, hasAnyReadProgress } from '../game/readProgress'
import { parseSceneQuery } from '../game/sceneQuery'
import { parseThemeQuery } from '../game/themeQuery'
import { useVisualViewportHeight } from '../utils/useVisualViewportHeight'
import { isEmbedded } from '../utils/isEmbedded'
import {
  getCachedParsedScriptDocument,
  getCachedScriptContent,
  putCachedParsedScriptDocument,
  putCachedScriptContent,
} from '../game/scriptContentCache'

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

function buildSceneIndex(
  entryPath: string | null,
  sortedPaths: string[],
  docs: Map<string, EventDocument>
) {
  const scenes: EventScene[] = []
  if (entryPath) {
    const entryDoc = docs.get(entryPath)
    if (entryDoc) scenes.push(...flattenDocumentScenes(entryDoc))
  }
  for (const path of sortedPaths) {
    if (path === entryPath) continue
    const doc = docs.get(path)
    if (doc) scenes.push(...flattenDocumentScenes(doc))
  }
  return scenes
}

function inferScriptPathsForSceneId(sceneId: string, paths: string[]): string[] {
  const basenames = new Set<string>([`${sceneId}.md`])
  const parts = sceneId.split('-')
  if (parts.length >= 2) {
    const resident = parts[0]
    const theme = parts.slice(1).join('-')
    basenames.add(`${theme}__${resident}.md`)
  }
  return paths.filter((path) => basenames.has(basename(path)))
}

/**
 * 対象 sceneId が属する doc（script ファイル）自身のシーンID一覧を返す (#386 confinement)。
 *
 * `?scene=` ディープリンク単独埋め込みでは、対象ファイル外（hub・他ファイル）への choice
 * ジャンプが埋め込みの外側の内容を漏らしてしまう（theo-hayami #20 の「他ファイルへは
 * HTML リンクで、埋め込み内の choice では遷移しない」という設計と矛盾する）。この一覧を
 * `NovelRenderer.setConfinedSceneIds` に渡し、圏外へのジャンプを終劇として扱わせる。
 *
 * entry doc（hub。`entryPath` が指すファイル）は候補から除外する (#386 修正2)。
 * `?scene=` が hub 自身の sceneId を指した場合、confinement を hub のシーン集合に
 * してしまうと、hub → 各お題への通常 choice 遷移まで軒並み「圏外」＝即終劇になり、
 * 汎用フローを壊す。hub 自身が指定された場合は null を返し、呼び出し側は confinement を
 * 有効化しない（無制限フロー扱い）という割り切りにする。
 *
 * それ以外で見つからなければ null（呼び出し側は confinement を有効化しない＝無制限のまま）。
 * sceneId は全 MD でグローバル一意が前提（warnDuplicateSceneIds 参照）なので、
 * 最初に見つかった（entry 以外の）doc をそのまま採用する。
 */
function findConfinedSceneIds(
  targetSceneId: string,
  docs: Map<string, EventDocument>,
  entryPath: string | null
): string[] | null {
  for (const [path, doc] of docs) {
    if (path === entryPath) continue // hub 自身は confinement の対象にしない
    const ids = flattenDocumentScenes(doc).map((s) => s.id)
    if (ids.includes(targetSceneId)) return ids
  }
  return null
}

function PlayerScreen({ projectName, apiBaseUrl, isDark, onBack }: PlayerScreenProps) {
  const viewportHeight = useVisualViewportHeight()
  // iframe 埋め込み表示か (#392)。マウント中は不変なので state 化せずレンダー時に一度評価する。
  const embedded = isEmbedded()
  // プレイヤーの見た目テーマ (#394)。App の darkMode（エディタ UI 用トグル）ではなく
  // `?theme=` で決める。既定は dark で、キャンバスの黒 (0x000000) にロード画面を継ぎ目なく
  // 繋ぐ。theo-hayami のようなライトな埋め込み先だけが `?theme=light` を明示する。
  // isEmbedded() 同様マウント中は不変なのでレンダー時に一度評価する。
  const playerDark = parseThemeQuery(window.location.search) === 'dark'
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
  const [loadDebugInfo, setLoadDebugInfo] = useState<string[]>([])
  // script.md がまだリポに無い「未投入」状態。エラーではなく案内として扱う。
  const [unpopulated, setUnpopulated] = useState(false)
  // `?scene=<sceneId>` の解決結果 (#386)。対象 sceneId が属する script を事前ロードして
  // allScenes に反映できた場合だけ sceneId を保持する。見つからない/未指定は null＝
  // NovelPlayer には initialSceneId を渡さず、現行どおりエントリ（ハブ）から開始する。
  const [startSceneId, setStartSceneId] = useState<string | null>(null)
  // confinement（在圏）一覧 (#386)。startSceneId が解決できた（＝?scene= ディープリンク単独
  // 埋め込みモード）ときだけ、対象 script ファイル自身の sceneId 一覧を持つ。null は
  // 制限なし＝通常のハブ経由フロー（listScripts 不能の単一ファイルフォールバックも、
  // 元々ファイルをまたげないため null のままでよい）。
  const [confinedSceneIds, setConfinedSceneIds] = useState<string[] | null>(null)
  const sortedPlayablePathsRef = useRef<string[]>([])
  const scriptInfoByPathRef = useRef<Map<string, ScriptInfo>>(new Map())
  const entryPathRef = useRef<string | null>(null)
  const loadedDocsRef = useRef<Map<string, EventDocument>>(new Map())
  const loadingDocsRef = useRef<Map<string, Promise<EventDocument | null>>>(new Map())

  // タイトル画面の表示状態 (#141)
  const [titleDismissed, setTitleDismissed] = useState(false)
  // 「つづきから」で開始した場合 true: ゲーム開始直後にスキップモードで未読位置まで進める
  const [startWithSkip, setStartWithSkip] = useState(false)

  const loadScriptDoc = useCallback(
    async (path: string): Promise<EventDocument | null> => {
      const cached = loadedDocsRef.current.get(path)
      if (cached) return cached
      const inFlight = loadingDocsRef.current.get(path)
      if (inFlight) return inFlight

      const promise = (async () => {
        const scriptInfo = scriptInfoByPathRef.current.get(path)
        const cacheKey = scriptInfo?.sha
          ? {
              projectName,
              ref: PUBLIC_BRANCH,
              path,
              sha: scriptInfo.sha,
            }
          : null
        let markdown: string | null = null
        let loadedFromPersistentCache = false

        if (cacheKey) {
          const cachedDoc = await getCachedParsedScriptDocument(cacheKey)
          if (cachedDoc) {
            loadedDocsRef.current.set(path, cachedDoc)
            return cachedDoc
          }

          markdown = await getCachedScriptContent(cacheKey)
          loadedFromPersistentCache = markdown !== null
        }

        if (markdown === null) {
          const contents = await api.getContents(projectName, path, PUBLIC_BRANCH)
          markdown = contents.content || ''
          const sha = cacheKey?.sha ?? contents.sha
          if (sha) {
            void putCachedScriptContent(
              {
                projectName,
                ref: PUBLIC_BRANCH,
                path,
                sha,
              },
              markdown
            )
          }
        }

        try {
          const parsed = await parseMarkdown(markdown)
          loadedDocsRef.current.set(path, parsed)
          if (cacheKey) void putCachedParsedScriptDocument(cacheKey, parsed)
          return parsed
        } catch (err) {
          if (!loadedFromPersistentCache) throw err

          console.warn(`PlayerScreen: cached script ${path} failed to parse; refetching`, err)
          const contents = await api.getContents(projectName, path, PUBLIC_BRANCH)
          const freshMarkdown = contents.content || ''
          const sha = cacheKey?.sha ?? contents.sha
          if (sha) {
            void putCachedScriptContent(
              {
                projectName,
                ref: PUBLIC_BRANCH,
                path,
                sha,
              },
              freshMarkdown
            )
          }
          const parsed = await parseMarkdown(freshMarkdown)
          loadedDocsRef.current.set(path, parsed)
          if (cacheKey) void putCachedParsedScriptDocument(cacheKey, parsed)
          return parsed
        }
      })()
        .catch((err) => {
          console.warn(`PlayerScreen: failed to load script ${path}:`, err)
          return null
        })
        .finally(() => {
          loadingDocsRef.current.delete(path)
        })
      loadingDocsRef.current.set(path, promise)
      return promise
    },
    [api, projectName]
  )

  const resolveMissingScene = useCallback(
    async (sceneId: string): Promise<EventScene[] | null> => {
      const entryPath = entryPathRef.current
      const sortedPaths = sortedPlayablePathsRef.current
      const currentScenes = buildSceneIndex(entryPath, sortedPaths, loadedDocsRef.current)
      if (currentScenes.some((s) => s.id === sceneId)) return currentScenes

      const candidatePaths = inferScriptPathsForSceneId(sceneId, sortedPaths).filter(
        (path) => !loadedDocsRef.current.has(path)
      )
      const fallbackPaths = sortedPaths.filter(
        (path) => path !== entryPath && !loadedDocsRef.current.has(path)
      )
      const pathsToTry = [
        ...candidatePaths,
        ...fallbackPaths.filter((p) => !candidatePaths.includes(p)),
      ]

      for (const path of pathsToTry) {
        const loaded = await loadScriptDoc(path)
        if (!loaded) continue
        const scenes = buildSceneIndex(entryPath, sortedPaths, loadedDocsRef.current)
        warnDuplicateSceneIds(scenes)
        const found = scenes.some((s) => s.id === sceneId)
        setLoadDebugInfo((prev) => [
          ...prev.filter((line) => !line.startsWith('lazy loaded docs:')),
          `lazy loaded docs: ${loadedDocsRef.current.size}/${sortedPaths.length}`,
        ])
        if (found) return scenes
      }
      return null
    },
    [loadScriptDoc]
  )

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      setUnpopulated(false)
      setLoadDebugInfo([])
      setStartSceneId(null)
      setConfinedSceneIds(null)
      sortedPlayablePathsRef.current = []
      scriptInfoByPathRef.current = new Map()
      entryPathRef.current = null
      loadedDocsRef.current = new Map()
      loadingDocsRef.current = new Map()
      // `?scene=<sceneId>` ディープリンク (#386)。production でも常時有効（DEV 限定の
      // debug_scene とは別系統）。読み込み完了まで NovelPlayer はマウントされないため、
      // ここで一度読めば十分（マウント後のクエリ変化への追従は対象外）。
      const sceneParam = parseSceneQuery(window.location.search)
      try {
        // 1. プロジェクト情報と scripts 一覧は独立しているので並列に開始する (#314)。
        //    hard reload の cold path で、project metadata 待ちが entry MD 取得開始を
        //    不要に遅らせないようにする。
        const projectsPromise = api.listProjects()
        const scriptsPromise = (async (): Promise<Awaited<
          ReturnType<typeof api.listScripts>
        > | null> => {
          try {
            return await api.listScripts(projectName, PUBLIC_BRANCH)
          } catch (err) {
            // listScripts 自体が使えない/失敗（旧 Worker・テストスタブ等）
            //   → 従来の単一 `script.md` 直接取得にフォールバックする。
            console.warn('PlayerScreen: listScripts unavailable, single-script mode:', err)
            return null
          }
        })()

        // 2. プロジェクト情報を取得（タイトル表示・assets ベース URL 解決用）。
        const projects = await projectsPromise
        const found = projects.find((p) => p.name === projectName) ?? null
        if (cancelled) return
        setProjectInfo(found)

        // external_url が設定されているプロジェクトはゲームサイトに直接リダイレクト
        // （PlayerScreen はノベル/RPG 専用。外部ゲームはここを経由しない）
        if (found?.external_url) {
          window.location.replace(found.external_url)
          return
        }

        // 3. main ブランチの .md を列挙して **エントリ MD を解決する** (#284 M1)。
        //    エントリ = path の basename が `script.md` のもの。無ければ sort 済み先頭。
        //    listScripts が 0 件 or 取得不能のときだけ「準備中(unpopulated)」/単一
        //    フォールバックに分岐する（直下 script.md 固定だと scriptsDir 構成の
        //    theo-hayami 等が永久に再生できない退行になるため）。
        const scripts = await scriptsPromise
        if (cancelled) return

        // 再生対象の .md パス一覧（hidden は除外）。
        const playableScripts = (scripts ?? []).filter((s) => !s.hidden)
        const playablePaths = playableScripts.map((s) => s.path)

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
          const entryScenes = flattenDocumentScenes(entryDoc)
          loadedDocsRef.current.set(SCRIPT_BASENAME, entryDoc)
          setDoc(entryDoc)
          setAllScenes(entryScenes)
          // #386: listScripts 不能時はクロスファイル解決ができないため、entry 自身の
          // シーンに含まれる場合だけ resolve する（無ければエントリ開始にフォールバック）。
          const resolvedStartSceneId =
            sceneParam && entryScenes.some((s) => s.id === sceneParam) ? sceneParam : null
          setStartSceneId(resolvedStartSceneId)
          setLoadDebugInfo([
            'mode: single script fallback',
            `entry: ${SCRIPT_BASENAME}`,
            'scripts listed: unavailable',
            'loaded docs: 1',
            `scenes: ${entryScenes.length}`,
            `events: ${flattenDocumentEvents(entryDoc).length}`,
            ...(sceneParam
              ? [
                  `scene param: ${sceneParam} → ${resolvedStartSceneId ? 'resolved' : 'not found (fallback to entry)'}`,
                ]
              : []),
          ])
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
        sortedPlayablePathsRef.current = sortedPaths
        scriptInfoByPathRef.current = new Map(playableScripts.map((s) => [s.path, s]))
        entryPathRef.current = entryPath

        // 4. 初期表示は entry MD だけを取得・parse する (#314 Phase 1)。
        //    サブ MD は選択先 sceneId が未ロードだった時点で resolver が差分取得する。
        const entryDoc = await loadScriptDoc(entryPath)
        if (cancelled) return

        if (!entryDoc) {
          // エントリ MD だけは必須。取得・parse できなければ再生不能。
          throw new Error(`PlayerScreen: entry script not loadable: ${entryPath}`)
        }

        // 5. RPG 判定・aspect_ratio / choice_style / font_family・通常再生ストリームの
        //    供給元はエントリ doc (#284 S1)。
        setDoc(entryDoc)

        // #386: `?scene=` 指定があれば、対象 sceneId が属する script を NovelPlayer
        // マウント前に事前解決・ロードする。resolveMissingScene（#314）をそのまま再利用し、
        // sceneId→script のマッピングロジック（inferScriptPathsForSceneId）を重複実装しない。
        // 見つかった場合は loadedDocsRef が更新済みなので、直後の buildSceneIndex に自然に乗る。
        // 見つからない/無効な sceneId は null のまま＝現行どおりエントリから開始する。
        let resolvedStartSceneId: string | null = null
        if (sceneParam) {
          const scenesWithTarget = await resolveMissingScene(sceneParam)
          if (cancelled) return
          if (scenesWithTarget && scenesWithTarget.some((s) => s.id === sceneParam)) {
            resolvedStartSceneId = sceneParam
          }
        }
        setStartSceneId(resolvedStartSceneId)

        // confinement（在圏）一覧 (#386)。対象 sceneId が属する doc 自身の sceneId 一覧に
        // 限定する（entry/hub 自身は候補から除外・修正2）。これにより NovelRenderer.jumpToScene
        // がこの集合外（hub・他ファイル）への choice ジャンプを終劇として扱い、単独埋め込みに
        // hub の内容が漏れるのを防ぐ（theo-hayami #20: 他ファイルへは HTML リンクで、埋め込み
        // 内の choice では遷移しない）。`?scene=` が hub 自身の sceneId を指した場合は
        // findConfinedSceneIds が null を返す＝無制限フローにフォールバックする。
        const confinedIds = resolvedStartSceneId
          ? findConfinedSceneIds(resolvedStartSceneId, loadedDocsRef.current, entryPath)
          : null
        setConfinedSceneIds(confinedIds)

        // 初期ジャンプ解決索引は entry のシーン + #386 で事前ロードした対象 script のシーン。
        // 未ロード target は NovelRenderer の missingSceneResolver が必要時に追加する (#314)。
        const scenes = buildSceneIndex(entryPath, sortedPaths, loadedDocsRef.current)
        warnDuplicateSceneIds(scenes)
        if (cancelled) return
        setAllScenes(scenes)
        setLoadDebugInfo([
          `entry: ${entryPath}`,
          `scripts listed: ${scripts.length}`,
          `playable paths: ${playablePaths.length}`,
          `initial loaded docs: ${loadedDocsRef.current.size}`,
          `persistent cache: enabled`,
          `lazy loading: enabled`,
          `scenes: ${scenes.length}`,
          ...(sceneParam
            ? [
                `scene param: ${sceneParam} → ${resolvedStartSceneId ? 'resolved' : 'not found (fallback to entry)'}`,
              ]
            : []),
          `events: ${flattenDocumentEvents(entryDoc).length}`,
        ])
      } catch (e) {
        console.error('PlayerScreen: failed to load project:', e)
        if (!cancelled) {
          setError('ゲームデータの読み込みに失敗しました')
          setDoc(null)
          setAllScenes([])
          setLoadDebugInfo([String(e instanceof Error ? e.message : e)])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [api, loadScriptDoc, projectName, resolveMissingScene])

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
  const [hasSaveData, setHasSaveData] = useState(() => hasAnyReadProgress(projectName))

  return (
    <div
      // #394: プレイヤーの見た目デフォルトは黒。dark 時はキャンバスの背景色 (0x000000) に
      // 一致する bg-black にして、ロード画面（黒）→キャンバス（黒）を継ぎ目なく繋ぐ。
      className={`flex flex-col overflow-hidden ${playerDark ? 'dark bg-black' : 'bg-white'}`}
      style={{ height: viewportHeight, minHeight: viewportHeight }}
    >
      {/* プレイヤーヘッダ（戻る＋タイトル）(#392):
          iframe 埋め込み表示時（isEmbedded()）は描画しない。theo-hayami 等の埋め込み側が
          既に HTML 額縁とタイトルを出しており、name-name トップへ戻る導線は埋め込み文脈で
          無意味・タイトル二重・没入破壊になるため（delivery ショーケースモード）。
          埋め込み条件は「iframe 内か」であって `?scene=` の有無ではない。`?scene=` は #388 の
          タイトル飛ばし（startSceneId）の条件であり、ヘッダ抑制の条件ではない。
          standalone タブで name-name.llll-ll.com/play/... を直接開いたときは name-name 自身の
          サイトなので従来どおりヘッダを出す（後方互換）。
          （#388 の TitleOverlay ゲートは deep-link 意図で startSceneId のまま。こちらは
          埋め込み文脈判定で isEmbedded()。関心が別なのでゲートも別。）
          ヘッダを外しても外枠は flex-col、<main> が flex-1 で全高を埋める（viewportHeight は
          visual viewport 全高で header 高さ前提を持たない）。 */}
      {!embedded && (
        <header
          // #394: ヘッダも playerDark に合わせる。ルート背景が黒（dark 既定）なのに
          // ヘッダだけ light 配色だと食い違うため、プレイヤーテーマに一致させる。
          className={`border-b ${playerDark ? 'border-gray-700 bg-gray-900' : 'border-blue-200 bg-blue-50'}`}
        >
          <div className="px-6 py-2 flex items-center gap-3">
            <button
              onClick={onBack}
              aria-label="プロジェクト一覧に戻る"
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                playerDark ? 'text-gray-300 hover:bg-gray-800' : 'text-gray-600 hover:bg-gray-100'
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
            <h1 className={`text-lg font-semibold ${playerDark ? 'text-white' : 'text-gray-900'}`}>
              {title}
            </h1>
          </div>
        </header>
      )}

      <main className="flex-1 overflow-hidden relative">
        {loading ? (
          // #394: ローディングはルート背景（dark 既定=黒）に乗るので playerDark で分岐。
          // dark 時は明色（text-gray-400）で黒地に可読、その後キャンバスの黒へ継ぎ目なく繋ぐ。
          <div
            className={`flex items-center justify-center h-full ${playerDark ? 'text-gray-400' : 'text-gray-600'}`}
          >
            読み込み中...
          </div>
        ) : error !== null ? (
          // #394: エラー文言もルート背景に乗るので playerDark で分岐（isDark のままだと黒地に
          // 暗文字で読めなくなる）。
          <div
            className={`flex items-center justify-center h-full ${playerDark ? 'text-gray-300' : 'text-gray-700'}`}
          >
            <p role="alert">{error}</p>
          </div>
        ) : unpopulated ? (
          // #394: 未投入案内もルート背景に乗るので playerDark で分岐。
          <div
            className={`flex flex-col items-center justify-center h-full gap-2 px-6 text-center ${
              playerDark ? 'text-gray-300' : 'text-gray-700'
            }`}
          >
            <p className="text-lg font-semibold">{title} はまだ準備中です</p>
            <p className={`text-sm ${playerDark ? 'text-gray-400' : 'text-gray-500'}`}>
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
              onResolveMissingScene={resolveMissingScene}
              // #386: `?scene=<sceneId>` ディープリンク。事前解決できた場合のみ渡し、
              // NovelPlayer マウント時に startFrom で該当シーンから開始する。
              // null（未指定/未解決）なら渡さず、現行どおりエントリから開始する。
              initialSceneId={startSceneId}
              // #386: 対象 script ファイル自身の sceneId 一覧。hub 等その集合外への choice
              // ジャンプは通常のシーン遷移ではなく終劇として扱われる（NovelPlayer 経由で
              // NovelRenderer.setConfinedSceneIds に渡る）。null（未指定/未解決）は無制限。
              confinedSceneIds={confinedSceneIds}
              assetBaseUrl={assetBaseUrl}
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
              skipEnabled={doc?.skip_enabled ?? null}
              debugEnabled={doc?.debug_enabled ?? null}
              speakerNudge={doc?.speaker_nudge ?? null}
              debugInfo={loadDebugInfo}
              docKey={projectName}
              initialSkipMode={startWithSkip}
            />
            {/* タイトル画面オーバーレイ (#141): ゲーム開始前に表示。
                #388: `?scene=` ディープリンク解決時（startSceneId 非 null＝deep-link モード）は
                タイトルを一切出さず、NovelPlayer が startFrom(initialSceneId) で開始した該当シーンを
                そのまま見せる。startSceneId はスクリプトロード後に非同期解決されるが、
                setStartSceneId と setLoading(false) は同一の非同期継続内でバッチされるため、
                loading=false になる最初のレンダー時点で startSceneId は確定済み。ここで
                render gate として直接判定すれば effect 同期のような 1 フレームのタイトルちらつきが
                出ない。deep-link モードでは TitleOverlay 自体を描かないので、onNewGame の副作用
                （clearReadProgress / renderer.restart()）が発火することも構造的にあり得ず、
                startFrom(initialSceneId) の開始位置が保たれる。
                通常フロー（`?scene=` 無し＝startSceneId null）は従来どおりタイトルを出す（後方互換）。 */}
            {startSceneId === null && !titleDismissed && (
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
                        setDocKey?: (docKey: string) => void
                        restart?: () => void
                      }
                    }
                  ).__renderer
                  renderer?.setDocKey?.(projectName)
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
