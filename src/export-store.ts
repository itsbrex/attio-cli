import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(`Export directory must not be a symlink: ${path}`);
  await chmod(path, 0o700);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
}

/** Private, immutable request checkpoints. Authentication and signed URLs never enter them. */
export class ExportStore {
  readonly root: string;
  private lock = false;

  constructor(root: string) { this.root = resolve(root); }

  path(relative: string): string {
    const path = resolve(this.root, relative);
    if (!path.startsWith(this.root + '/')) throw new Error('Export path escapes its directory');
    return path;
  }

  async acquire(resume: boolean): Promise<void> {
    await privateDirectory(this.root);
    if (!resume && (await readdir(this.root)).length) {
      throw new Error('Export directory is not empty. Use --resume or choose a new --dir.');
    }
    const lockPath = this.path('.export.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
        await lock.close();
        this.lock = true;
        return;
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const owner = await readJson<{ pid: number; host: string }>(lockPath);
        if (owner?.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) {
          throw new Error('Export is locked by another host or an unreadable lock.');
        }
        try { process.kill(owner.pid, 0); }
        catch (probe: any) {
          if (probe.code === 'ESRCH') { await unlink(lockPath); continue; }
          throw probe;
        }
        throw new Error(`Export is already running (PID ${owner.pid}).`);
      }
    }
    throw new Error('Could not acquire the export lock.');
  }

  async release(): Promise<void> {
    if (this.lock) { await unlink(this.path('.export.lock')); this.lock = false; }
  }

  async cached<T>(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const path = this.path(`.checkpoints/${sha256(key)}.json`);
    const cached = await readJson<{ key: string; sha256: string; data: T }>(path);
    if (cached) {
      if (cached.key !== key || cached.sha256 !== sha256(JSON.stringify(cached.data))) {
        throw new Error(`Export checkpoint checksum mismatch: ${path}`);
      }
      return cached.data;
    }
    const data = await fetchValue();
    await atomicJson(path, { key, sha256: sha256(JSON.stringify(data)), data });
    return data;
  }

  async publish(relative: string, rows: AsyncIterable<unknown> | Iterable<unknown>): Promise<{ file: string; count: number; sha256: string; bytes: number }> {
    const path = this.path(relative);
    await privateDirectory(dirname(path));
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    const hash = createHash('sha256');
    let count = 0;
    let bytes = 0;
    const write = async (text: string) => { hash.update(text); bytes += Buffer.byteLength(text); await file.writeFile(text); };
    try {
      await write('[\n');
      for await (const row of rows) await write((count++ ? ',\n' : '') + JSON.stringify(row));
      await write('\n]\n');
      await file.sync();
    } catch (error) {
      await file.close(); await unlink(temp); throw error;
    }
    await file.close();
    const digest = hash.digest('hex');
    // A crash after publication but before the manifest write is safe to resume.
    try {
      const existing = await fileDigest(path);
      if (existing.sha256 !== digest) throw new Error(`Existing export changed; refusing to overwrite ${relative}`);
      await unlink(temp);
      await chmod(path, 0o600);
    } catch (error: any) {
      if (error.code !== 'ENOENT') { await unlink(temp).catch(() => undefined); throw error; }
      await rename(temp, path);
    }
    return { file: relative, count, sha256: digest, bytes };
  }
}
