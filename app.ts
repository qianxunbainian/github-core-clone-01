// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and MCP
// over a single in-memory store (store.ts). main.ts owns the lifecycle (bind, register, wait
// for done); this module owns the routing.
//
// Cross-cutting rules the suite checks as protocol, applied to every route:
//   - every answer carries a non-empty X-GitHub-Request-Id header;
//   - API answers are JSON, never HTML, and errors are objects with a string message;
//   - every route except /healthz requires the trial's bearer token (MAKEFUN_SHOP_TOKEN);
//     a missing or wrong token is a 401 with a JSON message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPackV0, uploadPackV2 } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(forge, expectedToken, req, res);
      } catch {
        // A handler failure is a 500 with a JSON message, never a hung or crashed server.
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

async function route(forge: Forge, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot check: open, no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else needs the trial's bearer token.
  if (expectedToken !== '') {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
  }

  const baseUrl = `http://${req.headers.host ?? 'localhost'}`;

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const text = (await readBody(req)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON in request body' });
      return;
    }
    if (Array.isArray(parsed)) {
      const answers = parsed.map((entry) => executeGraphQL(forge, isRecord(entry) ? (entry as GraphQLRequest) : { query: '' }));
      sendJson(res, 200, answers);
      return;
    }
    if (!isRecord(parsed) || typeof parsed.query !== 'string') {
      sendJson(res, 400, { message: 'A GraphQL request needs a query string' });
      return;
    }
    sendJson(res, 200, executeGraphQL(forge, parsed as GraphQLRequest));
    return;
  }

  // MCP.
  if (path === '/mcp') {
    const text = method === 'POST' ? (await readBody(req)).toString('utf8') : '';
    const outcome = handleMcp(forge, method, text);
    if (outcome.body === undefined) {
      res.writeHead(outcome.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    // DELETE carries a body too on the contents route ({message, sha}); GET never does.
    const bodyText = method === 'GET' ? '' : (await readBody(req)).toString('utf8');
    const result = handleRest(forge, method, segments, url.searchParams, bodyText, baseUrl);
    if (result.status === 204 || result.body === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, {
      ...(segments.length === 0 && method === 'GET' ? { 'x-oauth-scopes': 'repo, read:org' } : {}),
      ...(result.headers ?? {}),
    });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const [, owner, repoName, service] = gitMatch;
    const repo = forge.getRepo(decodeSegment(owner), decodeSegment(repoName));
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (service === 'info/refs' && method === 'GET') {
      const serviceName = url.searchParams.get('service');
      if (serviceName !== 'git-upload-pack' && serviceName !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Unsupported service' });
        return;
      }
      const answer = infoRefs(forge, repo, serviceName, req.headers['git-protocol']);
      sendBuffer(res, 200, answer.body, answer.contentType);
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocol = req.headers['git-protocol'] ?? '';
      try {
        const answer = protocol.includes('version=2') ? uploadPackV2(forge, repo, body) : uploadPackV0(forge, repo, body);
        sendBuffer(res, 200, answer, 'application/x-git-upload-pack-result');
      } catch {
        sendJson(res, 400, { message: 'Bad upload-pack request' });
      }
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        const answer = await receivePack(forge, repo, body);
        sendBuffer(res, 200, answer, 'application/x-git-receive-pack-result');
      } catch {
        sendJson(res, 400, { message: 'Bad receive-pack request' });
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
