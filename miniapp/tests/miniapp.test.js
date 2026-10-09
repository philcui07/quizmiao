const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadPage(relativePath, app, wx) {
  app.globalData = app.globalData || {};
  app.refreshUser = app.refreshUser || (async () => app.globalData.user || null);
  app.getPrivacySetting = app.getPrivacySetting || (async () => ({ needAuthorization: false, privacyContractName: '' }));
  app.callProxy = app.callProxy || (async () => ({ ok: false, error: 'not mocked' }));
  app.createId = app.createId || (prefix => prefix + '_test');
  let definition;
  const sandbox = {
    console,
    decodeURIComponent,
    getApp: () => app,
    Page: value => { definition = value; },
    setTimeout,
    clearTimeout,
    wx
  };
  vm.runInNewContext(read(relativePath), sandbox, { filename: relativePath });
  definition.data = JSON.parse(JSON.stringify(definition.data));
  definition.setData = update => Object.assign(definition.data, update);
  return definition;
}

function loadCloudFunctionModule(cloud) {
  const module = { exports: {} };
  const sandbox = {
    Buffer,
    console,
    URL,
    exports: module.exports,
    module,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      return require(name);
    },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(read('cloudfunctions/proxy/index.js'), sandbox, {
    filename: 'cloudfunctions/proxy/index.js'
  });
  return module.exports;
}

function loadCloudFunction(cloud) {
  return loadCloudFunctionModule(cloud).main;
}

function createWx() {
  const calls = [];
  const events = [];
  return {
    calls,
    events,
    cloud: {
      callFunction(options) { calls.push(options); }
    },
    hideLoading() { events.push('hideLoading'); },
    hideShareMenu() { events.push('hideShareMenu'); },
    navigateTo(options) { events.push(['navigateTo', options]); },
    previewImage(options) { events.push(['previewImage', options]); },
    showLoading(options) { events.push(['showLoading', options]); },
    showShareMenu(options) { events.push(['showShareMenu', options]); },
    showToast(options) { events.push(['showToast', options]); },
    setNavigationBarTitle(options) { events.push(['setNavigationBarTitle', options]); }
  };
}

function loadApp(wx) {
  let definition;
  vm.runInNewContext(read('miniprogram/app.js'), {
    App: value => { definition = value; },
    console,
    Math,
    Date,
    wx
  }, { filename: 'miniprogram/app.js' });
  return definition;
}

function createMemoryCloud() {
  const collections = new Map();
  let sequence = 0;
  let currentOpenid = '';

  function values(name) {
    if (!collections.has(name)) throw new Error('collection not found: ' + name);
    return collections.get(name);
  }

  function reference(name, filters) {
    let sorting = null;
    let maximum = Infinity;
    return {
      where(extra) { return reference(name, Object.assign({}, filters || {}, extra)); },
      orderBy(field, direction) { sorting = { field, direction }; return this; },
      limit(value) { maximum = value; return this; },
      async get() {
        let list = Array.from(values(name).values()).filter(item => Object.entries(filters || {}).every(([key, value]) => item[key] === value));
        if (sorting) list.sort((a, b) => (a[sorting.field] - b[sorting.field]) * (sorting.direction === 'desc' ? -1 : 1));
        return { data: list.slice(0, maximum).map(item => Object.assign({}, item)) };
      },
      async add(options) {
        const id = name + '_' + (++sequence);
        values(name).set(id, Object.assign({ _id: id }, options.data));
        return { _id: id };
      },
      doc(id) {
        return {
          async get() {
            const item = values(name).get(id);
            if (!item) throw new Error('document not found');
            return { data: Object.assign({}, item) };
          },
          async set(options) {
            values(name).set(id, Object.assign({ _id: id }, options.data));
            return { _id: id };
          },
          async update(options) {
            const current = values(name).get(id);
            if (!current) throw new Error('document not found');
            const update = {};
            Object.entries(options.data).forEach(([key, value]) => {
              update[key] = value && value.__inc !== undefined ? (Number(current[key]) || 0) + value.__inc : value;
            });
            values(name).set(id, Object.assign({}, current, update));
            return { updated: 1 };
          }
        };
      }
    };
  }

  const db = {
    command: { inc: value => ({ __inc: value }) },
    serverDate: () => Date.now(),
    async createCollection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
    },
    collection(name) { return reference(name); }
  };

  return {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() { return db; },
    getWXContext() { return { OPENID: currentOpenid }; },
    setOpenid(value) { currentOpenid = value; },
    openapi: {
      phonenumber: {
        async getPhoneNumber({ code }) {
          if (!/^phone-code-/.test(code)) throw new Error('invalid phone code');
          return { phoneInfo: { phoneNumber: code.slice(11), countryCode: '86' } };
        }
      }
    },
    _collections: collections
  };
}

function question(cat, label) {
  return {
    cat,
    q: label,
    options: ['A', 'B', 'C', 'D'],
    answer: 0,
    exp: 'explanation'
  };
}

