// 拾知猫 - 账号资料云函数

const cloud = require('@cloudbase/node-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const userId = getAuthUserId(context);
  if (!userId) return { ok: false, error: '请先登录' };

  try {
    if (event.action === 'get') return await getProfile(userId);
    if (event.action === 'update') return await updateProfile(event, userId);
    return { ok: false, error: '未知 action: ' + event.action };
  } catch (e) {
    console.error('[profile-manage]', e);
    return { ok: false, error: '账号资料操作失败' };
  }
};

async function getProfile(userId) {
  const result = await db.collection('users').where({ owner_id: userId }).limit(1).get();
  const profile = result.data[0];
  return {
    ok: true,
    profile: profile ? { nickname: profile.nickname || '' } : { nickname: '' },
  };
}

async function updateProfile(event, userId) {
  const nickname = cleanText(event.nickname, 20);
  if (!nickname) return { ok: false, error: '昵称不能为空' };

  const now = Date.now();
  const result = await db.collection('users').where({ owner_id: userId }).limit(1).get();
  if (result.data.length > 0) {
    await db.collection('users').doc(result.data[0]._id).update({
      data: { nickname, updated_at: now },
    });
  } else {
    await db.collection('users').add({
      data: {
        owner_id: userId,
        nickname,
        created_at: now,
        updated_at: now,
      },
    });
  }
  return { ok: true, profile: { nickname } };
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

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}
