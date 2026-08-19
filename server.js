// server.js
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const evaluationConfig = require('./config/evaluationCriteria');

// Initialize express
const app = express();
const PORT = process.env.PORT || 5000;

// Render (and most hosts) terminate TLS at their own proxy, so without this req.ip
// is the proxy's address — the same value for every visitor. That breaks both the
// per-IP rate limit below (one global bucket instead of one per visitor) and
// express-session's "secure" cookie auto-detection.
//
// Trust exactly one hop, not `true` (all hops). `true` accepts a client-supplied
// X-Forwarded-For at face value, which lets a visitor with no real proxy in front
// simply set that header themselves and spoof req.ip — defeating the rate limiter
// it's meant to protect. Render sits exactly one hop in front, so `1` trusts only
// the address Render itself reports and ignores anything the client tries to add.
app.set('trust proxy', 1);

// Middleware setup
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use(bodyParser.json());

// A hardcoded, published secret defeats the point of signing session cookies. If
// SESSION_SECRET isn't set, generate one at boot rather than falling back to a
// public string — sessions just don't survive a restart, which is fine for a
// stateless practice tool.
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set — using a random value generated at boot. Sessions will not survive a restart. Set SESSION_SECRET in production to avoid this.');
}
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: 'auto' } // relies on trust proxy above to detect HTTPS correctly
}));
app.use(express.static(path.join(__dirname)));

// Serve main simulator page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'simulator.html'));
});

// --- AI provider configuration ---
// Both providers speak the OpenAI chat-completions shape, so only the base URL, the
// key and the model names differ.
const PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    // deepseek-chat, not deepseek-reasoner — this only needs a customer reply or a
    // JSON evaluation, not visible reasoning tokens spent getting there.
    defaultModels: ['deepseek-chat']
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    // Free OpenRouter slugs are retired without notice — the model this project
    // originally hardcoded (mistralai/mistral-7b-instruct) no longer exists on the
    // platform at all, in any variant, which is why this list is deliberately
    // re-verified rather than assumed. Check https://openrouter.ai/models before
    // trusting any slug here long-term.
    defaultModels: ['google/gemma-4-26b-a4b-it:free', 'poolside/laguna-s-2.1:free', 'openai/gpt-oss-20b:free']
  }
};

const REQUESTED_PROVIDER = process.env.AI_PROVIDER
  || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openrouter');

// If the requested provider has no key but the other one does, use that instead —
// a half-applied config (provider switched, key not yet added) should degrade to
// what still works rather than disabling AI entirely.
function resolveProvider(name) {
  if (PROVIDERS[name] && process.env[PROVIDERS[name].keyEnv]) return name;
  for (const [candidate, config] of Object.entries(PROVIDERS)) {
    if (process.env[config.keyEnv]) return candidate;
  }
  return PROVIDERS[name] ? name : 'openrouter';
}

const AI_PROVIDER = resolveProvider(REQUESTED_PROVIDER);

function modelsFor(providerName) {
  if (process.env.AI_MODELS) {
    const explicit = process.env.AI_MODELS.split(',').map(s => s.trim()).filter(Boolean);
    // Route each entry to the provider it belongs to. OpenRouter slugs always
    // contain a "/"; DeepSeek names never do. A stale list from one provider must
    // not get sent to an API that has never heard of those names.
    const routed = explicit.filter(m => (m.includes('/') ? 'openrouter' : 'deepseek') === providerName);
    if (routed.length) return routed;
  }
  return PROVIDERS[providerName].defaultModels;
}

// Primary provider's models first, then any other configured provider's — so a
// DeepSeek outage or empty balance falls through to OpenRouter's free models
// instead of breaking the simulator for every visitor.
const AI_CHAIN = [];
for (const name of [AI_PROVIDER, ...Object.keys(PROVIDERS).filter(n => n !== AI_PROVIDER)]) {
  if (!process.env[PROVIDERS[name].keyEnv]) continue;
  for (const model of modelsFor(name)) AI_CHAIN.push({ provider: name, model });
}

const AI_ENABLED = AI_CHAIN.length > 0;
const AI_TOTAL_BUDGET_MS = Number(process.env.AI_TOTAL_BUDGET_MS || 25000);
const AI_PER_CALL_TIMEOUT_MS = 15000;

