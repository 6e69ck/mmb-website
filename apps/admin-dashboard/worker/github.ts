import { SignJWT, importPKCS8 } from 'jose';
import { validateStoredPageDocument, type PageDocument, type PageSlug } from '@mmb/content';
import { ApiError, type Env } from './types';

export type PageVersionSummary = {
  versionId: string;
  shortId: string;
  message: string;
  author: string;
  timestamp: string;
  source: 'github' | 'r2';
};

export function isGitHubConfigured(env: Env): boolean {
  if (!env.CONTENT_GITHUB_REPO?.trim()) return false;
  if (env.CONTENT_GITHUB_TOKEN?.trim()) return true;
  return Boolean(
    env.CONTENT_GITHUB_APP_ID?.trim() &&
      env.CONTENT_GITHUB_APP_PRIVATE_KEY?.trim() &&
      env.CONTENT_GITHUB_INSTALLATION_ID?.trim()
  );
}

function repoConfig(env: Env) {
  const repo = env.CONTENT_GITHUB_REPO?.trim() || '';
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
    throw new ApiError(503, 'GitHub content repository configuration is invalid.');
  }
  const branch = env.CONTENT_GITHUB_BRANCH?.trim() || 'main';
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new ApiError(503, 'GitHub content branch configuration is invalid.');
  }
  return { repo, branch };
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUtf8Base64(value: string): string {
  const normalized = value.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function getGitHubToken(env: Env): Promise<string> {
  if (env.CONTENT_GITHUB_TOKEN?.trim()) return env.CONTENT_GITHUB_TOKEN.trim();
  const appId = env.CONTENT_GITHUB_APP_ID?.trim();
  const privateKeyPem = env.CONTENT_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  const installationId = env.CONTENT_GITHUB_INSTALLATION_ID?.trim();
  if (!appId || !privateKeyPem || !installationId) {
    throw new ApiError(503, 'GitHub content repository credentials are not configured.');
  }
  const key = await importPKCS8(privateKeyPem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(appId)
    .sign(key);

  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'MMB-Website-Admin',
    },
  });
  if (!response.ok) {
    throw new ApiError(503, 'Could not authenticate with the GitHub content repository.');
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) throw new ApiError(503, 'GitHub authentication did not return an access token.');
  return payload.token;
}

async function githubFetch(env: Env, url: string, init: RequestInit = {}) {
  const token = await getGitHubToken(env);
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'MMB-Website-Admin',
      ...(init.headers || {}),
    },
  });
}

export async function commitPageToGitHub(
  env: Env,
  slug: PageSlug,
  doc: PageDocument,
  options: { authorEmail: string; commitMessage: string; expectedGitSha?: string }
): Promise<{ commitSha: string; fileSha: string }> {
  const { repo, branch } = repoConfig(env);
  const filePath = `pages/${slug}.json`;
  const endpoint = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  const existingRes = await githubFetch(env, `${endpoint}?ref=${encodeURIComponent(branch)}`);
  let currentFileSha: string | undefined;
  if (existingRes.ok) {
    const current = (await existingRes.json()) as { sha?: string };
    currentFileSha = current.sha;
  } else if (existingRes.status !== 404) {
    throw new ApiError(503, 'Could not read the current page state from GitHub.');
  }

  if (options.expectedGitSha && currentFileSha && options.expectedGitSha !== currentFileSha) {
    throw new ApiError(409, 'This page was updated by another administrator. Refresh before publishing.');
  }

  const authorName = options.authorEmail.split('@')[0] || 'MMB Admin';
  const body = {
    message: options.commitMessage,
    content: encodeUtf8Base64(`${JSON.stringify(doc, null, 2)}\n`),
    branch,
    ...(currentFileSha ? { sha: currentFileSha } : {}),
    committer: { name: 'MMB Admin Dashboard', email: options.authorEmail },
    author: { name: authorName, email: options.authorEmail },
  };

  const putRes = await githubFetch(env, endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (putRes.status === 409 || putRes.status === 422) {
    throw new ApiError(409, 'This page was updated by another administrator. Refresh before publishing.');
  }
  if (!putRes.ok) {
    throw new ApiError(503, 'Could not commit changes to the GitHub content repository.');
  }
  const result = (await putRes.json()) as { commit?: { sha?: string }; content?: { sha?: string } };
  if (!result.content?.sha || !result.commit?.sha) {
    throw new ApiError(503, 'GitHub commit succeeded but returned an unexpected response.');
  }
  return { commitSha: result.commit.sha, fileSha: result.content.sha };
}

export async function listPageHistoryFromGitHub(
  env: Env,
  slug: PageSlug,
  limit = 25
): Promise<PageVersionSummary[]> {
  const { repo, branch } = repoConfig(env);
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(`pages/${slug}.json`)}&sha=${encodeURIComponent(branch)}&per_page=${limit}`;
  const response = await githubFetch(env, url);
  if (response.status === 404) return [];
  if (!response.ok) throw new ApiError(503, 'Could not load version history from GitHub.');
  const commits = (await response.json()) as Array<{
    sha: string;
    commit?: { message?: string; author?: { name?: string; email?: string; date?: string } };
  }>;
  return commits.map(item => ({
    versionId: item.sha,
    shortId: item.sha.slice(0, 7),
    message: item.commit?.message || 'Update page',
    author: item.commit?.author?.email || item.commit?.author?.name || 'Admin',
    timestamp: item.commit?.author?.date || '',
    source: 'github' as const,
  }));
}

export async function getPageVersionFromGitHub(
  env: Env,
  slug: PageSlug,
  commitSha: string
): Promise<PageDocument> {
  if (!/^[a-f0-9]{7,64}$/i.test(commitSha)) {
    throw new ApiError(400, 'Invalid version identifier.');
  }
  const { repo } = repoConfig(env);
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(`pages/${slug}.json`)}?ref=${encodeURIComponent(commitSha)}`;
  const response = await githubFetch(env, url);
  if (response.status === 404) throw new ApiError(404, 'Requested version was not found in GitHub.');
  if (!response.ok) throw new ApiError(503, 'Could not load requested version from GitHub.');
  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (!payload.content || payload.encoding !== 'base64') {
    throw new ApiError(503, 'Unsupported GitHub file encoding.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8Base64(payload.content));
  } catch {
    throw new ApiError(503, 'Historical page JSON could not be parsed.');
  }
  return validateStoredPageDocument(parsed);
}
