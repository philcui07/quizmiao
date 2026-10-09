const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const API_HOST = 'vercelapi.philcui.top';
const API_BASE = 'https://' + API_HOST;
const LLM_CANDIDATE_RATIO = 1.5;
// Long prompts are divided into small, non-overlapping knowledge sections.
// Asking for only 1-2 questions per model call is materially more reliable than
// asking one call for 3+ questions: the production model sometimes ends a batch
// early and is also more likely to repeat a knowledge point inside a large batch.
const LLM_BATCH_CONCURRENCY = 8;
const LLM_MAX_INPUT_CHARS = 16000;

exports.main = async (event, context) => {
  const { action, content, count, url, shareId, questions, tags } = event;
  const wxContext = cloud.getWXContext ? cloud.getWXContext() : {};
  const openid = wxContext.OPENID || '';
  const accountPhone = normalizePhone(event.accountPhone);

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
      return await handleSaveQuiz(event, accountPhone);
    }

    // 从云数据库获取题目（用于分享打开）
    if (action === 'getQuiz') {
      return await handleGetQuiz(shareId);
    }

    if (action === 'profileLogin') return await handleProfileLogin(event);
    if (action === 'profileGet') return await handleProfileGet(accountPhone);
    if (action === 'profileUpdateNickname') return await handleProfileUpdate(event, accountPhone);
    if (action === 'historyCreate') return await handleHistoryCreate(event, accountPhone);
    if (action === 'historyUpdate') return await handleHistoryUpdate(event, accountPhone);
    if (action === 'historyAttemptAdd') return await handleHistoryAttemptAdd(event, accountPhone);
    if (action === 'historyOverview') return await handleHistoryOverview(event, accountPhone);
    if (action === 'historyList') return await handleHistoryList(event, accountPhone);
    if (action === 'historyDetail') return await handleHistoryDetail(event, accountPhone);
    if (action === 'recordDetail') return await handleRecordDetail(event, accountPhone);
    if (action === 'shareList') return await handleShareList(event, accountPhone);
    if (action === 'shareMark') return await handleShareMark(event, accountPhone);
    if (action === 'shareResults') return await handleShareResults(event, accountPhone);
    if (action === 'shareResultSave') return await handleShareResultSave(event, accountPhone);

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
async function handleLLMStream(content, count) {
  const startedAt = Date.now();
  const targetCount = Math.max(1, Math.min(Number(count) || 10, 20));
  const candidateCount = Math.ceil(targetCount * LLM_CANDIDATE_RATIO);
  const batchSizes = buildLLMBatchSizes(candidateCount);
  const sections = splitLLMContent(content, batchSizes.length);
  const results = await Promise.all(batchSizes.map((batchSize, index) =>
    requestLLMStreamBatch(sections[index], batchSize)
      .catch(error => ({ ok: false, error: error.message || 'AI 出题失败', questions: [] }))
  ));
  const questions = mergeLLMQuestions(results, targetCount);
  if (questions.length < 1) {
    const firstError = results.find(result => result && result.error);
    return { ok: false, error: firstError?.error || 'AI 未生成有效题目' };
  }
  const cats = [...new Set(questions.map(question => question.cat))];
  console.log(`[proxy] llm merged: requested=${targetCount}, candidates=${candidateCount}, returned=${questions.length}, elapsed=${Date.now() - startedAt}ms`);
  return {
    ok: true,
    questions,
    cats,
    count: questions.length,
    elapsed_ms: Date.now() - startedAt
  };
}

function buildLLMBatchSizes(candidateCount) {
  const batchCount = Math.min(LLM_BATCH_CONCURRENCY, candidateCount);
  const baseSize = Math.floor(candidateCount / batchCount);
  const largerBatches = candidateCount % batchCount;
  return Array.from({ length: batchCount }, (_, index) => baseSize + (index < largerBatches ? 1 : 0));
}

function splitLLMContent(content, batchCount) {
  const text = String(content || '').slice(0, LLM_MAX_INPUT_CHARS);
  const matches = [...text.matchAll(/^\s*\d+\.\s+\S.*$/gm)];
  if (matches.length >= batchCount) {
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
      sections.push(blocks.slice(cursor, cursor + size).join('\n\n'));
      cursor += size;
    }
    return sections;
  }
  return Array.from({ length: batchCount }, (_, index) => {
    const start = Math.floor(text.length * index / batchCount);
    const end = Math.floor(text.length * (index + 1) / batchCount);
    return text.slice(start, end).trim();
  });
}

