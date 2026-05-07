// GET /api/projects ハンドラ
//
// 当面はハードコードのリスト。将来的に KV/D1 への移行を別 Issue で検討する。

import type { Env, Project } from "./types";

export const PROJECTS: ReadonlyArray<Project> = [
  { name: "ogurasia", title: "オグラシア", repo: "kako-jun/ogurasia" },
  { name: "skirts-colour", title: "宇宙色", repo: "kako-jun/skirts-colour" },
  { name: "friday-1930", title: "Friday 1930", repo: "kako-jun/friday-1930" },
  { name: "gymnasia", title: "Gymnasia", repo: "kako-jun/gymnasia" },
];

export function findProject(name: string): Project | undefined {
  return PROJECTS.find((p) => p.name === name);
}

export function splitRepo(project: Project): { owner: string; repo: string } {
  const [owner, repo] = project.repo.split("/", 2);
  return { owner, repo };
}

export async function handleListProjects(_request: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ projects: PROJECTS }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
