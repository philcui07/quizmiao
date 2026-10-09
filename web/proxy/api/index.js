// Vercel Serverless Function — 拾知猫后端代理
// 标准 Node.js (req, res) 模式
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MAX_INPUT_CHARS = 16000;
const QUIZ_CANDIDATE_RATIO = 1.5;
const QUIZ_MAX_BATCH_SIZE = 6;
const QUIZ_BATCH_CONCURRENCY = 5;
const QUIZ_GENERATE_TARGET_MS = 10000;
const QUIZ_DEDUPE_TIMEOUT_MS = 2200;

// 内存分享存储（Vercel Serverless 实例内共享，低流量下实例存活数分钟到数小时，适合临时分享场景）
const shareStore = new Map();
const SHARE_TTL = 60 * 60 * 1000; // 1小时

function generateShortId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupShares() {
  const now = Date.now();
  for (const [id, entry] of shareStore) {
    if (entry.expiresAt < now) shareStore.delete(id);
  }
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
    const body = await readBody(req);
    const { content, count } = body;
    if (!content) return json(res, { ok: false, error: "缺少内容" }, 400);

    const n = Math.max(1, Math.min(Number(count) || 10, 50));
    const valid = await generateFastQuestions(content, n, t0);
    if (valid.length < 1) {
      return json(res, { ok: false, error: "有效题目不足" }, 502);
    }

    const shuffled = shuffleUntilBalanced(valid);
    const t3 = Date.now();
    console.log(`[LLM] ${shuffled.length} questions total ${t3 - t0}ms, target_met=${t3 - t0 <= QUIZ_GENERATE_TARGET_MS}`);
    return json(res, {
      ok: true,
      questions: shuffled,
      elapsed_ms: t3 - t0,
    });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

// ---- LLM: generate quiz with SSE streaming ----
async function handleLLMStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const body = await readBody(req);
  const { content, count } = body;
  if (!content) {
    res.write(`data: ${JSON.stringify({ type: "error", error: "缺少内容" })}\n\n`);
    return res.end();
  }

  const n = Math.max(1, Math.min(Number(count) || 10, 50));
  const startedAt = Date.now();
  res.write(`data: ${JSON.stringify({ type: "start", count: n })}\n\n`);

  try {
    const questions = shuffleUntilBalanced(await generateFastQuestions(content, n, startedAt));
    for (let index = 0; index < questions.length; index++) {
      res.write(`data: ${JSON.stringify({
        type: "question",
        question: questions[index],
        index: index + 1,
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      type: "done",
      count: questions.length,
      elapsed_ms: Date.now() - startedAt,
      target_met: Date.now() - startedAt <= QUIZ_GENERATE_TARGET_MS,
    })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
    res.end();
  }
}

// ---- Build prompt ----
function buildPrompt(content, n, batchIndex = 0, batchCount = 1) {
  const batchHint = batchCount > 1
    ? `这是第${batchIndex + 1}/${batchCount}批，只根据下面分配到的内容区域取材，每题考查不同事实维度。`
    : "";
  return `你是专业出题老师。根据以下内容出${n}道四选一选择题。${batchHint}

内容：
${String(content || "").slice(0, MAX_INPUT_CHARS)}

输出JSON数组：[{"cat":"分类","q":"题干","options":["A","B","C","D"],"answer":0,"exp":"解析"}]

要求：
1.先答对再出题：每题答案必须100%正确，题干不含答案字眼
2.选项长度相近，干扰项有迷惑性
3.answer下标0-3均匀分布
4.覆盖不同知识点
5.先识别内容中的编号条目、知识点标题和易错点；素材足够时，每道题必须来自不同条目或不同子知识点
6.优先改写为新的应用场景，不要直接照抄原文易错题和例句
7.cat 必须填写具体知识点名称，例如“must否定回答”，不要只写“语法”“词汇”
8.只有“考查问题”和“正确结论”都实质相同时才算重复；不得仅因知识分类、对象、来源段落或正确答案相同而删除
9.同一知识点的事实、原因、优缺点、比较、流程识别、场景应用属于不同考法，应保留
10.去重后不足${n}题可以少输出，禁止为了凑数改写真正的重复题
11.只输出去重后的JSON数组，不要输出查重过程或其他文字`;
}

function selectBatchContent(content, batchIndex, batchCount) {
  const text = String(content || "").slice(0, MAX_INPUT_CHARS);
  if (batchCount <= 1 || text.length < batchCount * 400) return text;
  const numberedSections = splitNumberedKnowledgeSections(text, batchCount);
  if (numberedSections) return numberedSections[batchIndex];
  const boundaries = [0];
  for (let index = 1; index < batchCount; index++) {
    const ideal = Math.floor(text.length * index / batchCount);
    const before = text.lastIndexOf("\n", ideal);
    const after = text.indexOf("\n", ideal);
    const candidates = [before, after].filter((value) => value > boundaries[boundaries.length - 1]);
    const nearest = candidates.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    boundaries.push(Number.isInteger(nearest) && Math.abs(nearest - ideal) <= 300 ? nearest : ideal);
  }
  boundaries.push(text.length);
  return text.slice(boundaries[batchIndex], boundaries[batchIndex + 1]).trim();
}

function splitNumberedKnowledgeSections(text, batchCount) {
  const matches = [...text.matchAll(/^\s*\d+\.\s+\S.*$/gm)];
  if (matches.length < batchCount) return null;
  const blocks = matches.map((match, index) => {
    const start = index === 0 ? 0 : match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return text.slice(start, end).trim();
  });
  const baseSize = Math.floor(blocks.length / batchCount);
  const largerGroups = blocks.length % batchCount;
  const sections = [];
  let cursor = 0;
  for (let index = 0; index < batchCount; index++) {
    const size = baseSize + (index < largerGroups ? 1 : 0);
    sections.push(blocks.slice(cursor, cursor + size).join("\n\n"));
    cursor += size;
  }
  return sections;
}

function parseQuestionArray(content) {
  let text = String(content || "").replace(/```json|```/g, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function requestQuestionBatch(content, count, batchIndex, batchCount) {
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + DEEPSEEK_KEY,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: buildPrompt(content, count, batchIndex, batchCount) }],
      temperature: 0.2,
      max_tokens: Math.min(2400, Math.max(900, count * 320)),
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data = await resp.json();
  const questions = validateQuestions(parseQuestionArray(data.choices?.[0]?.message?.content));
  if (questions.length < 1) throw new Error("JSON 解析失败");
  return questions;
}

function buildDedupeReviewPrompt(questions) {
  const summaries = questions.map((question, index) => ({
    index: index + 1,
    category: question.cat,
    question: question.q,
    correct_answer: question.options[question.answer],
  }));
  return `你是选择题查重审核员。只返回有充分证据的重复题组。

候选题：${JSON.stringify(summaries)}

规则：
1. 仅当“考查问题”和“正确结论”都实质相同，才删除后出现的一题。
2. 不得因为分类、对象、来源段落或正确答案相同就判重。
3. 不同事实维度、原因、优缺点、比较、流程识别、场景应用或判断方式应保留。
4. 正反问、换词、改句式但仍识别同一事实，属于重复。
5. 多个“哪种范式是黄金标准”重复；多个“既是黄金标准又强绑定机器人”重复。
6. “根据描述识别动作表示对齐”与“动作表示对齐解决什么问题”不重复；同答“真机遥操作”但分别问黄金标准和数据孤岛，也不重复。
7. “为何不能从互联网获取”与“哪项不是其特征（可轻易从互联网获取）”重复；“动作表示对齐的目的”与“它解决什么问题”重复。

重复组内第一个编号为应保留题，其余编号为可删除的重复题。没有重复时返回空数组。
输出严格 JSON：{"duplicate_groups":[[2,14],[8,15]]}。不要输出保留编号，不要解释。`;
}

function applyDuplicateGroups(questions, groups, targetCount) {
  const removableBudget = Math.max(0, questions.length - targetCount);
  if (removableBudget === 0) return questions;
  const removed = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    const indexes = [...new Set((Array.isArray(group) ? group : [])
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= questions.length))];
    if (indexes.length < 2) continue;
    for (const index of indexes.slice(1)) {
      if (removed.size >= removableBudget) break;
      removed.add(index - 1);
    }
    if (removed.size >= removableBudget) break;
  }
  return questions.filter((_, index) => !removed.has(index));
}

async function reviewDuplicatesWithinBudget(questions, startedAt, targetCount) {
  const remaining = QUIZ_GENERATE_TARGET_MS - (Date.now() - startedAt) - 250;
  if (remaining < 500 || questions.length < 2) return questions;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(QUIZ_DEDUPE_TIMEOUT_MS, remaining));
  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_KEY,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: buildDedupeReviewPrompt(questions) }],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return questions;
    const data = await resp.json();
    const parsed = JSON.parse(String(data.choices?.[0]?.message?.content || "{}")
      .replace(/^```(?:json)?\s*|\s*```$/gi, ""));
    return applyDuplicateGroups(questions, parsed.duplicate_groups, targetCount);
  } catch (_) {
    return questions;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateFastQuestions(content, count, startedAt = Date.now()) {
  const candidateCount = Math.ceil(count * QUIZ_CANDIDATE_RATIO);
  const batchSizes = buildCandidateBatchSizes(candidateCount);
  const results = new Array(batchSizes.length);
  let nextBatch = 0;
  async function worker() {
    while (nextBatch < batchSizes.length) {
      const index = nextBatch++;
      results[index] = await requestQuestionBatch(
        selectBatchContent(content, index, batchSizes.length),
        batchSizes[index],
        index,
        batchSizes.length
      );
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(QUIZ_BATCH_CONCURRENCY, batchSizes.length) },
    () => worker()
  ));
  const candidates = dedupeQuestions(validateQuestions(results.flat()));
  if (batchSizes.length < 2) return candidates.slice(0, count);
  const reviewed = await reviewDuplicatesWithinBudget(candidates, startedAt, count);
  return reviewed.slice(0, count);
}

function buildCandidateBatchSizes(candidateCount) {
  const minimumBatches = Math.ceil(candidateCount / QUIZ_MAX_BATCH_SIZE);
  const preferredBatches = Math.min(QUIZ_BATCH_CONCURRENCY, candidateCount);
  const batchCount = Math.max(minimumBatches, preferredBatches);
  const baseSize = Math.floor(candidateCount / batchCount);
  const largerBatches = candidateCount % batchCount;
  return Array.from({ length: batchCount }, (_, index) => baseSize + (index < largerBatches ? 1 : 0));
}

function questionDedupeKey(question) {
  const normalize = (value) => String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return normalize(question.q);
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return (questions || []).filter((question) => {
    const key = questionDedupeKey(question);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Extract complete JSON objects from streaming buffer ----
function extractCompleteObjects(buffer) {
  const objects = [];
  let searchFrom = 0;

  while (true) {
    const start = buffer.indexOf("{", searchFrom);
    if (start === -1) {
      return { objects, remaining: "" };
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < buffer.length; i++) {
      const c = buffer[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") depth--;
      if (depth === 0 && c === "}") {
        end = i;
        break;
      }
    }

    if (end === -1) {
      // Incomplete object — keep from this brace
      return { objects, remaining: buffer.slice(start) };
    }

    const objStr = buffer.slice(start, end + 1);
    try {
      const obj = JSON.parse(objStr);
      objects.push(obj);
    } catch (_) {}

    searchFrom = end + 1;
  }
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

export {
  MAX_INPUT_CHARS,
  QUIZ_GENERATE_TARGET_MS,
  buildPrompt,
  buildDedupeReviewPrompt,
  dedupeQuestions,
  generateFastQuestions,
  selectBatchContent,
  buildCandidateBatchSizes,
  applyDuplicateGroups,
};