test('home displays v1.1.0 and only offers 5, 10, and 20 questions', () => {
  let page;
  vm.runInNewContext(read('miniprogram/pages/index/index.js'), {
    Page: value => { page = value; },
    getApp: () => ({}),
    wx: {},
    console
  });

  assert.deepEqual(Array.from(page.data.qtyOptions), ['5', '10', '20']);
  assert.equal(page.data.qtyDisplay, '10');

  const wxml = read('miniprogram/pages/index/index.wxml');
  assert.match(wxml, /<view class="footer-text">拾知猫 · v1\.1\.0<\/view>/);
  assert.doesNotMatch(wxml, /AI 驱动|无需配置/);
  assert.doesNotMatch(wxml, /&#10;/);
});

test('manual textarea and model input share a 16000-character scrollable limit', async () => {
  const sample = read('tests/fixtures/embodied-data.txt').trim();
  const doubled = sample + '\n\n' + sample;
  const app = { globalData: {} };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/index/index.js', app, wx);
  const updates = [];
  page.setData = update => {
    updates.push(update);
    Object.assign(page.data, update);
  };

  const pasted = page.onManualInput({ detail: { value: doubled } });
  assert.equal(sample.length < 8000, true);
  assert.equal(doubled.length < 16000, true);
  assert.equal(pasted, doubled);
  assert.equal(page.data.manualText, doubled);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(page.data.manualTextLength, doubled.length);
  assert.equal(Object.hasOwn(updates[0], 'manualText'), false);
  await page.startGenerate();
  assert.equal(app.globalData.pendingContent, doubled);

  const deleted = page.onManualInput({ detail: { value: '' } });
  assert.equal(deleted, '');
  assert.equal(page.data.manualText, '');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(page.data.manualTextLength, 0);
  assert.equal(Object.hasOwn(updates.at(-1), 'manualText'), false);

  const wxml = read('miniprogram/pages/index/index.wxml');
  const style = read('miniprogram/pages/index/index.wxss');
  assert.match(wxml, /maxlength="\{\{inputMaxLength\}\}"/);
  assert.match(wxml, /disable-default-padding="\{\{true\}\}"/);
  assert.doesNotMatch(wxml, /value="\{\{manualText\}\}"/);
  assert.match(wxml, /hidden="\{\{inputTab!=='text'\}\}"/);
  assert.doesNotMatch(wxml, /auto-height/);
  assert.match(style, /\.manual-input-shell\s*\{[^}]*height:\s*220px[^}]*padding:\s*12px 12px 18px/s);
  assert.match(style, /\.manual-input-area\s*\{[^}]*height:\s*100%[^}]*padding:\s*0[^}]*overflow-y:\s*auto/s);
});

test('cloud proxy requests 150 percent candidates in separate sections and truncates to target', () => {
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext() { return {}; }
  };
  const proxy = loadCloudFunctionModule(cloud).__test;

  assert.deepEqual(Array.from(proxy.buildLLMBatchSizes(15)), [2, 2, 2, 2, 2, 2, 2, 1]);

  const source = Array.from({ length: 10 }, (_, index) =>
    `${index + 1}. knowledge ${index + 1}\nExplanation and example ${index + 1}.`
  ).join('\n\n');
  const sections = Array.from(proxy.splitLLMContent(source, 8));
  assert.equal(sections.length, 8);
  assert.equal(sections.reduce((total, section) => total + (section.match(/^\d+\. /gm) || []).length, 0), 10);
  assert.equal(sections.join('\n\n').includes('10. knowledge 10'), true);

  const candidates = Array.from({ length: 5 }, (_, batchIndex) => ({
    ok: true,
    questions: Array.from({ length: 3 }, (_, questionIndex) => {
      const number = batchIndex * 3 + questionIndex + 1;
      return { q: `Question ${number}`, cat: `Category ${number}` };
    })
  }));
  candidates[4].questions[2] = { q: ' Question 1! ', cat: 'duplicate' };
  const merged = proxy.mergeLLMQuestions(candidates, 10);
  assert.equal(merged.length, 10);
  assert.deepEqual(Array.from(merged, item => item.q), Array.from({ length: 10 }, (_, index) => `Question ${index + 1}`));
});

test('link fetch normalizes difficult pasted URLs and selects safe reader fallbacks', () => {
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext() { return {}; }
  };
  const proxy = loadCloudFunctionModule(cloud).__test;
  const baike = 'https://baike.baidu.com/item/%E5%8E%86%E5%8F%B2%E4%B8%8A%E7%9A%84%E4%BB%8A%E5%A4%A9/4053008';

  assert.equal(proxy.normalizeSourceUrl(`[历史上的今天](${baike}，)`), baike);
  assert.equal(proxy.normalizeSourceUrl(baike + '%EF%BC%8C'), baike);
  assert.equal(proxy.normalizeSourceUrl('<https://example.com/lesson?q=1#part>'), 'https://example.com/lesson?q=1#part');
  assert.equal(proxy.normalizeSourceUrl('https://example.com/path，'), 'https://example.com/path');
  assert.equal(proxy.normalizeSourceUrl('ftp://example.com/file'), '');
  assert.equal(proxy.normalizeSourceUrl('http://localhost/secret'), '');
  assert.equal(proxy.normalizeSourceUrl('http://127.0.0.1/secret'), '');
  assert.equal(proxy.normalizeSourceUrl('http://192.168.1.20/secret'), '');
  assert.equal(proxy.normalizeSourceUrl('https://example.com:8443/lesson'), '');

  assert.equal(proxy.shouldUseReaderFirst(baike), true);
  assert.equal(proxy.rewriteFetchUrl(baike), baike.replace('baike.baidu.com', 'wapbaike.baidu.com'));
  assert.equal(proxy.shouldUseReaderFirst('https://example.com/lesson'), false);
  assert.equal(proxy.shouldFallbackToReader({ error: 'HTTP 403' }), true);
  assert.equal(proxy.shouldFallbackToReader({ error: 'JS_RENDERED' }), true);
  assert.equal(proxy.shouldFallbackToReader({ error: 'HTTP 404' }), false);

  const cleaned = proxy.cleanReaderContent(
    'Title: Lesson\n\nURL Source: https://example.com\n\nMarkdown Content:\n\n' +
    'Read [important concept](https://example.com/concept).\n\n![banner](https://example.com/a.png)'
  );
  assert.equal(cleaned, 'Read important concept.');
});

