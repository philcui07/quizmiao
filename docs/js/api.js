/**
 * 拾知猫 v1.1.0 — API 网络请求模块
 * 基于 CloudBase 云函数，替代 v1.0.1 的 Vercel 代理
 *
 * 变更说明：
 * - 出题改为非流式（CloudBase 云函数不支持 SSE）
 * - 网页抓取改为云函数调用
 * - 分享相关操作移至 CB 模块
 */

const LLM_TIMEOUT = 60000;

/**
 * HTTP 请求封装（保留用于第三方 API 如二维码生成）
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
 * 网页内容抓取（CloudBase 云函数）
 */
async function fetchPageContent(targetUrl) {
  return await CB.fetchPage(targetUrl);
}

/**
 * AI 出题（CloudBase 云函数，非流式）
 */
async function generateQuestions(content, count) {
  return await CB.generateQuestions(content, count);
}

/**
 * AI 出题（模拟流式接口，兼容 v1.0.1 前端调用）
 * 实际为非流式调用，通过分批渲染模拟流式效果
 * @returns {AbortController} 用于取消（模拟）
 */
function streamGenerateQuestions(content, count, { onStart, onQuestion, onDone, onError }) {
  let cancelled = false;
  const controller = new AbortController();

  (async () => {
    try {
      if (onStart) onStart(count);

      const resp = await CB.generateQuestions(content, count);

      if (cancelled) return;

      if (!resp || !resp.ok || !resp.questions || resp.questions.length === 0) {
        throw new Error(resp?.error || 'AI 未生成有效题目');
      }

      // 模拟流式：逐题发送，间隔 200ms
      const questions = resp.questions;
      for (let i = 0; i < questions.length; i++) {
        if (cancelled) return;
        await new Promise(r => setTimeout(r, 150));
        if (onQuestion) onQuestion(questions[i], i + 1);
      }

      if (cancelled) return;
      if (onDone) onDone(questions);
    } catch (e) {
      if (cancelled) return;
      if (onError) onError(e.message || '网络错误');
    }
  })();

  // 返回一个模拟的 controller
  return {
    abort() {
      cancelled = true;
    }
  };
}

/**
 * 题目验证（CloudBase 云函数）
 */
async function verifyQuestions(questions) {
  return await CB.callFunction('quiz-generate', {
    action: 'verify',
    questions,
  });
}
