// 拾知猫 - 手机号账号分享管理云函数

const crypto = require('crypto');
const cloud = require('@cloudbase/node-sdk');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const SHARE_TTL = 24 * 60 * 60 * 1000;

exports.main = async (event) => {
  const accountId = requireAccountId(event);
  try {
    switch (event.action) {
      case 'save':
        if (event.trackAccount === true && !accountId) return { ok: false, error: '请先登录' };
        return await saveShare(event, event.trackAccount === true ? accountId : '');
      case 'get':
        return await getShare(event);
      case 'list':
        if (!accountId) return { ok: false, error: '请先登录' };
        return await listShares(event, accountId);
      default:
        return { ok: false, error: '未知 action: ' + event.action };
    }
  } catch (e) {
    console.error('[share-manage]', e);
    return { ok: false, error: '分享操作失败' };
  }
};

async function saveShare(event, accountId) {
  const questions = sanitizeQuestions(event.questions);
  if (questions.length === 0) return { ok: false, error: '缺少有效题目' };

  const now = Date.now();
  const id = crypto.randomBytes(8).toString('hex');
  await db.collection('shares').doc(id).set({
    owner_id: accountId,
    name: cleanText(event.name, 50) || '未命名练习',
    questions,
    result_count: 0,
    created_at: now,
    expires_at: now + SHARE_TTL,
  });
  return { ok: true, id, expiresAt: now + SHARE_TTL, tracked: Boolean(accountId) };
}

async function getShare(event) {
  const id = cleanText(event.id, 64);
  if (!id) return { ok: false, error: '缺少分享 ID' };

  try {
    const share = firstDocument(await db.collection('shares').doc(id).get());
    if (!share) return { ok: false, error: '分享不存在' };
    if (share.expires_at <= Date.now()) {
      return { ok: false, error: '分享已过期（有效时长 24 小时），请让分享者重新生成' };
    }
    return {
      ok: true,
      questions: share.questions,
      name: share.name,
      share_id: id,
      expires_at: share.expires_at,
    };
  } catch (_) {
    return { ok: false, error: '分享不存在或已过期' };
  }
}

function firstDocument(result) {
  const data = result?.data;
  return Array.isArray(data) ? data[0] || null : data || null;
}

async function listShares(event, accountId) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const result = await db.collection('shares')
    .where({ owner_id: accountId })
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  const now = Date.now();
  return {
    ok: true,
    shares: result.data.map((share) => ({
      id: share._id,
      name: share.name,
      question_count: share.questions?.length || 0,
      result_count: share.result_count || 0,
      created_at: share.created_at,
      expires_at: share.expires_at,
      expired: share.expires_at <= now,
    })),
    page,
    hasMore: result.data.length === pageSize,
  };
}

function requireAccountId(event) {
  const phone = cleanText(event.accountPhone, 20);
  return /^1\d{10}$/.test(phone) ? phone : '';
}

function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((q) => {
    const options = Array.isArray(q?.options)
      ? q.options.slice(0, 4).map((item) => cleanText(item, 500))
      : [];
    const answer = Number(q?.answer);
    if (!cleanText(q?.q, 2000) || options.length !== 4 || options.some((item) => !item) || answer < 0 || answer > 3) {
      return null;
    }
    return {
      cat: cleanText(q.cat, 100),
      q: cleanText(q.q, 2000),
      options,
      answer,
      exp: cleanText(q.exp, 3000),
    };
  }).filter(Boolean);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}
