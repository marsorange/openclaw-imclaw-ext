import fs from 'fs';

export function readLocalFile(path: string): Buffer {
  return fs.readFileSync(path);
}