test('multiple link input continues when one source fails', async () => {
  const app = { globalData: {} };
  const wx = createWx();
  wx.cloud.callFunction = options => {
    const successful = options.data.url.includes('good.example');
    options.success({ result: successful
      ? { ok: true, text: 'A sufficiently long lesson from the working source.' }
      : { ok: false, error: 'HTTP 403' }
    });
  };
  const page = loadPage('miniprogram/pages/index/index.js', app, wx);
  page.setData({ inputTab: 'urls', urls: ['https://blocked.example/a', 'https://good.example/b'] });

  await page.startGenerate();

  assert.equal(app.globalData.pendingContent, 'A sufficiently long lesson from the working source.');
  assert.equal(app.globalData.pendingCount, 10);
  assert.equal(wx.events.some(event => Array.isArray(event) && event[0] === 'navigateTo' && event[1].url === '/pages/confirm/confirm'), true);
});

test('rapid paste then select-all delete cannot be overwritten by a stale counter update', async () => {
  const app = { globalData: {} };
  const page = loadPage('miniprogram/pages/index/index.js', app, createWx());
  const pasted = '最后一句也必须完整显示。'.repeat(600);

  assert.equal(page.onManualInput({ detail: { value: pasted } }), pasted);
  assert.equal(page.onManualInput({ detail: { value: '' } }), '');
  assert.equal(page.data.manualText, '');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(page.data.manualText, '');
  assert.equal(page.data.manualTextLength, 0);
});

test('profile waits for backend data before rendering one final state', async () => {
  let finish;
  const app = {
    globalData: {},
    maskPhone: phone => phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
    refreshUser: () => new Promise(resolve => { finish = resolve; })
  };
  const page = loadPage('miniprogram/pages/profile/profile.js', app, createWx());
  const showing = page.onShow();
  assert.equal(page.data.pageReady, false);
  finish({ phone: '13800138000', nickname: '老师' });
  await showing;
  assert.equal(page.data.pageReady, true);
  assert.equal(page.data.user.nickname, '老师');
});

test('history renders account cache first and refreshes it silently', async () => {
  const phone = '13800138000';
  const cached = [{ id: 'cached', title: '缓存题集', questionCount: 2, practiceCount: 1 }];
  const storage = { ['shizhimao_history_cache_' + phone]: { quizzes: cached, shares: [] } };
  let finish;
  const app = {
    globalData: { user: { phone } },
    refreshUser: async () => ({ phone }),
    callProxy: () => new Promise(resolve => { finish = resolve; })
  };
  const wx = createWx();
  wx.getStorageSync = key => storage[key];
  wx.setStorageSync = (key, value) => { storage[key] = value; };
  const page = loadPage('miniprogram/pages/history/history.js', app, wx);
  await page.initialize();
  assert.equal(page.data.pageReady, true);
  assert.equal(page.data.quizzes[0].title, '缓存题集');
  assert.equal(page.data.loading, false);
  finish({
    ok: true,
    quizzes: [{ id: 'fresh', title: '后端新题集', questionCount: 3, practiceCount: 0 }],
    shares: [{ id: 'share-fresh', name: '后端新分享', questionCount: 3, resultCount: 1 }]
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.quizzes[0].title, '后端新题集');
  assert.equal(page.data.shares[0].name, '后端新分享');
});

test('history fetches both sub-tabs once and switching tabs makes no request', async () => {
  const calls = [];
  const phone = '13800138000';
  const app = {
    globalData: { user: { phone } },
    refreshUser: async () => ({ phone }),
    async callProxy(action, data) {
      calls.push([action, data]);
      return {
        ok: true,
        quizzes: [{ id: 'quiz-one', title: '题集一', questionCount: 10, practiceCount: 1 }],
        shares: [{ id: 'share-one', name: '分享一', questionCount: 10, resultCount: 2 }]
      };
    }
  };
  const wx = createWx();
  wx.getStorageSync = () => null;
  wx.setStorageSync = () => {};
  const page = loadPage('miniprogram/pages/history/history.js', app, wx);

  await page.initialize();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'historyOverview');
  assert.equal(calls[0][1].pageSize, 50);
  assert.equal(page.data.quizzes.length, 1);
  assert.equal(page.data.shares.length, 1);

  page.switchTab({ currentTarget: { dataset: { tab: 'shares' } } });
  page.switchTab({ currentTarget: { dataset: { tab: 'quizzes' } } });
  page.switchTab({ currentTarget: { dataset: { tab: 'shares' } } });
  assert.equal(calls.length, 1);
  assert.equal(page.data.tab, 'shares');
});

test('privacy contract name is normalized before the UI adds brackets', async () => {
  const wx = {
    cloud: { init() {}, callFunction() {} },
    getPrivacySetting(options) {
      options.success({
        needAuthorization: true,
        privacyContractName: '《拾知猫小程序隐私保护指引》'
      });
    },
    getStorageSync() { return true; }
  };
  const app = loadApp(wx);
  const privacy = await app.getPrivacySetting();
  assert.equal(privacy.needAuthorization, true);
  assert.equal(privacy.privacyContractName, '拾知猫小程序隐私保护指引');
});

