/**
 * Bundle contract validator.
 *
 * A DSH Host bundle is not just JavaScript: Plugin Manager reads display
 * metadata and an icon straight out of the package without activating it, and
 * the Loader reads `dsh.bundle.patch`. A broken path there fails at install
 * time, in the UI, far from the code that broke it. This script fails fast
 * instead, and needs no dependencies so it runs anywhere.
 *
 * Checks:
 *   1. package.json manifest fields a bundle must carry
 *   2. every declared `exports` / `files` path actually exists
 *   3. locale metadata (`meta.title`, `meta.description`) for each locale
 *   4. the icon is a well-formed, in-package SVG under the size limit
 *   5. cordis.patch.yml inserts exactly this package
 *   6. index.js loads and exposes the Host plugin export form
 *
 * Usage: node scripts/validate.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ICON_BYTES = 256 * 1024;

const problems = [];
const notes = [];

/** Escape a string so it can be embedded in a RegExp. */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile one path segment with `*` wildcards into a matcher. */
function segmentRegExp(segment) {
	return new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`);
}

/** Turn a package path (possibly containing `*`) into concrete candidate paths. */
function expand(pattern) {
	const segments = pattern.replace(/^\.\//, '').split('/');
	let candidates = [''];
	for (const segment of segments) {
		const wildcard = segment.includes('*');
		const matcher = wildcard ? segmentRegExp(segment) : undefined;
		const next = [];
		for (const prefix of candidates) {
			if (matcher === undefined) {
				next.push(prefix === '' ? segment : `${prefix}/${segment}`);
				continue;
			}
			const dir = prefix === '' ? ROOT : join(ROOT, prefix);
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir)) {
				if (!matcher.test(entry)) continue;
				next.push(prefix === '' ? entry : `${prefix}/${entry}`);
			}
		}
		candidates = next;
	}
	return candidates;
}

/** True when at least one concrete match of `pattern` exists on disk. */
function resolves(pattern) {
	return expand(pattern).some((candidate) => existsSync(join(ROOT, candidate)));
}

// --- 1. manifest -----------------------------------------------------------
const manifestPath = join(ROOT, 'package.json');
let manifest;

if (!existsSync(manifestPath)) {
	problems.push('package.json is missing');
} else {
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		problems.push(`package.json is not valid JSON: ${error.message}`);
	}
}

if (manifest !== undefined) {
	for (const field of ['name', 'version', 'description', 'license']) {
		if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
			problems.push(`package.json: "${field}" must be a non-empty string`);
		}
	}
	if (manifest.type !== 'module') {
		problems.push('package.json: "type" must be "module" (the Loader imports ESM)');
	}
	if (typeof manifest.dsh?.bundle?.patch !== 'string') {
		problems.push('package.json: "dsh.bundle.patch" is missing');
	}
	if (manifest.exports?.['.'] === undefined) {
		problems.push('package.json: exports["."] is missing');
	}
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
		problems.push('package.json: "files" must list the runtime assets');
	}

	// --- 2. declared paths exist -------------------------------------------
	const declared = [];
	for (const [key, target] of Object.entries(manifest.exports ?? {})) {
		if (typeof target === 'string') {
			declared.push([`exports["${key}"]`, target]);
			continue;
		}
		if (target !== null && typeof target === 'object') {
			for (const [condition, value] of Object.entries(target)) {
				if (typeof value === 'string') declared.push([`exports["${key}"].${condition}`, value]);
			}
		}
	}
	for (const entry of manifest.files ?? []) declared.push([`files "${entry}"`, entry]);

	for (const [label, target] of declared) {
		if (!resolves(target)) problems.push(`package.json: ${label} -> "${target}" does not exist`);
	}

	// --- 3. locale metadata ------------------------------------------------
	const localeDir = join(ROOT, 'locale');
	if (!existsSync(localeDir)) {
		problems.push('locale/ is missing (Plugin Manager reads display metadata from it)');
	} else {
		const locales = readdirSync(localeDir).filter((name) => name.endsWith('.json'));
		if (locales.length === 0) problems.push('locale/ contains no JSON files');
		for (const name of locales) {
			let doc;
			try {
				doc = JSON.parse(readFileSync(join(localeDir, name), 'utf8'));
			} catch (error) {
				problems.push(`locale/${name} is not valid JSON: ${error.message}`);
				continue;
			}
			for (const field of ['title', 'description']) {
				if (typeof doc?.meta?.[field] !== 'string' || doc.meta[field].trim().length === 0) {
					problems.push(`locale/${name}: "meta.${field}" must be a non-empty string`);
				}
			}
		}
		if (locales.length > 0) notes.push(`locale metadata (${locales.join(', ')})`);
	}

	// --- 4. icon -----------------------------------------------------------
	const iconTarget = manifest.exports?.['./icon'];
	if (typeof iconTarget !== 'string') {
		problems.push('package.json: exports["./icon"] is missing');
	} else {
		const iconPath = join(ROOT, iconTarget.replace(/^\.\//, ''));
		if (!existsSync(iconPath)) {
			problems.push(`icon "${iconTarget}" is missing`);
		} else {
			const bytes = statSync(iconPath).size;
			const svg = readFileSync(iconPath, 'utf8');
			if (bytes > MAX_ICON_BYTES) {
				problems.push(`icon is ${bytes} bytes, over the ${MAX_ICON_BYTES} byte limit`);
			}
			if (!svg.includes('<svg')) problems.push('icon does not look like SVG');
			if (!svg.trimEnd().endsWith('</svg>')) problems.push('icon SVG is not closed');
			if (/<script[\s>]/i.test(svg)) problems.push('icon SVG must not contain script');
			if (!iconPath.startsWith(ROOT)) problems.push('icon must stay inside the package');
			if (problems.length === 0) notes.push(`icon (${bytes} bytes, in-package)`);
		}
	}

	// --- 5. loader patch ---------------------------------------------------
	if (typeof manifest.dsh?.bundle?.patch === 'string') {
		const patchPath = join(ROOT, manifest.dsh.bundle.patch.replace(/^\.\//, ''));
		if (!existsSync(patchPath)) {
			problems.push(`patch "${manifest.dsh.bundle.patch}" is missing`);
		} else {
			const yaml = readFileSync(patchPath, 'utf8');
			if (!/^-\s*insert:/m.test(yaml)) problems.push(`${manifest.dsh.bundle.patch}: expected a "- insert:" entry`);
			if (!yaml.includes(manifest.name)) {
				problems.push(`${manifest.dsh.bundle.patch}: does not reference "${manifest.name}"`);
			}
			if (!/^\s*(?:-\s*)?id:\s*\S+/m.test(yaml)) {
				problems.push(`${manifest.dsh.bundle.patch}: insert entry needs an "id"`);
			}
			if (!/^\s*(?:-\s*)?name:\s*\S+/m.test(yaml)) {
				problems.push(`${manifest.dsh.bundle.patch}: insert entry needs a "name"`);
			}
			notes.push(`loader patch (${manifest.dsh.bundle.patch})`);
		}
	}

	// --- 6. plugin export form ---------------------------------------------
	const entry = manifest.exports?.['.'];
	const entryTarget = typeof entry === 'string' ? entry : entry?.default;
	if (typeof entryTarget === 'string') {
		const entryPath = join(ROOT, entryTarget.replace(/^\.\//, ''));
		if (!existsSync(entryPath)) {
			problems.push(`entry "${entryTarget}" is missing`);
		} else {
			try {
				const module = await import(pathToFileURL(entryPath).href);
				if (typeof module.apply !== 'function') {
					problems.push('index.js must export an `apply(ctx, config)` function');
				} else if (!Array.isArray(module.inject)) {
					problems.push('index.js must export `inject` listing the services it needs');
				} else {
					notes.push(`plugin exports apply + inject [${module.inject.join(', ')}]`);
				}
				if (module.Config !== undefined) notes.push('index.js exports Config (row config is Loader-validated)');
			} catch (error) {
				problems.push(`index.js failed to load: ${error.message}`);
			}
		}
	}
}

// --- report ----------------------------------------------------------------
for (const note of notes) console.log(`  ok    ${note}`);
for (const problem of problems) console.error(`  FAIL  ${problem}`);

if (problems.length > 0) {
	console.error(`\n${problems.length} bundle contract problem(s)\n`);
	process.exitCode = 1;
} else {
	console.log('\nbundle contract OK\n');
}
