const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createDatabase() {
  const stores = new Map();
  let sequence = 0;
  let failNextSummaryUpdate = false;

  function storeFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function applyUpdate(target, data) {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === 'object' && value.__increment !== undefined) {
        target[key] = (Number(target[key]) || 0) + value.__increment;
      } else if (value && typeof value === 'object' && value.__setValue !== undefined) {
        target[key] = value.__setValue;
      } else if (target[key] === null && value && typeof value === 'object') {
        throw new Error(`Cannot create nested fields in null field ${key}`);
      } else {
        target[key] = value;
      }
    }
  }

  function collection(name) {
    const store = storeFor(name);
    return {
      doc(id) {
        return {
          async get() {
            const document = store.get(id);
            return { data: document ? [document] : [] };
          },
          async set(data) {
            store.set(id, { _id: id, ...data });
            return { _id: id };
          },
          async update(data) {
            const current = store.get(id);
            if (!current) throw new Error('document not found');
            if (name === 'quiz_history' && failNextSummaryUpdate && data?.last_attempt?.__setValue !== undefined) {
              failNextSummaryUpdate = false;
              throw new Error('simulated summary update failure');
            }
            applyUpdate(current, data);
            return { updated: 1 };
          },
        };
      },
      async add(data) {
        const id = `${name}_${++sequence}`;
        store.set(id, { _id: id, ...data });
        return { id };
      },
      where(query) {
        let limitValue = Infinity;
        let skipValue = 0;
        let order = null;
        const builder = {
          orderBy(field, direction) {
            order = { field, direction };
            return builder;
          },
          skip(value) {
            skipValue = value;
            return builder;
          },
          limit(value) {
            limitValue = value;
            return builder;
          },
          async get() {
            const data = [...store.values()].filter((item) =>
              Object.entries(query).every(([key, value]) => item[key] === value)
            );
            if (order) {
              const factor = order.direction === 'desc' ? -1 : 1;
              data.sort((a, b) => factor * ((a[order.field] || 0) - (b[order.field] || 0)));
            }
            return { data: data.slice(skipValue, skipValue + limitValue) };
          },
          async count() {
            return {
              total: [...store.values()].filter((item) =>
                Object.entries(query).every(([key, value]) => item[key] === value)
              ).length,
            };
          },
        };
        return builder;
      },
    };
  }

  return {
    stores,
    collection,
    failNextHistorySummaryUpdate() {
      failNextSummaryUpdate = true;
    },
    command: {
      inc(value) {
        return { __increment: value };
      },
      set(value) {
        return { __setValue: value };
      },
    },
  };
}

function loadFunction(name, db) {
  const source = fs.readFileSync(path.join(root, 'cloudbase/functions', name, 'index.js'), 'utf8');
  const fakeCloud = {
    SYMBOL_CURRENT_ENV: 'test-env',
    init() {
      return { database() { return db; } };
    },
  };
  const module = { exports: {} };
  const sandbox = {
    Buffer,
    Date,
    URL,
    console,
    module,
    exports: module.exports,
    require(id) {
      if (id === '@cloudbase/node-sdk') return fakeCloud;
      return require(id);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: `${name}/index.js` });
  return module.exports.main;
}

function questions() {
  return [{
    cat: '测试',
    q: '正确答案是什么？',
    options: ['甲', '乙', '丙', '丁'],
    answer: 0,
    exp: '甲是正确答案',
  }];
}

test('profile account is keyed only by phone and remains separate from other phones', async () => {
  const db = createDatabase();
  const profile = loadFunction('profile-manage', db);

  const firstLogin = await profile({ action: 'login', phone: '18600002610' }, { auth: { uid: 'gateway-a' } });
  assert.equal(firstLogin.ok, true);
  assert.equal(firstLogin.profile.accountId, '18600002610');

  const nickname = await profile({
    action: 'updateNickname',
    accountPhone: '18600002610',
    nickname: '晨骏爸爸',
  }, { auth: { uid: 'gateway-b' } });
  assert.equal(nickname.ok, true);

  const secondLogin = await profile({ action: 'login', phone: '13800138000' }, { auth: { uid: 'gateway-a' } });
  assert.equal(secondLogin.ok, true);
  assert.equal(secondLogin.profile.nickname, '');

  const firstProfile = await profile({ action: 'get', accountPhone: '18600002610' }, {});
  assert.equal(firstProfile.profile.nickname, '晨骏爸爸');
  assert.equal(db.stores.get('users').size, 2);
});

