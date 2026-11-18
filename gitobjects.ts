// Git's object model on Node's standard library: hashing, tree/commit/tag codecs, packfiles.
//
// Objects are content-addressed by the SHA-1 of "<type> <byte length>\0" followed by the raw
// bytes, exactly as git computes it. A packfile is the version-2 layout git writes: a 12-byte
// header, a run of zlib-deflated entries (plain, OFS_DELTA or REF_DELTA) and a trailing SHA-1
// over everything before it. This module reads and writes that layout and applies deltas; the
// forge in store.ts keeps the objects themselves.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id an object with these bytes owns: sha1 of the header line and the bytes. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(text: unknown): text is string {
  return typeof text === 'string' && /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** git's stored mode text: '100644', '100755', '120000', '40000' for a subtree, '160000'. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree ordering key: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise entries into a tree object, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Header lines run to the first blank line; the rest is the message. */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit. The message is stored exactly as given. */
export function buildCommit(commit: CommitData): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface TagData {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const tag: TagData = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta (the pack/copy instruction stream) to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${base.length} does not match its header ${sourceSize}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset++];
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) copyOffset |= delta[offset++] << (8 * bit);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) copySize |= delta[offset++] << (8 * bit);
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      out.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

// ---------------------------------------------------------------- packfiles

/** Serialise objects into a complete packfile (header, deflated entries, trailer checksum). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** One entry's variable-length type-and-size header. */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Adler-32 of a buffer, as the zlib trailer stores it (big-endian at the stream's end). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let index = 0; index < data.length; index += 1) {
    a = (a + data[index]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one entry starting at `offset`; reports how many compressed bytes it consumed.
 * Node's zlib never says where a stream ended, but inflateSync tolerates trailing bytes,
 * and a zlib stream ends with the Adler-32 of its plain bytes — so one full inflate plus
 * a scan for that checksum locates the end. If the scan finds no match (a checksum that
 * also occurs inside the deflate data would end the entry early and the pack-level
 * trailer check then fails), readPack retries with the probing variant below.
 */
function inflateEntryFast(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const data = inflateSync(pack.subarray(offset));
  const checksum = adler32(data);
  for (let end = offset + 6; end + 4 <= pack.length; end += 1) {
    if (pack.readUInt32BE(end) === checksum) return { data, consumed: end + 4 - offset };
  }
  throw new Error('the end of a pack entry was not found');
}

/**
 * The certain variant: the consumed length is the shortest prefix that inflates,
 * found by probing exponentially, then binary-searching the boundary.
 */
function inflateEntryProbing(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const maxLength = pack.length - offset;
  const inflates = (length: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  };
  let high = 1;
  while (high < maxLength && !inflates(high)) high *= 2;
  high = Math.min(high, maxLength);
  if (!inflates(high)) throw new Error('a pack entry does not inflate');
  let low = 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (inflates(mid)) high = mid;
    else low = mid + 1;
  }
  return { data: inflateSync(pack.subarray(offset, offset + low)), consumed: low };
}

interface PackEntry {
  offset: number;
  type: GitObjectType;
  /** For a plain entry: the object bytes. For a delta: the delta bytes. */
  data: Buffer;
  deltaBaseOffset?: number;
  deltaBaseOid?: string;
}

/**
 * Read a whole packfile and resolve every entry to a full object, keyed by object id. Delta
 * bases may come from the pack itself or from `externalBase` (the store, for REF_DELTA against
 * objects a push already holds). The trailer checksum is verified before anything resolves.
 */
export function readPack(
  pack: Buffer,
  externalBase: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum does not match its bytes');

  const parseEntries = (
    inflate: (pack: Buffer, offset: number) => { data: Buffer; consumed: number },
  ): PackEntry[] => {
    const parsed: PackEntry[] = [];
    let offset = 12;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = offset;
      let byte = pack[offset++];
      const typeCode = (byte >> 4) & 0x07;
      // The size is decoded for validation; the inflated length is authoritative.
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }
      let deltaBaseOffset: number | undefined;
      let deltaBaseOid: string | undefined;
      if (typeCode === 6) {
        // OFS_DELTA: a negative offset back to the base entry, in git's offset encoding.
        let back = pack[offset++];
        let value = back & 0x7f;
        while (back & 0x80) {
          back = pack[offset++];
          value = ((value + 1) << 7) | (back & 0x7f);
        }
        deltaBaseOffset = entryOffset - value;
      } else if (typeCode === 7) {
        deltaBaseOid = pack.toString('hex', offset, offset + 20);
        offset += 20;
      }
      const inflated = inflate(pack, offset);
      offset += inflated.consumed;
      const plainType = CODE_TYPES[typeCode];
      parsed.push({
        offset: entryOffset,
        type: plainType ?? 'blob',
        data: inflated.data,
        deltaBaseOffset,
        deltaBaseOid,
      });
      void size;
    }
    if (offset !== pack.length - 20) throw new Error('pack entries do not end at the trailer');
    return parsed;
  };

  let entries: PackEntry[];
  try {
    entries = parseEntries(inflateEntryFast);
  } catch {
    entries = parseEntries(inflateEntryProbing);
  }

  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, GitObject>();

  const resolveEntry = (entry: PackEntry): GitObject => {
    const cached = resolvedByOffset.get(entry.offset);
    if (cached) return cached;
    let object: GitObject;
    if (entry.deltaBaseOffset === undefined && entry.deltaBaseOid === undefined) {
      object = { type: entry.type, data: entry.data };
    } else {
      let base: GitObject | undefined;
      if (entry.deltaBaseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.deltaBaseOffset);
        if (!baseEntry) throw new Error(`delta base at offset ${entry.deltaBaseOffset} is not in the pack`);
        base = resolveEntry(baseEntry);
      } else if (entry.deltaBaseOid !== undefined) {
        base = resolved.get(entry.deltaBaseOid) ?? externalBase(entry.deltaBaseOid);
        if (!base) throw new Error(`delta base ${entry.deltaBaseOid} is not available`);
      }
      if (!base) throw new Error('delta without a base');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolvedByOffset.set(entry.offset, object);
    resolved.set(objectId(object.type, object.data), object);
    return object;
  };
  for (const entry of entries) resolveEntry(entry);
  return resolved;
}
