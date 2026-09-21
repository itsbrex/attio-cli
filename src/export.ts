import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { AttioClient } from './client.js';
import { AttioApiError, AttioAuthError } from './errors.js';
import { ExportStore, atomicJson, fileDigest, privateDirectory, readJson, sha256 } from './export-store.js';

export const EXPORT_RESOURCES = ['records', 'attributes', 'notes', 'emails', 'files'] as const;
export type ExportResource = typeof EXPORT_RESOURCES[number];
interface Artifact { file: string; count?: number; sha256: string; bytes: number }
interface ResourceState {
  status: 'running' | 'complete' | 'blocked' | 'failed';
  outputs: Artifact[];
  error?: string;
  details?: Record<string, unknown>;
}
interface ObjectInfo { api_slug: string; id: { workspace_id: string; object_id: string }; [key: string]: any }
export interface ExportManifest {
  schema: 'attio-cli-export/v1';
  started_at: string;
  updated_at: string;
  status: 'running' | 'complete' | 'incomplete';
  workspace_id: string;
  objects: ObjectInfo[];
  include: ExportResource[];
  attribute_policy: { include_archived: false; max_choices: number };
  limitations: string[];
  resources: Record<string, ResourceState>;
}
export interface ExportOptions {
  directory: string;
  objects: string[];
  include?: ExportResource[];
  resume?: boolean;
  concurrency?: number;
  maxChoices?: number;
  progress?: (message: string) => void;
}

function rows(response: any): any[] {
  if (!Array.isArray(response?.data)) throw new Error('Expected an API data array; export remains incomplete.');
  return response.data;
}
function identity(row: any, field: string, workspace: string): string {
  if (typeof row?.id?.[field] !== 'string' || !row.id[field] || row.id.workspace_id !== workspace) {
    throw new Error(`Malformed or wrong-workspace ${field} in export response.`);
  }
  return row.id[field];
}
function sameIds(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(id => right.has(id));
}
async function parallel<T>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length && failure === undefined) {
      const index = next++;
      try { await action(items[index], index); } catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure;
}

