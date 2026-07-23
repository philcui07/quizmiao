// 拾知猫 - 分享管理云函数（命名、24 小时有效期、账号归属）

const crypto = require('crypto');
const cloud = require('@cloudbase/node-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const SHARE_TTL = 24 * 60 * 60 * 1000;

exports.main = async (event, context) => {
  const userId = getAuthUserId(context);
  try {
    switch (event.action) {
      case 'save':
        return await saveShare(event, userId);
      case 'get':
        return await getShare(event);
      case 'list':
        if (!userId) return { ok: false, error: '请先登录' };
        return await listShares(event, userId);
      default:
        return { ok: false, error: '未知 action: ' + event.action };
    }
  } catch (e) {
    console.error('[share-manage]', e);
    return { ok: false, error: '分享操作失败' };
  }
};

async function saveShare(event, userId) {
  const questions = sanitizeQuestions(event.questions);
  if (questions.length === 0) return { ok: false, error: '缺少有效题目' };

  const now = Date.now();
  const id = crypto.randomBytes(8).toString('hex');
  await db.collection('shares').doc(id).set({
    data: {
      owner_id: userId || '',
      name: cleanText(event.name, 50) || '未命名练习',
      questions,
      result_count: 0,
      created_at: now,
      expires_at: now + SHARE_TTL,
    },
  });
  return { ok: true, id, expiresAt: now + SHARE_TTL, tracked: Boolean(userId) };
}

async function getShare(event) {
  const id = cleanText(event.id, 64);
  if (!id) return { ok: false, error: '缺少分享 ID' };

  try {
    const result = await db.collection('shares').doc(id).get();
    const share = result.data;
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

async function listShares(event, userId) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const result = await db.collection('shares')
    .where({ owner_id: userId })
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

function getAuthUserId(context) {
  const cloudContext = typeof cloud.getCloudbaseContext === 'function'
    ? cloud.getCloudbaseContext()
    : {};
  return cleanText(
    context?.auth?.uid ||
    context?.auth?.openid ||
    cloudContext.TCB_UUID ||
    cloudContext.WX_OPENID ||
    cloudContext.OPENID,
    128
  );
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