test('miniapp v1.1.0 uses the Web visual structure for home and history', () => {
  const appStyle = read('miniprogram/app.wxss');
  const home = read('miniprogram/pages/index/index.wxml');
  const homeStyle = read('miniprogram/pages/index/index.wxss');
  const history = read('miniprogram/pages/history/history.wxml');
  const historyStyle = read('miniprogram/pages/history/history.wxss');
  const detail = read('miniprogram/pages/history-detail/history-detail.wxml');
  const detailStyle = read('miniprogram/pages/history-detail/history-detail.wxss');

  assert.match(appStyle, /--primary:\s*#07C160/);
  assert.match(appStyle, /--bg:\s*#F6F6F6/);
  assert.match(appStyle, /\.card\s*\{[^}]*border-radius:\s*12px[^}]*padding:\s*20px 16px[^}]*width:\s*calc\(100% - 32px\)[^}]*max-width:\s*500px/s);

  assert.match(home, /class="card index-card"/);
  assert.match(homeStyle, /@media \(max-width:\s*360px\)/);

  assert.match(history, /class="card history-head"/);
  assert.match(history, /class="history-tabs"/);
  assert.match(history, /class="history-card"/);
  assert.doesNotMatch(history, /<button class="history-card"/);
  assert.match(history, /class="tag tag-self">题集/);
  assert.match(history, /item\.expired \? '已过期' : '分享中'/);
  assert.match(detail, /bindtap="openRecord"/);
  assert.doesNotMatch(detail, /<button class="attempt-card"/);
  assert.doesNotMatch(detail, /class="attempt-wrong-list"/);
  assert.match(read('miniprogram/pages/record-detail/record-detail.wxml'), /class="wrong-card"/);
  assert.match(historyStyle, /\.history-tabs\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(historyStyle, /\.history-card\s*\{[^}]*width:\s*auto[^}]*max-width:\s*none[^}]*margin:\s*0 16px 10px[^}]*box-sizing:\s*border-box/s);
  assert.match(detailStyle, /\.attempt-card\s*\{[^}]*width:\s*auto[^}]*max-width:\s*none[^}]*margin:\s*0 16px 10px/s);
  assert.match(detailStyle, /\.history-actions \.btn\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s);
});

test('home and history detail use native navigation bars', () => {
  const homeConfig = JSON.parse(read('miniprogram/pages/index/index.json'));
  const appConfig = JSON.parse(read('miniprogram/app.json'));
  const home = read('miniprogram/pages/index/index.wxml');
  const history = read('miniprogram/pages/history/history.wxml');

  assert.notEqual(homeConfig.navigationStyle, 'custom');
  assert.doesNotMatch(home, /class="nav-bar"/);
  assert.equal(appConfig.pages.includes('pages/history-detail/history-detail'), true);
  assert.equal(appConfig.pages.includes('pages/record-detail/record-detail'), true);
  assert.doesNotMatch(history, /返回记录/);
});

test('share data becomes ready and produces the expected native share card', async () => {
  const app = {
    globalData: {
      questions: [
        question('语文', 'Q1'),
        question('数学', 'Q2')
      ]
    }
  };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, wx);

  const saving = page._saveForShare(app.globalData.questions, []);
  assert.equal(page.data.shareSaving, true);
  assert.equal(page.data.shareReady, false);
  wx.calls[0].success({ result: { ok: true, shareId: 'share-current' } });
  assert.equal(await saving, true);
  assert.equal(page.data.shareReady, true);
  assert.equal(page.data.shareSaving, false);

  const message = page.onShareAppMessage();
  assert.equal(message.title, '拾知猫 · 2道练习题');
  assert.equal(message.path, '/pages/confirm/confirm?shareId=share-current');
  assert.match(message.desc, /语文、数学/);
});

test('generated questions are not shareable until a share ID is saved', async () => {
  const app = { globalData: { pendingContent: null, pendingCount: null } };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, wx);
  const questions = [question('语文', 'Q1'), question('数学', 'Q2')];

  const generating = page.startGeneration('enough source content for a quiz', 2);
  wx.calls[0].success({ result: { ok: true, questions } });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(wx.calls[1].data.action, 'saveQuiz');
  assert.equal(page.data.loading, true);
  assert.equal(page.data.shareReady, false);
  assert.equal(page.data.shareSaving, true);

  wx.calls[1].success({ result: { ok: true, shareId: 'generated-share-id' } });
  await generating;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.shareReady, true);
  assert.equal(page.data.shareSaving, false);
  assert.equal(page.onShareAppMessage().path, '/pages/confirm/confirm?shareId=generated-share-id');
});

test('AI option labels are normalized before rendering and sharing', async () => {
  const app = { globalData: { pendingContent: null, pendingCount: null } };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, wx);
  const generated = [question('生物', '光合作用')];
  generated[0].options = ['A. 叶绿体', 'B、细胞核', 'C) 线粒体', 'D：液泡'];

  const generating = page.startGeneration('光合作用是绿色植物制造有机物并释放氧气的过程。', 1);
  wx.calls[0].success({ result: { ok: true, questions: generated } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(wx.calls[1].data.questions[0].options), ['叶绿体', '细胞核', '线粒体', '液泡']);
  wx.calls[1].success({ result: { ok: true, shareId: 'normalized-share' } });
  await generating;
  assert.deepEqual(Array.from(app.globalData.questions[0].options), ['叶绿体', '细胞核', '线粒体', '液泡']);
});

test('cloud-storage share IDs are safely encoded in the native share path', () => {
  const app = { globalData: { questions: [question('语文', 'Q1')] } };
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, createWx());
  const fileId = 'file:cloud://env.bucket/shared-quizzes/example.json';
  page.setData({ shareId: fileId, shareReady: true });

  const message = page.onShareAppMessage();
  assert.equal(
    message.path,
    '/pages/confirm/confirm?shareId=' + encodeURIComponent(fileId)
  );
  assert.equal(page._getShareId({ shareId: encodeURIComponent(fileId) }), fileId);
});

