// Cloudflare Worker — weread-dashboard backend
// Routes:
//   GET  /api/dashboard  — fetch all dashboard data
//   POST /api/chat       — Claude + WeRead tool-use loop
//   OPTIONS /*           — CORS preflight

const WEREAD_BASE = "https://i.weread.qq.com/api/agent/gateway";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";
const SKILL_VERSION = "1.0.3";
const CLAUDE_MODEL = "claude-opus-4-7";
const MAX_TOOL_ROUNDS = 10;

let cachedApiCatalog = null;

function cors(env, request) {
  const allowedList = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request?.headers?.get("Origin") || "";
  const allow =
    allowedList.length === 0
      ? "*"
      : allowedList.includes(origin)
        ? origin
        : allowedList[0]; // fallback echoes first allowed (browser will block mismatched origins)
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, env, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env, request) },
  });
}

async function wereadCall(env, apiName, params = {}) {
  const body = { api_name: apiName, skill_version: SKILL_VERSION, ...params };
  const res = await fetch(WEREAD_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WEREAD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function getApiCatalog(env) {
  if (cachedApiCatalog) return cachedApiCatalog;
  const list = await wereadCall(env, "/_list");
  cachedApiCatalog = (list.apis || [])
    .map((a) => `- ${a.api_name} — ${a.description}`)
    .join("\n");
  return cachedApiCatalog;
}

function fmtDateUTC(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function fetchBookData(env, bookId) {
  const [info, bookmarks, reviews, progress] = await Promise.all([
    wereadCall(env, "/book/info", { bookId }),
    wereadCall(env, "/book/bookmarklist", { bookId }),
    wereadCall(env, "/review/list/mine", { bookid: bookId, count: 50 }),
    wereadCall(env, "/book/getprogress", { bookId }),
  ]);
  return { info, bookmarks, reviews, progress };
}

function formatBookContext(book, opts = {}) {
  const { info, bookmarks, reviews, progress } = book;
  const chMap = {};
  for (const c of bookmarks.chapters || []) chMap[c.chapterUid] = c.title;

  const bms = (bookmarks.updated || []).sort(
    (a, b) => (a.createTime || 0) - (b.createTime || 0),
  );
  const revs = (reviews.reviews || [])
    .map((r) => r.review || r)
    .sort((a, b) => (a.createTime || 0) - (b.createTime || 0));

  const lines = [];
  lines.push(`书名: ${info.title || ""}`);
  lines.push(`作者: ${info.author || ""}`);
  if (info.category) lines.push(`分类: ${info.category}`);
  if (info.intro) lines.push(`简介(供你判断书的题材气质): ${info.intro.slice(0, 400).replace(/\s+/g, " ")}`);

  const prog = (progress && progress.book) || progress || {};
  lines.push("");
  lines.push("# 阅读状态");
  if (prog.progress != null) lines.push(`进度: ${prog.progress}%`);
  if (prog.readingTime)
    lines.push(`累计停留时长: ${Math.round(prog.readingTime / 60)} 分钟`);
  if (prog.startReadingTime)
    lines.push(`首次阅读: ${fmtDateUTC(prog.startReadingTime)}`);
  if (prog.updateTime) lines.push(`最后活动: ${fmtDateUTC(prog.updateTime)}`);
  if (prog.summary) lines.push(`最后停留段落: ${prog.summary.slice(0, 80)}`);

  if (bms.length) {
    lines.push("");
    lines.push(`# 你的划线 (共 ${bms.length} 条, 按时间从早到晚)`);
    const limit = opts.maxBookmarks || 80;
    for (const b of bms.slice(0, limit)) {
      const date = fmtDateUTC(b.createTime);
      const ch = chMap[b.chapterUid] || "";
      lines.push(`[${date}][${ch}] ${(b.markText || "").replace(/\s+/g, " ")}`);
    }
    if (bms.length > limit)
      lines.push(`... (还有 ${bms.length - limit} 条已省略)`);
  } else {
    lines.push("");
    lines.push("# 你的划线: 无");
  }

  if (revs.length) {
    lines.push("");
    lines.push(`# 你的想法/批注 (共 ${revs.length} 条, 按时间从早到晚)`);
    const limit = opts.maxReviews || 30;
    for (const r of revs.slice(0, limit)) {
      const date = fmtDateUTC(r.createTime);
      const ch = r.chapterTitle || r.chapterName || "";
      const abs = r.abstract
        ? `\n  原文: ${r.abstract.slice(0, 200).replace(/\s+/g, " ")}`
        : "";
      const content = (r.content || "").replace(/\s+/g, " ");
      lines.push(`[${date}][${ch}]${abs}\n  你写的: ${content}`);
    }
    if (revs.length > limit)
      lines.push(`... (还有 ${revs.length - limit} 条已省略)`);
  } else {
    lines.push("");
    lines.push("# 你的想法: 无");
  }

  return lines.join("\n");
}

async function callClaudeOnce(env, system, userText) {
  const resp = await fetch(ANTHROPIC_BASE, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text, usage: data.usage };
}

// ---------- /api/dashboard ----------

async function handleDashboard(env) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  // Build monthly baseTimes (UTC second-precision) for Jan..currentMonth
  const monthlyBaseTimes = [];
  for (let m = 1; m <= currentMonth; m++) {
    const ts = Math.floor(Date.UTC(currentYear, m - 1, 1) / 1000);
    monthlyBaseTimes.push(ts);
  }

  const [yearStat, shelf, notebooks, ...monthly] = await Promise.all([
    wereadCall(env, "/readdata/detail", { mode: "annually" }),
    wereadCall(env, "/shelf/sync"),
    wereadCall(env, "/user/notebooks", { count: 10 }),
    ...monthlyBaseTimes.map((bt) =>
      wereadCall(env, "/readdata/detail", { mode: "monthly", baseTime: bt }),
    ),
  ]);

  // Daily heatmap: merge readTimes (already daily for monthly mode)
  const dailyHeatmap = {};
  for (const m of monthly) {
    if (m && m.readTimes) {
      for (const [ts, sec] of Object.entries(m.readTimes)) {
        dailyHeatmap[ts] = sec;
      }
    }
  }

  // Currently reading: most recent unfinished book from shelf
  const shelfBooks = shelf.books || [];
  const unfinishedCandidates = shelfBooks
    .filter((b) => b.readUpdateTime && b.finishReading === 0)
    .sort((a, b) => (b.readUpdateTime || 0) - (a.readUpdateTime || 0));
  const currentBook = unfinishedCandidates[0] || null;
  const topUnfinished = unfinishedCandidates.slice(0, 8);

  // Phase 2: fetch progress for top unfinished books + bookmarklist for top notebook
  const topNotebook = (notebooks.books || [])[0];
  const [recentBookmarks, ...unfinishedProgresses] = await Promise.all([
    topNotebook
      ? wereadCall(env, "/book/bookmarklist", { bookId: topNotebook.bookId })
      : Promise.resolve(null),
    ...topUnfinished.map((b) =>
      wereadCall(env, "/book/getprogress", { bookId: b.bookId }).catch(() => null),
    ),
  ]);
  const progress = unfinishedProgresses[0] || null;

  return {
    year: currentYear,
    updatedAt: Date.now(),
    yearStat: {
      totalReadTime: yearStat.totalReadTime,
      readDays: yearStat.readDays,
      dayAverageReadTime: yearStat.dayAverageReadTime,
      compare: yearStat.compare,
      readStat: yearStat.readStat,
      readLongest: (yearStat.readLongest || []).slice(0, 5).map((r) => ({
        title: r.book?.title,
        author: r.book?.author,
        cover: r.book?.cover,
        bookId: r.book?.bookId,
        readTime: r.readTime,
        tags: r.tags,
      })),
      preferCategory: (yearStat.preferCategory || []).slice(0, 6),
      preferCategoryWord: yearStat.preferCategoryWord,
      monthlyBuckets: yearStat.readTimes,
    },
    dailyHeatmap,
    currentBook: currentBook
      ? {
          bookId: currentBook.bookId,
          title: currentBook.title,
          author: currentBook.author,
          cover: currentBook.cover,
          category: currentBook.category,
          readUpdateTime: currentBook.readUpdateTime,
          progress: progress?.book
            ? {
                progress: progress.book.progress,
                readingTime: progress.book.readingTime,
                updateTime: progress.book.updateTime,
                chapterIdx: progress.book.chapterIdx,
                chapterTitle: progress.book.summary?.slice(0, 60),
                startReadingTime: progress.book.startReadingTime,
              }
            : null,
        }
      : null,
    shelf: {
      totalBooks: shelfBooks.length,
      totalAlbums: (shelf.albums || []).length,
      hasMp: !!(shelf.mp && Object.keys(shelf.mp).length),
    },
    unfinishedBooks: topUnfinished.map((b, i) => {
      const pb = unfinishedProgresses[i]?.book || {};
      return {
        bookId: b.bookId,
        title: b.title,
        author: b.author,
        cover: b.cover,
        category: b.category,
        readUpdateTime: b.readUpdateTime,
        progress: pb.progress ?? null,
        readingTime: pb.readingTime ?? null,
        startReadingTime: pb.startReadingTime ?? null,
        chapterTitle: pb.summary?.slice(0, 60) || null,
      };
    }),
    notebooks: {
      totalBookCount: notebooks.totalBookCount,
      totalNoteCount: notebooks.totalNoteCount,
      recentBooks: (notebooks.books || []).slice(0, 6).map((b) => ({
        bookId: b.bookId,
        title: b.book?.title,
        author: b.book?.author,
        cover: b.book?.cover,
        noteCount: b.noteCount,
        reviewCount: b.reviewCount,
        bookmarkCount: b.bookmarkCount,
        readingProgress: b.readingProgress,
        sort: b.sort,
      })),
    },
    recentHighlights:
      recentBookmarks && topNotebook
        ? {
            bookId: topNotebook.bookId,
            title: topNotebook.book?.title,
            author: topNotebook.book?.author,
            cover: topNotebook.book?.cover,
            items: (recentBookmarks.updated || [])
              .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
              .slice(0, 8)
              .map((bm) => ({
                bookmarkId: bm.bookmarkId,
                chapterUid: bm.chapterUid,
                chapterIdx: bm.chapterIdx,
                range: bm.range,
                markText: bm.markText,
                createTime: bm.createTime,
                colorStyle: bm.colorStyle,
              })),
            chapters: recentBookmarks.chapters,
          }
        : null,
  };
}

// ---------- /api/chat ----------

async function handleChat(env, request) {
  const { messages } = await request.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "messages required" }, env, 400, request);
  }

  const catalog = await getApiCatalog(env);
  const today = new Date().toISOString().slice(0, 10);

  const system = `你是「微信读书助手」,通过 weread_call 工具调用以下接口获取用户阅读数据:

${catalog}

# 调用规范
- 业务参数放在 weread_call 的 params 对象里(后端会平铺到顶层)
- 用户给书名时,先用 /store/search 拿 bookId,再调后续接口
- 当前日期: ${today}
- 时间戳字段一律转 YYYY-MM-DD 展示,不要展示原始数字
- 阅读时长单位为秒,展示成 "X小时Y分钟"
- 列表用编号(1. 2. 3.)
- /readdata/detail 的 mode:weekly/monthly/annually/overall,默认 monthly
- 回答简洁,不要重复用户问题`;

  const tools = [
    {
      name: "weread_call",
      description: "调用微信读书接口。先用 /_list 看目录,然后调具体接口。",
      input_schema: {
        type: "object",
        properties: {
          api_name: {
            type: "string",
            description: "接口名,如 /store/search、/readdata/detail",
          },
          params: {
            type: "object",
            description: "接口业务参数对象,如 {keyword: '三体', count: 10}",
            additionalProperties: true,
          },
        },
        required: ["api_name"],
      },
    },
  ];

  let convo = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await fetch(ANTHROPIC_BASE, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system,
        messages: convo,
        tools,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json(
        { error: "Claude API error", status: resp.status, detail: errText },
        env,
        502,
        request,
      );
    }

    const data = await resp.json();

    if (data.stop_reason === "tool_use") {
      convo.push({ role: "assistant", content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === "tool_use" && block.name === "weread_call") {
          try {
            const result = await wereadCall(
              env,
              block.input.api_name,
              block.input.params || {},
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          } catch (e) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ error: String(e) }),
              is_error: true,
            });
          }
        }
      }
      convo.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn / max_tokens / stop_sequence
    convo.push({ role: "assistant", content: data.content });
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return json(
      {
        text,
        stop_reason: data.stop_reason,
        usage: data.usage,
        messages: convo,
      },
      env,
      200,
      request,
    );
  }

  return json({ error: "max tool rounds exceeded", messages: convo }, env, 500, request);
}

