// A GraphQL v4 executor for the documents gh and github-mcp-server actually send.
//
// This is a small hand-rolled parser (operations, variables, aliases, arguments with inline
// enums/lists/input objects, inline fragments) plus a schema table and resolvers over the
// forge's store. It implements the field surface the clients probe and use — viewer,
// repository, issues, pull requests, node(id:), the __type introspection gh feature-detects
// with, and the create/close/merge/comment mutations — and answers GraphQL-style: HTTP 200
// with {data, errors}, errors naming an unknown field rather than failing the request.

import { VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// ------------------------------------------------------------------ global ids

/** Relay-style global ids: opaque, stable, and decodable by the forge alone. */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ schema tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'createdAt', 'updatedAt', 'comments', 'labels', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The child type a field resolves to, where the executor needs it (lists carry [Type]). */
const FIELD_TYPES: Readonly<Record<string, string>> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.__type': '__Type',
  'Mutation.createIssue': 'CreateIssuePayload',
  'Mutation.closeIssue': 'CloseIssuePayload',
  'Mutation.createPullRequest': 'CreatePullRequestPayload',
  'Mutation.mergePullRequest': 'MergePullRequestPayload',
  'Mutation.addComment': 'AddCommentPayload',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'IssueConnection.nodes': '[Issue]',
  'IssueConnection.pageInfo': 'PageInfo',
  'IssueConnection.edges': '[IssueEdge]',
  'IssueEdge.node': 'Issue',
  'PullRequestConnection.nodes': '[PullRequest]',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestConnection.edges': '[PullRequestEdge]',
  'PullRequestEdge.node': 'PullRequest',
  'PullRequest.files': 'PullRequestFileConnection',
  'PullRequestFileConnection.nodes': '[PullRequestChangedFile]',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'CommentEdge',
  'CommentEdge.node': 'IssueComment',
  '__Type.fields': '[__Field]',
  '__Type.enumValues': '[__EnumValue]',
};

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

const PUNCTUATORS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if (PUNCTUATORS.has(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const text = source.slice(index + 3, end < 0 ? source.length : end);
        tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let cursor = index + 1;
      let text = '';
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\' && cursor + 1 < source.length) {
          text += source[cursor + 1];
          cursor += 2;
        } else {
          text += source[cursor];
          cursor += 1;
        }
      }
      tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      index = cursor + 1;
      continue;
    }
    const rest = source.slice(index);
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (name) {
      tokens.push(name[0]);
      index += name[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      tokens.push(number[0]);
      index += number[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in the document`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private next(): string {
    const token = this.tokens[this.position++];
    if (token === undefined) throw new Error('unexpected end of the document');
    return token;
  }

  private expect(token: string): void {
    const found = this.next();
    if (found !== token) throw new Error(`expected ${token}, found ${found}`);
  }

  private skip(token: string): boolean {
    if (this.peek() === token) {
      this.position += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.position < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== undefined) name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        this.next(); // the type condition
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (!this.skip(')')) {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.skip('@')) {
      this.next(); // directive name
      if (this.peek() === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expect('(');
    while (!this.skip(')')) {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (!this.skip(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skip('}')) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d/.test(token) || /^-?\d+(\.\d+)?[eE]/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.skip('}')) {
      if (this.skip('...')) {
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.skip(':')) {
        alias = name;
        name = this.next();
      }
      const args = this.peek() === '(' ? this.parseArguments() : [];
      this.skipDirectives();
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }
}

// ------------------------------------------------------------------ execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

interface Source {
  type: string;
  value: unknown;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = valueOf(field.value, variables);
      return object;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, ctx.variables);
  return args;
}

// Typed views over the store records the resolvers hand around.
interface RepoSource { repo: RepoRec }
interface IssueSource { repo: RepoRec; issue: IssueRec }
interface PullSource { repo: RepoRec; pull: PullRec }

function executeSelectionSet(source: Source, selections: readonly SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (!selection.typeCondition || selection.typeCondition === source.type) {
        Object.assign(out, executeSelectionSet(source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(source, fragment, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(source, selection, ctx);
  }
  return out;
}

function executeField(source: Source, field: FieldNode, ctx: Ctx): unknown {
  const knownFields = TYPE_FIELDS[source.type];
  if (knownFields && !knownFields.includes(field.name)) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.type}'` });
    return null;
  }
  const raw = resolveField(source, field.name, argsOf(field, ctx), ctx);
  if (raw === null || raw === undefined) return null;
  if (!field.selectionSet) return raw;
  const childType = FIELD_TYPES[`${source.type}.${field.name}`];
  if (Array.isArray(raw)) {
    const itemType = (childType ?? '').replace(/^\[|\]$/g, '');
    return raw.map((item) => executeSelectionSet({ type: itemType, value: item }, field.selectionSet!, ctx));
  }
  if (childType) {
    return executeSelectionSet({ type: childType, value: raw }, field.selectionSet, ctx);
  }
  // A scalar answered with a selection set (a node(id:) whose type is decided at run time):
  // the raw value is already a Source in that case.
  if (typeof raw === 'object' && raw !== null && '__sourceType' in (raw as Record<string, unknown>)) {
    const tagged = raw as { __sourceType: string; value: unknown };
    return executeSelectionSet({ type: tagged.__sourceType, value: tagged.value }, field.selectionSet, ctx);
  }
  return raw;
}