test('cloud function falls back to storage and restores shared questions', async () => {
  const questions = [question('语文', 'Shared Q1')];
  let storedPayload;
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    getWXContext() { return {}; },
    database() {
      return {
        collection() {
          return {
            add() { return Promise.reject(new Error('collection not found')); }
          };
        },
        serverDate() { return 'server-date'; }
      };
    },
    async uploadFile(options) {
      storedPayload = JSON.parse(options.fileContent.toString('utf8'));
      return { fileID: 'cloud://test.bucket/' + options.cloudPath };
    },
    async downloadFile() {
      return { fileContent: Buffer.from(JSON.stringify(storedPayload)) };
    }
  };
  const main = loadCloudFunction(cloud);

  const saved = await main({ action: 'saveQuiz', questions, tags: [] }, {});
  assert.equal(saved.ok, true);
  assert.match(saved.shareId, /^file:cloud:\/\/test\.bucket\/shared-quizzes\//);
  assert.equal(storedPayload.questions[0].q, 'Shared Q1');

  const loaded = await main({ action: 'getQuiz', shareId: saved.shareId }, {});
  assert.equal(loaded.ok, true);
  assert.equal(loaded.questions.length, 1);
  assert.equal(loaded.questions[0].q, 'Shared Q1');
});

test('a recipient opens the shared questions instead of the home page', async () => {
  const app = { globalData: {} };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, wx);
  const questions = [question('语文', 'Shared Q1'), question('数学', 'Shared Q2')];

  const loading = page.loadSharedQuiz('recipient-share-id');
  assert.equal(wx.calls[0].data.action, 'getQuiz');
  assert.equal(wx.calls[0].data.shareId, 'recipient-share-id');
  wx.calls[0].success({ result: { ok: true, questions, tags: [{ name: '语文', count: 1 }] } });
  await loading;

  assert.equal(page.data.loading, false);
  assert.equal(page.data.shareReady, true);
  assert.equal(page.data.shareId, 'recipient-share-id');
  assert.equal(page.data.questions.length, 2);
  assert.equal(page.data.renderCount, 2);
  assert.equal(app.globalData.questions.length, 2);
  assert.equal(wx.calls.length, 1);
  assert.equal(wx.calls.some(call => call.data.action === 'llm'), false);
});

test('preparing a named share marks it before the native share panel opens', async () => {
  const calls = [];
  const app = {
    globalData: { user: { phone: '13800138000' }, historyId: 'history-one' },
    async callProxy(action, data) { calls.push({ action, data }); return { ok: true }; }
  };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, wx);
  page.setData({
    questions: [question('语文', 'Q1')],
    tags: [{ name: '语文', count: 1 }],
    shareName: '立即可见分享'
  });

  const confirming = page.confirmShareName();
  assert.equal(wx.calls[0].data.action, 'saveQuiz');
  wx.calls[0].success({ result: { ok: true, shareId: 'share-now' } });
  await new Promise(resolve => setImmediate(resolve));
  await confirming;

  assert.equal(calls[0].action, 'shareMark');
  assert.equal(calls[0].data.shareId, 'share-now');
  assert.equal(page.data.pendingShare, true);
});

test('a stale save response cannot replace the latest shared quiz', async () => {
  const app = { globalData: { questions: [question('语文', 'Q1')] } };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/confirm/confirm.js', app, wx);

  const oldSave = page._saveForShare([question('旧题', 'old')], []);
  const newSave = page._saveForShare([question('新题', 'new')], []);

  wx.calls[1].success({ result: { ok: true, shareId: 'new-share-id' } });
  assert.equal(await newSave, true);
  wx.calls[0].success({ result: { ok: true, shareId: 'old-share-id' } });
  assert.equal(await oldSave, false);
  assert.equal(page.data.shareId, 'new-share-id');
  assert.equal(page.data.shareReady, true);
});

test('shared quiz IDs are parsed from cards and legacy scenes', () => {
  const page = loadPage(
    'miniprogram/pages/confirm/confirm.js',
    { globalData: { questions: [] } },
    createWx()
  );
  assert.equal(page._getShareId({ shareId: 'from-card' }), 'from-card');
  assert.equal(page._getShareId({ scene: encodeURIComponent('from-qr') }), 'from-qr');
  assert.equal(page._getShareId({ scene: encodeURIComponent('shareId=legacy') }), 'legacy');
});

test('share UI directly invokes native WeChat sharing without links or QR', () => {
  const wxml = read('miniprogram/pages/confirm/confirm.wxml');
  assert.match(wxml, /open-type="share"/);
  assert.match(wxml, /disabled="\{\{loading \|\| shareSaving \|\| !shareReady \|\| questions\.length === 0\}\}"/);
  assert.doesNotMatch(wxml, /share-modal|generateShareCode|show-menu-by-longpress/);

  const cloudFunction = read('cloudfunctions/proxy/index.js');
  assert.doesNotMatch(cloudFunction, /getShareCode|wxacode|getTempFileURL/);
  assert.match(cloudFunction, /fallback to cloud storage/);
  assert.match(cloudFunction, /cloud\.uploadFile/);
  assert.match(cloudFunction, /cloud\.downloadFile/);
});

test('manual phone login validates and persists the Web v1.1.0 account phone', async () => {
  let request;
  const storage = {};
  const wx = {
    cloud: {
      callFunction(options) {
        request = options.data;
        options.success({ result: { ok: true, profile: { phone: '13800138000', phoneVerified: false } } });
      }
    },
    getStorageSync(key) { return storage[key]; },
    removeStorageSync(key) { delete storage[key]; },
    setStorageSync(key, value) { storage[key] = value; }
  };
  const app = loadApp(wx);
  await assert.rejects(() => app.loginWithPhone('123'), /11 位手机号/);
  const result = await app.loginWithPhone('13800138000');

  assert.equal(request.action, 'profileLogin');
  assert.equal(request.accountPhone, '13800138000');
  assert.equal(storage.shizhimao_account_phone, '13800138000');
  assert.equal(result.profile.phoneVerified, false);
  assert.equal(result.registered, false);
});

