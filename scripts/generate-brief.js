import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIME_ZONE = "Asia/Shanghai";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");
const OUTPUT_FILES = ["index.html", "finance-morning-brief.html"];

const sources = [
  {
    name: "Google News Business",
    url: "https://news.google.com/topstories?topic=b",
    rss: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-CN&gl=US&ceid=US:zh-Hans"
  },
  {
    name: "MarketWatch",
    url: "https://www.marketwatch.com/",
    rss: "https://feeds.content.dowjones.io/public/rss/mw_topstories"
  },
  {
    name: "CNBC Markets",
    url: "https://www.cnbc.com/markets/",
    rss: "https://www.cnbc.com/id/100003114/device/rss/rss.html"
  },
  {
    name: "Google News Markets",
    url: "https://news.google.com/search?q=markets%20stocks%20oil%20dollar",
    rss: "https://news.google.com/rss/search?q=markets%20stocks%20oil%20dollar%20when:1d&hl=zh-CN&gl=US&ceid=US:zh-Hans"
  },
  {
    name: "财新网",
    url: "https://www.caixin.com/finance/",
    rss: "https://www.caixin.com/rss/"
  }
];

const fallbackNews = [
  {
    title: "全球市场等待最新宏观数据与央行信号",
    link: "https://www.reuters.com/markets/",
    source: "Reuters Markets",
    description: "投资者继续评估通胀、就业、利率路径和企业盈利对股债汇商品的影响。",
    category: "宏观"
  },
  {
    title: "美股和科技股仍是全球风险偏好的核心观察对象",
    link: "https://www.cnbc.com/markets/",
    source: "CNBC Markets",
    description: "大型科技公司盈利、AI资本开支和美债收益率变化，将继续影响成长股估值。",
    category: "美股"
  },
  {
    title: "中国资产关注政策落地、消费修复和资金流向",
    link: "https://finance.sina.com.cn/",
    source: "新浪财经",
    description: "A股和港股短期仍取决于政策预期、盈利修复、外资流向和人民币汇率表现。",
    category: "中国资产"
  }
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripTags(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function getTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeEntities(stripTags(match?.[1] ?? ""));
}

function getLink(itemXml) {
  const link = getTag(itemXml, "link");
  if (link) return link;
  const href = itemXml.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
  return decodeEntities(href ?? "");
}

function categorize(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (/fed|inflation|rates|央行|通胀|利率|美联储/.test(text)) return "宏观";
  if (/stock|nasdaq|s&p|dow|equity|股|a股|港股|美股/.test(text)) return "股市";
  if (/oil|crude|brent|opec|原油|能源/.test(text)) return "原油";
  if (/gold|metal|黄金|金价|铜/.test(text)) return "商品";
  if (/dollar|yuan|yen|euro|currency|美元|人民币|汇率/.test(text)) return "外汇";
  if (/china|中国|房地产|消费/.test(text)) return "中国资产";
  return "财经";
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "finance-morning-brief/1.0 (+https://github.com/mingmingcui0404/finance-morning-brief)"
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRss(source) {
  try {
    const xml = await fetchText(source.rss);
    const chunks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
    return chunks.slice(0, 8).map((chunk) => {
      const title = getTag(chunk, "title");
      const description = getTag(chunk, "description") || getTag(chunk, "summary") || getTag(chunk, "content");
      const link = getLink(chunk) || source.url;
      const pubDate = getTag(chunk, "pubDate") || getTag(chunk, "updated") || getTag(chunk, "published");
      return {
        title,
        description,
        link,
        source: source.name,
        pubDate,
        category: categorize(title, description)
      };
    }).filter((item) => item.title);
  } catch (error) {
    console.warn(`Failed to fetch ${source.name}: ${error.message}`);
    return [];
  }
}

function dedupeNews(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/\W+/g, "").slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function pickTopNews(items) {
  const categoryOrder = ["宏观", "股市", "中国资产", "外汇", "原油", "商品", "财经"];
  const picked = [];
  for (const category of categoryOrder) {
    const item = items.find((candidate) => candidate.category === category && !picked.includes(candidate));
    if (item) picked.push(item);
  }
  for (const item of items) {
    if (picked.length >= 8) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.slice(0, 8);
}

function summarize(item) {
  const description = item.description || "请点击来源查看详情。";
  const short = description.length > 105 ? `${description.slice(0, 105)}...` : description;
  const impact = {
    "宏观": "影响利率预期、美元和全球风险资产定价。",
    "股市": "关注资金风险偏好、估值压力和行业轮动。",
    "中国资产": "关注政策落地、盈利修复与外资流向。",
    "外汇": "影响人民币、亚洲货币和跨境资金情绪。",
    "原油": "牵动输入型通胀、能源股和航空运输成本。",
    "商品": "反映避险需求、实际利率和全球需求预期。",
    "财经": "可能影响市场情绪和短线交易主线。"
  }[item.category] ?? "可能影响市场情绪和短线交易主线。";
  return `${short} ${impact}`;
}

function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...options
  }).format(date).replaceAll("/", "-");
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replaceAll("/", "-");
}

