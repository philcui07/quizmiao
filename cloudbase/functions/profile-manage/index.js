// 拾知猫 - 账号资料云函数（CloudBase 身份授权，手机号仅为资料）

const cloud = require('@cloudbase/node-sdk');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

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
  const phoneOwner = await findProfileByPhone(phone);
  const canonicalId = cleanText(phoneOwner?.canonical_owner_id, 128)
    || cleanText(phoneOwner?.owner_id, 128)
    || cleanText(identity?.canonical_owner_id, 128)
    || authId;

  // The phone number is the product account. A new anonymous credential for the
  // same phone is linked to the original account owner so history follows it.
  if (canonicalId !== authId) {
    await upsertIdentity(authId, identity, canonicalId, phone, now);
    const canonical = await findProfile(canonicalId);
    return { ok: true, profile: publicProfile(canonical || phoneOwner) };
  }

  const data = {
    owner_id: authId,
    canonical_owner_id: authId,
    phone,
    phone_verified: false,
    onboarded: true,
    updated_at: now,
  };
  if (identity) {
    await db.collection('users').doc(identity._id).update({ data });
  } else {
    data.nickname = '';
    data.created_at = now;
    await db.collection('users').add({ data });
  }
  return { ok: true, profile: publicProfile({ ...(identity || {}), ...data }) };
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

async function upsertIdentity(authId, identity, canonicalId, phone, now) {
  const data = {
    owner_id: authId,
    canonical_owner_id: canonicalId,
    phone,
    phone_verified: false,
    onboarded: true,
    updated_at: now,
  };
  if (identity) {
    await db.collection('users').doc(identity._id).update({ data });
  } else {
    await db.collection('users').add({ data: { nickname: '', created_at: now, ...data } });
  }
}

async function findProfile(ownerId) {
  const result = await db.collection('users').where({ owner_id: ownerId }).limit(1).get();
  return result.data[0] || null;
}

async function findProfileByPhone(phone) {
  const result = await db.collection('users').where({ phone }).limit(1).get();
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
