/**
 * 拾知猫 v1.1.0 — Web 版主应用
 *
 * v1.1.0 新增功能：
 * 1. CloudBase 设备身份 + 运营商一键认证（手动手机号回退）
 * 2. 历史出题记录 + 练习成绩 + 错题集
 * 3. 分享命名 + 24h时效 + 被分享人昵称弹窗
 * 4. 分享链接答题记录同步给分享人
 */

const App = {
  _history: ['index'],
  _streamController: null,
  _shareData: null,
  _pendingRoute: null,

  /* ==============================================
     通用 UI 工具
     ============================================== */
  toast(msg, duration = 2000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  },

  showLoading(title, sub = '') {
    document.getElementById('loading-title').textContent = title;
    document.getElementById('loading-sub').textContent = sub;
    document.getElementById('loading-overlay').classList.add('show');
  },
  hideLoading() {
    document.getElementById('loading-overlay').classList.remove('show');
  },

  /* ==============================================
     页面导航
     ============================================== */
  navigateTo(page) {
    if (this._requiresAccount(page) && !Store.user) {
      this.openLoginModal({ returnTo: page });
      return false;
    }
    const current = this._history[this._history.length - 1];
    this._showPage(current, false);
    if (current === 'confirm') this._cancelStream();
    this._history.push(page);
    this._showPage(page, true);
    this._renderPage(page);
    this._updateNavBar();
    window.scrollTo(0, 0);
    return true;
  },

  _requiresAccount(page) {
    return ['history', 'history-detail', 'share-detail'].includes(page);
  },

  redirectTo(page) {
    const prev = this._history.pop();
    this._showPage(prev, false);
    if (prev === 'confirm') this._cancelStream();
    this._history.push(page);
    this._showPage(page, true);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  navigateBack(delta = 1) {
    while (delta > 0 && this._history.length > 1) {
      const prev = this._history.pop();
      if (prev === 'confirm') this._cancelStream();
      this._showPage(prev, false);
      delta--;
    }
    const current = this._history[this._history.length - 1];
    this._showPage(current, true);
    this._renderPage(current);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  goHome() {
    this._cancelStream();
    this._history.forEach(p => { if (p !== 'index') this._showPage(p, false); });
    this._history = ['index'];
    this._showPage('index', true);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  goConfirm() {
    this._history.forEach(p => this._showPage(p, false));
    this._history = ['index', 'confirm'];
    this._showPage('confirm', true);
    this.pages.confirm.render();
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  _showPage(page, show) {
    const el = document.getElementById('page-' + page);
    if (el) el.style.display = show ? '' : 'none';
  },

  _updateNavBar() {
    const back = document.getElementById('nav-back');
    if (back) {
      back.style.display = this._history.length > 1 ? 'flex' : 'none';
    }
  },

  _renderPage(page) {
    const renderers = {
      'confirm': () => this.pages.confirm.render(),
      'history': () => this.pages.history.render(),
    };
    if (renderers[page]) renderers[page]();
  },

  _cancelStream() {
    if (this._streamController) {
      this._streamController.abort();
      this._streamController = null;
    }
  },

  /* ==============================================
     v1.1.0: 登录系统
     ============================================== */

  openLoginModal({ returnTo = null } = {}) {
    this._pendingRoute = returnTo;
    document.getElementById('login-modal').style.display = '';
    document.getElementById('login-phone').value = '';
    const status = PhoneAuth.getStatus();
    const oneClickButton = document.getElementById('one-click-login-btn');
    oneClickButton.disabled = !status.available;
    oneClickButton.classList.remove('is-loading');
    document.getElementById('one-click-login-label').textContent = status.available ? '本机号码一键登录' : '一键登录暂不可用';
    document.getElementById('one-click-status').textContent = status.available ? '由运营商安全认证本机号码' : status.reason;
    document.getElementById('manual-login-toggle').style.display = status.available ? '' : 'none';
    document.getElementById('manual-login-panel').style.display = status.available ? 'none' : '';
  },

  closeLoginModal() {
    document.getElementById('login-modal').style.display = 'none';
    this._pendingRoute = null;
  },

  showManualLogin(reason = '') {
    document.getElementById('manual-login-toggle').style.display = 'none';
    document.getElementById('manual-login-panel').style.display = '';
    if (reason) document.getElementById('manual-login-status').textContent = reason;
    setTimeout(() => document.getElementById('login-phone').focus(), 50);
  },

  async startOneClickLogin() {
    const status = PhoneAuth.getStatus();
    if (!status.available) {
      this.showManualLogin(status.reason);
      return;
    }

    const button = document.getElementById('one-click-login-btn');
    button.disabled = true;
    button.classList.add('is-loading');
    document.getElementById('one-click-login-label').textContent = '正在安全认证...';

    let result;
    try {
      const authorization = await PhoneAuth.authorize();
      result = await CB.loginWithCarrier(authorization);
    } catch (e) {
      result = { ok: false, error: e.message || '一键认证失败' };
    }

    button.classList.remove('is-loading');
    if (!result.ok) {
      button.disabled = false;
      document.getElementById('one-click-login-label').textContent = '重新尝试一键登录';
      this.showManualLogin(result.error || '一键认证失败，请输入手机号继续');
      return;
    }
    this._completeLogin(result.user, true);
  },

  async doManualLogin() {
    const phone = document.getElementById('login-phone').value.trim();

    if (!phone || !/^1\d{10}$/.test(phone)) {
      this.toast('请输入正确的手机号');
      return;
    }

    this.showLoading('正在建立本机账号...');
    const result = await CB.loginWithManualPhone(phone);
    this.hideLoading();

    if (!result.ok) {
      this.toast(result.error || '登录失败');
      return;
    }
    this._completeLogin(result.user, false);
  },

  _completeLogin(user, verified) {
    const returnTo = this._pendingRoute;
    Store.user = user;
    document.getElementById('login-modal').style.display = 'none';
    this._pendingRoute = null;
    this._updateLoginUI();
    if (Store.quizSource === 'self' && Store.questions?.length) {
      this.pages.confirm._ensureHistoryRecord();
    }
    this.toast(verified ? '本机号码认证成功' : '已在当前设备登录');
    if (returnTo) this.navigateTo(returnTo);
  },

  async doLogout() {
    const result = await CB.logout();
    if (!result.ok) {
      this.toast(result.error || '退出失败');
      return;
    }
    Store.user = null;
    Store.resetHistoryState();
    this.closeAccountModal();
    if (this._requiresAccount(this._history[this._history.length - 1])) this.goHome();
    this._updateLoginUI();
    this.toast('已退出登录');
  },

  _updateLoginUI() {
    const userInfo = document.getElementById('user-info');
    const loginBtn = document.getElementById('login-btn');
    if (Store.user) {
      const phone = Store.user.phone ? Store.user.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '已登录';
      const nickname = CB.getNickname() || phone;
      if (userInfo) {
        userInfo.style.display = '';
        userInfo.textContent = nickname;
      }
      if (loginBtn) loginBtn.style.display = 'none';
    } else {
      if (userInfo) userInfo.style.display = 'none';
      if (loginBtn) loginBtn.style.display = '';
    }
    const historyEntry = document.getElementById('history-entry');
    if (historyEntry) historyEntry.style.display = '';
  },

  openHistory() {
    return this.navigateTo('history');
  },

  /* ==============================================
     v1.1.0: 昵称设置
     ============================================== */
  openNicknameModal() {
    document.getElementById('nickname-input').value = CB.getNickname();
    document.getElementById('nickname-modal').style.display = '';
  },

  openAccountModal() {
    if (!Store.user) {
      this.openLoginModal();
      return;
    }
    const phone = Store.user.phone ? Store.user.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '本机账号';
    document.getElementById('account-name').textContent = CB.getNickname() || '未设置昵称';
    document.getElementById('account-phone').textContent = phone + (Store.user.phoneVerified ? ' · 已认证' : ' · 当前设备');
    document.getElementById('account-modal').style.display = '';
  },

  closeAccountModal() {
    document.getElementById('account-modal').style.display = 'none';
  },

  openHistoryFromAccount() {
    this.closeAccountModal();
    this.openHistory();
  },

  openNicknameFromAccount() {
    this.closeAccountModal();
    this.openNicknameModal();
  },

  closeNicknameModal() {
    document.getElementById('nickname-modal').style.display = 'none';
  },

  async saveNickname() {
    const name = document.getElementById('nickname-input').value.trim();
    if (!name) {
      this.toast('请输入昵称');
      return;
    }
    this.showLoading('正在保存昵称...');
    let result;
    try {
      result = await CB.setNickname(name);
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    this.hideLoading();
    if (!result.ok) {
      this.toast(result.error || '昵称保存失败');
      return;
    }
    this.closeNicknameModal();
    this._updateLoginUI();
    this.toast('昵称已保存');
  },

  /* ==============================================
     v1.1.0: 分享命名弹窗
     ============================================== */
  openShareNameModal() {
    document.getElementById('share-name-input').value = '';
    const hint = document.getElementById('share-account-hint');
    if (hint) {
      hint.textContent = Store.user
        ? '好友完成后，答题记录会汇总到“我的分享”中'
        : '当前未登录：链接仍可使用，但好友答题记录不会归入账号';
      hint.classList.toggle('warning', !Store.user);
    }
    document.getElementById('share-name-modal').style.display = '';
    setTimeout(() => document.getElementById('share-name-input').focus(), 100);
  },

  closeShareNameModal() {
    document.getElementById('share-name-modal').style.display = 'none';
  },

  async confirmShareName(method) {
    const name = document.getElementById('share-name-input').value.trim();
    this.closeShareNameModal();
    if (method === 'link') {
      await this._doShareLink(name);
    } else {
      await this._doShareQR(name);
    }
  },

  /* ==============================================
     v1.1.0: 被分享人昵称弹窗
     ============================================== */
  openShareNicknamePrompt() {
    // 如果已经填过，自动填入
    const existing = CB.getShareNickname();
    if (existing) {
      // 已有昵称，跳过弹窗
      return existing;
    }
    // 显示弹窗
    document.getElementById('share-nickname-input').value = '';
    document.getElementById('share-nickname-modal').style.display = '';
    return null; // 返回 null 表示需要等用户输入
  },

  closeShareNicknamePrompt() {
    document.getElementById('share-nickname-modal').style.display = 'none';
  },

  skipShareNickname() {
    this.closeShareNicknamePrompt();
    // 继续做题流程
    this._proceedWithSharedQuiz('');
  },

  submitShareNickname() {
    const name = document.getElementById('share-nickname-input').value.trim();
    if (name) {
      CB.setShareNickname(name);
    }
    this.closeShareNicknamePrompt();
    this._proceedWithSharedQuiz(name);
  },

  _proceedWithSharedQuiz(nickname) {
    // 继续加载分享题目
    Store.shareNickname = nickname;
    this._loadSharedQuizData();
  },

  /* ==============================================
     分享功能
     ============================================== */
  async share() {
    // v1.1.0: 先弹窗让用户输入分享名称
    this.openShareNameModal();
  },

  /** 分享链接：后端存数据 → 短 ID → 复制到剪贴板 */
  async _doShareLink(shareName) {
    const qs = Store.questions || [];
    if (qs.length === 0) {
      this.toast('暂无题目可分享');
      return;
    }

    try {
      this.showLoading('正在生成分享链接...');
      const data = await CB.saveShare(qs, shareName);
      this.hideLoading();

      if (!data.ok || !data.id) {
        this.toast('分享失败，请重试');
        return;
      }

      const shortUrl = window.location.origin + window.location.pathname + '#s=' + data.id;
      await navigator.clipboard.writeText(shortUrl);
      this.toast(data.tracked
        ? '链接已复制，24 小时内有效；好友成绩将记入账号'
        : '链接已复制，24 小时内有效');
    } catch (e) {
      this.hideLoading();
      this.toast('分享失败：' + (e.message || '网络错误'));
    }
  },

  /** 分享二维码 */
  async _doShareQR(shareName) {
    const qs = Store.questions || [];
    if (qs.length === 0) {
      this.toast('暂无题目可分享');
      return;
    }

    try {
      this.showLoading('正在生成二维码...');
      const data = await CB.saveShare(qs, shareName);
      this.hideLoading();

      if (!data.ok || !data.id) {
        this.toast('分享失败，请重试');
        return;
      }

      const shortUrl = window.location.origin + window.location.pathname + '#s=' + data.id;
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(shortUrl);

      // 显示二维码
      document.getElementById('share-qr-img').src = qrUrl;
      document.getElementById('share-qr-caption').textContent = (shareName || '拾知猫') + ' · ' + qs.length + '道题';
      document.getElementById('share-qr-wrap').style.display = '';
      document.getElementById('share-modal').style.display = '';

      try {
        const imgResp = await fetch(qrUrl);
        const blob = await imgResp.blob();
        if (navigator.clipboard && navigator.clipboard.write) {
          const item = new ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
          this.toast('二维码已复制，可在任意聊天窗口粘贴');
        } else {
          this.toast('二维码已生成，请长按图片保存');
        }
      } catch (e) {
        this.toast('二维码已生成，请长按图片保存');
      }
    } catch (e) {
      this.hideLoading();
      this.toast('分享失败：' + (e.message || '网络错误'));
    }
  },

  openShareModal() {
    document.getElementById('share-qr-wrap').style.display = 'none';
    document.getElementById('share-modal').style.display = '';
  },

  closeShareModal() {
    document.getElementById('share-modal').style.display = 'none';
    document.getElementById('share-qr-wrap').style.display = 'none';
  },

  /* ==============================================
     页面逻辑
     ============================================== */
  pages: {

    /* ---- 首页 (index) ---- */
    index: {
      _urls: [''],
      _activeTab: 'text',

      init() {
        this._urls = [''];
        this._activeTab = 'text';
        this.renderUrls();
        document.getElementById('btn-generate').disabled = false;
        document.getElementById('btn-generate').textContent = '生成练习题';
        document.getElementById('index-error').style.display = 'none';
      },

      switchTab(tab) {
        this._activeTab = tab;
        document.querySelectorAll('.input-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.getElementById('tab-text').style.display = tab === 'text' ? '' : 'none';
        document.getElementById('tab-urls').style.display = tab === 'urls' ? '' : 'none';
      },

      addUrl() {
        this._urls.push('');
        this.renderUrls();
      },

      removeUrl(idx) {
        this._urls.splice(idx, 1);
        if (this._urls.length === 0) this._urls.push('');
        this.renderUrls();
      },

      onUrlInput(idx, value) {
        this._urls[idx] = value;
      },

      onQtyChange(val) {},

      renderUrls() {
        const container = document.getElementById('url-list');
        container.innerHTML = this._urls.map((url, i) => `
          <div class="url-row">
            <input class="input-area input-inline" value="${App._esc(url)}" placeholder="https://..."
              oninput="App.pages.index.onUrlInput(${i}, this.value)" />
            ${this._urls.length > 1 ? `<div class="url-del" onclick="App.pages.index.removeUrl(${i})">×</div>` : ''}
          </div>
        `).join('');
      },

      async startGenerate() {
        const manualText = document.getElementById('manual-text').value.trim();
        const urls = this._urls.map(u => u.trim()).filter(u => u.length > 0);
        const count = parseInt(document.getElementById('qty-select').value);
        const activeTab = this._activeTab || 'text';

        if (activeTab === 'text' && !manualText) {
          document.getElementById('index-error').textContent = '请粘贴文本内容';
          document.getElementById('index-error').style.display = '';
          return;
        }
        if (activeTab === 'urls' && urls.length === 0) {
          document.getElementById('index-error').textContent = '请添加至少一个链接';
          document.getElementById('index-error').style.display = '';
          return;
        }

        const btn = document.getElementById('btn-generate');
        btn.disabled = true;
        btn.textContent = '生成中...';
        document.getElementById('index-error').style.display = 'none';

        let content = '';

        try {
          if (activeTab === 'text') {
            content = manualText;
          } else {
            App.showLoading('正在抓取网页内容...');
            const fetchResults = await Promise.allSettled(
              urls.map(u => fetchPageContent(u))
            );
            App.hideLoading();
            let fetchedCount = 0;
            fetchResults.forEach((result, i) => {
              if (result.status === 'fulfilled' && result.value.ok && result.value.text) {
                content = content
                  ? content + '\n\n--- 来源 ' + (i + 1) + ' ---\n' + result.value.text
                  : result.value.text;
                fetchedCount++;
              }
            });
            if (fetchedCount === 0) {
              btn.disabled = false;
              btn.textContent = '生成练习题';
              document.getElementById('index-error').textContent = '所有网页抓取均失败，请检查链接是否有效';
              document.getElementById('index-error').style.display = '';
              return;
            }
          }

          if (!content || content.length < 20) {
            btn.disabled = false;
            btn.textContent = '生成练习题';
            document.getElementById('index-error').textContent = '获取内容太少（需 ≥20 字符），请增加输入';
            document.getElementById('index-error').style.display = '';
            return;
          }

          Store.questions = [];
          Store.resetHistoryState();
          Store.resetShareState();
          Store.quizSource = 'self';
          App.navigateTo('confirm');
          App.pages.confirm.startStreaming(content, count);

        } catch (err) {
          App.hideLoading();
          btn.disabled = false;
          btn.textContent = '生成练习题';
          const msg = err.message || '生成失败，请重试';
          document.getElementById('index-error').textContent = msg;
          document.getElementById('index-error').style.display = '';
          App.toast(msg, 3000);
        }
      }
    },

    /* ---- 确认页 (confirm) — 支持流式渲染 ---- */
    confirm: {
      _streaming: false,
      _total: 0,
      _rendered: 0,

      _updateTitle(state) {
        const title = document.getElementById('confirm-title');
        switch (state) {
          case 'loading':
            title.innerHTML = '<span class="dot-spinner inline-spinner"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> AI 正在出题，约 10~30 秒...';
            title.className = 'section-title section-title-loading';
            break;
          case 'progress':
            title.innerHTML = '✨ 已生成 <span id="confirm-count">' + this._rendered + '</span> / ' + this._total + ' 题';
            title.className = 'section-title';
            break;
          case 'done':
            const qs = Store.questions;
            title.innerHTML = '✅ 已生成 <span id="confirm-count">' + qs.length + '</span> 道题';
            title.className = 'section-title';
            break;
          case 'error':
            title.innerHTML = '⚠️ 出题失败';
            title.className = 'section-title';
            break;
        }
      },

      _updateProgress() {
        const pct = this._total > 0 ? Math.max(5, Math.round(this._rendered / this._total * 100)) : 5;
        document.getElementById('confirm-progress-bar').style.width = pct + '%';
      },

      _generateShareUrl(questions) {
        try {
          const json = JSON.stringify(questions);
          const encoded = btoa(unescape(encodeURIComponent(json)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          App._shareData = encoded;
        } catch (e) {
          App._shareData = null;
        }
      },

      startStreaming(content, count) {
        this._streaming = true;
        this._total = count;
        this._rendered = 0;
        Store.questions = [];
        App._shareData = null;

        document.getElementById('confirm-tags').innerHTML = '';
        document.getElementById('confirm-list').innerHTML = '';
        document.getElementById('btn-start-practice').disabled = true;
        document.getElementById('confirm-error').style.display = 'none';

        this._updateTitle('loading');
        document.getElementById('confirm-loading-sub').style.display = '';
        document.getElementById('confirm-progress').style.display = '';
        document.getElementById('confirm-progress-bar').style.width = '5%';

        App._streamController = streamGenerateQuestions(content, count, {
          onStart: (total) => {
            this._total = total;
          },
          onQuestion: (q, received) => {
            this._rendered = received;
            this._appendQuestion(q, received);
            this._updateTitle('progress');
            this._updateProgress();
          },
          onDone: (questions) => {
            if (questions.length === 0) {
              this._fallbackToNonStreaming(content, count);
              return;
            }
            this._finishStreaming(questions);
          },
          onError: (msg) => {
            this._streaming = false;
            App._streamController = null;

            if (Store.questions.length === 0) {
              this._fallbackToNonStreaming(content, count);
              return;
            }

            document.getElementById('confirm-progress').style.display = 'none';
            document.getElementById('confirm-loading-sub').style.display = 'none';
            if (Store.questions.length > 0) {
              this.render();
            } else {
              this._showError(msg || 'AI 出题失败，请重试');
            }

            const btn = document.getElementById('btn-generate');
            btn.disabled = false;
            btn.textContent = '生成练习题';
          }
        });
      },

      _finishStreaming(questions) {
        this._streaming = false;
        App._streamController = null;
        Store.questions = questions;

        this._updateTitle('done');
        document.getElementById('confirm-loading-sub').style.display = 'none';
        document.getElementById('confirm-progress').style.display = 'none';
        document.getElementById('btn-start-practice').disabled = questions.length === 0;
        this._updateTags(questions);
        this._generateShareUrl(questions);
        this._ensureHistoryRecord();

        if (questions.length === 0) {
          this._showError('AI 未生成有效题目，请增加内容后重试');
        }

        const btn = document.getElementById('btn-generate');
        btn.disabled = false;
        btn.textContent = '生成练习题';
      },

      async _fallbackToNonStreaming(content, count) {
        this._updateTitle('loading');
        document.getElementById('confirm-loading-sub').style.display = '';
        document.getElementById('confirm-progress').style.display = '';

        try {
          const resp = await generateQuestions(content, count);
          if (resp && resp.questions && resp.questions.length > 0) {
            Store.questions = resp.questions;
            this._streaming = false;
            this._rendered = resp.questions.length;
            this._total = resp.questions.length;

            document.getElementById('confirm-progress').style.display = 'none';
            document.getElementById('confirm-loading-sub').style.display = 'none';
            this.render();
            this._ensureHistoryRecord();

            const btn = document.getElementById('btn-generate');
            btn.disabled = false;
            btn.textContent = '生成练习题';
          } else {
            throw new Error(resp && resp.error ? resp.error : 'AI 未生成有效题目');
          }
        } catch (err) {
          this._streaming = false;
          document.getElementById('confirm-progress').style.display = 'none';
          document.getElementById('confirm-loading-sub').style.display = 'none';
          this._showError(err.message || 'AI 出题失败，请重试');

          const btn = document.getElementById('btn-generate');
          btn.disabled = false;
          btn.textContent = '生成练习题';
        }
      },

      _appendQuestion(q, count) {
        const list = document.getElementById('confirm-list');
        const i = count - 1;
        const letters = ['A', 'B', 'C', 'D'];

        const card = document.createElement('div');
        card.className = 'qconf-card qconf-card-enter';
        card.dataset.idx = i;
        card.innerHTML = `
          <div class="qconf-q">${i + 1}. [${App._esc(q.cat)}] ${App._esc(q.q)}</div>
          <div class="qconf-opts">${q.options.map((o, oi) =>
            `${App._esc(letters[oi])}. ${App._esc(o)}`
          ).join(' &nbsp;')}</div>
          <div class="qconf-ans">
            答案：${App._esc(letters[q.answer])}. ${App._esc(q.options[q.answer])}
          </div>
          <div class="qconf-del" onclick="App.pages.confirm.delQ(${i})">×</div>
        `;
        list.appendChild(card);

        Store.questions = Store.questions.concat([q]);
        this._updateTags(Store.questions);
      },

      _updateTags(questions) {
        const catMap = {};
        questions.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
        const tags = Object.entries(catMap).map(([name, count]) => ({ name, count }));
        document.getElementById('confirm-tags').innerHTML = tags.map(t =>
          `<span class="tag">${App._esc(t.name)} ×${t.count}</span>`
        ).join('');
      },

      _showError(msg) {
        this._updateTitle('error');
        document.getElementById('confirm-loading-sub').style.display = 'none';
        document.getElementById('confirm-progress').style.display = 'none';
        const el = document.getElementById('confirm-error');
        el.textContent = msg;
        el.style.display = '';
      },

      render() {
        const qs = Store.questions || [];
        document.getElementById('confirm-tags').innerHTML = '';
        document.getElementById('confirm-list').innerHTML = '';

        if (qs.length === 0) {
          document.getElementById('confirm-list').innerHTML = '<div class="msg" style="text-align:center;color:var(--text3)">暂无题目</div>';
          return;
        }

        this._updateTitle('done');
        this._updateTags(qs);

        const letters = ['A', 'B', 'C', 'D'];
        document.getElementById('confirm-list').innerHTML = qs.map((q, i) => `
          <div class="qconf-card qconf-card-enter">
            <div class="qconf-q">${i + 1}. [${App._esc(q.cat)}] ${App._esc(q.q)}</div>
            <div class="qconf-opts">${q.options.map((o, oi) =>
              `${App._esc(letters[oi])}. ${App._esc(o)}`
            ).join(' &nbsp;')}</div>
            <div class="qconf-ans">
              答案：${App._esc(letters[q.answer])}. ${App._esc(q.options[q.answer])}
            </div>
            <div class="qconf-del" onclick="App.pages.confirm.delQ(${i})">×</div>
          </div>
        `).join('');

        document.getElementById('confirm-progress').style.display = 'none';
        document.getElementById('confirm-loading-sub').style.display = 'none';
        document.getElementById('btn-start-practice').disabled = qs.length === 0;

        this._generateShareUrl(qs);
      },

      delQ(idx) {
        const qs = Store.questions;
        qs.splice(idx, 1);
        Store.questions = qs;
        if (qs.length === 0) {
          App.navigateBack();
          return;
        }
        this.render();
        this._syncHistoryQuestions();
      },

      _buildHistoryTitle() {
        const categories = [...new Set((Store.questions || []).map(q => q.cat).filter(Boolean))].slice(0, 3);
        return categories.length ? categories.join('、') : '未命名题集';
      },

      async _ensureHistoryRecord() {
        if (!Store.user || Store.quizSource !== 'self' || !Store.questions?.length) return null;
        if (Store.historyId) return Store.historyId;
        if (Store.historyCreatePromise) return Store.historyCreatePromise;

        const sessionId = Store.quizSessionId || Store.createId('quiz');
        Store.quizSessionId = sessionId;
        const questions = Store.questions.map((item) => ({ ...item, options: [...item.options] }));
        const createPromise = CB.createQuizHistory({
          questions,
          title: this._buildHistoryTitle(),
        }).then((result) => {
          if (!result.ok) throw new Error(result.error || '题集保存失败');
          if (Store.quizSessionId === sessionId) Store.historyId = result.id;
          return result.id;
        }).catch((e) => {
          console.warn('题集保存失败:', e);
          return null;
        }).finally(() => {
          if (Store.historyCreatePromise === createPromise) Store.historyCreatePromise = null;
        });
        Store.historyCreatePromise = createPromise;
        return createPromise;
      },

      async _syncHistoryQuestions() {
        const sessionId = Store.quizSessionId;
        const questions = Store.questions.map((item) => ({ ...item, options: [...item.options] }));
        const historyId = await this._ensureHistoryRecord();
        if (!historyId || Store.quizSessionId !== sessionId) return;
        try {
          await CB.updateQuizHistory(historyId, questions);
        } catch (e) {
          console.warn('题集更新失败:', e);
        }
      },

      startPractice() {
        if (this._streaming) return;

        this._ensureHistoryRecord();

        Store.preparePool();
        App.pages.practice.render();
        App.navigateTo('practice');
      }
    },

    /* ---- 练习页 (practice) ---- */
    practice: {
      _answered: false,
      _picked: -1,
      _currentQ: null,

      render() {
        const g = Store;
        if (!g.pool || g.idx >= g.pool.length) {
          App.pages.result.render();
          App.redirectTo('result');
          return;
        }

        this._answered = false;
        this._picked = -1;
        this._currentQ = g.pool[g.idx];

        const q = this._currentQ;
        const letters = ['A', 'B', 'C', 'D'];

        document.getElementById('prac-progress').textContent = `第 ${g.idx + 1}/${g.pool.length} 题`;
        document.getElementById('prac-score').textContent = `得分 ${g.score}`;
        document.getElementById('prac-bar').style.width = (g.idx / g.pool.length * 100) + '%';
        document.getElementById('prac-question').textContent = q.q;

        document.getElementById('prac-options').innerHTML = q.options.map((opt, i) => `
          <div class="option-item" onclick="App.pages.practice.choose(${i})" data-opt="${i}">
            <div class="opt-letter">${letters[i]}</div>
            <span>${App._esc(opt)}</span>
          </div>
        `).join('');

        document.getElementById('prac-feedback').style.display = 'none';
        document.getElementById('btn-next').disabled = true;
      },

      choose(i) {
        if (this._answered) return;
        this._answered = true;
        this._picked = i;

        const g = Store;
        const correct = i === this._currentQ.answer;

        if (correct) {
          g.score++;
        } else {
          g.wrong.push({
            q: this._currentQ.q,
            cat: this._currentQ.cat,
            picked: this._currentQ.options[i],
            correct: this._currentQ.options[this._currentQ.answer],
            exp: this._currentQ.exp
          });
        }

        const items = document.querySelectorAll('#prac-options .option-item');
        items.forEach((el, oi) => {
          if (oi === this._currentQ.answer) el.classList.add('correct');
          if (oi === i && oi !== this._currentQ.answer) el.classList.add('wrong');
        });

        document.getElementById('prac-feedback').style.display = '';
        const fbResult = document.getElementById('prac-fb-result');
        if (correct) {
          fbResult.className = 'fb-result right';
          fbResult.textContent = '✓ 正确！';
        } else {
          fbResult.className = 'fb-result wrong';
          fbResult.textContent = '✗ 错误';
        }
        document.getElementById('prac-fb-exp').textContent = '解析：' + this._currentQ.exp;
        document.getElementById('prac-score').textContent = `得分 ${g.score}`;

        document.getElementById('btn-next').disabled = false;
      },

      nextQ() {
        Store.idx++;
        if (Store.idx >= Store.pool.length) {
          App.pages.result.render();
          App.redirectTo('result');
          return;
        }
        this.render();
      }
    },

    /* ---- 结果页 (result) ---- */
    result: {
      render() {
        const g = Store;
        const total = g.pool ? g.pool.length : 0;
        const score = g.score || 0;
        const pct = total > 0 ? Math.round(score / total * 100) : 0;
        const wrong = g.wrong || [];

        document.getElementById('result-score').textContent = `${score}/${total}`;
        document.getElementById('result-pct').textContent = `正确率 ${pct}%`;

        let desc;
        if (pct === 100) desc = '太棒了，全对！🎉';
        else if (pct >= 80) desc = '表现不错！';
        else desc = '继续加油！';
        document.getElementById('result-desc').textContent = desc;

        if (wrong.length > 0) {
          document.getElementById('wrong-section').style.display = '';
          document.getElementById('wrong-count').textContent = wrong.length;
          document.getElementById('wrong-list').innerHTML = wrong.map((w, i) => `
            <div class="wrong-item">
              <div class="wq">${i + 1}. [${App._esc(w.cat)}] ${App._esc(w.q)}</div>
              <div>你的答案：<span class="wa">${App._esc(w.picked)}</span></div>
              <div>正确答案：<span class="wc">${App._esc(w.correct)}</span></div>
              <div class="we">${App._esc(w.exp)}</div>
            </div>
          `).join('');
        } else {
          document.getElementById('wrong-section').style.display = 'none';
        }

        // v1.1.0: 保存练习结果
        this._saveResult();
      },

      async _saveResult() {
        const g = Store;
        if (g.attemptSaved) return;
        if (!g.attemptId) g.attemptId = g.createId('attempt');
        g.attemptSaved = true;
        const snapshot = {
          attemptId: g.attemptId,
          score: g.score,
          total: g.pool?.length || 0,
          wrongAnswers: (g.wrong || []).map((item) => ({ ...item })),
        };

        // 自建题集：在同一题集下追加一次练习，而不是创建重复题集。
        if (Store.user && Store.quizSource === 'self') {
          const historyId = await App.pages.confirm._ensureHistoryRecord();
          if (historyId) {
            try {
              await CB.addHistoryAttempt({
                historyId,
                attemptId: snapshot.attemptId,
                score: snapshot.score,
                total: snapshot.total,
                wrongAnswers: snapshot.wrongAnswers,
              });
            } catch (e) {
              console.warn('保存练习结果失败:', e);
            }
          }
        }

        // 分享题集：保存给分享人；答题者无需登录。
        if (Store.quizSource === 'shared' && Store.shareId) {
          try {
            await CB.saveShareResult({
              shareId: Store.shareId,
              attemptId: snapshot.attemptId,
              nickname: Store.shareNickname || CB.getShareNickname() || '匿名用户',
              score: snapshot.score,
              total: snapshot.total,
              wrongAnswers: snapshot.wrongAnswers,
            });
          } catch (e) {
            console.warn('保存分享结果失败:', e);
          }
        }
      },

      retry() {
        Store.preparePool();
        App.pages.practice.render();
        App.redirectTo('practice');
      }
    },

    /* ---- v1.1.0: 历史记录页 (history) ---- */
    history: {
      _activeTab: 'quizzes',
      _page: 1,
      _list: [],
      _hasMore: false,
      _sharePage: 1,
      _shares: [],
      _sharesHasMore: false,

      async render() {
        if (!Store.user) {
          App.openLoginModal({ returnTo: 'history' });
          return;
        }
        await this.switchTab(this._activeTab, true);
      },

      async switchTab(tab, force = false) {
        if (!force && tab === this._activeTab) return;
        this._activeTab = tab;
        document.querySelectorAll('[data-history-tab]').forEach((item) => {
          item.classList.toggle('active', item.dataset.historyTab === tab);
        });
        document.getElementById('history-quizzes-panel').style.display = tab === 'quizzes' ? '' : 'none';
        document.getElementById('history-shares-panel').style.display = tab === 'shares' ? '' : 'none';
        if (tab === 'quizzes') await this.loadQuizzes();
        else await this.loadShares();
      },

      async loadQuizzes() {
        App.showLoading('加载题集记录...');
        try {
          const result = await CB.listHistory(1);
          if (!result.ok) throw new Error(result.error || '加载失败');
          this._page = 1;
          this._list = result.list || [];
          this._hasMore = result.hasMore;
          this._renderList();
        } catch (e) {
          App.toast(e.message || '加载失败');
        } finally {
          App.hideLoading();
        }
      },

      _renderList() {
        const container = document.getElementById('history-list');

        if (this._list.length === 0) {
          container.innerHTML = '<div class="empty-state">还没有题集记录</div>';
        } else {
          container.innerHTML = this._list.map((item) => {
            const dateStr = new Date(item.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const last = item.last_attempt;
            const lastSummary = last
              ? `<span class="history-score">最近 ${last.score}/${last.total}</span><span class="history-wrong">错 ${last.wrong_count} 题</span>`
              : '<span class="muted">尚未练习</span>';
            return `
              <button class="history-card" onclick="App.pages.history.viewDetail('${item.id}')">
                <span class="history-card-header"><span class="history-title">${App._esc(item.title)}</span><span class="tag tag-self">题集</span></span>
                <span class="history-stats"><span>${item.question_count} 道题</span><span>练习 ${item.practice_count} 次</span>${lastSummary}</span>
                <span class="history-date">${dateStr}</span>
              </button>`;
          }).join('');
        }

        const moreBtn = document.getElementById('history-load-more');
        if (moreBtn) moreBtn.style.display = this._hasMore ? '' : 'none';
      },

      async loadMore() {
        const result = await CB.listHistory(this._page + 1);
        if (result.ok) {
          this._page++;
          this._list = this._list.concat(result.list || []);
          this._hasMore = result.hasMore;
          this._renderList();
        }
      },

      async loadShares() {
        App.showLoading('加载分享记录...');
        try {
          const result = await CB.listMyShares(1);
          if (!result.ok) throw new Error(result.error || '加载失败');
          this._sharePage = 1;
          this._shares = result.shares || [];
          this._sharesHasMore = result.hasMore;
          this._renderShareList();
        } catch (e) {
          App.toast(e.message || '加载失败');
        } finally {
          App.hideLoading();
        }
      },

      _renderShareList() {
        const container = document.getElementById('share-history-list');
        if (this._shares.length === 0) {
          container.innerHTML = '<div class="empty-state">还没有账号内分享记录</div>';
        } else {
          container.innerHTML = this._shares.map((item) => {
            const dateStr = new Date(item.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `
              <button class="history-card" onclick="App.pages.history.viewShareResults('${item.id}')">
                <span class="history-card-header"><span class="history-title">${App._esc(item.name)}</span><span class="tag ${item.expired ? 'tag-expired' : 'tag-shared'}">${item.expired ? '已过期' : '分享中'}</span></span>
                <span class="history-stats"><span>${item.question_count} 道题</span><span>收到 ${item.result_count} 次答题</span></span>
                <span class="history-date">${dateStr}</span>
              </button>`;
          }).join('');
        }
        document.getElementById('shares-load-more').style.display = this._sharesHasMore ? '' : 'none';
      },

      async loadMoreShares() {
        const result = await CB.listMyShares(this._sharePage + 1);
        if (!result.ok) return App.toast(result.error || '加载失败');
        this._sharePage++;
        this._shares = this._shares.concat(result.shares || []);
        this._sharesHasMore = result.hasMore;
        this._renderShareList();
      },

      async viewDetail(id) {
        App.showLoading('加载题集详情...');
        try {
          const result = await CB.getHistoryDetail(id);
          if (!result.ok) throw new Error(result.error || '加载失败');
          const item = result.history;
          document.getElementById('history-detail-title').textContent = item.title;
          document.getElementById('history-detail-date').textContent = new Date(item.created_at).toLocaleString('zh-CN');
          document.getElementById('history-detail-meta').textContent = `${item.questions.length} 道题 · 已练习 ${item.practice_count} 次`;
          document.getElementById('history-attempt-list').innerHTML = this._renderAttempts(item.attempts || [], false);
          document.getElementById('history-detail-questions').innerHTML = this._renderQuestions(item.questions || []);
          App.navigateTo('history-detail');
        } catch (e) {
          App.toast(e.message || '加载失败');
        } finally {
          App.hideLoading();
        }
      },

      async viewShareResults(id) {
        App.showLoading('加载好友答题记录...');
        try {
          const result = await CB.listShareResults(id);
          if (!result.ok) throw new Error(result.error || '加载失败');
          document.getElementById('share-detail-title').textContent = result.share.name;
          document.getElementById('share-detail-date').textContent = new Date(result.share.created_at).toLocaleString('zh-CN');
          document.getElementById('share-detail-meta').textContent = `${result.share.questions.length} 道题 · 收到 ${result.results.length} 次答题`;
          document.getElementById('share-result-list').innerHTML = this._renderAttempts(result.results || [], true);
          document.getElementById('share-detail-questions').innerHTML = this._renderQuestions(result.share.questions || []);
          App.navigateTo('share-detail');
        } catch (e) {
          App.toast(e.message || '加载失败');
        } finally {
          App.hideLoading();
        }
      },

      _renderAttempts(attempts, showNickname) {
        if (!attempts.length) return '<div class="empty-state compact">暂无练习记录</div>';
        return attempts.map((attempt, index) => {
          const pct = attempt.total ? Math.round(attempt.score / attempt.total * 100) : 0;
          const wrong = attempt.wrong_answers || [];
          const wrongHtml = wrong.length ? wrong.map((item, wrongIndex) => `
            <div class="wrong-item">
              <div class="wq">${wrongIndex + 1}. [${App._esc(item.cat)}] ${App._esc(item.q)}</div>
              <div>作答：<span class="wa">${App._esc(item.picked)}</span></div>
              <div>正确：<span class="wc">${App._esc(item.correct)}</span></div>
              <div class="we">${App._esc(item.exp)}</div>
            </div>`).join('') : '<div class="attempt-perfect">本次全部答对</div>';
          const title = showNickname ? App._esc(attempt.nickname || '匿名用户') : `第 ${attempts.length - index} 次练习`;
          return `
            <details class="attempt-card" ${index === 0 ? 'open' : ''}>
              <summary>
                <span><strong>${title}</strong><small>${new Date(attempt.created_at).toLocaleString('zh-CN')}</small></span>
                <span class="attempt-score">${attempt.score}/${attempt.total}<small>${pct}% · 错 ${wrong.length} 题</small></span>
              </summary>
              <div class="attempt-wrong-list">${wrongHtml}</div>
            </details>`;
        }).join('');
      },

      _renderQuestions(questions) {
        const letters = ['A', 'B', 'C', 'D'];
        return questions.map((q, index) => `
          <div class="qconf-card">
            <div class="qconf-q">${index + 1}. [${App._esc(q.cat)}] ${App._esc(q.q)}</div>
            <div class="qconf-opts">${q.options.map((option, optionIndex) => `${letters[optionIndex]}. ${App._esc(option)}`).join(' · ')}</div>
            <div class="qconf-ans">答案：${letters[q.answer]}. ${App._esc(q.options[q.answer])}</div>
          </div>`).join('');
      },
    },
  },

  /* ==============================================
     工具函数
     ============================================== */
  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  /* ==============================================
     v1.1.0: 从 URL hash 加载分享的题目
     ============================================== */
  async _loadSharedQuiz() {
    const hash = window.location.hash;
    if (!hash) return;

    // 新版短链接: #s=ABC123
    if (hash.startsWith('#s=')) {
      const id = hash.slice(3);
      if (!id) return;

      try {
        App.showLoading('正在加载分享内容...');
        const data = await CB.getShare(id);
        App.hideLoading();

        if (!data.ok || !Array.isArray(data.questions) || data.questions.length === 0) {
          App.toast(data.error || '分享内容已过期或不存在');
          return;
        }

        // 设置分享状态
        Store.resetHistoryState();
        Store.questions = data.questions;
        Store.quizSource = 'shared';
        Store.shareId = id;
        Store.shareName = data.name || '';

        // v1.1.0: 被分享人昵称弹窗
        const existingNickname = CB.getShareNickname();
        if (existingNickname) {
          // 已有昵称，直接继续
          Store.shareNickname = existingNickname;
          this._showSharedQuizPage();
        } else {
          // 首次打开，弹窗让用户输入昵称（可跳过）
          document.getElementById('share-nickname-input').value = '';
          document.getElementById('share-nickname-modal').style.display = '';
        }

        // 清除 hash
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname);
        }
      } catch (e) {
        App.hideLoading();
        App.toast('加载分享内容失败');
      }
      return;
    }

    // 旧版 base64 链接: #q=base64（兼容 v1.0.1）
    if (hash.startsWith('#q=')) {
      const encoded = hash.slice(3);
      try {
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const json = decodeURIComponent(escape(atob(base64)));
        const questions = JSON.parse(json);

        if (Array.isArray(questions) && questions.length > 0) {
          Store.resetHistoryState();
          Store.resetShareState();
          Store.questions = questions;
          Store.quizSource = 'self'; // 旧版链接没有分享人
          App._shareData = encoded;

          this._history = ['index', 'confirm'];
          this._showPage('index', false);
          this._showPage('confirm', true);
          this.pages.confirm.render();
          this._updateNavBar();
          window.scrollTo(0, 0);

          if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', window.location.pathname);
          }
        }
      } catch (e) {
        console.warn('加载旧版分享题目失败:', e);
      }
    }
  },

  // 显示分享题目到确认页
  _showSharedQuizPage() {
    this._history = ['index', 'confirm'];
    this._showPage('index', false);
    this._showPage('confirm', true);
    this.pages.confirm.render();
    this._updateNavBar();
    window.scrollTo(0, 0);
  },
};

/* ---- 初始化 ---- */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    CB.init();
    const loggedIn = await CB.isLoggedIn();
    if (loggedIn) {
      Store.user = await CB.getCurrentUser();
    }
  } catch (e) {
    console.error('[CloudBase] init failed:', e);
    App.toast('服务连接失败，请稍后刷新重试', 3000);
  }
  App._updateLoginUI();

  // 检查是否为分享链接
  if (window.location.hash && (window.location.hash.startsWith('#s=') || window.location.hash.startsWith('#q='))) {
    await App._loadSharedQuiz();
  } else {
    App.pages.index.init();
  }
});
