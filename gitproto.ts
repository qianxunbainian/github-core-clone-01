// Git smart HTTP: ref advertisements, protocol v2 ls-refs/fetch, v0 fetch and receive-pack.
//
// The wire is pkt-lines throughout. Upload-pack speaks protocol v2 when the client asks for it
// (a `Git-Protocol: version=2` header) and v0 otherwise; receive-pack is v0 only, as git made
// it. Packs the forge sends are complete and undeltified: every object a fetch needs travels in
// full, so a client never has to resolve a delta against something it already holds.

import { ZERO_OID, isOid, readPack, writePack, type GitObject } from './gitobjects.ts';
import type { Forge, RepoRec } from './store.ts';

const AGENT = 'makefun-forge/1.0.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// ---------------------------------------------------------------- pkt-lines

/** Frame one payload as a pkt-line (4 hex digits of total length, then the payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-lines from the front of a buffer; answers the packets and the bytes they used. */
export function parsePackets(buffer: Buffer, start = 0): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset - start };
}

/** The text lines of a packet list, one string per data packet, newline stripped. */
function packetLines(packets: readonly Packet[]): string[] {
  return packets
    .filter((packet) => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v0 advertisement body (after the service preamble): refs, peeled tags, capabilities. */
function advertiseV0(forge: Forge, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (service === 'git-upload-pack') {
    const caps = `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0][1];
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      for (const [name, oid] of refs) {
        parts.push(pktLine(`${oid} ${name}\n`));
        const peeled = forge.peelTag(oid);
        if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  } else {
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
    } else {
      refs.forEach(([name, oid], index) => {
        parts.push(pktLine(index === 0 ? `${oid} ${name}\0${RECEIVE_CAPS}\n` : `${oid} ${name}\n`));
        const peeled = forge.peelTag(oid);
        if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      });
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement body: a version line and the capability lines. */
function advertiseV2(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  if (service === 'git-receive-pack') {
    // receive-pack has no v2; git answers it with the v0 advertisement. Callers route here only
    // for upload-pack, but answer safely.
    return Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH, pktLine('version 2\n'), PKT_FLUSH]);
  }
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([pktLine(lines[0]), PKT_FLUSH, ...lines.slice(1).map((line) => pktLine(line)), PKT_FLUSH]);
}

export function infoRefs(
  forge: Forge,
  repo: RepoRec,
  service: 'git-upload-pack' | 'git-receive-pack',
  protocolHeader: string | undefined,
): { contentType: string; body: Buffer } {
  const wantsV2 = (protocolHeader ?? '').includes('version=2');
  const body = service === 'git-upload-pack' && wantsV2 ? advertiseV2(service) : advertiseV0(forge, repo, service);
  return { contentType: `application/x-${service}-advertisement`, body };
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out what a fetch sends: the objects the client lacks, honouring haves, the client's own
 * shallow boundary and a deepen limit. Boundary commits the client will newly hold shallow are
 * reported, as are client-shallow commits the deepening frees.
 */
function planFetch(
  forge: Forge,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);

  // What the client already holds: everything reachable from its haves, without descending
  // below the shallow boundary it declared (a boundary commit is held; its parents are not).
  const held = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const commit = forge.peelToCommit(have);
      if (commit) queue.push(commit);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head];
      if (held.has(oid)) continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue;
      const parsed = forge.commitOf(oid);
      if (parsed) queue.push(...parsed.parents);
    }
  }

  // Generations from the wants (want = generation 1), over the full graph.
  const generation = new Map<string, number>();
  {
    const queue: { oid: string; gen: number }[] = [];
    for (const want of wants) {
      const commit = forge.peelToCommit(want);
      if (commit) queue.push({ oid: commit, gen: 1 });
    }
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, gen } = queue[head];
      const known = generation.get(oid);
      if (known !== undefined && known <= gen) continue;
      generation.set(oid, gen);
      // Beyond the depth limit nothing is included, so the walk can stop there —
      // a depth-1 clone of a long history then touches one commit, not all of them.
      if (depth !== null && gen >= depth) continue;
      const parsed = forge.commitOf(oid);
      if (parsed) for (const parent of parsed.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  const included = new Set<string>();
  for (const [oid, gen] of generation) {
    if (depth === null || gen <= depth) included.add(oid);
  }
  const sentCommits = [...included].filter((oid) => !held.has(oid));

  // The new shallow boundary: included commits with a parent the plan leaves out.
  const boundary: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included) {
    const parsed = forge.commitOf(oid);
    if (!parsed) continue;
    const cut = parsed.parents.some((parent) => !included.has(parent) && forge.getObject(parent)?.type === 'commit');
    if (depth !== null && cut) boundary.push(oid);
    if (shallowSet.has(oid) && !cut) unshallow.push(oid);
  }

  // Everything the client already holds: the held commits plus their whole tree
  // closures. A fetch must never re-send any of it — an unchanged blob shared by
  // two trees is exactly as held as the commit itself.
  const heldAll = new Set<string>(held);
  const markTreeHeld = (treeOid: string): void => {
    if (heldAll.has(treeOid)) return;
    const entries = forge.treeOf(treeOid);
    if (!entries) return;
    heldAll.add(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') markTreeHeld(entry.oid);
      else heldAll.add(entry.oid);
    }
  };
  for (const oid of held) {
    const parsed = forge.commitOf(oid);
    if (parsed) markTreeHeld(parsed.tree);
  }

  const objectIds = new Set<string>();
  const objects: GitObject[] = [];
  const addObject = (oid: string): void => {
    if (objectIds.has(oid)) return;
    const object = forge.getObject(oid);
    if (!object) return;
    objectIds.add(oid);
    objects.push(object);
  };
  const addTreeClosure = (treeOid: string): void => {
    if (objectIds.has(treeOid) || heldAll.has(treeOid)) return;
    const entries = forge.treeOf(treeOid);
    if (!entries) return;
    addObject(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') addTreeClosure(entry.oid);
      else if (!heldAll.has(entry.oid)) addObject(entry.oid);
    }
  };

  for (const oid of sentCommits) {
    addObject(oid);
    const parsed = forge.commitOf(oid);
    if (parsed) addTreeClosure(parsed.tree);
  }
  // Tag objects the client asked for by id travel with their target.
  for (const want of wants) {
    const object = forge.getObject(want);
    if (object?.type === 'tag' && !heldAll.has(want)) {
      const target = forge.peelToCommit(want);
      if (target && included.has(target)) addObject(want);
    }
  }
  return { objects, shallow: boundary, unshallow };
}

/** Frame a pack as sideband band-1 pkt-lines (each within the 65524-byte pkt-line limit). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchLines(lines: readonly string[], into: FetchRequest): void {
  for (const line of lines) {
    if (line.startsWith('want ')) into.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) into.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) into.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) into.depth = Number.parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') into.done = true;
  }
}

/** POST git-upload-pack, protocol v2: the `command=fetch` and `command=ls-refs` commands. */
export function uploadPackV2(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  // Split the request at the delimiter packet: capability arguments, then command arguments.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const head = delimIndex < 0 ? packets : packets.slice(0, delimIndex);
  const rest = delimIndex < 0 ? [] : packets.slice(delimIndex + 1);
  const headLines = packetLines(head);
  const command = headLines.find((line) => line.startsWith('command='))?.slice('command='.length);

  if (command === 'ls-refs') {
    return lsRefsV2(forge, repo, packetLines(rest));
  }
  if (command === 'fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
    parseFetchLines(packetLines(rest), request);
    return fetchResponseV2(forge, repo, request);
  }
  return Buffer.concat([pktLine('error: unknown command\n'), PKT_FLUSH]);
}

function lsRefsV2(forge: Forge, repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = forge.peelTag(oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV2(forge: Forge, repo: RepoRec, request: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  const plan = planFetch(forge, request.wants, request.haves, request.shallow, request.depth);
  if (!request.done) {
    // Negotiation round: the client has not said done, so it gets acknowledgments only.
    const wants = request.wants.filter((oid) => isOid(oid) && forge.getObject(oid));
    const common = request.haves.find((have) => {
      const commit = forge.peelToCommit(have);
      return commit !== null && wants.some((want) => {
        const wantCommit = forge.peelToCommit(want);
        return wantCommit !== null && forge.isAncestor(commit, wantCommit);
      });
    });
    parts.push(pktLine('acknowledgments\n'));
    if (common) {
      parts.push(pktLine(`ACK ${forge.peelToCommit(common)}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // With `done` the answer is the shallow news and the packfile, nothing before it.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack, protocol v0: wants and haves in two sections, then NAK/ACK and a pack. */
export function uploadPackV0(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  // v0 wants carry capabilities after the first want; strip anything past the oid.
  const { packets } = parsePackets(body);
  for (const line of packetLines(packets)) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') request.done = true;
  }
  const plan = planFetch(forge, request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = request.haves.find((have) => forge.getObject(have));
  parts.push(pktLine(common ? `ACK ${forge.peelToCommit(common) ?? common}\n` : 'NAK\n'));
  parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST git-receive-pack: read the command list, absorb the pack, validate each ref update
 * (existence, fast-forward), apply the ones that pass, and answer a report-status — framed in
 * sideband band 1 when the client negotiated it, as the suite's client does.
 */
export async function receivePack(forge: Forge, repo: RepoRec, body: Buffer): Promise<Buffer> {
  const { packets, consumed } = parsePackets(body);
  const lines = packetLines(packets);
  const commands: PushCommand[] = [];
  let capabilities = '';
  lines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const [oldOid, newOid, ref] = text.split(' ');
    if (isOid(oldOid) && isOid(newOid) && ref) commands.push({ oldOid, newOid, ref });
  });
  const packBytes = body.subarray(consumed);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const wantsReport = capabilities.split(' ').includes('report-status');

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = await readPack(packBytes, (oid) => forge.getObject(oid));
      forge.absorbObjects(objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPushCommand(forge, repo, command));
  }

  if (!wantsReport) return Buffer.alloc(0);
  const reportLines = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!useSideband) return inner;
  // The report stream itself is pkt-lined; carry it inside band-1 packets.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + CHUNK)])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function applyPushCommand(forge: Forge, repo: RepoRec, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/') || ref.includes('..')) return { ref, ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const object = forge.getObject(newOid);
  if (!object) return { ref, ok: false, reason: 'unknown object' };
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
    return { ref, ok: false, reason: 'not a commit' };
  }
  if (oldOid !== ZERO_OID) {
    const oldCommit = forge.peelToCommit(oldOid);
    const newCommit = forge.peelToCommit(newOid);
    if (!oldCommit || !newCommit || !forge.isAncestor(oldCommit, newCommit)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}
