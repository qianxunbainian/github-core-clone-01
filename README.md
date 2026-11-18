# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge in one Node process, standard library only, no dependencies and no
install step. It serves, from a single in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git/...` — ref advertisement, protocol v2
  `ls-refs` and `fetch` (with shallow/deepen), protocol v0 fetch, and v0 `receive-pack`
  with report-status. The pack protocol is implemented by hand on `node:zlib` and
  `node:crypto`: complete undeltified packs out, full delta resolution in.
- **REST v3** under `/api/v3` — repositories, branches, git refs, commits, contents,
  labels, issues, comments, and pull requests with files and merges (merge, squash,
  rebase), with GitHub's status codes, error bodies and `Link` pagination.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server` send:
  viewer, repository fields, issue/pull-request reads, cursor pagination, Relay
  `node(id:)`, the `__type` introspection probes, batched operations, and the
  create/close/merge/comment mutations.
- **MCP** at `/mcp` — streamable HTTP JSON-RPC with both `server/discover` (2026-07-28)
  and the legacy `initialize` handshake; tools for repositories, issues and pull
  requests that act on the same store as the other surfaces.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register it, poll
  `/done`, exit 0). Unchanged from the contest starter, as its header requires.
- `app.ts` — the HTTP server: routing, bearer-token auth, request ids.
- `store.ts` — the in-memory forge: object store, repositories, contents writes,
  three-way merge planning, pull-request diffs.
- `gitobjects.ts` — git's object model: SHA-1 ids, tree/commit/tag codecs, packfiles.
- `gitproto.ts` — pkt-lines, advertisements, upload-pack, receive-pack.
- `rest.ts` / `graphql.ts` / `mcp.ts` / `views.ts` — the three API surfaces and their
  shared JSON shapes.

## Running

The contest harness runs `node main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` set. To poke at it locally, set any token, start it behind a
stub env, or import `createApp()` from `app.ts` in a test script and drive it with a
real git client and curl.
