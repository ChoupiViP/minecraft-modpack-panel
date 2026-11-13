// Vérifie la syntaxe de tous les fichiers JavaScript du projet (utilisé par la CI).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const files = ['src', 'public', 'test', 'scripts'].flatMap((dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)),
);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`${files.length} fichiers vérifiés.`);
