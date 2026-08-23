import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where Flatline keeps its state. Its own module, and not part of db.js, so that
 * secrets.js can find the encryption key without importing the database: db.js
 * imports migrations.js, which needs secrets.js for the one migration that
 * renames a stored credential, and that would be a cycle.
 *
 * db.js re-exports both, since everything else already reaches for them there.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = process.env.FLATLINE_DATA_DIR ?? path.join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const dbFile = path.join(dataDir, 'flatline.db');