test('cloud profile login uses the phone as the cross-device account ID', async () => {
  const cloud = createMemoryCloud();
  cloud.setOpenid('openid-owner-a');
  const main = loadCloudFunction(cloud);
  const result = await main({ action: 'profileLogin', accountPhone: '13800138000' }, {});

  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.equal(result.profile.phone, '13800138000');
  const users = Array.from(cloud._collections.get('users').values());
  assert.equal(users.length, 1);
  assert.equal(users[0].owner_openid, '13800138000');
  assert.equal(users[0].phone, '13800138000');
  assert.equal(result.profile.phoneVerified, false);

  cloud.setOpenid('openid-other-device');
  const again = await main({ action: 'profileLogin', accountPhone: '13800138000' }, {});
  assert.equal(again.ok, true);
  assert.equal(again.registered, false);
});

test('history is isolated by account phone and duplicate attempts are not counted twice', async () => {
  const cloud = createMemoryCloud();
  const main = loadCloudFunction(cloud);
  cloud.setOpenid('openid-owner-a');
  const owner = { accountPhone: '13800138000' };
  await main({ action: 'profileLogin', ...owner }, {});
  const created = await main({ action: 'historyCreate', ...owner, questions: [question('数学', '1+1?')] }, {});
  assert.equal(created.ok, true);

  const first = await main({
    action: 'historyAttemptAdd', ...owner, historyId: created.id, attemptId: 'attempt-once', score: 1, total: 1, wrongAnswers: []
  }, {});
  const duplicate = await main({
    action: 'historyAttemptAdd', ...owner, historyId: created.id, attemptId: 'attempt-once', score: 1, total: 1, wrongAnswers: []
  }, {});
  assert.equal(first.ok, true);
  assert.equal(duplicate.duplicate, true);

  // Even if the legacy aggregate field is stale, real attempt documents are authoritative.
  cloud._collections.get('quiz_history').get(created.id).practice_count = 0;

  const ownerList = await main({ action: 'historyList', ...owner }, {});
  assert.equal(ownerList.list.length, 1);
  assert.equal(ownerList.list[0].practiceCount, 1);
  const overview = await main({ action: 'historyOverview', ...owner }, {});
  assert.equal(overview.ok, true);
  assert.equal(overview.quizzes.length, 1);
  assert.equal(overview.shares.length, 0);
  const ownerDetail = await main({ action: 'historyDetail', ...owner, id: created.id }, {});
  assert.equal(ownerDetail.history.practiceCount, 1);

  cloud.setOpenid('openid-owner-second-device');
  const samePhoneOtherDevice = await main({ action: 'historyList', ...owner }, {});
  assert.equal(samePhoneOtherDevice.list.length, 1);
  assert.equal(samePhoneOtherDevice.list[0].id, created.id);

  cloud.setOpenid('openid-owner-b');
  const other = { accountPhone: '13900139000' };
  await main({ action: 'profileLogin', ...other }, {});
  const otherList = await main({ action: 'historyList', ...other }, {});
  const forbidden = await main({ action: 'historyDetail', ...other, id: created.id }, {});
  assert.equal(otherList.list.length, 0);
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.error, /无权/);
});

test('tracked shares accept anonymous results but expose them only to the owner', async () => {
  const cloud = createMemoryCloud();
  const main = loadCloudFunction(cloud);
  cloud.setOpenid('openid-sharer');
  const owner = { accountPhone: '13800138000' };
  await main({ action: 'profileLogin', ...owner }, {});
  const saved = await main({
    action: 'saveQuiz', ...owner, questions: [question('语文', '共享题')], tags: [], trackOwner: true, name: '分享题集'
  }, {});
  assert.equal(saved.tracked, true);
  const beforeShare = await main({ action: 'shareList', ...owner }, {});
  assert.equal(beforeShare.list.length, 0);
  const marked = await main({ action: 'shareMark', ...owner, shareId: saved.shareId }, {});
  assert.equal(marked.ok, true);
  const afterShare = await main({ action: 'shareList', ...owner }, {});
  assert.equal(afterShare.list.length, 1);

  cloud.setOpenid('');
  const submitted = await main({
    action: 'shareResultSave', shareId: saved.shareId, attemptId: 'friend-attempt', score: 0, total: 1,
    wrongAnswers: [{ cat: '语文', q: '共享题', picked: 'B', correct: 'A', exp: '解析' }]
  }, {});
  assert.equal(submitted.ok, true);

  // Real result documents remain authoritative when the legacy aggregate is stale.
  cloud._collections.get('shares').get(saved.shareId).result_count = 0;
  const accurateList = await main({ action: 'shareList', ...owner }, {});
  assert.equal(accurateList.list[0].resultCount, 1);

  cloud.setOpenid('openid-sharer');
  const ownerResults = await main({ action: 'shareResults', ...owner, shareId: saved.shareId }, {});
  assert.equal(ownerResults.ok, true);
  assert.equal(ownerResults.results.length, 1);
  assert.equal(ownerResults.results[0].participant, '匿名用户');
  assert.equal(ownerResults.results[0].wrongCount, 1);
  assert.equal(ownerResults.results[0].wrongAnswers, undefined);
  const resultDetail = await main({
    action: 'recordDetail', ...owner, type: 'share', id: ownerResults.results[0].id
  }, {});
  assert.equal(resultDetail.ok, true);
  assert.equal(resultDetail.record.wrongAnswers.length, 1);

  cloud.setOpenid('openid-other');
  await main({ action: 'profileLogin', accountPhone: '13900139000' }, {});
  const forbidden = await main({ action: 'shareResults', accountPhone: '13900139000', shareId: saved.shareId }, {});
  assert.equal(forbidden.ok, false);
});