// Per provider, set when it reports an account-wide quota is spent (OpenRouter's
// free tier is 50 requests/day for the whole account, not per model). Until it
// passes, that provider is skipped — the chain still tries any other provider.
const aiCooldownUntil = new Map();

function readDailyQuotaReset(body) {
  const error = body && body.error;
  if (!error) return 0;
  const isDaily = error.metadata && error.metadata.limit_source === 'openrouter_free_tier_daily';
  const mentionsDaily = typeof error.message === 'string' && error.message.includes('free-models-per-day');
  if (!isDaily && !mentionsDaily) return 0;
  const reset = Number(error.metadata && error.metadata.headers && error.metadata.headers['X-RateLimit-Reset']);
  if (!Number.isFinite(reset) || reset <= Date.now()) return Date.now() + 60 * 60 * 1000;
  return reset;
}

function callChatCompletion(messages, { model, maxTokens, temperature, jsonMode, provider }) {
  const name = provider;
  const cfg = PROVIDERS[name];
  const headers = {
    'Authorization': `Bearer ${process.env[cfg.keyEnv]}`,
    'Content-Type': 'application/json'
  };
  if (name === 'openrouter') {
    headers['HTTP-Referer'] = process.env.HTTP_REFERER || 'http://localhost:5000';
    headers['X-Title'] = 'K Store Email Simulator';
  }
  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    max_tokens: maxTokens
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  return fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: AI_PER_CALL_TIMEOUT_MS
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
}

// Tries each model in the chain in order until one returns usable content. Used by
// both /api/respond and /api/evaluate, so a transient failure or a spent daily
// quota on one provider falls through to the next rather than failing the request.
async function callAI(messages, { maxTokens = 400, temperature = 0.7, jsonMode = false } = {}) {
  const deadline = Date.now() + AI_TOTAL_BUDGET_MS;

  for (const { provider, model } of AI_CHAIN) {
    if (Date.now() >= deadline) break;
    if (Date.now() < (aiCooldownUntil.get(provider) || 0)) continue;

    try {
      const response = await callChatCompletion(messages, { model, maxTokens, temperature, jsonMode, provider });

      if (response.status === 429) {
        const reset = readDailyQuotaReset(response.data);
        if (reset) aiCooldownUntil.set(provider, reset);
        continue;
      }
      // A bad or unfunded key fails identically on every model in that provider.
      if (response.status === 401 || response.status === 402 || response.status === 403) {
        aiCooldownUntil.set(provider, Date.now() + 10 * 60 * 1000);
        continue;
      }
      if (response.status !== 200) continue;

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) continue;

      return { content, provider, model };
    } catch (error) {
      continue;
    }
  }

  return null;
}

// --- Per-visitor AI budget ---
// This page can be embedded publicly, and /api/evaluate calls a paid model on every
// use. Cap AI-backed turns per IP per hour; past the cap the request still gets a
// clear error rather than an unbounded bill. Meaningful now that trust proxy above
// makes req.ip the real visitor address instead of one shared proxy IP.
const AI_RATE_LIMIT_PER_HOUR = Number(process.env.AI_RATE_LIMIT_PER_HOUR || 40);
const aiUsage = new Map();

function consumeAiBudget(req) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entry = aiUsage.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    aiUsage.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= AI_RATE_LIMIT_PER_HOUR) return false;
  entry.count++;
  return true;
}

// --- Housekeeping: bounded reply cache ---
// A cache with no eviction grows forever on a long-running instance. Cap entry
// count and drop the oldest when full — simple LRU-ish behaviour via Map's
// insertion-order iteration.
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

// Periodic cleanup of expired rate-limit windows and session-scoped counters.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of aiUsage) {
    if (now - entry.windowStart >= 60 * 60 * 1000) aiUsage.delete(key);
  }
}, 15 * 60 * 1000).unref();

// Updated scoring prompt to include penalties and violation word lists from config
const CRITICAL_VIOLATION_WORDS = Object.entries(evaluationConfig.violations)
  .map(([category, words]) => `${category}: ${words.join(', ')}`)
  .join('\n');