function marketTone(news) {
  const text = news.map((item) => `${item.title} ${item.description}`).join(" ").toLowerCase();
  return {
    stocks: /rally|rise|gain|上涨|走高|反弹/.test(text) ? "偏暖" : "观察",
    dollar: /dollar.*fall|美元.*回落|美元.*走弱/.test(text) ? "回落" : "观察",
    oil: /oil.*fall|crude.*fall|油价.*下跌|原油.*回落/.test(text) ? "回落" : "波动",
    gold: /gold|黄金/.test(text) ? "震荡" : "观察",
    china: /china|中国|a股|港股|人民币/.test(text) ? "关注升温" : "观察",
    bonds: /yield|treasury|美债|收益率/.test(text) ? "利率敏感" : "观察"
  };
}

function renderHtml(news) {
  const now = new Date();
  const date = formatDate(now);
  const dateTime = formatDateTime(now);
  const tone = marketTone(news);
  const top = news[0];
  const summary = top
    ? `一句话总览：${top.title}。今日重点关注全球风险偏好、美元与利率预期、中国资产资金流向，以及原油和黄金对宏观与地缘消息的反应。`
    : "一句话总览：今日重点关注全球风险偏好、美元与利率预期、中国资产资金流向，以及原油和黄金对宏观与地缘消息的反应。";

  const newsCards = news.map((item) => `
            <article class="item">
              <h3><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
              <p>${escapeHtml(summarize(item))}</p>
              <div class="tagrow"><span class="tag">${escapeHtml(item.category)}</span><span class="tag">${escapeHtml(item.source)}</span>${item.pubDate ? `<span class="tag">${escapeHtml(item.pubDate)}</span>` : ""}</div>
            </article>`).join("\n");

  const sourceLinks = sources.map((source) => `
            <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a>`).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>财经信息汇总 - ${escapeHtml(date)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #657084;
      --line: #dfe5ee;
      --blue: #2357a6;
      --green: #14785d;
      --red: #b43d3d;
      --gold: #a06512;
      --shadow: 0 12px 30px rgba(24, 35, 55, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.6;
    }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .wrap { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
    header {
      background: #172033;
      color: #fff;
      padding: 34px 0 28px;
      border-bottom: 4px solid #d89a2b;
    }
    .topline {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 46px);
      letter-spacing: 0;
      line-height: 1.12;
    }
    .stamp { margin-top: 8px; color: #cbd5e1; font-size: 14px; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid rgba(255, 255, 255, 0.28);
      border-radius: 999px;
      color: #f7fafc;
      font-size: 14px;
      white-space: nowrap;
    }
    .summary {
      margin-top: 24px;
      max-width: 900px;
      font-size: 18px;
      color: #edf2f7;
    }
    main { padding: 28px 0 44px; }
    .grid {
      display: grid;
      grid-template-columns: 1.45fr 0.9fr;
      gap: 18px;
      align-items: start;
    }
    section {
      margin-bottom: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    section h2 {
      margin: 0;
      padding: 16px 18px 12px;
      font-size: 18px;
      line-height: 1.35;
      border-bottom: 1px solid var(--line);
    }
    .body { padding: 16px 18px 18px; }
    .news { display: grid; gap: 12px; }
    .item {
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcff;
    }
    .item h3 {
      margin: 0 0 7px;
      font-size: 16px;
      line-height: 1.42;
    }
    .item p { margin: 0; color: var(--muted); font-size: 14px; }
    .tagrow { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #eef3fa;
      color: #334155;
      font-size: 12px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      min-height: 86px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcff;
    }
    .metric .name { color: var(--muted); font-size: 13px; }
    .metric .value {
      margin-top: 4px;
      font-size: 22px;
      font-weight: 700;
      line-height: 1.2;
    }
    .metric .note { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .up { color: var(--green); }
    .down { color: var(--red); }
    .watch { color: var(--gold); }
    ul { margin: 0; padding-left: 20px; }
    li + li { margin-top: 9px; }
    .sources { display: grid; gap: 8px; font-size: 14px; }
    .note {
      padding: 12px 14px;
      border-left: 4px solid #d89a2b;
      background: #fff8eb;
      color: #5f4630;
      border-radius: 6px;
      font-size: 14px;
    }
    footer { color: var(--muted); font-size: 12px; padding: 0 0 30px; }
    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
      header { padding-top: 28px; }
      .badge { white-space: normal; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="topline">
        <div>
          <h1>财经信息汇总</h1>
          <div class="stamp">生成时间：${escapeHtml(dateTime)} Asia/Shanghai</div>
        </div>
        <div class="badge">每天 08:00 自动更新</div>
      </div>
      <p class="summary">${escapeHtml(summary)}</p>
    </div>
  </header>

  <main class="wrap">
    <div class="grid">
      <div>
        <section>
          <h2>重点新闻与影响</h2>
          <div class="body news">${newsCards}
          </div>
        </section>
      </div>

      <aside>
        <section>
          <h2>主要市场指标</h2>
          <div class="body">
            <div class="note">口径说明：本页由 GitHub Actions 定时生成，部分实时行情可能以新闻源和最近可用数据为准；请以交易所和官方发布为准。</div>
            <div class="metrics" style="margin-top:12px">
              <div class="metric"><div class="name">全球股市</div><div class="value ${tone.stocks === "偏暖" ? "up" : "watch"}">${escapeHtml(tone.stocks)}</div><div class="note">关注美股、日股、港股和A股联动</div></div>
              <div class="metric"><div class="name">美元指数</div><div class="value ${tone.dollar === "回落" ? "down" : "watch"}">${escapeHtml(tone.dollar)}</div><div class="note">影响人民币和大宗商品定价</div></div>
              <div class="metric"><div class="name">美债收益率</div><div class="value watch">${escapeHtml(tone.bonds)}</div><div class="note">牵动成长股估值和黄金价格</div></div>
              <div class="metric"><div class="name">原油</div><div class="value ${tone.oil === "回落" ? "down" : "watch"}">${escapeHtml(tone.oil)}</div><div class="note">关注供需、OPEC+和地缘消息</div></div>
              <div class="metric"><div class="name">黄金</div><div class="value watch">${escapeHtml(tone.gold)}</div><div class="note">受避险需求与实际利率共同影响</div></div>
              <div class="metric"><div class="name">中国资产</div><div class="value watch">${escapeHtml(tone.china)}</div><div class="note">关注政策、盈利和跨境资金流</div></div>
            </div>
          </div>
        </section>

        <section>
          <h2>今日关注</h2>
          <div class="body">
            <ul>
              <li>美国通胀、就业、消费者信心与美联储官员表态。</li>
              <li>中国政策落地、人民币汇率、A股与港股资金流向。</li>
              <li>大型科技公司盈利、AI资本开支和半导体产业链消息。</li>
              <li>原油、黄金和工业金属对美元、利率与地缘消息的反应。</li>
              <li>重要公司业绩、监管变化和突发地缘事件。</li>
            </ul>
          </div>
        </section>

        <section>
          <h2>风险提示</h2>
          <div class="body">
            <ul>
              <li>新闻源发布时间和市场实时数据可能存在延迟。</li>
              <li>宏观数据若显著偏离预期，股债汇商品可能同步放大波动。</li>
              <li>地缘冲突、政策变化或流动性收缩可能快速改变资产定价。</li>
              <li>本页为新闻与市场信息汇总，不构成投资建议。</li>
            </ul>
          </div>
        </section>

        <section>
          <h2>参考来源</h2>
          <div class="body sources">${sourceLinks}
          </div>
        </section>
      </aside>
    </div>
  </main>

  <footer class="wrap">
    本页由 GitHub Actions 每天 08:00（Asia/Shanghai）定时生成，并通过 Cloudflare Pages 部署。
  </footer>
</body>
</html>
`;
}

async function main() {
  const fetched = (await Promise.all(sources.map(fetchRss))).flat();
  const news = pickTopNews(dedupeNews(fetched)).concat(fallbackNews).slice(0, 8);
  const html = renderHtml(news);
  await mkdir(PUBLIC_DIR, { recursive: true });
  await Promise.all([
    ...OUTPUT_FILES.map((file) => writeFile(resolve(PUBLIC_DIR, file), html, "utf8")),
    ...OUTPUT_FILES.map((file) => writeFile(resolve(REPO_ROOT, file), html, "utf8"))
  ]);
  console.log(`Generated ${OUTPUT_FILES.join(", ")} in public/ and repo root with ${news.length} news items.`);
}

await main();
