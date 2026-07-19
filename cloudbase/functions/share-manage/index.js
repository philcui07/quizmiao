// 拾知猫 — 分享管理云函数 (CloudBase)
// 处理分享保存、获取、列表（v1.1.0: 24h时效 + 分享命名）

const cloud = require("@cloudbase/node-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SHARE_TTL = 24 * 60 * 60 * 1000; // 24小时（v1.1.0 从1h改为24h）

exports.main = async (event, context) => {
  const { action } = event;

  switch (action) {
    case "save":
      return await saveShare(event);
    case "get":
      return await getShare(event);
    case "list":
      return await listShares(event);
    default:
      return { ok: false, error: "未知 action: " + action };
  }
};

// ---- 保存分享 ----
async function saveShare(event) {
  const { questions, name, userInfo } = event;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: "缺少题目数据" };
  }

  const now = Date.now();
  const shareName = (name || "").trim().slice(0, 50); // 分享名称，最多50字

  try {
    const result = await db.collection("shares").add({
      data: {
        name: shareName || "未命名练习",
        questions,
        _openid: userInfo?.openid || "",
        created_at: now,
        expires_at: now + SHARE_TTL,
      },
    });

    return { ok: true, id: result._id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 获取分享 ----
async function getShare(event) {
  const { id } = event;
  if (!id) return { ok: false, error: "缺少分享ID" };

  try {
    const result = await db.collection("shares").doc(id).get();
    const share = result.data;

    if (!share) {
      return { ok: false, error: "分享不存在" };
    }

    if (share.expires_at < Date.now()) {
      return { ok: false, error: "分享已过期（有效时长24小时），请让分享者重新生成" };
    }

    return {
      ok: true,
      questions: share.questions,
      name: share.name,
      share_id: id,
      sharer_openid: share._openid,
    };
  } catch (e) {
    return { ok: false, error: "分享不存在或已过期" };
  }
}

// ---- 列出我的分享（分享人查看） ----
async function listShares(event) {
  const { userInfo } = event;
  if (!userInfo?.openid) return { ok: false, error: "未登录" };

  try {
    const now = Date.now();
    const result = await db
      .collection("shares")
      .where({
        _openid: userInfo.openid,
        expires_at: db.command.gt(now),
      })
      .orderBy("created_at", "desc")
      .limit(50)
      .get();

    return {
      ok: true,
      shares: result.data.map((s) => ({
        id: s._id,
        name: s.name,
        question_count: s.questions?.length || 0,
        created_at: s.created_at,
        expires_at: s.expires_at,
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
