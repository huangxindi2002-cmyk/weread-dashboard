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
  const candidates = shelfBooks
    .filter((b) => b.readUpdateTime && b.finishReading === 0)
    .sort((a, b) => (b.readUpdateTime || 0) - (a.readUpdateTime || 0));
  const currentBook = candidates[0] || null;

  // Phase 2: depend on currentBook + top notebook
  const topNotebook = (notebooks.books || [])[0];
  const [progress, recentBookmarks] = await Promise.all([
    currentBook
      ? wereadCall(env, "/book/getprogress", { bookId: currentBook.bookId })
      : Promise.resolve(null),
    topNotebook
      ? wereadCall(env, "/book/bookmarklist", { bookId: topNotebook.bookId })
      : Promise.resolve(null),
  ]);

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
          progress: progress
            ? {
                progress: progress.progress,
                readingTime: progress.readingTime,
                updateTime: progress.updateTime,
                chapterIdx: progress.chapterIdx,
                chapterTitle: progress.chapterTitle,
              }
            : null,
        }
      : null,
    shelf: {
      totalBooks: shelfBooks.length,
      totalAlbums: (shelf.albums || []).length,
      hasMp: !!(shelf.mp && Object.keys(shelf.mp).length),
    },
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
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "weread-dashboard" }, env, 200, request);
      }
      return json({ error: "not found" }, env, 404, request);
    } catch (e) {
      return json({ error: String(e), stack: e.stack }, env, 500, request);
    }
  },
};
