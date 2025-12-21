import { mkdirSync, existsSync } from 'node:fs';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copyPackageDist({ repoRoot, pkgFolderName, targetFolderName }) {
  const srcPkgDir = path.join(repoRoot, 'packages', pkgFolderName);
  const srcDistDir = path.join(srcPkgDir, 'dist');
  const srcPkgJson = path.join(srcPkgDir, 'package.json');

  if (!existsSync(srcPkgJson)) throw new Error(`Missing ${srcPkgJson}`);
  if (!existsSync(srcDistDir)) {
    throw new Error(`Missing ${srcDistDir}. Build the package first (tsc output).`);
  }

  const functionsDir = path.join(repoRoot, 'apps', 'functions');
  const vendorDir = path.join(functionsDir, 'vendor');
  const outDir = path.join(vendorDir, targetFolderName);

  ensureDir(outDir);

  // Copy package.json and dist/*
  cpSync(srcPkgJson, path.join(outDir, 'package.json'));
  cpSync(srcDistDir, path.join(outDir, 'dist'), { recursive: true });
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // scriptDir: <repo>/apps/functions/scripts
  const repoRoot = path.resolve(scriptDir, '..', '..', '..');

  // Ensure vendor root exists
  const vendorRoot = path.join(repoRoot, 'apps', 'functions', 'vendor');
  ensureDir(vendorRoot);

  copyPackageDist({ repoRoot, pkgFolderName: 'qc-engine', targetFolderName: 'qc-engine' });
  copyPackageDist({ repoRoot, pkgFolderName: 'shared', targetFolderName: 'shared' });

  console.log('Prepared apps/functions/vendor with workspace package dist outputs.');
}

main();
