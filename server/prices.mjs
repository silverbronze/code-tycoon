// API list prices in USD per million tokens, used for an API-equivalent cost
// estimate (a subscription plan is not billed per token).
// Anthropic: [input, output, cache read]; cache writes cost 1.25x input (5 min) or 2x (1 hour).
const P = {
  'claude-fable-5-1': [10, 50, 0.25], 'claude-mythos-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10, 0.2], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};
const FAMILY = [[/fable|mythos/, P['claude-fable-5-1']], [/opus/, P['claude-opus-5-5']], [/sonnet/, P['claude-sonnet-5-5']], [/haiku/, P['claude-haiku-5-5']]];

// OpenAI (Codex), standard tier, from developers.openai.com/api/docs/pricing (2026-11-08):
// [input, output, cached input, long]. Cache writes are taken at the 30-minute rate (1.25x input).
// long: one request over 272k input tokens costs 2x input (and cached input) and 1.5x output.
const O = {
  'gpt-6-astra': [10, 50, 1, 1], 'gpt-6.1-sol': [2, 10, 0.1, 1], 'gpt-6.1-terra': [1, 5, 0.05, 1], 'gpt-6-luna': [0.1, 0.5, 0.01, 1],
  'gpt-6-sol': [2, 10, 0.2, 1], 'gpt-5.6-sol': [4, 20, 0.4, 1], 'gpt-5.6-terra': [2, 12, 0.2, 1], 'gpt-5.6-luna': [0.2, 1.2, 0.02, 1],
  'gpt-5.5': [5, 30, 0.5, 1], 'gpt-5.5-pro': [30, 180, 30, 1], 'gpt-5.4': [2.5, 15, 0.25, 1], 'gpt-5.4-pro': [30, 180, 30, 1],
  'gpt-5.4-mini': [0.75, 4.5, 0.075], 'gpt-5.4-nano': [0.2, 1.25, 0.02], 'gpt-5.2': [1.75, 14, 0.175], 'gpt-5.2-pro': [21, 168, 21],
  'gpt-5.1': [1.25, 10, 0.125], 'gpt-5': [1.25, 10, 0.125], 'gpt-5-mini': [0.25, 2, 0.025], 'gpt-5-nano': [0.05, 0.4, 0.005], 'gpt-5-pro': [15, 120, 15],
};
const O_FAMILY = [[/astra/, O['gpt-6-astra']], [/terra/, O['gpt-6.1-terra']], [/luna/, O['gpt-6-luna']], [/sol/, O['gpt-6.1-sol']],
  [/-nano\b/, O['gpt-5-nano']], [/-mini\b/, O['gpt-5-mini']]];
const LONG = 272e3;

export function rates(model) {
  const m = String(model || '').toLowerCase().replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/\[.*\]$/, '');
  if (/^(gpt-|o\d)/.test(m)) {
    // Codex variants cost what their base model costs: gpt-5.1-codex -> gpt-5.1, gpt-5.1-codex-mini -> mini
    const base = m.replace(/-codex(-max)?$/, '').replace(/-codex-/, '-');
    return O[m] || O[base] || O_FAMILY.find(([re]) => re.test(m))?.[1] || null;
  }
  return P[m] || FAMILY.find(([re]) => re.test(m))?.[1] || null;
}

// u: a transcript `message.usage` object (Codex usage is mapped to the same fields).
// perRequest: u is one API request, so the long-context rate can apply; a sum over many is not.
export function costOf(model, u, { perRequest = true } = {}) {
  const r = rates(model); if (!r || !u) return 0;
  let [inp, out, read = inp * 0.1] = r;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const w5m = (u.cache_creation_input_tokens || 0) - w1h;
  if (r[3] && perRequest && (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) > LONG) {
    inp *= 2; read *= 2; out *= 1.5;
  }
  return ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out + (u.cache_read_input_tokens || 0) * read
    + Math.max(0, w5m) * inp * 1.25 + w1h * inp * 2) / 1e6;
}
