/**
 * 出题喵喵 QuizMiao — Web 版主应用
 * 对应小程序 pages 组件 + 导航系统
 *
 * 页面路由: index / confirm / practice / result
 * 对应小程序的: wx.navigateTo / wx.redirectTo / wx.navigateBack
 */

const App = {
  /* ---- 导航历史 (模拟页面栈) ---- */
  _history: ['index'],

  /* ---- 流式请求控制器（用于取消） ---- */
  _streamController: null,

  /* ---- 分享数据（base64 编码的题目 JSON） ---- */
  _shareData: null,

  /* ==============================================
     通用 UI 工具
     ============================================== */

  /** Toast 提示 (对应 wx.showToast) */
  toast(msg, duration = 2000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  },

  /** Loading 遮罩 (对应 wx.showLoading / wx.hideLoading) */
  showLoading(title, sub = '') {
    document.getElementById('loading-title').textContent = title;
    document.getElementById('loading-sub').textContent = sub;
    document.getElementById('loading-overlay').classList.add('show');
  },
  hideLoading() {
    document.getElementById('loading-overlay').classList.remove('show');
  },

  /* ==============================================
     页面导航 (模拟小程序导航)
     ============================================== */

  /** 导航到新页面 (保留当前页) */
  navigateTo(page) {
    const current = this._history[this._history.length - 1];
    this._showPage(current, false);
    // 离开 confirm 时取消流式请求
    if (current === 'confirm') this._cancelStream();
    this._history.push(page);
    this._showPage(page, true);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  /** 重定向 (关闭当前页) */
  redirectTo(page) {
    const prev = this._history.pop();
    this._showPage(prev, false);
    if (prev === 'confirm') this._cancelStream();
    this._history.push(page);
    this._showPage(page, true);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  /** 返回上 N 层 */
  navigateBack(delta = 1) {
    while (delta > 0 && this._history.length > 1) {
      const prev = this._history.pop();
      if (prev === 'confirm') this._cancelStream();
      this._showPage(prev, false);
      delta--;
    }
    const current = this._history[this._history.length - 1];
    this._showPage(current, true);

    // 重新渲染当前页 (onShow)
    this._renderPage(current);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  /** 返回首页 */
  goHome() {
    this._cancelStream();
    this._history.forEach(p => { if (p !== 'index') this._showPage(p, false); });
    this._history = ['index'];
    this._showPage('index', true);
    this._updateNavBar();
    window.scrollTo(0, 0);
  },

  /** 返回确认页（从任意页面跳转到题目列表） */
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

  /** 更新导航栏返回箭头显隐 */
  _updateNavBar() {
    const back = document.getElementById('nav-back');
    if (back) {
      back.style.display = this._history.length > 1 ? 'flex' : 'none';
    }
  },

  _renderPage(page) {
    const renderers = {
      'confirm': () => this.pages.confirm.render(),
    };
    if (renderers[page]) renderers[page]();
  },

  /** 取消正在进行的流式请求 */
  _cancelStream() {
    if (this._streamController) {
      this._streamController.abort();
      this._streamController = null;
    }
  },

  /* ==============================================
     分享功能 (对应 wx.onShareAppMessage)
     ============================================== */

  /* ==============================================
     分享功能 (弹窗选择: 链接 / 二维码)
     ============================================== */

  /** 打开分享弹窗 */
  openShareModal() {
    document.getElementById('share-qr-wrap').style.display = 'none';
    document.getElementById('share-modal').style.display = '';
  },

  /** 关闭分享弹窗 */
  closeShareModal() {
    document.getElementById('share-modal').style.display = 'none';
    document.getElementById('share-qr-wrap').style.display = 'none';
  },

  async share() {
    this.openShareModal();
  },

  /** 分享链接：后端存数据 → 短 ID → 复制到剪贴板 */
  async _doShareLink() {
    const qs = Store.questions || [];
    if (qs.length === 0) {
      this.toast('暂无题目可分享');
      this.closeShareModal();
      return;
    }

    try {
      this.showLoading('正在生成分享链接...');
      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: qs })
      });
      const data = await resp.json();
      this.hideLoading();

      if (!data.ok || !data.id) {
        this.toast('分享失败，请重试');
        this.closeShareModal();
        return;
      }

      const shortUrl = window.location.origin + window.location.pathname + '#s=' + data.id;
      await navigator.clipboard.writeText(shortUrl);
      this.toast('链接已复制，可在任意聊天窗口粘贴分享');
      this.closeShareModal();
    } catch (e) {
      this.hideLoading();
      this.toast('分享失败：' + (e.message || '网络错误'));
      this.closeShareModal();
    }
  },

  /** 分享二维码：后端存数据 → 短 ID → 生成二维码 → 复制到剪贴板 */
  async _doShareQR() {
    const qs = Store.questions || [];
    if (qs.length === 0) {
      this.toast('暂无题目可分享');
      this.closeShareModal();
      return;
    }

    try {
      this.showLoading('正在生成二维码...');
      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: qs })
      });
      const data = await resp.json();
      this.hideLoading();

      if (!data.ok || !data.id) {
        this.toast('分享失败，请重试');
        this.closeShareModal();
        return;
      }

      const shortUrl = window.location.origin + window.location.pathname + '#s=' + data.id;
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(shortUrl);

      // 显示二维码
      document.getElementById('share-qr-img').src = qrUrl;
      document.getElementById('share-qr-caption').textContent = '出题喵喵 · ' + qs.length + '道题';
      document.getElementById('share-qr-wrap').style.display = '';

      // 尝试复制图片到剪贴板
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
      this.closeShareModal();
    }
  },

  /* ==============================================
     页面逻辑 (对应小程序各 Page())
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

      onQtyChange(val) {
        // qty 已绑定到 select, 读取时用 select.value
      },

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

        // 按焦点 tab 校验
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
            // 链接 tab：并行抓取（在首页显示 loading）
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

          // 立即跳转到确认页，开始流式出题
          Store.questions = [];
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

      /** 更新标题区域（loading / progress / done） */
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

      /** 更新进度条 */
      _updateProgress() {
        const pct = this._total > 0 ? Math.max(5, Math.round(this._rendered / this._total * 100)) : 5;
        document.getElementById('confirm-progress-bar').style.width = pct + '%';
      },

      /** 生成分享链接的 base64 编码 */
      _generateShareUrl(questions) {
        try {
          const json = JSON.stringify(questions);
          // base64 URL-safe 编码（支持 UTF-8 中文）
          const encoded = btoa(unescape(encodeURIComponent(json)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          App._shareData = encoded;
        } catch (e) {
          App._shareData = null;
        }
      },

      /** 开始流式出题 */
      startStreaming(content, count) {
        this._streaming = true;
        this._total = count;
        this._rendered = 0;
        Store.questions = [];
        App._shareData = null;

        // 重置 UI
        document.getElementById('confirm-tags').innerHTML = '';
        document.getElementById('confirm-list').innerHTML = '';
        document.getElementById('btn-start-practice').disabled = true;
        document.getElementById('confirm-error').style.display = 'none';

        // 显示标题加载态 + 进度条
        this._updateTitle('loading');
        document.getElementById('confirm-loading-sub').style.display = '';
        document.getElementById('confirm-progress').style.display = '';
        document.getElementById('confirm-progress-bar').style.width = '5%';

        // 启动 SSE 流
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

            // 部分成功 — 显示已有题目
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

      /** 流式完成时的统一收尾 */
      _finishStreaming(questions) {
        this._streaming = false;
        App._streamController = null;
        Store.questions = questions;

        this._updateTitle('done');
        document.getElementById('confirm-loading-sub').style.display = 'none';
        document.getElementById('confirm-progress').style.display = 'none';
        document.getElementById('btn-start-practice').disabled = questions.length === 0;
        this._updateTags(questions);

        // 生成分享链接
        this._generateShareUrl(questions);

        if (questions.length === 0) {
          this._showError('AI 未生成有效题目，请增加内容后重试');
        }

        const btn = document.getElementById('btn-generate');
        btn.disabled = false;
        btn.textContent = '生成练习题';
      },

      /** 降级：非流式出题（SSE 不可用时自动回退） */
      async _fallbackToNonStreaming(content, count) {
        // 保持加载态
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

      /** 追加一道题目到列表 */
      _appendQuestion(q, count) {
        const list = document.getElementById('confirm-list');
        const i = count - 1; // 0-based index
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

        // 更新 Store
        Store.questions = Store.questions.concat([q]);
        this._updateTags(Store.questions);
      },

      /** 更新标签 */
      _updateTags(questions) {
        const catMap = {};
        questions.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
        const tags = Object.entries(catMap).map(([name, count]) => ({ name, count }));
        document.getElementById('confirm-tags').innerHTML = tags.map(t =>
          `<span class="tag">${App._esc(t.name)} ×${t.count}</span>`
        ).join('');
      },

      /** 显示错误 */
      _showError(msg) {
        this._updateTitle('error');
        document.getElementById('confirm-loading-sub').style.display = 'none';
        document.getElementById('confirm-progress').style.display = 'none';
        const el = document.getElementById('confirm-error');
        el.textContent = msg;
        el.style.display = '';
      },

      /** 全量渲染（删除题目后调用 / 分享链接加载） */
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

        // 生成分享链接（删除后重新生成）
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
      },

      startPractice() {
        if (this._streaming) return;
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
        document.getElementById('prac-cat').textContent = q.cat;
        document.getElementById('prac-question').textContent = q.q;

        // 选项
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

        // 高亮选项
        const items = document.querySelectorAll('#prac-options .option-item');
        items.forEach((el, oi) => {
          if (oi === this._currentQ.answer) el.classList.add('correct');
          if (oi === i && oi !== this._currentQ.answer) el.classList.add('wrong');
        });

        // 反馈
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

        // 错题
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
      },

      retry() {
        Store.preparePool();
        App.pages.practice.render();
        App.redirectTo('practice');
      }
    }
  },

  /* ==============================================
     工具函数
     ============================================== */

  /** HTML 转义 */
  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  /** 从 URL hash 加载分享的题目（支持短链接 #s= 和旧版 #q=） */
  async _loadSharedQuiz() {
    const hash = window.location.hash;
    if (!hash) return;

    // 新版短链接: #s=ABC123
    if (hash.startsWith('#s=')) {
      const id = hash.slice(3);
      if (!id) return;
      try {
        this.showLoading('正在加载分享内容...');
        const resp = await fetch('/api/share?id=' + encodeURIComponent(id));
        const data = await resp.json();
        this.hideLoading();

        if (!data.ok || !Array.isArray(data.questions) || data.questions.length === 0) {
          this.toast(data.error || '分享内容已过期或不存在');
          return;
        }

        Store.questions = data.questions;

        // 直接跳转到确认页
        this._history = ['index', 'confirm'];
        this._showPage('index', false);
        this._showPage('confirm', true);
        this.pages.confirm.render();
        this._updateNavBar();
        window.scrollTo(0, 0);

        // 清除 hash 避免刷新重复加载
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname);
        }
      } catch (e) {
        this.hideLoading();
        this.toast('加载分享内容失败');
      }
      return;
    }

    // 旧版 base64 链接: #q=base64
    if (hash.startsWith('#q=')) {
      const encoded = hash.slice(3);
      try {
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const json = decodeURIComponent(escape(atob(base64)));
        const questions = JSON.parse(json);

        if (Array.isArray(questions) && questions.length > 0) {
          Store.questions = questions;
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
  }
};

/* ---- 初始化 ---- */
document.addEventListener('DOMContentLoaded', async () => {
  // 检查是否为分享链接（优先新版短链接 #s=，兼容旧版 #q=）
  if (window.location.hash && (window.location.hash.startsWith('#s=') || window.location.hash.startsWith('#q='))) {
    await App._loadSharedQuiz();
  } else {
    App.pages.index.init();
  }
});
