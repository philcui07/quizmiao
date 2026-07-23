const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadApp(overrides = {}) {
  const elements = new Map();
  const document = {
    addEventListener() {},
    querySelectorAll() { return []; },
    createElement() {
      return { classList: { add() {} }, dataset: {}, style: {}, appendChild() {} };
    },
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          classList: { add() {}, remove() {}, toggle() {} },
          dataset: {},
          style: {},
          appendChild() {},
          value: '',
          textContent: '',
          innerHTML: '',
          disabled: false,
          focus() {},
        });
      }
      return elements.get(id);
    },
  };
  const context = vm.createContext({
    AbortController,
    console,
    crypto: globalThis.crypto,
    document,
    localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: {
      history: { replaceState() {} },
      location: { hash: '', origin: 'https://example.com', pathname: '/' },
      scrollTo() {},
    },
    PhoneAuth: {
      getStatus() { return { available: false, reason: '当前未配置运营商一键认证' }; },
    },
    ...overrides,
  });

  const storeSource = fs.readFileSync(path.join(root, 'docs/js/store.js'), 'utf8');
  vm.runInContext(storeSource + '\n;globalThis.__Store = Store;', context);
  const appSource = fs.readFileSync(path.join(root, 'docs/js/app.js'), 'utf8');
  vm.runInContext(appSource + '\n;globalThis.__App = App;', context);
  return { App: context.__App, Store: context.__Store, context, elements };
}

function sampleQuestions() {
  return [{
    cat: '测试',
    q: '哪一个选项正确？',
    options: ['甲', '乙', '丙', '丁'],
    answer: 0,
    exp: '甲正确',
  }];
}

test('preparePool creates a new id and resets save state for each retry', () => {
  const { Store } = loadApp({ CB: {} });
  Store.questions = sampleQuestions();
  Store.attemptSaved = true;
  Store.preparePool();
  const firstId = Store.attemptId;
  assert.match(firstId, /^attempt_/);
  assert.equal(Store.attemptSaved, false);
  Store.attemptSaved = true;
  Store.preparePool();
  assert.notEqual(Store.attemptId, firstId);
  assert.equal(Store.attemptSaved, false);
});

test('one quiz session creates only one history record', async () => {
  let createCalls = 0;
  const CB = {
    async createQuizHistory() {
      createCalls++;
      await Promise.resolve();
      return { ok: true, id: 'history-1' };
    },
  };
  const { App, Store } = loadApp({ CB });
  Store.user = { uid: 'user-1' };
  Store.quizSource = 'self';
  Store.questions = sampleQuestions();
  Store.resetHistoryState();

  const [first, second] = await Promise.all([
    App.pages.confirm._ensureHistoryRecord(),
    App.pages.confirm._ensureHistoryRecord(),
  ]);
  assert.equal(first, 'history-1');
  assert.equal(second, 'history-1');
  assert.equal(createCalls, 1);
  assert.equal(Store.historyId, 'history-1');
});

test('result rendering saves a self attempt once', async () => {
  let attemptCalls = 0;
  const CB = {
    async addHistoryAttempt(payload) {
      attemptCalls++;
      assert.equal(payload.historyId, 'history-1');
      assert.equal(payload.score, 1);
      return { ok: true };
    },
  };
  const { App, Store } = loadApp({ CB });
  Store.user = { uid: 'user-1' };
  Store.quizSource = 'self';
  Store.historyId = 'history-1';
  Store.questions = sampleQuestions();
  Store.pool = sampleQuestions();
  Store.score = 1;
  Store.wrong = [];
  Store.attemptId = 'attempt-1';
  Store.attemptSaved = false;

  await App.pages.result._saveResult();
  await App.pages.result._saveResult();
  assert.equal(attemptCalls, 1);
});

test('shared result keeps the participant nickname and attempt id', async () => {
  let savedPayload;
  const CB = {
    getShareNickname() { return '本机昵称'; },
    async saveShareResult(payload) { savedPayload = payload; return { ok: true }; },
  };
  const { App, Store } = loadApp({ CB });
  Store.quizSource = 'shared';
  Store.shareId = 'share-1';
  Store.shareNickname = '';
  Store.questions = sampleQuestions();
  Store.pool = sampleQuestions();
  Store.score = 0;
  Store.wrong = [{ q: '错题' }];
  Store.attemptId = 'attempt-shared';
  Store.attemptSaved = false;

  await App.pages.result._saveResult();
  assert.equal(savedPayload.shareId, 'share-1');
  assert.equal(savedPayload.attemptId, 'attempt-shared');
  assert.equal(savedPayload.nickname, '本机昵称');
});

test('attempt renderer escapes nickname and exposes score details', () => {
  const { App } = loadApp({ CB: {} });
  const html = App.pages.history._renderAttempts([{
    nickname: '<script>',
    score: 4,
    total: 5,
    wrong_answers: [],
    created_at: Date.now(),
  }], true);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /4\/5/);
  assert.match(html, /80%/);
  assert.doesNotMatch(html, /<script>/);
});

test('logged-out history navigation opens login and keeps a return route', () => {
  const { App, Store, elements } = loadApp({ CB: {} });
  Store.user = null;

  const navigated = App.navigateTo('history');

  assert.equal(navigated, false);
  assert.deepEqual(Array.from(App._history), ['index']);
  assert.equal(App._pendingRoute, 'history');
  assert.equal(elements.get('login-modal').style.display, '');
  assert.equal(elements.get('manual-login-panel').style.display, '');
  assert.equal(elements.get('one-click-login-btn').disabled, true);
});

