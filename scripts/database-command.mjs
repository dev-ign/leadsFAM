import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { runLocalCLI, assertLocalBindings } from './local-stack.mjs';

const operation = process.argv[2];
if (operation === 'bindings') {
  assertLocalBindings();
  console.log('All local development ports are loopback-only.');
  process.exit(0);
}
const commands = {
  start: ['start'],
  reset: ['db', 'reset', '--local'],
  test: ['test', 'db', '--local'],
  advisors: ['db', 'advisors', '--local', '--fail-on', 'warn'],
  'types-check': ['gen', 'types', '--local', '--lang', 'typescript', '--schema', 'public'],
  types: ['gen', 'types', '--local', '--lang', 'typescript', '--schema', 'public'],
};
if (!commands[operation]) throw new Error('Choose an explicit local database operation.');
console.log(`Running local Supabase ${operation}; credential output is not printed.`);
const output = runLocalCLI(commands[operation]);
if (operation === 'types' || operation === 'types-check') {
  if (!output.includes('export type Database'))
    throw new Error('Unexpected database type-generation output.');
  const target = fileURLToPath(
    new URL('../packages/database/src/database.types.ts', import.meta.url),
  );
  const formatted = await format(output, {
    ...(await resolveConfig(target)),
    parser: 'typescript',
  });
  if (operation === 'types-check') {
    if ((await readFile(target, 'utf8')) !== formatted)
      throw new Error('Database type drift: run pnpm db:types and review the diff.');
  } else await writeFile(target, formatted);
} else if (operation === 'test' || operation === 'advisors') {
  // SQL test/advisor output has no generated connection credentials.
  console.log(output);
}
console.log(`Local ${operation} completed.`);
