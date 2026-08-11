// 拾知猫 — AI 出题云函数 (CloudBase)
// 替代 Vercel proxy/api/index.js 中的 handleLLM + handleVerify

const crypto = require("crypto");
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const MAX_QUESTIONS_PER_BATCH = envInt("QUIZ_BATCH_SIZE", 2, 1, 5);
const MAX_CONCURRENT_BATCHES = envInt("QUIZ_BATCH_CONCURRENCY", 5, 1, 10);
const MAX_BATCH_ATTEMPTS = envInt("QUIZ_BATCH_ATTEMPTS", 2, 1, 2);
const UPSTREAM_TIMEOUT_MS = envInt("QUIZ_UPSTREAM_TIMEOUT_MS", 10000, 4000, 20000);
const CACHE_TTL_MS = envInt("QUIZ_CACHE_TTL_MS", 10 * 60 * 1000, 60000, 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = envInt("QUIZ_CACHE_MAX_ENTRIES", 100, 10, 500);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = envInt("QUIZ_RATE_LIMIT_MAX", 60, 10, 300);
const quizCache = new Map();
const rateLimits = new Map();

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

exports.main = async (event, context) => {
  const { action } = event;

  switch (action) {
    case "generate":
      return await generate(event, context);
    case "verify":
      return await verify(event);
    default:
      return { ok: false, error: "未知 action: " + action };
  }
};

// ---- AI 出题 ----
async function generate(event, context = {}) {
  const t0 = Date.now();
  const content = String(event.content || '').trim().slice(0, 50000);
  if (content.length < 20) return { ok: false, error: "内容至少需要 20 个字符" };
  if (!DEEPSEEK_KEY) return { ok: false, error: "服务尚未配置 DeepSeek API Key" };

  const quota = consumeGenerateQuota(event, context);
  if (!quota.allowed) {
    return { ok: false, error: "请求过于频繁，请稍后重试", retry_after: quota.retryAfter };
  }

  const n = Math.max(1, Math.min(Number(event.count) || 10, 50));
  const key = quizCacheKey(content, n);
  const cached = getCachedQuiz(key);
  if (cached) {
    return { ok: true, questions: cached, elapsed_ms: Date.now() - t0, cached: true };
  }
  const requestId = crypto.randomUUID();

  try {
    const shuffled = await generateQuizQuestions(content, n, requestId);
    cacheQuiz(key, shuffled);
    const t1 = Date.now();
    console.log(JSON.stringify({
      event: "quiz_request",
      request_id: requestId,
      count: shuffled.length,
      elapsed_ms: t1 - t0,
      cached: false,
    }));
    return {
      ok: true,
      questions: shuffled,
      elapsed_ms: t1 - t0,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function clientKey(event, context) {
  return String(
    event.accountPhone || context.TCB_UUID || context.OPENID || context.WX_OPENID || "anonymous"
  );
}

function consumeGenerateQuota(event, context) {
  const now = Date.now();
  const key = clientKey(event, context);
  const entry = rateLimits.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (rateLimits.size >= 5000) {
      for (const [storedKey, storedEntry] of rateLimits) {
        if (storedEntry.expiresAt <= now) rateLimits.delete(storedKey);
      }
      if (rateLimits.size >= 5000) rateLimits.delete(rateLimits.keys().next().value);
    }
    rateLimits.set(key, { count: 1, expiresAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)) };
  }
  entry.count += 1;
  return { allowed: true };
}

function quizCacheKey(content, count) {
  return crypto.createHash("sha256").update(`${DEEPSEEK_MODEL}:${count}:${content}`).digest("hex");
}

function getCachedQuiz(key) {
  const entry = quizCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    quizCache.delete(key);
    return null;
  }
  return entry.questions.map((question) => ({ ...question, options: question.options.slice() }));
}

function cacheQuiz(key, questions) {
  if (quizCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = quizCache.keys().next().value;
    if (oldest) quizCache.delete(oldest);
  }
  quizCache.set(key, {
    questions: questions.map((question) => ({ ...question, options: question.options.slice() })),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

async function generateQuizQuestions(content, count, requestId) {
  const batchSizes = [];
  for (let remaining = count; remaining > 0; remaining -= MAX_QUESTIONS_PER_BATCH) {
    batchSizes.push(Math.min(MAX_QUESTIONS_PER_BATCH, remaining));
  }

  const results = new Array(batchSizes.length);
  let nextBatch = 0;
  async function runWorker() {
    while (nextBatch < batchSizes.length) {
      const batchIndex = nextBatch++;
      results[batchIndex] = await requestQuestionBatch(
        content,
        batchSizes[batchIndex],
        batchIndex,
        batchSizes.length,
        requestId
      );
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_BATCHES, batchSizes.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  const questions = validateQuestions(results.flat()).slice(0, count);
  if (questions.length === 0) throw new Error("有效题目不足");
  return shuffleUntilBalanced(questions);
}

async function requestQuestionBatch(content, count, batchIndex, batchCount, requestId) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const prompt = buildPrompt(content, count, batchIndex, batchCount, attempt);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + DEEPSEEK_KEY,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            max_tokens: maxTokensForBatch(count),
            response_format: { type: "json_object" },
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error.name === "AbortError") throw createUpstreamError("DeepSeek 请求超时", false);
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const status = Number(resp.status) || 502;
      if (!resp.ok) throw createUpstreamError(`DeepSeek API ${status}`, status >= 500);
      const data = await resp.json();
      const questions = validateQuestions(parseQuestions(data.choices?.[0]?.message?.content) || []);
      if (questions.length === 0) throw new Error("JSON 解析失败");
      console.log(JSON.stringify({
        event: "quiz_batch",
        request_id: requestId,
        batch: batchIndex + 1,
        batch_count: batchCount,
        attempt,
        elapsed_ms: Date.now() - startedAt,
        questions: questions.length,
      }));
      return questions;
    } catch (error) {
      lastError = error;
      console.warn(JSON.stringify({
        event: "quiz_batch_error",
        request_id: requestId,
        batch: batchIndex + 1,
        batch_count: batchCount,
        attempt,
        elapsed_ms: Date.now() - startedAt,
        error: error.message,
      }));
      if (error.retryable === false) break;
    }
  }
  throw lastError || createUpstreamError("AI 出题失败");
}

function createUpstreamError(message, retryable = true) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function maxTokensForBatch(count) {
  return Math.min(2400, Math.max(900, count * 320));
}

// ---- AI 验证答案 ----
async function verify(event) {
  const questions = validateQuestions(Array.isArray(event.questions) ? event.questions.slice(0, 100) : []);
  if (questions.length === 0) {
    return { ok: false, error: "缺少题目数据" };
  }
  if (!DEEPSEEK_KEY) return { ok: false, error: "服务尚未配置 DeepSeek API Key" };

  const BATCH_SIZE = 20;
  const verified = [];

  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);
    const questionList = batch
      .map((q, idx) => {
        return `${idx + 1}. ${q.q}\nA. ${q.options[0]}\nB. ${q.options[1]}\nC. ${q.options[2]}\nD. ${q.options[3]}`;
      })
      .join("\n\n");

    const verifyPrompt = `你是一个专业的答题者。请独立完成以下选择题，给出你认为正确的答案。

${questionList}

输出 JSON 数组，格式：
[{"index":1,"answer":"A","confidence":0.9,"reason":"简要理由"}]

要求：
1. index 是题号（从1开始）
2. answer 是 A/B/C/D
3. confidence 是信心指数 0-1
4. 只输出 JSON，不要其他文字`;

    try {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + DEEPSEEK_KEY,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [{ role: "user", content: verifyPrompt }],
          temperature: 0.3,
          max_tokens: 4096,
          stream: false,
        }),
      });

      if (!resp.ok) {
        verified.push(...batch);
        continue;
      }

      const data = await resp.json();
      let text = data.choices?.[0]?.message?.content || "";
      text = text.replace(/```json|```/g, "").trim();

      const s = text.indexOf("["),
        e = text.lastIndexOf("]");
      if (s >= 0 && e > s) text = text.slice(s, e + 1);

      let llmAnswers;
      try {
        llmAnswers = JSON.parse(text);
      } catch (_) {
        verified.push(...batch);
        continue;
      }

      const letterToIndex = { A: 0, B: 1, C: 2, D: 3 };

      for (let j = 0; j < batch.length; j++) {
        const q = batch[j];
        const llmAns = llmAnswers.find((a) => a.index === j + 1);
        if (!llmAns) {
          verified.push(q);
          continue;
        }

        const llmIdx = letterToIndex[(llmAns.answer || "").toUpperCase()];
        if (llmIdx === undefined) {
          verified.push(q);
          continue;
        }

        if (llmIdx === q.answer) {
          verified.push(q);
        } else if (llmAns.confidence >= 0.8) {
          verified.push({ ...q, answer: llmIdx, exp: q.exp + " [经验证修正]" });
        } else {
          verified.push({ ...q, exp: q.exp + " [AI验证信心不足]" });
        }
      }
    } catch (_) {
      verified.push(...batch);
    }
  }

  return { ok: true, questions: verified };
}

