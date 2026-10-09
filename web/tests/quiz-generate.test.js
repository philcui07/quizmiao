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

test('CloudBase keeps five concurrent batches, then globally removes only reviewed duplicates and caches results', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  let reviewPrompt = '';
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, false);
    assert.equal(payload.response_format.type, 'json_object');
    calls += 1;
    if (payload.max_tokens === 500) {
      reviewPrompt = payload.messages[0].content;
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({ duplicate_groups: [[1, 3], [7, 8]] }) } }] };
        }
      };
    }
    const requested = Number(payload.messages[0].content.match(/出(\d+)道/)?.[1] || 0);
    assert.equal(payload.max_tokens, 960);
    return responseFor(makeQuestions(calls, requested));
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
    assert.equal(calls, 6);
    assert.match(reviewPrompt, /考查问题.*正确结论/);
    assert.match(reviewPrompt, /正确选项文字相同.*判为重复/);
    assert.match(reviewPrompt, /根据描述识别动作表示对齐.*不是重复/);
    assert.match(reviewPrompt, /为何不能从互联网获取.*属于重复/);

    const second = await main(event, { TCB_UUID: 'test-1' });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.questions.length, 10);
    assert.equal(calls, 6);
  } finally {
    global.fetch = originalFetch;
  }
});

test('CloudBase falls back to exact-stem dedupe when semantic review fails', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls += 1;
    if (payload.max_tokens === 500) throw new Error('review unavailable');
    const batch = calls;
    const requested = Number(payload.messages[0].content.match(/出(\d+)道/)?.[1] || 0);
    const questions = makeQuestions(batch, requested);
    if (batch === 2) questions[0].q = 'CloudBase 第1批第1题？！';
    return responseFor(questions);
  };

  try {
    const result = await main({
      action: 'generate',
      content: '这是另一段足够长度且不会命中缓存的查重失败测试知识内容。',
      count: 6,
      accountPhone: '13800000003'
    }, { TCB_UUID: 'test-3' });
    assert.equal(result.ok, true);
    assert.equal(result.questions.length, 6);
    assert.equal(calls, 6);
  } finally {
    global.fetch = originalFetch;
  }
});

test('CloudBase quiz-generate retries a malformed batch', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, async json() { return { choices: [{ message: { content: 'invalid' } }] }; } };
    }
    const payload = JSON.parse(options.body);
    if (payload.max_tokens === 500) {
      return { ok: true, async json() { return { choices: [{ message: { content: '{"duplicate_groups":[]}' } }] }; } };
    }
    const requested = Number(payload.messages[0].content.match(/出(\d+)道/)?.[1] || 0);
    return responseFor(makeQuestions(`retry-${calls}`, requested));
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
    assert.equal(calls, 5);
  } finally {
    global.fetch = originalFetch;
  }
});
