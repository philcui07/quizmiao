const app = getApp();

Page({
  data: {
    loading: true,
    error: '',
    title: '',
    record: null
  },

  async onLoad(options) {
    const type = options && options.type === 'share' ? 'share' : 'quiz';
    const id = options && options.id ? decodeURIComponent(options.id) : '';
    const title = options && options.title ? decodeURIComponent(options.title) : '答题详情';
    wx.setNavigationBarTitle({ title });
    if (!id) {
      this.setData({ loading: false, error: '缺少答题记录 ID' });
      return;
    }
    try {
      const result = await app.callProxy('recordDetail', { type, id });
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : '加载详情失败');
      const record = result.record;
      record.dateText = formatDate(record.createdAt);
      record.wrongCount = (record.wrongAnswers || []).length;
      record.scorePct = record.total ? Math.round(record.score / record.total * 100) : 0;
      this.setData({ title, record });
    } catch (err) {
      this.setData({ error: err.message || '加载详情失败' });
    } finally {
      this.setData({ loading: false });
    }
  }
});

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  if (!value || Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