const SCORING_PROMPT = `
You are a Customer Service Quality Analyzer. Evaluate this conversation using these EXACT criteria:

${JSON.stringify(evaluationConfig.criteria, null, 2)}

Penalties:
${JSON.stringify(evaluationConfig.penalties, null, 2)}

GOOD EXAMPLES:
${evaluationConfig.examples.good.map(ex => `${ex.type}: ${ex.text}`).join('\n')}

BAD EXAMPLES:
${evaluationConfig.examples.bad.map(ex => `${ex.type}: ${ex.text}`).join('\n')}

CRITICAL VIOLATIONS — if the agent's reply contains language matching any of these
categories, set criticalViolation to true, describe it in violationDetails, and set
every element's score to 0 regardless of anything else in the conversation:
${CRITICAL_VIOLATION_WORDS}

IMPORTANT: Return ONLY valid JSON in this format:
{
  "elements": {
    "greeting": {"present": true/false, "score": 0-25, "feedback": "why"},
    "empathy": {"present": true/false, "score": 0-25, "feedback": "why"},
    "solution": {"present": true/false, "score": 0-25, "feedback": "why, including if right solution was provided"},
    "closing": {"present": true/false, "score": 0-25, "feedback": "why"}
  },
  "penalties": {
    "lateReplies": {"count": number, "pointsDeducted": number, "feedback": "details"},
    "wrongEscalation": {"applied": true/false, "pointsDeducted": number, "feedback": "details"}
  },
  "totalScore": number (can be negative),
  "feedback": "overall analysis including penalties and right solution assessment",
  "criticalViolation": false,
  "violationDetails": ""
}`;

// Helper: Validate message
function validateMessage(message) {
  return message && typeof message === 'object' && typeof message.content === 'string' &&
         message.content.trim() !== '' && typeof message.role === 'string';
}

// Helper: Format messages for evaluation
function formatMessagesForEvaluation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Valid messages array required');
  }
  const validMessages = messages.filter(validateMessage);
  if (validMessages.length === 0) throw new Error('No valid messages');
  return validMessages.map(m => `[${m.role.toUpperCase()}]: ${m.content.trim()}`).join('\n\n');
}

// Helper: Process API evaluation response
async function processApiResponse(content) {
  const responseContent = content.trim();
  const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  const cleanJson = jsonMatch[0].replace(/,\s*([\]}])/g, '$1');
  const evaluation = JSON.parse(cleanJson);

  const validated = {
    elements: {},
    penalties: evaluation.penalties || { lateReplies: {count: 0, pointsDeducted: 0, feedback: ''}, wrongEscalation: {applied: false, pointsDeducted: 0, feedback: ''} },
    totalScore: 0,
    feedback: evaluation.feedback || '',
    criticalViolation: Boolean(evaluation.criticalViolation),
    violationDetails: evaluation.violationDetails || ''
  };

  for (const category of Object.keys(evaluationConfig.criteria)) {
    const element = evaluation.elements?.[category] || {};
    // A critical violation zeroes every element regardless of what the model scored
    // each one individually — the deterministic override backing the prompt's
    // instruction, since a model asked to self-enforce a rule sometimes forgets to.
    const rawScore = validated.criticalViolation ? 0 : Number(element.score) || 0;
    validated.elements[category] = {
      present: validated.criticalViolation ? false : Boolean(element.present),
      score: Math.min(25, Math.max(0, rawScore)),
      feedback: String(element.feedback || '')
    };
    validated.totalScore += validated.elements[category].score;
  }

  return validated;
}

