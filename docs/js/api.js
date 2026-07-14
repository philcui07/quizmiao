/**
 * 出题喵喵 QuizMiao — API 网络请求模块
 * 对应小程序 wx.request 封装
 * 
 * 部署后请将 WORKER_URL 改为你的 Vercel 代理地址
 * 例如: https://你的项目名.vercel.app
 */

const WORKER_URL = 'https://quizmiao.vercel.app';
const FETCH_TIMEOUT = 15000;   // 网页抓取：15 秒
const LLM_TIMEOUT = 120000;    // AI 出题 / 验证：120 秒

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
 * AI 出题
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
