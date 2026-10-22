import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOpenApiDocument, parseOpenApiDocument } from './openapi-contract.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const redoclyCli = `${projectRoot}node_modules/@redocly/cli/bin/cli.js`;
const redoclyConfig = `${projectRoot}redocly.yaml`;

export async function checkOpenApiFile(specPath = `${projectRoot}openapi.yaml`, { lint = true } = {}) {
  const source = await readFile(specPath, 'utf8');
  const document = parseOpenApiDocument(source, specPath);
  checkOpenApiDocument(document);

  if (lint) {
    // Redocly currently exposes its CLI as a bundled executable rather than a
    // stable programmatic API. Run that bundle in-process after our no-network
    // reference preflight has completed.
    process.argv = [process.execPath, redoclyCli, 'lint', specPath, '--config', redoclyConfig];
    await import(pathToFileURL(redoclyCli).href);
  }
  return document;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkOpenApiFile(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
