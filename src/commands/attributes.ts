import { Command, InvalidArgumentError, Option } from 'commander';
import { AttioClient } from '../client.js';
import { detectFormat, outputList, outputSingle, type OutputFormat } from '../output.js';
import { recordHeading } from '../object-metadata.js';

const columns = ['api_slug', 'title', 'type', 'is_required', 'is_unique', 'is_multiselect'];
function integer(value: string, minimum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new InvalidArgumentError(`Expected an integer >= ${minimum}.`);
  return number;
}
function target(command: Command): Command {
  return command.addOption(new Option('--target <target>', 'Attribute owner type').choices(['objects', 'lists']).default('objects'));
}
function basePath(identifier: string, owner: string): string {
  return `/${owner}/${encodeURIComponent(identifier)}/attributes`;
}

export function register(program: Command): void {
  const attributes = program.command('attributes').description('Read object and list attributes');

  target(attributes.command('list').description('List attributes for an object or list')
    .argument('<identifier>', 'Object API slug or list ID/slug'))
    .option('--limit <n>', 'Page size', value => integer(value, 1))
    .option('--offset <n>', 'Number of attributes to skip', value => integer(value, 0))
    .option('--all', 'Fetch every page without a record-count cap')
    .option('--show-archived', 'Include archived attributes')
    .action(async function (this: Command, identifier: string) {
      const opts = this.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);
      const items: Record<string, any>[] = [];
      const seen = new Set<string>();
      let offset = opts.offset ?? 0;
      while (true) {
        const params = new URLSearchParams();
        if (opts.limit !== undefined || opts.all) params.set('limit', String(opts.limit ?? 500));
        if (opts.offset !== undefined || opts.all) params.set('offset', String(offset));
        if (opts.showArchived) params.set('show_archived', 'true');
        const query = params.toString();
        const path = basePath(identifier, opts.target) + (query ? `?${query}` : '');
        const response = await client.get<{ data: Record<string, any>[] }>(path);
        if (!Array.isArray(response.data)) throw new Error('Expected an attribute array.');
        for (const attribute of response.data) {
          if (opts.all) {
            const id = attribute.id?.attribute_id ?? attribute.api_slug;
            if (!id || seen.has(id)) throw new Error('Duplicate or missing attribute ID during pagination.');
            seen.add(id);
          }
          items.push(attribute);
        }
        if (!opts.all || response.data.length === 0) break;
        offset += response.data.length;
      }
      if (format === 'table' && opts.target === 'objects') await recordHeading(client, identifier, true);
      outputList(items, { format, columns, idField: 'api_slug' });
    });

  target(attributes.command('get <identifier> <attribute>').description('Get one object or list attribute'))
    .action(async function (this: Command, identifier: string, attribute: string) {
      const opts = this.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const response = await client.get<{ data: Record<string, any> }>(`${basePath(identifier, opts.target)}/${encodeURIComponent(attribute)}`);
      const format = detectFormat(opts);
      if (format === 'csv') outputList([response.data], { format, columns });
      else outputSingle(response.data, { format, idField: 'api_slug' });
    });

  for (const [name, idField] of [['options', 'option_id'], ['statuses', 'status_id']]) {
    target(attributes.command(`${name} <identifier> <attribute>`).description(`List ${name === 'options' ? 'select options' : 'statuses'} for an object or list attribute`))
      .option('--show-archived', `Include archived ${name}`)
      .option('--limit <n>', 'Maximum choices printed (applied after the API response)', value => integer(value, 1), 100)
      .action(async function (this: Command, identifier: string, attribute: string) {
        const opts = this.optsWithGlobals();
        const client = new AttioClient(opts.apiKey, opts.debug);
        const path = `${basePath(identifier, opts.target)}/${encodeURIComponent(attribute)}/${name}`;
        const response = await client.get<{ data: Record<string, any>[] }>(path + (opts.showArchived ? '?show_archived=true' : ''));
        const available = opts.showArchived ? response.data : response.data.filter(item => !item.is_archived);
        const items = available.slice(0, opts.limit);
        if (available.length > opts.limit) console.error(`Showing ${items.length} of ${available.length} ${name}; use --limit to change the output cap.`);
        const format = detectFormat(opts);
        if (format === 'json') { outputList(items, { format }); return; }
        outputList(items.map(item => ({ ...item, id: item.id?.[idField] })), {
          format, columns: ['id', 'title', 'is_archived'], idField: 'id',
        });
      });
  }
}