// --- Deterministic fallback evaluator ---
// /api/respond degrades gracefully when both providers fail (see the canned lines
// below), so a conversation can always be completed without AI. Evaluation had no
// equivalent — a trainee who finished the conversation while both providers were
// down hit a dead end with no way to see a score. This scores the same 4x25 rubric
// with regex, reusing the exact solutionProvided/closingPattern checks /api/respond
// already applies live, so the two paths agree on what counts as a solution or a
// close. It is intentionally cruder than the AI's judgment — it exists to finish
// the exercise, not to replace real grading, and is always labeled as a fallback.
const SCRIPTED_GREETING = {
  greetingWord: /\b(hello|hi|good\s?(morning|afternoon|evening)|dear)\b/i,
  customerName: /\b(james|carter|mr\.?\s*carter)\b/i,
  offerToHelp: /\b(help|assist|here (for|to help)|resolve|sort (this|it) out)\b/i
};
const SCRIPTED_EMPATHY = {
  acknowledge: /\b(frustrat\w*|upset\w*|inconvenien\w*|understand how (you feel|frustrating))\b/i,
  understanding: /\b(i understand|i (can |)appreciate|i realize|i recognize)\b/i,
  supportive: /\b(i('m| am) here to help|right away|let's get this (sorted|resolved)|i('ll| will) help)\b/i
};
// Same pattern /api/respond uses live to decide whether a reply counts as the
// solution — keeping evaluation and conversation-flow judgment consistent.
const SCRIPTED_SOLUTION_ACTION = /(triggered|sent|resent|initiated|generated|issued|created|started).{0,50}password reset|password reset.{0,50}(email|link)|reset email|reset password link|manual unlock/i;
const SCRIPTED_SOLUTION_VERIFY = /\b(check your (inbox|email|spam)|spam( |-)?(folder|junk)|verify|confirm)\b/i;
const SCRIPTED_SOLUTION_OUTCOME = /\b(within|expire|expires|expiry|1 hour|5 minutes|\d+\s?(minutes|hours))\b/i;
// Same closing pattern /api/respond checks live.
const SCRIPTED_CLOSING_PATTERN = /(thank(?:s| you)|appreciate).*(contact|reach|time)|have (?:a )?(good|great|nice) (day|evening)|feel free to reach out|let me know if|anything else i can help/i;
const SCRIPTED_CLOSING_OFFER = /\b(anything else|further (assistance|help)|other (issues|questions))\b/i;
const SCRIPTED_CLOSING_THANKS = /\b(thank(?:s| you)|appreciate)\b/i;

function scriptedEvaluate(messages) {
  const agentMessages = messages.filter(m => m.role === 'agent').map(m => m.content);
  const allAgentText = agentMessages.join(' ');
  const firstAgentMsg = agentMessages[0] || '';
  const lastAgentMsg = agentMessages[agentMessages.length - 1] || '';

  // Critical violations checked across every agent message, same word lists the AI
  // prompt is given.
  let criticalViolation = false;
  let violationDetails = '';
  outer: for (const [category, words] of Object.entries(evaluationConfig.violations)) {
    for (const word of words) {
      if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(allAgentText)) {
        criticalViolation = true;
        violationDetails = `Agent used a "${category}" word or phrase ("${word}") — automatic zero applied.`;
        break outer;
      }
    }
  }

  const score = (checks, weights) => {
    let s = 0;
    let anyPresent = false;
    checks.forEach((matched, i) => { if (matched) { s += weights[i]; anyPresent = true; } });
    return { score: Math.min(25, s), present: anyPresent };
  };

  const elements = {};
  if (criticalViolation) {
    for (const category of Object.keys(evaluationConfig.criteria)) {
      elements[category] = { present: false, score: 0, feedback: 'Zero applied due to critical violation.' };
    }
  } else {
    const g = score(
      [SCRIPTED_GREETING.greetingWord.test(firstAgentMsg), SCRIPTED_GREETING.customerName.test(firstAgentMsg), SCRIPTED_GREETING.offerToHelp.test(firstAgentMsg)],
      [9, 8, 8]
    );
    elements.greeting = { present: g.present, score: g.score, feedback: g.present ? 'Detected via keyword match on the first reply (scripted fallback — not AI-judged).' : 'No greeting phrase, customer name, or offer to help detected in the first reply.' };

    const e = score(
      [SCRIPTED_EMPATHY.acknowledge.test(allAgentText), SCRIPTED_EMPATHY.understanding.test(allAgentText), SCRIPTED_EMPATHY.supportive.test(allAgentText)],
      [9, 8, 8]
    );
    elements.empathy = { present: e.present, score: e.score, feedback: e.present ? 'Detected via keyword match (scripted fallback — not AI-judged).' : 'No empathy or supportive language detected.' };

    const s = score(
      [SCRIPTED_SOLUTION_ACTION.test(allAgentText), SCRIPTED_SOLUTION_VERIFY.test(allAgentText), SCRIPTED_SOLUTION_OUTCOME.test(allAgentText)],
      [12, 7, 6]
    );
    elements.solution = { present: s.present, score: s.score, feedback: s.present ? 'Detected a password-reset action and/or verification/timing language (scripted fallback — not AI-judged).' : 'No password reset action, verification step, or timing detected.' };

    const c = score(
      [SCRIPTED_CLOSING_PATTERN.test(lastAgentMsg), SCRIPTED_CLOSING_OFFER.test(lastAgentMsg), SCRIPTED_CLOSING_THANKS.test(lastAgentMsg)],
      [10, 8, 7]
    );
    elements.closing = { present: c.present, score: c.score, feedback: c.present ? 'Detected a closing phrase in the final reply (scripted fallback — not AI-judged).' : 'No closing phrase, offer of further help, or thanks detected in the final reply.' };
  }

  const totalScore = Object.values(elements).reduce((sum, el) => sum + el.score, 0);

  return {
    elements,
    totalScore,
    feedback: criticalViolation
      ? `Scripted evaluation (AI unavailable): ${violationDetails}`
      : 'Scripted evaluation (AI unavailable) — scored by keyword matching against the same rubric. This is a fallback, not a substitute for AI judgment; results may be less accurate, particularly for empathy and tone.',
    criticalViolation,
    violationDetails
  };
}

// Endpoint: Evaluate conversation
app.post('/api/evaluate', async (req, res) => {
  try {
    const { messages, late_replies_count = 0, escalation_choice = 'No' } = req.body;
    if (!messages || !Array.isArray(messages)) throw new Error('Valid messages array required');

    if (!consumeAiBudget(req)) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        details: `Limit of ${AI_RATE_LIMIT_PER_HOUR} AI-backed requests per hour reached. Please try again later.`,
        evaluationFailed: true
      });
    }

    const formattedConversation = formatMessagesForEvaluation(messages);
    const evaluationMessages = [
      { role: 'system', content: SCORING_PROMPT },
      {
        role: 'user',
        content: `Evaluate this interaction:\n\n${formattedConversation}\n\nLate replies count: ${late_replies_count}\nEscalation choice: ${escalation_choice} (correct is 'No')\nProvide detailed evaluation of agent's performance across all messages.`
      }
    ];

    const result = AI_ENABLED
      ? await callAI(evaluationMessages, { maxTokens: 1000, temperature: 0.3, jsonMode: true })
      : null;

    let evaluation;
    let evaluationMode;
    if (result) {
      try {
        evaluation = await processApiResponse(result.content);
        evaluationMode = 'ai';
      } catch (parseError) {
        // The model returned something unparseable — same recovery as no result at
        // all, rather than surfacing a raw parse error to the trainee.
        evaluation = scriptedEvaluate(messages);
        evaluationMode = 'scripted';
      }
    } else {
      // Both providers exhausted. Previously this was a 503 dead end: a trainee
      // could finish the whole conversation and then be unable to see a score
      // until a key was topped up. Score deterministically instead, clearly
      // labeled, so the exercise can always be completed.
      evaluation = scriptedEvaluate(messages);
      evaluationMode = 'scripted';
    }
    evaluation.evaluationMode = evaluationMode;

    // Compute penalties deterministically from request data
    const latePenaltyPer = evaluationConfig.penalties?.lateReply?.deductionPerInstance || 0;
    const wrongEscalationPenalty = evaluationConfig.penalties?.wrongPopup?.deduction || 0;
    const latePenaltyTotal = Number(late_replies_count || 0) * latePenaltyPer;
    const wrongApplied = String(escalation_choice).toLowerCase() === 'yes';
    const wrongPenaltyTotal = wrongApplied ? wrongEscalationPenalty : 0;

    evaluation.penalties = {
      lateReplies: {
        count: Number(late_replies_count || 0),
        pointsDeducted: latePenaltyTotal,
        feedback: latePenaltyTotal > 0 ? `Deducted ${latePenaltyTotal} for ${late_replies_count} late replies` : ''
      },
      wrongEscalation: {
        applied: wrongApplied,
        pointsDeducted: wrongPenaltyTotal,
        feedback: wrongApplied ? 'Escalation selected when not required in this scenario' : ''
      }
    };

    const agentReplyCount = messages.filter(m => m.role === 'agent').length;
    const exceededMaxReplies = agentReplyCount > 10;

    if (exceededMaxReplies) {
      evaluation.adjustedTotalScore = evaluation.totalScore - 90;
      evaluation.feedback = (evaluation.feedback || '') + ' Penalty applied for excessive agent replies (limit 10).';
    } else {
      evaluation.adjustedTotalScore = evaluation.totalScore - latePenaltyTotal - wrongPenaltyTotal;
    }

    evaluation.context = {
      messageCount: messages.length,
      agentMessages: messages.filter(m => m.role === 'agent').length,
      customerMessages: messages.filter(m => m.role === 'customer').length,
      lateReplies: late_replies_count,
      escalationChoice: escalation_choice
    };

    return res.json(evaluation);
  } catch (error) {
    console.error('Evaluation error:', error);
    return res.status(500).json({
      error: 'Evaluation failed',
      details: error.message,
      evaluationFailed: true,
      elements: Object.fromEntries(Object.keys(evaluationConfig.criteria).map(cat => [cat, { present: false, score: 0, feedback: 'Evaluation failed' }])),
      penalties: { lateReplies: {count: 0, pointsDeducted: 0, feedback: ''}, wrongEscalation: {applied: false, pointsDeducted: 0, feedback: ''} },
      totalScore: 0,
      feedback: 'Evaluation system error. Try again.'
    });
  }
});

