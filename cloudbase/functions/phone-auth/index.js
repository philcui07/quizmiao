// 拾知猫 - Web 运营商一键认证服务端校验

const crypto = require('crypto');
const https = require('https');
const cloud = require('@cloudbase/node-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const authId = getAuthUserId(context);
  if (!authId) return { ok: false, error: '设备身份不可用，请刷新后重试' };
  if (event.action !== 'verify') return { ok: false, error: '未知 action: ' + event.action };

  try {
    const verified = await verifyProviderToken(event);
    const account = await bindVerifiedPhone(authId, verified.phone, verified.provider);
    return {
      ok: true,
      phoneMasked: maskPhone(verified.phone),
      merged: account.canonicalOwnerId !== authId,
    };
  } catch (e) {
    console.error('[phone-auth]', e.message);
    return {
      ok: false,
      code: e.code || 'PHONE_AUTH_FAILED',
      error: publicError(e),
      fallback: true,
    };
  }
};

async function verifyProviderToken(event) {
  const provider = cleanText(process.env.PHONE_AUTH_PROVIDER, 50);
  const requestProvider = cleanText(event.provider, 50);
  const token = cleanText(event.token, 4096);
  const endpoint = cleanText(process.env.PHONE_AUTH_VERIFY_URL, 1000);
  const hashSecret = String(process.env.PHONE_HASH_SECRET || '');

  if (!provider || provider === 'disabled' || !endpoint) {
    throw codedError('PROVIDER_NOT_CONFIGURED', '运营商认证尚未配置');
  }
  if (requestProvider !== provider) throw codedError('PROVIDER_MISMATCH', '认证供应商不匹配');
  if (!token) throw codedError('TOKEN_MISSING', '缺少运营商认证凭证');
  if (hashSecret.length < 32) throw codedError('SERVER_MISCONFIGURED', '号码哈希密钥未配置');

  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    throw codedError('SERVER_MISCONFIGURED', '认证校验地址无效');
  }
  if (url.protocol !== 'https:') throw codedError('SERVER_MISCONFIGURED', '认证校验地址必须使用 HTTPS');

  const response = await postJson(url, {
    provider,
    appId: cleanText(process.env.PHONE_AUTH_APP_ID, 200),
    token,
    metadata: sanitizeMetadata(event.metadata),
  }, cleanText(process.env.PHONE_AUTH_VERIFY_SECRET, 1000));

  const phone = cleanText(response.phone || response.phoneNumber || response.mobile, 20);
  if (response.ok !== true || !/^1\d{10}$/.test(phone)) {
    throw codedError('TOKEN_REJECTED', '运营商认证未通过');
  }
  return { provider, phone };
}

async function bindVerifiedPhone(authId, phone, provider) {
  const now = Date.now();
  const phoneHash = crypto
    .createHmac('sha256', process.env.PHONE_HASH_SECRET)
    .update('CN:' + phone)
    .digest('hex');

  let binding = null;
  try {
    binding = (await db.collection('phone_bindings').doc(phoneHash).get()).data || null;
  } catch (_) {}

  const canonicalOwnerId = cleanText(binding?.canonical_owner_id, 128) || authId;
  const canonicalProfile = await findProfile(canonicalOwnerId);
  const canonicalData = {
    owner_id: canonicalOwnerId,
    canonical_owner_id: canonicalOwnerId,
    phone,
    phone_verified: true,
    phone_provider: provider,
    phone_verified_at: now,
    onboarded: true,
    updated_at: now,
  };

  if (canonicalProfile) {
    await db.collection('users').doc(canonicalProfile._id).update({ data: canonicalData });
  } else {
    await db.collection('users').add({
      data: { nickname: '', created_at: now, ...canonicalData },
    });
  }

  if (canonicalOwnerId !== authId) {
    const identity = await findProfile(authId);
    const aliasData = {
      owner_id: authId,
      canonical_owner_id: canonicalOwnerId,
      phone: '',
      phone_verified: true,
      phone_provider: provider,
      phone_verified_at: now,
      onboarded: true,
      updated_at: now,
    };
    if (identity) {
      await db.collection('users').doc(identity._id).update({ data: aliasData });
    } else {
      await db.collection('users').add({ data: { nickname: '', created_at: now, ...aliasData } });
    }
    await migrateOwnerData(authId, canonicalOwnerId);
  }

  await db.collection('phone_bindings').doc(phoneHash).set({
    data: {
      canonical_owner_id: canonicalOwnerId,
      provider,
      created_at: binding?.created_at || now,
      updated_at: now,
    },
  });
  return { canonicalOwnerId };
}

async function migrateOwnerData(fromOwnerId, toOwnerId) {
  await Promise.all([
    db.collection('quiz_history').where({ owner_id: fromOwnerId }).update({ data: { owner_id: toOwnerId } }),
    db.collection('quiz_attempts').where({ owner_id: fromOwnerId }).update({ data: { owner_id: toOwnerId } }),
    db.collection('shares').where({ owner_id: fromOwnerId }).update({ data: { owner_id: toOwnerId } }),
    db.collection('share_results').where({ sharer_id: fromOwnerId }).update({ data: { sharer_id: toOwnerId } }),
  ]);
}

async function findProfile(ownerId) {
  const result = await db.collection('users').where({ owner_id: ownerId }).limit(1).get();
  return result.data[0] || null;
}

function postJson(url, body, secret) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(secret ? { Authorization: 'Bearer ' + secret } : {}),
      },
      timeout: 6000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (text.length < 64 * 1024) text += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(codedError('PROVIDER_ERROR', '认证服务暂不可用'));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (_) {
          reject(codedError('PROVIDER_ERROR', '认证服务响应无效'));
        }
      });
    });
    request.on('timeout', () => request.destroy(codedError('PROVIDER_TIMEOUT', '认证服务响应超时')));
    request.on('error', (error) => reject(error));
    request.end(payload);
  });
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [
    cleanText(key, 50), cleanText(item, 500),
  ]).filter(([key]) => key));
}

function getAuthUserId(context) {
  const cloudContext = typeof cloud.getCloudbaseContext === 'function'
    ? cloud.getCloudbaseContext()
    : {};
  return cleanText(
    context?.auth?.uid || context?.auth?.openid || cloudContext.TCB_UUID || cloudContext.WX_OPENID || cloudContext.OPENID,
    128
  );
}

function maskPhone(phone) {
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicError(error) {
  const allowed = new Set([
    'PROVIDER_NOT_CONFIGURED', 'PROVIDER_MISMATCH', 'TOKEN_MISSING', 'TOKEN_REJECTED',
    'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'SERVER_MISCONFIGURED',
  ]);
  return allowed.has(error.code) ? error.message : '一键认证失败，请输入手机号继续';
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}
