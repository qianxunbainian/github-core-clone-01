// The forge's state and the operations every surface shares.
//
// One process holds everything in memory: a content-addressed object store (objects are shared
// across repositories, as in git), and per-repository refs, issues, pull requests and labels.
// REST, GraphQL and MCP are three views over this one store, so an object created through any
// of them reads identically through the others. Nothing touches the disk: a trial starts from
// an empty forge and ends when the process exits.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobjects.ts';

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  seq: number;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, { name: string; color: string }>;
  /** Issues and pull requests draw numbers from one sequence, as on GitHub. */
  nextNumber: number;
  seq: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** The one user the bearer token belongs to, and the other logins the directory knows. */
export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const KNOWN_LOGINS: ReadonlySet<string> = new Set(['adaiversen', 'quinnkeller', 'olgabauer']);
export const STANDARD_LABELS: readonly { name: string; color: string }[] = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

const FORGE_IDENTITY = 'Forge Bot <forge@localhost>';

function nowStamp(): string {
  const seconds = Math.floor(Date.now() / 1000);
  return `${seconds} +0000`;
}

export class Forge {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRec>();
  private readonly commitCache = new Map<string, ReturnType<typeof parseCommit>>();
  private readonly treeCache = new Map<string, ReturnType<typeof parseTree>>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private sequence = 0;

  // ------------------------------------------------------------ objects

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store every object of a received pack; returns how many were new. */
  absorbObjects(objects: ReadonlyMap<string, GitObject>): number {
    let added = 0;
    for (const [oid, object] of objects) {
      if (!this.objects.has(oid)) {
        this.objects.set(oid, object);
        added += 1;
      }
    }
    return added;
  }

  /** Parsed commit for an oid (objects are immutable, so parses are cached forever). */
  commitOf(oid: string) {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  /** Parsed tree entries for an oid, cached the same way. */
  treeOf(oid: string) {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  /** Peel a tag (or a commit) down to the commit it ultimately names. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The commit a tag object peels to, for advertisement `^{}` lines. */
  peelTag(tagOid: string): string | null {
    const object = this.objects.get(tagOid);
    if (!object || object.type !== 'tag') return null;
    return this.peelToCommit(tagOid);
  }

  /** Every commit reachable from `tips`, tips first (a visited-set walk over parents). */
  reachableCommits(tips: readonly string[]): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(tip);
      if (commit) queue.push(commit);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head];
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      const parsed = this.commitOf(oid);
      if (parsed) for (const parent of parsed.parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return new Set(this.reachableCommits([descendant])).has(ancestor);
  }

  /** A best common ancestor of two commits (the one with the smallest combined walk). */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = new Map<string, number>();
    const walkA = this.reachableCommits([a]);
    walkA.forEach((oid, index) => ancestorsOfA.set(oid, index));
    for (const oid of this.reachableCommits([b])) {
      if (ancestorsOfA.has(oid)) return oid;
    }
    return null;
  }

  /** A commit's whole tree flattened to path -> {oid, mode}; empty for a missing commit. */
  flattenTree(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    if (!commitOid) return files;
    const commit = this.commitOf(commitOid);
    if (!commit) return files;
    const walk = (treeOid: string, prefix: string): void => {
      const entries = this.treeOf(treeOid);
      if (!entries) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(commit.tree, '');
    return files;
  }

  /** Build (and store) the tree hierarchy for a flattened file map; returns the root tree id. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface DirNode {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let next = node.dirs.get(segment);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(segment, next);
        }
        node = next;
      }
      node.files.set(segments[segments.length - 1], file);
    }
    const emit = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      return this.putObject('tree', buildTree(entries));
    };
    return emit(root);
  }

  /** Create a commit object from a tree, parents and a verbatim message. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const identity = `${FORGE_IDENTITY} ${nowStamp()}`;
    return this.putObject('commit', buildCommit({
      tree,
      parents: [...parents],
      author: identity,
      committer: identity,
      message,
    }));
  }

  // ------------------------------------------------------------ repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, options: { isPrivate?: boolean; description?: string }): RepoRec | null {
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const repo: RepoRec = {
      dbId: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      // A fresh repository starts with no labels: clients create the ones they use.
      labels: new Map(),
      nextNumber: 1,
      seq: this.sequence++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** The repository the path names, or null: another owner's name space never resolves. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit the default branch names, or null while the repository is unborn. */
  defaultTip(repo: RepoRec): string | null {
    return this.branchTip(repo, repo.defaultBranch);
  }

  // ------------------------------------------------------------ contents

  /**
   * One contents-API write: replace `path` with `content` (or delete it when content is null)
   * on `branch`, as a new commit. Answers the HTTP-flavoured outcome the REST layer reports.
   */
  writeFile(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha: string | undefined,
  ): { status: number; blobOid?: string; commitOid?: string; detail?: string } {
    const isDefault = branch === repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null && !isDefault) return { status: 422, detail: `branch ${branch} does not exist` };
    const files = this.flattenTree(tip);
    const existing = files.get(path);
    let blobOid: string | undefined;
    if (content === null) {
      if (!existing) return { status: 404, detail: 'file does not exist' };
      if (expectedSha !== undefined && expectedSha !== existing.oid) return { status: 409, detail: 'the sha does not match the current file' };
      files.delete(path);
    } else {
      if (existing && expectedSha !== undefined && expectedSha !== existing.oid) {
        return { status: 409, detail: 'the sha does not match the current file' };
      }
      blobOid = this.putObject('blob', content);
      files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    }
    const tree = this.buildTreeFromFiles(files);
    const commitOid = this.makeCommit(tree, tip ? [tip] : [], message);
    repo.refs.set(ref, commitOid);
    return {
      status: content !== null && !existing ? 201 : 200,
      blobOid,
      commitOid,
    };
  }

