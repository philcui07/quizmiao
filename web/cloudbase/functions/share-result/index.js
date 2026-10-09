// 拾知猫 - 分享答题记录云函数

const cloud = require('@cloudbase/node-sdk');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

exports.main = async (event) => {
  try {
    switch (event.action) {
      case 'save':
        return await saveResult(event);
      case 'list': {
        const accountId = requireAccountId(event);
        if (!accountId) return { ok: false, error: '请先登录' };
        return await listResults(event, accountId);
      }
      default:
        return { ok: false, error: '未知 action: ' + event.action };
    }
  } catch (e) {
    console.error('[share-result]', e);
    return { ok: false, error: '答题记录操作失败' };
  }
};

async function saveResult(event) {
  const shareId = cleanText(event.shareId, 64);
  const attemptId = cleanText(event.attemptId, 100);
  if (!shareId || !attemptId) return { ok: false, error: '缺少分享或练习轮次 ID' };

  let share;
  try {
    share = firstDocument(await db.collection('shares').doc(shareId).get());
  } catch (_) {
    return { ok: false, error: '分享不存在' };
  }
  if (!share) return { ok: false, error: '分享不存在' };
  if (share.expires_at <= Date.now()) return { ok: false, error: '分享已过期' };
  if (!share.owner_id) return { ok: true, untracked: true };

  const existing = await db.collection('share_results').where({
    share_id: shareId,
    attempt_id: attemptId,
  }).limit(1).get();
  if (existing.data.length > 0) return { ok: true, duplicate: true };

  const total = Math.max(0, Math.min(Number(event.total) || 0, share.questions?.length || 100));
  const score = Math.max(0, Math.min(Number(event.score) || 0, total));
  const wrongAnswers = sanitizeWrongAnswers(event.wrongAnswers, total);
  const now = Date.now();
  const result = await db.collection('share_results').add({
    share_id: shareId,
    sharer_id: share.owner_id,
    participant_id: requireAccountId(event),
    attempt_id: attemptId,
    nickname: cleanText(event.nickname, 20) || '匿名用户',
    score,
    total,
    wrong_answers: wrongAnswers,
    created_at: now,
  });
  const resultId = insertedId(result);
  if (!resultId) throw new Error('数据库未返回答题记录 ID');

  await db.collection('shares').doc(shareId).update({
    result_count: db.command.inc(1),
  });
  return { ok: true, id: resultId };
}

async function listResults(event, accountId) {
  const shareId = cleanText(event.shareId, 64);
  if (!shareId) return { ok: false, error: '缺少分享 ID' };

  let share;
  try {
    share = firstDocument(await db.collection('shares').doc(shareId).get());
  } catch (_) {
    return { ok: false, error: '分享不存在' };
  }
  if (!share || share.owner_id !== accountId) return { ok: false, error: '无权查看' };

  const result = await db.collection('share_results')
    .where({ share_id: shareId, sharer_id: accountId })
    .orderBy('created_at', 'desc')
    .limit(100)
    .get();

  return {
    ok: true,
    share: {
      id: shareId,
      name: share.name,
      questions: share.questions || [],
      created_at: share.created_at,
      expires_at: share.expires_at,
    },
    results: result.data.map((item) => ({
      id: item._id,
      nickname: item.nickname || '匿名用户',
      score: item.score,
      total: item.total,
      wrong_answers: item.wrong_answers || [],
      created_at: item.created_at,
    })),
  };
}

function firstDocument(result) {
  const data = result?.data;
  return Array.isArray(data) ? data[0] || null : data || null;
}

function requireAccountId(event) {
  const phone = cleanText(event.accountPhone, 20);
  return /^1\d{10}$/.test(phone) ? phone : '';
}

function insertedId(result) {
  return cleanText(result?.id || result?._id, 128);
}

function sanitizeWrongAnswers(value, total) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, total || 100).map((item) => ({
    cat: cleanText(item?.cat, 100),
    q: cleanText(item?.q, 2000),
    picked: cleanText(item?.picked, 500),
    correct: cleanText(item?.correct, 500),
    exp: cleanText(item?.exp, 3000),
  })).filter((item) => item.q);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}
