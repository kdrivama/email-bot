module.exports = {
  criteria: {
    greeting: {
      title: "Greeting and Introduction",
      maxScore: 25,
      requirements: [
        "Professional greeting (Hello/Hi/Good morning/afternoon/evening)",
        "Using customer name",
        "Clear offer of assistance"
      ],
      examples: {
        good: "Hello Mr. Carter, I understand you're having trouble accessing your account. I'm here to help resolve this for you.",
        bad: "Hey there, what's wrong?"
      }
    },
    empathy: {
      title: "Empathy and Understanding",
      maxScore: 25,
      requirements: [
        "Acknowledging customer frustration",
        "Showing understanding of the issue",
        "Professional supportive language"
      ],
      examples: {
        good: "I understand how frustrating it must be to be locked out of your account. Let me help you regain access right away.",
        bad: "You need to calm down and wait."
      }
    },
    solution: {
      title: "Solution Provided",
      maxScore: 25,
      requirements: [
        "Clear action steps",
        "Verification process explained",
        "Expected outcome communicated"
      ],
      examples: {
        good: "I've triggered a new password reset email for your account. Please check your inbox, including spam folder, within the next 5 minutes. The link will expire in 1 hour.",
        bad: "I sent something. Check your email."
      }
    },
    closing: {
      title: "Professional Closing",
      maxScore: 25,
      requirements: [
        "Professional closing phrase",
        "Offer for additional assistance",
        "Appreciation expressed"
      ],
      examples: {
        good: "Please let me know if you need any further assistance. Thank you for your patience.",
        bad: "That's all. Bye."
      }
    }
  },
  
  violations: {
    critical: [
      "Profanity or offensive language",
      "Hostile or dismissive responses",
      "Unprofessional conduct",
      "Abrupt endings"
    ],
    words: {
      profanity: ["hell", "damn", "crap"],
      unprofessional: ["k", "yeah yeah", "whatever"],
      dismissive: ["not my problem", "figure it out"],
      hostile: ["go away", "leave me alone"]
    }
  },
  
  penalties: {
    lateReply: {
      description: "Penalty for each late reply (timer reaches 00:00, more than 3 minutes 30 seconds)",
      deductionPerInstance: 20
    },
    wrongPopup: {
      description: "Penalty for selecting 'Yes' in escalation popup when 'No' is correct in this scenario",
      deduction: 50
    }
  },
  
  evaluationPrompt: `
You are a strict Customer Service Quality Analyzer. Evaluate this conversation using these exact criteria:

1. Greeting (25 points): Professional greeting, name use, clear help offer
2. Empathy (25 points): Understanding shown, acknowledgment, support
3. Solution (25 points): Clear steps, verification, outcome explained
4. Closing (25 points): Professional close, additional help offered, appreciation

Rate each category 0-25 points. ZERO points if requirements missing.
Automatic ZERO for all categories if any critical violations found.

Additional Penalties:
- For each late reply (number provided in additional data): deduct 20 points from total.
- If wrong popup selection (yes in additional data): deduct 50 points from total.
Cap the adjusted total score at 0 if it goes negative.

In feedback, include:
- Assessment of all 4 elements across all agent replies.
- Explanation of any penalties applied.
- Feedback on the right solution: In this scenario, the agent should trigger a password reset email with clear instructions, and select 'No' for escalation as it's a standard account lock issue.

RESPOND WITH VALID JSON ONLY. Format:
{
  "elements": {
    "greeting": {"present": true/false, "score": 0-25, "feedback": "why"},
    "empathy": {"present": true/false, "score": 0-25, "feedback": "why"},
    "solution": {"present": true/false, "score": 0-25, "feedback": "why"},
    "closing": {"present": true/false, "score": 0-25, "feedback": "why"}
  },
  "totalScore": 0-100,
  "penalties": {
    "lateReplies": {"count": number, "deduction": number},
    "wrongPopup": {"applied": true/false, "deduction": number}
  },
  "adjustedTotalScore": number,
  "feedback": "overall feedback including penalties and right solution",
  "criticalViolation": true/false,
  "violationDetails": "details if any"
}`
};