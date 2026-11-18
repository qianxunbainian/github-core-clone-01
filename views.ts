// The JSON shapes the surfaces answer with. REST, MCP and GraphQL all describe the same store
// objects; these serializers are the REST dialect of them (the shape gh and the suite's REST
// client read), and MCP returns them verbatim so an object made over MCP is the same object
// over REST, ids included.

import { VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: `repo-${repo.dbId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `issue-${repo.dbId}-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: userJson(),
    comments: issue.comments.length,
  };
}

export function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson() };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: `pr-${repo.dbId}-${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
  };
}
