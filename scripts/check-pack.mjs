/**
 * Validate a *packed* bundle directory.
 *
 * `scripts/validate.mjs` checks the repository. This checks the artifact that
 * `pnpm pack` produced, which is what actually gets installed: a path can exist
 * in the repo and still be missing from the tarball because `files` forgot it.
 *
 * Usage: node scripts/check-pack.mjs <unpacked-package-dir>
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '');
const problems = [];
const ok = [];

if (!existsSync(join(root, 'package.json'))) {
	console.error(`  FAIL  ${root}/package.json not found — pass the unpacked package directory`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Concrete paths for a package path that may contain `*` wildcards. */
function expand(pattern) {
	let candidates = [''];
	for (const segment of pattern.replace(/^\.\//, '').split('/')) {
		const next = [];
		for (const prefix of candidates) {
			if (!segment.includes('*')) {
				next.push(prefix === '' ? segment : `${prefix}/${segment}`);
				continue;
			}
			const matcher = new RegExp(
				`^${segment
					.split('*')
					.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
					.join('[^/]*')}$`,
			);
			const dir = prefix === '' ? root : join(root, prefix);
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir)) {
				if (matcher.test(entry)) next.push(prefix === '' ? entry : `${prefix}/${entry}`);
			}
		}
		candidates = next;
	}
	return candidates;
}

const resolves = (pattern) => expand(pattern).some((candidate) => existsSync(join(root, candidate)));

// Everything the runtime resolves must be inside the artifact.
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
	if (typeof target !== 'string') continue;
	if (!resolves(target)) problems.push(`exports["${key}"] -> "${target}" is absent from the package`);
}

for (const required of ['index.js', 'cordis.patch.yml']) {
	if (!existsSync(join(root, required))) problems.push(`"${required}" is absent from the package`);
}

// Display metadata is read from disk by Plugin Manager before activation.
for (const locale of ['en', 'zh']) {
	const file = join(root, 'locale', `${locale}.json`);
	if (!existsSync(file)) {
		problems.push(`locale/${locale}.json is absent from the package`);
		continue;
	}
	const doc = JSON.parse(readFileSync(file, 'utf8'));
	if (typeof doc?.meta?.title !== 'string' || doc.meta.title.trim() === '') {
		problems.push(`locale/${locale}.json has no meta.title`);
	}
}

const icon = join(root, 'icon.svg');
if (!existsSync(icon)) problems.push('icon.svg is absent from the package');
else if (statSync(icon).size === 0) problems.push('icon.svg is empty');

// The entry must load from the artifact with no dev dependencies present.
try {
	const module = await import(pathToFileURL(join(root, 'index.js')).href);
	if (typeof module.apply !== 'function') problems.push('index.js does not export apply()');
	else if (!Array.isArray(module.inject)) problems.push('index.js does not export inject');
	else ok.push(`entry loads from the artifact, inject [${module.inject.join(', ')}]`);
} catch (error) {
	problems.push(`index.js cannot be imported from the artifact: ${error.message}`);
}

// Dev-only files must not have leaked in.
for (const leaked of ['node_modules', 'scripts', 'test', 'pnpm-lock.yaml']) {
	if (existsSync(join(root, leaked))) problems.push(`"${leaked}" leaked into the package`);
}

for (const note of ok) console.log(`  ok    ${note}`);
for (const problem of problems) console.error(`  FAIL  ${problem}`);

if (problems.length > 0) {
	console.error(`\n${problems.length} packaging problem(s)\n`);
	process.exitCode = 1;
} else {
	console.log('\npackaged bundle OK\n');
}
