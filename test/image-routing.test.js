'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyImageRouting } = require('../src/image-routing');

function user(text, extraContent = []) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }, ...extraContent],
  };
}

function classify(text, extraInput = [], extraContent = []) {
  return classifyImageRouting({
    input: [...extraInput, user(text, extraContent)],
  });
}

for (const prompt of [
  'Generate an image of a lake.',
  'Draw a robot.',
  'Make a picture of a castle.',
  'Create an illustration of a fox.',
  'Render a cinematic forest.',
  'Can you draw a red dragon?',
  'I want you to draw a red dragon.',
  'I need an image of a mountain cabin.',
  'Show me a generated picture of a futuristic city.',
  'Turn this text description into an image.',
]) {
  test('routes explicit image generation: ' + prompt, () => {
    const decision = classify(prompt);
    assert.equal(decision.route, 'image_generation');
    assert.equal(decision.reason, 'explicit_generation_request');
  });
}

for (const prompt of [
  'Can this model read images?',
  'Why did it generate an image?',
  'Do not generate an image.',
  "Don't draw anything.",
  'Explain this without making a picture.',
  'Use text only.',
  'I am not asking you to create an image.',
  'Explain image generation.',
  'Fix the draw-image routing code.',
  'The log says create image failed.',
  'That worked.',
]) {
  test('keeps non-generation text on the chat model: ' + prompt, () => {
    assert.equal(classify(prompt).route, 'text');
  });
}

test('quoted generation wording does not route', () => {
  const decision = classify('The customer wrote "generate an image" in the ticket.');
  assert.equal(decision.route, 'text');
  assert.equal(decision.reason, 'default_text');
});

test('generation wording in a code block does not route', () => {
  const decision = classify('Explain this code:\n```\ngenerate an image of a lake\n```');
  assert.equal(decision.route, 'text');
});

test('developer generation instructions do not route', () => {
  const decision = classifyImageRouting({
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Generate an image.' }] },
      user('Tell me the time.'),
    ],
  });
  assert.equal(decision.route, 'text');
});

test('image attachment without generation intent stays text', () => {
  const decision = classify('Describe this.', [], [{
    type: 'input_image',
    image_url: 'data:image/png;base64,AAAA',
  }]);
  assert.equal(decision.route, 'text');
  assert.equal(decision.reason, 'image_understanding_request');
});

test('Computer Use screenshot followed by normal chat stays text', () => {
  const decision = classify('What folder is open?', [{
    type: 'function_call_output',
    call_id: 'computer_use',
    output: [{
      type: 'input_image',
      image_url: 'file:///tmp/computer-use.png',
    }],
  }]);
  assert.equal(decision.route, 'text');
  assert.equal(decision.reason, 'image_understanding_request');
});

test('view_image result followed by ordinary acknowledgement stays text', () => {
  const decision = classify('That worked.', [{
    type: 'function_call_output',
    call_id: 'view_image',
    output: [{ type: 'input_image', file_id: 'file_viewed' }],
  }]);
  assert.equal(decision.route, 'text');
  assert.equal(decision.reason, 'image_present_without_generation_intent');
});

for (const output of [
  'Screenshot saved to /tmp/capture.jpg',
  'Screenshot saved to file:///tmp/capture.png',
]) {
  test('tool result path does not trigger generation: ' + output, () => {
    const decision = classify('Continue with the next step.', [{
      type: 'function_call_output',
      call_id: 'tool_call',
      output,
    }]);
    assert.equal(decision.route, 'text');
  });
}

for (const followup of [
  'Make another one.',
  'Generate a second version.',
  'Change the background to blue.',
  'Make it more photorealistic.',
  'Create a square version.',
]) {
  test('routes generation follow-up with generation context: ' + followup, () => {
    const decision = classify(followup, [
      user('Generate an image of a lake.'),
      {
        type: 'image_generation_call',
        id: 'img_previous',
        status: 'completed',
        revised_prompt: 'An alpine lake at sunrise',
        saved_path: '/tmp/lake.png',
      },
    ]);
    assert.equal(decision.route, 'image_generation');
    assert.equal(decision.reason, 'generation_followup');
    assert.match(decision.prompt, /An alpine lake at sunrise/);
    assert.match(decision.prompt, new RegExp(followup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('short edit without generation context stays text', () => {
  assert.equal(classify('Change the background to blue.').route, 'text');
  assert.equal(classify('Make another one.').route, 'text');
});

test('normal text after a generated image stays text', () => {
  const decision = classify('What time is it?', [
    user('Generate an image of a lake.'),
    { type: 'image_generation_call', status: 'completed', revised_prompt: 'lake' },
  ]);
  assert.equal(decision.route, 'text');
  assert.equal(decision.reason, 'default_text');
});

test('tool continuation does not repeat a historical generation request', () => {
  const decision = classifyImageRouting({
    input: [
      user('Generate an image of a lake.'),
      { type: 'function_call', name: 'tool_search', call_id: 'call_search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_search', output: 'tool result' },
    ],
  });
  assert.equal(decision.route, 'text');
  assert.equal(decision.reason, 'default_text');
});

test('screenshot capture and persistence continuation stays text', () => {
  const decision = classifyImageRouting({
    input: [
      user('Capture the current window and persist the screenshot.'),
      { type: 'function_call', name: 'ComputerUse', call_id: 'call_computer', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_computer',
        output: 'Saved screenshot to file:///tmp/computer-use.jpg',
      },
    ],
  });
  assert.equal(decision.route, 'text');
});
