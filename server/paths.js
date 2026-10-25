import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..');
// The desktop app redirects this to a writable location next to the executable.
export const DATA_DIR = process.env.CAMNET_DATA_DIR
  ? path.resolve(process.env.CAMNET_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
export const DIST_DIR = path.join(ROOT_DIR, 'dist');