// ---------- /api/book/summary ----------

const BOOK_SUMMARY_SYSTEM = `你是一位文学阅读分析师,从用户在一本书里留下的划线和想法中,提炼一段「你对这本书的理解」。

写作原则:
- 文风:理性为主底色,允许一丝克制的诗意——像年度阅读报告里那种安静的回望,而非读书笔记
- 长度:300-500 字,自然分 2-3 段
- 视角:第二人称("你"),不要写成"该读者"
- 不要逐条罗列划线原文,而是从划线和想法的"选择"里读出:你被什么打动、关注的主题、思考的脉络
- 不要总结全书内容,聚焦"你"这一次阅读的私人路径
- 不要客套话开头("在《xxx》中,你..." 这类),直接进入观察
- 不要 markdown 标题,只用段落
- 不要使用大量 emoji,最多 1 个,可省略
- 如果数据极少(只有 1-2 条划线/想法),坦诚地写——也许这本书只是擦肩而过,不必硬凑`;

async function handleBookSummary(env, request) {
  const { bookId } = await request.json();
  if (!bookId) return json({ error: "bookId required" }, env, 400, request);

  const book = await fetchBookData(env, bookId);
  if (!book.info || book.info.errcode) {
    return json({ error: "book not found or no access", detail: book.info }, env, 404, request);
  }
  const context = formatBookContext(book);
  const { text, usage } = await callClaudeOnce(env, BOOK_SUMMARY_SYSTEM, context);
  return json(
    {
      text,
      usage,
      meta: {
        title: book.info.title,
        author: book.info.author,
        cover: book.info.cover,
        bookmarkCount: (book.bookmarks.updated || []).length,
        reviewCount: (book.reviews.reviews || []).length,
      },
    },
    env,
    200,
    request,
  );
}

