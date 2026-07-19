// 拾知猫 — 分享答题记录云函数 (CloudBase)
// 功能4: 通过分享链接完成的答题记录同步给分享人

const cloud = require("@cloudbase/node-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { action } = event;

  switch (action) {
    case "save":
      return await saveResult(event);
    case "list":
      return await listResults(event);
    default:
      return { ok: false, error: "未知 action: " + action };
  }
};

// ---- 保存答题结果（被分享人做完题后） ----
async function saveResult(event) {
  const { shareId, nickname, score, total, wrongAnswers, userInfo } = event;

  if (!shareId) return { ok: false, error: "缺少分享ID" };

  try {
    // 获取分享记录，拿到分享人的 openid
    const shareResult = await db.collection("shares").doc(shareId).get();
    const share = shareResult.data;

    if (!share) {
      return { ok: false, error: "分享不存在" };
    }

    const now = Date.now();
    await db.collection("share_results").add({
      data: {
        share_id: shareId,
        sharer_openid: share._openid, // 分享人的 openid
        share_name: share.name,
        nickname: (nickname || "匿名用户").trim().slice(0, 20),
        score: score || 0,
        total: total || 0,
        wrong_answers: wrongAnswers || [],
        _openid: userInfo?.openid || "", // 答题人的 openid（可能为空，未登录）
        created_at: now,
      },
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 查看分享的答题记录（分享人查看） ----
async function listResults(event) {
  const { shareId, userInfo } = event;

  if (!userInfo?.openid) return { ok: false, error: "请先登录" };

  try {
    // 验证这个分享属于当前用户
    const shareResult = await db.collection("shares").doc(shareId).get();
    const share = shareResult.data;

    if (!share || share._openid !== userInfo.openid) {
      return { ok: false, error: "无权查看" };
    }

    // 获取该分享的所有答题记录
    const result = await db
      .collection("share_results")
      .where({ share_id: shareId })
      .orderBy("created_at", "desc")
      .limit(100)
      .get();

    return {
      ok: true,
      shareName: share.name,
      questions: share.questions,
      results: result.data.map((r) => ({
        id: r._id,
        nickname: r.nickname,
        score: r.score,
        total: r.total,
        wrong_answers: r.wrong_answers || [],
        created_at: r.created_at,
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
