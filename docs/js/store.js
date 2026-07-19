/**
 * 拾知猫 — 全局状态管理
 * 对应小程序 app.globalData
 */
const Store = {
  questions: null,  // AI 生成的题目数组 [{q, cat, options, answer, exp}]
  pool: null,       // 打乱后的练习题池
  idx: 0,           // 当前题目索引
  score: 0,         // 当前得分
  wrong: [],        // 错题记录 [{q, cat, picked, correct, exp}]

  /** 重置练习状态 */
  resetPractice() {
    this.idx = 0;
    this.score = 0;
    this.wrong = [];
  },

  /** 打乱题目并准备练习 */
  preparePool() {
    this.resetPractice();
    this.pool = [...(this.questions || [])].sort(() => Math.random() - 0.5);
  }
};
