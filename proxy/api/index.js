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

    // POST /llm → generate quiz questions
    if (url.pathname === "/llm" && req.method === "POST") {
      return await handleLLM(req, res);
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
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuizMiao/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
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

// ---- LLM: generate quiz ----
async function handleLLM(req, res) {
  const t0 = Date.now();
  try {
    const body = await readBody(req);
    const { content, count } = body;
    if (!content) return json(res, { ok: false, error: "缺少内容" }, 400);

    const prompt = `你是一个专业的出题老师。请根据以下教学内容，生成 ${count || 10} 道 4选1 选择题。

教学内容：
${content.slice(0, 12000)}

输出 JSON 数组，格式：
[{"cat":"知识点分类","q":"题干（填空题用 ______ 表示空位）","options":["A","B","C","D"],"answer":0,"exp":"解析"}]

严格要求：
1. 题干绝对不能出现正确选项的任何字眼
2. 4个选项长度相近，干扰项有迷惑性
3. 答案下标均匀分布
4. 覆盖不同类型知识点
5. 只输出 JSON 数组，不要其他文字`;

    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_KEY,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.75,
        max_tokens: 8192,
        stream: false,
      }),
    });

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

    if (!Array.isArray(arr) || arr.length < 2) {
      return json(res, { ok: false, error: "题目数量不足" }, 502);
    }

    const valid = validateQuestions(arr);
    if (valid.length < 2) {
      return json(res, { ok: false, error: "有效题目不足" }, 502);
    }

    const shuffled = shuffleUntilBalanced(valid);
    return json(res, {
      ok: true,
      questions: shuffled,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
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
            model: "deepseek-chat",
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
function validateQuestions(arr) {
  const valid = [];
  for (const q of arr) {
    if (
      !q.cat ||
      !q.q ||
      !Array.isArray(q.options) ||
      q.options.length !== 4 ||
      typeof q.answer !== "number" ||
      !q.exp
    )
      continue;
    if (q.answer < 0 || q.answer > 3) continue;

    const opts = q.options.map((o) => String(o).trim());
    if (new Set(opts).size !== 4 || opts.some((o) => !o)) continue;

    const ansText = opts[q.answer].toLowerCase();
    const qText = q.q.toLowerCase();
    const ansWords = ansText.split(/[\s,\.!\?，。！？、]+/).filter((w) => w.length >= 2);
    if (ansWords.some((w) => qText.includes(w))) continue;

    const lens = opts.map((o) => o.length);
    if (Math.max(...lens) / Math.min(...lens) > 3.5) continue;

    valid.push({ cat: q.cat, q: q.q, options: opts, answer: q.answer, exp: q.exp });
  }
  return valid;
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