// Helper: Validate customer response tone
function validateCustomerResponse(text) {
  if (!text) return false;
  const agentPatterns = [
    /I('ve| have| will|'ll) (triggered|sent|reset|assist|help|check|verify|look)/i,
    /I understand|I apologize|we apologize|I'm sorry|we're sorry/i,
    /please try|you can try|you should|I recommend|I suggest/i,
    /feel free to|don't hesitate|please contact/i,
    /our team|our system|our support|we understand/i,
    /let me|allow me|I can|we can|we will|we'll/i,
    /have a (good|great|nice)|best regards|sincerely/i,
    /I'm here to|we're here to|how can I|how may I/i
  ];
  const customerPatterns = [
    /already tried|tried that|doesn't work|not working/i,
    /need.*(access|help|reset|unlock|NOW)/i,
    /where.*email|no email|never received|didn't receive/i,
    /check(ed)?.*(spam|junk)|nothing in|not there/i,
    /thank.*you|waiting|will wait/i,
    /frustrat(ed|ing)|angry|upset|ridiculous/i,
    /locked.*out|can't.*login|account.*(locked|blocked)/i,
    /this is (terrible|unacceptable|ridiculous|awful)/i,
    /fix this|do something|useless|incompetent/i
  ];
  if (agentPatterns.some(p => p.test(text))) return false;
  return customerPatterns.some(p => p.test(text));
}