// ------------------------------------------------------------------ resolvers

function resolveField(source: Source, name: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const { forge } = ctx;
  switch (source.type) {
    case 'Query':
      return resolveQuery(name, args, ctx);
    case 'Mutation':
      return resolveMutation(name, args, ctx);
    case 'User':
      return { login: VIEWER.login, id: globalId('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email, url: '' }[name] ?? null;
    case 'Repository':
      return resolveRepository((source.value as RepoSource).repo, name, args, ctx);
    case 'Issue': {
      const { repo, issue } = source.value as IssueSource;
      switch (name) {
        case 'id': return globalId('Issue', repo.dbId, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source.value as PullSource;
      switch (name) {
        case 'id': return globalId('PullRequest', repo.dbId, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return forge.planMerge(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const files = forge.pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : files.length;
          return { __connection: 'files', files: files.slice(0, first), total: files.length };
        }
        default: return null;
      }
    }
    case 'Ref': {
      const ref = source.value as { name: string };
      return name === 'name' ? ref.name : null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const connection = source.value as { nodes: unknown[]; pageInfo?: unknown; total: number };
      if (name === 'nodes') return connection.nodes;
      if (name === 'totalCount') return connection.total;
      if (name === 'pageInfo') return connection.pageInfo ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      if (name === 'edges') return connection.nodes.map((node) => ({ node, cursor: '' }));
      return null;
    }
    case 'PullRequestFileConnection': {
      const connection = source.value as { __connection: string; files: { path: string; additions: number; deletions: number }[]; total: number };
      if (name === 'nodes') return connection.files;
      if (name === 'totalCount') return connection.total;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = source.value as { path: string; additions: number; deletions: number };
      return file[name as 'path' | 'additions' | 'deletions'] ?? null;
    }
    case 'PageInfo': {
      const pageInfo = source.value as Record<string, unknown>;
      return pageInfo[name] ?? null;
    }
    case 'IssueComment': {
      const comment = source.value as { id: string; body: string };
      return name === 'id' ? comment.id : name === 'body' ? comment.body : null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = source.value as { issue: IssueSource };
      return name === 'issue' ? payload.issue : null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = source.value as { pullRequest: PullSource };
      return name === 'pullRequest' ? payload.pullRequest : null;
    }
    case 'AddCommentPayload': {
      const payload = source.value as { commentEdge: { node: { id: string; body: string } } };
      return name === 'commentEdge' ? payload.commentEdge : null;
    }
    case 'CommentEdge': {
      const edge = source.value as { node: unknown };
      return name === 'node' ? edge.node : name === 'cursor' ? '' : null;
    }
    case '__Type': {
      const typeName = (source.value as { name: string }).name;
      if (name === 'name') return typeName;
      if (name === 'kind') return ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = TYPE_FIELDS[typeName];
        return fields ? fields.map((fieldName) => ({ name: fieldName })) : null;
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[typeName];
        return values ? values.map((value) => ({ name: value })) : null;
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      const entry = source.value as { name: string };
      return name === 'name' ? entry.name : null;
    }
    default:
      return null;
  }
}

function resolveQuery(name: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const { forge } = ctx;
  switch (name) {
    case 'viewer':
      return { login: VIEWER.login };
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = forge.getRepo(owner, repoName);
      return repo ? { repo } : null;
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = [...forge.repos.values()].find((candidate) => candidate.dbId === Number(parsed.parts[0]));
        return repo ? { __sourceType: 'Repository', value: { repo } } : null;
      }
      if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
        const repo = [...forge.repos.values()].find((candidate) => candidate.dbId === Number(parsed.parts[0]));
        if (!repo) return null;
        const number = Number(parsed.parts[1]);
        if (parsed.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue ? { __sourceType: 'Issue', value: { repo, issue } } : null;
        }
        const pull = repo.pulls.get(number);
        return pull ? { __sourceType: 'PullRequest', value: { repo, pull } } : null;
      }
      return null;
    }
    case '__type': {
      const typeName = typeof args.name === 'string' ? args.name : '';
      if (!TYPE_FIELDS[typeName] && !ENUM_VALUES[typeName]) return null;
      return { name: typeName };
    }
    default:
      return null;
  }
}

function resolveRepository(repo: RepoRec, name: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const { forge } = ctx;
  switch (name) {
    case 'id': return globalId('Repository', repo.dbId);
    case 'databaseId': return repo.dbId;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'owner': return { login: repo.owner };
    case 'defaultBranchRef': {
      const tip = forge.defaultTip(repo);
      return tip ? { name: repo.defaultBranch } : null;
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'hasPullRequestsEnabled': return true;
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(number);
      return issue ? { repo, issue } : null;
    }
    case 'issues': return issuesConnection(repo, args);
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.get(number);
      return pull ? { repo, pull } : null;
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' ? args.first : 30;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
      return {
        nodes: pulls.slice(0, first).map((pull) => ({ repo, pull })),
        total: pulls.length,
        pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    default: return null;
  }
}

/** repository.issues with the states filter, CREATED_AT ordering and cursor paging. */
function issuesConnection(repo: RepoRec, args: Record<string, unknown>): unknown {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  if (states) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));

  const first = typeof args.first === 'number' ? args.first : issues.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = Buffer.from(args.after, 'base64url').toString('utf8');
    const afterNumber = Number(decoded.replace('cursor:', ''));
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const page = issues.slice(start, start + first);
  const last = page[page.length - 1];
  return {
    nodes: page.map((issue) => ({ repo, issue })),
    total: issues.length,
    pageInfo: {
      hasNextPage: start + page.length < issues.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? Buffer.from(`cursor:${page[0].number}`).toString('base64url') : null,
      endCursor: last ? Buffer.from(`cursor:${last.number}`).toString('base64url') : null,
    },
  };
}

function repoByGlobalId(forge: Forge, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return [...forge.repos.values()].find((candidate) => candidate.dbId === Number(parsed.parts[0])) ?? null;
}

function resolveMutation(name: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const { forge } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const repo = repoByGlobalId(forge, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'createIssue: the repository id does not name a repository' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = forge.createIssue(repo, title, body, []);
      return { issue: { repo, issue } };
    }
    case 'closeIssue': {
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed ? [...forge.repos.values()].find((candidate) => candidate.dbId === Number(parsed.parts[0])) : undefined;
      const issue = repo && parsed ? repo.issues.get(Number(parsed.parts[1])) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'closeIssue: the issue id does not name an issue' });
        return null;
      }
      issue.state = 'closed';
      return { issue: { repo, issue } };
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(forge, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest: the repository id does not name a repository' });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = forge.createPull(repo, title, body, head, base);
      if (!pull) {
        ctx.errors.push({ message: 'createPullRequest: the head or base branch does not exist' });
        return null;
      }
      return { pullRequest: { repo, pull } };
    }
    case 'mergePullRequest': {
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed ? [...forge.repos.values()].find((candidate) => candidate.dbId === Number(parsed.parts[0])) : undefined;
      const pull = repo && parsed ? repo.pulls.get(Number(parsed.parts[1])) : undefined;
      if (!repo || !pull) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request id does not name a pull request' });
        return null;
      }
      const methodText = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const method = methodText === 'SQUASH' ? 'squash' : methodText === 'REBASE' ? 'rebase' : 'merge';
      const outcome = forge.mergePull(repo, pull, method);
      if (!outcome.ok) {
        ctx.errors.push({ message: `mergePullRequest: ${outcome.reason}` });
        return null;
      }
      return { pullRequest: { repo, pull } };
    }
    case 'addComment': {
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed ? [...forge.repos.values()].find((candidate) => candidate.dbId === Number(parsed.parts[0])) : undefined;
      const issue = repo && parsed ? repo.issues.get(Number(parsed.parts[1])) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'addComment: the subject id does not name an issue' });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = forge.addComment(repo, issue, body);
      return { commentEdge: { node: { id: globalId('IssueComment', comment.id), body: comment.body } } };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ entry point

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one operation document; answers the {data, errors?} envelope. */
export function executeGraphQL(forge: Forge, request: GraphQLRequest): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'the document did not parse' }] };
  }
  const operation = request.operationName
    ? document.operations.find((candidate) => candidate.name === request.operationName) ?? document.operations[0]
    : document.operations[0];
  if (!operation) return { errors: [{ message: 'the document holds no operation' }] };
  const ctx: Ctx = {
    forge,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet({ type: rootType, value: {} }, operation.selectionSet, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
