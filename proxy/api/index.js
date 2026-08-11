// Vercel Serverless Function — 拾知猫后端代理
// 标准 Node.js (req, res) 模式
import { createHash, randomUUID } from "node:crypto";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const MAX_QUESTIONS_PER_BATCH = envInt("QUIZ_BATCH_SIZE", 2, 1, 5);
const MAX_CONCURRENT_BATCHES = envInt("QUIZ_BATCH_CONCURRENCY", 5, 1, 10);
const MAX_BATCH_ATTEMPTS = envInt("QUIZ_BATCH_ATTEMPTS", 2, 1, 2);
const UPSTREAM_TIMEOUT_MS = envInt("QUIZ_UPSTREAM_TIMEOUT_MS", 10000, 4000, 20000);
const CACHE_TTL_MS = envInt("QUIZ_CACHE_TTL_MS", 10 * 60 * 1000, 60000, 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = envInt("QUIZ_CACHE_MAX_ENTRIES", 100, 10, 500);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = envInt("QUIZ_RATE_LIMIT_MAX", 60, 10, 300);

// 内存分享存储（Vercel Serverless 实例内共享，低流量下实例存活数分钟到数小时，适合临时分享场景）
const shareStore = new Map();
const SHARE_TTL = 60 * 60 * 1000; // 1小时
const quizCache = new Map();
const rateLimits = new Map();

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function generateShortId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupShares() {
  const now = Date.now();
  for (const [id, entry] of shareStore) {
    if (entry.expiresAt < now) shareStore.delete(id);
  }
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  return String(forwarded).split(",")[0].trim() || "unknown";
}

function consumeGenerateQuota(req) {
  const now = Date.now();
  const key = getClientKey(req);
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
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)),
    };
  }
  entry.count += 1;
  return { allowed: true };
}

function rejectGenerateQuota(req, res, stream = false) {
  const quota = consumeGenerateQuota(req);
  if (quota.allowed) return false;

  res.setHeader("Retry-After", String(quota.retryAfter));
  const payload = { type: "error", error: "请求过于频繁，请稍后重试" };
  if (stream) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
  } else {
    json(res, { ok: false, error: payload.error, retry_after: quota.retryAfter }, 429);
  }
  return true;
}

function quizCacheKey(content, count) {
  return createHash("sha256")
    .update(`${DEEPSEEK_MODEL}:${count}:${content}`)
    .digest("hex");
}

function getCachedQuiz(key) {
  const entry = quizCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    quizCache.delete(key);
    return null;
  }
  return entry.questions.map((question) => ({
    ...question,
    options: question.options.slice(),
  }));
}

function cacheQuiz(key, questions) {
  if (quizCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = quizCache.keys().next().value;
    if (oldest) quizCache.delete(oldest);
  }
  quizCache.set(key, {
    questions: questions.map((question) => ({
      ...question,
      options: question.options.slice(),
    })),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isWeChat = ua.includes("micromessenger") || ua.includes("wechat");
  const isCrawler =
    isWeChat ||
    ua.includes("bot") ||
    ua.includes("spider") ||
    ua.includes("twitterbot") ||
    ua.includes("facebookexternalhit") ||
    ua.includes("slack") ||
    ua.includes("telegram");

  try {
    // ?url=xxx → fetch & extract text
    const targetUrl = url.searchParams.get("url");
    if (targetUrl) {
      return await handleFetch(targetUrl, res);
    }

    // POST /llm → generate quiz questions (non-streaming)
    if (url.pathname === "/llm" && req.method === "POST") {
      return await handleLLM(req, res);
    }

    // POST /llm-stream → generate quiz questions (SSE streaming)
    if (url.pathname === "/llm-stream" && req.method === "POST") {
      return await handleLLMStream(req, res);
    }

    // POST /verify → verify quiz answers
    if (url.pathname === "/verify" && req.method === "POST") {
      return await handleVerify(req, res);
    }

    // /s/:encodedData → share link with SEO meta
    const shareMatch = url.pathname.match(/^\/s\/(.+)$/);
    if (shareMatch) {
      return handleShare(shareMatch[1], isCrawler, url, res);
    }

    // POST /share → save quiz data, return short id
    // GET  /share?id=xxx → retrieve quiz data by short id
    if (url.pathname === "/share" || url.pathname === "/api/share") {
      if (req.method === "POST") {
        return await handleShareSave(req, res);
      }
      if (req.method === "GET") {
        return await handleShareGet(url, res);
      }
    }

    // Default redirect
    res.setHeader("Location", "https://philcui07.github.io/quizmiao/");
    return res.status(302).end();
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

// ---- Helpers ----
function json(res, data, status = 200) {
  return res.status(status).json(data);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        resolve({});
      }
    });
  });
}

