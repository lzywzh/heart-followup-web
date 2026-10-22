import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const content = template
  .replaceAll('CHANGE_ME_DATABASE_PASSWORD', randomBytes(24).toString('hex'))
  .replaceAll('CHANGE_ME_SESSION_SECRET', randomBytes(32).toString('hex'));
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created local .env with random development credentials. Existing files are never overwritten.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env already exists; kept it unchanged.');
    process.exitCode = 1;
  } else throw error;
}
