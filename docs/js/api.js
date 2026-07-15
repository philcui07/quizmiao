/**
 * 出题喵喵 QuizMiao — API 网络请求模块
 * 对应小程序 wx.request 封装
 *
 * 部署后请将 WORKER_URL 改为你的 Vercel 代理地址
 * 例如: https://你的项目名.vercel.app
 */

const WORKER_URL = 'https://vercelapi.philcui.top';
const FETCH_TIMEOUT = 15000;   // 网页抓取：15 秒
const LLM_TIMEOUT = 60000;     // AI 出题：60 秒（优化后无需验证步骤）

/**
 * HTTP 请求封装（对应小程序 wxRequest）
 */
async function httpRequest(url, method = 'GET', data = null, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    };
    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }
    const resp = await fetch(url, options);
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
    }
    return await resp.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw new Error(e.message || '网络错误');
  }
}

/**
 * 网页内容抓取
 */
async function fetchPageContent(targetUrl) {
  const resp = await httpRequest(
    `${WORKER_URL}/?url=${encodeURIComponent(targetUrl)}`,
    'GET', null, FETCH_TIMEOUT
  );
  return resp;
}

/**
 * AI 出题（非流式，用于小程序云函数代理）
 */
async function generateQuestions(content, count) {
  const resp = await httpRequest(
    `${WORKER_URL}/llm`, 'POST',
    { content, count },
    LLM_TIMEOUT
  );
  return resp;
}

/**
 * AI 出题（SSE 流式传输）
 * @param {string} content - 出题内容
 * @param {number} count - 题目数量
 * @param {object} callbacks - { onStart, onQuestion, onDone, onError }
 * @returns {AbortController} 用于取消请求
 */
function streamGenerateQuestions(content, count, { onStart, onQuestion, onDone, onError }) {
  const controller = new AbortController();

  (async () => {
    try {
      const resp = await fetch(`${WORKER_URL}/llm-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, count }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const questions = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'start' && onStart) {
              onStart(event.count);
            } else if (event.type === 'question' && onQuestion) {
              questions.push(event.question);
              onQuestion(event.question, questions.length);
            } else if (event.type === 'done') {
              if (onDone) onDone(questions);
            } else if (event.type === 'error') {
              if (onError) onError(event.error);
              return;
            }
          } catch (_) {}
        }
      }

      // Stream ended without explicit done event
      if (onDone && questions.length > 0) onDone(questions);
      else if (onDone && questions.length === 0) onError && onError('未生成任何题目');
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (onError) onError(e.message || '网络错误');
    }
  })();

  return controller;
}

/**
 * 题目验证
 */
async function verifyQuestions(questions) {
  const resp = await httpRequest(
    `${WORKER_URL}/verify`, 'POST',
    { questions },
    LLM_TIMEOUT
  );
  return resp;
}
