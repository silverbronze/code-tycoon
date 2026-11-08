// API list prices in USD per million tokens, used for an API-equivalent cost
// estimate (a subscription plan is not billed per token). Cache writes cost
// 1.25x input (5 min) or 2x (1 hour); cache reads have a per-model rate.
const P = {
  'claude-fable-5-1': [10, 50, 0.25], 'claude-mythos-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10, 0.2], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};
const FAMILY = [[/fable|mythos/, P['claude-fable-5-1']], [/opus/, P['claude-opus-5-5']], [/sonnet/, P['claude-sonnet-5-5']], [/haiku/, P['claude-haiku-5-5']]];

export function rates(model) {
  const m = String(model || '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  return P[m] || FAMILY.find(([re]) => re.test(m))?.[1] || null;
}

// u: a transcript `message.usage` object
export function costOf(model, u) {
  const r = rates(model); if (!r || !u) return 0;
  const [inp, out, read = inp * 0.1] = r;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const w5m = (u.cache_creation_input_tokens || 0) - w1h;
  return ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out + (u.cache_read_input_tokens || 0) * read
    + Math.max(0, w5m) * inp * 1.25 + w1h * inp * 2) / 1e6;
}
