// 拾知猫 — 网页内容抓取云函数 (CloudBase)
// 替代 Vercel proxy/api/index.js 中的 handleFetch

const dns = require('dns').promises;
const net = require('net');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

exports.main = async (event, context) => {
  const { url: targetUrl } = event;
  if (!targetUrl) return { ok: false, error: "缺少 url 参数" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const resp = await safeFetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuizMiao/1.1)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const contentLength = Number(resp.headers.get('content-length')) || 0;
    if (contentLength > MAX_RESPONSE_BYTES) {
      return { ok: false, error: '网页内容过大，请复制正文后使用文本出题' };
    }
    const contentType = resp.headers.get('content-type') || '';
    if (contentType && !/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      return { ok: false, error: '该链接不是可读取的网页内容' };
    }

    const html = (await resp.text()).slice(0, MAX_RESPONSE_BYTES);
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

async function safeFetch(input, options) {
  let current = new URL(input);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    await assertPublicUrl(current);
    const resp = await fetch(current, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(resp.status)) return resp;
    const location = resp.headers.get('location');
    if (!location) return resp;
    current = new URL(location, current);
  }
  throw new Error('网页重定向次数过多');
}

async function assertPublicUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持公开的 HTTP/HTTPS 网页');
  }
  if ((url.protocol === 'http:' && url.port && url.port !== '80') ||
      (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new Error('不支持非标准端口');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('不支持内网地址');
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error('不支持内网地址');
  }
}

function isPrivateAddress(address) {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) {
    return true;
  }
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

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
