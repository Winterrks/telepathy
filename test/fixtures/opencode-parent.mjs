// Spawns the OpenCode driver as a child. Flags before `--` stay on this process's command line, which is
// what the plugin reads when OpenCode 1.19 does not put `--session` on the plugin process itself.
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const childArgs = sep >= 0 ? process.argv.slice(sep + 1) : [];
const child = spawn(process.execPath, childArgs, { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
