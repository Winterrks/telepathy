/**
 * What `session/new` offers, and how a started agent gets its mode, model and effort. Agents describe these
 * as `configOptions` (`category` mode, model, thought_level) set with `session/set_config_option`; older ones
 * as `modes` and `models`, set with `session/set_mode` and `session/set_model`.
 */

export interface Choice {
  value: string;
  name?: string;
}

interface ConfigOption {
  id: string;
  category?: string;
  options: Choice[];
}

export interface Offer {
  mode?: { configId?: string; choices: Choice[] };
  model?: { configId?: string; choices: Choice[] };
  effort?: { configId: string; choices: Choice[] };
}

function flatten(options: unknown): Choice[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((item) => {
    const entry = (item ?? {}) as { value?: unknown; name?: unknown; options?: unknown };
    if (Array.isArray(entry.options)) return flatten(entry.options);
    return typeof entry.value === 'string' ? [{ value: entry.value, name: typeof entry.name === 'string' ? entry.name : undefined }] : [];
  });
}

export function readOffer(created: unknown): Offer {
  const root = (created ?? {}) as {
    configOptions?: unknown;
    modes?: { availableModes?: { id?: unknown; name?: unknown }[] };
    models?: { availableModels?: { modelId?: unknown; name?: unknown }[] };
  };
  const options: ConfigOption[] = Array.isArray(root.configOptions)
    ? root.configOptions.flatMap((raw) => {
        const o = (raw ?? {}) as { id?: unknown; category?: unknown; options?: unknown };
        return typeof o.id === 'string' ? [{ id: o.id, category: typeof o.category === 'string' ? o.category : undefined, options: flatten(o.options) }] : [];
      })
    : [];
  const byCategory = (category: string) => options.find((o) => o.category === category) ?? options.find((o) => o.id === category);
  const offer: Offer = {};
  const mode = byCategory('mode');
  if (mode) offer.mode = { configId: mode.id, choices: mode.options };
  else if (root.modes?.availableModes?.length) {
    offer.mode = {
      choices: root.modes.availableModes.flatMap((m) => (typeof m.id === 'string' ? [{ value: m.id, name: typeof m.name === 'string' ? m.name : undefined }] : [])),
    };
  }
  const model = byCategory('model');
  if (model) offer.model = { configId: model.id, choices: model.options };
  else if (root.models?.availableModels?.length) {
    offer.model = {
      choices: root.models.availableModels.flatMap((m) => (typeof m.modelId === 'string' ? [{ value: m.modelId, name: typeof m.name === 'string' ? m.name : undefined }] : [])),
    };
  }
  const effort = options.find((o) => o.category === 'thought_level');
  if (effort) offer.effort = { configId: effort.id, choices: effort.options };
  return offer;
}

