// Updated evaluationCriteria.js
const evaluationConfig = {
  criteria: {
    greeting: {
      description: "First customer contact and introduction",
      requiredElements: [
        "Professional greeting",
        "Customer name use",
        "Clear offer to help"
      ],
      maxScore: 25
    },
    empathy: {
      description: "Understanding and acknowledging customer's situation",
      requiredElements: [
        "Acknowledgment of issue",
        "Understanding phrase",
        "Supportive language"
      ],
      maxScore: 25
    },
    solution: {
      description: "Problem resolution and steps provided",
      requiredElements: [
        "Clear action steps",
        "Verification process",
        "Expected outcome"
      ],
      maxScore: 25
    },
    closing: {
      description: "Professional conversation end",
      requiredElements: [
        "Professional closing",
        "Additional help offer",
        "Appreciation"
      ],
      maxScore: 25
    }
  },

  examples: {
    good: [
      {
        type: "greeting",
        text: "Hello Mr. Carter, I understand you're having trouble accessing your account. I'm here to help resolve this for you."
      },
      {
        type: "empathy",
        text: "I understand how frustrating it is to be locked out of your account. I'll help you regain access right away."
      },
      {
        type: "solution",
        text: "Hi James, Thank you for your reply. I've triggered a new password reset for your account. Check your email (including spam/junk) for the link—it expires in 1 hour. If issues persist, reply here and I'll manually unlock your account!\n\nJohn Smith\nCS of K Store"
      }
    ],
    bad: [
      {
        type: "greeting",
        text: "Hi there, what's the problem?"
      },
      {
        type: "closing",
        text: "k bye"
      }
    ]
  },

  violations: {
    profanity: ["hell", "damn", "crap"],
    unprofessional: ["k", "yeah yeah", "whatever"],
    dismissive: ["not my problem", "figure it out"],
    hostile: ["go away", "leave me alone"]
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
  }
};

module.exports = evaluationConfig;