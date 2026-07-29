// 拾知猫 - 手机号账号资料云函数

const cloud = require('@cloudbase/node-sdk');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

exports.main = async (event) => {
  try {
    switch (event.action) {
      case 'login':
        return await login(event);
      case 'get':
        return await getProfile(event);
      case 'updateNickname':
        return await updateNickname(event);
      default:
        return { ok: false, error: '未知 action: ' + event.action };
    }
  } catch (e) {
    console.error('[profile-manage]', e);
    return { ok: false, error: '账号资料操作失败' };
  }
};

async function login(event) {
  const phone = requirePhone(event.phone);
  if (!phone) return { ok: false, error: '请输入正确的手机号' };

  const now = Date.now();
  const existing = await findAccount(phone);
  const data = {
    account_id: phone,
    phone,
    nickname: cleanText(existing?.nickname, 20),
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await db.collection('users').doc(accountDocId(phone)).set(data);
  return { ok: true, profile: publicProfile(data) };
}

async function getProfile(event) {
  const phone = requirePhone(event.accountPhone);
  if (!phone) return { ok: false, error: '请先登录' };

  const account = await findAccount(phone);
  if (!account) return { ok: false, error: '请先登录' };
  return { ok: true, profile: publicProfile(account) };
}

async function updateNickname(event) {
  const phone = requirePhone(event.accountPhone);
  if (!phone) return { ok: false, error: '请先登录' };

  const nickname = cleanText(event.nickname, 20);
  if (!nickname) return { ok: false, error: '昵称不能为空' };

  const account = await findAccount(phone);
  if (!account) return { ok: false, error: '请先登录' };

  await db.collection('users').doc(accountDocId(phone)).update({
    nickname,
    updated_at: Date.now(),
  });
  return { ok: true, profile: publicProfile({ ...account, nickname }) };
}

async function findAccount(phone) {
  try {
    return firstDocument(await db.collection('users').doc(accountDocId(phone)).get());
  } catch (_) {
    return null;
  }
}

function firstDocument(result) {
  const data = result?.data;
  return Array.isArray(data) ? data[0] || null : data || null;
}

function publicProfile(account) {
  return {
    accountId: account.account_id,
    phone: account.phone,
    nickname: account.nickname || '',
    phoneVerified: false,
    onboarded: true,
  };
}

function accountDocId(phone) {
  return 'phone_' + phone;
}

function requirePhone(value) {
  const phone = cleanText(value, 20);
  return /^1\d{10}$/.test(phone) ? phone : '';
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}
