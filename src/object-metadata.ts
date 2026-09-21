import { Command } from 'commander';
import { stripVTControlCharacters } from 'node:util';
import { AttioClient } from './client.js';

export interface ObjectMetadata {
  api_slug: string;
  singular_noun: string;
  plural_noun: string;
  id?: { object_id?: string };
}

const STANDARD_OBJECTS = new Set(['people', 'companies', 'deals', 'users', 'workspaces']);

function displayText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
}

export function objectMetadata(data: unknown): ObjectMetadata[] {
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is ObjectMetadata =>
    item !== null && typeof item === 'object'
    && ['api_slug', 'singular_noun', 'plural_noun'].every(key =>
      typeof item[key] === 'string' && displayText(item[key]).length > 0),
  );
}

/** Optional presentation metadata. Never required for record operations. */
export async function discoverObjects(client: AttioClient): Promise<ObjectMetadata[]> {
  try {
    const response = await client.get<{ data: unknown }>('/objects', { timeoutMs: 1500, maxRetries: 0 });
    return objectMetadata(response.data);
  } catch {
    // Offline, unavailable scopes, or malformed metadata must not block the CLI.
    return [];
  }
}

export function objectLabel(objects: ObjectMetadata[], object: string, plural = true): string {
  const metadata = objects.find(item => item.api_slug === object || item.id?.object_id === object);
  if (!metadata) return displayText(object);
  const name = displayText(plural ? metadata.plural_noun : metadata.singular_noun);
  return `${name} (${displayText(metadata.api_slug)})`;
}

export async function recordHeading(client: AttioClient, object: string, plural = false): Promise<void> {
  console.log(objectLabel(await discoverObjects(client), object, plural));
}

/** Return display-only copies; preserve API payloads and non-object fields. */
export async function labelObjectColumn<T extends Record<string, any>>(
  client: AttioClient, rows: T[], column: string,
): Promise<T[]> {
  if (!rows.some(row => row[column])) return rows;
  const objects = await discoverObjects(client);
  const label = (value: unknown): unknown => typeof value === 'string'
    ? objectLabel(objects, value)
    : Array.isArray(value) ? value.map(label) : value;
  return rows.map(row => column in row ? { ...row, [column]: label(row[column]) } : row);
}

/** Change descriptions only: command names and action closures retain API slugs. */
function applyObjectHelp(program: Command, objects: ObjectMetadata[]): void {
  for (const object of objects) {
    if (!STANDARD_OBJECTS.has(object.api_slug)) continue;
    const command = program.commands.find(cmd => cmd.name() === object.api_slug);
    if (!command) continue;
    const singular = displayText(object.singular_noun);
    const plural = displayText(object.plural_noun);
    command.description(`Manage ${plural} (API slug: ${object.api_slug})`);
    const descriptions: Record<string, string> = {
      list: `List ${plural}`,
      get: `Get ${singular} by record ID`,
      create: `Create ${singular}`,
      update: `Update ${singular}`,
      delete: `Delete ${singular}`,
      assert: `Create or update ${singular} by matching attribute`,
      search: `Search ${plural}`,
    };
    for (const child of command.commands) {
      if (descriptions[child.name()]) child.description(descriptions[child.name()]);
    }
  }
}

/** Help exits during parsing, so hydrate its labels before the real parse. */
export async function prepareObjectHelp(program: Command, args: string[]): Promise<void> {
  const probe = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  // Reuse root option definitions, including --api-key=<key> and option values.
  // Parsing options alone never runs a command, prints help, or changes program.
  for (const option of program.options) probe.addOption(option);
  let operands: string[];
  let unknown: string[];
  try {
    ({ operands, unknown } = probe.parseOptions(args));
  } catch {
    return; // Let the real parser report invalid arguments.
  }
  const beforeDoubleDash = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  const wantsHelp = (operands.length === 0 && unknown.length === 0)
    || operands[0] === 'help'
    || beforeDoubleDash.some(arg => arg === '--help' || arg === '-h')
    || (operands.length === 1 && unknown.length === 0 && STANDARD_OBJECTS.has(operands[0]));
  if (!wantsHelp || probe.opts().version) return;
  const opts = probe.opts();
  applyObjectHelp(program, await discoverObjects(new AttioClient(opts.apiKey, opts.debug)));
}

export function workspaceObjectGuide(objects: ObjectMetadata[]): string {
  const intro = '### Workspace object names\n\nObject display names can change. Always use API slugs in commands, API paths, filters, and record references. Run `attio objects list` to check current names.';
  if (objects.length === 0) return intro;
  const escape = (value: string) => displayText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '&#96;');
  const rows = objects.map(object => `| ${escape(object.plural_noun)} | ${escape(object.singular_noun)} | \`${escape(object.api_slug)}\` |`);
  return `${intro}\n\n| Display name | Singular | API slug |\n| --- | --- | --- |\n${rows.join('\n')}`;
}
