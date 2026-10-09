/**
 * 拾知猫 v1.1.1 — 全局状态管理
 * 新增：用户状态、分享状态、来源追踪、历史题集复练
 */
const Store = {
  questions: null,  // AI 生成的题目数组 [{q, cat, options, answer, exp}]
  pool: null,       // 打乱后的练习题池
  idx: 0,           // 当前题目索引
  score: 0,         // 当前得分
  wrong: [],        // 错题记录 [{q, cat, picked, correct, exp}]

  // v1.1.0+ account and practice state
  user: null,       // 当前登录资料 {uid, phone, phoneVerified, nickname, identityScope}
  historyId: null,  // 当前自建题集在 quiz_history 中的记录 ID
  historyCreatePromise: null,
  quizSessionId: null,
  attemptId: null,  // 当前练习轮次 ID，用于防止重复保存
  attemptSaved: false,
  attemptSavePromise: null,
  quizSource: 'self',  // 'self' | 'shared' — 当前题目来源
  shareId: null,    // 如果是分享链接进来的，记录分享ID
  shareName: '',    // 分享名称
  shareNickname: '',

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
    this.attemptId = this.createId('attempt');
    this.attemptSaved = false;
    this.attemptSavePromise = null;
  },

  createId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  },

  resetHistoryState() {
    this.historyId = null;
    this.historyCreatePromise = null;
    this.quizSessionId = this.createId('quiz');
    this.attemptId = null;
    this.attemptSaved = false;
    this.attemptSavePromise = null;
  },

  /** Load an existing account-owned history set without creating a new set. */
  loadHistoryQuestions(historyId, questions) {
    this.questions = (questions || []).map((item) => ({
      ...item,
      options: [...(item.options || [])],
    }));
    this.pool = null;
    this.historyId = historyId;
    this.historyCreatePromise = null;
    this.quizSessionId = this.createId('quiz');
    this.attemptId = null;
    this.attemptSaved = false;
    this.attemptSavePromise = null;
    this.quizSource = 'self';
    this.shareId = null;
    this.shareName = '';
    this.shareNickname = '';
  },

  /** v1.1.0: 重置分享相关状态 */
  resetShareState() {
    this.quizSource = 'self';
    this.shareId = null;
    this.shareName = '';
    this.shareNickname = '';
  },
};
