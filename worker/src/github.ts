// octokit ラッパー
//
// - GitHub PAT は env.GITHUB_TOKEN から読む（ブラウザに渡らない）
// - レスポンスヘッダの x-ratelimit-remaining を console.log に出す
// - dev で corp proxy 越しに繋ぐときは env.GITHUB_API_BASE を host 側中継に向ける

import { Octokit } from "@octokit/core";
import type { Env } from "./types";

export type GitHubClient = Octokit;

// GITHUB_TOKEN 未設定の警告は同一プロセス内で 1 回だけ出す。
let warnedMissingToken = false;
let warnedApiBase = false;

export function createGitHub(env: Env): GitHubClient {
  if (!env.GITHUB_TOKEN) {
    if (!warnedMissingToken) {
      console.warn("[github] GITHUB_TOKEN is not set");
      warnedMissingToken = true;
    }
  }
  if (env.GITHUB_API_BASE && !warnedApiBase) {
    console.log(`[github] using GITHUB_API_BASE=${env.GITHUB_API_BASE}`);
    warnedApiBase = true;
  }
  return new Octokit({
    auth: env.GITHUB_TOKEN,
    userAgent: "name-name-api/0.1.0",
    baseUrl: env.GITHUB_API_BASE ?? "https://api.github.com",
  });
}

/**
 * octokit のレスポンス headers から rate limit を読み出してログに流す。
 * octokit の戻り値型に headers が含まれるが、ヘッダ名が小文字 / 大文字混在するので両対応。
 */
export function logRateLimit(
  scope: string,
  headers: Record<string, string | number | undefined> | undefined,
): void {
  if (!headers) return;
  const remaining =
    headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
  const limit = headers["x-ratelimit-limit"] ?? headers["X-RateLimit-Limit"];
  const reset = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (remaining !== undefined) {
    console.log(
      `[github:${scope}] rate-limit remaining=${remaining} limit=${limit ?? "?"} reset=${reset ?? "?"}`,
    );
  }
}

/**
 * @octokit/core が投げる RequestError を吸収して { status, message, response? } に正規化する。
 */
export interface NormalizedGitHubError {
  status: number;
  message: string;
  responseHeaders?: Record<string, string | number | undefined>;
}

export function normalizeError(err: unknown): NormalizedGitHubError {
  if (typeof err === "object" && err !== null && "status" in err) {
    const e = err as {
      status?: number;
      message?: string;
      response?: { headers?: Record<string, string | number | undefined> };
    };
    return {
      status: typeof e.status === "number" ? e.status : 500,
      message: e.message ?? "GitHub API error",
      responseHeaders: e.response?.headers,
    };
  }
  return { status: 500, message: "Unknown error" };
}