function mergeLLMQuestions(results, targetCount) {
  const seen = new Set();
  const questions = [];
  for (const result of results || []) {
    for (const question of result?.questions || []) {
      const key = String(question.q || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      questions.push(question);
      if (questions.length >= targetCount) return questions;
    }
  }
  return questions;
}

function requestLLMStreamBatch(content, count) {
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
    let receivedStart = false;
    let streamError = '';
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
            if (data.type === 'start') {
              receivedStart = true;
            }
            if (data.type === 'question' && data.question) {
              questions.push(data.question);
            } else if (data.type === 'done') {
              // 正常完成
            } else if (data.type === 'error') {
              streamError = data.error || 'AI 出题失败';
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
        
        if (questions.length < 1 && !receivedStart && !streamError) {
          // Only fallback when the SSE endpoint could not start at all.
          fallbackNonStream(content, count, resolve);
        } else if (questions.length < 1) {
          resolve({ ok: false, error: streamError || 'AI 未生成有效题目' });
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
        if (questions.length > 0) {
          resolve({
            ok: true,
            questions,
            cats: [...new Set(questions.map(q => q.cat))],
            count: questions.length,
            elapsed_ms: Date.now() - startTime
          });
        } else if (receivedStart || streamError) {
          resolve({ ok: false, error: streamError || 'AI 出题失败' });
        } else {
          fallbackNonStream(content, count, resolve);
        }
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
        resolve({ ok: false, error: streamError || 'AI 出题超时，请减少题数后重试' });
      }
    });

    req.on('error', (err) => {
      console.error('LLM stream request error:', err.message);
      if (questions.length > 0) {
        resolve({
          ok: true,
          questions,
          cats: [...new Set(questions.map(q => q.cat))],
          count: questions.length,
          elapsed_ms: Date.now() - startTime
        });
      } else {
        fallbackNonStream(content, count, resolve);
      }
    });

    req.write(postData);
    req.end();

    // 兜底超时：与云函数调用上限一致，避免重复请求长期占用实例。
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

exports.__test = {
  buildLLMBatchSizes,
  splitLLMContent,
  mergeLLMQuestions,
  normalizeSourceUrl,
  shouldUseReaderFirst,
  rewriteFetchUrl,
  shouldFallbackToReader,
  cleanReaderContent
};

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
async function handleFetch(rawUrl) {
  const url = normalizeSourceUrl(rawUrl);
  if (!url) return { ok: false, error: '请输入有效的 HTTP/HTTPS 网页链接' };
  const fetchUrl = rewriteFetchUrl(url);
  const directResult = await handleLegacyFetch(fetchUrl);
  if (directResult.ok) return Object.assign({}, directResult, { sourceUrl: url, mobileFallback: fetchUrl !== url });
  if (!shouldFallbackToReader(directResult)) return directResult;

  // The WeChat cloud network cannot reliably reach Reader directly. Route the
  // fallback through the already reachable product proxy instead.
  const readerResult = await handleLegacyFetch('https://r.jina.ai/' + url);
  if (readerResult.ok) {
    const text = cleanReaderContent(readerResult.text);
    if (text.length >= 20) {
      return { ok: true, text: text.slice(0, 50000), length: text.length, readerFallback: true, sourceUrl: url };
    }
  }
  return {
    ok: false,
    error: directResult.error || readerResult.error || '网页读取失败',
    hint: '该网站限制自动读取，请打开网页后复制正文，切换到“文本”出题。'
  };
}

function handleLegacyFetch(url) {
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

function normalizeSourceUrl(value) {
  let text = String(value || '').trim();
  const markdown = text.match(/^\s*\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)\s*[，。；、,;！!？?]*\s*$/i);
  if (markdown) text = markdown[1];
  if (/^<https?:\/\/[^>]+>$/i.test(text)) text = text.slice(1, -1).trim();
  text = text
    .replace(/[，。；、,;！!？?]+$/g, '')
    .replace(/(?:%EF%BC%8C|%E3%80%82|%2C|%3B|%EF%BC%81|%EF%BC%9F)+$/ig, '');
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if ((parsed.protocol === 'http:' && parsed.port && parsed.port !== '80') ||
        (parsed.protocol === 'https:' && parsed.port && parsed.port !== '443')) return '';
    if (isUnsafeHostname(parsed.hostname)) return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function isUnsafeHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (!net.isIP(host)) return false;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

function shouldUseReaderFirst(url) {
  return rewriteFetchUrl(url) !== url;
}

function rewriteFetchUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() === 'baike.baidu.com') {
      parsed.hostname = 'wapbaike.baidu.com';
    }
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function shouldFallbackToReader(result) {
  const error = String(result && result.error || '');
  return /HTTP\s*(401|403|406|409|429|451|503)|JS_RENDERED|解析失败/i.test(error);
}

function cleanReaderContent(value) {
  return String(value || '')
    .replace(/^Title:.*\n+/i, '')
    .replace(/^URL Source:.*\n+/i, '')
    .replace(/^Published Time:.*\n+/i, '')
    .replace(/^Markdown Content:\s*\n+/i, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 保存题目到云数据库（用于分享）
 */
async function handleSaveQuiz(event, openid) {
  const questions = sanitizeQuestions(event.questions);
  const tags = sanitizeTags(event.tags);
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: '没有可分享的题目' };
  }

  const db = cloud.database();
  if (event.trackOwner === true && openid) {
    try {
      const profile = await findProfile(openid);
      if (profile) {
        if (event.reuseExisting === true && event.historyId) {
          const existing = await queryOrEmpty(() => db.collection('shares').where({
            owner_openid: openid
          }).limit(100).get());
          const matched = sortNewest(existing.data || [])
            .find(item => item.history_id === cleanText(event.historyId, 128));
          if (matched) {
            await db.collection('shares').doc(matched._id).update({
              data: {
                name: cleanText(event.name, 80) || buildTitle(questions),
                questions,
                tags,
                updated_at: Date.now()
              }
            });
            return { ok: true, shareId: matched._id, tracked: true, reused: true };
          }
        }
        const now = Date.now();
        const shareData = {
          owner_openid: openid,
          history_id: cleanText(event.historyId, 128),
          name: cleanText(event.name, 80) || buildTitle(questions),
          questions,
          tags,
          result_count: 0,
          shared_at: null,
          expires_at: now + 24 * 60 * 60 * 1000,
          created_at: now,
          updated_at: now
        };
        const result = await addWithCollection(db, 'shares', shareData);
        return { ok: true, shareId: result._id, tracked: true };
      }
    } catch (e) {
      console.warn('save tracked share failed, fallback to legacy share:', e.message);
    }
  }

  try {
    const result = await db.collection('shared_quizzes').add({
      data: {
        questions: questions,
        tags: tags || [],
        createdAt: db.serverDate()
      }
    });
    return { ok: true, shareId: result._id };
  } catch (e) {
    // 新环境未创建数据库集合时，使用云存储保证分享仍然可用。
    console.warn('save quiz to database failed, fallback to cloud storage:', e.message);
    const fileName = crypto.randomBytes(12).toString('hex');
    const uploaded = await cloud.uploadFile({
      cloudPath: 'shared-quizzes/' + fileName + '.json',
      fileContent: Buffer.from(JSON.stringify({
        questions,
        tags: tags || [],
        createdAt: Date.now()
      }))
    });
    return { ok: true, shareId: 'file:' + uploaded.fileID };
  }
}

/**
 * 从云数据库获取题目（分享打开时）
 */
async function handleGetQuiz(shareId) {
  if (!shareId) return { ok: false, error: '缺少分享 ID' };

  if (shareId.indexOf('file:') === 0) {
    try {
      const result = await cloud.downloadFile({ fileID: shareId.slice(5) });
      const data = JSON.parse(result.fileContent.toString('utf8'));
      if (!Array.isArray(data.questions) || data.questions.length === 0) {
        return { ok: false, error: '分享题目为空' };
      }
      if (isShareExpired(data.createdAt)) return { ok: false, error: '分享已过期' };
      return { ok: true, questions: data.questions, tags: data.tags || [] };
    } catch (e) {
      return { ok: false, error: '获取分享题目失败: ' + e.message };
    }
  }

  const db = cloud.database();
  try {
    const tracked = firstDocument(await db.collection('shares').doc(shareId).get());
    if (tracked && Array.isArray(tracked.questions) && tracked.questions.length) {
      const expiresAt = Number(tracked.expires_at) || (Number(tracked.created_at) + 24 * 60 * 60 * 1000);
      if (expiresAt && Date.now() >= expiresAt) return { ok: false, error: '分享已过期' };
      return {
        ok: true,
        questions: tracked.questions,
        tags: tracked.tags || [],
        name: tracked.name || '',
        tracked: true
      };
    }
  } catch (_) {
    // Continue with v1.0.x share storage.
  }

  try {
    const result = await db.collection('shared_quizzes').doc(shareId).get();
    if (result.data) {
      if (isShareExpired(result.data.createdAt)) return { ok: false, error: '分享已过期' };
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

async function handleProfileLogin(event) {
  const phone = normalizePhone(event.accountPhone);
  if (!phone) return { ok: false, error: '请输入以 1 开头的 11 位手机号' };

  const db = cloud.database();
  const existing = await findProfile(phone);
  const registered = !existing;
  const now = Date.now();
  const data = {
    owner_openid: phone,
    phone,
    country_code: '86',
    nickname: existing ? cleanText(existing.nickname, 20) : '',
    phone_verified: false,
    created_at: existing && existing.created_at ? existing.created_at : now,
    updated_at: now
  };
  await setWithCollection(db, 'users', userDocId(phone), data);
  return { ok: true, profile: publicProfile(data), registered };
}

async function handleProfileGet(openid) {
  if (!openid) return { ok: false, error: '无法识别当前微信用户' };
  const profile = await findProfile(openid);
  return profile
    ? { ok: true, profile: publicProfile(profile) }
    : { ok: false, error: '请先使用微信手机号登录' };
}

async function handleProfileUpdate(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const nickname = cleanText(event.nickname, 20);
  if (!nickname) return { ok: false, error: '昵称不能为空' };
  const db = cloud.database();
  await db.collection('users').doc(userDocId(openid)).update({
    data: { nickname, updated_at: Date.now() }
  });
  return { ok: true, profile: publicProfile(Object.assign({}, profile.data, { nickname })) };
}

async function handleHistoryCreate(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const questions = sanitizeQuestions(event.questions);
  if (!questions.length) return { ok: false, error: '缺少有效题目' };
  const now = Date.now();
  const db = cloud.database();
  const result = await addWithCollection(db, 'quiz_history', {
    owner_openid: openid,
    title: cleanText(event.title, 80) || buildTitle(questions),
    questions,
    practice_count: 0,
    last_attempt: null,
    created_at: now,
    updated_at: now
  });
  return { ok: true, id: result._id };
}

async function handleHistoryUpdate(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const history = await getOwnedHistory(event.id, openid);
  if (!history.ok) return history;
  const questions = sanitizeQuestions(event.questions);
  if (!questions.length) return { ok: false, error: '题目不能为空' };
  await cloud.database().collection('quiz_history').doc(event.id).update({
    data: { questions, title: cleanText(event.title, 80) || history.data.title, updated_at: Date.now() }
  });
  return { ok: true };
}

async function handleHistoryAttemptAdd(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const history = await getOwnedHistory(event.historyId, openid);
  if (!history.ok) return history;
  const attemptId = cleanText(event.attemptId, 128);
  if (!attemptId) return { ok: false, error: '缺少练习轮次 ID' };
  const db = cloud.database();
  const existing = await queryOrEmpty(() => db.collection('quiz_attempts').where({
    owner_openid: openid
  }).limit(100).get());
  const duplicate = (existing.data || []).find(item => item.attempt_id === attemptId);
  if (duplicate) {
    return { ok: true, id: duplicate._id, duplicate: true };
  }
  const total = clampNumber(event.total, 0, history.data.questions.length);
  const score = clampNumber(event.score, 0, total);
  const wrongAnswers = sanitizeWrongAnswers(event.wrongAnswers, total);
  const now = Date.now();
  const result = await addWithCollection(db, 'quiz_attempts', {
    owner_openid: openid,
    history_id: event.historyId,
    attempt_id: attemptId,
    score,
    total,
    wrong_answers: wrongAnswers,
    created_at: now
  });
  await db.collection('quiz_history').doc(event.historyId).update({
    data: {
      practice_count: db.command.inc(1),
      last_attempt: {
        id: result._id,
        score,
        total,
        wrong_count: wrongAnswers.length,
        created_at: now
      },
      updated_at: now
    }
  });
  return { ok: true, id: result._id };
}

async function handleHistoryList(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const pageSize = clampNumber(event.pageSize || 50, 1, 50);
  const [result, attemptsResult] = await Promise.all([
    queryOrEmpty(() => cloud.database().collection('quiz_history')
      .where({ owner_openid: openid })
      .limit(100)
      .get()),
    queryOrEmpty(() => cloud.database().collection('quiz_attempts')
      .where({ owner_openid: openid })
      .limit(100)
      .get())
  ]);
  const attemptsByHistory = {};
  (attemptsResult.data || []).forEach(attempt => {
    const id = attempt.history_id;
    if (!id) return;
    if (!attemptsByHistory[id]) attemptsByHistory[id] = [];
    attemptsByHistory[id].push(attempt);
  });
  return {
    ok: true,
    list: sortNewest(result.data || []).slice(0, pageSize).map(item => {
      const attempts = sortNewest(attemptsByHistory[item._id] || []);
      const latest = attempts[0];
      return {
        id: item._id,
        title: item.title,
        questionCount: Array.isArray(item.questions) ? item.questions.length : 0,
        practiceCount: attempts.length,
        lastAttempt: latest ? {
          id: latest._id,
          score: latest.score,
          total: latest.total,
          wrong_count: (latest.wrong_answers || []).length,
          created_at: latest.created_at
        } : null,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      };
    })
  };
}

async function handleHistoryOverview(event, openid) {
  const [quizzes, shares] = await Promise.all([
    handleHistoryList(event, openid),
    handleShareList(event, openid)
  ]);
  if (!quizzes.ok || !shares.ok) {
    return { ok: false, error: quizzes.error || shares.error || '加载历史记录失败' };
  }
  return { ok: true, quizzes: quizzes.list || [], shares: shares.list || [] };
}

async function handleHistoryDetail(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const history = await getOwnedHistory(event.id, openid);
  if (!history.ok) return history;
  let attempts = { data: [] };
  try {
    attempts = await cloud.database().collection('quiz_attempts')
      .where({ owner_openid: openid })
      .limit(100)
      .get();
  } catch (_) {
    // A new account has no attempt collection yet.
  }
  const item = history.data;
  const ownedAttempts = sortNewest((attempts.data || []).filter(attempt => attempt.history_id === event.id));
  return {
    ok: true,
    history: {
      id: item._id,
      title: item.title,
      questions: item.questions || [],
      practiceCount: ownedAttempts.length,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      attempts: ownedAttempts.map(attempt => ({
        id: attempt._id,
        score: attempt.score,
        total: attempt.total,
        wrongCount: (attempt.wrong_answers || []).length,
        createdAt: attempt.created_at
      }))
    }
  };
}

async function handleShareList(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const [result, results] = await Promise.all([
    queryOrEmpty(() => cloud.database().collection('shares')
      .where({ owner_openid: openid })
      .limit(100)
      .get()),
    queryOrEmpty(() => cloud.database().collection('share_results')
      .where({ owner_openid: openid })
      .limit(100)
      .get())
  ]);
  const counts = {};
  (results.data || []).forEach(item => {
    if (item.share_id) counts[item.share_id] = (counts[item.share_id] || 0) + 1;
  });
  const pageSize = clampNumber(event.pageSize || 50, 1, 50);
  return {
    ok: true,
    list: sortNewest((result.data || []).filter(item => item.shared_at)).slice(0, pageSize).map(item => ({
      id: item._id,
      name: item.name,
      questionCount: Array.isArray(item.questions) ? item.questions.length : 0,
      resultCount: counts[item._id] || 0,
      createdAt: item.created_at,
      expiresAt: Number(item.expires_at) || (Number(item.created_at) + 24 * 60 * 60 * 1000)
    }))
  };
}

async function handleShareMark(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const shareId = cleanText(event.shareId, 128);
  const db = cloud.database();
  const share = await getDocument(db.collection('shares').doc(shareId));
  if (!share || share.owner_openid !== openid) return { ok: false, error: '分享不存在或无权操作' };
  const now = Date.now();
  await db.collection('shares').doc(shareId).update({
    data: { shared_at: share.shared_at || now, updated_at: now }
  });
  return { ok: true, sharedAt: share.shared_at || now };
}

async function handleShareResults(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const shareId = cleanText(event.shareId, 128);
  const db = cloud.database();
  const share = await getDocument(db.collection('shares').doc(shareId));
  if (!share || share.owner_openid !== openid) return { ok: false, error: '分享不存在或无权查看' };
  let results = { data: [] };
  try {
    results = await db.collection('share_results')
      .where({ owner_openid: openid })
      .limit(100)
      .get();
  } catch (_) {
    // A share has no result collection until the first friend finishes.
  }
  return {
    ok: true,
    share: {
      id: share._id,
      name: share.name,
      questions: share.questions || [],
      createdAt: share.created_at,
      expiresAt: Number(share.expires_at) || (Number(share.created_at) + 24 * 60 * 60 * 1000)
    },
    results: sortNewest((results.data || []).filter(item => item.share_id === shareId)).map(item => ({
      id: item._id,
      participant: item.participant || '微信用户',
      score: item.score,
      total: item.total,
      wrongCount: (item.wrong_answers || []).length,
      createdAt: item.created_at
    }))
  };
}

async function handleRecordDetail(event, openid) {
  const profile = await requireProfile(openid);
  if (!profile.ok) return profile;
  const id = cleanText(event.id, 128);
  const type = event.type === 'share' ? 'share' : 'quiz';
  const collection = type === 'share' ? 'share_results' : 'quiz_attempts';
  const item = await getDocument(cloud.database().collection(collection).doc(id));
  if (!item || item.owner_openid !== openid) return { ok: false, error: '记录不存在或无权查看' };
  return {
    ok: true,
    record: {
      id: item._id,
      participant: type === 'share' ? (item.participant || '微信用户') : '',
      score: item.score,
      total: item.total,
      wrongAnswers: item.wrong_answers || [],
      createdAt: item.created_at
    }
  };
}

async function handleShareResultSave(event, participantOpenid) {
  const shareId = cleanText(event.shareId, 128);
  const attemptId = cleanText(event.attemptId, 128);
  if (!shareId || !attemptId) return { ok: false, error: '缺少分享或练习轮次 ID' };
  const db = cloud.database();
  const share = await getDocument(db.collection('shares').doc(shareId));
  if (!share) return { ok: false, error: '分享不存在' };
  const expiresAt = Number(share.expires_at) || (Number(share.created_at) + 24 * 60 * 60 * 1000);
  if (expiresAt && Date.now() >= expiresAt) return { ok: false, error: '分享已过期' };
  if (!share.owner_openid) return { ok: true, untracked: true };
  const existing = await queryOrEmpty(() => db.collection('share_results').where({
    owner_openid: share.owner_openid
  }).limit(100).get());
  if ((existing.data || []).some(item => item.share_id === shareId && item.attempt_id === attemptId)) {
    return { ok: true, duplicate: true };
  }

  const total = clampNumber(event.total, 0, Array.isArray(share.questions) ? share.questions.length : 100);
  const score = clampNumber(event.score, 0, total);
  const participantProfile = participantOpenid ? await findProfile(participantOpenid) : null;
  const submittedName = cleanText(event.participantName, 20);
  const participant = submittedName || (participantProfile
    ? cleanText(participantProfile.nickname, 20) || maskPhone(participantProfile.phone)
    : '匿名用户');
  const result = await addWithCollection(db, 'share_results', {
    share_id: shareId,
    owner_openid: share.owner_openid,
    participant_openid: participantProfile ? participantOpenid : '',
    participant,
    attempt_id: attemptId,
    score,
    total,
    wrong_answers: sanitizeWrongAnswers(event.wrongAnswers, total),
    created_at: Date.now()
  });
  await db.collection('shares').doc(shareId).update({
    data: { result_count: db.command.inc(1), updated_at: Date.now() }
  });
  return { ok: true, id: result._id };
}

async function findProfile(openid) {
  if (!openid) return null;
  return await getDocument(cloud.database().collection('users').doc(userDocId(openid)));
}

async function requireProfile(openid) {
  if (!openid) return { ok: false, error: '请先输入手机号登录' };
  const profile = await findProfile(openid);
  return profile ? { ok: true, data: profile } : { ok: false, error: '请先使用微信手机号登录' };
}

async function getOwnedHistory(id, openid) {
  const cleanId = cleanText(id, 128);
  if (!cleanId) return { ok: false, error: '缺少题集 ID' };
  const item = await getDocument(cloud.database().collection('quiz_history').doc(cleanId));
  if (!item) return { ok: false, error: '记录不存在' };
  if (item.owner_openid !== openid) return { ok: false, error: '无权查看' };
  return { ok: true, data: item };
}

async function getDocument(reference) {
  try {
    return firstDocument(await reference.get());
  } catch (_) {
    return null;
  }
}

async function queryOrEmpty(query) {
  try {
    return await query();
  } catch (error) {
    if (isMissingCollection(error)) return { data: [] };
    throw error;
  }
}

async function addWithCollection(db, name, data) {
  try {
    return await db.collection(name).add({ data });
  } catch (error) {
    if (!isMissingCollection(error) || typeof db.createCollection !== 'function') throw error;
    await createCollectionIfMissing(db, name);
    return await db.collection(name).add({ data });
  }
}

async function setWithCollection(db, name, id, data) {
  try {
    return await db.collection(name).doc(id).set({ data });
  } catch (error) {
    if (!isMissingCollection(error) || typeof db.createCollection !== 'function') throw error;
    await createCollectionIfMissing(db, name);
    return await db.collection(name).doc(id).set({ data });
  }
}

async function createCollectionIfMissing(db, name) {
  try {
    await db.createCollection(name);
  } catch (error) {
    if (!/exist|已存在|ResourceInUse/i.test(error && error.message)) throw error;
  }
}

function isMissingCollection(error) {
  return /collection.*(not found|does not exist)|集合.*(不存在|未创建)|DATABASE_COLLECTION_NOT_EXIST/i.test(error && error.message);
}

function firstDocument(result) {
  const data = result && result.data;
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

function publicProfile(profile) {
  return {
    phone: cleanText(profile.phone, 20),
    nickname: cleanText(profile.nickname, 20),
    phoneVerified: profile.phone_verified === true
  };
}

function userDocId(openid) {
  return 'wx_' + crypto.createHash('sha256').update(openid).digest('hex').slice(0, 40);
}

function normalizePhone(value) {
  const phone = cleanText(value, 20);
  return /^1\d{10}$/.test(phone) ? phone : '';
}

function buildTitle(questions) {
  const categories = [...new Set(questions.map(item => item.cat).filter(Boolean))].slice(0, 3);
  return categories.length ? categories.join('、') : '未命名题集';
}

function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(item => {
    const options = Array.isArray(item && item.options)
      ? item.options.slice(0, 4).map(option => cleanText(option, 500))
      : [];
    const answer = Number(item && item.answer);
    if (!cleanText(item && item.q, 2000) || options.length !== 4 || options.some(option => !option) || answer < 0 || answer > 3) {
      return null;
    }
    return {
      cat: cleanText(item.cat, 100),
      q: cleanText(item.q, 2000),
      options,
      answer,
      exp: cleanText(item.exp, 3000)
    };
  }).filter(Boolean);
}

function sanitizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map(item => ({
    name: cleanText(item && item.name, 100),
    count: clampNumber(item && item.count, 0, 100)
  })).filter(item => item.name);
}

function sanitizeWrongAnswers(value, total) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, total || 100).map(item => ({
    cat: cleanText(item && item.cat, 100),
    q: cleanText(item && item.q, 2000),
    picked: cleanText(item && item.picked, 500),
    correct: cleanText(item && item.correct, 500),
    exp: cleanText(item && item.exp, 3000)
  })).filter(item => item.q);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function isShareExpired(createdAt) {
  const timestamp = Number(createdAt && typeof createdAt.valueOf === 'function' ? createdAt.valueOf() : createdAt);
  return Boolean(timestamp && Date.now() >= timestamp + 24 * 60 * 60 * 1000);
}

function clampNumber(value, min, max) {
  const number = Math.floor(Number(value) || 0);
  return Math.max(min, Math.min(number, max));
}

function sortNewest(items) {
  return items.slice().sort((left, right) => (Number(right.created_at) || 0) - (Number(left.created_at) || 0));
}

function maskPhone(phone) {
  return cleanText(phone, 20).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}
