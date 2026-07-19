/**
 * 拾知猫 v1.1.0 — 全局状态管理
 * 新增：用户状态、分享状态、来源追踪
 */
const Store = {
  questions: null,  // AI 生成的题目数组 [{q, cat, options, answer, exp}]
  pool: null,       // 打乱后的练习题池
  idx: 0,           // 当前题目索引
  score: 0,         // 当前得分
  wrong: [],        // 错题记录 [{q, cat, picked, correct, exp}]

  // v1.1.0 新增
  user: null,       // 当前登录用户 {openid, phone, nickname}
  quizSource: 'self',  // 'self' | 'shared' — 当前题目来源
  shareId: null,    // 如果是分享链接进来的，记录分享ID
  shareName: '',    // 分享名称
  sharerOpenid: '', // 分享人的openid（用于答题结果同步）

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
  },

  /** v1.1.0: 重置分享相关状态 */
  resetShareState() {
    this.quizSource = 'self';
    this.shareId = null;
    this.shareName = '';
    this.sharerOpenid = '';
  },
};