test('result page saves one shared attempt and does not duplicate on repeated calls', async () => {
  const calls = [];
  const app = {
    globalData: {
      user: null,
      pool: [question('语文', '共享题')],
      score: 0,
      wrong: [],
      quizSource: 'shared',
      shareId: 'share-one',
      participantName: '小林',
      attemptId: 'attempt-one',
      attemptSaved: false
    },
    async callProxy(action, data) { calls.push({ action, data }); return { ok: true }; }
  };
  const page = loadPage('miniprogram/pages/result/result.js', app, createWx());
  await page.saveAttempt();
  await page.saveAttempt();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'shareResultSave');
  assert.equal(calls[0].data.shareId, 'share-one');
  assert.equal(calls[0].data.participantName, '小林');
});

test('Web-aligned share naming and participant nickname UI are present', () => {
  const wxml = read('miniprogram/pages/confirm/confirm.wxml');
  const js = read('miniprogram/pages/confirm/confirm.js');
  assert.match(wxml, /给这份练习起个名字/);
  assert.match(wxml, /maxlength="50"/);
  assert.match(wxml, /输入你的昵称（可选）/);
  assert.match(wxml, /maxlength="20"/);
  assert.match(wxml, /open-type="share"/);
  assert.match(js, /quizmiao_participant_name/);
  assert.match(js, /confirmParticipantName/);
});

test('tracked shares expire after 24 hours and preserve custom participant names', async () => {
  const cloud = createMemoryCloud();
  const main = loadCloudFunction(cloud);
  cloud.setOpenid('openid-expiry-owner');
  const owner = { accountPhone: '13800138000' };
  await main({ action: 'profileLogin', ...owner }, {});
  const saved = await main({
    action: 'saveQuiz', ...owner, questions: [question('英语', 'Expiry')], tags: [], trackOwner: true, name: '24小时分享'
  }, {});

  cloud.setOpenid('openid-friend');
  const submitted = await main({
    action: 'shareResultSave', shareId: saved.shareId, attemptId: 'named-attempt', participantName: '好友甲',
    score: 1, total: 1, wrongAnswers: []
  }, {});
  assert.equal(submitted.ok, true);

  cloud.setOpenid('openid-expiry-owner');
  const detail = await main({ action: 'shareResults', ...owner, shareId: saved.shareId }, {});
  assert.equal(detail.results[0].participant, '好友甲');
  assert.equal(detail.share.expiresAt - detail.share.createdAt, 24 * 60 * 60 * 1000);

  const record = cloud._collections.get('shares').get(saved.shareId);
  record.expires_at = Date.now() - 1;
  cloud.setOpenid('openid-friend');
  const expiredOpen = await main({ action: 'getQuiz', shareId: saved.shareId }, {});
  const expiredSubmit = await main({
    action: 'shareResultSave', shareId: saved.shareId, attemptId: 'late-attempt', score: 1, total: 1, wrongAnswers: []
  }, {});
  assert.equal(expiredOpen.ok, false);
  assert.match(expiredOpen.error, /已过期/);
  assert.equal(expiredSubmit.ok, false);
  assert.match(expiredSubmit.error, /已过期/);
});

test('history replay restores quiz state and starts a fresh attempt', () => {
  const app = {
    globalData: {},
    createId: () => 'attempt-history-replay'
  };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/history-detail/history-detail.js', app, wx);
  page.setData({
    detailType: 'quiz',
    detail: { id: 'history-one', questions: [question('数学', '历史题')] }
  });
  page.replay();
  assert.equal(app.globalData.historyId, 'history-one');
  assert.equal(app.globalData.quizSource, 'self');
  assert.equal(app.globalData.attemptId, 'attempt-history-replay');
  assert.equal(app.globalData.pool.length, 1);
  assert.equal(wx.events.at(-1)[0], 'navigateTo');
  assert.equal(wx.events.at(-1)[1].url, '/pages/practice/practice');
});

test('practice page shows the question without its category label', () => {
  const wxml = read('miniprogram/pages/practice/practice.wxml');
  const style = read('miniprogram/pages/practice/practice.wxss');
  assert.match(wxml, /class="q-text">\{\{currentQ\.q\}\}/);
  assert.doesNotMatch(wxml, /currentQ\.cat|q-tag/);
  assert.doesNotMatch(style, /\.q-tag/);
});

test('history page automatically opens Web-style login and detail keeps direct sharing', () => {
  const wxml = read('miniprogram/pages/history/history.wxml');
  const detail = read('miniprogram/pages/history-detail/history-detail.wxml');
  assert.match(wxml, /wx:elif="\{\{!user\}\}"/);
  assert.match(wxml, /wx:if="\{\{!pageReady\}\}"/);
  assert.match(wxml, /wx:if="\{\{loginModalVisible\}\}"/);
  assert.match(wxml, /class="login-phone-field"/);
  assert.match(wxml, /bindtap="submitPhoneLogin"/);
  assert.doesNotMatch(wxml, /open-type="getPhoneNumber"/);
  assert.match(detail, /open-type="share"/);
  assert.doesNotMatch(wxml + detail, /二维码|复制链接|generateShareCode/);
});