// ---- Fetch & extract text ----
async function handleFetch(targetUrl, res) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuizMiao/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return json(res, { ok: false, error: `HTTP ${resp.status}` }, 502);
    }
    const html = await resp.text();
    const text = extractText(html);
    if (text.length < 20) {
      return json(
        res,
        {
          ok: false,
          error: "JS_RENDERED",
          hint: "该网页是 JavaScript 动态渲染的，无法自动抓取。请打开网页 → 全选复制内容 → 粘贴到文本框中。",
        },
        502
      );
    }
    return json(res, { ok: true, text: text.slice(0, 50000), length: text.length });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 502);
  }
}

// ---- Share: save data (POST /share) ----
async function handleShareSave(req, res) {
  try {
    cleanupShares();
    const body = await readBody(req);
    const questions = body.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return json(res, { ok: false, error: "缺少题目数据" }, 400);
    }
    const id = generateShortId();
    shareStore.set(id, { questions, expiresAt: Date.now() + SHARE_TTL });
    return json(res, { ok: true, id });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

// ---- Share: get data (GET /share?id=xxx) ----
async function handleShareGet(url, res) {
  try {
    cleanupShares();
    const id = url.searchParams.get("id");
    if (!id) return json(res, { ok: false, error: "缺少分享ID" }, 400);
    const entry = shareStore.get(id);
    if (!entry) return json(res, { ok: false, error: "分享已过期（有效时长1小时），请让分享者重新生成" }, 404);
    return json(res, { ok: true, questions: entry.questions });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

// ---- Share page (SEO meta for crawlers) ----
function handleShare(encodedData, isCrawler, requestUrl, res) {
  const mainUrl = `https://philcui07.github.io/quizmiao/#q=${encodedData}`;

  if (!isCrawler) {
    res.setHeader("Location", mainUrl);
    return res.status(302).end();
  }

  let previewTitle = "拾知猫";
  let previewDesc = "有人分享了一组练习题给你，点击打开做题！";
  try {
    const estimatedBytes = Math.floor((encodedData.length * 3) / 4);
    const estimatedQuestions = Math.floor(estimatedBytes / 60);
    if (estimatedQuestions > 0 && estimatedQuestions <= 99) {
      previewTitle = `拾知猫 · ${estimatedQuestions}道练习题`;
      previewDesc = `包含约 ${estimatedQuestions} 道 AI 生成的练习题，覆盖多个知识点，点击开始做题！`;
    }
  } catch (_) {}

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${previewTitle}</title>
<meta property="og:title" content="${previewTitle}">
<meta property="og:description" content="${previewDesc}">
<meta property="og:type" content="website">
<meta property="og:url" content="${requestUrl.href}">
<meta property="og:image" content="https://philcui07.github.io/quizmiao/icon.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:locale" content="zh_CN">
<meta property="og:site_name" content="拾知猫">
<meta http-equiv="refresh" content="0;url=${mainUrl}">
</head>
<body>
<p>正在跳转到拾知猫...</p>
<script>location.href='${mainUrl}';</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
}

// ---- LLM: generate quiz (non-streaming, with inline self-verification) ----
async function handleLLM(req, res) {
  const t0 = Date.now();
  try {
    if (rejectGenerateQuota(req, res)) return;
    const body = await readBody(req);
    const { content, count } = body;
    if (!content) return json(res, { ok: false, error: "缺少内容" }, 400);

    const n = normalizeQuestionCount(count);
    const key = quizCacheKey(content, n);
    const cached = getCachedQuiz(key);
    if (cached) {
      return json(res, { ok: true, questions: cached, elapsed_ms: Date.now() - t0, cached: true });
    }

    const requestId = randomUUID();
    const shuffled = await generateQuizQuestions(content, n, null, requestId);
    cacheQuiz(key, shuffled);
    const t1 = Date.now();
    console.log(JSON.stringify({
      event: "quiz_request",
      request_id: requestId,
      count: shuffled.length,
      elapsed_ms: t1 - t0,
      cached: false,
    }));
    return json(res, {
      ok: true,
      questions: shuffled,
      elapsed_ms: t1 - t0,
    });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, e.statusCode || 500);
  }
}

// ---- LLM: SSE-compatible response backed by a reliable non-streaming request ----
async function handleLLMStream(req, res) {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (rejectGenerateQuota(req, res, true)) return;

  const body = await readBody(req);
  const { content, count } = body;
  if (!content) {
    res.write(`data: ${JSON.stringify({ type: "error", error: "缺少内容" })}\n\n`);
    return res.end();
  }

  const n = normalizeQuestionCount(count);
  let heartbeat = null;

  try {
    // Keep the browser-facing SSE contract while using reliable structured
    // upstream responses. Completed batches are still emitted immediately.
    res.write(`data: ${JSON.stringify({ type: "start", count: n })}\n\n`);
    heartbeat = setInterval(() => res.write(": keepalive\n\n"), 10000);

    const key = quizCacheKey(content, n);
    const cached = getCachedQuiz(key);
    let sentCount = 0;
    const emitBatch = (batch) => {
      batch.forEach((question) => {
        sentCount += 1;
        res.write(
          `data: ${JSON.stringify({ type: "question", question, index: sentCount })}\n\n`
        );
      });
    };

    if (cached) {
      emitBatch(cached);
    } else {
      const generated = await generateQuizQuestions(content, n, emitBatch, randomUUID());
      cacheQuiz(key, generated);
    }

    // Send done event
    res.write(`data: ${JSON.stringify({ type: "done", count: sentCount })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
    res.end();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function normalizeQuestionCount(count) {
  const parsed = Number.parseInt(count, 10);
  return Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 10;
}

async function generateQuizQuestions(content, count, onBatch = null, requestId = randomUUID()) {
  const batchSizes = [];
  for (let remaining = count; remaining > 0; remaining -= MAX_QUESTIONS_PER_BATCH) {
    batchSizes.push(Math.min(MAX_QUESTIONS_PER_BATCH, remaining));
  }

  const results = new Array(batchSizes.length);
  let nextBatch = 0;

  async function runWorker() {
    while (nextBatch < batchSizes.length) {
      const batchIndex = nextBatch++;
      const batch = await requestQuestionBatch(
        content,
        batchSizes[batchIndex],
        batchIndex,
        batchSizes.length,
        requestId
      );
      results[batchIndex] = shuffleUntilBalanced(batch);
      if (onBatch) onBatch(results[batchIndex]);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_BATCHES, batchSizes.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  const questions = validateQuestions(results.flat()).slice(0, count);
  if (questions.length === 0) {
    const error = new Error("有效题目不足");
    error.statusCode = 502;
    throw error;
  }
  return onBatch ? questions : shuffleUntilBalanced(questions);
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
            stream: false,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error.name === "AbortError") throw createUpstreamError("DeepSeek 请求超时", 504);
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      if (!resp.ok) {
        throw createUpstreamError(`API ${resp.status}`);
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || "";
      const questions = parseQuestionResponse(text);
      if (questions.length === 0) {
        throw createUpstreamError("有效题目不足");
      }
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
    }
  }

  throw lastError || createUpstreamError("AI 出题失败");
}

function parseQuestionResponse(rawText) {
  const text = rawText.replace(/```json|```/g, "").trim();
  const candidates = [text];

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const items = Array.isArray(parsed) ? parsed : parsed.questions;
      if (Array.isArray(items)) return validateQuestions(items);
    } catch (_) {}
  }

  throw createUpstreamError("JSON 解析失败");
}

function createUpstreamError(message) {
  const error = new Error(message);
  error.statusCode = message.includes("超时") ? 504 : 502;
  return error;
}

function maxTokensForBatch(count) {
  return Math.min(2400, Math.max(900, count * 320));
}

// ---- Build prompt ----
function buildPrompt(content, n, batchIndex = 0, batchCount = 1, attempt = 1) {
  const batchHint = batchCount > 1
    ? `这是第${batchIndex + 1}/${batchCount}批，请侧重与其他批次不同的知识点。`
    : "";
  const retryHint = attempt > 1 ? "上次输出格式错误，这次必须严格遵守JSON格式。" : "";
  return `你是专业出题老师。根据以下内容出${n}道四选一选择题。${batchHint}${retryHint}

内容：
${content.slice(0, 8000)}

输出JSON对象：{"questions":[{"cat":"分类","q":"题干","options":["A","B","C","D"],"answer":0,"exp":"解析"}]}

要求：
1.先答对再出题：每题答案必须100%正确，题干不含答案字眼
2.选项长度相近，干扰项有迷惑性
3.answer下标0-3均匀分布
4.覆盖不同知识点
5.解析简洁准确，不超过60字
6.只输出JSON`;
}

// ---- LLM: verify answers ----
async function handleVerify(req, res) {
  try {
    const body = await readBody(req);
    const { questions } = body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return json(res, { ok: false, error: "缺少题目数据" }, 400);
    }

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
            model: "deepseek-v4-flash",
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

    return json(res, { ok: true, questions: verified });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

// ---- Validators & helpers ----

/** Validate a single question object, return cleaned question or null */
function validateQuestion(q) {
  if (
    !q.cat ||
    !q.q ||
    !Array.isArray(q.options) ||
    q.options.length !== 4 ||
    typeof q.answer !== "number" ||
    !q.exp
  )
    return null;
  if (q.answer < 0 || q.answer > 3) return null;

  const opts = q.options.map((o) => String(o).trim());
  if (new Set(opts).size !== 4 || opts.some((o) => !o)) return null;

  // Relaxed: only reject extreme length disparity (8x instead of 3.5x)
  const lens = opts.map((o) => o.length);
  if (Math.min(...lens) > 0 && Math.max(...lens) / Math.min(...lens) > 8) return null;

  return { cat: String(q.cat), q: String(q.q), options: opts, answer: q.answer, exp: String(q.exp) };
}

/** Validate an array of questions */
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

function extractText(html) {
  html = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, "");

  return html
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