  /** Read one path at a ref: a file's bytes, a directory's entries, or null when absent. */
  readPath(
    repo: RepoRec,
    refName: string | undefined,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: { name: string; path: string; oid: string; type: 'file' | 'dir' }[] } | null {
    const tip = refName ? this.branchTip(repo, refName) ?? this.commitish(refName, repo) : this.defaultTip(repo);
    if (!tip) {
      return path === '' ? { kind: 'dir', entries: [] } : null;
    }
    const commit = this.commitOf(tip);
    if (!commit) return null;
    if (path === '') {
      const entries = this.treeOf(commit.tree);
      if (!entries) return { kind: 'dir', entries: [] };
      return {
        kind: 'dir',
        entries: entries.map((entry) => ({
          name: entry.name,
          path: entry.name,
          oid: entry.oid,
          type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
        })),
      };
    }
    const segments = path.split('/');
    let treeOid = commit.tree;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.treeOf(treeOid);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') {
          const subEntries = this.treeOf(entry.oid);
          if (!subEntries) return { kind: 'dir', entries: [] };
          return {
            kind: 'dir',
            entries: subEntries.map((child) => ({
              name: child.name,
              path: `${path}/${child.name}`,
              oid: child.oid,
              type: child.mode === '40000' ? ('dir' as const) : ('file' as const),
            })),
          };
        }
        const blob = this.objects.get(entry.oid);
        if (!blob) return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** Resolve a branch name or a raw commit id to a commit oid (for ?ref= and ?sha=). */
  commitish(ref: string, repo: RepoRec): string | null {
    const byBranch = this.branchTip(repo, ref);
    if (byBranch) return byBranch;
    const object = this.objects.get(ref);
    if (object && object.type === 'commit') return ref;
    if (object && object.type === 'tag') return this.peelToCommit(ref);
    return null;
  }

  /** Commits on a branch, newest first, following all parents. */
  listCommits(repo: RepoRec, branch: string | undefined): { oid: string; message: string; parents: string[] }[] {
    const tip = branch ? this.commitish(branch, repo) : this.defaultTip(repo);
    if (!tip) return [];
    return this.reachableCommits([tip]).map((oid) => {
      const parsed = this.commitOf(oid)!;
      return { oid, message: parsed.message, parents: parsed.parents };
    });
  }

  // ------------------------------------------------------------ issues and pulls

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.sequence++,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (!headSha || !baseSha) return null;
    const pull: PullRec = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headShaAtCreate: headSha,
      baseShaAtCreate: baseSha,
      seq: this.sequence++,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files between a pull request's merge base and its head, with line counts. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
    const mergeBase = this.mergeBase(headTip, baseTip) ?? baseTip;
    const from = this.flattenTree(mergeBase);
    const to = this.flattenTree(headTip);
    return diffFileMaps(this, from, to);
  }

  /** Whether a pull request merges cleanly, and the merged tree when it does. */
  planMerge(repo: RepoRec, pull: PullRec): { ok: true; tree: string; headTip: string; baseTip: string } | { ok: false; reason: string } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (!headTip || !baseTip) return { ok: false, reason: 'a branch is missing' };
    if (this.isAncestor(headTip, baseTip)) return { ok: false, reason: 'already merged' };
    const base = this.mergeBase(headTip, baseTip);
    if (!base) return { ok: false, reason: 'no common ancestor' };
    if (base === baseTip) {
      const headCommit = this.commitOf(headTip);
      return { ok: true, tree: headCommit!.tree, headTip, baseTip };
    }
    const baseFiles = this.flattenTree(base);
    const headFiles = this.flattenTree(headTip);
    const targetFiles = this.flattenTree(baseTip);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      const inTarget = targetFiles.get(path);
      const headChanged = inHead?.oid !== inBase?.oid;
      const targetChanged = inTarget?.oid !== inBase?.oid;
      if (headChanged && targetChanged && inHead?.oid !== inTarget?.oid) {
        return { ok: false, reason: 'conflict' };
      }
      const winner = headChanged ? inHead : inTarget;
      if (winner) merged.set(path, winner);
    }
    return { ok: true, tree: this.buildTreeFromFiles(merged), headTip, baseTip };
  }

  /** Merge a pull request into its base branch. Answers the merge outcome. */
  mergePull(repo: RepoRec, pull: PullRec, method: 'merge' | 'squash' | 'rebase'): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pull.state !== 'open') return { ok: false, reason: 'not open' };
    const plan = this.planMerge(repo, pull);
    if (!plan.ok) return plan;
    let sha: string;
    if (method === 'merge') {
      sha = this.makeCommit(plan.tree, [plan.baseTip, plan.headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
    } else {
      sha = this.makeCommit(plan.tree, [plan.baseTip], `${pull.title} (#${pull.number})`);
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }
}

/** Line counts for one changed file: lines only in the new text count as additions. */
function lineDelta(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const countLines = (data: Buffer | null): Map<string, number> => {
    const counts = new Map<string, number>();
    if (!data) return counts;
    for (const line of data.toString('utf8').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = countLines(oldData);
  const newCounts = countLines(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

/** The file-level difference between two flattened trees. */
export function diffFileMaps(
  forge: Forge,
  from: ReadonlyMap<string, { oid: string; mode: string }>,
  to: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldData = before ? forge.getObject(before.oid)?.data ?? null : null;
    const newData = after ? forge.getObject(after.oid)?.data ?? null : null;
    const { additions, deletions } = lineDelta(oldData, newData);
    changes.push({
      path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
    });
  }
  return changes;
}