/** Read-only API export. Every successful page is durable before its cursor advances. */
export async function exportWorkspace(client: AttioClient, options: ExportOptions): Promise<ExportManifest> {
  const include = [...new Set(options.include ?? EXPORT_RESOURCES)].sort() as ExportResource[];
  if (!include.length || include.some(value => !EXPORT_RESOURCES.includes(value))) throw new Error('Unknown or empty export resource selection.');
  if (!options.objects.length) throw new Error('Select at least one object API slug.');
  const concurrency = options.concurrency ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('--concurrency must be an integer from 1 to 32.');
  const maxChoices = options.maxChoices ?? 100;
  if (!Number.isSafeInteger(maxChoices) || maxChoices < 1) throw new Error('--max-choices must be a positive integer.');
  const store = new ExportStore(options.directory);
  await store.acquire(options.resume ?? false);
  try {
    const saved = await readJson<ExportManifest>(store.path('manifest.json'));
    if (options.resume && !saved) throw new Error('No export manifest found. Start without --resume in an empty directory.');
    if (saved && saved.schema !== 'attio-cli-export/v1') throw new Error('Unsupported export manifest. Choose a new --dir; existing exports are preserved.');
    const available = rows(await client.get('/objects')) as ObjectInfo[];
    const selectedObjects = [...new Set(options.objects)].map(name => {
      const object = available.find(item => item.api_slug === name || item.id?.object_id === name);
      if (!object?.id?.workspace_id || !object.id.object_id || !/^[\w-]+$/.test(object.api_slug)) throw new Error(`Unknown or invalid object: ${name}`);
      return object;
    });
    const objects = [...new Map(selectedObjects.map(object => [object.id.object_id, object])).values()]
      .sort((a, b) => a.api_slug.localeCompare(b.api_slug));
    const workspace = objects[0].id.workspace_id;
    if (objects.some(object => object.id.workspace_id !== workspace)) throw new Error('Mixed workspace identities.');
    if (saved && (saved.workspace_id !== workspace || JSON.stringify(saved.include) !== JSON.stringify(include)
      || JSON.stringify(saved.objects.map(o => [o.api_slug, o.id.object_id])) !== JSON.stringify(objects.map(o => [o.api_slug, o.id.object_id])))) {
      throw new Error('Workspace, objects, or resource selection changed; choose a new export directory.');
    }
    if (saved && include.includes('attributes') && (saved.attribute_policy?.include_archived !== false || saved.attribute_policy.max_choices !== maxChoices)) {
      throw new Error('Attribute export policy changed; choose a new directory or use the original --max-choices value.');
    }
    const manifest: ExportManifest = saved ?? {
      schema: 'attio-cli-export/v1', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      status: 'running', workspace_id: workspace, objects, include, resources: {},
      attribute_policy: { include_archived: false, max_choices: maxChoices },
      limitations: [
        'API-visible data only. No transactional snapshot; current values are observed over the export interval.',
        'Records require two complete opposite-order scans with matching IDs. Resume keeps successful pages from the original run.',
        `Attributes include current record values and active definitions. Active select options/statuses are capped at ${maxChoices} choices per attribute; truncation is reported. Historical values and list-entry values are not included.`,
        'Notes include plaintext and Markdown returned by Attio. Embedded note images are not exposed by the notes API.',
        'Emails contain metadata only, never message bodies or attachments. Alpha access and email:read are required; visibility restrictions still apply.',
        'Email filters support People and Companies. Other selected objects have no direct email relation in this API.',
        'Files include all folder levels and download attempts for internal and connected files. Unavailable downloads make the export incomplete.',
      ],
    };
    const save = async () => { manifest.updated_at = new Date().toISOString(); await atomicJson(store.path('manifest.json'), manifest); };
    // Completed files are checked even when all request pages are cached.
    for (const state of Object.values(manifest.resources)) {
      for (const output of state.outputs) {
        const actual = await fileDigest(store.path(output.file));
        if (actual.sha256 !== output.sha256 || actual.bytes !== output.bytes) throw new Error(`Export file checksum mismatch: ${output.file}`);
      }
    }
    manifest.status = 'running'; await save();
    let nextRequest = 0;
    const throttle = async () => {
      const delay = Math.max(0, nextRequest - Date.now()); nextRequest = Date.now() + delay + 30;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    };
    const get = async (path: string): Promise<any> => { await throttle(); return client.get(path); };
    const cachedRows = async (key: string, fetchPage: () => Promise<any[]>): Promise<any[]> => {
      const value = await store.cached(key, fetchPage);
      if (!Array.isArray(value)) throw new Error('Malformed export checkpoint array.');
      return value;
    };
    const fromPages = async function* (keys: string[]) {
      for (const key of keys) {
        const page = await cachedRows(key, async () => { throw new Error(`Missing completed checkpoint: ${key}`); });
        yield* page;
      }
    };
    const resource = async (name: string, action: (state: ResourceState) => Promise<void>) => {
      const previous = manifest.resources[name];
      const state: ResourceState = { status: 'running', outputs: previous?.outputs ?? [] };
      manifest.resources[name] = state; await save();
      try { await action(state); state.status = 'complete'; }
      catch (error: any) {
        state.status = error instanceof AttioAuthError || (error instanceof AttioApiError && error.statusCode === 403) ? 'blocked' : 'failed';
        state.error = error.message;
        options.progress?.(`${name}: ${state.status}: ${error.message}`);
      }
      await save();
    };
    const recordIds = new Map<string, Set<string>>();
    const needRecords = include.some(item => ['records', 'notes', 'emails', 'files'].includes(item));
    if (needRecords) for (const object of objects) {
      const slug = object.api_slug;
      await resource(`records:${slug}`, async state => {
        let previous: Set<string> | undefined;
        for (let pass = 1; pass <= 4; pass++) {
          const ids = new Set<string>(); const keys: string[] = [];
          let offset = 0;
          while (true) {
            const key = `records:${slug}:${pass}:${offset}`;
            const page = await cachedRows(key, async () => {
              await throttle();
              return rows(await client.post(`/objects/${encodeURIComponent(slug)}/records/query`, {
                limit: 500, offset, sorts: [{ attribute: 'created_at', direction: pass % 2 ? 'asc' : 'desc' }],
              }));
            });
            for (const row of page) {
              const id = identity(row, 'record_id', workspace);
              if (row.id.object_id !== object.id.object_id || !row.values || typeof row.values !== 'object' || Array.isArray(row.values)) throw new Error(`Malformed ${slug} record.`);
              if (ids.has(id)) throw new Error(`Duplicate ${slug} record during scan; restart in a new directory.`);
              ids.add(id);
            }
            keys.push(key); offset += page.length;
            if (!page.length) break;
            if (keys.length % 10 === 0) options.progress?.(`${slug}: scan ${pass}, ${ids.size} records`);
          }
          options.progress?.(`${slug}: scan ${pass} finished, ${ids.size} records`);
          if (previous && sameIds(previous, ids)) {
            state.outputs = [await store.publish(`${slug}.json`, fromPages(keys))];
            state.details = { verified_passes: [pass - 1, pass], unique_ids_sha256: sha256([...ids].sort().join('\n')), terminal_empty_pages: true };
            recordIds.set(slug, ids); return;
          }
          previous = ids;
        }
        throw new Error(`Record membership did not stabilize for ${slug} after four scans.`);
      });
    }
    if (include.includes('attributes')) for (const object of objects) {
      const slug = object.api_slug;
      await resource(`attributes:${slug}`, async state => {
        const attributes: any[] = []; const ids = new Set<string>();
        let offset = 0;
        while (true) {
          const page = await cachedRows(`attributes:active:${slug}:${offset}`, async () => rows(await get(`/objects/${encodeURIComponent(slug)}/attributes?limit=500&offset=${offset}&show_archived=false`)));
          for (const attribute of page) {
            const id = identity(attribute, 'attribute_id', workspace);
            if (attribute.id.object_id !== object.id.object_id || ids.has(id)) throw new Error('Duplicate or wrong-object attribute.');
            ids.add(id);
            if (!attribute.is_archived) attributes.push(attribute);
          }
          offset += page.length; if (!page.length) break;
        }
        const choices: any[] = [];
        for (const attribute of attributes) {
          if (!['select', 'status'].includes(attribute.type)) continue;
          const suffix = attribute.type === 'select' ? 'options' : 'statuses';
          const choice = await store.cached(`attribute-${suffix}:active:${maxChoices}:${slug}:${attribute.id.attribute_id}`, async () => {
            // These endpoints have no documented server-side limit or pagination.
            const active = rows(await get(`/objects/${encodeURIComponent(slug)}/attributes/${encodeURIComponent(attribute.id.attribute_id)}/${suffix}?show_archived=false`)).filter(value => !value.is_archived);
            return { values: active.slice(0, maxChoices), available_count: active.length, truncated: active.length > maxChoices };
          });
          choices.push({ attribute_id: attribute.id.attribute_id, api_slug: attribute.api_slug, [suffix]: choice.values,
            available_count: choice.available_count, exported_count: choice.values.length, truncated: choice.truncated });
        }
        state.outputs = [await store.publish(`attributes/${slug}.json`, attributes), await store.publish(`attributes/${slug}-choices.json`, choices)];
        state.details = { include_archived: false, max_choices: maxChoices, truncated_attributes: choices.filter(choice => choice.truncated).length };
        options.progress?.(`${slug}: ${attributes.length} attribute definitions, ${choices.length} option/status sets`);
      });
    }
    const requireRecords = () => { if (recordIds.size !== objects.length) throw new Error('Related export requires complete record scans for every selected object.'); };
    if (include.includes('notes')) await resource('notes', async state => {
      requireRecords();
      const selected = (object: string, id: string) => {
        const match = objects.find(item => item.api_slug === object || item.id.object_id === object);
        return match ? recordIds.get(match.api_slug)!.has(id) : false;
      };
      const noteIds = new Set<string>(); const keys: string[] = []; let offset = 0;
      while (true) {
        const key = `notes:${offset}`;
        const page = await store.cached(key, async () => {
          // Attio requires BOTH parent_object and parent_record_id, or neither.
          const all = rows(await get(`/notes?limit=50&offset=${offset}`));
          return { source_count: all.length, data: all.filter(note => selected(note.parent_object, note.parent_record_id)
            || note.tags?.some((tag: any) => tag.type === 'record' && selected(tag.object, tag.record_id))) };
        });
        if (!Number.isInteger(page.source_count) || page.source_count < 0 || !Array.isArray(page.data)) throw new Error('Malformed notes checkpoint.');
        for (const note of page.data) {
          const id = identity(note, 'note_id', workspace);
          if (noteIds.has(id)) throw new Error('Duplicate note during scan; restart in a new directory.');
          noteIds.add(id);
        }
        keys.push(key); offset += page.source_count;
        if (!page.source_count) break;
        // Notes have a stricter 10 requests/second limit.
        await new Promise(resolve => setTimeout(resolve, 110));
        if (keys.length % 20 === 0) options.progress?.(`notes: ${offset} scanned, ${noteIds.size} related`);
      }
      const noteRows = async function* () { for (const key of keys) { const page = await store.cached<any>(key, async () => { throw new Error('Missing note checkpoint'); }); yield* page.data; } };
      state.outputs = [await store.publish('notes.json', noteRows())];
      state.details = { workspace_notes_scanned: offset, selected_notes: noteIds.size, terminal_empty_page: true };
    });
    const cursorPages = async (key: string, path: string, params: Record<string, string>, consume: (row: any) => void) => {
      let cursor: string | null = null; const seen = new Set<string>();
      do {
        const query = new URLSearchParams(params); if (cursor !== null) query.set('cursor', cursor);
        const page: any = await store.cached(`${key}:${cursor ?? 'first'}`, () => get(`${path}?${query}`));
        for (const row of rows(page)) consume(row);
        if (!page.pagination || !('next_cursor' in page.pagination)) throw new Error('Missing pagination.next_cursor; cannot prove completeness.');
        cursor = page.pagination.next_cursor;
        if (cursor !== null) {
          if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('Invalid or repeated pagination cursor.');
          seen.add(cursor);
        }
      } while (cursor !== null);
    };
    if (include.includes('emails')) await resource('emails', async state => {
      requireRecords();
      const emails = new Map<string, any>();
      const supported = objects.filter(object => ['people', 'companies'].includes(object.api_slug));
      if (!supported.length) throw new Error('Email API supports only People and Companies record links; no supported object selected.');
      for (const object of supported) {
        const ids = [...recordIds.get(object.api_slug)!].sort();
        for (let index = 0; index < ids.length; index += 10) {
          const batch = ids.slice(index, index + 10);
          await cursorPages(`emails:${object.api_slug}:${sha256(batch.join(','))}`, '/emails', {
            linked_object: object.api_slug, linked_record_ids: batch.join(','), limit: '50',
          }, row => {
            const id = identity(row, 'email_id', workspace);
            emails.set(`${row.id.mailbox_id}:${id}`, row);
          });
          if (index % 1000 === 0) options.progress?.(`emails: ${object.api_slug} ${Math.min(index + 10, ids.length)}/${ids.length} records checked`);
        }
      }
      state.outputs = [await store.publish('emails.json', emails.values())];
      state.details = { content: 'metadata_only', direct_objects: supported.map(object => object.api_slug), unsupported_direct_objects: objects.filter(o => !supported.includes(o)).map(o => o.api_slug) };
    });
    if (include.includes('files')) await resource('files', async state => {
      requireRecords();
      const jobs = objects.flatMap(object => [...recordIds.get(object.api_slug)!].sort().map(id => ({ object, id })));
      const files = new Map<string, any>(); let completed = 0;
      await parallel(jobs, concurrency, async ({ object, id }) => {
        await cursorPages(`files:${object.api_slug}:${id}`, '/files', { object: object.api_slug, record_id: id, limit: '200' }, row => {
          const fileId = identity(row, 'file_id', workspace);
          if (row.object_id !== object.id.object_id || row.record_id !== id) throw new Error('File belongs to a different record.');
          files.set(fileId, row);
        });
        completed++;
        if (completed % 250 === 0 || completed === jobs.length) options.progress?.(`files: ${completed}/${jobs.length} records checked, ${files.size} file/folder entries`);
      });
      const ordered = [...files.values()].sort((a, b) => a.id.file_id.localeCompare(b.id.file_id));
      state.outputs = [await store.publish('files.json', ordered)];
      state.details = { records_checked: completed, entries: files.size };
      await save();
      const downloads: any[] = [];
      await privateDirectory(store.path('files'));
      await parallel(ordered, concurrency, async row => {
        if (['folder', 'connected-folder'].includes(row.file_type)) return;
        if (!['file', 'connected-file'].includes(row.file_type)) throw new Error(`Unknown file type: ${row.file_type}`);
        const id = row.id.file_id;
        try {
          const downloaded = await store.cached<Artifact>(`download:${id}`, async () => {
            const relative = `files/${encodeURIComponent(id)}.bin`;
            const target = store.path(relative); const temp = `${target}.${randomUUID()}.partial`;
            await throttle();
            const result = await client.downloadFile(id, temp);
            if (row.file_type === 'file' && typeof row.content_size === 'number' && result.bytes !== row.content_size) {
              await unlink(temp); throw new Error('Downloaded file size differs from its metadata.');
            }
            try {
              const existing = await fileDigest(target);
              if (existing.sha256 !== result.sha256) throw new Error('Existing downloaded file changed.');
              await unlink(temp);
            } catch (error: any) {
              if (error.code !== 'ENOENT') { await unlink(temp).catch(() => undefined); throw error; }
              await rename(temp, target);
            }
            return { file: relative, ...result };
          });
          const actual = await fileDigest(store.path(downloaded.file));
          if (actual.sha256 !== downloaded.sha256 || actual.bytes !== downloaded.bytes) throw new Error('Downloaded file checksum mismatch.');
          downloads.push({ file_id: id, status: 'complete', ...downloaded });
        } catch (error: any) { downloads.push({ file_id: id, status: 'failed', error: error.message }); }
      });
      downloads.sort((a, b) => a.file_id.localeCompare(b.file_id));
      await atomicJson(store.path('downloads.json'), downloads);
      state.outputs.push({ file: 'downloads.json', count: downloads.length, ...await fileDigest(store.path('downloads.json')) });
      state.details.downloaded = downloads.filter(item => item.status === 'complete').length;
      const failed = downloads.filter(item => item.status !== 'complete');
      if (failed.length) throw new Error(`${failed.length} file downloads unavailable; see downloads.json and retry with --resume.`);
    });
    manifest.status = Object.values(manifest.resources).every(state => state.status === 'complete') ? 'complete' : 'incomplete';
    await save();
    return manifest;
  } finally { await store.release(); }
}
