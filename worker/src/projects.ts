// GET /api/projects ハンドラ
//
// プロジェクトリストはハードコード。新ゲーム追加 = 本ファイル 1 行追加 + `wrangler deploy`。
// (KV/D1 化を一度検討したが、dev 環境 (miniflare) で KV を毎回 seed する手間に対し
//  実利が薄かったので #117 close。プロジェクト数 10+ や動的追加 UI が要る段階で再考)

import type { Env, Project } from "./types";

export const PROJECTS: ReadonlyArray<Project> = [
  { name: "ogurasia", title: "オグラシア", repo: "kako-jun/ogurasia" },
  { name: "skirts-colour", title: "宇宙色", repo: "kako-jun/skirts-colour" },
  { name: "friday-1930", title: "Friday 1930", repo: "kako-jun/friday-1930" },
  { name: "gymnasia", title: "Gymnasia", repo: "kako-jun/gymnasia" },
  { name: "llll-ll-media", title: "llll-ll-media", repo: "kako-jun/llll-ll-media" },
];

export function findProject(name: string): Project | undefined {
  return PROJECTS.find((p) => p.name === name);
}

export function splitRepo(project: Project): { owner: string; repo: string } {
  const [owner, repo] = project.repo.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`invalid project.repo: ${project.repo}`);
  }
  return { owner, repo };
}

export async function handleListProjects(_request: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ projects: PROJECTS }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
