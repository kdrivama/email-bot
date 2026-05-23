// server.js (Refactored: Added new endpoints/logic for timing/escalation, updated evaluation to include penalties, cleaned up code structure, ensured compatibility)
const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const evaluationConfig = require('./config/evaluationCriteria');

// Initialize express
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware setup
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use(bodyParser.json());
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname)));

// Serve main simulator page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'simulator.html'));
});

const cache = new Map();

// Updated scoring prompt to include penalties from config
const SCORING_PROMPT = `
You are a Customer Service Quality Analyzer. Evaluate this conversation using these EXACT criteria:

${JSON.stringify(evaluationConfig.criteria, null, 2)}

Penalties:
${JSON.stringify(evaluationConfig.penalties, null, 2)}

GOOD EXAMPLES:
${evaluationConfig.examples.good.map(ex => `${ex.type}: ${ex.text}`).join('\n')}

BAD EXAMPLES:
${evaluationConfig.examples.bad.map(ex => `${ex.type}: ${ex.text}`).join('\n')}

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

// Helper: Wait function
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper: API request with retries
async function makeApiRequest(url, requestBody, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) throw new Error(`API failed: ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      lastError = error;
      if (i < maxRetries - 1) await wait(1000 * Math.pow(2, i));
    }
  }
  throw lastError;
}

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
async function processApiResponse(result) {
  if (!result?.choices?.[0]?.message?.content) throw new Error('Invalid API response');
  const responseContent = result.choices[0].message.content.trim();
  const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  const cleanJson = jsonMatch[0].replace(/,\s*([\]}])/g, '$1');
  const evaluation = JSON.parse(cleanJson);

  // Validate and format
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
    validated.elements[category] = {
      present: Boolean(element.present),
      score: Math.min(25, Math.max(0, Number(element.score) || 0)),
      feedback: String(element.feedback || '')
    };
    validated.totalScore += validated.elements[category].score;
  }

  return validated;
}

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

// Endpoint: Evaluate conversation (Updated to accept late_replies_count and escalation_choice)
app.post('/api/evaluate', async (req, res) => {
  try {
    const { messages, late_replies_count = 0, escalation_choice = 'No' } = req.body;
    if (!messages || !Array.isArray(messages)) throw new Error('Valid messages array required');

    const formattedConversation = formatMessagesForEvaluation(messages);
    const evaluationMessages = [
      { role: 'system', content: SCORING_PROMPT },
      {
        role: 'user',
        content: `Evaluate this interaction:\n\n${formattedConversation}\n\nLate replies count: ${late_replies_count}\nEscalation choice: ${escalation_choice} (correct is 'No')\nProvide detailed evaluation of agent's performance across all messages.`
      }
    ];

    const result = await makeApiRequest('https://openrouter.ai/api/v1/chat/completions', {
      model: 'openai/gpt-3.5-turbo',
      messages: evaluationMessages,
      temperature: 0.3,
      max_tokens: 1000
    });

    const evaluation = await processApiResponse(result);

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

    // Determine if max replies exceeded and enforce formula (total score - 90)
    const agentReplyCount = messages.filter(m => m.role === 'agent').length;
    const exceededMaxReplies = agentReplyCount > 10;

    // Provide adjusted total explicitly
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
      elements: Object.fromEntries(Object.keys(evaluationConfig.criteria).map(cat => [cat, { present: false, score: 0, feedback: 'Evaluation failed' }])),
      penalties: { lateReplies: {count: 0, pointsDeducted: 0, feedback: ''}, wrongEscalation: {applied: false, pointsDeducted: 0, feedback: ''} },
      totalScore: 0,
      feedback: 'Evaluation system error. Try again.'
    });
  }
});

// Endpoint: Respond as customer (Unchanged, but refactored for clarity)
app.post('/api/respond', async (req, res) => {
  const { agent_reply, history } = req.body;  // Simplified; assume scenario/kb not used
  if (!agent_reply) return res.status(400).json({ error: 'Missing agent_reply' });

  if (!req.session.conversation) req.session.conversation = { uselessReplies: 0, isEnded: false };
  if (req.session.conversation.isEnded) {
    return res.status(403).json({ error: 'Conversation ended', message: 'Issue escalated.' });
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

  const body = {
    model: process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 300,
    temperature: 0.9
  };

  try {
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!orRes.ok) throw new Error(`OpenRouter error: ${await orRes.text()}`);

    const json = await orRes.json();
    let reply = json.choices?.[0]?.message?.content || '(No reply)';

    if (!validateCustomerResponse(reply)) {
      if (solutionProvided) reply = "Fine, I'll check my email again. This better work!";
      else if (isProbing) reply = "YES, I already tried all that! Stop wasting time!";
      else reply = "Unacceptable! Need access NOW!";
    }

    cache.set(cacheKey, reply);
    res.json({ reply });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// New Endpoint: Close case (Handles escalation choice, but allows proceed; penalties applied in evaluate)
app.post('/api/close', (req, res) => {
  const { escalation_choice } = req.body;
  if (!escalation_choice) return res.status(400).json({ error: 'Missing escalation_choice' });

  // In this scenario, always allow proceed, but note choice for evaluation
  if (req.session.conversation) req.session.conversation.escalationChoice = escalation_choice;

  return res.json({ success: true, message: 'Case closed. Proceed to evaluation.' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});