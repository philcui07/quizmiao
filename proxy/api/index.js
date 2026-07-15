// Vercel Serverless Function — 出题喵喵后端代理
// 标准 Node.js (req, res) 模式
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

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

// ---- Share page (SEO meta for crawlers) ----
function handleShare(encodedData, isCrawler, requestUrl, res) {
  const mainUrl = `https://philcui07.github.io/quizmiao/#q=${encodedData}`;

  if (!isCrawler) {
    res.setHeader("Location", mainUrl);
    return res.status(302).end();
  }

  let previewTitle = "出题喵喵 · AI出题练习";
  let previewDesc = "有人分享了一组练习题给你，点击打开做题！";
  try {
    const estimatedBytes = Math.floor((encodedData.length * 3) / 4);
    const estimatedQuestions = Math.floor(estimatedBytes / 60);
    if (estimatedQuestions > 0 && estimatedQuestions <= 99) {
      previewTitle = `出题喵喵 · ${estimatedQuestions}道练习题`;
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
<meta property="og:site_name" content="出题喵喵">
<meta http-equiv="refresh" content="0;url=${mainUrl}">
</head>
<body>
<p>正在跳转到出题喵喵...</p>
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

    const n = count || 10;
    const prompt = buildPrompt(content, n);

    const t1 = Date.now();
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_KEY,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
        max_tokens: 8192,
        stream: false,
      }),
    });
    const t2 = Date.now();
    console.log(`[LLM] API call took ${t2 - t1}ms`);

    if (!resp.ok) {
      return json(res, { ok: false, error: `API ${resp.status}` }, 502);
    }

    const data = await resp.json();
    let text = data.choices?.[0]?.message?.content || "";
    text = text.replace(/```json|```/g, "").trim();

    const s = text.indexOf("["),
      e = text.lastIndexOf("]");
    if (s >= 0 && e > s) text = text.slice(s, e + 1);

    let arr;
    try {
      arr = JSON.parse(text);
    } catch (_) {
      return json(res, { ok: false, error: "JSON 解析失败" }, 502);
    }

    if (!Array.isArray(arr) || arr.length < 1) {
      return json(res, { ok: false, error: "题目数量不足" }, 502);
    }

    const valid = validateQuestions(arr);
    if (valid.length < 1) {
      return json(res, { ok: false, error: "有效题目不足" }, 502);
    }

    const shuffled = shuffleUntilBalanced(valid);
    const t3 = Date.now();
    console.log(`[LLM] parse+validate took ${t3 - t2}ms, total ${t3 - t0}ms`);
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
  // SSE headers
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

  const n = count || 10;
  const prompt = buildPrompt(content, n);

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_KEY,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
        max_tokens: 8192,
        stream: true,
      }),
    });

    if (!resp.ok) {
      res.write(`data: ${JSON.stringify({ type: "error", error: `API ${resp.status}` })}\n\n`);
      return res.end();
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let contentBuffer = "";
    let sentCount = 0;

    // Send start event
    res.write(`data: ${JSON.stringify({ type: "start", count: n })}\n\n`);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) contentBuffer += delta;
        } catch (_) {}

        // Try to extract complete JSON objects
        const result = extractCompleteObjects(contentBuffer);
        for (const q of result.objects) {
          const valid = validateQuestion(q);
          if (valid) {
            sentCount++;
            res.write(
              `data: ${JSON.stringify({ type: "question", question: valid, index: sentCount })}\n\n`
            );
          }
        }
        contentBuffer = result.remaining;
      }
    }

    // Process any remaining content
    const finalResult = extractCompleteObjects(contentBuffer);
    for (const q of finalResult.objects) {
      const valid = validateQuestion(q);
      if (valid) {
        sentCount++;
        res.write(
          `data: ${JSON.stringify({ type: "question", question: valid, index: sentCount })}\n\n`
        );
      }
    }

    // Send done event
    res.write(`data: ${JSON.stringify({ type: "done", count: sentCount })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
    res.end();
  }
}

// ---- Build prompt ----
function buildPrompt(content, n) {
  return `你是专业出题老师。根据以下内容出${n}道四选一选择题。

内容：
${content.slice(0, 8000)}

输出JSON数组：[{"cat":"分类","q":"题干","options":["A","B","C","D"],"answer":0,"exp":"解析"}]

要求：
1.先答对再出题：每题答案必须100%正确，题干不含答案字眼
2.选项长度相近，干扰项有迷惑性
3.answer下标0-3均匀分布
4.覆盖不同知识点
5.只输出JSON`;
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
