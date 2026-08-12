'use strict';

function phaseForAssistantText(hasToolCalls) {
  return hasToolCalls ? 'commentary' : 'final_answer';
}

module.exports = { phaseForAssistantText };
