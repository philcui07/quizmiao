const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const API_HOST = 'vercelapi.philcui.top';
const API_BASE = 'https://' + API_HOST;

exports.main = async (event, context) => {
  const { action, content, count, url, shareId, questions, tags } = event;

  try {
    // AI 出题（流式消费，收集全部后返回）
    if (action === 'llm') {
      return await handleLLMStream(content, count);
    }

    // 网页抓取
    if (action === 'fetch') {
      return await handleFetch(url);
    }

    // 保存题目到云数据库（用于分享）
    if (action === 'saveQuiz') {
      return await handleSaveQuiz(questions, tags);
    }

    // 从云数据库获取题目（用于分享打开）
    if (action === 'getQuiz') {
      return await handleGetQuiz(shareId);
    }

    return { ok: false, error: 'Unknown action: ' + action };
  } catch (e) {
    console.error('proxy error:', e.message);
    return { ok: false, error: e.message || '云函数请求失败' };
  }
};

/**
 * 流式消费 Vercel /llm-stream 端点
 * 边收边解析，收集全部题目后一次性返回
 * 优势：不会因为 Vercel maxDuration 导致 502，能处理大题目数
 */
function handleLLMStream(content, count) {
  return new Promise((resolve) => {
    const n = count || 10;
    const postData = JSON.stringify({ content, count: n });
    
    const options = {
      hostname: API_HOST,
      port: 443,
      path: '/llm-stream',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'text/event-stream'
      },
      timeout: 120000
    };

    const questions = [];
    let buffer = '';
    const startTime = Date.now();

    const req = https.request(options, (resp) => {
      resp.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留不完整行
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;
          
          try {
            const data = JSON.parse(jsonStr);
            if (data.type === 'question' && data.question) {
              questions.push(data.question);
            } else if (data.type === 'done') {
              // 正常完成
            } else if (data.type === 'error') {
              console.error('LLM stream error:', data.error);
            }
          } catch (_) {
            // 跳过无法解析的行
          }
        }
      });

      resp.on('end', () => {
        const elapsed = Date.now() - startTime;
        console.log(`[proxy] llm-stream done: ${questions.length} questions in ${elapsed}ms`);
        
        if (questions.length < 1) {
          // Fallback to non-streaming
          fallbackNonStream(content, count, resolve);
        } else {
          // Extract category tags
          const cats = [...new Set(questions.map(q => q.cat))];
          resolve({
            ok: true,
            questions,
            cats,
            count: questions.length,
            elapsed_ms: elapsed
          });
        }
      });

      resp.on('error', (err) => {
        console.error('LLM stream response error:', err.message);
        fallbackNonStream(content, count, resolve);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('[proxy] llm-stream timeout');
      if (questions.length > 0) {
        resolve({
          ok: true,
          questions,
          cats: [...new Set(questions.map(q => q.cat))],
          count: questions.length,
          elapsed_ms: Date.now() - startTime
        });
      } else {
        resolve({ ok: false, error: 'AI 出题超时，请减少题数后重试' });
      }
    });

    req.on('error', (err) => {
      console.error('LLM stream request error:', err.message);
      fallbackNonStream(content, count, resolve);
    });

    req.write(postData);
    req.end();

    // 兜底超时：60秒
    setTimeout(() => {
      if (questions.length > 0) {
        resolve({
          ok: true,
          questions,
          cats: [...new Set(questions.map(q => q.cat))],
          count: questions.length,
          elapsed_ms: Date.now() - startTime
        });
      } else {
        req.destroy();
      }
    }, 60000);
  });
}

/**
 * 非流式兜底（仅在流式失败时使用）
 */
async function fallbackNonStream(content, count, resolve) {
  try {
    const https = require('https');
    const postData = JSON.stringify({ content, count: count || 10 });
    
    const options = {
      hostname: API_HOST,
      port: 443,
      path: '/llm',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 120000
    };

    const req = https.request(options, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data);
        } catch (e) {
          resolve({ ok: false, error: '解析失败' });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, error: '请求失败' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    req.write(postData);
    req.end();
  } catch (e) {
    resolve({ ok: false, error: e.message });
  }
}

/**
 * 网页抓取
 */
function handleFetch(url) {
  return new Promise((resolve) => {
    const encodedUrl = encodeURIComponent(url);
    const options = {
      hostname: API_HOST,
      port: 443,
      path: '/api?url=' + encodedUrl,
      method: 'GET',
      timeout: 15000
    };

    const req = https.request(options, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, error: '解析失败' });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    req.end();
  });
}

/**
 * 保存题目到云数据库（用于分享）
 */
async function handleSaveQuiz(questions, tags) {
  const db = cloud.database();
  const result = await db.collection('shared_quizzes').add({
    data: {
      questions: questions,
      tags: tags || [],
      createdAt: db.serverDate()
    }
  });
  return { ok: true, shareId: result._id };
}

/**
 * 从云数据库获取题目（分享打开时）
 */
async function handleGetQuiz(shareId) {
  const db = cloud.database();
  try {
    const result = await db.collection('shared_quizzes').doc(shareId).get();
    if (result.data) {
      return {
        ok: true,
        questions: result.data.questions,
        tags: result.data.tags || []
      };
    }
    return { ok: false, error: '题目不存在或已被删除' };
  } catch (e) {
    return { ok: false, error: '获取分享题目失败: ' + e.message };
  }
}