test('bottom navigation and My page provide Web-style account actions', () => {
  const appConfig = JSON.parse(read('miniprogram/app.json'));
  assert.equal(appConfig.__usePrivacyCheck__, undefined);
  assert.deepEqual(appConfig.tabBar.list.map(item => item.text), ['首页', '历史', '我的']);
  assert.deepEqual(appConfig.tabBar.list.map(item => item.pagePath), [
    'pages/index/index', 'pages/history/history', 'pages/profile/profile'
  ]);
  appConfig.tabBar.list.forEach(item => {
    assert.match(item.iconPath, /^assets\/tabbar\/.+\.png$/);
    assert.match(item.selectedIconPath, /^assets\/tabbar\/.+-active\.png$/);
    assert.equal(fs.existsSync(path.join(ROOT, 'miniprogram', item.iconPath)), true);
    assert.equal(fs.existsSync(path.join(ROOT, 'miniprogram', item.selectedIconPath)), true);
  });

  const home = read('miniprogram/pages/index/index.wxml');
  const history = read('miniprogram/pages/history/history.wxml');
  const profile = read('miniprogram/pages/profile/profile.wxml');
  const profileJs = read('miniprogram/pages/profile/profile.js');
  const profileStyle = read('miniprogram/pages/profile/profile.wxss');
  assert.doesNotMatch(home, /class="nav-bar"/);
  assert.equal(JSON.parse(read('miniprogram/pages/index/index.json')).navigationBarTitleText, '拾知猫');
  assert.doesNotMatch(home, /nav-login-btn|history-entry-card|登录拾知猫|修改昵称|退出登录/);
  assert.match(profile, /手机号登录/);
  assert.match(profile, /maxlength="11"/);
  assert.match(profile, /登录并继续/);
  assert.match(profile, /修改昵称/);
  assert.doesNotMatch(profile, /历史记录|查看我的题集与分享/);
  assert.doesNotMatch(profile, /class="menu-desc"|class="menu-value"/);
  assert.doesNotMatch(profile, /<button class="menu-row/);
  assert.doesNotMatch(profileJs, /openHistory/);
  assert.match(profileStyle, /\.menu-card\s*\{[^}]*padding:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(profileStyle, /\.menu-row\s*\{[^}]*width:\s*100%[^}]*padding:\s*12px 48px 12px 18px[^}]*justify-content:\s*flex-start[^}]*text-align:\s*left/s);
  assert.match(profileStyle, /\.menu-title\s*\{[^}]*width:\s*100%[^}]*text-align:\s*left/s);
  assert.match(profile, /退出登录/);
  assert.match(profileJs, /profileUpdateNickname/);
  assert.match(profileJs, /app\.logout\(\)/);
  for (const wxml of [home, history, profile]) assert.doesNotMatch(wxml, /getPhoneNumber|agreePrivacyAuthorization/);
});

test('My page completes login, nickname update, and logout', async () => {
  const calls = [];
  const app = {
    globalData: { user: null },
    maskPhone: phone => phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
    refreshUser: async () => app.globalData.user,
    async loginWithPhone(phone) {
      calls.push(['login', phone]);
      const profile = { phone, nickname: '', phoneVerified: false };
      app.globalData.user = profile;
      return { profile, registered: true };
    },
    async callProxy(action, data) {
      calls.push([action, data]);
      return { ok: true, profile: { phone: '13800138000', nickname: data.nickname, phoneVerified: false } };
    },
    logout() { calls.push(['logout']); app.globalData.user = null; }
  };
  const wx = createWx();
  wx.switchTab = options => wx.events.push(['switchTab', options]);
  const page = loadPage('miniprogram/pages/profile/profile.js', app, wx);

  page.setData({ loginPhone: '13800138000' });
  await page.submitPhoneLogin();
  assert.equal(page.data.user.phone, '13800138000');
  assert.equal(page.data.phoneDisplay, '138****8000');

  page.setData({ nicknameInput: '拾知用户', nicknameModalVisible: true });
  await page.saveNickname();
  assert.equal(page.data.user.nickname, '拾知用户');
  assert.equal(page.data.avatarText, '拾');

  page.logout();
  assert.equal(page.data.user, null);
  assert.equal(calls.at(-1)[0], 'logout');
});

test('history tab opens login automatically and loads records after login', async () => {
  const calls = [];
  const app = {
    globalData: { user: null },
    refreshUser: async () => app.globalData.user,
    async loginWithPhone(phone) {
      calls.push(['login', phone]);
      const profile = { phone, nickname: '', phoneVerified: false };
      app.globalData.user = profile;
      return { profile, registered: false };
    },
    async callProxy(action) {
      calls.push([action]);
      return { ok: true, quizzes: [], shares: [] };
    }
  };
  const wx = createWx();
  const page = loadPage('miniprogram/pages/history/history.js', app, wx);
  await page.onLoad();
  assert.equal(page.data.loginModalVisible, true);

  page.setData({ loginPhone: '13800138000' });
  await page.submitPhoneLogin();
  assert.equal(page.data.loginModalVisible, false);
  assert.equal(page.data.user.phone, '13800138000');
  assert.equal(calls.filter(call => call[0] === 'historyOverview').length, 1);
});

test('manual phone login reports successful first registration', async () => {
  const storage = {};
  const wx = {
    cloud: {
      callFunction(options) {
        options.success({
          result: {
            ok: true,
            registered: true,
            profile: { phone: '13800138000', phoneVerified: false }
          }
        });
      }
    },
    getStorageSync(key) { return storage[key]; },
    removeStorageSync(key) { delete storage[key]; },
    setStorageSync(key, value) { storage[key] = value; }
  };
  const app = loadApp(wx);
  const result = await app.loginWithPhone('13800138000');
  assert.equal(result.registered, true);
  assert.equal(result.profile.phone, '13800138000');
});
