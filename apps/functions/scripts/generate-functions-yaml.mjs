import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/ -> functions/ -> apps/ -> repo root
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const functionsDir = path.resolve(repoRoot, 'apps', 'functions');
const outputPath = path.resolve(functionsDir, 'functions.yaml');

// Derive the SDK install directory from its exported entrypoint, then run its JS bin via Node.
// Some versions of firebase-functions do not export package.json.
const entryPath = require.resolve('firebase-functions', { paths: [repoRoot] });
const pkgRoot = path.resolve(path.dirname(entryPath), '..', '..');
const binJsPath = path.resolve(pkgRoot, 'lib', 'bin', 'firebase-functions.js');

await new Promise((resolve, reject) => {
	// firebase-functions CLI currently only reads functionsDir when args.length > 1.
	// Pass a harmless second arg to ensure it uses our functionsDir.
	const child = spawn(process.execPath, [binJsPath, functionsDir, '__noop__'], {
		cwd: repoRoot,
		env: {
			...process.env,
			FUNCTIONS_MANIFEST_OUTPUT_PATH: outputPath
		},
		stdio: 'inherit'
	});

	child.on('error', reject);
	child.on('exit', (code) => {
		if (code === 0) resolve();
		reject(new Error(`firebase-functions manifest generation failed (exit ${code})`));
	});
});
