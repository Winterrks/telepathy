import { autoUpdateEnabled, setAutoUpdate } from '../auto-update.ts';
import { stateDir } from '../core/paths.ts';

/** `telepathy config` and `telepathy config auto-update on|off`. */
export function configCommand(args: string[]): number {
  const [key, value] = args;
  if (!key) {
    console.log(`state: ${stateDir()}`);
    console.log(`auto-update: ${autoUpdateEnabled() ? 'on' : 'off'}`);
    console.log('Disable with `telepathy config auto-update off` or TELEPATHY_AUTO_UPDATE=0.');
    return 0;
  }
  if (key !== 'auto-update') {
    console.error(`Unknown setting ${JSON.stringify(key)}. Known: auto-update.`);
    return 1;
  }
  if (value !== 'on' && value !== 'off') {
    console.error('Usage: telepathy config auto-update on|off');
    return 1;
  }
  setAutoUpdate(value === 'on');
  console.log(`auto-update: ${value}`);
  return 0;
}
