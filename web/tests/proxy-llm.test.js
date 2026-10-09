import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_INPUT_CHARS,
  QUIZ_GENERATE_TARGET_MS,
  buildPrompt,
  buildDedupeReviewPrompt,
  dedupeQuestions,
  generateFastQuestions,
  selectBatchContent,
  buildCandidateBatchSizes,
  applyDuplicateGroups
} from '../proxy/api/index.js';

test('proxy sends up to 16000 input characters in the same deduplication prompt', () => {
  const content = '甲'.repeat(9000) + '八千以后仍保留' + '乙'.repeat(8000);
  const prompt = buildPrompt(content, 10);
  assert.equal(MAX_INPUT_CHARS, 16000);
  assert.match(prompt, /八千以后仍保留/);
  assert.match(prompt, /考查问题.*正确结论/);
  assert.match(prompt, /不得仅因知识分类.*正确答案相同而删除/);
  assert.match(prompt, /不足10题可以少输出/);
  assert.equal(prompt.includes('乙'.repeat(7001)), false);
});

test('long input is split into non-overlapping batch regions to reduce latency and duplicates', () => {
  const content = Array.from({ length: 5 }, (_, index) =>
    `第${index + 1}区标记\n` + String(index + 1).repeat(1200)
  ).join('\n');
  const regions = Array.from({ length: 5 }, (_, index) => selectBatchContent(content, index, 5));
  assert.equal(regions.length, 5);
  assert.equal(regions.every((region) => region.length >= 1000 && region.length <= 1400), true);
  for (let index = 0; index < 5; index++) {
    assert.match(regions[index], new RegExp(`第${index + 1}区标记`));
    assert.equal(regions.filter((region) => region.includes(`第${index + 1}区标记`)).length, 1);
  }
});

test('numbered knowledge points stay intact when distributed across generation batches', () => {
  const content = '知识清单说明\n' + Array.from({ length: 10 }, (_, index) =>
    `${index + 1}. 知识点${index + 1}\n定义${index + 1}\n例句${index + 1}\n` + '内容'.repeat(220)
  ).join('\n');
  const regions = Array.from({ length: 5 }, (_, index) => selectBatchContent(content, index, 5));
  for (let point = 1; point <= 10; point++) {
    assert.equal(regions.filter((region) => region.includes(`${point}. 知识点${point}\n`)).length, 1);
    const owner = regions.find((region) => region.includes(`${point}. 知识点${point}\n`));
    assert.match(owner, new RegExp(`定义${point}\\n例句${point}`));
  }
  assert.deepEqual(regions.map((region) => (region.match(/^\d+\.\s/gm) || []).length), [2, 2, 2, 2, 2]);
});

test('dedupe review prompt preserves different cognitive tasks but removes same-fact rewrites', () => {
  const prompt = buildDedupeReviewPrompt([
    { cat: '流程', q: '根据描述识别处理步骤', options: ['动作表示对齐', 'B', 'C', 'D'], answer: 0 },
    { cat: '流程', q: '动作表示对齐解决什么问题', options: ['统一格式', 'B', 'C', 'D'], answer: 0 }
  ]);
  assert.match(prompt, /根据描述识别动作表示对齐.*不重复/);
  assert.match(prompt, /黄金标准和数据孤岛.*不重复/);
  assert.match(prompt, /为何不能从互联网获取.*重复/);
  assert.match(prompt, /动作表示对齐的目的.*重复/);
});

test('miniapp backend keeps five parallel batches and applies one bounded global review', async () => {
  const originalFetch = global.fetch;
  let active = 0;
  let maxActive = 0;
  let generationCalls = 0;
  let reviewCalls = 0;
  let requestedCandidates = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.max_tokens === 500) {
      reviewCalls += 1;
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: '{"duplicate_groups":[[1,3],[7,8]]}' } }] };
        }
      };
    }
    generationCalls += 1;
    const batch = generationCalls;
    const requested = Number(payload.messages[0].content.match(/出(\d+)道/)?.[1] || 0);
    requestedCandidates += requested;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const questions = Array.from({ length: requested }, (_, index) => ({
      cat: `批次${batch}`,
      q: `Miniapp 第${batch}批第${index + 1}题？`,
      options: ['选项一', '选项二', '选项三', '选项四'],
      answer: index,
      exp: '解析'
    }));
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(questions) } }] };
      }
    };
  };

  try {
    const result = await generateFastQuestions('足够长度的 Miniapp 并发出题测试内容。', 10);
    assert.equal(QUIZ_GENERATE_TARGET_MS, 10000);
    assert.equal(generationCalls, 5);
    assert.equal(reviewCalls, 1);
    assert.equal(maxActive, 5);
    assert.equal(requestedCandidates, 15);
    assert.equal(result.length, 10);
  } finally {
    global.fetch = originalFetch;
  }
});

test('selected question count requests 150 percent candidates in balanced parallel batches', () => {
  assert.deepEqual(buildCandidateBatchSizes(Math.ceil(5 * 1.5)), [2, 2, 2, 1, 1]);
  assert.deepEqual(buildCandidateBatchSizes(Math.ceil(10 * 1.5)), [3, 3, 3, 3, 3]);
  assert.deepEqual(buildCandidateBatchSizes(Math.ceil(20 * 1.5)), [6, 6, 6, 6, 6]);
});

test('semantic dedupe can only remove surplus candidates and never relies on a partial keep list', () => {
  const questions = Array.from({ length: 15 }, (_, index) => ({ q: `第${index + 1}题` }));
  const overlyAggressiveGroups = [
    [1, 2, 3, 4, 5, 6, 7, 8],
    [9, 10, 11, 12, 13, 14, 15]
  ];
  const reviewed = applyDuplicateGroups(questions, overlyAggressiveGroups, 10);
  assert.equal(reviewed.length, 10);
  assert.deepEqual(applyDuplicateGroups(questions, undefined, 10), questions);
});

test('proxy removes normalized duplicate questions without filling the target count', () => {
  const base = {
    cat: '具身数据',
    q: '具身数据为什么不能简单从互联网爬取？',
    options: ['多模态与物理闭环', '只包含文本', '无需时序', '成本为零'],
    answer: 0,
    exp: '包含真实物理交互。'
  };
  const duplicate = { ...base, q: '具身数据为什么不能简单从互联网爬取？！' };
  const unique = { ...base, q: '便携采集范式的主要优势是什么？' };
  const result = dedupeQuestions([base, duplicate, unique]);
  assert.equal(result.length, 2);
});

test('proxy rejects the same normalized question even when its options differ', () => {
  const questions = [
    { q: '具身数据是什么？', options: ['A', 'B', 'C', 'D'] },
    { q: '具身数据 是什么', options: ['甲', '乙', '丙', '丁'] }
  ];
  assert.equal(dedupeQuestions(questions).length, 1);
});
