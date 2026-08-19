document.addEventListener('DOMContentLoaded', () => {
  const replyTextarea = document.getElementById('agent-reply');
  const sendButton = document.getElementById('send-button');
  const closeButton = document.getElementById('close-case');
  const escalationPopup = document.getElementById('escalation-popup');
  const escalationNo = document.getElementById('escalation-no');
  const escalationYes = document.getElementById('escalation-yes');
  const feedbackSlide = document.getElementById('feedback-slide');
  const timerDisplay = document.getElementById('timer');
  const messagesDiv = document.getElementById('messages');
  const evaluationPanel = document.getElementById('evaluation-panel');
  const seeDetailsBtn = document.getElementById('see-details');
  const detailSlide = document.getElementById('detail-slide');
  const detailClose = document.getElementById('detail-close');

  let timeLeft = 210; // 3 minutes 30 seconds
  let timerInterval;
  let lateRepliesCount = 0;
  let conversationHistory = [];
  const MAX_AGENT_REPLIES = 10;

  // Start timer once at simulation start; it resets only after sending a reply
  sendButton.addEventListener('click', handleSendReply);
  closeButton.addEventListener('click', showEscalationPopup);

  function startTimer() {
    clearInterval(timerInterval);
    timeLeft = 210;
    timerInterval = setInterval(() => {
      timeLeft--;
      updateTimerDisplay();
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        lateRepliesCount++;
        alert(`Reply timed out! Late replies: ${lateRepliesCount}`);
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    timerDisplay.textContent = `Timer: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    if (timeLeft <= 0) timerDisplay.textContent = 'Timer: 00:00';
  }

  // Set Received timestamp from user's computer
  (function setReceivedTimestamp(){
    const el = document.getElementById('meta-received');
    if (el) {
      const now = new Date();
      const formatted = `${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      el.textContent = formatted;
    }
  })();

  function handleSendReply() {
    clearInterval(timerInterval);
    const agentReply = replyTextarea.value.trim();
    if (!agentReply) return alert('Please enter a reply.');

    // Track and enforce max replies before sending to server
    const agentMessagesSoFar = conversationHistory.filter(m => m.role === 'agent').length;
    if (agentMessagesSoFar >= MAX_AGENT_REPLIES) {
      showTerminationPopup('User did not feel you are helping, this case has been escalated to higher autorities.');
      return; // evaluation will be triggered by popup OK
    }

    const message = { role: 'agent', content: agentReply };
    conversationHistory.push(message);
    appendMessage(message);

    fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_reply: agentReply, history: conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n') })
    })
    .then(async response => {
      if (response.status === 403) {
        // Auto-termination path
        const data = await response.json().catch(() => ({ message: 'Conversation ended.' }));
        showTerminationPopup(data.message || 'Conversation ended. Proceed to evaluation.');
        return Promise.reject('TERMINATED');
      }
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Server error');
      }
      return response.json();
    })
    .then(data => {
      if (data.reply) {
        const customerMessage = { role: 'customer', content: data.reply };
        conversationHistory.push(customerMessage);
        appendMessage(customerMessage);
        replyTextarea.value = '';
        closeButton.style.display = 'block'; // Show close button after reply
        // Reset and start timer for the next agent reply window
        startTimer();
      }
    })
    .catch(error => {
      if (error === 'TERMINATED') return; // handled via popup
      alert('Error sending reply: ' + error.message);
    });
  }

  // Kick off the countdown when the simulator loads
  startTimer();

  function appendMessage(message) {
    const item = document.createElement('div');
    item.className = `email-item ${message.role}`;

    const header = document.createElement('div');
    header.className = 'email-header';

    const from = document.createElement('div');
    from.className = 'email-from';
    const displayRole = message.role === 'agent' ? 'Agent' : 'James Carter';
    const address = message.role === 'agent' ? 'support@kstore.com' : 'jamesc@email.com';
    from.innerHTML = `<strong>${displayRole}</strong> <span class="email-address">&lt;${address}&gt;</span>`;

    const meta = document.createElement('div');
    meta.className = 'email-meta';
    const now = new Date();
    meta.textContent = `${now.toLocaleDateString()} • ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    header.appendChild(from);
    header.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'email-body';
    body.textContent = message.content;

    item.appendChild(header);
    item.appendChild(body);

    messagesDiv.appendChild(item);
    messagesDiv.scrollTop = messagesDiv.scrollHeight; // Auto-scroll
  }

  function showEscalationPopup() {
    escalationPopup.style.display = 'block';
  }

  document.getElementById('submit-escalation').addEventListener('click', () => {
    const escalationChoice = escalationNo.checked ? 'No' : 'Yes';
    // If Yes, show escalation detail form first
    if (escalationChoice === 'Yes') {
      escalationPopup.style.display = 'none';
      const escDetails = document.getElementById('escalation-details');
      if (escDetails) escDetails.style.display = 'block';
      return;
    }

    // No escalation → proceed to close and evaluate
    escalationPopup.style.display = 'none';
    fetch('/api/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escalation_choice: escalationChoice })
    })
    .then(() => evaluateConversation())
    .catch(error => alert('Error closing case: ' + error.message));
  });

  // Submit escalation details (only for Yes path)
  const escSubmit = document.getElementById('esc-submit');
  if (escSubmit) {
    escSubmit.addEventListener('click', () => {
      const escDetails = document.getElementById('escalation-details');
      const email = document.getElementById('esc-email')?.value;
      const phone = document.getElementById('esc-phone')?.value;
      const route = document.getElementById('esc-route')?.value;
      if (escDetails) escDetails.style.display = 'none';
      // We keep backend unchanged; send the Yes choice and proceed
      fetch('/api/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalation_choice: 'Yes', email, phone, route })
      })
        .then(() => evaluateConversation())
        .catch(error => alert('Error closing case: ' + error.message));
    });
  }

  // Back button and ESC support from Escalation Details
  const escBack = document.getElementById('esc-back');
  function goBackToEscalationConfirm() {
    const escDetails = document.getElementById('escalation-details');
    if (escDetails) escDetails.style.display = 'none';
    if (escalationPopup) {
      // Reset radio to Yes so context is preserved
      if (escalationYes) escalationYes.checked = true;
      escalationPopup.style.display = 'block';
    }
  }
  if (escBack) escBack.addEventListener('click', goBackToEscalationConfirm);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const escDetailsVisible = document.getElementById('escalation-details')?.style.display === 'block';
      if (escDetailsVisible) {
        e.preventDefault();
        goBackToEscalationConfirm();
      }
    }
  });

  function evaluateConversation() {
    const loading = document.getElementById('loading-popup');
    if (loading) loading.style.display = 'block';
    fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversationHistory, late_replies_count: lateRepliesCount, escalation_choice: escalationNo.checked ? 'No' : 'Yes' })
    })
    .then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.evaluationFailed) {
        // A system failure must never be shown as a scored 0/100 — the trainee has
        // no way to tell "you failed" from "the grader broke" otherwise.
        showEvaluationError(data.details || data.error || 'The evaluation service is unavailable.');
        return;
      }
      updateEvaluationPanel(data);
      const panel = document.getElementById('evaluation-panel');
      if (panel) panel.classList.remove('hidden');
      window.__latestEvaluation = data;
    })
    .catch(error => showEvaluationError(error.message))
    .finally(() => {
      if (loading) loading.style.display = 'none';
    });
  }

  function showEvaluationError(details) {
    const panel = document.getElementById('evaluation-panel');
    if (panel) panel.classList.remove('hidden');
    const totalEl = document.getElementById('total-score');
    if (totalEl) totalEl.textContent = '—';
    const feedbackEl = document.getElementById('overall-feedback');
    if (feedbackEl) {
      feedbackEl.innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = 'Evaluation unavailable — this is not your score. ';
      const span = document.createElement('span');
      span.textContent = details || 'Please try again.';
      const retry = document.createElement('button');
      retry.textContent = 'Retry evaluation';
      retry.className = 'primary';
      retry.style.marginTop = '10px';
      retry.style.display = 'block';
      retry.addEventListener('click', evaluateConversation);
      feedbackEl.appendChild(strong);
      feedbackEl.appendChild(span);
      feedbackEl.appendChild(retry);
    }
    ['greeting', 'empathy', 'solution', 'closing'].forEach(k => {
      const s = document.getElementById(`score-${k}`);
      const d = document.getElementById(`desc-${k}`);
      if (s) s.textContent = '—';
      if (d) d.textContent = '';
    });
    const box = document.getElementById('deduction-box');
    if (box) box.classList.add('hidden');
  }

  function showTerminationPopup(message) {
    const popup = document.getElementById('termination-popup');
    const okBtn = document.getElementById('termination-ok');
    const msg = document.getElementById('termination-message');
    if (!popup || !okBtn) return;
    if (msg) msg.textContent = message || 'Conversation ended. Proceed to evaluation.';
    popup.style.display = 'block';
    okBtn.onclick = () => {
      popup.style.display = 'none';
      // Trigger evaluation immediately with current state
      evaluateConversation();
    };
  }

  function updateEvaluationPanel(data) {
    const get = id => document.getElementById(id);
    const elements = data.elements || {};
    const score = (k) => (elements[k]?.score ?? 0);
    const fb = (k) => (elements[k]?.feedback || '');

    get('score-greeting').textContent = `${score('greeting')}/25`;
    get('score-empathy').textContent = `${score('empathy')}/25`;
    get('score-solution').textContent = `${score('solution')}/25`;
    get('score-closing').textContent = `${score('closing')}/25`;

    get('desc-greeting').textContent = fb('greeting');
    get('desc-empathy').textContent = fb('empathy');
    get('desc-solution').textContent = fb('solution');
    get('desc-closing').textContent = fb('closing');

    const totalVal = (typeof data.adjustedTotalScore === 'number') ? data.adjustedTotalScore : data.totalScore;
    get('total-score').textContent = `${totalVal}/100`;
    get('overall-feedback').textContent = data.feedback || '';

    // The server can zero every score for a critical violation (profanity, hostile
    // or dismissive language); without this the trainee saw a 0/100 with no
    // indication of why, indistinguishable from an ordinary weak reply.
    const violationBox = get('violation-box');
    if (violationBox) {
      if (data.criticalViolation) {
        violationBox.textContent = `Critical violation: ${data.violationDetails || 'unprofessional language detected'}. All scores set to 0.`;
        violationBox.classList.remove('hidden');
      } else {
        violationBox.classList.add('hidden');
        violationBox.textContent = '';
      }
    }

    // Deductions panel (only if applicable)
    const deductions = [];
    const p = data.penalties || {};
    if (p.lateReplies && Number(p.lateReplies.pointsDeducted) > 0) {
      deductions.push({
        label: `Late replies (${p.lateReplies.count})`,
        points: Number(p.lateReplies.pointsDeducted),
        reason: p.lateReplies.feedback || 'Reply timer exceeded'
      });
    }
    if (p.wrongEscalation && p.wrongEscalation.applied && Number(p.wrongEscalation.pointsDeducted) > 0) {
      deductions.push({
        label: 'Wrong escalation choice',
        points: Number(p.wrongEscalation.pointsDeducted),
        reason: p.wrongEscalation.feedback || "Selected 'Yes' when 'No' was correct"
      });
    }

    // If server applied max-replies rule via adjustedTotalScore = total - 90, show it
    if (typeof data.adjustedTotalScore === 'number' && typeof data.totalScore === 'number' && (data.totalScore - data.adjustedTotalScore) >= 90) {
      deductions.push({ label: 'Exceeded maximum replies (10)', points: 90, reason: 'Too many agent replies; keep the conversation concise and solution-oriented.' });
    }

    const box = get('deduction-box');
    const total = get('deduction-total');
    const list = get('deduction-list');
    if (box && total && list) {
      if (deductions.length === 0) {
        box.classList.add('hidden');
        list.innerHTML = '';
      } else {
        const sum = deductions.reduce((s, d) => s + (d.points || 0), 0);
        total.textContent = `-${sum}`;
        list.innerHTML = deductions.map(d => `<li>${d.label}: -${d.points} (${d.reason})</li>`).join('');
        box.classList.remove('hidden');
      }
    }
  }

  // See detailed feedback handlers
  if (seeDetailsBtn) {
    seeDetailsBtn.addEventListener('click', () => {
      const data = window.__latestEvaluation;
      if (!data) return;

      // Hide composer area to "close chat bar"
      const replySection = document.querySelector('.reply-section');
      if (replySection) replySection.style.display = 'none';

      // Perfect criteria definitions shown as guidance
      const perfectCriteria = {
        greeting: [
          'Professional greeting',
          'Use customer name',
          'State clear offer to help'
        ],
        empathy: [
          'Acknowledge the frustration',
          'Show understanding of the exact issue',
          'Use supportive and respectful tone'
        ],
        solution: [
          'State concrete action taken (e.g., triggered reset)',
          'Explain any verification or next steps',
          'Set expectations (timing, expiry, what if it fails)'
        ],
        closing: [
          'Professional closing phrase',
          'Offer further assistance',
          'Show appreciation'
        ]
      };

      // Populate detail slide
      const elements = data.elements || {};
      const fill = (key, titleIdPrefix, exampleText) => {
        const score = elements[key]?.score ?? 0;
        const feedback = elements[key]?.feedback || '';
        const perfectList = (perfectCriteria[key] || []).map(i => `• ${i}`).join('\n');
        const perfectReason = score === 25
          ? `Perfect ${key} — keep it up!`
          : `To achieve 25/25, include:\n${perfectList}`;
        document.getElementById(`detail-${titleIdPrefix}-score`).textContent = `${score}/25`;
        document.getElementById(`detail-${titleIdPrefix}-why`).textContent = score === 25 ? `Perfect ${key} since: ${feedback}` : `Why not full score: ${feedback}`;
        document.getElementById(`detail-${titleIdPrefix}-perfect`).textContent = perfectReason;
        document.getElementById(`detail-${titleIdPrefix}-example`).textContent = exampleText || '';
      };

      fill('greeting', 'greeting', 'Hello James, thank you for reaching out. I can help you regain access right away.');
      fill('empathy', 'empathy', "I understand how frustrating it is to be locked out of your account. I'll sort this out for you now.");
      fill('solution', 'solution', "I've triggered a password reset email for your account. Please check your inbox (and spam) for the link—it expires in 1 hour. If it doesn't arrive, reply here and I will manually unlock your account.");
      fill('closing', 'closing', 'Please let me know if you need any further assistance. Thank you for your patience.');

      // Deductions (detailed)
      const detailSection = document.getElementById('detail-deductions-section');
      const summaryEl = document.getElementById('detail-deductions-summary');
      const listEl = document.getElementById('detail-deductions-list');
      const preventEl = document.getElementById('detail-deductions-prevent');
      if (detailSection && summaryEl && listEl && preventEl) {
        const deductions = [];
        const p = data.penalties || {};
        if (p.lateReplies && Number(p.lateReplies.pointsDeducted) > 0) {
          deductions.push({
            label: `Late replies (${p.lateReplies.count})`,
            points: Number(p.lateReplies.pointsDeducted),
            reason: p.lateReplies.feedback || 'Reply timer exceeded',
            prevent: 'Manage time: send concise, prompt replies; acknowledge quickly; use templates to accelerate.'
          });
        }
        if (p.wrongEscalation && p.wrongEscalation.applied && Number(p.wrongEscalation.pointsDeducted) > 0) {
          deductions.push({
            label: 'Wrong escalation choice',
            points: Number(p.wrongEscalation.pointsDeducted),
            reason: p.wrongEscalation.feedback || "Selected 'Yes' when 'No' was correct",
            prevent: 'This scenario can be resolve by sending the user reset password link again from system. Check knowledge base — Scenario 1: Unable to Login - Forgotten Password.'
          });
        }
        if (typeof data.adjustedTotalScore === 'number' && typeof data.totalScore === 'number' && (data.totalScore - data.adjustedTotalScore) >= 90) {
          deductions.push({
            label: 'Exceeded maximum replies (10)',
            points: 90,
            reason: 'Too many agent replies; conversation became inefficient.',
            prevent: 'Provide the solution early (trigger reset), avoid repetitive probing, aim to resolve within a few turns.'
          });
        }

        if (deductions.length > 0) {
          const total = deductions.reduce((s, d) => s + (d.points || 0), 0);
          summaryEl.textContent = `Total deduction: -${total}`;
          listEl.innerHTML = deductions.map(d => `<li>${d.label}: -${d.points} — ${d.reason}</li>`).join('');
          preventEl.textContent = `How to prevent: ${deductions.map(d => d.prevent).join(' ')} `;
          detailSection.style.display = '';
        } else {
          detailSection.style.display = 'none';
          listEl.innerHTML = '';
          summaryEl.textContent = '';
          preventEl.textContent = '';
        }
      }

      // Show slide
      detailSlide.classList.remove('hidden');
    });
  }

  if (detailClose) {
    detailClose.addEventListener('click', () => {
      detailSlide.classList.add('hidden');
      const replySection = document.querySelector('.reply-section');
      if (replySection) replySection.style.display = '';
    });
  }
});