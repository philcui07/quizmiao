// 拾知猫 — AI 出题云函数 (CloudBase)
// 替代 Vercel proxy/api/index.js 中的 handleLLM + handleVerify

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

exports.main = async (event, context) => {
  const { action } = event;

  switch (action) {
    case "generate":
      return await generate(event);
    case "verify":
      return await verify(event);
    default:
      return { ok: false, error: "未知 action: " + action };
  }
};

// ---- AI 出题 ----
async function generate(event) {
  const t0 = Date.now();
  const content = String(event.content || '').trim().slice(0, 50000);
  if (content.length < 20) return { ok: false, error: "内容至少需要 20 个字符" };
  if (!DEEPSEEK_KEY) return { ok: false, error: "服务尚未配置 DeepSeek API Key" };

  const n = Math.max(5, Math.min(Number(event.count) || 10, 50));
  const prompt = buildPrompt(content, n);

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_KEY,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
        max_tokens: Math.min(8192, Math.max(2048, n * 300)),
        stream: false,
      }),
    });

    if (!resp.ok) {
      return { ok: false, error: `DeepSeek API ${resp.status}` };
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
      return { ok: false, error: "JSON 解析失败" };
    }

    if (!Array.isArray(arr) || arr.length < 1) {
      return { ok: false, error: "题目数量不足" };
    }

    const valid = validateQuestions(arr);
    if (valid.length < 1) {
      return { ok: false, error: "有效题目不足" };
    }

    const shuffled = shuffleUntilBalanced(valid);
    const t1 = Date.now();
    return {
      ok: true,
      questions: shuffled,
      elapsed_ms: t1 - t0,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
