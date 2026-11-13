// À importer en premier dans chaque test : isole les données dans un dossier temporaire.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-panel-test-'));
process.env.PANEL_DATA_DIR = TEST_DATA_DIR;

/** Crée un dossier temporaire propre au test. */
export function tempDir(prefix = 'case-') {
  return fs.mkdtempSync(path.join(TEST_DATA_DIR, prefix));
}
