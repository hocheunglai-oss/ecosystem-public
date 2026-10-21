import { readFile, writeFile, chmod } from 'node:fs/promises';
import { prepareSpcRoster } from '../server/access/spcRoster.ts';
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || inputPath === outputPath) throw new Error('Supply separate private input and output file paths.');
const input = JSON.parse(await readFile(inputPath,'utf8'));
const output = prepareSpcRoster(input.rows, input.decisions);
await writeFile(outputPath, JSON.stringify(output,null,2)+'\n', { mode:0o600 });
await chmod(outputPath,0o600);
console.log(JSON.stringify({ users:output.users.length, active:output.users.filter(user=>user.isActive).length,
  administrators:output.users.filter(user=>user.isAdmin).length, offices:output.offices.length,
  accountsCreated:0, emailsSent:0 }));
