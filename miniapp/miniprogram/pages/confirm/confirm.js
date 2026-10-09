const app = getApp();

Page({
  data: {
    questions: [],
    tags: [],
    loading: false,
    loadingShared: false,
    error: '',
    totalCount: 0,
    renderCount: 0,
    shareId: '',
    shareReady: false,
    shareSaving: false,
    shareNameVisible: false,
    shareName: '',
    pendingShare: false,
    participantNameVisible: false,
    participantName: ''
  },

  onLoad(options) {
    this._setShareMenu(false);

    // 从分享链接打开：通过 shareId 从云数据库拉取题目
    const shareId = this._getShareId(options);
    if (shareId) {
      this.loadSharedQuiz(shareId);
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
    this._setShareMenu(false);
    this.setData({
      loading: true,
      loadingShared: false,
      error: '',
      questions: [],
      tags: [],
      renderCount: 0,
      totalCount: 0,
      shareId: '',
      shareReady: false
    });

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

      const allQuestions = normalizeQuestions(llmResp.questions);
      const catMap = {};
      allQuestions.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
      const allTags = Object.entries(catMap).map(([name, count]) => ({ name, count }));

      // 保存全部到全局
      app.globalData.questions = allQuestions;
      app.globalData.quizSource = 'self';
      app.globalData.shareId = '';
      await this._ensureHistory(allQuestions);

      // 先保存分享数据，拿到 shareId 后再开放原生分享入口
      const shareReady = await this._saveForShare(allQuestions, allTags);
      wx.hideLoading();

      // 先显示总标题和标签（结束 loading 状态）
      this.setData({
        loading: false,
        questions: [],
        tags: allTags,
        totalCount: allQuestions.length,
        renderCount: 0,
        shareReady
      });

      // 逐题渐显渲染（模拟流式体感，每批 2-3 题，间隔 120ms）
      this._animateQuestions(allQuestions);

      // 仅在分享数据可用时显示微信原生分享菜单
      this._setShareMenu(shareReady);

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
  async _saveForShare(questions, tags, shareName) {
    if (!questions || questions.length === 0) return false;

    const requestId = (this._shareSaveRequestId || 0) + 1;
    this._shareSaveRequestId = requestId;
    this._setShareMenu(false);
    this.setData({
      shareSaving: true,
      shareReady: false,
      shareId: ''
    });

    try {
      const resp = await cloudCall('saveQuiz', {
        questions,
        tags,
        trackOwner: Boolean(app.globalData.user),
        historyId: app.globalData.historyId || '',
        name: String(shareName || '').trim() || this._buildTitle(questions),
        reuseExisting: Boolean(app.globalData.historyId)
      });
      if (requestId !== this._shareSaveRequestId) return false;
      if (!resp || !resp.ok || !resp.shareId) {
        throw new Error(resp && resp.error ? resp.error : '分享服务暂不可用');
      }

      this.setData({ shareId: resp.shareId, shareReady: true });
      app.globalData.shareId = resp.shareId;
      this._setShareMenu(true);
      return true;
    } catch (e) {
      if (requestId !== this._shareSaveRequestId) return false;
      console.warn('保存分享题目失败:', e.message);
      return false;
    } finally {
      if (requestId === this._shareSaveRequestId) {
        this.setData({ shareSaving: false });
      }
    }
  },

  _getShareId(options) {
    if (!options) return '';
    if (options.shareId) return decodeURIComponent(options.shareId);
    if (!options.scene) return '';

    const scene = decodeURIComponent(options.scene);
    return scene.indexOf('shareId=') === 0 ? scene.slice(8) : scene;
  },

  _setShareMenu(visible) {
    if (visible && wx.showShareMenu) {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    } else if (!visible && wx.hideShareMenu) {
      wx.hideShareMenu();
    }
  },

  /**
   * 从分享链接加载题目
   */
  async loadSharedQuiz(shareId) {
    this.setData({ loading: true, loadingShared: true, error: '', questions: [], tags: [], renderCount: 0, totalCount: 0 });

    try {
      const resp = await cloudCall('getQuiz', { shareId });
      if (!resp || !resp.ok || !resp.questions || resp.questions.length < 1) {
        throw new Error(resp && resp.error ? resp.error : '获取分享题目失败');
      }

      const allQuestions = normalizeQuestions(resp.questions);
      const allTags = resp.tags || [];
      app.globalData.questions = allQuestions;
      app.globalData.historyId = '';
      app.globalData.quizSource = 'shared';
      app.globalData.shareId = shareId;

      const savedParticipant = wx.getStorageSync ? String(wx.getStorageSync('quizmiao_participant_name') || '') : '';
      app.globalData.participantName = savedParticipant;

      this.setData({
        loading: false,
        loadingShared: false,
        questions: allQuestions,
        tags: allTags,
        totalCount: allQuestions.length,
        renderCount: allQuestions.length,
        shareId: shareId,
        shareReady: true
      });
      this._setShareMenu(true);

      if (!savedParticipant) {
        this.setData({ participantNameVisible: true, participantName: '' });
      }
    } catch (err) {
      this.setData({ loading: false, loadingShared: false, error: err.message || '加载分享题目失败' });
    }
  },

  /**
   * 渲染题目列表
   */
  async renderQuestions() {
    const qs = normalizeQuestions(app.globalData.questions || []);
    app.globalData.questions = qs;
    const catMap = {};
    qs.forEach(q => { catMap[q.cat] = (catMap[q.cat] || 0) + 1; });
    const tags = Object.entries(catMap).map(([name, count]) => ({ name, count }));
    this.setData({ questions: qs, tags, shareReady: false });
    if (qs.length > 0) {
      await this._ensureHistory(qs);
      await this._saveForShare(qs, tags);
    }
  },

  /**
   * 小程序分享 — 使用微信原生分享面板
   */
  onShareAppMessage() {
    const qs = app.globalData.questions || this.data.questions || [];
    if (this.data.shareId && app.globalData.user) {
      const pending = app.callProxy('shareMark', { shareId: this.data.shareId }).catch(err => {
        console.warn('标记分享记录失败:', err.message);
      });
      trackHistorySync(pending);
    }
    const catNames = [...new Set(qs.map(q => q.cat))].slice(0, 3).join('、');
    const sharePath = this.data.shareId
      ? '/pages/confirm/confirm?shareId=' + encodeURIComponent(this.data.shareId)
      : '/pages/index/index';
    return {
      title: '拾知猫 · ' + qs.length + '道练习题',
      desc: catNames ? '涵盖 ' + catNames + ' 等知识点，来一起做题吧！' : '来一起做题吧！',
      path: sharePath,
      imageUrl: ''
    };
  },

  requestShare() {
    if (!this.data.shareReady || !this.data.questions.length) return;
    this.setData({ shareNameVisible: true, shareName: this._buildTitle(this.data.questions) });
  },

  closeShareName() {
    if (!this.data.shareSaving) this.setData({ shareNameVisible: false });
  },

  onShareNameInput(e) {
    this.setData({ shareName: e.detail.value });
  },

  async confirmShareName() {
    const name = String(this.data.shareName || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入分享名称', icon: 'none' });
      return;
    }
    const ready = await this._saveForShare(this.data.questions, this.data.tags, name);
    if (!ready) {
      wx.showToast({ title: '分享准备失败，请稍后重试', icon: 'none' });
      return;
    }
    if (app.globalData.user && this.data.shareId) {
      try {
        const marked = await app.callProxy('shareMark', { shareId: this.data.shareId });
        if (!marked || !marked.ok) throw new Error(marked && marked.error ? marked.error : '标记分享失败');
      } catch (err) {
        wx.showToast({ title: '分享记录同步失败，请重试', icon: 'none' });
        return;
      }
    }
    this.setData({ shareNameVisible: false, pendingShare: true });
  },

  onShareButtonTap() {
    if (this.data.pendingShare) this.setData({ pendingShare: false });
  },

  onParticipantNameInput(e) {
    this.setData({ participantName: e.detail.value });
  },

  confirmParticipantName() {
    const name = String(this.data.participantName || '').trim() || '匿名用户';
    if (wx.setStorageSync) wx.setStorageSync('quizmiao_participant_name', name);
    app.globalData.participantName = name;
    this.setData({ participantNameVisible: false, participantName: name });
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const qs = app.globalData.questions || this.data.questions || [];
    const shareQuery = this.data.shareId
      ? 'shareId=' + encodeURIComponent(this.data.shareId)
      : '';
    return {
      title: '拾知猫 · ' + qs.length + '道练习题',
      query: shareQuery,
      imageUrl: ''
    };
  },

  async delQ(e) {
    const idx = e.currentTarget.dataset.idx;
    const qs = this.data.questions.slice();
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
    if (app.globalData.historyId && app.globalData.quizSource === 'self') {
      try {
        await app.callProxy('historyUpdate', {
          id: app.globalData.historyId,
          questions: qs,
          title: this._buildTitle(qs)
        });
      } catch (e) {
        console.warn('更新题集失败:', e.message);
      }
    }
    await this._saveForShare(qs, tags);
  },

  startPractice() {
    if (this.data.loading || this.data.questions.length === 0) return;
    const pool = [...app.globalData.questions].sort(() => Math.random() - 0.5);
    app.globalData.pool = pool;
    app.globalData.idx = 0;
    app.globalData.score = 0;
    app.globalData.wrong = [];
    app.globalData.attemptId = app.createId('attempt');
    app.globalData.attemptSaved = false;
    wx.navigateTo({ url: '/pages/practice/practice' });
  },

  async _ensureHistory(questions) {
    if (app.globalData.quizSource !== 'self' || app.globalData.historyId) return app.globalData.historyId;
    const user = await app.refreshUser();
    if (!user) return '';
    try {
      const result = await app.callProxy('historyCreate', {
        questions,
        title: this._buildTitle(questions)
      });
      if (result && result.ok && result.id) {
        app.globalData.historyId = result.id;
        return result.id;
      }
      console.warn('创建题集历史失败:', result && result.error);
    } catch (e) {
      console.warn('创建题集历史失败:', e.message);
    }
    return '';
  },

  _buildTitle(questions) {
    const names = [...new Set((questions || []).map(item => item.cat).filter(Boolean))].slice(0, 3);
    return names.length ? names.join('、') : '未命名题集';
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

function normalizeQuestions(questions) {
  return (questions || []).map(question => Object.assign({}, question, {
    options: (question.options || []).map(option => String(option || '')
      .replace(/^\s*[A-D][.、:：)）]\s*/i, '')
      .trim())
  }));
}

function trackHistorySync(promise) {
  app.globalData.historySyncPromise = promise;
  promise.finally(() => {
    if (app.globalData.historySyncPromise === promise) app.globalData.historySyncPromise = null;
  });
}
