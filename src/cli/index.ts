/**
 * Ace Code Search CLI (ess) — index management from command line
 * Usage:
 *   node dist/cli.js create --root ./src --db ./index.db [--name MyIndex]
 *   node dist/cli.js update --db ./index.db [--root ./src] [--force]
 *   node dist/cli.js list [--registry path/to/registry.json]
 */

import * as fs from 'fs';
import * as path from 'path';
import { IndexService } from '../index/IndexService';
import { IndexRegistry } from '../index/IndexRegistry';

interface CliArgs {
  command: string;
  root?: string;
  db?: string;
  name?: string;
  force?: boolean;
  registry?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = { command: args[0] ?? 'help' };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case '--root':
        result.root = next;
        i++;
        break;
      case '--db':
        result.db = next;
        i++;
        break;
      case '--name':
        result.name = next;
        i++;
        break;
      case '--force':
        result.force = true;
        break;
      case '--registry':
        result.registry = next;
        i++;
        break;
    }
  }
  return result;
}

async function cmdCreate(args: CliArgs): Promise<void> {
  if (!args.root || !args.db) {
    console.error('Usage: ess create --root <dir> --db <path.db> [--name Name]');
    process.exit(1);
  }
  const root = path.resolve(args.root);
  const dbPath = path.resolve(args.db);
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });

  const service = new IndexService(dbPath, { name: args.name ?? path.basename(root) });
  await service.initialize([root]);
  await service.startIndexing(true);
  service.dispose();
  console.log(`Created index: ${dbPath}`);
  console.log(`Root: ${root}`);
}

async function cmdUpdate(args: CliArgs): Promise<void> {
  if (!args.db) {
    console.error('Usage: ess update --db <path.db> [--root <dir>] [--force]');
    process.exit(1);
  }
  const dbPath = path.resolve(args.db);
  const root = args.root ? path.resolve(args.root) : path.dirname(dbPath);
  const service = new IndexService(dbPath);
  await service.initialize([root]);
  await service.startIndexing(args.force ?? false);
  service.dispose();
  console.log(`Updated index: ${dbPath}`);
}

async function cmdList(args: CliArgs): Promise<void> {
  const registryPath = args.registry
    ? path.resolve(args.registry)
    : path.join(process.cwd(), 'registry.json');
  const registry = new IndexRegistry(path.dirname(registryPath));
  await registry.load();
  const indexes = registry.getAll();
  if (indexes.length === 0) {
    console.log('No indexes in registry.');
    return;
  }
  for (const idx of indexes) {
    console.log(`${idx.name} (${idx.id})`);
    console.log(`  db: ${idx.dbPath}`);
    console.log(`  roots: ${idx.rootDirs.join(', ')}`);
    console.log(`  readOnly: ${idx.readOnly}`);
    if (idx.directoryMappings.length) {
      console.log(`  mappings: ${idx.directoryMappings.map((m) => `${m.from} => ${m.to}`).join('; ')}`);
    }
    console.log('');
  }
}

function printHelp(): void {
  console.log(`Ace Code Search CLI (ess)

Commands:
  create   --root <dir> --db <file.db> [--name <name>]
  update   --db <file.db> [--root <dir>] [--force]
  list     [--registry <registry.json>]
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case 'create':
      await cmdCreate(args);
      break;
    case 'update':
      await cmdUpdate(args);
      break;
    case 'list':
      await cmdList(args);
      break;
    default:
      printHelp();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
