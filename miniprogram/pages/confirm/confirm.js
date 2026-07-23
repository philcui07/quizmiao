const app = getApp();

Page({
  data: {
    questions: [],
    tags: [],
    loading: false,
    error: '',
    totalCount: 0,
    renderCount: 0,
    shareId: ''
  },

  onLoad(options) {
    // 从分享链接打开：通过 shareId 从云数据库拉取题目
    if (options && options.shareId) {
      this.loadSharedQuiz(options.shareId);
      return;
    }

    // 检查是否有待生成的内容
    if (app.globalData.pendingContent) {
      const content = app.globalData.pendingContent;
      const count = app.globalData.pendingCount;
      // 清除 pending 数据
      app.globalData.pendingContent = null;
      app.globalData.pendingCount = null;
      // 开始生成
      this.startGeneration(content, count);
    } else {
      // 直接展示已有题目（从练习页返回等场景）
      this.renderQuestions();
    }
  },

  /**
   * 在确认页执行 AI 出题（流式消费 + 逐题渐显动画）
   */
  async startGeneration(content, count) {
    this.setData({ loading: true, error: '', questions: [], tags: [], renderCount: 0, totalCount: 0 });

    wx.showLoading({ title: 'AI 正在出题...', mask: true });

    try {
      let llmResp;
      try {
        llmResp = await cloudCall('llm', { content, count });
      } catch (e) {
        if (e.message && e.message.includes('timeout')) {
          throw new Error('AI 出题超时，请减少内容或题数后重试');
        }
        throw new Error('AI 出题失败: ' + (e.message || '云函数未响应'));
      }

      if (!llmResp || !llmResp.questions || llmResp.questions.length < 1) {
        throw new Error('AI 生成题目不足，请增加内容后重试');
      }

      wx.hideLoading();

      const allQuestions = llmResp.questions;
      const catMap = {};
      allQuestions.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
      const allTags = Object.entries(catMap).map(([name, count]) => ({ name, count }));

      // 保存全部到全局
      app.globalData.questions = allQuestions;

      // 先显示总标题和标签（结束 loading 状态）
      this.setData({
        loading: false,
        questions: [],
        tags: allTags,
        totalCount: allQuestions.length,
        renderCount: 0
      });

      // 逐题渐显渲染（模拟流式体感，每批 2-3 题，间隔 120ms）
      this._animateQuestions(allQuestions);

      // 保存到云数据库，获取 shareId 供分享使用
      this._saveForShare(allQuestions, allTags);

      if (llmResp.elapsed_ms) {
        console.log(`[出题耗时] ${llmResp.elapsed_ms}ms`);
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ loading: false, error: err.message || 'AI 出题失败，请重试' });
    }
  },

  /**
   * 逐题渐显动画 — 分批渲染题目卡片
   */
  _animateQuestions(allQuestions) {
    const BATCH = 3;    // 每批 3 题
    const INTERVAL = 150; // 批间隔 150ms
    let index = 0;

    const step = () => {
      if (index >= allQuestions.length) {
        // 全部渲染完成
        this.setData({ renderCount: allQuestions.length });
        return;
      }

      const batch = allQuestions.slice(index, index + BATCH);
      index += BATCH;
      
      const current = this.data.questions.concat(batch);
      this.setData({
        questions: current,
        renderCount: current.length
      });

      setTimeout(step, INTERVAL);
    };

    step();
  },

  /**
   * 保存题目到云数据库，获取 shareId
   */
  async _saveForShare(questions, tags) {
    try {
      const resp = await cloudCall('saveQuiz', { questions, tags });
      if (resp && resp.ok && resp.shareId) {
        this.setData({ shareId: resp.shareId });
      }
    } catch (e) {
      console.warn('保存分享题目失败（不影响使用）:', e.message);
    }
  },

  /**
   * 从分享链接加载题目
   */
  async loadSharedQuiz(shareId) {
    this.setData({ loading: true, error: '', questions: [], tags: [], renderCount: 0, totalCount: 0 });

    try {
      const resp = await cloudCall('getQuiz', { shareId });
      if (!resp || !resp.ok || !resp.questions || resp.questions.length < 1) {
        throw new Error(resp && resp.error ? resp.error : '获取分享题目失败');
      }

      const allQuestions = resp.questions;
      const allTags = resp.tags || [];
      app.globalData.questions = allQuestions;

      this.setData({
        loading: false,
        tags: allTags,
        totalCount: allQuestions.length,
        renderCount: 0,
        shareId: shareId
      });

      this._animateQuestions(allQuestions);
    } catch (err) {
      this.setData({ loading: false, error: err.message || '加载分享题目失败' });
    }
  },

  /**
   * 渲染题目列表
   */
  renderQuestions() {
    const qs = app.globalData.questions || [];
    const catMap = {};
    qs.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
    const tags = Object.entries(catMap).map(([name, count]) => ({ name, count }));
    this.setData({ questions: qs, tags });
  },

  /**
   * 小程序分享 — 使用微信原生分享面板
   */
  onShareAppMessage() {
    const qs = app.globalData.questions || this.data.questions || [];
    const catNames = [...new Set(qs.map(q => q.cat))].slice(0, 3).join('、');
    const sharePath = this.data.shareId
      ? '/pages/confirm/confirm?shareId=' + this.data.shareId
      : '/pages/index/index';
    return {
      title: '出题喵喵 · ' + qs.length + '道练习题',
      desc: '涵盖 ' + catNames + ' 等知识点，来一起做题吧！',
      path: sharePath,
      imageUrl: ''
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const qs = app.globalData.questions || this.data.questions || [];
    const shareQuery = this.data.shareId
      ? 'shareId=' + this.data.shareId
      : '';
    return {
      title: '出题喵喵 · ' + qs.length + '道练习题',
      query: shareQuery,
      imageUrl: ''
    };
  },

  delQ(e) {
    const idx = e.currentTarget.dataset.idx;
    const qs = this.data.questions;
    qs.splice(idx, 1);
    if (qs.length === 0) {
      wx.navigateBack();
      return;
    }
    app.globalData.questions = qs;
    this.setData({ questions: qs });
    const catMap = {};
    qs.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
    const tags = Object.entries(catMap).map(([name, count]) => ({ name, count }));
    this.setData({ tags });
  },

  startPractice() {
    if (this.data.loading || this.data.questions.length === 0) return;
    const pool = [...app.globalData.questions].sort(() => Math.random() - 0.5);
    app.globalData.pool = pool;
    app.globalData.idx = 0;
    app.globalData.score = 0;
    app.globalData.wrong = [];
    wx.navigateTo({ url: '/pages/practice/practice' });
  },

  goHome() { wx.navigateBack(); },
  regenerate() { wx.navigateBack(); },
  goBack() { wx.navigateBack(); }
});

// 云函数调用封装（客户端超时60秒，与云函数配置一致）
function cloudCall(action, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'proxy',
      data: Object.assign({ action }, data),
      timeout: 60000,
      success(res) {
        if (res.result !== undefined && res.result !== null) {
          resolve(res.result);
        } else {
          reject(new Error('云函数返回空结果，可能未正确部署'));
        }
      },
      fail(err) {
        const errMsg = err.errMsg || '';
        if (errMsg.includes('-404012') || errMsg.includes('not found') || errMsg.includes('不存在')) {
          reject(new Error('云函数 proxy 未找到，请检查是否已部署'));
        } else if (errMsg.includes('timeout') || errMsg.includes('超时') || errMsg.includes('TIME_LIMIT')) {
          reject(new Error('云函数调用超时，请稍后重试'));
        } else {
          reject(new Error(errMsg || '云函数调用失败'));
        }
      }
    });
  });
}
