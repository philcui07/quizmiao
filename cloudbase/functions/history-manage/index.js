// 拾知猫 - 手机号账号题集与练习历史云函数

const cloud = require('@cloudbase/node-sdk');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

exports.main = async (event) => {
  const accountId = requireAccountId(event);
  if (!accountId) return { ok: false, error: '请先登录' };

  try {
    switch (event.action) {
      case 'create':
        return await createQuiz(event, accountId);
      case 'updateQuestions':
        return await updateQuestions(event, accountId);
      case 'addAttempt':
        return await addAttempt(event, accountId);
      case 'list':
        return await listQuizzes(event, accountId);
      case 'detail':
        return await getDetail(event, accountId);
      case 'repairSummary':
        return await repairSummary(event, accountId);
      default:
        return { ok: false, error: '未知 action: ' + event.action };
    }
  } catch (e) {
    console.error('[history-manage]', e);
    return { ok: false, error: '历史记录操作失败' };
  }
};

async function createQuiz(event, accountId) {
  const questions = sanitizeQuestions(event.questions);
  if (questions.length === 0) return { ok: false, error: '缺少有效题目' };

  const now = Date.now();
  const result = await db.collection('quiz_history').add({
    owner_id: accountId,
    title: cleanText(event.title, 80) || buildTitle(questions),
    questions,
    practice_count: 0,
    last_attempt: null,
    created_at: now,
    updated_at: now,
  });
  const id = insertedId(result);
  if (!id) throw new Error('数据库未返回题集 ID');
  return { ok: true, id };
}

async function updateQuestions(event, accountId) {
  const history = await getOwnedHistory(event.id, accountId);
  if (!history.ok) return history;

  const questions = sanitizeQuestions(event.questions);
  if (questions.length === 0) return { ok: false, error: '题目不能为空' };

  await db.collection('quiz_history').doc(event.id).update({
    questions,
    updated_at: Date.now(),
  });
  return { ok: true };
}

async function addAttempt(event, accountId) {
  const history = await getOwnedHistory(event.historyId, accountId);
  if (!history.ok) return history;

  const attemptId = cleanText(event.attemptId, 100);
  if (!attemptId) return { ok: false, error: '缺少练习轮次 ID' };

  const existing = await db.collection('quiz_attempts').where({
    owner_id: accountId,
    attempt_id: attemptId,
  }).limit(1).get();
  if (existing.data.length > 0) {
    await repairHistorySummary(event.historyId, accountId);
    return { ok: true, id: existing.data[0]._id, duplicate: true };
  }

  const total = Math.max(0, Math.min(Number(event.total) || 0, history.data.questions.length));
  const score = Math.max(0, Math.min(Number(event.score) || 0, total));
  const wrongAnswers = sanitizeWrongAnswers(event.wrongAnswers, total);
  const now = Date.now();
  const result = await db.collection('quiz_attempts').add({
    owner_id: accountId,
    history_id: event.historyId,
    attempt_id: attemptId,
    score,
    total,
    wrong_answers: wrongAnswers,
    created_at: now,
  });
  const resultId = insertedId(result);
  if (!resultId) throw new Error('数据库未返回练习记录 ID');

  await db.collection('quiz_history').doc(event.historyId).update({
    practice_count: db.command.inc(1),
    // Plain nested objects are flattened into dot paths by the SDK. Replace the
    // whole field because existing quiz documents initialize it as null.
    last_attempt: db.command.set({
      id: resultId,
      score,
      total,
      wrong_count: wrongAnswers.length,
      created_at: now,
    }),
    updated_at: now,
  });
  return { ok: true, id: resultId };
}

async function repairSummary(event, accountId) {
  const history = await getOwnedHistory(event.historyId, accountId);
  if (!history.ok) return history;
  const summary = await repairHistorySummary(event.historyId, accountId);
  return { ok: true, ...summary };
}

async function repairHistorySummary(historyId, accountId) {
  const query = db.collection('quiz_attempts').where({
    owner_id: accountId,
    history_id: historyId,
  });
  const [countResult, latestResult] = await Promise.all([
    query.count(),
    query.orderBy('created_at', 'desc').limit(1).get(),
  ]);
  const latest = latestResult.data[0] || null;
  const practiceCount = Number(countResult.total) || 0;
  const lastAttempt = latest ? {
    id: latest._id,
    score: latest.score,
    total: latest.total,
    wrong_count: latest.wrong_answers?.length || 0,
    created_at: latest.created_at,
  } : null;

  await db.collection('quiz_history').doc(historyId).update({
    practice_count: practiceCount,
    last_attempt: db.command.set(lastAttempt),
    updated_at: Date.now(),
  });
  return { practice_count: practiceCount, last_attempt: lastAttempt };
}

async function listQuizzes(event, accountId) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const result = await db.collection('quiz_history')
    .where({ owner_id: accountId })
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  return {
    ok: true,
    list: result.data.map((item) => ({
      id: item._id,
      title: item.title,
      question_count: item.questions?.length || 0,
      practice_count: item.practice_count || 0,
      last_attempt: item.last_attempt || null,
      created_at: item.created_at,
      updated_at: item.updated_at,
    })),
    page,
    hasMore: result.data.length === pageSize,
  };
}

async function getDetail(event, accountId) {
  const history = await getOwnedHistory(event.id, accountId);
  if (!history.ok) return history;

  const attempts = await db.collection('quiz_attempts')
    .where({ owner_id: accountId, history_id: event.id })
    .orderBy('created_at', 'desc')
    .limit(100)
    .get();

  const item = history.data;
  return {
    ok: true,
    history: {
      id: item._id,
      title: item.title,
      questions: item.questions || [],
      practice_count: item.practice_count || attempts.data.length,
      created_at: item.created_at,
      updated_at: item.updated_at,
      attempts: attempts.data.map((attempt) => ({
        id: attempt._id,
        score: attempt.score,
        total: attempt.total,
        wrong_answers: attempt.wrong_answers || [],
        created_at: attempt.created_at,
      })),
    },
  };
}

async function getOwnedHistory(id, accountId) {
  if (!id) return { ok: false, error: '缺少题集 ID' };
  try {
    const item = firstDocument(await db.collection('quiz_history').doc(id).get());
    if (!item) return { ok: false, error: '记录不存在' };
    if (item.owner_id !== accountId) return { ok: false, error: '无权查看' };
    return { ok: true, data: item };
  } catch (_) {
    return { ok: false, error: '记录不存在' };
  }
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

function buildTitle(questions) {
  const categories = [...new Set(questions.map((q) => q.cat).filter(Boolean))].slice(0, 3);
  return categories.length ? categories.join('、') : '未命名题集';
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
