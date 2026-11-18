// The REST v3 surface: repositories, branches, refs, commits, contents, labels, issues,
// comments and pull requests, in the shapes and status codes GitHub answers with.
//
// The handler is a pure function over the store: method, path segments, query, body text and
// the request's base URL in; status, JSON body and extra headers out. app.ts owns the socket.

import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { commentJson, issueJson, pullJson, repoJson, userJson } from './views.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fail(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(): RestResult {
  return fail(404, 'Not Found');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse a JSON request body: an empty body is {}, a malformed one is the protocol 400. */
function jsonBody(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return { ok: true, value: {} };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

interface Page {
  perPage: number;
  page: number;
}

/** GitHub's paging parameters: per_page defaults to 30 and caps at 100, page starts at 1. */
function pageOf(query: URLSearchParams, defaultPerPage = 30): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : defaultPerPage,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice one page and build the Link header chain GitHub sends (rel="next" while pages remain). */
function paginate<T>(items: readonly T[], page: Page, baseUrl: string, path: string, query: URLSearchParams): { slice: T[]; headers: Record<string, string> } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const headers: Record<string, string> = {};
  if (start + page.perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('per_page', String(page.perPage));
    next.set('page', String(page.page + 1));
    const last = new URLSearchParams(query);
    last.set('per_page', String(page.perPage));
    last.set('page', String(Math.ceil(items.length / page.perPage)));
    headers.link = `<${baseUrl}${path}?${next.toString()}>; rel="next", <${baseUrl}${path}?${last.toString()}>; rel="last"`;
  }
  return { slice, headers };
}

// ------------------------------------------------------------------ entry point

export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  bodyText: string,
  baseUrl: string,
): RestResult {
  const [head, ...tail] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: `${baseUrl}/api/v3/user`,
        current_user_repositories_url: `${baseUrl}/api/v3/user/repos`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        issues_url: `${baseUrl}/api/v3/repos/{owner}/{repo}/issues`,
        rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
      },
    };
  }
  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }
  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson() };
  }
  if (head === 'user' && tail[0] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = pageOf(query);
      const { slice, headers } = paginate(forge.viewerRepos(), page, baseUrl, '/api/v3/user/repos', query);
      return { status: 200, body: slice.map(repoJson), headers };
    }
    if (method === 'POST') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return fail(422, 'Repository creation failed: a name is required');
      const repo = forge.createRepo(name, {
        isPrivate: parsed.value.private === true,
        description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
      });
      if (!repo) return fail(422, 'Repository creation failed: name already exists on this account');
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }
  if (head === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const repo = forge.getRepo(owner, name);
    if (!repo) return notFound();
    return handleRepo(forge, repo, method, segments.slice(3), query, bodyText, baseUrl);
  }
  return notFound();
}

// ------------------------------------------------------------------ one repository

function handleRepo(
  forge: Forge,
  repo: RepoRec,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  bodyText: string,
  baseUrl: string,
): RestResult {
  const repoPath = `/api/v3/repos/${repo.owner}/${repo.name}`;
  if (segments.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== '') repo.name = parsed.value.name;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  const [head, ...rest] = segments;

  if (head === 'branches') {
    if (rest.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (rest.length >= 1 && method === 'GET') {
      const branch = rest.join('/');
      const sha = forge.branchTip(repo, branch);
      if (!sha) return notFound();
      return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  if (head === 'git' && rest[0] === 'refs') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) return fail(422, 'Validation Failed: ref must start with refs/');
      if (typeof sha !== 'string' || !forge.getObject(sha)) return fail(422, 'Validation Failed: sha does not name an object');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: forge.getObject(sha)!.type } } };
    }
    if (rest.length >= 3 && rest[1] === 'heads' && method === 'GET') {
      const branch = rest.slice(2).join('/');
      const sha = forge.branchTip(repo, branch);
      if (!sha) return notFound();
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } };
    }
    return notFound();
  }

  if (head === 'commits' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    const shaParam = query.get('sha') ?? undefined;
    const page = pageOf(query, 100);
    const all = forge.listCommits(repo, shaParam);
    const { slice, headers } = paginate(all, page, baseUrl, `${repoPath}/commits`, query);
    return {
      status: 200,
      headers,
      body: slice.map((entry) => {
        const parsed = forge.commitOf(entry.oid);
        return {
          sha: entry.oid,
          commit: {
            message: entry.message,
            author: identityJson(parsed?.author),
            committer: identityJson(parsed?.committer),
            tree: { sha: parsed?.tree },
          },
          parents: entry.parents.map((parent) => ({ sha: parent })),
        };
      }),
    };
  }

  if (head === 'contents') {
    return handleContents(forge, repo, method, rest, query, bodyText);
  }

  if (head === 'labels' && segments.length === 1) {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
    }
    if (method === 'POST') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return fail(422, 'Validation Failed: a label name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: the label already exists');
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      repo.labels.set(name, { name, color });
      return { status: 201, body: { name, color } };
    }
    return notFound();
  }

  if (head === 'issues') return handleIssues(forge, repo, method, rest, query, bodyText, baseUrl, repoPath);
  if (head === 'pulls') return handlePulls(forge, repo, method, rest, query, bodyText, baseUrl, repoPath);
  return notFound();
}

