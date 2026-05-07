// GET /api/projects ハンドラ
//
// 当面はハードコードのリスト。
// TODO(#117): PROJECTS リストの KV / D1 化。その時に Map<name, Project> に切り替えて
//   findProject を O(1) にする。現状は 4 件なので線形探索で十分。

import type { Env, Project } from "./types";

export const PROJECTS: ReadonlyArray<Project> = [
  { name: "ogurasia", title: "オグラシア", repo: "kako-jun/ogurasia" },
  { name: "skirts-colour", title: "宇宙色", repo: "kako-jun/skirts-colour" },
  { name: "friday-1930", title: "Friday 1930", repo: "kako-jun/friday-1930" },
  { name: "gymnasia", title: "Gymnasia", repo: "kako-jun/gymnasia" },
];

export function findProject(name: string): Project | undefined {
  // TODO(#117): KV/D1 化の際は Map ベースに置き換える
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