/** The last segment of an id like `https://…/session-modes#autopilot`, lowercased. */
const tail = (value: string) => value.toLowerCase().split(/[#/]/).pop() ?? '';

/**
 * The harness's auto mode: one named `auto`, then Copilot's `autopilot`, then Devin's `smart`. Never a
 * bypass or yolo mode: those approve everything, and auto is what was asked for.
 */
export function autoMode(choices: Choice[]): string | undefined {
  for (const wanted of ['auto', 'autopilot', 'smart']) {
    const hit = choices.find((c) => tail(c.value) === wanted || c.name?.toLowerCase() === wanted);
    if (hit) return hit.value;
  }
  return undefined;
}

const base = (value: string) => value.toLowerCase().replace(/\[.*$/, '');

/**
 * The choice `wanted` names: the exact value, then a case-insensitive one, then one whose value or name starts
 * with it, then one that contains it. Cursor's variants (`claude-opus-5-5[effort=high,…]`) share a base, so
 * `effort` picks among them when given.
 */
export function pickModel(choices: Choice[], wanted: string, effort?: string): { value?: string; ambiguous?: string[] } {
  const q = wanted.trim().toLowerCase();
  const exact = choices.filter((c) => c.value === wanted);
  if (exact.length === 1) return { value: exact[0].value };
  const tiers = [
    choices.filter((c) => c.value.toLowerCase() === q || c.name?.toLowerCase() === q || base(c.value) === q),
    choices.filter((c) => base(c.value).startsWith(q) || c.name?.toLowerCase().startsWith(q)),
    choices.filter((c) => base(c.value).includes(q) || c.name?.toLowerCase().includes(q)),
  ];
  for (let matches of tiers) {
    if (!matches.length) continue;
    if (effort && matches.length > 1) {
      const e = effort.toLowerCase();
      const withEffort = matches.filter((c) => new RegExp(`(?:^|[,\\[])(?:effort|reasoning_effort|reasoning)=${e}(?:[,\\]]|$)`).test(c.value.toLowerCase()));
      if (withEffort.length) matches = withEffort;
    }
    const bases = new Set(matches.map((c) => base(c.value)));
    if (matches.length === 1 || bases.size === 1) return { value: matches[0].value };
    return { ambiguous: matches.map((c) => c.value) };
  }
  return {};
}

export function pickEffort(choices: Choice[], wanted: string): string | undefined {
  const q = wanted.trim().toLowerCase();
  return choices.find((c) => c.value.toLowerCase() === q || c.name?.toLowerCase() === q)?.value;
}

export interface Applied {
  settings: string[];
  notes: string[];
}

type Request = (method: string, params: unknown) => Promise<unknown>;

/** Sets auto mode, then the model, then the effort. A model or effort that does not exist is an error. */
export async function applySettings(
  request: Request,
  sessionId: string,
  created: unknown,
  wanted: { model?: string; effort?: string },
): Promise<Applied> {
  const offer = readOffer(created);
  const settings: string[] = [];
  const notes: string[] = [];
  const setOption = (configId: string, value: string) => request('session/set_config_option', { sessionId, configId, value });

  const auto = offer.mode ? autoMode(offer.mode.choices) : undefined;
  if (auto) {
    if (offer.mode?.configId) await setOption(offer.mode.configId, auto);
    else await request('session/set_mode', { sessionId, modeId: auto });
    settings.push(`mode ${tail(auto)}`);
  } else {
    notes.push('This harness has no auto mode, so each permission request it makes comes to you.');
  }

  let modelValue: string | undefined;
  if (wanted.model) {
    if (!offer.model?.choices.length) throw new Error(`this harness does not offer a model choice over ACP, so model "${wanted.model}" cannot be set`);
    const picked = pickModel(offer.model.choices, wanted.model, offer.effort ? undefined : wanted.effort);
    if (picked.ambiguous) {
      throw new Error(`model "${wanted.model}" matches ${picked.ambiguous.length} models: ${picked.ambiguous.slice(0, 12).join(', ')}`);
    }
    if (!picked.value) {
      throw new Error(`no model matches "${wanted.model}". Available: ${offer.model.choices.slice(0, 40).map((c) => c.value).join(', ')}`);
    }
    modelValue = picked.value;
    if (offer.model.configId) await setOption(offer.model.configId, picked.value);
    else await request('session/set_model', { sessionId, modelId: picked.value });
    settings.push(`model ${picked.value}`);
  }

  if (wanted.effort) {
    if (offer.effort) {
      const value = pickEffort(offer.effort.choices, wanted.effort);
      if (!value) {
        throw new Error(`effort "${wanted.effort}" is not one of ${offer.effort.choices.map((c) => c.value).join(', ')}`);
      }
      await setOption(offer.effort.configId, value);
      settings.push(`effort ${value}`);
    } else if (!modelValue || !/[[,](?:effort|reasoning_effort|reasoning)=/.test(modelValue)) {
      notes.push(`This harness has no effort setting over ACP, so effort "${wanted.effort}" was not applied.`);
    }
  }
  return { settings, notes };
}
