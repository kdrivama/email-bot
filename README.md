# K Store — Email Handling Simulator

An AI role-play trainer for handling an angry customer over email/chat: James Carter,
locked out of his account, waiting on a password reset. The trainee writes real
replies; James responds in character and the exchange is scored on greeting, empathy,
solution and closing, with deductions for late replies and an incorrect escalation
call.

**K Store is a fictional brand.** The customer, order and account details are invented
for training purposes.

---

## Running it

```bash
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY or OPENROUTER_API_KEY
npm start
```

Open `http://localhost:5000`.

## AI provider

Set in `.env` — see `.env.example` for the full list of variables. In short:

- `AI_PROVIDER` picks DeepSeek or OpenRouter; if unset, it follows whichever key is
  present (DeepSeek preferred).
- Keep both keys configured if you can. A DeepSeek outage or empty balance falls
  through to OpenRouter automatically, so the simulator degrades rather than breaks.
- `GET /healthz` reports the active provider, the model chain, and any exhausted
  quota — check it first if the customer starts sounding repetitive or scripted.

## Deployment

Hosted on Render as a web service — see `render.yaml`. Set `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY` and `SESSION_SECRET` in the Render dashboard, not in the repo.

## Structure

```
server.js                   Express app: AI provider chain, scoring, session state
config/evaluationCriteria.js  scoring rubric, examples, penalty amounts, violation words
simulator.html / .js / .css   the trainee-facing interface
render.yaml                  Render web service definition
```

## Design notes

- The scoring rubric and the AI's judgment are separated deliberately: the model
  scores each element and flags critical violations, but late-reply and
  wrong-escalation penalties are computed deterministically from what the client
  actually reports, not left to the model's arithmetic.
- A critical violation (profanity, hostility, dismissiveness) zeroes every element
  regardless of how the model scored them individually — enforced server-side as a
  deterministic override, since a model asked to self-enforce a rule sometimes
  forgets to apply it consistently.
- If the evaluation service itself fails, the trainee sees a distinct "evaluation
  unavailable, retry" state rather than a scored 0/100 — those two situations must
  never look the same.
