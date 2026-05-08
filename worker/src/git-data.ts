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
type RefPatchResponse =
  Endpoints["PATCH /repos/{owner}/{repo}/git/refs/{ref}"]["response"]["data"];
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
 * - 存在すれば sha を返す
 * - 404 なら null を返す（新規作成扱い）
 */
async function getCurrentBlobSha(
  octokit: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | null> {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref: branch,
    });
    const data = res.data as ContentsGetResponse;
    if (Array.isArray(data)) {
      // ディレクトリなら sha 比較は無意味。null として扱い、後段で衝突判定に任せる
      return null;
    }
    return data.sha ?? null;
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

  const refPatchRes = await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommitSha,
  });
  logRateLimit("git-data.ref-patch", refPatchRes.headers as Record<string, string | number | undefined>);
  const finalCommitSha = (refPatchRes.data as RefPatchResponse).object.sha;

  return {
    path,
    sha: newBlobSha,
    commit_sha: finalCommitSha,
    branch,
  };
}
