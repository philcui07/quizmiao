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
