// 拾知猫 — 网页内容抓取云函数 (CloudBase)
// 替代 Vercel proxy/api/index.js 中的 handleFetch

exports.main = async (event, context) => {
  const { url: targetUrl } = event;
  if (!targetUrl) return { ok: false, error: "缺少 url 参数" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuizMiao/1.1)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    const text = extractText(html);

    if (text.length < 20) {
      return {
        ok: false,
        error: "JS_RENDERED",
        hint: "该网页是 JavaScript 动态渲染的，无法自动抓取。请打开网页 → 全选复制内容 → 粘贴到文本框中。",
      };
    }

    return { ok: true, text: text.slice(0, 50000), length: text.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

function extractText(html) {
  html = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, "");

  return html
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
