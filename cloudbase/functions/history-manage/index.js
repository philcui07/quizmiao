// 拾知猫 — 历史记录管理云函数 (CloudBase)
// 功能2: 历史出题记录 + 练习成绩 + 错题集

const cloud = require("@cloudbase/node-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { action, userInfo } = event;

  if (!userInfo?.openid && action !== "save") {
    return { ok: false, error: "请先登录" };
  }

  switch (action) {
    case "save":
      return await saveHistory(event);
    case "list":
      return await listHistory(event);
    case "detail":
      return await getDetail(event);
    default:
      return { ok: false, error: "未知 action: " + action };
  }
};

// ---- 保存练习记录 ----
// 触发时机：1. 出题确认页确认后 2. 练习完成后
async function saveHistory(event) {
  const { questions, score, total, wrongAnswers, source, shareId, title, userInfo } = event;

  if (!userInfo?.openid) {
    return { ok: false, error: "请先登录" };
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: "缺少题目数据" };
  }

  try {
    const now = Date.now();
    const result = await db.collection("quiz_history").add({
      data: {
        _openid: userInfo.openid,
        title: title || "练习记录",
        questions,
        score: score || 0,
        total: total || questions.length,
        wrong_answers: wrongAnswers || [],
        source: source || "self", // 'self' | 'shared'
        share_id: shareId || "",
        created_at: now,
      },
    });

    return { ok: true, id: result._id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 历史列表 ----
async function listHistory(event) {
  const { userInfo, page = 1, pageSize = 20 } = event;

  try {
    const skip = (page - 1) * pageSize;
    const result = await db
      .collection("quiz_history")
      .where({ _openid: userInfo.openid })
      .orderBy("created_at", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();

    return {
      ok: true,
      list: result.data.map((h) => ({
        id: h._id,
        title: h.title,
        score: h.score,
        total: h.total,
        wrong_count: h.wrong_answers?.length || 0,
        question_count: h.questions?.length || 0,
        source: h.source,
        created_at: h.created_at,
      })),
      page,
      hasMore: result.data.length === pageSize,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 历史详情（含题目和错题集） ----
async function getDetail(event) {
  const { id, userInfo } = event;

  try {
    const result = await db.collection("quiz_history").doc(id).get();
    const history = result.data;

    if (!history) {
      return { ok: false, error: "记录不存在" };
    }

    // 只能查看自己的记录
    if (history._openid !== userInfo.openid) {
      return { ok: false, error: "无权查看" };
    }

    return {
      ok: true,
      history: {
        id: history._id,
        title: history.title,
        questions: history.questions,
        score: history.score,
        total: history.total,
        wrong_answers: history.wrong_answers || [],
        source: history.source,
        share_id: history.share_id,
        created_at: history.created_at,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
