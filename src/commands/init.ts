import { Command } from 'commander';
import chalk from 'chalk';
import { AttioClient } from '../client.js';
import { setApiKey, getConfigPath, isConfigured } from '../config.js';
import { prompt } from '../prompt.js';

export function register(program: Command): void {
  program
    .command('init')
    .description('Interactive setup wizard — connect to your Attio workspace')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      let apiKey = opts.apiKey as string | undefined;

      if (!apiKey) {
        // Non-TTY: print manual instructions and exit
        if (!process.stdin.isTTY) {
          console.log('Non-interactive environment detected. To configure manually:\n');
          console.log('  export ATTIO_API_KEY=your_key');
          console.log('  # or');
          console.log(`  attio config set api-key your_key`);
          console.log(`  # or`);
          console.log(`  attio init --api-key your_key\n`);
          console.log(`Get your API key at: https://app.attio.com/settings/developers`);
          return;
        }

        // Check for existing key
        if (isConfigured()) {
          const overwrite = await prompt(
            chalk.yellow('An API key is already configured. Overwrite? [y/N] '),
          ).catch(() => '');
          if (overwrite.trim().toLowerCase() !== 'y') {
            console.error(chalk.dim('Setup cancelled.'));
            return;
          }
        }

        // Interactive prompt
        console.error('');
        console.error(chalk.bold('  Attio CLI Setup'));
        console.error(chalk.dim('  ───────────────'));
        console.error('');
        console.error(`  You'll need an API key from ${chalk.cyan('https://app.attio.com/settings/developers')}`);
        console.error('');

        try {
          apiKey = await prompt('  Paste your API key: ', { mask: true });
        } catch {
          // Ctrl+C or closed input
          console.error('');
          process.exit(0);
        }
      }

      // Clean up the key (trim whitespace, strip surrounding quotes)
      apiKey = (apiKey as string).trim().replace(/^['"]|['"]$/g, '');

      if (!apiKey) {
        console.error(chalk.red('\n  No API key provided.'));
        console.error(`  Get one at: ${chalk.cyan('https://app.attio.com/settings/developers')}`);
        process.exit(1);
      }

      // Validate against /self
      process.stderr.write(chalk.dim('  Verifying...'));
      try {
        const client = new AttioClient(apiKey);
        const self = await client.get<Record<string, any>>('/self');

        console.error(chalk.green(' ✓'));
        console.error('');

        const name = self.workspace_name || 'your workspace';
        const slug = self.workspace_slug;
        console.error(`  Connected to ${chalk.bold(`"${name}"`)}${slug ? ` (${slug})` : ''}`);

        // Save the key
        setApiKey(apiKey);
        console.error(`  API key saved to ${chalk.dim(getConfigPath())}`);

        // Agent setup nudge
        console.error('');
        console.error(chalk.dim('  ───────────────'));
        console.error(chalk.bold('  Agent Setup') + chalk.dim(' (optional)'));
        console.error('');
        console.error('  To let AI agents discover this CLI, run:');
        console.error('');
        console.error(`    ${chalk.cyan('attio config claude-md >> CLAUDE.md')}`);
        console.error('');
        console.error(`  Done! Try ${chalk.cyan('attio whoami')} or ${chalk.cyan('attio companies list')} to get started.`);
        console.error('');
      } catch (err: any) {
        console.error(chalk.red(' ✗'));
        console.error('');
        if (err?.message?.includes('Invalid or expired') || err?.message?.includes('401') || err?.message?.includes('not recognised')) {
          console.error(chalk.red('  Invalid API key.'));
          console.error(`  Double-check at: ${chalk.cyan('https://app.attio.com/settings/developers')}`);
        } else {
          console.error(chalk.red(`  Could not connect: ${err?.message || err}`));
        }
        process.exit(1);
      }
    });
}
