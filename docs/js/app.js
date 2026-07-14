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
    this._history.push(page);
    this._showPage(page, true);
    window.scrollTo(0, 0);
  },

  /** 重定向 (关闭当前页) */
  redirectTo(page) {
    const prev = this._history.pop();
    this._showPage(prev, false);
    this._history.push(page);
    this._showPage(page, true);
    window.scrollTo(0, 0);
  },

  /** 返回上 N 层 */
  navigateBack(delta = 1) {
    while (delta > 0 && this._history.length > 1) {
      const prev = this._history.pop();
      this._showPage(prev, false);
      delta--;
    }
    const current = this._history[this._history.length - 1];
    this._showPage(current, true);

    // 重新渲染当前页 (onShow)
    this._renderPage(current);
    window.scrollTo(0, 0);
  },

  /** 返回首页 */
  goHome() {
    this._history.forEach(p => { if (p !== 'index') this._showPage(p, false); });
    this._history = ['index'];
    this._showPage('index', true);
    window.scrollTo(0, 0);
  },

  /** 返回确认页（从任意页面跳转到题目列表） */
  goConfirm() {
    this._history.forEach(p => this._showPage(p, false));
    this._history = ['index', 'confirm'];
    this._showPage('confirm', true);
    this.pages.confirm.render();
    window.scrollTo(0, 0);
  },

  _showPage(page, show) {
    const el = document.getElementById('page-' + page);
    if (el) el.style.display = show ? '' : 'none';
  },

  _renderPage(page) {
    const renderers = {
      'confirm': () => this.pages.confirm.render(),
    };
    if (renderers[page]) renderers[page]();
  },

  /* ==============================================
     分享功能 (对应 wx.onShareAppMessage)
     ============================================== */

  async share() {
    const qs = Store.questions || [];
    const title = `出题喵喵 · ${qs.length}道练习题`;
    const text = `涵盖 ${[...new Set(qs.map(q => q.cat))].slice(0, 3).join('、')} 等知识点，来一起做题吧！`;

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: window.location.href });
      } catch (_) { /* 用户取消 */ }
    } else {
      try {
        await navigator.clipboard.writeText(window.location.href);
        this.toast('链接已复制，粘贴给好友即可分享');
      } catch (_) {
        this.toast('分享链接：' + window.location.href);
      }
    }
  },

  /* ==============================================
     页面逻辑 (对应小程序各 Page())
     ============================================== */

  pages: {

    /* ---- 首页 (index) ---- */
    index: {
      _urls: [''],

      init() {
        this._urls = [''];
        this.renderUrls();
        document.getElementById('btn-generate').disabled = false;
        document.getElementById('btn-generate').textContent = '生成练习题';
        document.getElementById('index-error').style.display = 'none';
      },

      switchTab(tab) {
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

        if (!manualText && urls.length === 0) {
          document.getElementById('index-error').textContent = '请粘贴文本或添加链接';
          document.getElementById('index-error').style.display = '';
          return;
        }

        const btn = document.getElementById('btn-generate');
        btn.disabled = true;
        btn.textContent = '生成中...';
        document.getElementById('index-error').style.display = 'none';

        App.showLoading('正在准备...');

        try {
          let content = manualText;

          // 步骤1：多链接并行抓取
          if (urls.length > 0) {
            App.showLoading('正在抓取网页内容...');
            const fetchResults = await Promise.allSettled(
              urls.map(u => fetchPageContent(u))
            );
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
              throw new Error('所有网页抓取均失败，请检查链接是否有效');
            }
          }

          if (!content || content.length < 20) {
            throw new Error('获取内容太少（需 ≥20 字符），请增加输入');
          }

          // 步骤2：AI 出题（含自检，无需二次验证）
          App.showLoading('AI 正在出题，约 10~30 秒...');
          let llmResp;
          try {
            llmResp = await generateQuestions(content, count);
          } catch (e) {
            if (e.message && e.message.includes('timeout') || e.message.includes('超时')) {
              throw new Error('AI 出题超时（已等待 60 秒），请减少内容或题数后重试');
            }
            throw new Error('AI 出题失败: ' + (e.message || '服务器未响应'));
          }

          if (!llmResp || !llmResp.questions || llmResp.questions.length < 2) {
            throw new Error('AI 生成题目不足（需 ≥2 道），请增加内容后重试');
          }

          let questions = llmResp.questions;

          if (llmResp.elapsed_ms) {
            console.log(`[出题耗时] ${llmResp.elapsed_ms}ms`);
          }

          Store.questions = questions;
          App.hideLoading();
          App.pages.confirm.render();
          App.navigateTo('confirm');

        } catch (err) {
          App.hideLoading();
          const msg = err.message || '生成失败，请重试';
          document.getElementById('index-error').textContent = msg;
          document.getElementById('index-error').style.display = '';
          App.toast(msg, 3000);
        } finally {
          btn.disabled = false;
          btn.textContent = '生成练习题';
        }
      }
    },

    /* ---- 确认页 (confirm) ---- */
    confirm: {
      render() {
        const qs = Store.questions || [];
        document.getElementById('confirm-count').textContent = qs.length;

        // 分类标签
        const catMap = {};
        qs.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
        const tags = Object.entries(catMap).map(([name, count]) => ({ name, count }));
        document.getElementById('confirm-tags').innerHTML = tags.map(t =>
          `<span class="tag">${App._esc(t.name)} ×${t.count}</span>`
        ).join('');

        // 题目列表
        document.getElementById('confirm-list').innerHTML = qs.map((q, i) => `
          <div class="qconf-card">
            <div class="qconf-q">${i + 1}. [${App._esc(q.cat)}] ${App._esc(q.q)}</div>
            <div class="qconf-opts">${q.options.map((o, oi) =>
              `${App._esc(['A','B','C','D'][oi])}. ${App._esc(o)}`
            ).join(' &nbsp;')}</div>
            <div class="qconf-ans">
              答案：${App._esc(['A','B','C','D'][q.answer])}. ${App._esc(q.options[q.answer])}
            </div>
            <div class="qconf-del" onclick="App.pages.confirm.delQ(${i})">×</div>
          </div>
        `).join('');

        if (qs.length === 0) {
          document.getElementById('confirm-list').innerHTML = '<div class="msg" style="text-align:center;color:var(--text3)">暂无题目</div>';
        }
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
  }
};

/* ---- 初始化 ---- */
document.addEventListener('DOMContentLoaded', () => {
  App.pages.index.init();
});