test('history is stored and queried directly by the phone account id', async () => {
  const db = createDatabase();
  const history = loadFunction('history-manage', db);

  const created = await history({
    action: 'create',
    accountPhone: '18600002610',
    title: '测试题集',
    questions: questions(),
  }, { auth: { uid: 'ignored-gateway-id' } });
  assert.equal(created.ok, true);

  const storedHistory = db.stores.get('quiz_history').get(created.id);
  assert.equal(storedHistory.owner_id, '18600002610');
  assert.equal('canonical_owner_id' in storedHistory, false);

  const ownList = await history({ action: 'list', accountPhone: '18600002610' }, {});
  const otherList = await history({ action: 'list', accountPhone: '13800138000' }, {});
  assert.equal(ownList.list.length, 1);
  assert.equal(otherList.list.length, 0);

  const attempt = await history({
    action: 'addAttempt',
    accountPhone: '18600002610',
    historyId: created.id,
    attemptId: 'attempt-1',
    score: 1,
    total: 1,
    wrongAnswers: [],
  }, {});
  assert.equal(attempt.ok, true);

  const storedAttempt = db.stores.get('quiz_attempts').get(attempt.id);
  assert.equal(storedAttempt.owner_id, '18600002610');
  assert.equal('canonical_owner_id' in storedAttempt, false);

  const detail = await history({
    action: 'detail',
    accountPhone: '18600002610',
    id: created.id,
  }, {});
  assert.equal(detail.history.attempts.length, 1);
  assert.equal(detail.history.practice_count, 1);
});

test('duplicate attempt repairs a summary left inconsistent by a partial write', async () => {
  const db = createDatabase();
  const history = loadFunction('history-manage', db);
  const accountPhone = '18600002610';
  const created = await history({
    action: 'create',
    accountPhone,
    title: '恢复测试',
    questions: questions(),
  }, {});

  db.failNextHistorySummaryUpdate();
  const payload = {
    action: 'addAttempt',
    accountPhone,
    historyId: created.id,
    attemptId: 'attempt-partial',
    score: 1,
    total: 1,
    wrongAnswers: [],
  };
  const partial = await history(payload, {});
  assert.equal(partial.ok, false);
  assert.equal(db.stores.get('quiz_attempts').size, 1);
  assert.equal(db.stores.get('quiz_history').get(created.id).practice_count, 0);

  const repaired = await history(payload, {});
  assert.equal(repaired.ok, true);
  assert.equal(repaired.duplicate, true);
  assert.equal(db.stores.get('quiz_attempts').size, 1);
  assert.equal(db.stores.get('quiz_history').get(created.id).practice_count, 1);
  assert.equal(db.stores.get('quiz_history').get(created.id).last_attempt.score, 1);
});

test('share ownership and friend results use the sharer phone account id', async () => {
  const db = createDatabase();
  const share = loadFunction('share-manage', db);
  const result = loadFunction('share-result', db);

  const saved = await share({
    action: 'save',
    accountPhone: '18600002610',
    trackAccount: true,
    name: '分享测试',
    questions: questions(),
  }, {});
  assert.equal(saved.ok, true);
  assert.equal(saved.tracked, true);

  const storedShare = db.stores.get('shares').get(saved.id);
  assert.equal(storedShare.owner_id, '18600002610');
  assert.equal('canonical_owner_id' in storedShare, false);

  const friend = await result({
    action: 'save',
    accountPhone: '13800138000',
    shareId: saved.id,
    attemptId: 'friend-attempt-1',
    nickname: '好友',
    score: 1,
    total: 1,
    wrongAnswers: [],
  }, {});
  assert.equal(friend.ok, true);

  const storedResult = db.stores.get('share_results').get(friend.id);
  assert.equal(storedResult.sharer_id, '18600002610');
  assert.equal(storedResult.participant_id, '13800138000');
  assert.equal('canonical_owner_id' in storedResult, false);

  const listed = await result({
    action: 'list',
    accountPhone: '18600002610',
    shareId: saved.id,
  }, {});
  assert.equal(listed.ok, true);
  assert.equal(listed.results.length, 1);
  assert.equal(listed.results[0].nickname, '好友');

  const denied = await result({
    action: 'list',
    accountPhone: '13800138000',
    shareId: saved.id,
  }, {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error, '无权查看');
});

test('phone-auth remains disabled without provider placeholders', async () => {
  const db = createDatabase();
  const phoneAuth = loadFunction('phone-auth', db);
  const response = await phoneAuth({ action: 'verify' }, {});

  assert.equal(response.ok, false);
  assert.equal(response.code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(response.fallback, true);
});
