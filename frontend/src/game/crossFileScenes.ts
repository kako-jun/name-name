import type { EventDocument, EventScene } from '../types'

// 複数 MD をまたぐシーン解決の共通部品 (#778)。
// PlayerScreen（再生専用画面）と EditorScreen（編集プレビュー）が同じ遅延ロード規則
// （sceneId から候補 MD を推定 → 順に取得 → 索引を作り直す）を使うために切り出した。
// 取得元（main / develop・キャッシュ・未保存の下書き）は呼び出し側の loadDoc が決める。

/** path（'a/b/c.md'）の basename（'c.md'）を返す。空 path は '' */
export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * EventDocument の全章の全シーンを 1 本の EventScene[] にフラット化する (#284)。
 * 章境界は捨てる（シーンジャンプは sceneId だけで解決されるため章の概念は不要）。
 */
export function flattenDocumentScenes(doc: EventDocument): EventScene[] {
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
export function warnDuplicateSceneIds(scenes: EventScene[]): void {
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

export function buildSceneIndex(
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

/**
 * #556: `routeNN/NN-slug.md` 命名規則（Gymnasia等）の候補パス suffix を返す。
 * sceneId が `r{route番号}-{slug}` 形式（例: `r09-01-eyes-in-the-dark`）のときだけ
 * `route{route番号}/{slug}.md`（例: `route09/01-eyes-in-the-dark.md`）を返す。
 *
 * basename だけでは判定できない: Gymnasia は `02-life.md` のような同名 slug が
 * 複数 route（route01/02/05/06）に存在するため、フォルダ名込みの suffix 一致で
 * route を区別する必要がある。
 *
 * この suffix はそのまま `path.endsWith(suffix)` で比較してはいけない:
 * `/` を挟まない文字列末尾一致だと `subroute02/02-life.md` のようなフォルダ名の
 * 部分一致まで拾ってしまう（ディレクトリ境界を認識しないため）。呼び出し側
 * （matchesRouteSuffix）で `/` 区切りの境界チェックを併用する。
 */
function inferRouteSlugPathSuffix(sceneId: string): string | null {
  const match = sceneId.match(/^r(\d+)-(.+)$/)
  if (!match) return null
  const [, routeNumber, slug] = match
  // sceneId 側の route 番号の桁表記（ゼロ埋め有無等）はフォルダ名の桁表記と
  // 一致している前提。ズレていてもクラッシュはせず、suffix 一致に失敗して
  // 呼び出し側の basename ベースの brute-force フォールバックに落ちるだけ。
  return `route${routeNumber}/${slug}.md`
}

/**
 * `routeSuffix` が `path` の末尾にディレクトリ境界を伴って一致するかを判定する。
 * 単純な `path.endsWith(routeSuffix)` は `subroute02/02-life.md` のような
 * フォルダ名末尾一致を誤検出するため、`/` 区切り（または完全一致）を必須にする。
 */
function matchesRouteSuffix(path: string, routeSuffix: string | null): boolean {
  return routeSuffix !== null && (path === routeSuffix || path.endsWith('/' + routeSuffix))
}

export function inferScriptPathsForSceneId(sceneId: string, paths: string[]): string[] {
  const basenames = new Set<string>([`${sceneId}.md`])
  const parts = sceneId.split('-')
  if (parts.length >= 2) {
    const resident = parts[0]
    const theme = parts.slice(1).join('-')
    basenames.add(`${theme}__${resident}.md`)
  }
  const routeSuffix = inferRouteSlugPathSuffix(sceneId)
  return paths.filter(
    (path) => basenames.has(basename(path)) || matchesRouteSuffix(path, routeSuffix)
  )
}

/**
 * 未ロードのシーンを、候補 MD を順に取得して解決する遅延ロードの本体 (#314, #667, #778)。
 *
 * - `docs`（ロード済み MD の path→doc）と `entryPath` / `sortedPaths` から現在の索引を作り、
 *   既に sceneId が含まれていればそれを返す。
 * - 無ければ `inferScriptPathsForSceneId` の推定候補 → 残りの未ロード MD の順に `loadDoc` で取得する。
 *   `loadDoc` は成功時に `docs` へ登録する責務を持つ（以降の索引再構築に乗る）。
 * - 1 件ロードするたびに索引を作り直して `onIndexUpdated` に通知し、見つかれば返す。全滅は null。
 */
export async function resolveMissingSceneAcrossDocs(opts: {
  sceneId: string
  entryPath: string | null
  sortedPaths: string[]
  docs: Map<string, EventDocument>
  loadDoc: (path: string) => Promise<EventDocument | null>
  onIndexUpdated?: (scenes: EventScene[]) => void
}): Promise<EventScene[] | null> {
  const { sceneId, entryPath, sortedPaths, docs, loadDoc, onIndexUpdated } = opts
  const currentScenes = buildSceneIndex(entryPath, sortedPaths, docs)
  if (currentScenes.some((s) => s.id === sceneId)) return currentScenes

  const candidatePaths = inferScriptPathsForSceneId(sceneId, sortedPaths).filter(
    (path) => !docs.has(path)
  )
  const fallbackPaths = sortedPaths.filter((path) => path !== entryPath && !docs.has(path))
  const pathsToTry = [
    ...candidatePaths,
    ...fallbackPaths.filter((p) => !candidatePaths.includes(p)),
  ]

  for (const path of pathsToTry) {
    const loaded = await loadDoc(path)
    if (!loaded) continue
    const scenes = buildSceneIndex(entryPath, sortedPaths, docs)
    warnDuplicateSceneIds(scenes)
    onIndexUpdated?.(scenes)
    if (scenes.some((s) => s.id === sceneId)) return scenes
  }
  return null
}
