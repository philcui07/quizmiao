const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DEEPSEEK_API_KEY = 'test-key';
const { main } = require('../cloudbase/functions/quiz-generate/index.js');

function responseFor(questions) {
  return {
    ok: true,
    async json() {
      return { choices: [{ message: { content: JSON.stringify({ questions }) } }] };
    }
  };
}

function makeQuestions(batch, count) {
  return Array.from({ length: count }, (_, index) => ({
    cat: `批次${batch}`,
    q: `CloudBase 第${batch}批第${index + 1}题？`,
    options: ['选项一', '选项二', '选项三', '选项四'],
    answer: index % 4,
    exp: '测试解析'
  }));
}

test('CloudBase quiz-generate splits ten questions into five concurrent batches and caches results', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, false);
    assert.equal(payload.response_format.type, 'json_object');
    assert.equal(payload.max_tokens, 900);
    calls += 1;
    return responseFor(makeQuestions(calls, 2));
  };

  try {
    const event = {
      action: 'generate',
      content: '这是一段足够长度的 CloudBase 测试知识内容。',
      count: 10,
      accountPhone: '13800000001'
    };
    const first = await main(event, { TCB_UUID: 'test-1' });
    assert.equal(first.ok, true);
    assert.equal(first.questions.length, 10);
    assert.equal(calls, 5);

    const second = await main(event, { TCB_UUID: 'test-1' });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.questions.length, 10);
    assert.equal(calls, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('CloudBase quiz-generate retries a malformed batch', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, async json() { return { choices: [{ message: { content: 'invalid' } }] }; } };
    }
    return responseFor(makeQuestions('retry', 2));
  };

  try {
    const result = await main({
      action: 'generate',
      content: '这是一段足够长度的 CloudBase 重试测试知识内容。',
      count: 2,
      accountPhone: '13800000002'
    }, { TCB_UUID: 'test-2' });
    assert.equal(result.ok, true);
    assert.equal(result.questions.length, 2);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