test('manual device login returns to the guarded history page', async () => {
  const CB = {
    getNickname() { return ''; },
    async loginWithManualPhone(phone) {
      assert.equal(phone, '13800138000');
      return {
        ok: true,
        user: { uid: 'device-1', phone, phoneVerified: false, identityScope: 'device' },
      };
    },
    async listHistory() { return { ok: true, list: [], hasMore: false }; },
  };
  const { App, Store, elements } = loadApp({ CB });
  App.navigateTo('history');
  elements.get('login-phone').value = '13800138000';

  await App.doManualLogin();

  assert.equal(Store.user.uid, 'device-1');
  assert.equal(Store.user.phoneVerified, false);
  assert.equal(App._history[App._history.length - 1], 'history');
  assert.equal(App._pendingRoute, null);
  assert.equal(elements.get('login-modal').style.display, 'none');
});

test('history entry stays visible before login', () => {
  const { App, Store, elements } = loadApp({ CB: {} });
  Store.user = null;
  App._updateLoginUI();
  assert.equal(elements.get('history-entry').style.display, '');
});

test('manual phone login creates an anonymous CloudBase identity and stores phone as profile only', async () => {
  const values = new Map();
  const calls = [];
  let loginState = null;
  const auth = {
    async getLoginState() { return loginState; },
    async hasLoginState() { return loginState; },
    async signInAnonymously() { loginState = { user: { uid: 'secure-device-id' } }; },
  };
  const cloudbase = {
    init() {
      return {
        auth() { return auth; },
        async callFunction({ name, data }) {
          calls.push({ name, data });
          if (name === 'profile-manage' && data.action === 'updatePhone') {
            return { result: { ok: true } };
          }
          if (name === 'profile-manage' && data.action === 'get') {
            return {
              result: {
                ok: true,
                profile: { onboarded: true, phone: '13800138000', phoneVerified: false, nickname: '' },
              },
            };
          }
          throw new Error('unexpected cloud function');
        },
      };
    },
  };
  const context = vm.createContext({
    cloudbase,
    console,
    globalThis: null,
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); },
    },
  });
  context.globalThis = context;
  const source = fs.readFileSync(path.join(root, 'docs/js/cloudbase.js'), 'utf8');
  vm.runInContext(source + '\n;globalThis.__CB = CB;', context);

  const result = await context.__CB.loginWithManualPhone('13800138000');

  assert.equal(result.ok, true);
  assert.equal(result.user.uid, 'secure-device-id');
  assert.equal(result.user.phoneVerified, false);
  assert.equal(calls[0].name, 'profile-manage');
  assert.equal(calls[0].data.action, 'updatePhone');
  assert.equal(calls[0].data.phone, '13800138000');
  assert.equal(values.get('quizmiao_account_active'), '1');
});

test('SMS verification UI and browser calls are removed', () => {
  const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'docs/js/app.js'), 'utf8');
  const cloudbaseSource = fs.readFileSync(path.join(root, 'docs/js/cloudbase.js'), 'utf8');
  assert.doesNotMatch(html, /login-code|验证码/);
  assert.doesNotMatch(appSource, /sendLoginCode|loginWithSMSCode|验证码/);
  assert.doesNotMatch(cloudbaseSource, /getVerification|signInWithSms|sendSMSCode/);
});

test('provider adapter returns only provider token data', async () => {
  const context = vm.createContext({ console, globalThis: null });
  context.globalThis = context;
  const configSource = fs.readFileSync(path.join(root, 'docs/js/phone-auth-config.js'), 'utf8');
  const adapterSource = fs.readFileSync(path.join(root, 'docs/js/phone-auth.js'), 'utf8');
  vm.runInContext(configSource + '\n' + adapterSource + '\n;globalThis.__PhoneAuth = PhoneAuth;', context);
  assert.equal(context.__PhoneAuth.getStatus().available, false);

  context.QUIZMIAO_PHONE_AUTH_CONFIG = { enabled: true, provider: 'mock', appId: 'public-app-id' };
  context.__PhoneAuth.registerAdapter('mock', {
    async authorize({ appId }) {
      assert.equal(appId, 'public-app-id');
      return { token: 'short-lived-token', metadata: { scene: 'login' } };
    },
  });

  const result = await context.__PhoneAuth.authorize();
  assert.equal(result.provider, 'mock');
  assert.equal(result.token, 'short-lived-token');
  assert.equal(result.metadata.scene, 'login');
  assert.equal(Object.hasOwn(result, 'phone'), false);
});

test('carrier authorization failure reveals manual phone fallback', async () => {
  const PhoneAuth = {
    getStatus() { return { available: true, provider: 'mock' }; },
    async authorize() { throw new Error('当前网络不支持一键认证'); },
  };
  const { App, elements } = loadApp({ CB: {}, PhoneAuth });
  App.openLoginModal();
  assert.equal(elements.get('manual-login-panel').style.display, 'none');

  await App.startOneClickLogin();

  assert.equal(elements.get('manual-login-panel').style.display, '');
  assert.equal(elements.get('manual-login-status').textContent, '当前网络不支持一键认证');
  assert.equal(elements.get('one-click-login-btn').disabled, false);
});