// ---- Prompt 构建 ----
function buildPrompt(content, n, batchIndex = 0, batchCount = 1, attempt = 1) {
  const batchHint = batchCount > 1 ? `这是第${batchIndex + 1}/${batchCount}批，请侧重不同知识点。` : "";
  const retryHint = attempt > 1 ? "上次输出格式错误，这次必须严格遵守 JSON。" : "";
  return `你是专业出题老师。根据以下内容出${n}道四选一选择题。${batchHint}${retryHint}

内容：
${content.slice(0, 8000)}

输出严格 JSON 对象：{"questions":[{"cat":"分类","q":"题干","options":["A","B","C","D"],"answer":0,"exp":"解析"}]}

要求：
1.先答对再出题：每题答案必须100%正确，题干不含答案字眼
2.选项长度相近，干扰项有迷惑性
3.answer下标0-3均匀分布
4.覆盖不同知识点
5.解析简洁准确，不超过60字
6.只输出 JSON 对象，不要 Markdown、解释或代码块`;
}

function parseQuestions(content) {
  const text = String(content || '').replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  const candidates = [text];
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(text.slice(firstObject, lastObject + 1));
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(text.slice(firstArray, lastArray + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.questions)) return parsed.questions;
      if (Array.isArray(parsed?.data?.questions)) return parsed.data.questions;
    } catch (_) {}
  }
  return null;
}