/** "Name <email> 1700000000 +0000" as the REST author object. */
function identityJson(line: string | undefined): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) /.exec(line ?? '');
  if (!match) return { name: '', email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

// ------------------------------------------------------------------ contents

function handleContents(
  forge: Forge,
  repo: RepoRec,
  method: string,
  pathSegments: readonly string[],
  query: URLSearchParams,
  bodyText: string,
): RestResult {
  const path = pathSegments.join('/');
  if (method === 'GET') {
    const ref = query.get('ref') ?? undefined;
    const found = forge.readPath(repo, ref, path);
    if (!found) return notFound();
    if (found.kind === 'dir') {
      return {
        status: 200,
        body: found.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.type === 'file' ? forge.getObject(entry.oid)?.data.length ?? 0 : 0,
          type: entry.type,
        })),
      };
    }
    const name = path.split('/').pop() ?? path;
    return {
      status: 200,
      body: {
        type: 'file',
        name,
        path,
        sha: found.oid,
        size: found.data.length,
        encoding: 'base64',
        content: found.data.toString('base64'),
      },
    };
  }
  if (method === 'PUT' || method === 'DELETE') {
    const parsed = jsonBody(bodyText);
    if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const expectedSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (method === 'PUT') {
      if (typeof parsed.value.content !== 'string') return fail(422, 'Validation Failed: content is required');
      const content = Buffer.from(parsed.value.content, 'base64');
      const outcome = forge.writeFile(repo, branch, path, content, message, expectedSha);
      if (!outcome.commitOid) return fail(outcome.status, outcome.detail ?? 'the write failed');
      const name = path.split('/').pop() ?? path;
      return {
        status: outcome.status,
        body: {
          content: { type: 'file', name, path, sha: outcome.blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: outcome.commitOid },
        },
      };
    }
    const outcome = forge.writeFile(repo, branch, path, null, message, expectedSha);
    if (!outcome.commitOid) return fail(outcome.status, outcome.detail ?? 'the delete failed');
    return { status: 200, body: { content: null, commit: { sha: outcome.commitOid } } };
  }
  return notFound();
}

// ------------------------------------------------------------------ issues

function handleIssues(
  forge: Forge,
  repo: RepoRec,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  bodyText: string,
  baseUrl: string,
  repoPath: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const page = pageOf(query);
      const { slice, headers } = paginate(issues, page, baseUrl, `${repoPath}/issues`, query);
      return { status: 200, body: slice.map((issue) => issueJson(repo, issue)), headers };
    }
    if (method === 'POST') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      const title = parsed.value.title;
      if (typeof title !== 'string' || title === '') return fail(422, 'Validation Failed: a title is required');
      const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return fail(422, `Validation Failed: label '${label}' does not exist`);
      }
      const issue = forge.createIssue(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', labels);
      return { status: 201, body: issueJson(repo, issue) };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      else if (parsed.value.state !== undefined) return fail(422, 'Validation Failed: state must be open or closed');
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (Array.isArray(parsed.value.labels)) {
        const labels = parsed.value.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return fail(422, `Validation Failed: label '${label}' does not exist`);
        }
        issue.labels = labels;
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map(commentJson) };
    }
    if (method === 'POST') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      if (typeof parsed.value.body !== 'string') return fail(422, 'Validation Failed: a comment body is required');
      const comment = forge.addComment(repo, issue, parsed.value.body);
      return { status: 201, body: commentJson(comment) };
    }
    return notFound();
  }
  return notFound();
}

// ------------------------------------------------------------------ pull requests

function branchNameOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function handlePulls(
  forge: Forge,
  repo: RepoRec,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  bodyText: string,
  baseUrl: string,
  repoPath: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const page = pageOf(query);
      const { slice, headers } = paginate(pulls, page, baseUrl, `${repoPath}/pulls`, query);
      return { status: 200, body: slice.map((pull) => pullJson(forge, repo, pull)), headers };
    }
    if (method === 'POST') {
      const parsed = jsonBody(bodyText);
      if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
      const head = branchNameOf(parsed.value.head);
      const base = branchNameOf(parsed.value.base);
      const title = parsed.value.title;
      if (!head || !forge.branchTip(repo, head)) return fail(422, 'Validation Failed: the head branch does not exist');
      if (!base || !forge.branchTip(repo, base)) return fail(422, 'Validation Failed: the base branch does not exist');
      if (typeof title !== 'string' || title === '') return fail(422, 'Validation Failed: a title is required');
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return fail(422, 'Validation Failed: a pull request already exists for this branch');
      const pull = forge.createPull(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', head, base);
      if (!pull) return fail(422, 'Validation Failed: the pull request could not be created');
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (!pull) return notFound();
    if (method !== 'GET') return notFound();
    const page = pageOf(query, 100);
    const files = forge.pullFiles(repo, pull);
    const { slice, headers } = paginate(files, page, baseUrl, `${repoPath}/pulls/${pull.number}/files`, query);
    return {
      status: 200,
      headers,
      body: slice.map((file) => ({
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
      })),
    };
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (!pull) return notFound();
    if (method !== 'PUT') return notFound();
    const parsed = jsonBody(bodyText);
    if (!parsed.ok) return fail(400, 'Malformed JSON in request body');
    const methodName = parsed.value.merge_method;
    const mergeMethod = methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge';
    const outcome = forge.mergePull(repo, pull, mergeMethod);
    if (!outcome.ok) return fail(405, 'Pull Request is not mergeable');
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}
