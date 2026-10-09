// 拾知猫 - 云开发版
// 通过微信云函数代理 API 请求，绕过域名白名单和 ICP 备案限制
// 云函数 proxy 转发到 Vercel API
const INPUT_MAX_LENGTH = 16000;

Page({
  data: {
    inputTab: 'text',
    manualText: '',
    manualTextLength: 0,
    inputMaxLength: INPUT_MAX_LENGTH,
    urls: [''],
    qtyOptions: ['5', '10', '20'],
    qtyIndex: 1,
    qtyDisplay: '10',
    generating: false,
    errorMsg: ''
  },

  switchTab(e) {
    this.setData({ inputTab: e.currentTarget.dataset.tab });
  },

  onManualInput(e) {
    const value = String(e.detail.value || '').slice(0, INPUT_MAX_LENGTH);
    // Android 的原生 textarea 会在 bindinput 返回后才提交粘贴/删除结果。
    // 同一事件中同步 setData（即使只更新计数）仍可能触发原生组件重绘，
    // 把第一次全选删除恢复成旧内容。正文不做受控回写，计数延迟到提交后更新。
    this.data.manualText = value;
    if (this._manualCounterTimer) clearTimeout(this._manualCounterTimer);
    this._manualCounterTimer = setTimeout(() => {
      this._manualCounterTimer = null;
      this.setData({ manualTextLength: this.data.manualText.length });
    }, 50);
    // 微信 textarea 支持从 bindinput 返回字符串作为最终输入值。
    // 显式返回空字符串可以让 Android 第一次全选删除立即生效。
    return value;
  },

  onUnload() {
    if (this._manualCounterTimer) {
      clearTimeout(this._manualCounterTimer);
      this._manualCounterTimer = null;
    }
  },

  onUrlInput(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const urls = this.data.urls.slice();
    urls[idx] = e.detail.value;
    this.setData({ urls });
  },

  addUrl() {
    this.setData({ urls: this.data.urls.concat(['']) });
  },

  removeUrl(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const urls = this.data.urls.slice();
    urls.splice(idx, 1);
    if (urls.length === 0) urls.push('');
    this.setData({ urls });
  },

  onQtyChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({ qtyIndex: idx, qtyDisplay: this.data.qtyOptions[idx] });
  },

  async startGenerate() {
    const { manualText, urls, qtyOptions, qtyIndex, inputTab } = this.data;
    const validUrls = urls.map(u => u.trim()).filter(u => u.length > 0);
    const app = getApp();

    // 按焦点 tab 校验
    if (inputTab === 'text' && !manualText) {
      this.setData({ errorMsg: '请粘贴文本内容' });
      return;
    }
    if (inputTab === 'urls' && validUrls.length === 0) {
      this.setData({ errorMsg: '请添加至少一个链接' });
      return;
    }
    const count = parseInt(qtyOptions[qtyIndex]);

    this.setData({ generating: true, errorMsg: '' });

    try {
      let content = '';

      // 按焦点 tab 获取内容
      if (inputTab === 'text') {
        content = manualText;
      } else {
        // 链接 tab：多链接并行抓取（通过云函数代理）
        wx.showLoading({ title: '正在抓取网页内容...', mask: true });
        const fetchPromises = validUrls.map(u =>
          cloudCall('fetch', { url: u })
            .then(resp => {
              if (resp.ok && resp.text) {
                return { ok: true, text: resp.text };
              }
              return { ok: false, text: '', error: resp.error || resp.hint || '抓取失败' };
            })
            .catch(err => {
              console.error('fetch cloud call error:', err);
              return { ok: false, text: '', error: err.message || '云函数调用失败' };
            })
        );
        const results = await Promise.all(fetchPromises);
        wx.hideLoading();
        let fetchedCount = 0;
        results.forEach((r, i) => {
          if (r.ok && r.text) {
            content = content
              ? content + '\n\n--- 来源 ' + (i + 1) + ' ---\n' + r.text
              : r.text;
            fetchedCount++;
          }
        });
        if (fetchedCount === 0) {
          const firstError = results[0] && results[0].error ? results[0].error : '所有网页抓取均失败';
          throw new Error(firstError);
        }
      }

      if (!content || content.length < 20) {
        throw new Error('获取内容太少（需 ≥20 字符），请增加输入');
      }
      content = content.slice(0, INPUT_MAX_LENGTH);

      // 传递内容到确认页，由确认页执行 AI 出题
      app.globalData.historyId = '';
      app.globalData.quizSource = 'self';
      app.globalData.shareId = '';
      app.globalData.pendingContent = content;
      app.globalData.pendingCount = count;
      wx.navigateTo({ url: '/pages/confirm/confirm' });

    } catch (err) {
      wx.hideLoading();
      const msg = err.message || '生成失败，请重试';
      this.setData({ errorMsg: msg });
      wx.showToast({ title: msg, icon: 'none', duration: 3000 });
    } finally {
      this.setData({ generating: false });
    }
  }
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
