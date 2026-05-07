// 認証ミドルウェア（スタブ）
//
// 本実装は kako-jun/name-name#110 で行う:
//   - /edit/* に対応する mutating エンドポイントは CF Access JWT または GitHub OAuth で
//     kako-jun のみ通過させる
//   - /play/* （read-only）はログイン不要
//
// 本 Issue (#106) では「口だけ」用意する。Authorization: Bearer <DEV_AUTH_TOKEN> が
// 一致した場合のみ editor 扱いとする。DEV_AUTH_TOKEN が未設定なら誰も editor になれない。

import type { Env } from "./types";

export interface AuthContext {
  isEditor: boolean;
  user: string | null;
}

/**
 * 文字列の constant-time 比較。
 * Workers ランタイムには `crypto.subtle.timingSafeEqual` 相当が無いので自前実装する。
 * 長さが異なる場合は早期 false を返すが、その時点では中身の差分情報はリークしない。
 *
 * TODO(#110): 本認証 (CF Access JWT / GitHub OAuth) に置き換える際も、
 *   ユーザ秘匿値（HMAC タグ等）を比較する箇所では必ず constant-time を維持すること。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  // TODO(#110): CF Access JWT or GitHub OAuth で検証する。
  //   その際もトークン比較は必ず constant-time を維持する（constantTimeEqual を使う）。
  const authHeader = request.headers.get("authorization");
  if (env.DEV_AUTH_TOKEN && authHeader !== null) {
    const expected = `Bearer ${env.DEV_AUTH_TOKEN}`;
    if (constantTimeEqual(authHeader, expected)) {
      return { isEditor: true, user: "kako-jun" };
    }
  }
  return { isEditor: false, user: null };
}

export function requireEditor(ctx: AuthContext): Response | null {
  if (!ctx.isEditor) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return null;
}
