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
  /** The harness has an auto mode over ACP, and it is on. */
  auto: boolean;
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
  return { settings, notes, auto: !!auto };
}

/** Names that say a model is a small, cheap one, cheapest first. */
const CHEAP = [/\bnano\b/, /flash[-_ ]?lite|\blite\b/, /\bmini\b|haiku|\bflash\b/, /\bsmall\b|\bfast\b|\bspark\b/];
const LARGE = /opus|\bpro\b|ultra|\bmax\b/;

/** The cheapest model the harness offers, judged by its name; undefined when no name says so. */
export function cheapestModel(choices: Choice[]): string | undefined {
  let best: { value: string; rank: number } | undefined;
  for (const choice of choices) {
    const text = `${base(choice.value)} ${choice.name ?? ''}`.toLowerCase();
    if (LARGE.test(text)) continue;
    const rank = CHEAP.findIndex((re) => re.test(text));
    if (rank >= 0 && (!best || rank < best.rank)) best = { value: choice.value, rank };
  }
  return best?.value;
}

/** A mode that reads but doesn't edit or run anything: Cursor's `ask`, others' `plan` or `read-only`. */
export function readOnlyMode(choices: Choice[]): string | undefined {
  for (const wanted of ['ask', 'read-only', 'readonly', 'plan', 'chat']) {
    const hit = choices.find((c) => tail(c.value) === wanted || c.name?.toLowerCase() === wanted);
    if (hit) return hit.value;
  }
  return undefined;
}

/** `gemini-3.8-flash[reasoning_effort=high]` at another effort: Cursor takes its parameters on the model id. */
const withEffort = (value: string, effort: string) => value.replace(/([[,](?:effort|reasoning_effort|reasoning)=)[^,\]]*/, `$1${effort}`);

/**
 * The reviewer's settings (src/agent/reviewer.ts): a read-only mode, then the model asked for or the cheapest one,
 * at medium effort. A setting the harness refuses is left at its default rather than failing the review.
 */
export async function applyReviewerSettings(request: Request, sessionId: string, created: unknown, wantedModel?: string): Promise<string[]> {
  const offer = readOffer(created);
  const settings: string[] = [];
  const setOption = (configId: string, value: string) => request('session/set_config_option', { sessionId, configId, value });
  const attempt = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
      settings.push(what);
      return true;
    } catch {
      return false;
    }
  };
  const mode = offer.mode ? readOnlyMode(offer.mode.choices) : undefined;
  if (mode && offer.mode) {
    const configId = offer.mode.configId;
    await attempt(`mode ${tail(mode)}`, () => (configId ? setOption(configId, mode) : request('session/set_mode', { sessionId, modeId: mode })));
  }
  const choices = offer.model?.choices ?? [];
  const model = wantedModel ? pickModel(choices, wantedModel, 'medium').value : cheapestModel(choices);
  if (model && offer.model) {
    const configId = offer.model.configId;
    const set = (value: string) => (configId ? setOption(configId, value) : request('session/set_model', { sessionId, modelId: value }));
    const medium = offer.effort ? model : withEffort(model, 'medium');
    if (!(medium !== model && (await attempt(`model ${medium}`, () => set(medium))))) await attempt(`model ${model}`, () => set(model));
  }
  if (offer.effort) {
    const effort = offer.effort;
    const value = pickEffort(effort.choices, 'medium');
    if (value) await attempt(`effort ${value}`, () => setOption(effort.configId, value));
  }
  return settings;
}
