// 拾知猫 - 账号资料云函数（CloudBase 身份授权，手机号仅为资料）

const cloud = require('@cloudbase/node-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const authId = getAuthUserId(context);
  if (!authId) return { ok: false, error: '设备身份不可用，请刷新后重试' };

  try {
    if (event.action === 'get') return await getProfile(authId);
    if (event.action === 'updatePhone') return await updatePhone(event, authId);
    if (event.action === 'updateNickname') return await updateNickname(event, authId);
    return { ok: false, error: '未知 action: ' + event.action };
  } catch (e) {
    console.error('[profile-manage]', e);
    return { ok: false, error: '账号资料操作失败' };
  }
};

async function getProfile(authId) {
  const identity = await findProfile(authId);
  if (!identity) return { ok: true, profile: emptyProfile() };

  const canonicalId = cleanText(identity.canonical_owner_id, 128) || authId;
  const profile = canonicalId === authId ? identity : (await findProfile(canonicalId)) || identity;
  return { ok: true, profile: publicProfile(profile) };
}

async function updatePhone(event, authId) {
  const phone = cleanText(event.phone, 20);
  if (!/^1\d{10}$/.test(phone)) return { ok: false, error: '请输入正确的手机号' };

  const now = Date.now();
  const identity = await findProfile(authId);
  const canonicalId = cleanText(identity?.canonical_owner_id, 128) || authId;
  const canonical = canonicalId === authId ? identity : await findProfile(canonicalId);

  // 已由运营商认证的号码不能被手动输入降级或覆盖。
  if (canonical?.phone_verified) {
    await markOnboarded(authId, identity, canonicalId, now);
    return { ok: true, profile: publicProfile(canonical) };
  }

  const data = {
    owner_id: canonicalId,
    canonical_owner_id: canonicalId,
    phone,
    phone_verified: false,
    onboarded: true,
    updated_at: now,
  };
  if (canonical) {
    await db.collection('users').doc(canonical._id).update({ data });
  } else {
    data.nickname = '';
    data.created_at = now;
    await db.collection('users').add({ data });
  }

  if (canonicalId !== authId) await markOnboarded(authId, identity, canonicalId, now);
  return { ok: true, profile: publicProfile({ ...(canonical || {}), ...data }) };
}

async function updateNickname(event, authId) {
  const nickname = cleanText(event.nickname, 20);
  if (!nickname) return { ok: false, error: '昵称不能为空' };

  const identity = await findProfile(authId);
  if (!identity?.onboarded) return { ok: false, error: '请先登录' };
  const canonicalId = cleanText(identity.canonical_owner_id, 128) || authId;
  const canonical = canonicalId === authId ? identity : await findProfile(canonicalId);
  if (!canonical) return { ok: false, error: '账号资料不存在' };

  await db.collection('users').doc(canonical._id).update({
    data: { nickname, updated_at: Date.now() },
  });
  return { ok: true, profile: publicProfile({ ...canonical, nickname }) };
}

async function markOnboarded(authId, identity, canonicalId, now) {
  const data = { canonical_owner_id: canonicalId, onboarded: true, updated_at: now };
  if (identity) {
    await db.collection('users').doc(identity._id).update({ data });
  } else {
    await db.collection('users').add({
      data: { owner_id: authId, nickname: '', phone: '', phone_verified: false, created_at: now, ...data },
    });
  }
}

async function findProfile(ownerId) {
  const result = await db.collection('users').where({ owner_id: ownerId }).limit(1).get();
  return result.data[0] || null;
}

function publicProfile(profile) {
  return {
    nickname: profile?.nickname || '',
    phone: profile?.phone || '',
    phoneVerified: Boolean(profile?.phone_verified),
    onboarded: Boolean(profile?.onboarded),
  };
}

function emptyProfile() {
  return { nickname: '', phone: '', phoneVerified: false, onboarded: false };
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
