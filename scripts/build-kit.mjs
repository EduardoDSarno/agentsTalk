import { bundleKit } from '../install-kit.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
fs.mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
await bundleKit(fileURLToPath(new URL('../dist/', import.meta.url)));
