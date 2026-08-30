// GitHub transport (ADR 0004): REST via Node's global fetch. The token comes
// from the environment the user already has — GITHUB_TOKEN, else the logged-in
// gh CLI (`gh auth token`). Login/OAuth is NOT this plugin's job.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { parseManifest, type SnapshotManifest } from './manifest.ts'

const execFileP = promisify(execFile)

const API_BASE = 'https://api.github.com'

export class GitHubError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/** Resolve a token: GITHUB_TOKEN env first, then the gh CLI's stored token. */
export async function getGithubToken(): Promise<string> {
  const env = process.env.GITHUB_TOKEN?.trim()
  if (env !== undefined && env !== '') return env
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 10_000 })
    const token = stdout.trim()
    if (token !== '') return token
  } catch {
    // fall through to the error below
  }
  throw new GitHubError(
    'GitHub 凭据不可用：未设置 GITHUB_TOKEN，且 gh CLI 未登录。GitHub 登录不在本插件职责内 —— 请先 `gh auth login` 或设置 GITHUB_TOKEN。',
  )
}

export interface GhRequestResult {
  status: number
  json: unknown
}

export class GhClient {
  private readonly token: string
  private readonly pluginVersion: string

  constructor(token: string, pluginVersion: string) {
    this.token = token
    this.pluginVersion = pluginVersion
  }

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<GhRequestResult> {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `dsh-vault/${this.pluginVersion}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json: unknown = undefined
    const text = await response.text()
    if (text !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        json = { message: text }
      }
    }
    if (!response.ok) {
      const message = (json as { message?: string } | undefined)?.message ?? response.statusText
      if (response.status === 401) {
        throw new GitHubError(`GitHub 认证失败（401）：token 无效或过期 —— ${message}`, 401)
      }
      throw new GitHubError(`GitHub API ${method} ${path} 失败（${response.status}）：${message}`, response.status)
    }
    return { status: response.status, json }
  }
}

export interface ResolvedRepo {
  owner: string
  repo: string
  fullName: string
  created: boolean
}

/**
 * Resolve the vault repo, optionally creating it when missing (backup does;
 * restore must never create). Default name: dsh-backup-<login>; an
 * `owner/name` override is honored but only created when owner is the
 * authenticated user.
 */
export async function resolveRepo(client: GhClient, override: string, create: boolean): Promise<ResolvedRepo> {
  const me = (await client.request('GET', '/user')).json as { login: string }
  const login = me.login
  const spec = override.trim() !== '' ? override.trim() : `dsh-backup-${login}`
  const slash = spec.indexOf('/')
  const owner = slash === -1 ? login : spec.slice(0, slash)
  const repo = slash === -1 ? spec : spec.slice(slash + 1)

  try {
    await client.request('GET', `/repos/${owner}/${repo}`)
    return { owner, repo, fullName: `${owner}/${repo}`, created: false }
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error
    if (!create) {
      throw new GitHubError(`仓库 ${owner}/${repo} 不存在（还没有任何机器备份过？先在源机器上 /vault backup）`)
    }
  }

  if (owner !== login) {
    throw new GitHubError(`仓库 ${owner}/${repo} 不存在，且它不在你的账号下 —— 无法自动创建。请先手动创建 private 仓库，或用 /vault set repo 改回自己的仓库。`)
  }
  await client.request('POST', '/user/repos', {
    name: repo,
    private: true,
    description: 'dsh-vault: encrypted dsh config backups',
  })
  return { owner, repo, fullName: `${owner}/${repo}`, created: true }
}

/** Put (create or update) one file via the Contents API. */
export async function putFile(
  client: GhClient,
  fullName: string,
  path: string,
  content: Buffer,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  let sha: string | undefined
  try {
    const existing = (await client.request('GET', `/repos/${fullName}/contents/${encodePath(path)}`, undefined, signal)).json as { sha?: string }
    sha = existing.sha
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error
  }
  await client.request(
    'PUT',
    `/repos/${fullName}/contents/${encodePath(path)}`,
    { message, content: content.toString('base64'), ...(sha !== undefined ? { sha } : {}) },
    signal,
  )
}

/** Get one file's bytes; undefined when it does not exist (404). */
export async function getFile(client: GhClient, fullName: string, path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  let json: { content?: string; encoding?: string }
  try {
    json = (await client.request('GET', `/repos/${fullName}/contents/${encodePath(path)}`, undefined, signal)).json as { content?: string; encoding?: string }
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined
    throw error
  }
  if (json.encoding !== 'base64' || typeof json.content !== 'string') {
    throw new GitHubError(`GitHub 返回的 ${path} 不是 base64 内容（可能超过 Contents API 大小限制）`)
  }
  return Buffer.from(json.content, 'base64')
}

export interface MachineSnapshotSummary {
  machine: string
  manifest?: SnapshotManifest
}

/** List all machines in the vault with their (plaintext) manifests. */
export async function listMachines(client: GhClient, fullName: string, signal?: AbortSignal): Promise<MachineSnapshotSummary[]> {
  let entries: { name: string; type: string }[]
  try {
    const json = (await client.request('GET', `/repos/${fullName}/contents/machines`, undefined, signal)).json
    if (!Array.isArray(json)) return []
    entries = json as { name: string; type: string }[]
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return []
    throw error
  }
  const out: MachineSnapshotSummary[] = []
  for (const entry of entries) {
    if (entry.type !== 'dir') continue
    let manifest: SnapshotManifest | undefined
    try {
      const raw = await getFile(client, fullName, `machines/${entry.name}/manifest.json`, signal)
      if (raw !== undefined) manifest = parseManifest(JSON.parse(raw.toString('utf8')))
    } catch {
      manifest = undefined
    }
    out.push({ machine: entry.name, manifest })
  }
  return out
}

/** SHA-256 of the blob, recorded in the manifest for download integrity. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
