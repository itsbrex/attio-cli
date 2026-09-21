import { Command } from 'commander';
import { resolve } from 'node:path';
import { AttioClient } from '../client.js';
import { EXPORT_RESOURCES, exportWorkspace, type ExportResource } from '../export.js';

export function register(program: Command): void {
  program.command('export <objects...>')
    .description('Export full records and related resources to a private, resumable directory')
    .option('--dir <path>', 'Output directory (must be empty for a new export)', '.attio-workspace')
    .option('--include <resources>', 'Comma-separated resources: records,attributes,notes,emails,files', EXPORT_RESOURCES.join(','))
    .option('--resume', 'Resume the same selection, checking existing files and page checkpoints')
    .option('--concurrency <n>', 'Concurrent file requests (1–32)', '8')
    .option('--max-choices <n>', 'Maximum active options/statuses saved per attribute (applied after API response)', '100')
    .action(async function (this: Command, objects: string[]) {
      const opts = this.optsWithGlobals();
      const directory = resolve(opts.dir);
      const manifest = await exportWorkspace(new AttioClient(opts.apiKey, opts.debug), {
        directory, objects, include: opts.include.split(',').map((value: string) => value.trim()) as ExportResource[],
        resume: opts.resume ?? false, concurrency: Number(opts.concurrency),
        maxChoices: Number(opts.maxChoices),
        progress: message => console.error(message),
      });
      console.log(JSON.stringify({
        status: manifest.status, directory, manifest: resolve(directory, 'manifest.json'),
        resources: manifest.resources,
      }, null, 2));
      if (manifest.status !== 'complete') throw new Error('Export incomplete. See manifest.json for blocked resources; rerun with --resume after resolving access or errors.');
    });
}
