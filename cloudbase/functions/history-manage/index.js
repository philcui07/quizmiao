// 拾知猫 - 题集与练习历史管理云函数

const cloud = require('@cloudbase/node-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const userId = getAuthUserId(context);
  if (!userId) return { ok: false, error: '请先登录' };

  try {
    switch (event.action) {
      case 'create':
        return await createQuiz(event, userId);
      case 'updateQuestions':
        return await updateQuestions(event, userId);
      case 'addAttempt':
        return await addAttempt(event, userId);
      case 'list':
        return await listQuizzes(event, userId);
      case 'detail':
        return await getDetail(event, userId);
      default:
        return { ok: false, error: '未知 action: ' + event.action };
    }
  } catch (e) {
    console.error('[history-manage]', e);
    return { ok: false, error: '历史记录操作失败' };
  }
};

async function createQuiz(event, userId) {
  const questions = sanitizeQuestions(event.questions);
  if (questions.length === 0) return { ok: false, error: '缺少有效题目' };

  const now = Date.now();
  const result = await db.collection('quiz_history').add({
    data: {
      owner_id: userId,
      title: cleanText(event.title, 80) || buildTitle(questions),
      questions,
      practice_count: 0,
      last_attempt: null,
      created_at: now,
      updated_at: now,
    },
  });
  return { ok: true, id: result._id };
}

async function updateQuestions(event, userId) {
  const history = await getOwnedHistory(event.id, userId);
  if (!history.ok) return history;

  const questions = sanitizeQuestions(event.questions);
  if (questions.length === 0) return { ok: false, error: '题目不能为空' };

  await db.collection('quiz_history').doc(event.id).update({
    data: { questions, updated_at: Date.now() },
  });
  return { ok: true };
}

async function addAttempt(event, userId) {
  const history = await getOwnedHistory(event.historyId, userId);
  if (!history.ok) return history;

  const attemptId = cleanText(event.attemptId, 100);
  if (!attemptId) return { ok: false, error: '缺少练习轮次 ID' };

  const existing = await db.collection('quiz_attempts').where({
    owner_id: userId,
    attempt_id: attemptId,
  }).limit(1).get();
  if (existing.data.length > 0) {
    return { ok: true, id: existing.data[0]._id, duplicate: true };
  }

  const total = Math.max(0, Math.min(Number(event.total) || 0, history.data.questions.length));
  const score = Math.max(0, Math.min(Number(event.score) || 0, total));
  const wrongAnswers = sanitizeWrongAnswers(event.wrongAnswers, total);
  const now = Date.now();

  const result = await db.collection('quiz_attempts').add({
    data: {
      owner_id: userId,
      history_id: event.historyId,
      attempt_id: attemptId,
      score,
      total,
      wrong_answers: wrongAnswers,
      created_at: now,
    },
  });

  await db.collection('quiz_history').doc(event.historyId).update({
    data: {
      practice_count: db.command.inc(1),
      last_attempt: {
        id: result._id,
        score,
        total,
        wrong_count: wrongAnswers.length,
        created_at: now,
      },
      updated_at: now,
    },
  });

  return { ok: true, id: result._id };
}

async function listQuizzes(event, userId) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const result = await db.collection('quiz_history')
    .where({ owner_id: userId })
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

async function getDetail(event, userId) {
  const history = await getOwnedHistory(event.id, userId);
  if (!history.ok) return history;

  const attempts = await db.collection('quiz_attempts')
    .where({ owner_id: userId, history_id: event.id })
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

async function getOwnedHistory(id, userId) {
  if (!id) return { ok: false, error: '缺少题集 ID' };
  try {
    const result = await db.collection('quiz_history').doc(id).get();
    if (!result.data) return { ok: false, error: '记录不存在' };
    if (result.data.owner_id !== userId) return { ok: false, error: '无权查看' };
    return { ok: true, data: result.data };
  } catch (_) {
    return { ok: false, error: '记录不存在' };
  }
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
