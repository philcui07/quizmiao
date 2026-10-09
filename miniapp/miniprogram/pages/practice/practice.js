const app = getApp();

Page({
  data: {
    currentQ: null,
    idx: 0,
    total: 0,
    score: 0,
    answered: false,
    picked: -1,
    isCorrect: false,
    letters: ['A', 'B', 'C', 'D']
  },

  onLoad() {
    const g = app.globalData;
    if (!g.pool || g.idx >= g.pool.length) {
      wx.redirectTo({ url: '/pages/result/result' });
      return;
    }
    if (!g.attemptId) g.attemptId = app.createId('attempt');
    g.attemptSaved = false;
    this.setData({
      currentQ: g.pool[g.idx],
      idx: g.idx,
      total: g.pool.length,
      score: g.score
    });
  },

  choose(e) {
    if (this.data.answered) return;
    const i = parseInt(e.currentTarget.dataset.i);
    const g = app.globalData;
    const correct = i === this.data.currentQ.answer;

    if (correct) {
      g.score++;
    } else {
      g.wrong.push({
        q: this.data.currentQ.q,
        cat: this.data.currentQ.cat,
        picked: this.data.currentQ.options[i],
        correct: this.data.currentQ.options[this.data.currentQ.answer],
        exp: this.data.currentQ.exp
      });
    }

    this.setData({
      answered: true,
      picked: i,
      isCorrect: correct,
      score: g.score
    });
  },

  nextQ() {
    const g = app.globalData;
    g.idx++;
    if (g.idx >= g.pool.length) {
      wx.redirectTo({ url: '/pages/result/result' });
      return;
    }
    this.setData({
      currentQ: g.pool[g.idx],
      idx: g.idx,
      answered: false,
      picked: -1
    });
  }
});
