// Git Data API 経由のアセットアップロード (#116)
//
// Contents API は base64 で 5 MiB ちょうど・>5 MiB を扱えないため、`>= MAX_ASSET_BYTES`
// は本モジュールに分岐する。フローは:
//   1. branch 省略時は GET /repos で default_branch を解決
//   2. GET /git/ref/heads/{branch} で親 commit SHA を取得
//   3. GET /git/commits/{sha} で base tree SHA を取得
//   4. POST /git/blobs で blob を作成 (encoding: base64)
//   5. POST /git/trees で base_tree を継承した新 tree を作成
//   6. POST /git/commits で親付き commit を作成
//   7. PATCH /git/refs/heads/{branch} で branch ref を進める
//
// 楽観ロックは body.sha が指定されたときのみ実施する: GET contents で現在の blob sha を
// 取り、不一致なら 409。新規作成 (Contents 404) で sha 指定があるのも 409 扱い。

import type { Endpoints } from "@octokit/types";
import { logRateLimit, normalizeError, type GitHubClient } from "./github";

export interface GitDataUploadParams {
  owner: string;
  repo: string;
  /** 例: `assets/images/title.png` （リポジトリ root からのパス） */
  path: string;
  /** base64 エンコード済みの本体（whitespace 除去はしない。呼び出し側で済ませてあること） */
  contentBase64: string;
  message: string;
  /** 省略時は default_branch を解決する */
  branch?: string;
  /** 楽観ロック用。指定があれば現在の blob sha と一致確認する */
  expectedSha?: string;
}

export interface GitDataUploadResult {
  path: string;
  /** 新しい blob の SHA */
  sha: string;
  /** ref を進めた後の commit SHA */
  commit_sha: string;
  branch: string;
}

export class GitDataConflictError extends Error {
  status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = "GitDataConflictError";
  }
}

type RepoGetResponse = Endpoints["GET /repos/{owner}/{repo}"]["response"]["data"];
type RefGetResponse = Endpoints["GET /repos/{owner}/{repo}/git/ref/{ref}"]["response"]["data"];
type CommitGetResponse =
  Endpoints["GET /repos/{owner}/{repo}/git/commits/{commit_sha}"]["response"]["data"];
type BlobCreateResponse =
  Endpoints["POST /repos/{owner}/{repo}/git/blobs"]["response"]["data"];
type TreeCreateResponse =
  Endpoints["POST /repos/{owner}/{repo}/git/trees"]["response"]["data"];
type CommitCreateResponse =
  Endpoints["POST /repos/{owner}/{repo}/git/commits"]["response"]["data"];
type ContentsGetResponse =
  Endpoints["GET /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];

async function resolveDefaultBranch(
  octokit: GitHubClient,
  owner: string,
  repo: string,
): Promise<string> {
  const res = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  logRateLimit("git-data.repo", res.headers as Record<string, string | number | undefined>);
  const data = res.data as RepoGetResponse;
  return data.default_branch;
}

/**
 * 楽観ロック用に現在の path 上の blob sha を取得する。
 *
 * Contents API を **ファイル直接** で叩くと >1 MiB のレスポンスが
 * truncate されるなど挙動差があるため、親ディレクトリの listing から
 * 該当 basename を引く方式にする (review M-2)。listing 各 entry の sha
 * はディレクトリ全体が大きくても安定して返ってくる。
 *
 * - 存在すれば sha を返す
 * - 親ディレクトリ自体が無い / 当該ファイルが listing に無い → null (新規作成扱い)
 * - 想定外の形 (path が file ではなく dir 等) は warn ログを出して null
 */
async function getCurrentBlobSha(
  octokit: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | null> {
  // 前提: path は `assets/<type>/<file>` 形式 (handleUploadAsset で構築)。
  // トップレベル (スラッシュ無し) の path は呼び出し側で発生しない想定だが、
  // 将来そうなった場合に listing 親を引けないので null に倒して新規扱いにする。
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const dirPath = path.slice(0, lastSlash);
  const baseName = path.slice(lastSlash + 1);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: dirPath,
      ref: branch,
    });
    const data = res.data as ContentsGetResponse;
    if (!Array.isArray(data)) {
      // ディレクトリのつもりが file が返ってきた異常系。比較不能なので null に倒す。
      console.warn(`[git-data] expected directory listing at ${dirPath} but got non-array`);
      return null;
    }
    const entry = data.find((e) => e.name === baseName && e.type === "file");
    return entry?.sha ?? null;
  } catch (err) {
    const ne = normalizeError(err);
    if (ne.status === 404) return null;
    throw err;
  }
}

export async function uploadAssetViaGitData(
  octokit: GitHubClient,
  params: GitDataUploadParams,
): Promise<GitDataUploadResult> {
  const { owner, repo, path, contentBase64, message, expectedSha } = params;

  const branch = params.branch ?? (await resolveDefaultBranch(octokit, owner, repo));

  if (expectedSha !== undefined) {
    const currentSha = await getCurrentBlobSha(octokit, owner, repo, path, branch);
    if (currentSha !== expectedSha) {
      throw new GitDataConflictError(
        currentSha === null
          ? `path ${path} does not exist on branch ${branch} but sha was provided (optimistic lock failed)`
          : `sha mismatch on ${path}: expected ${expectedSha} but current is ${currentSha}`,
      );
    }
  }

  const refRes = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  logRateLimit("git-data.ref", refRes.headers as Record<string, string | number | undefined>);
  const parentCommitSha = (refRes.data as RefGetResponse).object.sha;

  const commitRes = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner, repo, commit_sha: parentCommitSha },
  );
  logRateLimit("git-data.commit-get", commitRes.headers as Record<string, string | number | undefined>);
  const baseTreeSha = (commitRes.data as CommitGetResponse).tree.sha;

  const blobRes = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
    owner,
    repo,
    content: contentBase64,
    encoding: "base64",
  });
  logRateLimit("git-data.blob", blobRes.headers as Record<string, string | number | undefined>);
  const newBlobSha = (blobRes.data as BlobCreateResponse).sha;

  const treeRes = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: [
      {
        path,
        mode: "100644",
        type: "blob",
        sha: newBlobSha,
      },
    ],
  });
  logRateLimit("git-data.tree", treeRes.headers as Record<string, string | number | undefined>);
  const newTreeSha = (treeRes.data as TreeCreateResponse).sha;

  const newCommitRes = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message,
    tree: newTreeSha,
    parents: [parentCommitSha],
  });
  logRateLimit("git-data.commit-create", newCommitRes.headers as Record<string, string | number | undefined>);
  const newCommitSha = (newCommitRes.data as CommitCreateResponse).sha;

  // ref patch が 422 を返したら他デバイス/CI の concurrent push と判定し
  // GitDataConflictError に詰め替える (review M-1)。force は使わない方針。
  try {
    const refPatchRes = await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommitSha,
    });
    logRateLimit("git-data.ref-patch", refPatchRes.headers as Record<string, string | number | undefined>);
    // refPatchRes.data.object.sha は newCommitSha と一致するため改めて読まずに返す。
    // (ref patch の echo 確認は logRateLimit の HTTP 200 で十分)
    return {
      path,
      sha: newBlobSha,
      commit_sha: newCommitSha,
      branch,
    };
  } catch (err) {
    const ne = normalizeError(err);
    if (ne.status === 422) {
      throw new GitDataConflictError(
        `ref advanced concurrently on heads/${branch} (non-fast-forward); retry the upload`,
      );
    }
    throw err;
  }
}
