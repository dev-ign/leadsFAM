import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const root = process.cwd();
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const allowed = {
  '@leadops/web': ['@leadops/ui', '@leadops/shared', '@leadops/config'],
  '@leadops/api': ['@leadops/shared', '@leadops/config'],
  '@leadops/ui': ['@leadops/config'],
  '@leadops/shared': ['@leadops/config'],
  '@leadops/config': [],
};
const browserPackages = new Set(['@leadops/web', '@leadops/ui', '@leadops/shared']);
const packages = [];
const errors = [];
for (const base of ['apps', 'packages']) {
  for (const entry of await readdir(path.join(root, base), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, base, entry.name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    packages.push({ directory, manifest });
  }
}
const graph = new Map();
const fileGraph = new Map();
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.turbo', 'coverage'].includes(entry.name)) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(location)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(location);
  }
  return result;
}
for (const { directory, manifest } of packages) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  const workspace = Object.keys(dependencies).filter((name) => name.startsWith('@leadops/'));
  graph.set(manifest.name, workspace);
  for (const dependency of workspace) {
    if (!allowed[manifest.name]?.includes(dependency))
      errors.push(`${manifest.name} cannot depend on ${dependency}`);
    if (dependencies[dependency] !== 'workspace:*')
      errors.push(`${manifest.name}: ${dependency} must use workspace:*`);
  }
  const sourceFiles = await files(directory);
  const sourceSet = new Set(sourceFiles);
  for (const file of sourceFiles) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges = [];
    function inspect(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) specifier = argument.text;
        else errors.push(`${path.relative(root, file)}: imports must use literal module names`);
      }
      if (specifier?.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (!target.startsWith(directory + path.sep))
          errors.push(`${path.relative(root, file)}: relative import crosses a package boundary`);
        const stem = target.replace(/\.js$/, '');
        const resolved = [
          target,
          `${stem}.ts`,
          `${stem}.tsx`,
          `${target}/index.ts`,
          `${target}/index.tsx`,
        ].find((candidate) => sourceSet.has(candidate));
        if (resolved) edges.push(resolved);
      } else if (specifier) {
        const builtin = builtins.has(specifier) || specifier.startsWith('node:');
        if (browserPackages.has(manifest.name) && builtin)
          errors.push(`${path.relative(root, file)}: Node builtin in browser-safe package`);
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!builtin && !dependencies[name])
          errors.push(`${path.relative(root, file)}: undeclared dependency ${name}`);
        if (name.startsWith('@leadops/') && !allowed[manifest.name]?.includes(name))
          errors.push(`${path.relative(root, file)}: forbidden package ${name}`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    fileGraph.set(file, edges);
  }
}
function checkCycles(graph, label) {
  const complete = new Set();
  function visit(node, chain) {
    if (chain.includes(node)) {
      errors.push(
        `${label} cycle: ${[...chain, node].map((item) => (path.isAbsolute(item) ? path.relative(root, item) : item)).join(' → ')}`,
      );
      return;
    }
    if (complete.has(node)) return;
    for (const dependency of graph.get(node) ?? []) visit(dependency, [...chain, node]);
    complete.add(node);
  }
  for (const node of graph.keys()) visit(node, []);
}
checkCycles(graph, 'Package');
checkCycles(fileGraph, 'Module');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Package and module boundaries verified (${packages.length} packages).`);
