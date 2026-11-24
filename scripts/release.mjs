import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromeSource = join(root, 'packages', 'core', 'browser-bridge', 'extension');
const releaseDir = join(root, 'release');
const chromeReleaseDir = join(releaseDir, 'chrome-extension');

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.txt']);
const BUILD_PLACEHOLDER = '__BRIDGE_AUTH_TOKEN__';

function run(command, args, cwd = root) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function runCapture(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walkFiles(path));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

function isTextFile(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Validate text that is safe to ship. This deliberately checks build-time
 * credential markers and credential-shaped values, while allowing ordinary
 * UI placeholder attributes and generic example model names in the scaffold.
 */
export function validateReleaseText(text, filePath = 'release artifact', options = {}) {
  const { allowBuildPlaceholder = false } = options;
  const scanText = allowBuildPlaceholder ? text.replaceAll(BUILD_PLACEHOLDER, '') : text;
  if ((!allowBuildPlaceholder && text.includes(BUILD_PLACEHOLDER)) || /__REPLACE_[A-Z0-9_]+__/.test(scanText)) {
    throw new Error(`${filePath}: unresolved credential placeholder`);
  }
  if (/token-literal-example|example-legacy-secret-token/i.test(scanText)) {
    throw new Error(`${filePath}: known credential placeholder`);
  }
  if (/Bearer\s+[A-Za-z0-9._~-]{16,}/i.test(scanText)) {
    throw new Error(`${filePath}: credential-shaped bearer value`);
  }
  if (/(?:sk|gh[pousr]|xox[baprs]|AIza)[-_A-Za-z0-9]{16,}/.test(scanText)) {
    throw new Error(`${filePath}: credential-shaped value`);
  }
}

function addReference(references, value) {
  if (typeof value === 'string' && value) references.add(value);
}

function manifestReferences(manifest) {
  const references = new Set();
  addReference(references, manifest.background?.service_worker);
  addReference(references, manifest.action?.default_popup);
  addReference(references, manifest.options_page);
  addReference(references, manifest.options_ui?.page);
  addReference(references, manifest.devtools_page);
  addReference(references, manifest.side_panel?.default_path);
  for (const value of Object.values(manifest.icons ?? {})) addReference(references, value);
  for (const value of Object.values(manifest.chrome_url_overrides ?? {})) addReference(references, value);
  for (const script of manifest.content_scripts ?? []) {
    for (const value of script.js ?? []) addReference(references, value);
  }
  for (const resourceGroup of manifest.web_accessible_resources ?? []) {
    for (const value of resourceGroup.resources ?? []) addReference(references, value);
  }
  for (const value of manifest.sandbox?.pages ?? []) addReference(references, value);
  return [...references];
}

function assertReferencedFiles(extensionDir, manifest) {
  const errors = [];
  for (const reference of manifestReferences(manifest)) {
    if (reference.includes('..') || reference.startsWith('/')) {
      errors.push(`unsafe manifest reference ${reference}`);
      continue;
    }
    if (!existsSync(join(extensionDir, reference))) errors.push(`missing manifest reference ${reference}`);
  }
  return errors;
}

function htmlReferencedFiles(extensionDir, htmlPath) {
  const references = [];
  const html = readFileSync(htmlPath, 'utf8');
  const attributePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const reference = match[1];
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) references.push(reference);
  }
  return references;
}

/**
 * Validate a Chrome load-unpacked directory. Build placeholders are permitted
 * only in the source tree; packaged output must call this with false unless
 * validating the credential-free scaffolding bundle.
 */
