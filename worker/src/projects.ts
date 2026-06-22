// GET /api/projects ハンドラ
//
// プロジェクトリストはハードコード。新ゲーム追加 = 本ファイル 1 行追加 + `wrangler deploy`。
// (KV/D1 化を一度検討したが、dev 環境 (miniflare) で KV を毎回 seed する手間に対し
//  実利が薄かったので #117 close。プロジェクト数 10+ や動的追加 UI が要る段階で再考)

import type { Env, Project } from "./types";

export const PROJECTS: ReadonlyArray<Project> = [
  { name: "ogurasia", title: "おぐらじあ", repo: "kako-jun/ogurasia" },
  { name: "attama", title: "あったま空っぽのほうが", repo: "kako-jun/attama" },
  { name: "skirts-colour", title: "宇宙の果てわ、なに色か？", repo: "kako-jun/skirts-colour" },
  { name: "friday-1930", title: "Friday 19:30", repo: "kako-jun/friday-1930" },
  { name: "gymnasia", title: "Gymnasia", repo: "kako-jun/gymnasia" },
  { name: "llll-ll-media", title: "llll-ll-media", repo: "kako-jun/llll-ll-media" },
  { name: "amanuma", title: "amanuma", repo: "kako-jun/amanuma", external_url: "https://amanuma.llll-ll.com" },
  { name: "cee-lo-rings", title: "cee-lo-rings", repo: "kako-jun/cee-lo-rings", external_url: "https://cee-lo-rings.llll-ll.com" },
  { name: "anomaly2-corona-road", title: "anomaly2-corona-road", repo: "kako-jun/anomaly2-corona-road", external_url: "https://anomaly2-corona-road.llll-ll.com" },
  { name: "tacojiman", title: "tacojiman", repo: "kako-jun/tacojiman", external_url: "https://tacojiman.llll-ll.com" },
  { name: "endroll-jumpers", title: "endroll-jumpers", repo: "kako-jun/endroll-jumpers", external_url: "https://endroll-jumpers.llll-ll.com" },
  { name: "yatagarrage", title: "Yatagarrage: Hanabi Sparkout", repo: "kako-jun/yatagarrage", external_url: "https://yatagarrage.llll-ll.com" },
  { name: "legend-of-window-ninja", title: "ウィンドウ忍者伝説", repo: "kako-jun/legend-of-window-ninja", external_url: "https://kako-jun.github.io/legend-of-window-ninja/" },
  { name: "elevator-gurl", title: "ヱレベヰターガール", repo: "kako-jun/elevator-gurl", external_url: "https://elevator-gurl.llll-ll.com" },
  { name: "the-peeple", title: "The Peeple", repo: "kako-jun/the-peeple", external_url: "https://the-peeple.llll-ll.com" },
  { name: "theo-hayami", title: "せおはやみ", repo: "kako-jun/theo-hayami", scriptsDir: "content/scripts" },
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