// Endpoint: Respond as customer
app.post('/api/respond', async (req, res) => {
  const { agent_reply, history } = req.body;
  if (!agent_reply) return res.status(400).json({ error: 'Missing agent_reply' });

  if (!req.session.conversation) req.session.conversation = { uselessReplies: 0, agentReplyCount: 0, isEnded: false };
  if (req.session.conversation.isEnded) {
    return res.status(403).json({ error: 'Conversation ended', message: 'Issue escalated.' });
  }

  // Enforced server-side, not just in the client's send button — the client-side
  // MAX_AGENT_REPLIES check can be bypassed by calling this endpoint directly, which
  // previously left the "auto-termination at 10 replies" as a UI suggestion only.
  req.session.conversation.agentReplyCount++;
  if (req.session.conversation.agentReplyCount > 10) {
    req.session.conversation.isEnded = true;
    return res.status(403).json({ error: 'Conversation ended', message: 'Maximum reply limit reached. This case has been escalated to higher authorities.' });
  }

  const lower = agent_reply.toLowerCase();
  const agentAsksAnythingElse = /(anything else|further (assistance|help)|other issues|additional help)/i.test(lower);
  const hasQuestion = /\?/.test(agent_reply);
  const probingKeywords = /(confirm|could you|have you|did you|can you|please provide|please confirm|check)/i;
  const isProbing = hasQuestion || probingKeywords.test(lower);
  const solutionProvided = /(triggered|sent|resent|initiated|generated|issued|created|started).{0,50}password reset|password reset.{0,50}(email|link)|reset email|reset password link|manual unlock/i.test(lower);
  const closingPattern = /(thank(?:s| you)|appreciate).*(contact|reach|time)|have (?:a )?(good|great|nice) (day|evening)|feel free to reach out|let me know if|anything else i can help/i;

  const isUselessReply = !solutionProvided && !isProbing && !closingPattern.test(lower);

  if (solutionProvided) {
    req.session.conversation.uselessReplies = 0;
    const calmReply = agentAsksAnythingElse ? "No, that's all. Thank you." : "Thank you for your prompt assistance. I will wait for the password reset email.";
    return res.json({ reply: calmReply });
  }

  if (closingPattern.test(lower) && !isProbing && !solutionProvided) {
    req.session.conversation.uselessReplies = 0;
    return res.json({ reply: "You're welcome. Have a great day!" });
  }

  if (isUselessReply) {
    req.session.conversation.uselessReplies++;
    if (req.session.conversation.uselessReplies >= 2) {
      req.session.conversation.isEnded = true;
      return res.status(403).json({ error: 'Conversation ended', message: 'User did not feel you are helping, this case has been escalated to higher authorities.' });
    }
  } else {
    req.session.conversation.uselessReplies = 0;
  }

  const systemPrompt = `SYSTEM: You are James Carter, an angry customer locked out of your account.

CORE ROLE: You are ONLY James Carter, the frustrated customer. Never switch roles.

STRICT RULES:
• ALWAYS respond as James Carter, the angry customer
• NEVER use agent/support language or tone
• NEVER provide solutions or assistance
• NEVER apologize or show understanding
• NEVER use professional customer service phrases

REQUIRED RESPONSE PATTERNS:
IF agent asks questions:
- State "I already tried that"
- Mention checking spam folder
- Express growing frustration

IF agent provides reset link:
- Brief "thank you"
- State "waiting for email"
- No pleasantries

IF agent is unhelpful:
- Express anger
- Demand immediate action
- Show frustration

IF asked about anything else:
- Short "No"
- Minimal politeness

VOICE:
• Frustrated
• Demanding
• Impatient
• Direct
• Angry

FORBIDDEN PHRASES - NEVER USE:
• "I understand"
• "I can help"
• "Let me"
• "Please try"
• "Our team"
• "Feel free"
• "Best regards"

OUTPUT:
• ONLY write James Carter's angry customer replies
• NO explanations
• NO role-playing notes
• NO agent responses`;

  const userPrompt = `Agent reply: "${agent_reply}"
Conversation so far:
${history}`;

  const cacheKey = systemPrompt + userPrompt;
  if (cache.has(cacheKey)) return res.json({ reply: cache.get(cacheKey) });

  if (!consumeAiBudget(req)) {
    return res.status(429).json({ error: 'Rate limit exceeded', message: `Limit of ${AI_RATE_LIMIT_PER_HOUR} AI-backed requests per hour reached. Please try again later.` });
  }

  const result = AI_ENABLED
    ? await callAI([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { maxTokens: 300, temperature: 0.9 })
    : null;

  let reply = result?.content?.trim() || '';

  if (!validateCustomerResponse(reply)) {
    if (solutionProvided) reply = "Fine, I'll check my email again. This better work!";
    else if (isProbing) reply = "YES, I already tried all that! Stop wasting time!";
    else reply = "Unacceptable! Need access NOW!";
  }

  cacheSet(cacheKey, reply);
  res.json({ reply });
});

// Endpoint: Close case
app.post('/api/close', (req, res) => {
  const { escalation_choice } = req.body;
  if (!escalation_choice) return res.status(400).json({ error: 'Missing escalation_choice' });

  if (req.session.conversation) req.session.conversation.escalationChoice = escalation_choice;

  return res.json({ success: true, message: 'Case closed. Proceed to evaluation.' });
});

// Exposed because an exhausted quota, an unfunded key and a dead model all look
// identical from outside otherwise: the customer just stops sounding like an AI.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    aiEnabled: AI_ENABLED,
    aiProvider: AI_PROVIDER,
    aiModels: AI_CHAIN.map(e => `${e.provider}:${e.model}`),
    aiQuotaExhaustedUntil: Object.fromEntries(
      [...aiCooldownUntil].map(([provider, until]) => [provider, new Date(until).toISOString()])
    ),
    aiBudget: {
      limitPerHour: AI_RATE_LIMIT_PER_HOUR,
      usedByYou: (aiUsage.get(req.ip) || {}).count || 0,
      trackedClients: aiUsage.size
    },
    clientIp: req.ip,
    cacheEntries: cache.size
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`AI provider: ${AI_ENABLED ? AI_PROVIDER : 'disabled (no API key configured)'}`);
});
