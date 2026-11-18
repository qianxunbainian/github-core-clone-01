// The MCP endpoint: Model Context Protocol over streamable HTTP at /mcp.
//
// Both protocol eras are served: the modern `server/discover` (which returns the server's
// identity, capabilities and supported revisions in one answer, no session) and the legacy
// `initialize` handshake. The server is stateless — no session id is issued or needed. Tools
// act on the same store as REST and GraphQL, and answer with the REST-shaped objects, so an
// issue created here is the same issue REST reads.

import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './views.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function repoArg(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = stringArg(args, 'owner') || VIEWER.login;
  const repo = forge.getRepo(owner, stringArg(args, 'repo'));
  if (!repo) throw new Error(`repository ${owner}/${stringArg(args, 'repo')} was not found`);
  return repo;
}

const OWNER_REPO_PROPS = {
  owner: { type: 'string', description: 'The repository owner login' },
  repo: { type: 'string', description: 'The repository name' },
};

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = stringArg(args, 'name');
      const repo = forge.createRepo(name, {
        isPrivate: args.private === true,
        description: stringArg(args, 'description'),
      });
      if (!repo) throw new Error(`a repository named ${name} already exists`);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: { type: 'object', properties: { ...OWNER_REPO_PROPS }, required: ['owner', 'repo'] },
    run: (forge, args) => repoJson(repoArg(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) throw new Error(`label '${label}' does not exist in ${repo.owner}/${repo.name}`);
      }
      const issue = forge.createIssue(repo, stringArg(args, 'title'), stringArg(args, 'body'), labels);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const state = stringArg(args, 'state');
      let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      return { issues: issues.map((issue) => issueJson(repo, issue)) };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number.parseInt(stringArg(args, 'issue_number'), 10);
      const issue = repo.issues.get(number);
      if (!issue) throw new Error(`issue #${number} was not found`);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch to merge from' },
        base: { type: 'string', description: 'The base branch to merge into' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const pull = forge.createPull(repo, stringArg(args, 'title'), stringArg(args, 'body'), stringArg(args, 'head'), stringArg(args, 'base'));
      if (!pull) throw new Error('the head or base branch does not exist');
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(stringArg(args, 'pull_number'), 10);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`pull request #${number} was not found`);
      const outcome = forge.mergePull(repo, pull, 'squash');
      if (!outcome.ok) throw new Error(`pull request #${number} could not be merged: ${outcome.reason}`);
      return pullJson(forge, repo, pull);
    },
  },
];

/** The tools/list answer: one constant array, byte-identical on every call. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

export interface McpOutcome {
  status: number;
  body?: unknown;
}

/** Handle one HTTP request to /mcp. `rawBody` is the request text (already read). */
export function handleMcp(forge: Forge, method: string, rawBody: string): McpOutcome {
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not valid JSON' } },
    };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => dispatch(forge, entry).body) };
  }
  const outcome = dispatch(forge, parsed);
  return outcome;
}

interface RpcOutcome {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function dispatch(forge: Forge, message: unknown): RpcOutcome {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(request.id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(request.id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(request.id, {});
    case 'tools/list':
      return rpcResult(request.id, TOOLS_LIST_RESULT);
    case 'tools/call':
      return callTool(forge, request.id, params);
    default:
      if (isNotification) return { status: 202, body: undefined };
      return rpcError(request.id, -32601, `Method not found: ${method}`);
  }
}

function callTool(forge: Forge, id: unknown, params: Record<string, unknown>): RpcOutcome {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === '');
  if (missing.length > 0) {
    return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
  }
  try {
    const result = tool.run(forge, args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (err) {
    return rpcResult(id, {
      content: [{ type: 'text', text: err instanceof Error ? err.message : 'the tool failed' }],
      isError: true,
    });
  }
}