// ---------- /api/book/footprint ----------

const BOOK_FOOTPRINT_SYSTEM = `你是一位阅读行为分析师。根据用户对某本书的阅读足迹,简述足迹 + 推测他可能为何停下脚步。

写作原则:
- 文风:温和、共情、略带文艺,不批判不说教,像朋友在帮你回看一段路
- 长度:200-400 字,2-3 段
- 结构建议:
  - 首段:简述阅读足迹——什么时候第一次翻开、读到了哪里(进度+大致章节)、最后一次留下痕迹是什么时候、相隔多久、累计停留多长
  - 中段:从数据线索里推测 2-3 种"或许"的停下原因(题材厚重?难度?生活节奏?某个时间点之后断了?某一类划线后突然停止?)——要扣数据,不要泛泛而谈
  - 收尾:可省略,或一句温和的尾收(如"也许哪天还会重新翻开")
- 视角:第二人称
- 不下定论,用"或许"、"可能"、"也许"
- 不要 markdown 标题
- 不要 emoji,如果非要 1 个`;

async function handleBookFootprint(env, request) {
  const { bookId } = await request.json();
  if (!bookId) return json({ error: "bookId required" }, env, 400, request);

  const book = await fetchBookData(env, bookId);
  if (!book.info || book.info.errcode) {
    return json({ error: "book not found or no access", detail: book.info }, env, 404, request);
  }
  const context = formatBookContext(book, { maxBookmarks: 60, maxReviews: 20 });
  const { text, usage } = await callClaudeOnce(env, BOOK_FOOTPRINT_SYSTEM, context);
  return json(
    {
      text,
      usage,
      meta: {
        title: book.info.title,
        author: book.info.author,
        cover: book.info.cover,
        progress: book.progress?.book?.progress,
        readingTime: book.progress?.book?.readingTime,
        startReadingTime: book.progress?.book?.startReadingTime,
        lastActivity: book.progress?.book?.updateTime,
        bookmarkCount: (book.bookmarks.updated || []).length,
        reviewCount: (book.reviews.reviews || []).length,
      },
    },
    env,
    200,
    request,
  );
}

// ---------- main fetch handler ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env, request) });
    }

    try {
      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        const data = await handleDashboard(env);
        return json(data, env, 200, request);
      }
      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(env, request);
      }
      if (url.pathname === "/api/book/summary" && request.method === "POST") {
        return await handleBookSummary(env, request);
      }
      if (url.pathname === "/api/book/footprint" && request.method === "POST") {
        return await handleBookFootprint(env, request);
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "weread-dashboard" }, env, 200, request);
      }
      return json({ error: "not found" }, env, 404, request);
    } catch (e) {
      return json({ error: String(e), stack: e.stack }, env, 500, request);
    }
  },
};
