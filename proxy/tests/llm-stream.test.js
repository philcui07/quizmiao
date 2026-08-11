import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import handler from "../api/index.js";

function createRequest(body, url = "/llm-stream") {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = url;
  req.headers = { host: "localhost" };
  req.send = () => {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  };
  return req;
}

function createResponse() {
  const chunks = [];
  return {
    chunks,
    headers: {},
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      this.ended = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.ended = true;
      return data;
    },
  };
}

function parseEvents(response) {
  return response.chunks
    .join("")
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

test("llm-stream emits start, validated questions, and done from a non-streaming upstream response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, false);
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify([
                { cat: "天文", q: "地球绕太阳一周需要多久？", options: ["一天", "一年", "一月", "十年"], answer: 1, exp: "约一年" },
                { cat: "天文", q: "月球是什么？", options: ["恒星", "彗星", "行星", "卫星"], answer: 3, exp: "天然卫星" },
              ]),
            },
          }],
        };
      },
    };
  };

  try {
    const req = createRequest({ content: "足够长度的天文知识内容，用于生成测试题目。", count: 2 });
    const res = createResponse();
    const result = handler(req, res);
    req.send();
    await result;

    const events = parseEvents(res);
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(res.ended, true);
    assert.deepEqual(events.map((event) => event.type), ["start", "question", "question", "done"]);
    assert.equal(events[0].count, 2);
    assert.equal(events[3].count, 2);
    assert.equal(events[1].question.options.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llm-stream splits ten questions into two five-question DeepSeek calls", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, false);
    assert.match(payload.messages[0].content, /出5道四选一选择题/);

    const batch = ++callCount;
    const questions = Array.from({ length: 5 }, (_, index) => ({
      cat: `批次${batch}`,
      q: `第${batch}批第${index + 1}题？`,
      options: ["选项一", "选项二", "选项三", "选项四"],
      answer: index % 4,
      exp: "测试解析",
    }));

    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(questions) } }] };
      },
    };
  };

  try {
    const req = createRequest({ content: "足够长度的天文知识内容，用于生成十道测试题目。", count: 10 });
    const res = createResponse();
    const result = handler(req, res);
    req.send();
    await result;

    const events = parseEvents(res);
    assert.equal(callCount, 2);
    assert.equal(events.filter((event) => event.type === "question").length, 10);
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.at(-1).count, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llm fallback also splits ten questions and returns one JSON response", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async () => {
    const batch = ++callCount;
    const questions = Array.from({ length: 5 }, (_, index) => ({
      cat: `批次${batch}`,
      q: `降级路径第${batch}批第${index + 1}题？`,
      options: ["选项一", "选项二", "选项三", "选项四"],
      answer: index % 4,
      exp: "测试降级路径",
    }));
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(questions) } }] };
      },
    };
  };

  try {
    const req = createRequest(
      { content: "足够长度的天文知识内容，用于测试非流式降级路径。", count: 10 },
      "/llm"
    );
    const res = createResponse();
    const result = handler(req, res);
    req.send();
    await result;

    assert.equal(callCount, 2);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.questions.length, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llm-stream retries a batch when the model returns invalid JSON", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  const questions = Array.from({ length: 5 }, (_, index) => ({
    cat: "重试",
    q: `重试第${index + 1}题？`,
    options: ["选项一", "选项二", "选项三", "选项四"],
    answer: index % 4,
    exp: "测试重试",
  }));

  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      callCount += 1;
      return {
        choices: [{
          message: {
            content: callCount === 1
              ? "这不是有效 JSON"
              : JSON.stringify({ questions }),
          },
        }],
      };
    },
  });

  try {
    const req = createRequest({ content: "足够长度的天文知识内容，用于测试 JSON 重试。", count: 5 });
    const res = createResponse();
    const result = handler(req, res);
    req.send();
    await result;

    const events = parseEvents(res);
    assert.equal(callCount, 2);
    assert.equal(events.filter((event) => event.type === "question").length, 5);
    assert.equal(events.at(-1).type, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llm-stream emits a completed batch before a slower batch finishes", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let releaseSlowBatch;
  const slowBatch = new Promise((resolve) => {
    releaseSlowBatch = resolve;
  });

  const makeQuestions = (batch) => Array.from({ length: 5 }, (_, index) => ({
    cat: `实时批次${batch}`,
    q: `实时第${batch}批第${index + 1}题？`,
    options: ["选项一", "选项二", "选项三", "选项四"],
    answer: index % 4,
    exp: "测试实时批次",
  }));

  globalThis.fetch = async () => {
    const batch = ++callCount;
    return {
      ok: true,
      async json() {
        if (batch === 2) await slowBatch;
        return { choices: [{ message: { content: JSON.stringify({ questions: makeQuestions(batch) }) } }] };
      },
    };
  };

  try {
    const req = createRequest({ content: "足够长度的天文知识内容，用于测试逐批 SSE 输出。", count: 10 });
    const res = createResponse();
    const result = handler(req, res);
    req.send();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const partialEvents = parseEvents(res);
    assert.equal(partialEvents.filter((event) => event.type === "question").length, 5);
    assert.equal(partialEvents.some((event) => event.type === "done"), false);

    releaseSlowBatch();
    await result;
    const events = parseEvents(res);
    assert.equal(events.filter((event) => event.type === "question").length, 10);
    assert.equal(events.at(-1).type, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
