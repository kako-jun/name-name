// kako-jun/name-name#107: API クライアントのモックテスト。
//
// fetch をモック化して、リクエスト URL / メソッド / ヘッダ / body と
// レスポンスの整形が期待どおりであることを検証する。
// 実際の Worker は呼ばない（ネットワーク非依存）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, authHeaders, createApiClient, defaultApiBaseUrl, __internal } from './client'

const BASE = 'http://api.test.local'

interface CallRecord {
  url: string
  init?: RequestInit
}

function makeMockFetch(handler: (call: CallRecord) => Response | Promise<Response>) {
  const calls: CallRecord[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const record: CallRecord = { url, init }
    calls.push(record)
    return handler(record)
  }
  return { fetchImpl, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('defaultApiBaseUrl', () => {
  it('未指定時は localhost:8787 を返す', () => {
    // VITE_API_URL は vitest 実行環境で未設定が既定
    const url = defaultApiBaseUrl()
    // CI で VITE_API_URL を入れることもあるので「localhost:8787 か空でない文字列」を許容
    expect(typeof url).toBe('string')
    expect(url.length).toBeGreaterThan(0)
  })

  // PR #120 review N3: VITE_API_URL を空にすると 'http://localhost:8787' を返すこと、
  //   値が入っていればその値を返すことを vi.stubEnv で確定させる。
  it('VITE_API_URL が空文字なら http://localhost:8787 を返す', () => {
    vi.stubEnv('VITE_API_URL', '')
    try {
      expect(defaultApiBaseUrl()).toBe('http://localhost:8787')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('VITE_API_URL に値があればその値を返す', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com')
    try {
      expect(defaultApiBaseUrl()).toBe('https://api.example.com')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('authHeaders', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('localStorage に dev_auth_token が無ければ空ヘッダ', () => {
    const headers = authHeaders() as Record<string, string>
    expect(headers).toEqual({})
  })

  it('localStorage に dev_auth_token があれば Bearer ヘッダ', () => {
    localStorage.setItem(__internal.AUTH_TOKEN_STORAGE_KEY, 'tok-xyz')
    const headers = authHeaders() as Record<string, string>
    expect(headers).toEqual({ authorization: 'Bearer tok-xyz' })
  })
})

describe('createApiClient', () => {
  afterEach(() => {
    localStorage.clear()
  })

  describe('listProjects', () => {
    it('GET /api/projects を叩いて projects 配列を返す', async () => {
      const projects = [
        { name: 'ogurasia', title: 'オグラシア', repo: 'kako-jun/ogurasia' },
        { name: 'gymnasia', title: 'Gymnasia', repo: 'kako-jun/gymnasia' },
      ]
      const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ projects }))
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      const result = await api.listProjects()

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`${BASE}/api/projects`)
      expect(calls[0].init?.method).toBeUndefined() // 既定 GET
      expect(result).toEqual(projects)
    })

    it('エラー時は ApiError を投げる', async () => {
      const { fetchImpl } = makeMockFetch(() => jsonResponse({ error: 'oops' }, 500))
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      await expect(api.listProjects()).rejects.toBeInstanceOf(ApiError)
    })
  })

  describe('getContents', () => {
    it('ref 指定時は ?ref= クエリを付ける', async () => {
      const { fetchImpl, calls } = makeMockFetch(() =>
        jsonResponse({
          path: 'chapters/all.md',
          sha: 'abc',
          content: '# hello',
          encoding: 'utf-8',
        })
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      const result = await api.getContents('ogurasia', 'chapters/all.md', 'develop')

      expect(calls[0].url).toBe(
        `${BASE}/api/projects/ogurasia/contents/chapters/all.md?ref=develop`
      )
      expect(result.sha).toBe('abc')
      expect(result.content).toBe('# hello')
    })

    it('ref 未指定時はクエリ無し、パスは percent-encode される', async () => {
      const { fetchImpl, calls } = makeMockFetch(() =>
        jsonResponse({ path: 'a/b', sha: 's', content: '', encoding: 'utf-8' })
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      await api.getContents('プロジェクト', 'dir/日本語.md')

      // / は保持され、各セグメントだけ encode される
      expect(calls[0].url).toBe(
        `${BASE}/api/projects/${encodeURIComponent('プロジェクト')}/contents/dir/${encodeURIComponent(
          '日本語.md'
        )}`
      )
    })

    it('Bearer トークンを乗せる（localStorage 経由）', async () => {
      localStorage.setItem(__internal.AUTH_TOKEN_STORAGE_KEY, 'put-token')
      const { fetchImpl, calls } = makeMockFetch(() =>
        jsonResponse({ path: 'p', sha: 's', content: '', encoding: 'utf-8' })
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      await api.getContents('p', 'a.md')

      const headers = calls[0].init?.headers as Record<string, string> | undefined
      expect(headers?.authorization).toBe('Bearer put-token')
    })
  })

  describe('putContents', () => {
    it('PUT で sha / branch / content を送る', async () => {
      const { fetchImpl, calls } = makeMockFetch(() =>
        jsonResponse({ path: 'chapters/all.md', sha: 'new-sha', commit_sha: 'commit-sha' })
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      const result = await api.putContents('proj', 'chapters/all.md', {
        content: '# new content',
        sha: 'old-sha',
        branch: 'develop',
        message: 'update',
      })

      expect(calls[0].init?.method).toBe('PUT')
      const body = JSON.parse(String(calls[0].init?.body))
      expect(body).toEqual({
        content: '# new content',
        sha: 'old-sha',
        branch: 'develop',
        message: 'update',
      })
      expect(result.sha).toBe('new-sha')
      expect(result.commit_sha).toBe('commit-sha')
    })

    it('Worker からの 409 は ApiError として伝搬する', async () => {
      const { fetchImpl } = makeMockFetch(() =>
        jsonResponse({ error: 'sha mismatch', status: 409 }, 409)
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      const err = await api
        .putContents('proj', 'p.md', { content: 'x', sha: 'old', branch: 'develop' })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
    })
  })

  describe('listAssets', () => {
    it('entries 配列を返し、空でも落ちない', async () => {
      const entries = [
        {
          name: 'logo.png',
          path: 'assets/images/logo.png',
          sha: 's1',
          size: 100,
          type: 'file' as const,
          download_url: 'https://raw/x.png',
        },
      ]
      const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ type: 'images', entries }))
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      const result = await api.listAssets('proj', 'images', { ref: 'develop' })

      expect(calls[0].url).toBe(`${BASE}/api/projects/proj/assets/images?ref=develop`)
      expect(result).toEqual(entries)
    })
  })

  describe('uploadAsset', () => {
    it('JSON + base64 で POST する', async () => {
      const { fetchImpl, calls } = makeMockFetch(() =>
        jsonResponse(
          { path: 'assets/images/x.png', sha: 'new-sha', commit_sha: 'cs', size: 1024 },
          201
        )
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })

      const result = await api.uploadAsset('proj', 'images', 'x.png', 'AAAA', 'develop', {
        message: 'add x',
      })

      expect(calls[0].url).toBe(`${BASE}/api/projects/proj/assets/images`)
      expect(calls[0].init?.method).toBe('POST')
      const body = JSON.parse(String(calls[0].init?.body))
      // PR #120 review N2: sha 未指定時は body 上にキーが現れないことを明示確認する
      //   (JSON.stringify({sha: undefined}) は "sha" を出さないので
      //   サーバ側 (Worker) は body.sha === undefined と認識する)。
      expect(body).toEqual({
        filename: 'x.png',
        contentBase64: 'AAAA',
        branch: 'develop',
        message: 'add x',
      })
      expect(body.sha).toBeUndefined()
      expect(result.sha).toBe('new-sha')
    })

    // PR #120 review N2: sha 指定時には body にそのまま乗ること。
    it('sha 指定時は body.sha を送る', async () => {
      const { fetchImpl, calls } = makeMockFetch(() =>
        jsonResponse(
          { path: 'assets/images/x.png', sha: 'updated', commit_sha: 'cs2', size: 1024 },
          200
        )
      )
      const api = createApiClient({ baseUrl: BASE, fetchImpl })
      await api.uploadAsset('proj', 'images', 'x.png', 'AAAA', 'develop', {
        message: 'overwrite',
        sha: 'existing-sha',
      })
      const body = JSON.parse(String(calls[0].init?.body))
      expect(body.sha).toBe('existing-sha')
    })
  })

  describe('compatibility stubs', () => {
    it('getStatus は { has_uncommitted: false } を返す', async () => {
      const { fetchImpl } = makeMockFetch(() => jsonResponse({}))
      const api = createApiClient({ baseUrl: BASE, fetchImpl })
      await expect(api.getStatus()).resolves.toEqual({ has_uncommitted: false })
    })

    it('commit / discard は no-op で完了する', async () => {
      const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
      const api = createApiClient({ baseUrl: BASE, fetchImpl })
      await api.commit()
      await api.discard()
      // スタブはネットワークを叩かない
      expect(calls).toHaveLength(0)
    })

    it('getTags は空配列を返す', async () => {
      const { fetchImpl } = makeMockFetch(() => jsonResponse({}))
      const api = createApiClient({ baseUrl: BASE, fetchImpl })
      await expect(api.getTags()).resolves.toEqual([])
    })
  })

  it('baseUrl の末尾スラッシュは取り除かれる', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ projects: [] }))
    const api = createApiClient({ baseUrl: `${BASE}/`, fetchImpl })
    await api.listProjects()
    expect(calls[0].url).toBe(`${BASE}/api/projects`)
  })
})

// vi.fn() を直接使ったケースも残しておく（タスク指示の vi.fn() で fetch を
// モック化する形のサンプル）
describe('vi.fn() を使った fetch モック例', () => {
  it('listProjects を vi.fn() ベースで検証', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ projects: [{ name: 'x', title: 'X', repo: 'kako-jun/x' }] })
    )
    const api = createApiClient({ baseUrl: BASE, fetchImpl: fetchSpy as unknown as typeof fetch })
    const projects = await api.listProjects()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(projects).toHaveLength(1)
  })
})