export function validateChromeExtension(extensionDir, options = {}) {
  const { expectedVersion, allowBuildPlaceholders = false } = options;
  const errors = [];
  const manifestPath = join(extensionDir, 'manifest.json');
  let manifest;
  try {
    manifest = readJson(manifestPath);
    if (manifest.manifest_version !== 3) errors.push('manifest.json: manifest_version must be 3');
    if (expectedVersion && manifest.version !== expectedVersion) {
      errors.push(`manifest.json: expected version ${expectedVersion}, got ${manifest.version}`);
    }
    errors.push(...assertReferencedFiles(extensionDir, manifest));
  } catch (error) {
    errors.push(`manifest.json: ${error.message}`);
  }

  for (const path of walkFiles(extensionDir)) {
    const name = relative(extensionDir, path);
    if (isTextFile(path)) {
      const text = readFileSync(path, 'utf8');
      try {
        validateReleaseText(text, name, { allowBuildPlaceholder: allowBuildPlaceholders });
      } catch (error) {
        errors.push(error.message);
      }
      if (extname(path).toLowerCase() === '.html') {
        for (const reference of htmlReferencedFiles(extensionDir, path)) {
          const resolved = resolve(dirname(path), reference);
          const relativeReference = relative(extensionDir, resolved);
          if (relativeReference.startsWith('..') || relativeReference.startsWith('/')) {
            errors.push(`${name}: unsafe HTML reference ${reference}`);
          } else if (!existsSync(resolved)) {
            errors.push(`${name}: missing HTML reference ${reference}`);
          }
        }
      }
    }
    if (extname(path).toLowerCase() === '.js') {
      try {
        execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
      } catch (error) {
        const detail = String(error.stderr ?? error.message).trim();
        errors.push(`${name}: JavaScript syntax check failed${detail ? ` (${detail})` : ''}`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`Chrome extension validation failed:\n- ${errors.join('\n- ')}`);
  }
  return manifest;
}

function archiveEntries(archivePath) {
  return runCapture('unzip', ['-Z1', archivePath]).split(/\r?\n/).filter(Boolean);
}

function extractArchive(archivePath) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-edge-bridge-release-'));
  try {
    run('unzip', ['-q', archivePath, '-d', directory]);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function validateArchiveIntegrity(archivePath) {
  run('unzip', ['-tq', archivePath]);
  const entries = archiveEntries(archivePath);
  if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
    throw new Error(`${archivePath}: archive contains an unsafe path`);
  }
  return entries;
}

function validateChromeZip(zipPath, expectedVersion) {
  validateArchiveIntegrity(zipPath);
  const extracted = extractArchive(zipPath);
  try {
    validateChromeExtension(extracted, { expectedVersion, allowBuildPlaceholders: true });
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

function copyChromeSource(destination) {
  cpSync(chromeSource, destination, { recursive: true });
}

function packageVersionCheck() {
  const rootPackage = readJson(join(root, 'package.json'));
  const chromeManifest = readJson(join(chromeSource, 'manifest.json'));
  const versions = [rootPackage.version, chromeManifest.version];
  if (new Set(versions).size !== 1) {
    throw new Error(`version mismatch: root=${versions[0]}, chrome=${versions[1]}`);
  }
  return { version: versions[0] };
}

export function cleanTrackedReleaseTargets(targetReleaseDir = releaseDir) {
  rmSync(join(targetReleaseDir, 'chrome-extension'), { recursive: true, force: true });
  if (!existsSync(targetReleaseDir)) return;
  for (const entry of readdirSync(targetReleaseDir)) {
    if (/^browser-edge-bridge-chrome-v.*\.zip$/i.test(entry)) {
      rmSync(join(targetReleaseDir, entry), { force: true });
    }
  }
}

function main() {
  const { version } = packageVersionCheck();

  validateChromeExtension(chromeSource, { expectedVersion: version, allowBuildPlaceholders: true });

  cleanTrackedReleaseTargets(releaseDir);
  mkdirSync(chromeReleaseDir, { recursive: true });
  copyChromeSource(chromeReleaseDir);

  validateChromeExtension(chromeReleaseDir, { expectedVersion: version, allowBuildPlaceholders: true });
  const chromeZip = join(releaseDir, `browser-edge-bridge-chrome-v${version}.zip`);
  run('zip', ['-qr', '-X', chromeZip, '.'], chromeReleaseDir);
  validateChromeZip(chromeZip, version);

  console.log('\nRelease artifacts:');
  console.log(`- ${chromeReleaseDir} (Chrome: Load unpacked)`);
  console.log(`- ${chromeZip}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