// ---- 验证器 ----
function validateQuestion(q) {
  if (!q.cat || !q.q || !Array.isArray(q.options) || q.options.length !== 4 || typeof q.answer !== "number" || !q.exp)
    return null;
  if (q.answer < 0 || q.answer > 3) return null;

  const opts = q.options.map((o) => String(o).trim());
  if (new Set(opts).size !== 4 || opts.some((o) => !o)) return null;

  const lens = opts.map((o) => o.length);
  if (Math.min(...lens) > 0 && Math.max(...lens) / Math.min(...lens) > 8) return null;

  return { cat: String(q.cat), q: String(q.q), options: opts, answer: q.answer, exp: String(q.exp) };
}

function validateQuestions(arr) {
  return arr.map(validateQuestion).filter((q) => q !== null);
}

function shuffleAnswerOptions(questions) {
  return questions.map((q) => {
    const idx = q.options.map((opt, i) => ({ opt, i }));
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return {
      ...q,
      options: idx.map((x) => x.opt),
      answer: idx.findIndex((x) => x.i === q.answer),
    };
  });
}

function shuffleUntilBalanced(questions) {
  const t = Math.max(2, Math.ceil(questions.length / 4));
  for (let a = 0; a < 5; a++) {
    const s = shuffleAnswerOptions(questions);
    const d = [0, 0, 0, 0];
    s.forEach((q) => d[q.answer]++);
    if (Math.max(...d) - Math.min(...d) <= t) return s;
  }
  return shuffleAnswerOptions(questions);
}
