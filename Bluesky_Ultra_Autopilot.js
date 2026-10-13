/* ====================================================
   ★ المكان المحدد اللي تحط فيه حاجتك لأي وركر جديد ★
   لو مش عايز تلعب في Variables حط هنا واعمل Deploy
   1) ADMIN_KEY: باسورد اللوحة (لو سبته فاضي اللوحة مفتوحة)
   2) SEED_HANDLE + SEED_PASSWORD: حساب بلو سكاي اللي يتربط لوحده
      مثال: SEED_HANDLE: "user.bsky.social"
      مثال: SEED_PASSWORD: "xxxx-xxxx-xxxx-xxxx" (App Password)
   ملحوظة: الأفضل تحطهم في Settings > Variables بنفس الأسماء
   والـ Variables تكسب لو موجودة.
==================================================== */
const CONFIG = {
  ADMIN_KEY: "",
  SEED_HANDLE: "",
  SEED_PASSWORD: ""
};

export default {
  async scheduled(event, env, ctx) {
    // Keep a failed Cron invocation observable instead of leaving an unhandled rejection.
    ctx.waitUntil(handleScheduledPosting(env).catch(async (e) => {
      await pushLog(env, {
        time: Date.now(), handle: "[CRON]", url: "", text: "",
        success: false, kind: "cron-fatal", type: "system",
        error: String(e && e.message || e || "Scheduled posting failed").slice(0, 200)
      });
    }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "POST" && pathname === "/api/save") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        await saveAccounts(env, body.accounts || []);
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/toggle") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const accounts = await getAccounts(env);
        if (body.index === undefined || !accounts[body.index]) {
          return json({ error: "الحساب غير موجود" }, 400);
        }
        if (body.target === "video") {
          accounts[body.index].videoEnabled = body.enabled === true;
          if (body.enabled === true) {
            accounts[body.index].videoNextPostAt = Date.now() + 60000;
            accounts[body.index].videoLastError = "";
          }
          await saveAccounts(env, accounts);
          return json({ success: true, enabled: accounts[body.index].videoEnabled, nextPostAt: accounts[body.index].videoNextPostAt });
        }
        if (body.target === "text") {
          accounts[body.index].textEnabled = body.enabled === true;
          if (body.enabled === true) {
            accounts[body.index].textNextPostAt = Date.now() + 60000;
            accounts[body.index].textLastError = "";
          }
          await saveAccounts(env, accounts);
          return json({ success: true, enabled: accounts[body.index].textEnabled, nextPostAt: accounts[body.index].textNextPostAt });
        }
        accounts[body.index].postingEnabled = body.enabled === true;
        if (body.enabled === true) {
          accounts[body.index].nextPostAt = Date.now() + 60000;
          accounts[body.index].lastError = "";
        }
        await saveAccounts(env, accounts);
        return json({ success: true, enabled: accounts[body.index].postingEnabled, nextPostAt: accounts[body.index].nextPostAt });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/add-account") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const db = getKV(env);
        if (!db) return json({ error: "قاعدة البيانات غير مربوطة — روح Settings > Bindings > Add KV باسم BSKY_DB ثم Redeploy" }, 500);
        const handle = normalizeHandle(body.handle || "");
        const password = normalizePassword(body.password || "");
        if (!handle || !password) return json({ error: "برجاء إدخال الحساب وكلمة المرور" }, 400);
        const accounts = await getAccounts(env);
        if (accounts.some(a => normalizeHandle(a.handle) === handle)) return json({ error: "هذا الحساب موجود بالفعل" }, 400);

        const login = await bskyLogin(handle, password);
        if (!login.ok) return json({ error: login.error || "فشل تسجيل الدخول" }, 400);

        const account = normalizeAccount({ handle, password });
        accounts.unshift(account);
        await saveAccounts(env, accounts);
        return json({ success: true, account });
      } catch (e) {
        return json({ error: friendlyError(e) }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/delete-account") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const accounts = await getAccounts(env);
        if (!Number.isInteger(body.index) || !accounts[body.index]) return json({ error: "الحساب غير موجود" }, 400);
        accounts.splice(body.index, 1);
        await saveAccounts(env, accounts);
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/check-account") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const accounts = await getAccounts(env);
        if (!Number.isInteger(body.index) || !accounts[body.index]) return json({ error: "الحساب غير موجود" }, 400);
        const account = accounts[body.index];
        const login = await bskyLogin(account.handle, account.password);
        return json({ success: true, online: login.ok, profile: login.profile || null });
      } catch (e) {
        return json({ success: true, online: false });
      }
    }

    if (request.method === "POST" && pathname === "/api/test-post") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const accounts = await getAccounts(env);
        if (!Number.isInteger(body.index) || !accounts[body.index]) return json({ error: "الحساب غير موجود" }, 400);
        const account = accounts[body.index];
        if (!account.queue?.length) return json({ error: "لا توجد صورة لاختبار النشر" }, 400);
        const result = await publishItem(account, account.queue[0], env);
        if (!result.success) return json({ error: result.error }, 400);
        await pushLog(env, { time: Date.now(), handle: account.handle, url: account.queue[0].url || account.queue[0].urls?.[0] || "", text: result.previewText || "", uri: result.uri || "", success: true, kind: "test" });
        return json({ success: true, uri: result.uri || null, link: result.link || null });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/test-text-post") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const accounts = await getAccounts(env);
        if (!Number.isInteger(body.index) || !accounts[body.index]) return json({ error: "الحساب غير موجود" }, 400);
        const account = accounts[body.index];
        if (!account.textQueue?.length) return json({ error: "لا يوجد بوست نصي لاختبار النشر" }, 400);
        const result = await publishTextItem(account, account.textQueue[0]);
        if (!result.success) return json({ error: result.error }, 400);
        await pushLog(env, { time: Date.now(), handle: account.handle, url: account.textQueue[0].link || "", text: result.previewText || "", uri: result.uri || "", success: true, kind: "text-test", type: "text" });
        return json({ success: true, uri: result.uri || null, link: result.link || null });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/test-video-post") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const accounts = await getAccounts(env);
        if (!Number.isInteger(body.index) || !accounts[body.index]) return json({ error: "الحساب غير موجود" }, 400);
        const account = accounts[body.index];
        if (!account.videoQueue?.length) return json({ error: "لا يوجد فيديو لاختبار النشر" }, 400);
        const item = account.videoQueue[0];
        const result = await publishVideoItem(account, item);
        if (result.processing && result.jobId) {
          item.jobId = result.jobId;
          account.videoNextPostAt = Date.now() + 60000;
          account.videoLastError = "الفيديو قيد المعالجة على Bluesky؛ سيُستكمل تلقائيًا";
          await saveAccounts(env, accounts);
          return json({ success: false, processing: true, error: account.videoLastError });
        }
        if (!result.success) {
          // A terminal processing failure must not leave a stale jobId in the queue.
          if (item.jobId) {
            item.jobId = "";
            account.videoLastError = String(result.error || "تعذر نشر الفيديو").slice(0, 200);
            await saveAccounts(env, accounts);
          }
          return json({ error: result.error }, 400);
        }
        // Successful video test consumes only the exact queue item that was tested.
        // This prevents the preview from continuing to show a completed job as processing.
        const completedIndex = account.videoQueue.findIndex((queued) => queued === item);
        if (completedIndex >= 0) account.videoQueue.splice(completedIndex, 1);
        else if (account.videoQueue[0] && account.videoQueue[0].url === item.url && account.videoQueue[0].jobId === item.jobId) account.videoQueue.shift();
        await saveAccounts(env, accounts);
        await pushLog(env, { time: Date.now(), handle: account.handle, url: item.url || "", text: result.previewText || "", uri: result.uri || "", link: result.link || "", success: true, kind: "video-test", type: "video" });
        return json({ success: true, removedFromQueue: completedIndex >= 0 || !account.videoQueue.some((queued) => queued.url === item.url && queued.jobId === item.jobId), uri: result.uri || null, link: result.link || null });
      } catch (e) {
        return json({ error: friendlyError(e) }, 500);
      }
    }

    // Discovery: search public Bluesky posts and record viewed candidates for deduplication.
    if (request.method === "GET" && pathname === "/api/discovery/search") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      const query = String(url.searchParams.get("q") || "").trim().slice(0, 300);
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 25) || 25));
      if (!query) return json({ error: "اكتب كلمة أو عبارة للبحث في المنشورات العامة" }, 400);
      try {
        const endpoint = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts");
        endpoint.searchParams.set("q", query);
        endpoint.searchParams.set("limit", String(limit));
        const response = await fetch(endpoint.toString(), { headers: { "Accept": "application/json" } });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 250);
          return json({ error: "فشل البحث العام على Bluesky", status: response.status, detail }, response.status >= 500 ? 502 : response.status);
        }
        const payload = await response.json();
        const posts = (Array.isArray(payload.posts) ? payload.posts : []).map(post => {
          const record = post.record || {};
          const author = post.author || {};
          const uri = String(post.uri || "");
          return {
            uri,
            cid: post.cid || "",
            indexedAt: post.indexedAt || null,
            text: String(record.text || "").slice(0, 3000),
            createdAt: record.createdAt || null,
            lang: Array.isArray(record.langs) ? record.langs : [],
            author: {
              did: author.did || "",
              handle: author.handle || "",
              displayName: String(author.displayName || "").slice(0, 120),
              avatar: author.avatar || "",
              followersCount: Number(author.followersCount || 0),
              followsCount: Number(author.followsCount || 0),
              postsCount: Number(author.postsCount || 0),
              labels: Array.isArray(author.labels) ? author.labels : []
            },
            metrics: {
              replyCount: Number(post.replyCount || 0),
              repostCount: Number(post.repostCount || 0),
              likeCount: Number(post.likeCount || 0),
              quoteCount: Number(post.quoteCount || 0)
            },
            replyRef: post.reply || null,
            record
          };
        });
        // Keep a bounded, cross-request seen set in KV; this records candidates only, it does not interact.
        const db = getKV(env);
        let seen = [];
        if (db) {
          try { seen = JSON.parse(await db.get("discovery_seen_v1") || "[]"); } catch {}
          if (!Array.isArray(seen)) seen = [];
          const seenSet = new Set(seen.map(x => x && x.uri).filter(Boolean));
          const now = Date.now();
          for (const post of posts) {
            post.alreadySeen = seenSet.has(post.uri);
            if (post.uri && !seenSet.has(post.uri)) {
              seen.push({ uri: post.uri, seenAt: now, query });
              seenSet.add(post.uri);
            }
          }
          seen = seen.filter(x => x && x.uri && Number(x.seenAt || 0) > now - 30 * 86400000).slice(-2000);
          await db.put("discovery_seen_v1", JSON.stringify(seen));
        } else {
          for (const post of posts) post.alreadySeen = null;
        }
        return json({
          success: true,
          query,
          count: posts.length,
          cursor: payload.cursor || null,
          dedupePersistent: !!db,
          notice: "هذه نتائج بحث عامة مرشحة للمراجعة؛ لم يتم الإعجاب أو المتابعة أو الرد تلقائياً.",
          posts
        });
      } catch (e) {
        return json({ error: friendlyError(e) }, 502);
      }
    }

    // Discovery analysis: transparent heuristic ranking only; it never performs engagement.
    if (request.method === "POST" && pathname === "/api/discovery/analyze") {
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        const query = String(body.query || "").trim().slice(0, 500);
        const posts = Array.isArray(body.posts) ? body.posts.filter(post => post && typeof post === "object" && !Array.isArray(post)).slice(0, 50) : [];
        if (!posts.length) return json({ error: "أرسل قائمة posts صحيحة لتحليلها (حتى 50 منشورًا)" }, 400);
        const normalize = value => String(value || "").toLocaleLowerCase().normalize("NFKC").replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}_#@]+/gu, " ").trim();
        const stop = new Set(["the","and","for","with","this","that","from","your","you","are","was","have","has","بعض","هذا","هذه","ذلك","على","الى","إلى","في","من","عن","مع","هو","هي","ما","لا","لم","لن","كان","كانت"]);
        const tokens = value => normalize(value).split(/\s+/).filter(t => t.length > 1 && !stop.has(t));
        const queryTokens = [...new Set(tokens(query))];
        const analyzed = posts.map((post, index) => {
          const text = String(post.text || post.record?.text || "").slice(0, 3000);
          const author = post.author || {};
          const words = new Set(tokens(text + " " + (author.description || "")));
          const matched = queryTokens.filter(t => words.has(t));
          const relevance = queryTokens.length ? Math.round(100 * matched.length / queryTokens.length) : 0;
          const m = post.metrics && typeof post.metrics === "object" ? post.metrics : post;
          const safeCount = value => { const n = Number(value || 0); return Number.isFinite(n) ? Math.max(0, Math.min(1000000000, n)) : 0; };
          const likes = safeCount(m.likeCount);
          const reposts = safeCount(m.repostCount);
          const replies = safeCount(m.replyCount);
          const engagement = Math.min(20, Math.round(Math.log2(1 + likes + reposts * 2 + replies * 1.5) * 3));
          const textQuality = text.length >= 40 ? 10 : text.length >= 15 ? 5 : 0;
          const alreadySeen = post.alreadySeen === true;
          const labels = Array.isArray(author.labels) ? author.labels : [];
          const riskLabels = labels.filter(x => /spam|impersonat|scam|sexual|misleading/i.test(String(x.val || x.label || "")));
          let score = Math.max(0, Math.min(100, Math.round(relevance * 0.7 + engagement + textQuality)));
          const reasons = [];
          if (matched.length) reasons.push("تطابق كلمات: " + matched.slice(0, 8).join("، "));
          if (engagement) reasons.push("تفاعل عام ملحوظ");
          if (alreadySeen) reasons.push("سبق تسجيل المنشور كمشاهد");
          if (riskLabels.length) { score = Math.min(score, 10); reasons.push("وسوم قد تستدعي مراجعة حذرة"); }
          const recommendation = alreadySeen ? "skip_seen" : riskLabels.length ? "manual_review" : score >= 55 ? "review_high_relevance" : score >= 25 ? "review_low_relevance" : "skip_low_relevance";
          return { uri: String(post.uri || ""), cid: String(post.cid || ""), index, text, author: { handle: String(author.handle || ""), displayName: String(author.displayName || "").slice(0, 120), followersCount: Math.max(0, Number(author.followersCount || 0)) }, metrics: { likeCount: likes, repostCount: reposts, replyCount: replies }, relevanceScore: score, matchedTerms: matched, recommendation, reasons, alreadySeen, reviewedAt: new Date().toISOString() };
        }).sort((a,b) => b.relevanceScore - a.relevanceScore);
        const db = getKV(env);
        if (db) {
          const key = "discovery_analysis_v1";
          let history = [];
          try { history = JSON.parse(await db.get(key) || "[]"); } catch {}
          if (!Array.isArray(history)) history = [];
          const now = Date.now();
          const byUri = new Map(history.filter(x => x && x.uri).map(x => [x.uri, x]));
          for (const item of analyzed) if (item.uri) byUri.set(item.uri, { uri:item.uri, handle:item.author.handle, score:item.relevanceScore, recommendation:item.recommendation, query, reviewedAt:now });
          history = [...byUri.values()].filter(x => Number(x.reviewedAt || 0) > now - 30 * 86400000).slice(-2000);
          await db.put(key, JSON.stringify(history));
        }
        return json({ success:true, mode:"heuristic_not_ai", query, count:analyzed.length, historyPersisted:!!db, notice:"التقييم تقريبي قائم على تطابق الكلمات ومقاييس عامة، وليس فهمًا دلاليًا أو نموذج ذكاء اصطناعي. لا ينفذ أي إعجاب أو متابعة أو رد أو إعادة نشر.", results:analyzed });
      } catch (e) { return json({ error: friendlyError(e) }, 500); }
    }

    // Read-only discovery history for a dashboard or external operator UI.
    if (request.method === "GET" && pathname === "/api/discovery/history") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50) || 50));
      const db = getKV(env);
      if (!db) return json({ success: true, persisted: false, seen: [], analyzed: [], notice: "لا يوجد KV مربوط؛ السجل الدائم غير متاح." });
      try {
        const readList = async key => {
          let value = [];
          try { value = JSON.parse(await db.get(key) || "[]"); } catch {}
          return Array.isArray(value) ? value.filter(x => x && typeof x === "object") : [];
        };
        const now = Date.now();
        const [seenRaw, analyzedRaw] = await Promise.all([readList("discovery_seen_v1"), readList("discovery_analysis_v1")]);
        const cutoff = now - 30 * 86400000;
        const seen = seenRaw.filter(x => x.uri && Number(x.seenAt || 0) > cutoff).slice(-limit).reverse();
        const analyzed = analyzedRaw.filter(x => x.uri && Number(x.reviewedAt || 0) > cutoff).slice(-limit).reverse();
        return json({ success: true, persisted: true, retentionDays: 30, limits: { returnedPerList: limit, storedMaximum: 2000 }, counts: { seen: seen.length, analyzed: analyzed.length }, seen, analyzed });
      } catch (e) { return json({ error: friendlyError(e) }, 500); }
    }

    if (request.method === "GET" && pathname === "/api/discovery/profile") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      const actor = String(url.searchParams.get("actor") || "").trim().replace(/^@/, "").slice(0, 300);
      if (!actor) return json({ error: "أدخل handle أو DID للحساب" }, 400);
      try {
        const endpoint = new URL("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile");
        endpoint.searchParams.set("actor", actor);
        const response = await fetch(endpoint.toString(), { headers: { "Accept": "application/json" } });
        if (!response.ok) return json({ error: "تعذر جلب الملف العام", status: response.status }, response.status >= 500 ? 502 : response.status);
        const p = await response.json();
        return json({
          success: true,
          profile: {
            did: p.did || "",
            handle: p.handle || "",
            displayName: String(p.displayName || "").slice(0, 120),
            description: String(p.description || "").slice(0, 2000),
            avatar: p.avatar || "",
            banner: p.banner || "",
            followersCount: Number(p.followersCount || 0),
            followsCount: Number(p.followsCount || 0),
            postsCount: Number(p.postsCount || 0),
            indexedAt: p.indexedAt || null,
            labels: Array.isArray(p.labels) ? p.labels : []
          }
        });
      } catch (e) {
        return json({ error: friendlyError(e) }, 502);
      }
    }

    if (request.method === "POST" && pathname === "/api/run-now") {
      try {
        let bkey = "";
        try { const b = await request.clone().json(); bkey = b.key || ""; } catch {}
        if (!isAuthorized(request, env, url, bkey)) return unauthorized();
        const db = getKV(env);
        if (!db) return json({ error: "قاعدة البيانات غير مربوطة — روح Settings > Bindings > Add KV باسم BSKY_DB ثم Redeploy" }, 500);
        const r = await handleScheduledPosting(env, { force: true, limitPerAccount: 1 });
        return json({ success: true, published: r?.published || 0 });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (pathname === "/api/health") {
      const list = listKVBindings(env);
      const kvBound = list.length > 0;
      const hasAdmin = !!(env.ADMIN_PASSWORD || env.ADMIN_KEY);
      let accountsCount = 0;
      try { accountsCount = (await getAccounts(env)).length; } catch {}
      return json({
        ok: kvBound,
        kvBound,
        kvName: kvBound ? list[0].name : null,
        hasAdminPassword: hasAdmin,
        accountsCount,
        seedFound: getSeedAccounts(env).length,
        hint: !kvBound ? "اربط KV باسم BSKY_DB من Settings ثم Bindings ثم Redeploy" : (!hasAdmin ? "يفضل تضيف ADMIN_PASSWORD لحماية اللوحة" : "تمام")
      });
    }

    if (pathname === "/api/link-preview") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      const raw = url.searchParams.get("url") || "";
      try {
        const target = String(raw || "").trim();
        const hostname = new URL(target).hostname.replace(/^www\./i, "");
        let preview = { title: "", description: "", imageUrl: "" };
        try { preview = await fetchLinkPreview(target); } catch {}
        return json({
          success: true,
          target,
          hostname,
          title: String(preview.title || ""),
          description: String(preview.description || ""),
          imageUrl: String(preview.imageUrl || "")
        });
      } catch {
        return json({ success: false, error: "الرابط غير صالح" }, 400);
      }
    }

    if (pathname === "/api/video-preview") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      try {
        const raw = url.searchParams.get("url") || "";
        if (!raw.trim()) return json({ success: false, error: "أدخل رابط الفيديو أو الصفحة أولًا" }, 400);
        const source = await openVideoSource(raw);
        const result = { success: true, url: source.url, contentType: source.contentType, size: Number(source.response.headers.get("content-length") || 0), pageTitle: "", pageHost: "" };
        try { await source.response.body?.cancel(); } catch {}
        // عنوان صفحة الفيديو (لمنظومة الفيديو فقط): لو الرابط صفحة، اسحب عنوانها لاستخدامه كعنوان للبوست
        try {
          const prev = await fetchLinkPreview(raw.trim());
          result.pageTitle = String(prev.title || "").slice(0, 300);
          try { result.pageHost = new URL(raw.trim()).hostname.replace(/^www\./i, ""); } catch {}
        } catch {}
        return json(result);
      } catch (e) {
        return json({ success: false, error: friendlyError(e) }, 400);
      }
    }

    if (pathname === "/api/data") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      // لو KV فاضي وفيه SEED_ACCOUNTS ازرعه تلقائيا أول مرة
      try {
        const cur = await getAccounts(env);
        const seed = getSeedAccounts(env);
        if (!cur.length && seed.length && getKV(env)) {
          await saveAccounts(env, seed);
        }
      } catch {}
      const accounts = await getAccounts(env);
      const logs = await getLogs(env);
      const stats = buildStats(accounts, logs);
      return json({ accounts, logs: logs.slice(0, 80), stats });
    }

    if (pathname === "/api/export") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      const accounts = await getAccounts(env);
      const logs = await getLogs(env);
      return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), accounts, logs }, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=bsky-backup.json" }
      });
    }

    if (request.method === "POST" && pathname === "/api/import") {
      if (!isAuthorized(request, env, url)) return unauthorized();
      try {
        const body = await request.json();
        if (!isAuthorized(request, env, url, body.key)) return unauthorized();
        if (!Array.isArray(body.accounts)) return json({ error: "ملف غير صالح" }, 400);
        const accounts = body.accounts.map(normalizeAccount);
        await saveAccounts(env, accounts);
        return json({ success: true, count: accounts.length });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/reset-all") {
      try {
        const b = await request.json().catch(function(){return {};});
        if (!isAuthorized(request, env, url, b.key)) return unauthorized();
        const db = getKV(env);
        if (!db) return json({ error: "قاعدة البيانات غير مربوطة — روح Settings > Bindings > Add KV باسم BSKY_DB ثم Redeploy" }, 500);
        await db.delete("accounts");
        await db.delete("post_logs");
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (request.method === "POST" && pathname === "/api/clear-logs") {
      try {
        const b = await request.json().catch(function(){return {};});
        if (!isAuthorized(request, env, url, b.key)) return unauthorized();
        const db = getKV(env);
        if (!db) return json({ error: "قاعدة البيانات غير مربوطة — روح Settings > Bindings > Add KV باسم BSKY_DB ثم Redeploy" }, 500);
        await db.delete("post_logs");
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response(getUltraDashboardHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" }
    });
  }
};

function listKVBindings(env) {
  const out = [];
  const names = ["BSKY_DB", "AUTOPILOT_KV", "BSKY_KV", "DB", "KV"];
  for (const n of names) {
    try { if (env[n] && typeof env[n].get === 'function' && typeof env[n].put === 'function') out.push({ name: n, db: env[n] }); } catch {}
  }
  for (const key in env) {
    if (names.indexOf(key) !== -1) continue;
    try {
      const v = env[key];
      if (v && typeof v.get === 'function' && typeof v.put === 'function') {
        if (!out.some(x => x.db === v)) out.push({ name: key, db: v });
      }
    } catch {}
  }
  return out;
}
function getKV(env) {
  const l = listKVBindings(env);
  return l.length ? l[0].db : null;
}
function getSeedAccounts(env) {
  try {
    // 1) من Variables (الأفضل)
    const raw = env.SEED_ACCOUNTS || env.DEFAULT_ACCOUNTS || "";
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const clean = arr.map(normalizeAccount).filter(a => a.handle && a.password);
        if (clean.length) return clean;
      }
    }
    // 2) من المكان المحدد فوق الكود CONFIG
    const h = normalizeHandle((env.SEED_HANDLE || CONFIG.SEED_HANDLE || "").trim());
    const p = normalizePassword((env.SEED_PASSWORD || CONFIG.SEED_PASSWORD || "").trim());
    if (h && p) return [normalizeAccount({ handle: h, password: p })];
    return [];
  } catch { return []; }
}

function getAdminPassword(env) {
  return env.ADMIN_PASSWORD || env.ADMIN_KEY || CONFIG.ADMIN_KEY || "";
}
function isAuthorized(request, env, url, bodyKey) {
  const pw = getAdminPassword(env);
  if (!pw) return true;
  const q = url.searchParams.get("key");
  if (q && q === pw) return true;
  const auth = request.headers.get("Authorization") || "";
  if (auth === "Bearer " + pw) return true;
  if (bodyKey && bodyKey === pw) return true;
  return false;
}
function unauthorized() {
  return json({ error: "غير مصرح - ضع ?key=كلمة_السر في رابط اللوحة" }, 401);
}

function cairoParts(ts) {
  try {
    const dt = new Date(ts);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(dt);
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    return { date: `${m.year}-${m.month}-${m.day}`, hour: parseInt(m.hour, 10) % 24, minute: parseInt(m.minute, 10) };
  } catch {
    const d = new Date(ts + 3 * 3600000);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}
function cairoToday() { return cairoParts(Date.now()).date; }

function normalizeHandle(h) {
  let s = String(h || "").replace(/[\u200e\u200f\u200b\u00a0]/g, "").trim();
  s = s.replace(/^@+/, "").replace(/\s+/g, "");
  s = s.toLowerCase();
  if (s && !s.includes(".")) s = s + ".bsky.social";
  return s;
}
function normalizePassword(pw) {
  let s = String(pw || "").replace(/[\u200e\u200f\u200b\u00a0\r\n\t]/g, "").trim();
  const nospace = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(nospace) || (s.includes("-") && s.includes(" "))) return nospace;
  return s;
}
function friendlyError(e) {
  const m = String(e && e.message || e || "خطأ غير معروف");
  if (m.includes("undefined") && m.toLowerCase().includes("get")) return "قاعدة البيانات غير مربوطة — اربط الـ KV من Settings ثم Bindings";
  return m.slice(0, 300);
}
function requireDB(env) {
  const db = getKV(env);
  if (!db) throw new Error("قاعدة البيانات غير مربوطة — اربط KV Namespace من Settings ثم Bindings ثم اعد المحاولة");
  return db;
}

async function getAccounts(env) {
  try {
    const list = listKVBindings(env);
    if (!list.length) return [];
    for (const item of list) {
      try {
        const raw = await item.db.get("accounts");
        if (raw) {
          const arr = JSON.parse(raw || "[]");
          if (Array.isArray(arr) && arr.length) return arr.map(normalizeAccount);
        }
      } catch {}
    }
    try {
      const raw0 = await list[0].db.get("accounts");
      const arr0 = JSON.parse(raw0 || "[]");
      return Array.isArray(arr0) ? arr0.map(normalizeAccount) : [];
    } catch { return []; }
  } catch { return []; }
}
async function saveAccounts(env, accounts) {
  const list = listKVBindings(env);
  if (!list.length) throw new Error("قاعدة البيانات غير مربوطة — اربط KV Namespace من Settings ثم Bindings ثم اعد المحاولة");
  const clean = (accounts || []).map(normalizeAccount);
  await list[0].db.put("accounts", JSON.stringify(clean));
}
async function getLogs(env) {
  try {
    const list = listKVBindings(env);
    if (!list.length) return [];
    for (const item of list) {
      try {
        const raw = await item.db.get("post_logs");
        if (raw) { const arr = JSON.parse(raw || "[]"); if (Array.isArray(arr) && arr.length) return arr; }
      } catch {}
    }
    try {
      const raw0 = await list[0].db.get("post_logs");
      const arr0 = JSON.parse(raw0 || "[]");
      return Array.isArray(arr0) ? arr0 : [];
    } catch { return []; }
  } catch { return []; }
}
async function pushLog(env, entry) {
  try {
    const db = getKV(env);
    if (!db) return;
    const logs = await getLogs(env);
    logs.unshift({ ...entry });
    await db.put("post_logs", JSON.stringify(logs.slice(0, 200)));
  } catch {}
}

function scheduleKey(prefix, name) {
  const root = prefix ? prefix + "Schedule" : "schedule";
  return root + String(name || "").charAt(0).toUpperCase() + String(name || "").slice(1);
}
function scheduleDailyLimitKey(prefix) {
  return prefix ? prefix + "DailyLimit" : "dailyLimit";
}
function clampScheduleInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function normalizeScheduleMode(value) {
  const mode = String(value || "fixed").toLowerCase();
  return ["fixed", "ramp", "custom"].includes(mode) ? mode : "fixed";
}
function normalizeScheduleBasis(value) {
  return String(value || "activation").toLowerCase() === "month" ? "month" : "activation";
}
function normalizePostingStrategy(value) {
  const mode = String(value || "").toLowerCase();
  return mode === "random" || mode === "gradual" ? mode : "";
}
function postingStrategyKey(prefix) {
  return prefix ? prefix + "PostingStrategy" : "postingStrategy";
}
function postingModeKey(prefix) {
  return prefix ? prefix + "PostMode" : "postMode";
}
function getPostingStrategy(account, prefix) {
  const saved = normalizePostingStrategy(account?.[postingStrategyKey(prefix)]);
  if (saved) return saved;
  const cfg = scheduleConfig(account, prefix);
  return cfg.mode === "ramp" || cfg.mode === "custom" ? "gradual" : "random";
}
function scheduleConfig(account, prefix) {
  const baseLimit = clampScheduleInt(account?.[scheduleDailyLimitKey(prefix)], 1, 50, 12);
  const holdAfterDay = clampScheduleInt(account?.[scheduleKey(prefix, "holdAfterDay")], 0, 31, 0);
  const computedHold = clampScheduleInt(1 + Math.max(0, holdAfterDay - 1), 1, 50, 1);
  return {
    mode: normalizeScheduleMode(account?.[scheduleKey(prefix, "mode")]),
    basis: normalizeScheduleBasis(account?.[scheduleKey(prefix, "dayBasis")]),
    startCount: clampScheduleInt(account?.[scheduleKey(prefix, "startCount")], 1, 50, 1),
    step: clampScheduleInt(account?.[scheduleKey(prefix, "step")], 0, 50, 1),
    holdAfterDay,
    holdCount: clampScheduleInt(account?.[scheduleKey(prefix, "holdCount")], 1, 50, computedHold),
    max: clampScheduleInt(account?.[scheduleKey(prefix, "max")], 1, 50, 50),
    custom: String(account?.[scheduleKey(prefix, "custom")] || ""),
    startDate: String(account?.[scheduleKey(prefix, "startDate")] || ""),
    baseLimit
  };
}
function parseScheduleDate(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ts = Date.UTC(y, mo - 1, d);
  return Number.isFinite(ts) ? ts : null;
}
function parseCustomSchedule(raw) {
  const out = {};
  String(raw || "").split(/[，,;\n]+/).forEach(part => {
    const m = part.trim().match(/^(\d{1,2})\s*[:=：-]\s*(\d{1,2})$/);
    if (!m) return;
    const day = clampScheduleInt(m[1], 1, 31, 1);
    const count = clampScheduleInt(m[2], 1, 50, 1);
    out[day] = count;
  });
  return out;
}
function scheduleDayNumber(account, prefix, today) {
  const cfg = scheduleConfig(account, prefix);
  const date = String(today || cairoToday());
  if (cfg.basis === "month") return Math.max(1, Math.min(31, parseInt(date.slice(-2), 10) || 1));
  const current = parseScheduleDate(date);
  const started = parseScheduleDate(cfg.startDate || date);
  if (current === null || started === null) return 1;
  return Math.max(1, Math.floor((current - started) / 86400000) + 1);
}
function getEffectiveDailyLimit(account, prefix, today, options = {}) {
  const date = String(today || cairoToday());
  const cfg = scheduleConfig(account, prefix);
  const startKey = scheduleKey(prefix, "startDate");
  if (options.mutateStartDate && cfg.basis === "activation" && !parseScheduleDate(cfg.startDate)) {
    account[startKey] = date;
  }
  if (getPostingStrategy(account, prefix) === "random") return cfg.baseLimit;
  if (cfg.mode === "fixed") return cfg.baseLimit;
  const day = scheduleDayNumber(account, prefix, date);
  let value = cfg.startCount;
  if (cfg.mode === "custom") {
    const map = parseCustomSchedule(cfg.custom);
    const keys = Object.keys(map).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const exact = map[day];
    if (exact !== undefined) value = exact;
    else {
      const previous = keys.filter(k => k <= day).pop();
      value = previous === undefined ? cfg.startCount : map[previous];
    }
  } else if (cfg.holdAfterDay > 0 && day >= cfg.holdAfterDay) {
    value = cfg.holdCount;
  } else {
    value = cfg.startCount + ((day - 1) * cfg.step);
  }
  return Math.max(1, Math.min(50, Math.min(cfg.max, value)));
}
function describePostingSchedule(account, prefix, today) {
  const cfg = scheduleConfig(account, prefix);
  if (getPostingStrategy(account, prefix) === "random") return "الخطة العشوائية فعالة • الحد الثابت: " + cfg.baseLimit + " منشور" + (cfg.baseLimit === 1 ? "" : "ات");
  if (cfg.mode === "fixed") return "الخطة التدريجية مفعلة لكن العدد ثابت • الحد اليومي: " + cfg.baseLimit + " منشور" + (cfg.baseLimit === 1 ? "" : "ات");
  const day = scheduleDayNumber(account, prefix, today);
  const now = getEffectiveDailyLimit(account, prefix, today);
  const samples = [day, day + 1, day + 2].map(d => {
    const copy = { ...account, [scheduleKey(prefix, "startDate")]: cfg.startDate || String(today || cairoToday()) };
    const fakeDate = cfg.basis === "month" ? String(today || cairoToday()).slice(0, 8) + String(Math.min(31, d)).padStart(2, "0") : String(today || cairoToday());
    if (cfg.basis === "activation") {
      const base = parseScheduleDate(copy[scheduleKey(prefix, "startDate")]);
      if (base !== null) {
        const future = new Date(base + (d - 1) * 86400000);
        const iso = future.toISOString().slice(0, 10);
        return getEffectiveDailyLimit(copy, prefix, iso);
      }
    }
    return getEffectiveDailyLimit(copy, prefix, fakeDate);
  });
  const mode = cfg.mode === "ramp" ? "تدريجي" : "تخصيص يومي";
  return mode + " • اليوم " + day + ": " + now + " منشور/يوم • التالي: " + samples.join(" → ") + " • السقف: " + cfg.max;
}

function normalizeAccount(a) {
  const q = Array.isArray(a.queue) ? a.queue.map(normalizeQueueItem) : [];
  const tq = Array.isArray(a.textQueue) ? a.textQueue.map(normalizeTextItem) : [];
  return {
    handle: normalizeHandle(a.handle || ""),
    password: normalizePassword(a.password || ""),
    queue: q,
    textQueue: tq,
    videoQueue: Array.isArray(a.videoQueue) ? a.videoQueue.map(normalizeVideoItem) : [],
    videoEnabled: a.videoEnabled === true,
    videoPostMode: String(a.videoPostMode ?? "random"),
    videoGlobalTags: String(a.videoGlobalTags ?? ""),
    videoRandomTagsCount: String(a.videoRandomTagsCount ?? "1"),
    videoIntervalMinutes: Math.max(1, Math.min(120, parseInt(a.videoIntervalMinutes ?? "15", 10) || 15)),
    videoDailyLimit: Math.max(1, Math.min(50, parseInt(a.videoDailyLimit ?? "12", 10) || 12)),
    videoScheduleMode: normalizeScheduleMode(a.videoScheduleMode),
    videoScheduleDayBasis: normalizeScheduleBasis(a.videoScheduleDayBasis),
    videoScheduleStartCount: clampScheduleInt(a.videoScheduleStartCount, 1, 50, 1),
    videoScheduleStep: clampScheduleInt(a.videoScheduleStep, 0, 50, 1),
    videoScheduleHoldAfterDay: clampScheduleInt(a.videoScheduleHoldAfterDay, 0, 31, 0),
    videoScheduleHoldCount: clampScheduleInt(a.videoScheduleHoldCount, 1, 50, 1),
    videoScheduleMax: clampScheduleInt(a.videoScheduleMax, 1, 50, 50),
    videoScheduleCustom: String(a.videoScheduleCustom ?? ""),
    videoScheduleStartDate: String(a.videoScheduleStartDate ?? ""),
    videoPostingStrategy: normalizePostingStrategy(a.videoPostingStrategy),
    videoStartHour: String(a.videoStartHour ?? "07"),
    videoStartAmPm: String(a.videoStartAmPm ?? "PM"),
    videoEndHour: String(a.videoEndHour ?? "01"),
    videoEndAmPm: String(a.videoEndAmPm ?? "AM"),
    videoNextPostAt: Number(a.videoNextPostAt || 0),
    videoPostedToday: Number(a.videoPostedToday || 0),
    videoLastPostDate: String(a.videoLastPostDate || ""),
    videoLastPostAt: Number(a.videoLastPostAt || 0),
    videoLastError: String(a.videoLastError || ""),
    textEnabled: a.textEnabled === true,
    textPostMode: String(a.textPostMode ?? "random"),
    textGlobalTags: String(a.textGlobalTags ?? ""),
    textRandomTagsCount: String(a.textRandomTagsCount ?? "1"),
    textIntervalMinutes: Math.max(1, Math.min(120, parseInt(a.textIntervalMinutes ?? "15", 10) || 15)),
    textDailyLimit: Math.max(1, Math.min(50, parseInt(a.textDailyLimit ?? "12", 10) || 12)),
    textScheduleMode: normalizeScheduleMode(a.textScheduleMode),
    textScheduleDayBasis: normalizeScheduleBasis(a.textScheduleDayBasis),
    textScheduleStartCount: clampScheduleInt(a.textScheduleStartCount, 1, 50, 1),
    textScheduleStep: clampScheduleInt(a.textScheduleStep, 0, 50, 1),
    textScheduleHoldAfterDay: clampScheduleInt(a.textScheduleHoldAfterDay, 0, 31, 0),
    textScheduleHoldCount: clampScheduleInt(a.textScheduleHoldCount, 1, 50, 1),
    textScheduleMax: clampScheduleInt(a.textScheduleMax, 1, 50, 50),
    textScheduleCustom: String(a.textScheduleCustom ?? ""),
    textScheduleStartDate: String(a.textScheduleStartDate ?? ""),
    textPostingStrategy: normalizePostingStrategy(a.textPostingStrategy),
    textStartHour: String(a.textStartHour ?? a.startHour ?? "07"),
    textStartAmPm: String(a.textStartAmPm ?? a.startAmPm ?? "PM"),
    textEndHour: String(a.textEndHour ?? a.endHour ?? "01"),
    textEndAmPm: String(a.textEndAmPm ?? a.endAmPm ?? "AM"),
    textNextPostAt: Number(a.textNextPostAt || 0),
    textPostedToday: Number(a.textPostedToday || 0),
    textLastPostDate: String(a.textLastPostDate || ""),
    textLastPostAt: Number(a.textLastPostAt || 0),
    textLastError: String(a.textLastError || ""),
    postingEnabled: a.postingEnabled === true,
    postMode: String(a.postMode ?? "random"),
    globalTags: String(a.globalTags ?? ""),
    randomTagsCount: String(a.randomTagsCount ?? "1"),
    intervalMinutes: Math.max(1, Math.min(120, parseInt(a.intervalMinutes ?? "15", 10) || 15)),
    dailyLimit: Math.max(1, Math.min(50, parseInt(a.dailyLimit ?? "12", 10) || 12)),
    scheduleMode: normalizeScheduleMode(a.scheduleMode),
    scheduleDayBasis: normalizeScheduleBasis(a.scheduleDayBasis),
    scheduleStartCount: clampScheduleInt(a.scheduleStartCount, 1, 50, 1),
    scheduleStep: clampScheduleInt(a.scheduleStep, 0, 50, 1),
    scheduleHoldAfterDay: clampScheduleInt(a.scheduleHoldAfterDay, 0, 31, 0),
    scheduleHoldCount: clampScheduleInt(a.scheduleHoldCount, 1, 50, 1),
    scheduleMax: clampScheduleInt(a.scheduleMax, 1, 50, 50),
    scheduleCustom: String(a.scheduleCustom ?? ""),
    scheduleStartDate: String(a.scheduleStartDate ?? ""),
    postingStrategy: normalizePostingStrategy(a.postingStrategy),
    startHour: String(a.startHour ?? "07"),
    startAmPm: String(a.startAmPm ?? "PM"),
    endHour: String(a.endHour ?? "01"),
    endAmPm: String(a.endAmPm ?? "AM"),
    multiPerPost: Math.max(1, Math.min(4, parseInt(a.multiPerPost ?? "1", 10) || 1)),
    altText: String(a.altText ?? ""),
    nextPostAt: Number(a.nextPostAt || 0),
    postedToday: Number(a.postedToday || 0),
    lastPostDate: String(a.lastPostDate || ""),
    lastPostAt: Number(a.lastPostAt || 0),
    lastError: String(a.lastError || "")
  };
}

function normalizeQueueItem(it) {
  if (typeof it === "string") return { url: it, title: "", tags: "", randomTagsCount: "", alt: "", failCount: 0 };
  let urls = [];
  if (Array.isArray(it.urls)) urls = it.urls;
  else if (typeof it.url === "string" && it.url.includes("|")) urls = it.url.split("|").map(s => s.trim()).filter(Boolean);
  return {
    url: String(it.url || urls[0] || ""),
    urls: urls.length ? urls : undefined,
    title: String(it.title || ""),
    tags: String(it.tags || ""),
    randomTagsCount: String(it.randomTagsCount || ""),
    alt: String(it.alt || ""),
    failCount: Number(it.failCount || 0)
  };
}

function normalizeVideoItem(it) {
  if (typeof it === "string") return { url: it.trim(), title: "", tags: "", randomTagsCount: "1", failCount: 0, jobId: "" };
  return {
    url: String(it.url || it.link || "").trim(),
    title: String(it.title || ""),
    tags: String(it.tags || ""),
    randomTagsCount: String(it.randomTagsCount || "1"),
    failCount: Number(it.failCount || 0),
    jobId: String(it.jobId || "")
  };
}

function normalizeTextItem(it) {
  if (typeof it === "string") {
    const s = it.trim();
    if (/^https?:\/\//i.test(s)) return { link: s, title: "", tags: "", randomTagsCount: "", failCount: 0 };
    return { link: "", title: s, tags: "", randomTagsCount: "", failCount: 0 };
  }
  return {
    link: String(it.link || it.url || ""),
    title: String(it.title || ""),
    tags: String(it.tags || ""),
    randomTagsCount: String(it.randomTagsCount || ""),
    failCount: Number(it.failCount || 0)
  };
}

function buildStats(accounts, logs) {
  const totalQueued = accounts.reduce((s, a) => s + (a.queue?.length || 0) + (a.textQueue?.length || 0) + (a.videoQueue?.length || 0), 0);
  const textQueued = accounts.reduce((s, a) => s + (a.textQueue?.length || 0), 0);
  const imageQueued = accounts.reduce((s, a) => s + (a.queue?.length || 0), 0);
  const videoQueued = accounts.reduce((s, a) => s + (a.videoQueue?.length || 0), 0);
  const enabled = accounts.filter(a => a.postingEnabled || a.textEnabled || a.videoEnabled).length;
  const today = cairoToday();
  const publishedToday = logs.filter(l => l.success && cairoParts(l.time).date === today).length;
  const success = logs.filter(l => l.success).length;
  const fail = logs.filter(l => !l.success).length;
  return { accounts: accounts.length, enabled, totalQueued, imageQueued, textQueued, videoQueued, publishedToday, success, fail };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function bskyLogin(handle, password) {
  try {
    const res = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: handle, password })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      let msg = "فشل تسجيل الدخول — راجع اليوزر والباسورد";
      try {
        const j = JSON.parse(txt);
        const em = (j.error || "") + " " + (j.message || "");
        if (/invalid/i.test(em) || /password/i.test(em) || /identifier/i.test(em)) msg = "بيانات الدخول مرفوضة من Bluesky";
        else if (em.trim()) msg = em.trim().slice(0, 200);
      } catch { if (txt.trim()) msg = txt.trim().slice(0, 200); }
      return { ok: false, error: msg };
    }
    const session = await res.json();
    return { ok: true, session, profile: { did: session.did, handle: session.handle, email: session.email || undefined } };
  } catch (e) {
    return { ok: false, error: "تعذر الوصول إلى Bluesky" };
  }
}

async function publishItem(account, currentItem, env) {
  try {
    const login = await bskyLogin(account.handle, account.password);
    if (!login.ok) return { success: false, error: login.error || "فشل تسجيل الدخول" };
    const { session } = login;
    const token = session.accessJwt;
    const did = session.did;
    const pds = session.didDoc?.service?.find(x => x.id === "#atproto_pds")?.serviceEndpoint || "https://bsky.social";

    let urls = [];
    if (Array.isArray(currentItem.urls) && currentItem.urls.length) urls = currentItem.urls;
    else if (currentItem.url && currentItem.url.includes("|")) urls = currentItem.url.split("|").map(s => s.trim()).filter(Boolean);
    else if (currentItem.url) urls = [currentItem.url];
    const maxImgs = Math.max(1, Math.min(4, account.multiPerPost || 1));
    urls = urls.slice(0, maxImgs);
    if (!urls.length) return { success: false, error: "لا يوجد رابط صورة صالح", isImageError: true };

    const images = [];
    for (const u of urls) {
      const imgRes = await fetch(u);
      if (!imgRes.ok) return { success: false, error: "فشل تحميل الصورة", isImageError: true };
      const blob = await imgRes.blob();
      if (blob.size > 976000) return { success: false, error: "الصورة أكبر من 1MB", isImageError: true };
      const up = await fetch(pds + "/xrpc/com.atproto.repo.uploadBlob", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": blob.type || "image/jpeg" },
        body: blob
      });
      if (!up.ok) return { success: false, error: "فشل رفع الصورة", isImageError: true };
      const blobData = await up.json();
      images.push({ alt: (currentItem.alt || account.altText || currentItem.title || "image").slice(0, 1000), image: blobData.blob });
    }

    const title = (currentItem.title || "").trim();
    const tagsRaw = (currentItem.tags || account.globalTags || "").trim();
    const tagsCount = Math.max(1, Math.min(30, parseInt(currentItem.randomTagsCount || account.randomTagsCount || "1", 10) || 1));
    let selectedTags = [];
    if (tagsRaw) {
      const all = [...new Set(tagsRaw.split(/\s+/).filter(t => t.startsWith("#") && t.length > 1))];
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      selectedTags = all.slice(0, Math.min(tagsCount, all.length));
    }
    const tagsStr = selectedTags.join(" ");
    let postText = title && tagsStr ? title + "\n" + tagsStr : (title || tagsStr || "صورة");
    if (postText.length > 280) postText = postText.slice(0, 278) + "…";

    const facets = buildFacets(postText, selectedTags);

    const record = {
      $type: "app.bsky.feed.post",
      text: postText,
      createdAt: new Date().toISOString(),
      embed: { $type: "app.bsky.embed.images", images }
    };
    if (facets.length) record.facets = facets;

    const postRes = await fetch(pds + "/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record })
    });
    if (!postRes.ok) return { success: false, error: (await postRes.text()).slice(0, 300) };
    const posted = await postRes.json();
    const uri = posted.uri || "";
    const rkey = uri.split("/").pop() || "";
    const link = rkey ? `https://bsky.app/profile/${account.handle}/post/${rkey}` : "";
    return { success: true, uri, link, previewText: postText };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function publishTextItem(account, currentItem) {
  try {
    const login = await bskyLogin(account.handle, account.password);
    if (!login.ok) return { success: false, error: login.error || "فشل تسجيل الدخول" };
    const { session } = login;
    const token = session.accessJwt;
    const did = session.did;
    const pds = session.didDoc?.service?.find(x => x.id === "#atproto_pds")?.serviceEndpoint || "https://bsky.social";

    const boxTitle = (currentItem.title || "").trim();
    const link = (currentItem.link || currentItem.url || "").trim();
    const tagsRaw = (currentItem.tags || account.textGlobalTags || "").trim();
    const tagsCount = Math.max(1, Math.min(30, parseInt(currentItem.randomTagsCount || account.textRandomTagsCount || "1", 10) || 1));
    let selectedTags = [];
    if (tagsRaw) {
      const all = [...new Set(tagsRaw.split(/\s+/).filter(t => t.startsWith("#") && t.length > 1))];
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      selectedTags = all.slice(0, Math.min(tagsCount, all.length));
    }
    const tagsStr = selectedTags.join(" ");
    // استخدم الرابط كاملًا كما أدخله المستخدم لجلب المعاينة والنشر.
    let embed = null;
    let fetched = null;
    let linkIsValid = false;
    let linkTarget = link;
    let linkHost = "";
    try {
      const parsedLink = new URL(link);
      linkIsValid = parsedLink.protocol === "http:" || parsedLink.protocol === "https:";
      if (linkIsValid) {
        linkTarget = link;
        linkHost = parsedLink.hostname.replace(/^www\./i, "");
      }
    } catch {}
    if (linkIsValid) {
      try { fetched = await fetchLinkPreview(linkTarget); } catch {}
      let thumb = null;
      if (fetched && fetched.imageUrl) {
        try {
          const ir = await fetch(fetched.imageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (ir.ok) {
            const ct = (ir.headers.get("content-type") || "").toLowerCase();
            if (ct.startsWith("image/")) {
              const blob = await ir.blob();
              if (blob.size > 0 && blob.size <= 976000) {
                const up = await fetch(pds + "/xrpc/com.atproto.repo.uploadBlob", {
                  method: "POST",
                  headers: { "Authorization": "Bearer " + token, "Content-Type": blob.type || "image/jpeg" },
                  body: blob
                });
                if (up.ok) { const jd = await up.json(); thumb = jd.blob || null; }
              }
            }
          }
        } catch {}
      }
      const cardTitle = ((fetched && fetched.title) || boxTitle || linkHost || "رابط").slice(0, 300);
      const cardDesc = ((fetched && fetched.description) || (linkHost ? "رابط على " + linkHost : "افتح الرابط")).slice(0, 1000);
      const ext = { uri: link, title: cardTitle, description: cardDesc };
      if (thumb) ext.thumb = thumb;
      embed = { $type: "app.bsky.embed.external", external: ext };
    }
    let postText = "";
    let previewText = "";
    if (embed) {
      // وجود الرابط ككارت خارجي لا يعتمد على نجاح استخراج بيانات الموقع.
      const mainTitle = boxTitle || (fetched && fetched.title) || "";
      const parts = [mainTitle, tagsStr].filter(s => s && s.trim());
      if (!parts.length) parts.push((fetched && fetched.title) || "خبر جديد");
      postText = parts.join("\n");
    } else {
      // مفيش كارت: السلوك القديم (عنوان + رابط أزرق + هاشتاج)
      const parts = [boxTitle, link, tagsStr].filter(s => s && s.trim());
      if (!parts.length) return { success: false, error: "لا يوجد محتوى للنشر (العنوان والرابط والهاشتاج كلها فاضية)", isTextError: true };
      postText = parts.join("\n");
    }
    if (postText.length > 300) postText = postText.slice(0, 298) + "…";
    const facets = buildFacets(postText, selectedTags);
    const record = { $type: "app.bsky.feed.post", text: postText, createdAt: new Date().toISOString() };
    if (facets.length) record.facets = facets;
    if (embed) record.embed = embed;
    const postRes = await fetch(pds + "/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record })
    });
    if (!postRes.ok) return { success: false, error: (await postRes.text()).slice(0, 300) };
    const posted = await postRes.json();
    const uri = posted.uri || "";
    const rkey = uri.split("/").pop() || "";
    const outLink = rkey ? `https://bsky.app/profile/${account.handle}/post/${rkey}` : "";
    return { success: true, uri, link: outLink, previewText: postText };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getBskyServiceToken(session, pds, aud, lxm) {
  const authUrl = new URL(pds.replace(/\/$/, "") + "/xrpc/com.atproto.server.getServiceAuth");
  authUrl.searchParams.set("aud", aud);
  authUrl.searchParams.set("lxm", lxm);
  authUrl.searchParams.set("exp", String(Math.floor(Date.now() / 1000) + 1800));
  const res = await fetch(authUrl.href, { headers: { "Authorization": "Bearer " + session.accessJwt } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error((data.message || data.error || "تعذر تجهيز تصريح رفع الفيديو") + " — تأكد من صلاحية الحساب في Bluesky");
  return data.token;
}
function videoServiceDid() { return "did:web:video.bsky.app"; }
function pdsServiceDid(pds) { return "did:web:" + new URL(pds).hostname.toLowerCase(); }
function assertSafeVideoUrl(value) {
  let u;
  try { u = new URL(String(value || "").trim()); } catch { throw new Error("رابط الفيديو أو الصفحة غير صالح"); }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw new Error("استخدم رابط HTTP أو HTTPS عام من دون بيانات دخول داخل الرابط");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) throw new Error("هذا الرابط غير مسموح كمصدر فيديو عام");
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some(x => x > 255) || n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 || (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168)) throw new Error("هذا الرابط غير مسموح كمصدر فيديو عام");
  }
  return u;
}
function isMp4Url(value) { try { return /\.mp4$/i.test(new URL(value).pathname); } catch { return false; } }
function extractVideoUrlFromHtml(html, pageUrl) {
  const candidates = [];
  const add = value => {
    const raw = decodeHtmlEntities(String(value || "").replace(/\\\//g, "/").trim());
    if (!raw || /^(data:|blob:|javascript:)/i.test(raw)) return;
    try { const u = new URL(raw, pageUrl); if ((u.protocol === "http:" || u.protocol === "https:") && !candidates.includes(u.href)) candidates.push(u.href); } catch {}
  };
  const attrs = tag => {
    const out = {};
    tag.replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, k, a, b, c) => { out[k.toLowerCase()] = a || b || c || ""; return _; });
    return out;
  };
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    const a = attrs(tag);
    const key = String(a.property || a.name || "").toLowerCase();
    if (["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"].includes(key)) add(a.content);
  }
  const mediaTags = html.match(/<(?:video|source)\b[^>]*>/gi) || [];
  for (const tag of mediaTags) {
    const a = attrs(tag);
    add(a.src || a["data-src"]);
    if (a.srcset) add(a.srcset.split(",")[0].trim().split(/\s+/)[0]);
  }
  const jsonUrls = html.match(/"(?:contentUrl|videoUrl|src)"\s*:\s*"(?:\\.|[^"])*"/gi) || [];
  for (const item of jsonUrls) {
    const m = item.match(/:\s*"((?:\\.|[^"])*)"/);
    if (m) add(m[1].replace(/\\u0026/g, "&"));
  }
  const literalMp4 = html.match(/(?:https?:)?\/\/[^"'\s<>]+?\.mp4(?:\?[^"'\s<>]*)?/gi) || [];
  literalMp4.forEach(add);
  return candidates.find(u => isMp4Url(u)) || candidates[0] || "";
}
async function openVideoSource(url) {
  const safe = assertSafeVideoUrl(url);
  const response = await fetch(safe.href, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; BlueskyVideoPublisher/1.0)", "Accept": "video/mp4,video/*;q=0.9,text/html;q=0.8,*/*;q=0.5" } });
  if (!response.ok) throw new Error("تعذر تحميل الرابط (HTTP " + response.status + ")؛ تأكد أنه متاح للعامة ولا يحتاج تسجيل دخول");
  const finalUrl = response.url || safe.href;
  assertSafeVideoUrl(finalUrl);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isVideo = contentType.startsWith("video/") || (contentType === "application/octet-stream" && isMp4Url(finalUrl)) || isMp4Url(finalUrl);
  if (isVideo) {
    if (contentType && contentType !== "application/octet-stream" && contentType !== "video/mp4") throw new Error("الرابط يُرجع " + contentType + "؛ ارفع فيديو MP4 مباشرًا");
    return { response, url: finalUrl, contentType: "video/mp4" };
  }
  if (contentType.includes("html") || contentType.startsWith("text/")) {
    const html = (await response.text()).slice(0, 1000000);
    const directUrl = extractVideoUrlFromHtml(html, finalUrl);
    if (!directUrl) throw new Error("لم أجد ملف MP4 عامًا داخل الصفحة. جرّب رابط الفيديو المباشر؛ الروابط المحمية أو التي تحتاج تسجيل دخول لا يمكن سحبها تلقائيًا");
    if (directUrl === finalUrl) throw new Error("الصفحة لا تعرض رابط فيديو مباشرًا قابلًا للتحميل");
    return openVideoSource(directUrl);
  }
  throw new Error("الرابط لا يبدو صفحة عامة أو ملف MP4 مباشرًا");
}
async function getVideoUploadLimits(session, pds) {
  const token = await getBskyServiceToken(session, pds, videoServiceDid(), "app.bsky.video.getUploadLimits");
  const res = await fetch("https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits", { headers: { "Authorization": "Bearer " + token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "تعذر التحقق من حدود رفع الفيديو في Bluesky");
  if (data.canUpload === false) throw new Error(data.message || "حساب Bluesky لا يستطيع رفع فيديو حاليًا؛ تحقق من توثيق البريد وحدود النشر اليومية");
  return data;
}
async function getVideoJobStatus(session, pds, jobId) {
  const token = await getBskyServiceToken(session, pds, videoServiceDid(), "app.bsky.video.getJobStatus");
  const endpoint = "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=" + encodeURIComponent(jobId);
  const res = await fetch(endpoint, { headers: { "Authorization": "Bearer " + token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "تعذر متابعة معالجة الفيديو على Bluesky");
  return data.jobStatus || data;
}
async function createVideoPost(account, session, pds, blob, item) {
  // منظومة الفيديو فقط: لو العنوان اليدوي فاضي استخدم عنوان الرابط المسحوب تلقائيًا
  const title = String(item.title || item.autoTitle || "").trim();
  const tagsRaw = String(item.tags || account.videoGlobalTags || "").trim();
  const tagsCount = Math.max(1, Math.min(30, parseInt(item.randomTagsCount || account.videoRandomTagsCount || "1", 10) || 1));
  let selectedTags = [];
  if (tagsRaw) {
    const all = [...new Set(tagsRaw.split(/\s+/).filter(t => t.startsWith("#") && t.length > 1))];
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    selectedTags = all.slice(0, Math.min(tagsCount, all.length));
  }
  const tagsStr = selectedTags.join(" ");
  let postText = [title, tagsStr].filter(Boolean).join("\n") || "فيديو";
  if (postText.length > 300) postText = postText.slice(0, 298) + "…";
  const record = { $type: "app.bsky.feed.post", text: postText, createdAt: new Date().toISOString(), embed: { $type: "app.bsky.embed.video", video: blob, alt: title.slice(0, 1000) } };
  const facets = buildFacets(postText, selectedTags);
  if (facets.length) record.facets = facets;
  const res = await fetch(pds + "/xrpc/com.atproto.repo.createRecord", {
    method: "POST", headers: { "Authorization": "Bearer " + session.accessJwt, "Content-Type": "application/json" },
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record })
  });
  if (!res.ok) return { success: false, error: (await res.text()).slice(0, 300) };
  const posted = await res.json();
  const uri = posted.uri || "";
  const rkey = uri.split("/").pop() || "";
  return { success: true, uri, link: rkey ? "https://bsky.app/profile/" + account.handle + "/post/" + rkey : "", previewText: postText };
}
async function publishVideoItem(account, item) {
  try {
    const login = await bskyLogin(account.handle, account.password);
    if (!login.ok) return { success: false, error: login.error || "فشل تسجيل الدخول" };
    const session = login.session;
    const pds = session.didDoc?.service?.find(x => x.id === "#atproto_pds")?.serviceEndpoint || "https://bsky.social";
    let blob = null;
    if (item.jobId) {
      const status = await getVideoJobStatus(session, pds, item.jobId);
      if (status.blob) blob = status.blob;
      else if (String(status.state || "").includes("FAILED")) return { success: false, error: status.message || status.error || "فشل Bluesky في معالجة الفيديو" };
      else return { success: false, processing: true, jobId: item.jobId };
    } else {
      const source = await openVideoSource(item.url);
      const length = Number(source.response.headers.get("content-length") || 0);
      if (length > 300 * 1024 * 1024) return { success: false, error: "حجم الفيديو يتجاوز حد 300 ميجابايت المسموح به في النظام" };
      const limits = await getVideoUploadLimits(session, pds);
      if (length && Number.isFinite(Number(limits.remainingDailyBytes)) && length > Number(limits.remainingDailyBytes)) return { success: false, error: "حجم الفيديو أكبر من الرصيد اليومي المتبقي لرفع الفيديو على Bluesky" };
      if (Number(limits.remainingDailyVideos) === 0) return { success: false, error: "وصل الحساب إلى حد الفيديوهات اليومي في Bluesky" };
      const uploadToken = await getBskyServiceToken(session, pds, pdsServiceDid(pds), "com.atproto.repo.uploadBlob");
      const uploadUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo");
      uploadUrl.searchParams.set("did", session.did);
      uploadUrl.searchParams.set("name", "video-" + Date.now() + ".mp4");
      const headers = { "Authorization": "Bearer " + uploadToken, "Content-Type": "video/mp4" };
      if (length) headers["Content-Length"] = String(length);
      const upload = await fetch(uploadUrl.href, { method: "POST", headers, body: source.response.body });
      const uploadData = await upload.json().catch(() => ({}));
      const job = uploadData.jobStatus || uploadData;
      if (!upload.ok && !(upload.status === 409 && job.jobId)) return { success: false, error: uploadData.message || uploadData.error || "فشل رفع الفيديو لخدمة Bluesky (HTTP " + upload.status + ")" };
      if (job.blob) blob = job.blob;
      else if (job.jobId) return { success: false, processing: true, jobId: String(job.jobId) };
      else return { success: false, error: job.message || job.error || "لم تُرجع خدمة Bluesky حالة معالجة الفيديو" };
    }
    // منظومة الفيديو فقط: سحب عنوان صفحة الفيديو تلقائيًا لو العنوان فاضي قبل النشر
    try {
      if (!String(item.title || "").trim() && !String(item.autoTitle || "").trim() && item.url) {
        const prev = await fetchLinkPreview(String(item.url).trim());
        if (prev && prev.title) item.autoTitle = String(prev.title).slice(0, 300);
      }
    } catch {}
    return createVideoPost(account, session, pds, blob, item);
  } catch (e) { return { success: false, error: friendlyError(e) }; }
}

function decodeHtmlEntities(s) {
  return String(s || "").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'").replace(/&nbsp;/gi, " ").replace(/&#(x[0-9a-f]+|\d+);/gi, function (match, code) {
    const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    try { return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match; } catch { return match; }
  }).trim();
}
async function fetchLinkPreview(link) {
  const res = await fetch(link, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "text/html,image/*;q=0.9,*/*;q=0.8" }, redirect: "follow" });
  if (!res.ok) throw new Error("fetch failed");
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("image/")) return { title: "", description: "", imageUrl: link };
  if (!ct.includes("html") && !ct.includes("text/")) throw new Error("not html");
  const html = (await res.text()).slice(0, 300000);
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const getAttr = (tag, name) => {
    const re = new RegExp("\\b" + name + "\\s*=\\s*(['\"])(.*?)\\1", "i");
    const m = tag.match(re);
    return m ? (m[2] || "") : "";
  };
  const getMeta = (names) => {
    for (const tag of metaTags) {
      const key = (getAttr(tag, "property") || getAttr(tag, "name") || "").toLowerCase();
      if (names.includes(key)) {
        const value = decodeHtmlEntities(getAttr(tag, "content"));
        if (value) return value.slice(0, 1000);
      }
    }
    return "";
  };
  let title = getMeta(["og:title", "twitter:title"]);
  if (!title) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (m) title = decodeHtmlEntities(m[1].replace(/<[^>]*>/g, "")).slice(0, 300); }
  const description = getMeta(["og:description", "twitter:description", "description"]);
  let img = getMeta(["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  if (!img) {
    const linkTags = html.match(/<link\b[^>]*>/gi) || [];
    for (const tag of linkTags) {
      if ((getAttr(tag, "rel") || "").toLowerCase().split(/\s+/).includes("image_src")) { img = getAttr(tag, "href"); if (img) break; }
    }
  }
  if (img) {
    try {
      const imageUrl = new URL(decodeHtmlEntities(img), link);
      img = imageUrl.protocol === "http:" || imageUrl.protocol === "https:" ? imageUrl.href : "";
    } catch { img = ""; }
  }
  return { title: (title || "").trim(), description: (description || "").trim(), imageUrl: img };
}

function buildFacets(text, tags) {
  const facets = [];
  const enc = new TextEncoder();
  const pushTag = (tag) => {
    let start = 0;
    while (true) {
      const idx = text.indexOf(tag, start);
      if (idx === -1) break;
      const before = text[idx - 1];
      if (before && !/\s|\n/.test(before)) { start = idx + tag.length; continue; }
      const byteStart = enc.encode(text.slice(0, idx)).length;
      const byteEnd = byteStart + enc.encode(tag).length;
      facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: tag.replace("#", "") }] });
      start = idx + tag.length;
    }
  };
  (tags || []).forEach(pushTag);
  const urlRe = /https?:\/\/[^\s]+/g;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const byteStart = enc.encode(text.slice(0, m.index)).length;
    const byteEnd = byteStart + enc.encode(m[0]).length;
    facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

function convertToMinutes(hourStr, ampm) {
  let h = parseInt(hourStr, 10) || 12;
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60;
}

// دالة فحص وتذبذب نافذة النشاط اليومية الشاملة مع القوائم المنسدلة
function isOutsideActiveWindow(account, ts) {
  return isOutsideWindow(account.startHour || "07", account.startAmPm || "PM", account.endHour || "01", account.endAmPm || "AM", ts);
}
function isOutsideTextWindow(account, ts) {
  return isOutsideWindow(account.textStartHour || "07", account.textStartAmPm || "PM", account.textEndHour || "01", account.textEndAmPm || "AM", ts);
}
function isOutsideVideoWindow(account, ts) {
  return isOutsideWindow(account.videoStartHour || "07", account.videoStartAmPm || "PM", account.videoEndHour || "01", account.videoEndAmPm || "AM", ts);
}
function isOutsideWindow(startHour, startAmPm, endHour, endAmPm, ts) {
  const now = ts ?? Date.now();
  const p = cairoParts(now);
  const h = p.hour;
  const m = p.minute;
  const currentMinutes = h * 60 + m;

  const baseStartMin = convertToMinutes(startHour || "07", startAmPm || "PM");
  let baseEndMin = convertToMinutes(endHour || "01", endAmPm || "AM");
  if (baseEndMin <= baseStartMin) baseEndMin += 24 * 60;

  // توليد بصمة عشوائية يومية جذرية للجلسة
  const dateHash = Array.from(p.date).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const shiftStartMinutes = ((dateHash * 13) % 90) - 45; 
  const shiftEndMinutes = ((dateHash * 19) % 90) - 45;   

  const todayStartMin = baseStartMin + shiftStartMinutes;
  let todayEndMin = baseEndMin + shiftEndMinutes;

  let checkCurrent = currentMinutes;
  if (checkCurrent < todayStartMin && checkCurrent < (6 * 60)) {
    checkCurrent += 24 * 60;
  }
  
  let effectiveStart = todayStartMin;
  let effectiveEnd = todayEndMin;
  if (effectiveEnd <= effectiveStart) effectiveEnd += 24 * 60;

  if (checkCurrent < effectiveStart || checkCurrent > effectiveEnd) {
    return true; 
  }
  return false;
}

async function handleScheduledPosting(env, opts = {}) {
  const accounts = await getAccounts(env);
  if (!accounts.length) return { published: 0 };
  const isForce = opts.force === true;
  const today = cairoToday();
  let updated = false;
  let published = 0;

  for (const account of accounts) {
    // ---- reset counters daily (both systems) ----
    if (account.lastPostDate !== today) { account.postedToday = 0; account.lastPostDate = today; updated = true; }
    if (account.textLastPostDate !== today) { account.textPostedToday = 0; account.textLastPostDate = today; updated = true; }
    if (account.videoLastPostDate !== today) { account.videoPostedToday = 0; account.videoLastPostDate = today; updated = true; }
    // ---- نظام الصور (الأصلي) ----
    try {
      const canImg = isForce || account.postingEnabled === true;
      if (canImg && account.queue?.length) {
        let skipImg = false;
        if (!isForce && (account.postedToday || 0) >= getEffectiveDailyLimit(account, "", today, { mutateStartDate: true })) skipImg = true;
        if (!isForce && !skipImg && isOutsideActiveWindow(account)) skipImg = true;
        const now = Date.now();
        if (!isForce && !skipImg && account.nextPostAt && now < account.nextPostAt) skipImg = true;
        if (!skipImg) {
          let item = account.queue[0];
          if ((account.multiPerPost || 1) > 1) {
            const group = account.queue.slice(0, account.multiPerPost);
            const allUntitled = group.every(g => !(g.title || "").trim());
            if (allUntitled) {
              item = { ...group[0], urls: group.map(g => g.url), url: group.map(g => g.url).join("|") };
            }
          }
          const result = await publishItem(account, item, env);
          if (result.success) {
            const consumed = (account.multiPerPost || 1) > 1 && item.urls ? item.urls.length : 1;
            account.queue.splice(0, consumed);
            account.postedToday = (account.postedToday || 0) + 1;
            account.lastPostDate = today;
            account.lastPostAt = Date.now();
            const currentIv = Math.max(1, Math.min(120, parseInt(account.intervalMinutes || 15, 10)));
            let nextDelayMs = currentIv * 60000;
            if ((account.postMode || "random") === "random") {
              const variation = (Math.random() * 0.8 - 0.4) * (currentIv * 60000);
              nextDelayMs = Math.max(90000, (currentIv * 60000) + variation);
            }
            account.nextPostAt = Date.now() + nextDelayMs;
            account.lastError = "";
            updated = true;
            published++;
            await pushLog(env, { time: Date.now(), handle: account.handle, url: item.url, text: result.previewText || "", uri: result.uri || "", link: result.link || "", success: true, kind: isForce ? "manual" : "auto", type: "image" });
          } else {
            const msg = String(result.error || "خطأ");
            const currentIv = Math.max(1, Math.min(120, parseInt(account.intervalMinutes || 15, 10)));
            account.nextPostAt = Date.now() + (currentIv * 60000);
            account.lastError = msg.slice(0, 200);
            await pushLog(env, { time: Date.now(), handle: account.handle, url: item.url, text: "", uri: "", success: false, kind: isForce ? "manual" : "auto", type: "image", error: account.lastError });
            updated = true;
          }
        }
      }
    } catch (e) {
      account.lastError = String(e.message || e).slice(0, 200);
      account.nextPostAt = Date.now() + Math.max(1, Math.min(120, parseInt(account.intervalMinutes || 15, 10))) * 60000;
      await pushLog(env, { time: Date.now(), handle: account.handle, url: account.queue?.[0]?.url || "", text: "", success: false, kind: isForce ? "manual" : "auto", type: "image", error: account.lastError });
      updated = true;
    }
    // ---- نظام النص المستقل (جديد) ----
    try {
      const canTxt = isForce || account.textEnabled === true;
      if (canTxt && account.textQueue?.length) {
        let skipTxt = false;
        if (!isForce && (account.textPostedToday || 0) >= getEffectiveDailyLimit(account, "text", today, { mutateStartDate: true })) skipTxt = true;
        if (!isForce && !skipTxt && isOutsideTextWindow(account)) skipTxt = true;
        const now2 = Date.now();
        if (!isForce && !skipTxt && account.textNextPostAt && now2 < account.textNextPostAt) skipTxt = true;
        if (!skipTxt) {
          const tItem = account.textQueue[0];
          const tResult = await publishTextItem(account, tItem);
          if (tResult.success) {
            account.textQueue.splice(0, 1);
            account.textPostedToday = (account.textPostedToday || 0) + 1;
            account.textLastPostDate = today;
            account.textLastPostAt = Date.now();
            const cIv = Math.max(1, Math.min(120, parseInt(account.textIntervalMinutes || 15, 10)));
            let nd = cIv * 60000;
            if ((account.textPostMode || "random") === "random") {
              const variation = (Math.random() * 0.8 - 0.4) * (cIv * 60000);
              nd = Math.max(90000, (cIv * 60000) + variation);
            }
            account.textNextPostAt = Date.now() + nd;
            account.textLastError = "";
            updated = true;
            published++;
            await pushLog(env, { time: Date.now(), handle: account.handle, url: tItem.link || "", text: tResult.previewText || "", uri: tResult.uri || "", link: tResult.link || "", success: true, kind: isForce ? "text-manual" : "text-auto", type: "text" });
          } else {
            const msg = String(tResult.error || "خطأ");
            const cIv = Math.max(1, Math.min(120, parseInt(account.textIntervalMinutes || 15, 10)));
            account.textNextPostAt = Date.now() + (cIv * 60000);
            account.textLastError = msg.slice(0, 200);
            await pushLog(env, { time: Date.now(), handle: account.handle, url: tItem.link || "", text: "", uri: "", success: false, kind: isForce ? "text-manual" : "text-auto", type: "text", error: account.textLastError });
            updated = true;
          }
        }
      }
    } catch (e) {
      account.textLastError = String(e.message || e).slice(0, 200);
      account.textNextPostAt = Date.now() + Math.max(1, Math.min(120, parseInt(account.textIntervalMinutes || 15, 10))) * 60000;
      await pushLog(env, { time: Date.now(), handle: account.handle, url: account.textQueue?.[0]?.link || "", text: "", success: false, kind: isForce ? "text-manual" : "text-auto", type: "text", error: account.textLastError });
      updated = true;
    }
    // ---- نظام الفيديو المستقل ----
    try {
      const canVideo = account.videoEnabled === true;
      if (canVideo && account.videoQueue?.length) {
        let skipVideo = false;
        if (!isForce && (account.videoPostedToday || 0) >= getEffectiveDailyLimit(account, "video", today, { mutateStartDate: true })) skipVideo = true;
        if (!isForce && !skipVideo && isOutsideVideoWindow(account)) skipVideo = true;
        if (!isForce && !skipVideo && account.videoNextPostAt && Date.now() < account.videoNextPostAt) skipVideo = true;
        if (!skipVideo) {
          const vItem = account.videoQueue[0];
          const vResult = await publishVideoItem(account, vItem);
          if (vResult.success) {
            account.videoQueue.splice(0, 1);
            account.videoPostedToday = (account.videoPostedToday || 0) + 1;
            account.videoLastPostDate = today;
            account.videoLastPostAt = Date.now();
            const vIv = Math.max(1, Math.min(120, parseInt(account.videoIntervalMinutes || 15, 10)));
            let vDelay = vIv * 60000;
            if ((account.videoPostMode || "random") === "random") vDelay = Math.max(90000, vDelay + (Math.random() * 0.8 - 0.4) * vDelay);
            account.videoNextPostAt = Date.now() + vDelay;
            account.videoLastError = "";
            updated = true;
            published++;
            await pushLog(env, { time: Date.now(), handle: account.handle, url: vItem.url || "", text: vResult.previewText || "", uri: vResult.uri || "", link: vResult.link || "", success: true, kind: isForce ? "video-manual" : "video-auto", type: "video" });
          } else if (vResult.processing && vResult.jobId) {
            vItem.jobId = vResult.jobId;
            account.videoNextPostAt = Date.now() + 60000;
            account.videoLastError = "الفيديو قيد المعالجة على Bluesky؛ سيُستكمل تلقائيًا";
            updated = true;
          } else {
            if (vItem.jobId) vItem.jobId = "";
            const msg = String(vResult.error || "تعذر نشر الفيديو");
            const vIv = Math.max(1, Math.min(120, parseInt(account.videoIntervalMinutes || 15, 10)));
            account.videoNextPostAt = Date.now() + vIv * 60000;
            account.videoLastError = msg.slice(0, 200);
            await pushLog(env, { time: Date.now(), handle: account.handle, url: vItem.url || "", text: "", uri: "", success: false, kind: isForce ? "video-manual" : "video-auto", type: "video", error: account.videoLastError });
            updated = true;
          }
        }
      }
    } catch (e) {
      account.videoLastError = String(e.message || e).slice(0, 200);
      account.videoNextPostAt = Date.now() + Math.max(1, Math.min(120, parseInt(account.videoIntervalMinutes || 15, 10))) * 60000;
      await pushLog(env, { time: Date.now(), handle: account.handle, url: account.videoQueue?.[0]?.url || "", text: "", success: false, kind: isForce ? "video-manual" : "video-auto", type: "video", error: account.videoLastError });
      updated = true;
    }
  }

  if (updated) await saveAccounts(env, accounts);
  return { published };
}

function scheduleControlsHTML(prefix, label, accent) {
  const root = prefix === "image" ? "schedule" : prefix + "Schedule";
  const id = name => root + String(name || "").charAt(0).toUpperCase() + String(name || "").slice(1);
  const holdDays = '<option value="0">بدون تثبيت</option>' + Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">من اليوم ${i + 1}</option>`).join("");
  const holdCounts = Array.from({ length: 50 }, (_, i) => `<option value="${i + 1}">${i + 1} منشور/يوم</option>`).join("");
  return `<div class="schedule-box" style="border-color:${accent}">
  <div class="schedule-head"><b>التوزيع الذكي لعدد منشورات ${label}</b><button type="button" class="mini ghost" onclick="resetScheduleStart('${prefix}')">بدء اليوم الأول من اليوم</button></div>
  <div class="strategy-switch"><div class="strategy-switch-head"><b>الخطة الفعالة لعدد المنشورات</b><small id="${id("strategyStatus")}">اختر خطة واحدة للعدد</small></div><div class="strategy-buttons"><button type="button" id="${id("strategyRandom")}" class="strategy-btn random" onclick="selectPostingStrategy('${prefix}','random')">🎲 الخطة العشوائية<small>عدد ثابت • التوقيت من القائمة</small></button><button type="button" id="${id("strategyGradual")}" class="strategy-btn gradual" onclick="selectPostingStrategy('${prefix}','gradual')">📈 الخطة التدريجية<small>عدد متدرج • التوقيت من القائمة</small></button></div></div>
  <div class="three">
    <div><small class="hint">خطة العدد</small><select id="${id("mode")}" onchange="onScheduleModeChange('${prefix}')"><option value="fixed">ثابت يوميًا</option><option value="ramp">تدريجي تلقائي</option><option value="custom">تخصيص حسب اليوم</option></select></div>
    <div><small class="hint">طريقة حساب اليوم</small><select id="${id("dayBasis")}" onchange="upd()"><option value="activation">من يوم التفعيل</option><option value="month">من يوم الشهر</option></select></div>
    <div><small class="hint">السقف الأقصى</small><input id="${id("max")}" type="number" min="1" max="50" value="50" oninput="upd()"></div>
  </div>
  <div id="${id("rampFields")}" class="four" style="margin-top:9px">
    <div><small class="hint">عدد البداية (اليوم 1)</small><input id="${id("startCount")}" type="number" min="1" max="50" value="1" oninput="upd()"></div>
    <div><small class="hint">الزيادة كل يوم</small><input id="${id("step")}" type="number" min="0" max="50" value="1" oninput="upd()"></div>
    <div><small class="hint">يثبت من اليوم</small><select id="${id("holdAfterDay")}" onchange="upd()">${holdDays}</select></div>
    <div><small class="hint">عدد التثبيت</small><select id="${id("holdCount")}" onchange="upd()">${holdCounts}</select></div>
  </div>
  <div id="${id("customFields")}" style="display:none;margin-top:9px"><small class="hint">الأيام المخصصة (مثال: 1:1, 2:2, 3:3, 4:5)</small><textarea id="${id("custom")}" dir="ltr" oninput="upd()" placeholder="1:1, 2:2, 3:3, 4:5"></textarea></div>
  <div id="${id("help")}" class="schedule-help">الزران يحددان عدد المنشورات فقط: ثابت أو متدرج. استخدم قائمة طريقة النشر لاختيار توقيت عشوائي أو منتظم داخل الخطة المختارة.</div>
</div>`;
}

function getUltraDashboardHTML() {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bluesky Ultra - لوحة القيادة الذكية</title>
<style>
:root{--bg:#070b16;--card:#0f172acc;--card2:#111c33;--line:#1e2c4d;--txt:#eaf0ff;--mut:#93a1c0;--blue:#2f7bff;--blue2:#00c2ff;--green:#22c55e;--red:#ef4444;--pur:#a855f7;--gold:#f59e0b}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,"Segoe UI",Tahoma;color:var(--txt);background:radial-gradient(1000px 500px at 80% -10%,#1a2c5e55,transparent),radial-gradient(800px 400px at 10% 0%,#00c2ff22,transparent),var(--bg);min-height:100vh;padding:22px}
.wrap{max-width:1180px;margin:auto}
.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px}
.brand{display:flex;gap:12px;align-items:center}.logo{width:48px;height:48px;border-radius:16px;background:linear-gradient(135deg,var(--blue),var(--blue2));display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 8px 30px #2f7bff55}
.brand h1{margin:0;font-size:22px}.brand p{margin:2px 0 0;color:var(--mut);font-size:13px}
.system-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;padding:6px;background:#0b1328;border:1px solid var(--line);border-radius:16px;position:sticky;top:10px;z-index:5}.system-tab{flex:1;min-width:150px;background:#111c33;color:var(--mut);border:1px solid var(--line);box-shadow:none;padding:10px 14px}.system-tab:hover{transform:none;border-color:var(--blue)}.system-tab.active{background:linear-gradient(135deg,var(--blue),#5a5bff);border-color:transparent;color:#fff;box-shadow:0 6px 18px #2f7bff44}.system-tab[aria-selected="true"]{color:#fff}
button{border:0;border-radius:12px;padding:11px 18px;font-weight:800;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--blue),#5a5bff);box-shadow:0 6px 18px #2f7bff44;transition:.2s;font-size:14px}
button:hover{transform:translateY(-1px)}button.ghost{background:#16223d;box-shadow:none;border:1px solid var(--line)}button.green{background:linear-gradient(135deg,#16a34a,#22c55e)}button.red{background:linear-gradient(135deg,#dc2626,#ef4444)}button.gold{background:linear-gradient(135deg,#d97706,#f59e0b)}button:disabled{opacity:.6;cursor:wait}
.video-qitem{display:flex;gap:10px;align-items:center;background:#0c152b;border:1px solid #22c55e44;border-radius:12px;padding:9px;margin:7px 0;min-width:0}.video-qcopy{flex:1;min-width:0}.video-qcopy b,.video-qcopy small{display:block;overflow-wrap:anywhere;word-break:break-word}.video-qcopy b{font-size:13px}.video-qcopy small{color:var(--mut);font-size:11px;margin-top:3px}.video-qactions{display:flex;gap:4px;flex-shrink:0}.video-link{color:#5aa2ff}
#videoQueueList{display:grid;gap:0;max-height:560px;overflow:auto;margin-top:8px;padding-left:4px}#videoQueueList .video-qitem{margin:7px 0}.video-qitem video.qv{width:100%;max-height:190px;border-radius:10px;border:1px solid #223;margin-top:6px;background:#000;object-fit:contain}.video-qbadge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:800;margin-left:6px}.video-qbadge.now{background:#22c55e22;color:#4ade80;border:1px solid #22c55e55}.video-qbadge.auto{background:#0ea5e922;color:#7dd3fc;border:1px solid #0ea5e955}.video-qautotitle{color:#7dd3fc;font-size:11px;margin-top:3px}.qv-wrap{margin-top:6px}.qv-wrap button{width:100%}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}
.stat{background:linear-gradient(180deg,var(--card),#0b1226);border:1px solid var(--line);border-radius:18px;padding:14px}.stat small{color:var(--mut)}.stat b{font-size:26px;display:block;margin-top:4px}
.card{background:linear-gradient(180deg,#101a30ee,#0b1328ee);border:1px solid var(--line);border-radius:20px;padding:18px;margin:12px 0;box-shadow:0 10px 40px #0008}
.card h2{margin:0 0 4px;font-size:17px}.card p.d{margin:0 0 12px;color:var(--mut);font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap}input,select,textarea{width:100%;background:#0a1226;border:1px solid var(--line);color:var(--txt);border-radius:12px;padding:11px 12px;font-size:14px}textarea{min-height:110px;font-family:ui-monospace,monospace;direction:ltr;text-align:left;resize:vertical;min-width:0;max-width:100%}input:focus,select:focus,textarea:focus{outline:2px solid #2f7bff66;border-color:var(--blue)}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.two>*{min-width:0}@media(max-width:700px){.two{grid-template-columns:1fr}}.three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}@media(max-width:700px){.three{grid-template-columns:1fr}}
.acct{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#0c152b;border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin:8px 0;cursor:pointer}.acct.active{border-color:var(--blue);background:#122349}.acct .h{font-weight:800}.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-left:6px}.dot.on{background:var(--green);box-shadow:0 0 10px var(--green)}.dot.off{background:var(--red)}
.mini{font-size:12px;padding:7px 10px;border-radius:9px}
.layout{display:grid;grid-template-columns:360px 1fr;gap:12px}@media(max-width:1000px){.layout{grid-template-columns:1fr}}
.preview{background:#000;border:1px solid var(--line);border-radius:16px;padding:14px;max-width:460px;width:100%;min-width:0;overflow:hidden}.preview #pvText,.preview #pvText2{overflow-wrap:anywhere;word-break:break-word;min-width:0}.link-card{display:block;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:12px;background:#0c152b;color:var(--txt);text-decoration:none;min-width:0;max-width:100%;overflow:hidden}.link-card:hover{border-color:var(--blue)}.link-card small{display:block;color:var(--mut);overflow-wrap:anywhere;word-break:break-word}.link-card b{display:block;margin:4px 0;font-size:13px}.link-card .link-desc{display:block;color:var(--mut);font-size:12px;line-height:1.5;margin-bottom:6px;overflow-wrap:anywhere;word-break:break-word}.link-card .link-url{display:block;color:#5aa2ff;font-size:12px;overflow-wrap:anywhere;word-break:break-word}.link-card .link-thumb{display:block;width:100%;max-height:180px;object-fit:cover;border-radius:8px;margin-bottom:8px}.preview-toggle-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}#textQueueList{display:grid;gap:8px;max-height:560px;overflow:auto;margin-top:8px}#textQueueList .qitem{margin:0}.text-qitem{flex-wrap:nowrap;gap:8px;align-items:center;min-width:0}.text-q-summary{width:82px;min-width:82px;max-width:82px;display:flex;flex-direction:column;gap:4px;min-width:0}.text-q-summary b,.text-q-summary small{display:block;overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere;word-break:break-word}.text-q-summary b{font-size:12px}.text-q-summary small{font-size:10px;color:var(--mut)}.text-q-preview{display:flex;gap:8px;align-items:center;flex:1;min-width:0}.text-q-preview-media{width:68px;min-width:68px;height:68px;border-radius:10px;overflow:hidden;background:#111c33;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:10px;text-align:center}.text-q-preview-media img{width:100%;height:100%;object-fit:cover}.text-q-preview-copy{min-width:0;flex:1}.text-q-preview-copy small,.text-q-preview-copy b,.text-q-description,.text-q-url{display:block;overflow-wrap:anywhere;word-break:break-word}.text-q-preview-copy small{color:var(--mut);font-size:10px}.text-q-preview-copy b{font-size:12px;margin:2px 0}.text-q-description{font-size:10px;color:var(--mut);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.text-q-url{color:#5aa2ff;font-size:10px;margin-top:3px}.text-q-actions{display:flex;gap:4px;align-items:center;flex-shrink:0}#textQueueList.hide-link-previews .text-q-preview{display:none}.preview .ph{display:flex;gap:10px;align-items:center;margin-bottom:8px}.avatar{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,var(--pur),var(--blue));display:flex;align-items:center;justify-content:center;font-weight:900}.preview img.post{width:100%;border-radius:12px;border:1px solid #222;margin-top:8px;max-height:320px;object-fit:cover}.preview video.post{width:100%;border-radius:12px;border:1px solid #222;margin-top:8px;max-height:320px;background:#000;object-fit:contain}.ptags{color:#3fa0ff}
.qitem{display:flex;gap:10px;align-items:center;background:#0c152b;border:1px solid var(--line);border-radius:12px;padding:8px;margin:7px 0}.qitem img{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid #223;flex-shrink:0}.qitem .t{flex:1;min-width:0}.qitem .t b{font-size:13px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qitem .t small{color:var(--mut);overflow-wrap:anywhere;word-break:break-word}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--mut)}a{color:#5aa2ff}
#status{margin-top:10px;font-weight:800;min-height:22px}.pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:800}.pill.ok{background:#22c55e22;color:#4ade80;border:1px solid #22c55e55}.pill.bad{background:#ef444422;color:#fca5a5;border:1px solid #ef444455}.four{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}@media(max-width:900px){.four{grid-template-columns:repeat(2,1fr)}}@media(max-width:520px){.four{grid-template-columns:1fr}}
.schedule-box{margin-top:12px;padding:12px;border:1px solid #2f7bff55;border-radius:14px;background:#0c152b}.schedule-box .schedule-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}.schedule-box .schedule-head b{font-size:14px}.schedule-box .schedule-help{margin-top:9px;padding:9px;border-radius:10px;background:#111c33;color:#b9c7e8;font-size:12px;line-height:1.7}.schedule-box textarea{min-height:58px;font-size:12px}.schedule-box .mini{padding:6px 9px;font-size:11px}.strategy-switch{margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:12px;background:#0a1226}.strategy-switch-head{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.strategy-switch-head small{color:var(--mut);font-size:11px}.strategy-buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px}.strategy-btn{background:#111c33;border:1px solid var(--line);box-shadow:none;color:var(--mut);padding:10px 12px}.strategy-btn:hover{transform:none}.strategy-btn.active{color:#fff;border-color:transparent}.strategy-btn.active.random{background:linear-gradient(135deg,#7c3aed,#a855f7)}.strategy-btn.active.gradual{background:linear-gradient(135deg,#047857,#22c55e)}.strategy-btn.muted{opacity:.45}.strategy-btn small{display:block;font-size:10px;margin-top:3px;font-weight:600}

/* Phase 5 dashboard usability refinements: compact discovery and readable result areas. */
.log-filters{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.log-filters select{width:100%;min-width:0}@media(max-width:760px){.log-filters{grid-template-columns:minmax(0,1fr)}}
#discoveryPanel{padding:clamp(12px,2vw,20px);min-width:0}
#discoveryPanel h2{margin-top:0;line-height:1.45}
#discoveryPanel .row{gap:8px;align-items:center;flex-wrap:wrap}
#discoveryPanel button{min-height:38px;white-space:normal}
#discoveryPanel #discoveryStatus{min-height:0!important;padding:4px 0;overflow-wrap:anywhere}
#discoveryPanel #discoveryResults{max-height:620px;overflow:auto;overscroll-behavior:contain;padding-inline:2px}
#discoveryPanel #discoveryHistory{max-height:280px;overflow:auto;overscroll-behavior:contain;padding-inline:2px}
#discoveryPanel #discoveryProfileResult{overflow-wrap:anywhere}
#discoveryPanel input,#discoveryPanel select{min-width:0;width:100%;box-sizing:border-box}
#discoveryPanel article{box-shadow:0 4px 14px #00000018}
@media(max-width:760px){#discoveryPanel .two{grid-template-columns:minmax(0,1fr)!important}#discoveryPanel .row button{flex:1 1 140px}#discoveryPanel #discoveryResults{max-height:70vh}}
</style></head><body><div class="wrap">
<div class="top">
<div class="brand"><div class="logo">B</div><div><h1>Bluesky Ultra Autopilot</h1><p>نظام النشر الذكي بـ "نافذة نشاط ذكية" وتذبذب جذري شامل للجلسات</p></div></div>
<div class="actions">
<button class="ghost" onclick="loadData()">تحديث</button>
<button class="gold" onclick="runNow()">نشر الآن</button>
<button class="red" onclick="resetAll()">مسح شامل</button>
</div></div>

<div class="grid">
<div class="stat"><small>الحسابات</small><b id="sAcc">0</b></div>
<div class="stat"><small>مفعلة</small><b id="sOn">0</b></div>
<div class="stat"><small>في الطابور</small><b id="sQ">0</b></div>
<div class="stat"><small>منشور اليوم</small><b id="sToday">0</b></div>
</div>

<div class="layout">
<div>
<div class="card"><h2>1- الحسابات</h2><p class="d">ربط باليوزر و App Password</p>
<div class="two"><input id="handle" placeholder="user.bsky.social" style="direction:ltr;text-align:left"><input id="appPass" type="password" placeholder="كلمة المرور" style="direction:ltr;text-align:left"></div>
<div class="row" style="margin-top:8px"><button onclick="addAccount(this)">ربط الحساب</button></div>
<div id="accountsList" style="margin-top:8px"></div>
</div>
<div class="card"><h2>سجل النشر ومراقبة الجدولة</h2><p class="d">آخر 80 عملية — فلترة حسب الحساب والنظام والحالة، مع إبراز أخطاء Cron</p>
<div id="logHealth" class="schedule-help" role="status" aria-live="polite" style="margin:8px 0 12px">جارٍ قراءة حالة السجل…</div>
<div class="three log-filters" style="margin-bottom:10px">
<div><small class="hint">الحساب</small><select id="logFilterAccount" onchange="renderLogs()"><option value="">كل الحسابات</option></select></div>
<div><small class="hint">النظام</small><select id="logFilterType" onchange="renderLogs()"><option value="">كل الأنظمة</option><option value="image">صور</option><option value="text">نص</option><option value="video">فيديو</option><option value="system">النظام / Cron</option></select></div>
<div><small class="hint">الحالة</small><select id="logFilterStatus" onchange="renderLogs()"><option value="">الكل</option><option value="success">ناجح</option><option value="failed">فاشل</option></select></div>
</div>
<div class="row" style="margin-bottom:10px"><input id="logFilterSearch" placeholder="بحث في الخطأ أو الرابط أو النص…" oninput="renderLogs()" style="flex:1;min-width:160px"><button class="mini ghost" onclick="loadData()">↻ تحديث السجل</button><button class="mini red" onclick="clearLogs()">مسح السجل</button></div>
<div id="logs"></div></div>
</div>

<div>
<div class="system-tabs" role="tablist" aria-label="أنظمة النشر"><button type="button" class="system-tab active" data-system-tab="image" role="tab" aria-selected="true" onclick="switchSystemTab('image')">🖼️ نظام الصور</button><button type="button" class="system-tab" data-system-tab="text" role="tab" aria-selected="false" onclick="switchSystemTab('text')">📝 المنشورات النصية</button><button type="button" class="system-tab" data-system-tab="video" role="tab" aria-selected="false" onclick="switchSystemTab('video')">🎬 نظام الفيديو</button></div>
<div class="card" data-system-panel="image"><h2>2- إعدادات نافذة النشاط الذكية والتذبذب</h2><p class="d">حدد نطاق العمل اليومي باختيار الساعات، والكود سيقوم تلقائياً بعمل زحزحة وتذبذب جذري لفتحه وإغلاقه يومياً</p>
<div class="two">
<div>
<small class="hint">بداية نافذة النشاط (من)</small>
<div class="two">
<select id="startHour" onchange="upd()"><option value="01">الساعة 01</option><option value="02">الساعة 02</option><option value="03">الساعة 03</option><option value="04">الساعة 04</option><option value="05">الساعة 05</option><option value="06">الساعة 06</option><option value="07" selected>الساعة 07</option><option value="08">الساعة 08</option><option value="09">الساعة 09</option><option value="10">الساعة 10</option><option value="11">الساعة 11</option><option value="12">الساعة 12</option></select>
<select id="startAmPm" onchange="upd()"><option value="PM">مساءً (PM)</option><option value="AM">صباحاً (AM)</option></select>
</div>
</div>
<div>
<small class="hint">نهاية نافذة النشاط (إلى)</small>
<div class="two">
<select id="endHour" onchange="upd()"><option value="01" selected>الساعة 01</option><option value="02">الساعة 02</option><option value="03">الساعة 03</option><option value="04">الساعة 04</option><option value="05">الساعة 05</option><option value="06">الساعة 06</option><option value="07">الساعة 07</option><option value="08">الساعة 08</option><option value="09">الساعة 09</option><option value="10">الساعة 10</option><option value="11">الساعة 11</option><option value="12">الساعة 12</option></select>
<select id="endAmPm" onchange="upd()"><option value="AM">صباحاً (AM)</option><option value="PM">مساءً (PM)</option></select>
</div>
</div>
</div>
<div class="three" style="margin-top:10px">
<div><small class="hint">طريقة النشر</small><select id="postMode" onchange="upd()"><option value="random">عشوائي (ذروة بشرية بجلسة متذبذبة)</option><option value="regular">منتظم (ثابت بالدقائق)</option></select></div>
<div><small class="hint">الفارق بين البوستات (بالدقائق)</small><input id="intervalMinutes" type="number" min="1" max="120" value="15" oninput="upd()" style="text-align:right"></div>
<div><small class="hint">حد يومي</small><select id="dailyLimit" onchange="upd()"><option value="1">1 / يوم</option><option value="2">2 / يوم</option><option value="3">3 / يوم</option><option value="4">4 / يوم</option><option value="5">5 / يوم</option><option value="6">6 / يوم</option><option value="7">7 / يوم</option><option value="8">8 / يوم</option><option value="9">9 / يوم</option><option value="10">10 / يوم</option><option value="11">11 / يوم</option><option value="12" selected>12 / يوم</option><option value="13">13 / يوم</option><option value="14">14 / يوم</option><option value="15">15 / يوم</option><option value="16">16 / يوم</option><option value="17">17 / يوم</option><option value="18">18 / يوم</option><option value="19">19 / يوم</option><option value="20">20 / يوم</option><option value="21">21 / يوم</option><option value="22">22 / يوم</option><option value="23">23 / يوم</option><option value="24">24 / يوم</option><option value="25">25 / يوم</option><option value="26">26 / يوم</option><option value="27">27 / يوم</option><option value="28">28 / يوم</option><option value="29">29 / يوم</option><option value="30">30 / يوم</option><option value="31">31 / يوم</option><option value="32">32 / يوم</option><option value="33">33 / يوم</option><option value="34">34 / يوم</option><option value="35">35 / يوم</option><option value="36">36 / يوم</option><option value="37">37 / يوم</option><option value="38">38 / يوم</option><option value="39">39 / يوم</option><option value="40">40 / يوم</option><option value="41">41 / يوم</option><option value="42">42 / يوم</option><option value="43">43 / يوم</option><option value="44">44 / يوم</option><option value="45">45 / يوم</option><option value="46">46 / يوم</option><option value="47">47 / يوم</option><option value="48">48 / يوم</option><option value="49">49 / يوم</option><option value="50">50 / يوم</option></select></div>
</div>
${scheduleControlsHTML("image", "الصور", "#2f7bff55")}
<div class="two" style="margin-top:8px">
<div><small class="hint">صور في البوست؟</small><select id="multiPerPost" onchange="upd()"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></div>
<div><small class="hint">Alt Text للصور</small><input id="altText" oninput="upd()" placeholder="مثال: صورة طبيعية"></div>
</div>
<div id="smartBox" class="hint" style="margin-top:12px;background:#0c152b;padding:10px;border-radius:10px;border:1px solid var(--line)"></div>
</div>

<div class="card" data-system-panel="image"><h2>3- المحتوى + معاينة حية</h2><p class="d">الصق الروابط والعناوين — كل سطر = بوست</p>
<div class="row" style="margin-bottom:10px"><button id="imageToggleBtn" class="ghost" onclick="toggleImagePosting()">تفعيل الصور ▶</button><button class="mini" style="background:#7c3aed" onclick="testPost(selectedAccountIndex,this)">تجربة صورة</button><span class="hint" id="imageStateHint"></span></div>
<div class="two">
<div><small class="hint">الروابط (<span id="urlCounter">0</span>)</small><textarea id="bulkUrls" oninput="upd()" placeholder="https://..."></textarea></div>
<div><small class="hint">العناوين (<span id="titleCounter">0</span>)</small><textarea id="postTitle" oninput="upd()" placeholder="عنوان كل صورة في سطر"></textarea></div>
</div>
<div style="margin-top:8px"><small class="hint">الهاشتاجات (<span id="tagCounter">0</span>)</small><textarea id="postTags" oninput="upd()" style="min-height:70px" placeholder="#art #photo #bluesky"></textarea></div>
<div class="two" style="margin-top:8px">
<div><small class="hint">عدد الهاشتاجات العشوائية</small><select id="tagsCount" onchange="upd()"><option value="1" selected>1 هاشتاج</option><option value="2">2 هاشتاج</option><option value="3">3 هاشتاج</option><option value="4">4 هاشتاج</option><option value="5">5 هاشتاج</option><option value="6">6 هاشتاج</option><option value="7">7 هاشتاج</option><option value="8">8 هاشتاج</option><option value="9">9 هاشتاج</option><option value="10">10 هاشتاج</option><option value="11">11 هاشتاج</option><option value="12">12 هاشتاج</option><option value="13">13 هاشتاج</option><option value="14">14 هاشتاج</option><option value="15">15 هاشتاج</option><option value="16">16 هاشتاج</option><option value="17">17 هاشتاج</option><option value="18">18 هاشتاج</option><option value="19">19 هاشتاج</option><option value="20">20 هاشتاج</option><option value="21">21 هاشتاج</option><option value="22">22 هاشتاج</option><option value="23">23 هاشتاج</option><option value="24">24 هاشتاج</option><option value="25">25 هاشتاج</option><option value="26">26 هاشتاج</option><option value="27">27 هاشتاج</option><option value="28">28 هاشتاج</option><option value="29">29 هاشتاج</option><option value="30">30 هاشتاج</option></select></div>
<div style="display:flex;align-items:end"><button class="green" onclick="saveConfig()">حفظ إعدادات الصور</button></div>
</div>
<div class="two" style="margin-top:12px">
<div><div class="preview-toggle-heading"><small class="hint">معاينة بوست Bluesky</small><button id="imagePreviewToggle" class="mini ghost" onclick="togglePreviewPanel('imagePreviewPanel','imagePreviewToggle','image')">إخفاء المعاينة</button></div><div id="imagePreviewPanel"><div class="preview"><div class="ph"><div class="avatar" id="pvAv">B</div><div><b id="pvHandle">—</b><br><small class="hint">الآن</small></div></div><div id="pvText" style="white-space:pre-wrap;font-size:14px"></div><img class="post" id="pvImg" style="display:none"></div></div></div>
<div><small class="hint">الطابور</small><div id="queueList"></div></div>
</div>
<div id="status"></div>
</div>

<div class="card" data-system-panel="text" style="border-color:#a855f755"><h2>4- إعدادات بوستات النص 📝 (جدولة مستقلة تماماً)</h2><p class="d">نظام منفصل للبوستات العادية: عنوان + رابط + هاشتاج — مرن: لو الرابط فاضي ينشر عنوان وهاشتاج، ولو العنوان فاضي ينشر رابط وهاشتاج، ولو الاتنين فاضيين ينشر هاشتاج بس</p>
<div class="row" style="margin-bottom:10px"><button id="textToggleBtn" class="ghost" onclick="toggleTextPosting()">تفعيل النص</button><button class="mini" style="background:#7c3aed" onclick="testTextPost(this)">تجربة بوست نصي</button><span class="hint" id="textStateHint"></span></div>
<div class="two">
<div>
<small class="hint">بداية نافذة النص (من)</small>
<div class="two">
<select id="textStartHour" onchange="upd()"><option value="01">الساعة 01</option><option value="02">الساعة 02</option><option value="03">الساعة 03</option><option value="04">الساعة 04</option><option value="05">الساعة 05</option><option value="06">الساعة 06</option><option value="07" selected>الساعة 07</option><option value="08">الساعة 08</option><option value="09">الساعة 09</option><option value="10">الساعة 10</option><option value="11">الساعة 11</option><option value="12">الساعة 12</option></select>
<select id="textStartAmPm" onchange="upd()"><option value="PM">مساءً (PM)</option><option value="AM">صباحاً (AM)</option></select>
</div>
</div>
<div>
<small class="hint">نهاية نافذة النص (إلى)</small>
<div class="two">
<select id="textEndHour" onchange="upd()"><option value="01" selected>الساعة 01</option><option value="02">الساعة 02</option><option value="03">الساعة 03</option><option value="04">الساعة 04</option><option value="05">الساعة 05</option><option value="06">الساعة 06</option><option value="07">الساعة 07</option><option value="08">الساعة 08</option><option value="09">الساعة 09</option><option value="10">الساعة 10</option><option value="11">الساعة 11</option><option value="12">الساعة 12</option></select>
<select id="textEndAmPm" onchange="upd()"><option value="AM">صباحاً (AM)</option><option value="PM">مساءً (PM)</option></select>
</div>
</div>
</div>
<div class="three" style="margin-top:10px">
<div><small class="hint">طريقة نشر النص</small><select id="textPostMode" onchange="upd()"><option value="random">عشوائي (ذروة بشرية)</option><option value="regular">منتظم (ثابت بالدقائق)</option></select></div>
<div><small class="hint">الفارق بين بوستات النص (بالدقائق)</small><input id="textIntervalMinutes" type="number" min="1" max="120" value="15" oninput="upd()" style="text-align:right"></div>
<div><small class="hint">حد يومي للنص</small><select id="textDailyLimit" onchange="upd()"><option value="1">1 / يوم</option><option value="2">2 / يوم</option><option value="3">3 / يوم</option><option value="4">4 / يوم</option><option value="5">5 / يوم</option><option value="6">6 / يوم</option><option value="7">7 / يوم</option><option value="8">8 / يوم</option><option value="9">9 / يوم</option><option value="10">10 / يوم</option><option value="11">11 / يوم</option><option value="12" selected>12 / يوم</option><option value="13">13 / يوم</option><option value="14">14 / يوم</option><option value="15">15 / يوم</option><option value="16">16 / يوم</option><option value="17">17 / يوم</option><option value="18">18 / يوم</option><option value="19">19 / يوم</option><option value="20">20 / يوم</option><option value="21">21 / يوم</option><option value="22">22 / يوم</option><option value="23">23 / يوم</option><option value="24">24 / يوم</option><option value="25">25 / يوم</option><option value="26">26 / يوم</option><option value="27">27 / يوم</option><option value="28">28 / يوم</option><option value="29">29 / يوم</option><option value="30">30 / يوم</option><option value="31">31 / يوم</option><option value="32">32 / يوم</option><option value="33">33 / يوم</option><option value="34">34 / يوم</option><option value="35">35 / يوم</option><option value="36">36 / يوم</option><option value="37">37 / يوم</option><option value="38">38 / يوم</option><option value="39">39 / يوم</option><option value="40">40 / يوم</option><option value="41">41 / يوم</option><option value="42">42 / يوم</option><option value="43">43 / يوم</option><option value="44">44 / يوم</option><option value="45">45 / يوم</option><option value="46">46 / يوم</option><option value="47">47 / يوم</option><option value="48">48 / يوم</option><option value="49">49 / يوم</option><option value="50">50 / يوم</option></select></div>
</div>
${scheduleControlsHTML("text", "البوستات النصية", "#a855f755")}
<div id="smartBoxText" class="hint" style="margin-top:12px;background:#0c152b;padding:10px;border-radius:10px;border:1px solid #a855f755"></div>
</div>

<div class="card" data-system-panel="text" style="border-color:#a855f755"><h2>5- محتوى النص + معاينة حية 📝</h2><p class="d">الصق الروابط والعناوين — كل سطر = بوست نصي (غير مرتبطين ببعض زي الصور)</p>
<div class="two">
<div><small class="hint">روابط النص (<span id="urlCounterT">0</span>) — اختياري</small><textarea id="bulkTextLinks" oninput="upd()" placeholder="https://... (يمكن تركه فاضي)"></textarea></div>
<div><small class="hint">عناوين النص (<span id="titleCounterT">0</span>) — اختياري</small><textarea id="bulkTextTitles" oninput="upd()" placeholder="نص البوست في سطر (يمكن تركه فاضي)"></textarea></div>
</div>
<div style="margin-top:8px"><small class="hint">هاشتاجات النص (<span id="tagCounterT">0</span>)</small><textarea id="bulkTextTags" oninput="upd()" style="min-height:70px" placeholder="#news #tech"></textarea></div>
<div class="two" style="margin-top:8px">
<div><small class="hint">عدد هاشتاجات النص العشوائية</small><select id="textTagsCount" onchange="upd()"><option value="1" selected>1 هاشتاج</option><option value="2">2 هاشتاج</option><option value="3">3 هاشتاج</option><option value="4">4 هاشتاج</option><option value="5">5 هاشتاج</option><option value="6">6 هاشتاج</option><option value="7">7 هاشتاج</option><option value="8">8 هاشتاج</option><option value="9">9 هاشتاج</option><option value="10">10 هاشتاج</option><option value="11">11 هاشتاج</option><option value="12">12 هاشتاج</option><option value="13">13 هاشتاج</option><option value="14">14 هاشتاج</option><option value="15">15 هاشتاج</option><option value="16">16 هاشتاج</option><option value="17">17 هاشتاج</option><option value="18">18 هاشتاج</option><option value="19">19 هاشتاج</option><option value="20">20 هاشتاج</option><option value="21">21 هاشتاج</option><option value="22">22 هاشتاج</option><option value="23">23 هاشتاج</option><option value="24">24 هاشتاج</option><option value="25">25 هاشتاج</option><option value="26">26 هاشتاج</option><option value="27">27 هاشتاج</option><option value="28">28 هاشتاج</option><option value="29">29 هاشتاج</option><option value="30">30 هاشتاج</option></select></div>
<div style="display:flex;align-items:end;gap:8px"><button class="green" onclick="saveConfig()">حفظ إعدادات النص</button></div>
</div>
<div class="two" style="margin-top:12px">
<div><div class="preview-toggle-heading"><small class="hint">معاينة بوست نصي</small><button id="textPostPreviewToggle" class="mini ghost" onclick="togglePreviewPanel('textPostPreviewPanel','textPostPreviewToggle','text-post')">إخفاء المعاينة</button></div><div id="textPostPreviewPanel"><div class="preview"><div class="ph"><div class="avatar" id="pvAv2" style="background:linear-gradient(135deg,#a855f7,#2f7bff)">T</div><div><b id="pvHandle2">—</b><br><small class="hint">الآن</small></div></div><div id="pvText2" style="white-space:pre-wrap;font-size:14px"></div><a id="pvLinkCard" class="link-card" href="#" target="_blank" rel="noopener noreferrer" style="display:none"><img class="link-thumb" id="pvLinkImage" alt="" style="display:none"><small id="pvLinkHost"></small><b id="pvLinkTitle"></b><span class="link-desc" id="pvLinkDesc"></span><span class="link-url" id="pvLinkUrl"></span></a></div></div></div>
<div><div class="preview-toggle-heading"><small class="hint">طابور النص — معاينة الرابط وزر الحذف بجانبه</small><button id="textLinksPreviewToggle" class="mini ghost" onclick="toggleTextQueuePreviews()">إخفاء المعاينات</button></div><div id="textQueueList"></div></div>
</div>
<div id="statusText" style="margin-top:10px;font-weight:800;min-height:22px"></div>
</div>

<div class="card" data-system-panel="video" id="videoSystem" style="border-color:#22c55e66"><h2>6- نظام الفيديو + معاينة حية 🎬 (جدولة مستقلة)</h2><p class="d">أدخل رابط ملف MP4 أو رابط صفحة عامة تكشف رابط الفيديو. يُرفع الفيديو إلى Bluesky ويُنشر كفيديو داخل المنشور، مع إعدادات وهاشتاجات وطابور مستقل.</p>
<div class="row" style="margin-bottom:10px"><button id="videoToggleBtn" class="ghost" onclick="toggleVideoPosting()">تفعيل الفيديو ▶</button><button class="mini" style="background:#0891b2" onclick="testVideoPost(this)">تجربة فيديو</button><span class="hint" id="videoStateHint">متوقف</span></div>
<div class="two">
<div><small class="hint">بداية نافذة الفيديو (من)</small><div class="two"><select id="videoStartHour" onchange="upd()"></select><select id="videoStartAmPm" onchange="upd()"><option value="PM">مساءً (PM)</option><option value="AM">صباحاً (AM)</option></select></div></div>
<div><small class="hint">نهاية نافذة الفيديو (إلى)</small><div class="two"><select id="videoEndHour" onchange="upd()"></select><select id="videoEndAmPm" onchange="upd()"><option value="AM">صباحاً (AM)</option><option value="PM">مساءً (PM)</option></select></div></div>
</div>
<div class="three" style="margin-top:10px">
<div><small class="hint">طريقة نشر الفيديو</small><select id="videoPostMode" onchange="upd()"><option value="random">عشوائي (نافذة نشاط ذكية)</option><option value="regular">منتظم (ثابت بالدقائق)</option></select></div>
<div><small class="hint">الفارق بين الفيديوهات (بالدقائق)</small><input id="videoIntervalMinutes" type="number" min="1" max="120" value="15" oninput="upd()" style="text-align:right"></div>
<div><small class="hint">الحد اليومي للفيديو</small><select id="videoDailyLimit" onchange="upd()"></select></div>
</div>
${scheduleControlsHTML("video", "الفيديو", "#22c55e55")}
<div id="smartBoxVideo" class="hint" style="margin-top:12px;background:#0c152b;padding:10px;border-radius:10px;border:1px solid #22c55e55"></div>
<div class="two" style="margin-top:12px">
<div><small class="hint">روابط الفيديو أو صفحات الفيديو (<span id="urlCounterV">0</span>) — كل سطر فيديو مستقل</small><textarea id="bulkVideoUrls" oninput="upd()" placeholder="https://example.com/video.mp4 أو رابط صفحة عامة"></textarea></div>
<div><small class="hint">عناوين الفيديوهات (<span id="titleCounterV">0</span>)</small><textarea id="bulkVideoTitles" oninput="upd()" placeholder="عنوان لكل فيديو في سطر"></textarea></div>
</div>
<div style="margin-top:8px"><small class="hint">هاشتاجات الفيديو الخاصة بالنظام (<span id="tagCounterV">0</span>)</small><textarea id="bulkVideoTags" oninput="upd()" style="min-height:70px" placeholder="#video #news"></textarea></div>
<div class="two" style="margin-top:8px"><div><small class="hint">عدد هاشتاجات الفيديو العشوائية</small><select id="videoTagsCount" onchange="upd()"></select></div><div style="display:flex;align-items:end"><button class="green" onclick="saveConfig()">حفظ إعدادات الفيديو</button></div></div>
<div class="two" style="margin-top:12px">
<div><div class="preview-toggle-heading"><small class="hint">معاينة منشور الفيديو</small><button id="videoPreviewToggle" class="mini ghost" onclick="togglePreviewPanel('videoPreviewPanel','videoPreviewToggle','video')">إخفاء المعاينة</button></div><div id="videoPreviewPanel"><div class="preview"><div class="ph"><div class="avatar" id="pvAv3" style="background:linear-gradient(135deg,#16a34a,#22c55e)">V</div><div><b id="pvHandle3">—</b><br><small class="hint">معاينة المنشور</small></div></div><div id="pvVideoText" style="white-space:pre-wrap;font-size:14px"></div><video class="post" id="pvVideo" controls playsinline preload="none" style="display:none"></video><div id="pvVideoNote" class="hint" style="margin-top:8px">أدخل رابط MP4 أو صفحة فيديو لعرض المعاينة.</div></div></div></div>
<div><div class="preview-toggle-heading"><small class="hint">طابور الفيديو — يمكن الحذف أو تغيير الترتيب • <span id="videoQueueCount">0</span> فيديو</small><span class="row"><button class="mini ghost" onclick="fetchVideoTitlesIntoBoxes(this)">سحب عناوين الروابط</button></span></div><div id="videoQueueList"></div></div>
</div>
<div id="statusVideo" style="margin-top:10px;font-weight:800;min-height:22px"></div>
</div>

</div>
</div>
</div>


<div class="card" id="discoveryPanel" style="border-color:#00c2ff66">
  <h2>7- مركز اكتشاف المنشورات وتحليل الصلة 🔎</h2>
  <p class="d">ابحث في المنشورات العامة، حلّل النتائج بمؤشرات واضحة، وراجع سجل الاكتشاف. هذا المركز لا ينفّذ إعجابات أو متابعات أو ردودًا تلقائية.</p>
  <div class="two">
    <div><small class="hint">موضوع البحث</small><input id="discoveryQuery" maxlength="300" placeholder="مثال: photography أو الذكاء الاصطناعي" onkeydown="if(event.key==='Enter')discoverySearch()"></div>
    <div><small class="hint">عدد النتائج</small><select id="discoveryLimit"><option value="10">10 منشورات</option><option value="20" selected>20 منشورًا</option><option value="30">30 منشورًا</option><option value="50">50 منشورًا</option></select></div>
  </div>
  <div class="row" style="margin-top:10px"><button id="discoverySearchBtn" onclick="discoverySearch()">🔎 البحث العام</button><button id="discoveryAnalyzeBtn" class="green" onclick="discoveryAnalyze()" disabled>تحليل النتائج</button><button class="ghost" onclick="discoveryLoadHistory()">📚 تحديث السجل</button><button class="ghost" onclick="discoveryProfile()">👤 فحص حساب</button></div>
  <div id="discoveryStatus" role="status" aria-live="polite" style="margin-top:10px;min-height:22px;font-weight:700"></div>
  <div class="two" style="margin-top:8px"><div><small class="hint">تصفية النتائج المعروضة</small><input id="discoveryFilter" maxlength="200" placeholder="كلمة من المنشور أو اسم الحساب" oninput="discoveryRenderPosts(discoveryPosts,discoveryAnalyzed)"></div><div><small class="hint">ترتيب النتائج</small><select id="discoverySort" onchange="discoveryRenderPosts(discoveryPosts,discoveryAnalyzed)"><option value="original">ترتيب البحث</option><option value="score">الأعلى صلة أولًا</option><option value="engagement">الأعلى تفاعلًا أولًا</option></select></div></div>
  <div id="discoveryResults" style="margin-top:12px"><p class="hint">ابدأ ببحث عام لعرض المنشورات المرشحة هنا.</p></div>
  <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px"><h3 style="margin:0 0 8px">سجل الاكتشاف والتحليل</h3><div id="discoveryHistory" class="hint">اضغط «تحديث السجل» لجلب آخر النتائج المحفوظة.</div></div>
  <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px"><h3 style="margin:0 0 8px">تفاصيل حساب عام</h3><div class="two"><input id="discoveryActor" maxlength="300" placeholder="handle.bsky.social أو DID"><button class="ghost" onclick="discoveryProfile()">جلب الملف العام</button></div><div id="discoveryProfileResult" style="margin-top:8px"></div></div>
</div>

<script>
var currentData={accounts:[],logs:[],stats:{}},selectedAccountIndex=null,accountStates={};
function apiKey(){try{var m=new URLSearchParams(location.search).get('key');if(m){try{localStorage.setItem('bsky_key',m)}catch(e){}return m}try{return localStorage.getItem('bsky_key')||''}catch(e){return ''}}catch(e){return ''}}
function apiUrl(p){var k=apiKey();return k?p+((p.indexOf('?')>-1)?'&':'?')+'key='+encodeURIComponent(k):p}
async function apiPost(p,body){body=body||{};var k=apiKey();if(k&&!body.key)body.key=k;var r=await fetch(apiUrl(p),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(r.status===401){var d=null;try{d=await r.json()}catch(e){}var msg=(d&&d.error)||'غير مصرح';var nk=prompt(msg+'\\nادخل كلمة سر اللوحة:','');if(nk){try{localStorage.setItem('bsky_key',nk)}catch(e){}return apiPost(p,Object.assign({},body,{key:nk}))}throw new Error(msg)}return r}
async function apiGet(p){var r=await fetch(apiUrl(p));if(r.status===401){var d=null;try{d=await r.clone().json()}catch(e){}var msg=(d&&d.error)||'غير مصرح';var nk=prompt(msg+'\\nادخل كلمة سر اللوحة:','');if(nk){try{localStorage.setItem('bsky_key',nk)}catch(e){}var retryUrl=p+((p.indexOf('?')>-1)?'&':'?')+'key='+encodeURIComponent(nk);return fetch(retryUrl)}throw new Error(msg)}return r}
var discoveryPosts=[],discoveryAnalyzed=[];
function discoverySetStatus(message,ok){var el=$('discoveryStatus');if(el){el.style.color=ok===false?'#fca5a5':ok===true?'#4ade80':'var(--mut)';el.textContent=message||'';}}
async function discoveryJson(response){var data;try{data=await response.json()}catch(e){throw new Error('استجابة غير مفهومة من الخادم')}if(!response.ok||data.error)throw new Error(data.error||('فشل الطلب: '+response.status));return data;}
async function discoverySearch(){var q=String($('discoveryQuery').value||'').trim();if(!q){discoverySetStatus('اكتب موضوعًا للبحث أولًا.',false);return}var btn=$('discoverySearchBtn');btn.disabled=true;discoverySetStatus('جارٍ البحث في المنشورات العامة…');try{var r=await apiGet('/api/discovery/search?q='+encodeURIComponent(q)+'&limit='+encodeURIComponent($('discoveryLimit').value));var d=await discoveryJson(r);discoveryPosts=Array.isArray(d.posts)?d.posts:[];discoveryAnalyzed=[];$('discoveryAnalyzeBtn').disabled=!discoveryPosts.length;discoveryRenderPosts(discoveryPosts,[]);discoverySetStatus('تم جلب '+discoveryPosts.length+' نتيجة. '+(d.dedupePersistent?'إزالة التكرار محفوظة في KV.':'تنبيه: لا يوجد KV للحفظ الدائم.'),true)}catch(e){discoverySetStatus(e.message||'تعذر البحث.',false)}finally{btn.disabled=false}}
async function discoveryAnalyze(){if(!discoveryPosts.length){discoverySetStatus('ابحث أولًا حتى تتوفر نتائج للتحليل.',false);return}var btn=$('discoveryAnalyzeBtn');btn.disabled=true;discoverySetStatus('جارٍ تحليل النتائج…');try{var r=await apiPost('/api/discovery/analyze',{query:String($('discoveryQuery').value||'').trim(),posts:discoveryPosts});var d=await discoveryJson(r);discoveryAnalyzed=Array.isArray(d.analyzed)?d.analyzed:(Array.isArray(d.results)?d.results:[]);if(!discoveryAnalyzed.length&&Array.isArray(d.posts))discoveryAnalyzed=d.posts;discoveryRenderPosts(discoveryPosts,discoveryAnalyzed);discoverySetStatus('اكتمل التحليل. التقييم تقريبي بالكلمات والتفاعل ويحتاج مراجعة بشرية؛ لا توجد تفاعلات تلقائية.',true);discoveryLoadHistory()}catch(e){discoverySetStatus(e.message||'تعذر تحليل النتائج.',false)}finally{btn.disabled=false}}
function discoveryRenderPosts(posts,analyzed){var root=$('discoveryResults');if(!posts.length){root.innerHTML='<p class=\"hint\">لا توجد نتائج لعرضها.</p>';return}var byUri={};(analyzed||[]).forEach(function(a){byUri[a.uri]=a});var filter=String(($('discoveryFilter')||{}).value||'').trim().toLocaleLowerCase();var sort=String(($('discoverySort')||{}).value||'original');var visible=posts.filter(function(p){var a=p.author||{};var hay=String(p.text||'')+' '+String(a.handle||'')+' '+String(a.displayName||'');return !filter||hay.toLocaleLowerCase().indexOf(filter)!==-1});if(sort!=='original')visible.sort(function(x,y){var ax=byUri[x.uri]||{},ay=byUri[y.uri]||{};if(sort==='score')return (Number(ay.relevanceScore)||0)-(Number(ax.relevanceScore)||0);var mx=x.metrics||{},my=y.metrics||{};var sx=(Number(mx.likeCount)||0)+2*(Number(mx.repostCount)||0)+(Number(mx.replyCount)||0);var sy=(Number(my.likeCount)||0)+2*(Number(my.repostCount)||0)+(Number(my.replyCount)||0);return sy-sx});if(!visible.length){root.innerHTML='<p class=\"hint\">لا توجد نتائج تطابق التصفية الحالية.</p>';return}root.innerHTML='<p class=\"hint\">عرض '+visible.length+' من '+posts.length+' نتيجة.</p>'+visible.map(function(p){var a=byUri[p.uri]||{},author=p.author||{},metrics=p.metrics||{},score=Number(a.relevanceScore),scoreText=isFinite(score)?Math.max(0,Math.min(100,score))+'/100':'لم يُحلّل بعد';var profile='https://bsky.app/profile/'+encodeURIComponent(author.handle||author.did||'');var postUrl=p.uri&&p.uri.indexOf('at://')===0?'https://bsky.app/profile/'+encodeURIComponent(author.handle||author.did||'')+'/post/'+encodeURIComponent(p.uri.split('/').pop()):profile;var text=String(p.text||'');return '<article style="border:1px solid var(--line);background:#0c152b;border-radius:14px;padding:12px;margin:8px 0"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>'+escapeHtml(author.displayName||author.handle||'حساب عام')+'</b><span class="pill '+(isFinite(score)&&score>=55?'ok':'')+'">الصلة: '+escapeHtml(scoreText)+'</span></div><small class="hint">@'+escapeHtml(author.handle||'غير معروف')+' · '+Number(metrics.likeCount||0)+' إعجاب · '+Number(metrics.repostCount||0)+' إعادة نشر · '+Number(metrics.replyCount||0)+' رد</small><p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:9px 0">'+escapeHtml(text)+'</p>'+(a.reasons&&a.reasons.length?'<small class="hint">'+escapeHtml(a.reasons.join(' • '))+'</small>':'')+'<div class="row" style="margin-top:8px"><a href="'+escapeHtml(postUrl)+'" target="_blank" rel="noopener noreferrer">فتح المنشور</a><a href="'+escapeHtml(profile)+'" target="_blank" rel="noopener noreferrer">فتح الحساب</a>'+(p.alreadySeen===true?'<span class="pill">سبق رصده</span>':'')+'</div></article>'}).join('')}
async function discoveryLoadHistory(){var box=$('discoveryHistory');box.textContent='جارٍ تحميل السجل…';try{var r=await apiGet('/api/discovery/history?limit=50');var d=await discoveryJson(r);var seen=Array.isArray(d.seen)?d.seen:[],analyzed=Array.isArray(d.analyzed)?d.analyzed:[];var html='<p class="hint">'+(d.persisted?'الحفظ الدائم متاح • الاحتفاظ حتى 30 يومًا':'الحفظ الدائم غير متاح: اربط KV بالـ Worker')+' · مرصود: '+seen.length+' · محلّل: '+analyzed.length+'</p>';if(!seen.length&&!analyzed.length)html+='<p class="hint">السجل فارغ حتى الآن.</p>';if(analyzed.length)html+='<h4>آخر نتائج التحليل</h4>'+analyzed.slice(0,20).map(function(x){return '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><b>'+escapeHtml(x.author&& (x.author.displayName||x.author.handle)||x.uri||'منشور')+'</b> — '+escapeHtml(String(x.relevanceScore==null?'—':x.relevanceScore)+'/100')+'<div class="hint">'+escapeHtml(String(x.text||'').slice(0,220))+'</div><small class="hint">'+escapeHtml(x.recommendation||'')+'</small></div>'}).join('');if(seen.length)html+='<h4>آخر المنشورات المرصودة</h4>'+seen.slice(0,20).map(function(x){return '<div style="padding:6px 0;border-bottom:1px solid var(--line)"><a target="_blank" rel="noopener noreferrer" href="'+escapeHtml('https://bsky.app/profile/'+encodeURIComponent(x.handle||'')+'/post/'+encodeURIComponent(String(x.uri||'').split('/').pop()))+'">'+escapeHtml(x.handle||x.uri||'منشور')+'</a><small class="hint"> · '+escapeHtml(x.query||'')+'</small></div>'}).join('');box.innerHTML=html}catch(e){box.textContent='تعذر تحميل السجل: '+(e.message||'خطأ غير معروف')}}
async function discoveryProfile(){var actor=String($('discoveryActor').value||'').trim();if(!actor){var q=String($('discoveryQuery').value||'').trim();if(q.indexOf('.')>-1||q.indexOf('did:')===0)actor=q}if(!actor){discoverySetStatus('أدخل handle في خانة فحص الحساب.',false);return}var box=$('discoveryProfileResult');box.textContent='جارٍ جلب الملف العام…';try{var r=await apiGet('/api/discovery/profile?actor='+encodeURIComponent(actor));var d=await discoveryJson(r);var p=d.profile||d;box.innerHTML='<div style="border:1px solid var(--line);border-radius:12px;padding:12px"><b>'+escapeHtml(p.displayName||p.handle||actor)+'</b><div class="hint">@'+escapeHtml(p.handle||actor)+'</div><p>'+escapeHtml(p.description||'لا يوجد وصف عام.')+'</p><div class="row"><span class="pill">متابعون: '+Number(p.followersCount||0)+'</span><span class="pill">يتابع: '+Number(p.followsCount||0)+'</span><span class="pill">منشورات: '+Number(p.postsCount||0)+'</span></div><a target="_blank" rel="noopener noreferrer" href="'+escapeHtml('https://bsky.app/profile/'+encodeURIComponent(p.handle||actor))+'">فتح الملف على Bluesky</a></div>'}catch(e){box.textContent='تعذر جلب الملف: '+(e.message||'خطأ غير معروف')}}
function $(id){return document.getElementById(id)}
function switchSystemTab(name){var allowed=['image','text','video'];if(allowed.indexOf(name)<0)name='image';document.querySelectorAll('[data-system-panel]').forEach(function(panel){panel.style.display=panel.getAttribute('data-system-panel')===name?'':'none';});document.querySelectorAll('[data-system-tab]').forEach(function(tab){var active=tab.getAttribute('data-system-tab')===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',active?'true':'false');});try{localStorage.setItem('bsky_system_tab',name);}catch(e){}}
function restoreSystemTab(){var name='image';try{var saved=localStorage.getItem('bsky_system_tab');if(saved)name=saved;}catch(e){}switchSystemTab(name);}
function restorePreviewPanel(panelId,buttonId,key){var panel=$(panelId),button=$(buttonId);if(!panel||!button)return;var close=false;try{close=localStorage.getItem('bsky_preview_'+key)==='closed'}catch(e){}panel.style.display=close?'none':'';button.innerText=close?'إظهار المعاينة':'إخفاء المعاينة';}
function toggleTextQueuePreviews(){var list=$('textQueueList'),button=$('textLinksPreviewToggle');if(!list||!button)return;var close=!list.classList.contains('hide-link-previews');list.classList.toggle('hide-link-previews',close);button.innerText=close?'إظهار المعاينات':'إخفاء المعاينات';try{localStorage.setItem('bsky_preview_text-links',close?'closed':'open')}catch(e){}}
function restoreTextQueuePreviews(){var list=$('textQueueList'),button=$('textLinksPreviewToggle');if(!list||!button)return;var close=false;try{close=localStorage.getItem('bsky_preview_text-links')==='closed'}catch(e){}list.classList.toggle('hide-link-previews',close);button.innerText=close?'إظهار المعاينات':'إخفاء المعاينات';}

function clientScheduleKey(prefix,name){var root=prefix==='image'?'schedule':prefix+'Schedule';return root+String(name||'').charAt(0).toUpperCase()+String(name||'').slice(1);}
function clientScheduleId(prefix,name){return clientScheduleKey(prefix,name);}
function clientStrategyKey(prefix){return prefix==='image'?'postingStrategy':prefix+'PostingStrategy';}
function clientTimingId(prefix){return prefix==='image'?'postMode':prefix+'PostMode';}
function clientStrategyMode(a,prefix){var saved=String(a[clientStrategyKey(prefix)]||'');if(saved==='random'||saved==='gradual')return saved;var schedule=String(a[clientScheduleKey(prefix,'mode')]||'fixed');return schedule==='ramp'||schedule==='custom'?'gradual':'random';}
function updatePostingStrategyUI(a,prefix){if(!a)return;var active=clientStrategyMode(a,prefix),random=$(clientScheduleId(prefix,'strategyRandom')),gradual=$(clientScheduleId(prefix,'strategyGradual')),status=$(clientScheduleId(prefix,'strategyStatus'));if(random){random.className='strategy-btn '+(active==='random'?'active random':'muted');random.setAttribute('aria-pressed',active==='random'?'true':'false');}if(gradual){gradual.className='strategy-btn '+(active==='gradual'?'active gradual':'muted');gradual.setAttribute('aria-pressed',active==='gradual'?'true':'false');}if(status)status.innerText=active==='random'?'العدد الثابت مفعّل • التدرج مكتوم • التوقيت من القائمة':'العدد المتدرج مفعّل • الثبات مكتوم • التوقيت من القائمة';}
function selectPostingStrategy(prefix,mode){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex],current=clientStrategyMode(a,prefix),requested=mode==='gradual'?'gradual':'random',active=requested===current?(current==='random'?'gradual':'random'):requested;a[clientStrategyKey(prefix)]=active;var schedule=$(clientScheduleId(prefix,'mode'));if(active==='random'){a[clientScheduleKey(prefix,'mode')]='fixed';if(schedule)schedule.value='fixed';}else{a[clientScheduleKey(prefix,'mode')]='ramp';if(schedule)schedule.value='ramp';}upd();updatePostingStrategyUI(a,prefix);}
function clientScheduleClamp(value,min,max,fallback){var n=parseInt(value,10);if(!isFinite(n))return fallback;return Math.max(min,Math.min(max,n));}
function clientCairoToday(){try{var p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),m={};p.forEach(function(x){m[x.type]=x.value});return m.year+'-'+m.month+'-'+m.day;}catch(e){return new Date().toISOString().slice(0,10);}}
function clientDateOrdinal(value){var p=String(value||'').split('-').map(Number);if(p.length!==3||p.some(function(x){return !isFinite(x)}))return null;return Date.UTC(p[0],p[1]-1,p[2]);}
function clientScheduleDay(a,prefix){var basis=String(a[clientScheduleKey(prefix,'dayBasis')]||'activation');var today=clientCairoToday();if(basis==='month')return Math.max(1,Math.min(31,parseInt(today.slice(8,10),10)||1));var start=clientDateOrdinal(a[clientScheduleKey(prefix,'startDate')]||today),cur=clientDateOrdinal(today);if(start===null||cur===null)return 1;return Math.max(1,Math.floor((cur-start)/86400000)+1);}
function clientCustomSchedule(raw){var map={};String(raw||'').replace(/،/g,',').replace(/;/g,',').split(String.fromCharCode(10)).join(',').split(',').forEach(function(part){var bits=part.trim().split(/[:=：-]/);if(bits.length<2)return;var day=clientScheduleClamp(bits[0],1,31,0),count=clientScheduleClamp(bits[1],1,50,0);if(day&&count)map[day]=count;});return map;}
function clientScheduleLimitForDay(a,prefix,day){var base=clientScheduleClamp(a[prefix==='image'?'dailyLimit':prefix+'DailyLimit'],1,50,12);var strategy=clientStrategyMode(a,prefix);var mode=String(a[clientScheduleKey(prefix,'mode')]||'fixed');if(strategy==='random'||mode==='fixed')return base;var start=clientScheduleClamp(a[clientScheduleKey(prefix,'startCount')],1,50,1),step=clientScheduleClamp(a[clientScheduleKey(prefix,'step')],0,50,1),max=clientScheduleClamp(a[clientScheduleKey(prefix,'max')],1,50,50),value=start; if(mode==='custom'){var map=clientCustomSchedule(a[clientScheduleKey(prefix,'custom')]),keys=Object.keys(map).map(Number).filter(function(k){return isFinite(k)&&k<=day}).sort(function(x,y){return x-y});if(map[day]!==undefined)value=map[day];else if(keys.length)value=map[keys[keys.length-1]];}else{var hold=clientScheduleClamp(a[clientScheduleKey(prefix,'holdAfterDay')],0,31,0),holdCount=clientScheduleClamp(a[clientScheduleKey(prefix,'holdCount')],1,50,1);value=hold>0&&day>=hold?holdCount:start+((day-1)*step);}return Math.max(1,Math.min(50,Math.min(max,value)));}
function clientScheduleDescription(a,prefix){var strategy=clientStrategyMode(a,prefix),mode=String(a[clientScheduleKey(prefix,'mode')]||'fixed'),day=clientScheduleDay(a,prefix),limit=clientScheduleLimitForDay(a,prefix,day),timing=$(clientTimingId(prefix)),timingText=timing&&timing.value==='regular'?'منتظم':'عشوائي';if(strategy==='random')return 'الخطة العشوائية مفعلة • الحد الثابت: '+limit+' منشور/يوم • التوقيت: '+timingText;if(mode==='fixed')return 'الخطة التدريجية مفعلة لكن العدد ثابت • الحد اليومي: '+limit+' منشور/يوم • التوقيت: '+timingText;var name=mode==='ramp'?'تدريجي':'تخصيص يومي';return name+' • اليوم '+day+': '+limit+' منشور/يوم • التوقيت: '+timingText+' • الأيام التالية: '+[day,day+1,day+2].map(function(d){return clientScheduleLimitForDay(a,prefix,d)}).join(' → ')+' • السقف: '+clientScheduleClamp(a[clientScheduleKey(prefix,'max')],1,50,50);}
function updateScheduleVisibility(prefix){var modeEl=$(clientScheduleId(prefix,'mode'));if(!modeEl)return;var mode=modeEl.value,ramp=$(clientScheduleId(prefix,'rampFields')),custom=$(clientScheduleId(prefix,'customFields'));if(ramp)ramp.style.display=mode==='ramp'?'grid':'none';if(custom)custom.style.display=mode==='custom'?'block':'none';}
function refreshScheduleUI(a,prefix){if(!a)return;updateScheduleVisibility(prefix);var help=$(clientScheduleId(prefix,'help'));if(help)help.innerText=clientScheduleDescription(a,prefix);var box=$(prefix==='image'?'smartBox':prefix==='text'?'smartBoxText':'smartBoxVideo');if(box){var base=box.innerText||'';box.innerText=clientScheduleDescription(a,prefix)+(base&&base.indexOf('الوضع:')===0?' • '+base:'');}updatePostingStrategyUI(a,prefix);}
function fillScheduleControls(a,prefix){if(!a)return;var defaults={mode:'fixed',dayBasis:'activation',startCount:1,step:1,holdAfterDay:0,holdCount:1,max:50,custom:'',startDate:''};Object.keys(defaults).forEach(function(name){var el=$(clientScheduleId(prefix,name));if(el)el.value=String(a[clientScheduleKey(prefix,name)]!==undefined&&a[clientScheduleKey(prefix,name)]!==null?a[clientScheduleKey(prefix,name)]:defaults[name]);});refreshScheduleUI(a,prefix);}
function readScheduleControls(a,prefix){if(!a)return;var today=clientCairoToday(),read=function(name){var el=$(clientScheduleId(prefix,name));return el?el.value:''};a[clientScheduleKey(prefix,'mode')]=['fixed','ramp','custom'].indexOf(read('mode'))>-1?read('mode'):'fixed';a[clientScheduleKey(prefix,'dayBasis')]=read('dayBasis')==='month'?'month':'activation';a[clientScheduleKey(prefix,'startCount')]=clientScheduleClamp(read('startCount'),1,50,1);a[clientScheduleKey(prefix,'step')]=clientScheduleClamp(read('step'),0,50,1);a[clientScheduleKey(prefix,'holdAfterDay')]=clientScheduleClamp(read('holdAfterDay'),0,31,0);a[clientScheduleKey(prefix,'holdCount')]=clientScheduleClamp(read('holdCount'),1,50,1);a[clientScheduleKey(prefix,'max')]=clientScheduleClamp(read('max'),1,50,50);a[clientScheduleKey(prefix,'custom')]=read('custom');if(a[clientScheduleKey(prefix,'dayBasis')]==='activation'&&!a[clientScheduleKey(prefix,'startDate')])a[clientScheduleKey(prefix,'startDate')]=today;a[clientStrategyKey(prefix)]=(a[clientScheduleKey(prefix,'mode')]==='ramp'||a[clientScheduleKey(prefix,'mode')]==='custom')?'gradual':'random';refreshScheduleUI(a,prefix);}
function onScheduleModeChange(prefix){updateScheduleVisibility(prefix);upd();}
function resetScheduleStart(prefix){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];a[clientScheduleKey(prefix,'startDate')]=clientCairoToday();fillScheduleControls(a,prefix);upd();saveConfig();}

function fillNums(){
  var hoursOpt = '';
  for(var h=1; h<=12; h++) {
    var val = h < 10 ? '0' + h : '' + h;
    hoursOpt += '<option value="'+val+'">الساعة '+val+'</option>';
  }
  $('startHour').innerHTML = hoursOpt;
  $('endHour').innerHTML = hoursOpt;

  var dl=$('dailyLimit'), s2='';
  for(var i=1;i<=50;i++) s2+='<option value="'+i+'">'+i+' / يوم</option>';
  dl.innerHTML=s2;

  var tc=$('tagsCount'), s3='';
  for(var k=1;k<=30;k++) s3+='<option value="'+k+'">'+k+' هاشتاج</option>';
  tc.innerHTML=s3;
}

async function loadData(){try{var r=await apiGet('/api/data');currentData=await r.json();$('sAcc').innerText=currentData.stats.accounts||0;$('sOn').innerText=currentData.stats.enabled||0;$('sQ').innerText=currentData.stats.totalQueued||0;$('sToday').innerText=currentData.stats.publishedToday||0;try{var sh=localStorage.getItem('bsky_selected');if(sh){var fi=(currentData.accounts||[]).findIndex(function(x){return x.handle===sh});if(fi>-1)selectedAccountIndex=fi;}}catch(e){}renderAccounts();renderLogs();if(currentData.accounts.length&&(selectedAccountIndex===null||!currentData.accounts[selectedAccountIndex]))selectAccount(0);else if(selectedAccountIndex!==null){fillEditor();updateTopForSelected();}checkAll();}catch(e){console.error(e)}}
async function checkAccount(i){try{var r=await apiPost('/api/check-account',{index:i});var d=await r.json();accountStates[i]=d.online===true;renderAccounts();}catch(e){accountStates[i]=false;renderAccounts();}}
function checkAll(){(currentData.accounts||[]).forEach(function(a,i){checkAccount(i)});}
function renderAccounts(){var c=$('accountsList');c.innerHTML=(currentData.accounts||[]).map(function(a,i){var active=i===selectedAccountIndex?'active':'';var on=a.postingEnabled;var st=accountStates[i];var dot=st===false?'off':'on';var q=a.queue?a.queue.length:0;var pt=Number(a.postedToday||0);var imgLimit=clientScheduleLimitForDay(a,'image',clientScheduleDay(a,'image'));var txtLimit=clientScheduleLimitForDay(a,'text',clientScheduleDay(a,'text'));var vidLimit=clientScheduleLimitForDay(a,'video',clientScheduleDay(a,'video'));return '<div class="acct '+active+'" onclick="selectAccount('+i+')"><div><span class="dot '+dot+'"></span><span class="h">'+escapeHtml(a.handle)+'</span> <small class="hint">(صور '+q+' • اليوم '+pt+'/'+imgLimit+' • نص '+Number(a.textPostedToday||0)+'/'+txtLimit+' • فيديو '+Number(a.videoPostedToday||0)+'/'+vidLimit+')</small>'+(a.lastError?'<div><small style="color:#fca5a5">'+escapeHtml(a.lastError)+'</small></div>':'')+'</div><div class="row"><button class="mini red" onclick="event.stopPropagation();removeAccount('+i+')">حذف</button></div></div>'}).join('')||'<p class="hint">لا يوجد حسابات بعد.</p>';}
function renderLogs(){var el=$('logs');if(!el)return;var all=Array.isArray(currentData.logs)?currentData.logs:[];var accountSelect=$('logFilterAccount');if(accountSelect){var previous=accountSelect.value;var handles=Array.from(new Set(all.map(function(l){return String(l.handle||'').trim()}).filter(Boolean))).sort();var options='<option value="">كل الحسابات</option>'+handles.map(function(h){return '<option value="'+escapeHtml(h)+'">'+escapeHtml(h)+'</option>'}).join('');if(accountSelect.innerHTML!==options)accountSelect.innerHTML=options;if(handles.indexOf(previous)>-1)accountSelect.value=previous;}
var af=accountSelect?accountSelect.value:'',tf=$('logFilterType')?$('logFilterType').value:'',sf=$('logFilterStatus')?$('logFilterStatus').value:'',q=String($('logFilterSearch')&&$('logFilterSearch').value||'').trim().toLowerCase();
var L=all.filter(function(l){var type=String(l.type||'').toLowerCase(),kind=String(l.kind||'').toLowerCase();if(af&&String(l.handle||'')!==af)return false;if(tf==='system'&&type!=='system'&&kind.indexOf('cron')!==0)return false;if(tf&&tf!=='system'&&type!==tf)return false;if(sf==='success'&&!l.success)return false;if(sf==='failed'&&l.success)return false;if(q&&[l.handle,l.url,l.link,l.text,l.error,l.kind,l.type].join(' ').toLowerCase().indexOf(q)<0)return false;return true;});
var health=$('logHealth');if(health){var cron=all.filter(function(l){return String(l.kind||'').indexOf('cron')===0&&!l.success}),failed=all.filter(function(l){return l.success===false});health.innerHTML=cron.length?'<b style="color:#fca5a5">⚠ أخطاء Cron مسجلة: '+cron.length+'</b><div class="hint">آخر خطأ: '+escapeHtml(String(cron[0].error||'خطأ غير محدد'))+'</div>':'<b style="color:#4ade80">✓ لا توجد أخطاء Cron مسجلة في السجل الحالي</b><div class="hint">إجمالي العمليات الفاشلة المحفوظة: '+failed.length+' — عدم وجود أخطاء هنا لا يثبت أن Trigger الخارجي يعمل.</div>';}
if(!L.length){el.innerHTML='<p class="hint">لا توجد عمليات تطابق الفلاتر الحالية.</p>';return;}el.innerHTML='<p class="hint">عرض '+Math.min(L.length,50)+' من '+L.length+' نتيجة مطابقة.</p><div style="overflow:auto"><table><tr><th>الوقت</th><th>الحساب</th><th>النظام</th><th>الحالة</th><th>التفاصيل</th></tr>'+L.slice(0,50).map(function(l){var d=new Date(l.time).toLocaleString('ar');var pill=l.success?'<span class="pill ok">ناجح</span>':'<span class="pill bad">فاشل</span>';var type=String(l.type||l.kind||'—');var detail=l.link?'<a href="'+escapeHtml(l.link)+'" target="_blank" rel="noopener noreferrer">فتح المنشور</a>':(l.error?escapeHtml(l.error):(l.url?'<a href="'+escapeHtml(l.url)+'" target="_blank" rel="noopener noreferrer">فتح المصدر</a>':escapeHtml(String(l.text||'—').slice(0,160))));return '<tr><td>'+d+'</td><td>'+escapeHtml(l.handle||'')+'</td><td>'+escapeHtml(type)+'</td><td>'+pill+'</td><td style="overflow-wrap:anywhere">'+detail+'</td></tr>'}).join('')+'</table></div>';}
function selectAccount(i){selectedAccountIndex=i;try{var _h=currentData.accounts[i]&&currentData.accounts[i].handle;if(_h)localStorage.setItem('bsky_selected',_h)}catch(e){}fillEditor();renderAccounts();updateTopForSelected();}
function updateTopForSelected(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;$('sQ').innerText=(a.queue?a.queue.length:0)+(a.textQueue?a.textQueue.length:0)+(a.videoQueue?a.videoQueue.length:0);$('sToday').innerText=Number(a.postedToday||0)+Number(a.textPostedToday||0)+Number(a.videoPostedToday||0);$('sOn').innerText=currentData.stats.enabled||0;}catch(e){}}
function fillEditor(){var a=currentData.accounts[selectedAccountIndex];if(!a)return;$('bulkUrls').value=(a.queue||[]).map(function(x){return x.urls?x.urls.join(' | '):x.url}).join('\\n');$('postTitle').value=(a.queue||[]).map(function(x){return x.title||''}).join('\\n');$('postTags').value=a.globalTags||'';$('tagsCount').value=a.randomTagsCount||'1';$('postMode').value=a.postMode||'random';$('intervalMinutes').value=String(a.intervalMinutes||15);$('dailyLimit').value=String(a.dailyLimit||12);$('startHour').value=String(a.startHour||'07');$('startAmPm').value=String(a.startAmPm||'PM');$('endHour').value=String(a.endHour||'01');$('endAmPm').value=String(a.endAmPm||'AM');$('multiPerPost').value=String(a.multiPerPost||1);$('altText').value=a.altText||'';updatePreview();renderQueue();}
function upd(){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];var urls=$('bulkUrls').value.split('\\n').map(function(x){return x.trim()}).filter(Boolean);var titles=$('postTitle').value.split('\\n');var tags=$('postTags').value;a.globalTags=tags;a.randomTagsCount=$('tagsCount').value;a.postMode=$('postMode').value;a.intervalMinutes=Math.max(1, Math.min(120, parseInt($('intervalMinutes').value, 10) || 15));a.dailyLimit=parseInt($('dailyLimit').value,10)||12;a.startHour=$('startHour').value;a.startAmPm=$('startAmPm').value;a.endHour=$('endHour').value;a.endAmPm=$('endAmPm').value;a.multiPerPost=parseInt($('multiPerPost').value,10)||1;a.altText=$('altText').value;a.queue=urls.map(function(u,i){var parts=u.split('|').map(function(s){return s.trim()}).filter(Boolean);var obj={url:parts[0],title:(titles[i]||'').trim(),tags:tags,randomTagsCount:a.randomTagsCount,alt:''};if(parts.length>1)obj.urls=parts.slice(0,a.multiPerPost);return obj;});updatePreview();renderQueue();
var modeText=a.postMode==='regular'?'منتظم':'نافذة نشاط ذكية (بتذبذب جذري يومي)';var next=a.nextPostAt&&a.nextPostAt>Date.now()?new Date(a.nextPostAt).toLocaleString('ar'):'جاهز داخل النافذة';$('smartBox').innerText='الوضع: '+modeText+' • الإطار المختار: من '+a.startHour+' '+a.startAmPm+' إلى '+a.endHour+' '+a.endAmPm+' • القادم: '+next;}
function updatePreview(){var a=currentData.accounts[selectedAccountIndex];if(!a)return;$('pvHandle').innerText=a.handle||'—';$('pvAv').innerText=(a.handle||'B')[0].toUpperCase();var t=($('postTitle').value.split('\\n')[0]||'').trim();var tags=($('postTags').value.split(/\\s+/).filter(function(x){return x.startsWith('#')}).slice(0,parseInt($('tagsCount').value||'1',10))).join(' ');$('pvText').innerHTML=escapeHtml(t+(t&&tags?'\\n':'')+tags).replace(/#(\\S+)/g,'<span class="ptags">#$1</span>');var u=$('bulkUrls').value.split('\\n').map(function(x){return x.trim()}).filter(Boolean)[0];if(u){var first=u.split('|')[0].trim();$('pvImg').style.display='block';$('pvImg').src=first;}else $('pvImg').style.display='none';
$('urlCounter').innerText=$('bulkUrls').value.split('\\n').filter(function(x){return x.trim()}).length;$('titleCounter').innerText=$('postTitle').value.split('\\n').filter(function(x){return x.trim()}).length;$('tagCounter').innerText=$('postTags').value.split(/\\s+/).filter(function(x){return x&&x.startsWith('#')}).length;}
function renderQueue(){var a=currentData.accounts[selectedAccountIndex];if(!a)return;var q=a.queue||[];$('queueList').innerHTML=q.slice(0,12).map(function(x,i){var img=(x.urls&&x.urls[0])||x.url;return '<div class="qitem"><img loading="lazy" src="'+escapeHtml(img)+'" onerror="this.style.opacity=.3"><div class="t"><b>'+escapeHtml(x.title||'(بدون عنوان)')+'</b><small>'+escapeHtml((img||'').slice(0,60))+'</small></div><button class="mini red" onclick="delQ('+i+')">X</button><button class="mini ghost" onclick="upQ('+i+')">رفع</button></div>'}).join('')+(q.length>12?'<p class="hint">+ '+(q.length-12)+' عناصر أخرى...</p>':'');}
function updateTextPreview(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;$('pvHandle2').innerText=a.handle||'—';var tt=(($('bulkTextTitles').value.split('\\n')[0]||'').trim());var ll=(($('bulkTextLinks').value.split('\\n')[0]||'').trim());var tg=(($('bulkTextTags').value.split(/\\s+/).filter(function(x){return x.startsWith('#')}).slice(0,parseInt($('textTagsCount').value||'1',10))).join(' '));var parts=[tt,ll,tg].filter(Boolean);var txt=parts.join('\\n')||'(فاضي — اكتب عنوان أو رابط أو هاشتاج)';$('pvText2').innerHTML=escapeHtml(txt).replace(/#(\\S+)/g,'<span class="ptags">#$1</span>');$('urlCounterT').innerText=$('bulkTextLinks').value.split('\\n').filter(function(x){return x.trim()}).length;$('titleCounterT').innerText=$('bulkTextTitles').value.split('\\n').filter(function(x){return x.trim()}).length;$('tagCounterT').innerText=$('bulkTextTags').value.split(/\\s+/).filter(function(x){return x&&x.startsWith('#')}).length;}catch(e){}}
function renderTextQueue(){var a=currentData.accounts[selectedAccountIndex];if(!a)return;var q=a.textQueue||[];$('textQueueList').innerHTML=q.slice(0,12).map(function(x,i){var lbl=(x.title||'(بدون عنوان)').slice(0,40);var lnk=(x.link||'(بدون رابط)').slice(0,50);return '<div class="qitem"><div class="t"><b>📝 '+escapeHtml(lbl)+'</b><small>'+escapeHtml(lnk)+'</small></div><button class="mini red" onclick="delTQ('+i+')">X</button><button class="mini ghost" onclick="upTQ('+i+')">رفع</button></div>'}).join('')+(q.length>12?'<p class="hint">+ '+(q.length-12)+' عناصر أخرى...</p>':'')||'<p class="hint">طابور النص فاضي.</p>';}
function delTQ(i){currentData.accounts[selectedAccountIndex].textQueue.splice(i,1);fillEditor();upd();}
function upTQ(i){if(i===0)return;var q=currentData.accounts[selectedAccountIndex].textQueue;var tmp=q[i-1];q[i-1]=q[i];q[i]=tmp;fillEditor();upd();}
function updateTextToggleBtn(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;var b=$('textToggleBtn');if(!b)return;var on=a.textEnabled===true;b.innerText=on?'إيقاف النص ⏸':'تفعيل النص ▶';b.className=on?'green':'ghost';var h=$('textStateHint');if(h)h.innerText=on?('مفعل • اليوم '+Number(a.textPostedToday||0)+'/'+(a.textDailyLimit||12)):'متوقف';}catch(e){}}
async function toggleTextPosting(){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];await apiPost('/api/toggle',{index:selectedAccountIndex,enabled:!(a.textEnabled===true),target:'text'});await loadData();}
async function toggleTextPostingRow(i,st){await apiPost('/api/toggle',{index:i,enabled:st,target:'text'});await loadData();}
async function testTextPost(btn){btn=btn||document.activeElement;if(btn)btn.disabled=true;try{upd();await apiPost('/api/save',{accounts:currentData.accounts});var r=await apiPost('/api/test-text-post',{index:selectedAccountIndex});var d=await r.json();var s=$('statusText');if(s){s.style.color=d.success?'#4ade80':'#fca5a5';s.innerText=d.success?'تم نشر التجربة النصية بنجاح':'فشل: '+(d.error||'');}}catch(e){}finally{try{if(btn)btn.disabled=false;}catch(e){}setTimeout(loadData,1600);}}
function delQ(i){currentData.accounts[selectedAccountIndex].queue.splice(i,1);fillEditor();upd();}
function upQ(i){if(i===0)return;var q=currentData.accounts[selectedAccountIndex].queue;var tmp=q[i-1];q[i-1]=q[i];q[i]=tmp;fillEditor();upd();}
async function saveConfig(){upd();var s=$('status');s.style.color='#5aa2ff';s.innerText='جاري حفظ الإعدادات...';try{var r=await apiPost('/api/save',{accounts:currentData.accounts});var d=await r.json();if(d.success){s.style.color='#4ade80';s.innerText='تم حفظ إعدادات الأنظمة';loadData();}else{s.style.color='#fca5a5';s.innerText='خطأ: '+d.error}}catch(e){s.style.color='#fca5a5';s.innerText='فشل الاتصال'}}
async function togglePosting(i,st){await apiPost('/api/toggle',{index:i,enabled:st});await loadData();}
async function testPost(i,btn){btn.disabled=true;var old=btn.innerText;btn.innerText='...';try{upd();await apiPost('/api/save',{accounts:currentData.accounts});var r=await apiPost('/api/test-post',{index:i});var d=await r.json();$('status').style.color=d.success?'#4ade80':'#fca5a5';$('status').innerText=d.success?'تمت التجربة بنجاح':'فشل';btn.innerText=d.success?'تم':'خطأ';}catch(e){btn.innerText='خطأ';}setTimeout(function(){btn.innerText=old;btn.disabled=false;loadData();},1600);}
async function addAccount(btn){try{btn=btn||document.activeElement;if(btn&&btn.disabled)return;if(btn)btn.disabled=true;var s=$('status');var h=$('handle').value.replace(/\\s+/g, '').replace(/^@+/,'').toLowerCase().trim();if(h&&h.indexOf('.')===-1)h+='.bsky.social';var p=$('appPass').value.replace(/[\\r\\n\\t]+/g,'').trim();if(!h||!p){alert('اكتب اليوزر والباسورد');if(btn)btn.disabled=false;return;}if(s){s.style.color='#5aa2ff';s.innerText='جاري التحقق...';}var r=await apiPost('/api/add-account',{handle:h,password:p});var d=await r.json().catch(function(){return{error:'رد غير صالح'}});if(!r.ok||!d.success){if(s){s.style.color='#fca5a5';s.innerText='فشل الربط';}alert(d.error||'فشل الربط');if(btn)btn.disabled=false;return;}currentData.accounts.unshift(d.account);$('handle').value='';$('appPass').value='';selectAccount(0);await loadData();}catch(e){alert('فشل الاتصال');}finally{try{if(btn)btn.disabled=false;}catch(e){}}}
async function removeAccount(i){if(!confirm('حذف الحساب؟'))return;await apiPost('/api/delete-account',{index:i});currentData.accounts.splice(i,1);selectedAccountIndex=null;renderAccounts();loadData();}
async function runNow(){var s=$('status');try{upd();s.style.color='#5aa2ff';s.innerText='جاري النشر...';await apiPost('/api/save',{accounts:currentData.accounts});var r=await apiPost('/api/run-now',{});var d=await r.json();if(d.success){s.style.color='#4ade80';s.innerText='تم النشر بنجاح: '+(d.published||0);}else{s.style.color='#fca5a5';s.innerText='خطأ';}}catch(e){s.style.color='#fca5a5';s.innerText='فشل الاتصال';}setTimeout(loadData,2500);}
async function resetAll(){if(!confirm('متأكد؟'))return;var r=await apiPost('/api/reset-all',{});if((await r.json()).success){selectedAccountIndex=null;loadData();}}
async function clearLogs(){if(!confirm('هل تريد مسح السجل بالكامل؟'))return;try{var r=await apiPost('/api/clear-logs',{});var d=await r.json();if(d.success){loadData();}else{alert('خطأ: '+(d.error||''));}}catch(e){alert('فشل الاتصال');}
}

/* ===== نص: إضافات آمنة لا تمس كود الصور ===== */
function fillTextNums(){try{
  var hoursOpt='';for(var h=1;h<=12;h++){var v=h<10?'0'+h:''+h;hoursOpt+='<option value="'+v+'">الساعة '+v+'</option>';}
  if($('textStartHour'))$('textStartHour').innerHTML=hoursOpt;
  if($('textEndHour'))$('textEndHour').innerHTML=hoursOpt;
  if($('textDailyLimit')){var s='';for(var i=1;i<=50;i++)s+='<option value="'+i+'">'+i+' / يوم</option>';$('textDailyLimit').innerHTML=s;}
  if($('textTagsCount')){var s2='';for(var k=1;k<=30;k++)s2+='<option value="'+k+'">'+k+' هاشتاج</option>';$('textTagsCount').innerHTML=s2;}
}catch(e){console.error('fillText',e)}}
function fillTextEditor(){try{
  var a=currentData.accounts[selectedAccountIndex];if(!a)return;
  if($('textStartHour'))$('textStartHour').value=String(a.textStartHour||a.startHour||'07');
  if($('textStartAmPm'))$('textStartAmPm').value=String(a.textStartAmPm||a.startAmPm||'PM');
  if($('textEndHour'))$('textEndHour').value=String(a.textEndHour||a.endHour||'01');
  if($('textEndAmPm'))$('textEndAmPm').value=String(a.textEndAmPm||a.endAmPm||'AM');
  if($('textPostMode'))$('textPostMode').value=a.textPostMode||'random';
  if($('textIntervalMinutes'))$('textIntervalMinutes').value=String(a.textIntervalMinutes||15);
  if($('textDailyLimit'))$('textDailyLimit').value=String(a.textDailyLimit||12);
  if($('textTagsCount'))$('textTagsCount').value=a.textRandomTagsCount||'1';
  if($('bulkTextTags'))$('bulkTextTags').value=a.textGlobalTags||'';
  if($('bulkTextLinks'))$('bulkTextLinks').value=(a.textQueue||[]).map(function(x){return x.link||''}).join('\\n');
  if($('bulkTextTitles'))$('bulkTextTitles').value=(a.textQueue||[]).map(function(x){return x.title||''}).join('\\n');
  fillScheduleControls(a,'text');
  updateTextPreview();renderTextQueue();updateTextToggleBtn();
}catch(e){console.error('fillTextEd',e)}}
function updText(){try{
  if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];if(!a)return;
  if(!$('bulkTextLinks')||!$('bulkTextTitles'))return;
  var tLinks=$('bulkTextLinks').value.split('\\n');var tTitles=$('bulkTextTitles').value.split('\\n');var tTags=$('bulkTextTags')?$('bulkTextTags').value:'';
  a.textGlobalTags=tTags;
  if($('textTagsCount'))a.textRandomTagsCount=$('textTagsCount').value;
  if($('textPostMode'))a.textPostMode=$('textPostMode').value;
  if($('textIntervalMinutes'))a.textIntervalMinutes=Math.max(1,Math.min(120,parseInt($('textIntervalMinutes').value,10)||15));
  if($('textDailyLimit'))a.textDailyLimit=parseInt($('textDailyLimit').value,10)||12;
  if($('textStartHour'))a.textStartHour=$('textStartHour').value;
  if($('textStartAmPm'))a.textStartAmPm=$('textStartAmPm').value;
  if($('textEndHour'))a.textEndHour=$('textEndHour').value;
  if($('textEndAmPm'))a.textEndAmPm=$('textEndAmPm').value;
  var rows=[];var n=Math.max(tLinks.length,tTitles.length);
  for(var ti=0;ti<n;ti++){var li=(tLinks[ti]||'').trim();var tt=(tTitles[ti]||'').trim();if(!li&&!tt)continue;rows.push({link:li,title:tt,tags:tTags,randomTagsCount:a.textRandomTagsCount});}
  if(!rows.length&&tTags.trim()){rows.push({link:'',title:'',tags:tTags,randomTagsCount:a.textRandomTagsCount});}
  a.textQueue=rows;
  var modeT=a.textPostMode==='regular'?'منتظم':'نافذة نص ذكية';
  var nextT=a.textNextPostAt&&a.textNextPostAt>Date.now()?new Date(a.textNextPostAt).toLocaleString('ar'):'جاهز داخل النافذة';
  updateTextPreview();renderTextQueue();updateTextToggleBtn();
}catch(e){console.error('updText',e)}}
var textLinkPreviewCache=Object.create(null),textLinkPreviewPending=Object.create(null),textLinkPreviewJobs=[],textLinkPreviewActive=0,textLinkPreviewSignature='',textLinkPreviewTimer=null;
function isTextPreviewHttp(value){try{var u=new URL(value);return u.protocol==='http:'||u.protocol==='https:'}catch(e){return false}}
function getTextPreviewHost(value){try{return new URL(value).hostname.replace(/^www\\./i,'')}catch(e){return ''}}
function runTextLinkPreviewJobs(){while(textLinkPreviewActive<3&&textLinkPreviewJobs.length){(function(link){textLinkPreviewActive++;apiGet('/api/link-preview?url='+encodeURIComponent(link)).then(function(r){if(!r.ok)throw new Error('preview failed');return r.json()}).then(function(d){textLinkPreviewCache[link]={input:link,target:d.target||link,hostname:d.hostname||getTextPreviewHost(link),title:d.title||'',description:d.description||'',imageUrl:d.imageUrl||''};}).catch(function(){textLinkPreviewCache[link]={input:link,target:link,hostname:getTextPreviewHost(link),title:'',description:'',imageUrl:'',failed:true};}).finally(function(){delete textLinkPreviewPending[link];textLinkPreviewActive--;runTextLinkPreviewJobs();renderTextQueue();});})(textLinkPreviewJobs.shift());}}
function renderTextLinkPreviews(){var el=$('textLinkPreviews');if(!el)return;var lines=$('bulkTextLinks')?$('bulkTextLinks').value.split('\\n'):[];var titleLines=$('bulkTextTitles')?$('bulkTextTitles').value.split('\\n'):[];var items=lines.map(function(x,i){return{link:(x||'').trim(),title:(titleLines[i]||'').trim()}}).filter(function(x){return x.link});if(!items.length){clearTimeout(textLinkPreviewTimer);textLinkPreviewTimer=null;textLinkPreviewSignature='';el.innerHTML='<p class="hint">الصق الروابط لعرض معاينة كل رابط هنا.</p>';return;}el.innerHTML=items.map(function(item,index){var link=item.link;var safe=isTextPreviewHttp(link);var data=textLinkPreviewCache[link];if(!data&&link===textPreviewCacheUrl&&textPreviewData)data=textPreviewData;var host=(data&&data.hostname)||getTextPreviewHost(link);var target=(data&&data.target)||link;var title=(data&&data.title)||item.title||host||'معاينة الرابط';var desc=data?(data.description||(data.failed?'تعذر جلب بيانات الصفحة.':(data.imageUrl?'الصورة متاحة لكن الموقع لم يوفّر وصفًا.':'الموقع لم يوفّر وصفًا أو صورة معاينة.'))):'جاري جلب بيانات الرابط...';var image='';if(data&&data.imageUrl&&isTextPreviewHttp(data.imageUrl))image=data.imageUrl;var media=image?'<img loading="lazy" src="'+escapeHtml(image)+'" alt="">':'<span>'+(data?(data.failed?'الصورة غير متاحة':(data.imageUrl?'صورة الرابط':'بدون صورة معاينة')):'جارٍ تحميل الصورة...')+'</span>';var content='<div class="text-link-preview-media">'+media+'</div><div class="text-link-preview-copy"><small>الرابط '+(index+1)+' • '+escapeHtml(host||'')+'</small><b>'+escapeHtml(title)+'</b><span class="text-link-preview-description">'+escapeHtml(desc)+'</span><span class="text-link-preview-url">'+escapeHtml(target)+'</span></div>';return safe?'<a class="text-link-preview-item" href="'+escapeHtml(target)+'" target="_blank" rel="noopener noreferrer">'+content+'</a>':'<div class="text-link-preview-item">'+content+'</div>';}).join('');var signature=items.map(function(item){return item.link}).join('\\n');if(signature!==textLinkPreviewSignature){textLinkPreviewSignature=signature;clearTimeout(textLinkPreviewTimer);textLinkPreviewTimer=setTimeout(function(){var first=(lines[0]||'').trim();items.forEach(function(item){var link=item.link;if(isTextPreviewHttp(link)&&!(link===first&&textPreviewCacheUrl===link)&&!textLinkPreviewCache[link]&&!textLinkPreviewPending[link]){textLinkPreviewPending[link]=true;textLinkPreviewJobs.push(link)}});runTextLinkPreviewJobs();},450);}}
var textPreviewCacheUrl='',textPreviewData=null,textPreviewTimer=null;
function updateTextPreview(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;if($('pvHandle2'))$('pvHandle2').innerText=a.handle||'—';
  var tt=(($('bulkTextTitles').value.split('\\n')[0]||'').trim());var ll=(($('bulkTextLinks').value.split('\\n')[0]||'').trim());
  var tg=(($('bulkTextTags').value.split(/\\s+/).filter(function(x){return x.startsWith('#')}).slice(0,parseInt(($('textTagsCount')&&$('textTagsCount').value)||'1',10))).join(' '));
  var validLink=false,host='';try{var parsed=new URL(ll);validLink=parsed.protocol==='http:'||parsed.protocol==='https:';if(validLink)host=parsed.hostname.replace(/^www\\./i,'');}catch(e){}
  var meta=textPreviewData&&textPreviewData.input===ll?textPreviewData:null;
  var bodyTitle=tt||(meta&&meta.title)||(validLink?'خبر جديد':'');var parts=validLink?[bodyTitle,tg].filter(Boolean):[tt,ll,tg].filter(Boolean);var txt=parts.join('\\n')||'(فاضي — اكتب عنوان أو رابط أو هاشتاج)';
  if($('pvText2'))$('pvText2').innerHTML=escapeHtml(txt).replace(/#(\\S+)/g,'<span class="ptags">#$1</span>');
  var card=$('pvLinkCard');if(card){if(validLink){card.style.display='block';var target=ll;card.href=ll;$('pvLinkHost').innerText=host;$('pvLinkTitle').innerText=(meta&&meta.title)||tt||host;$('pvLinkDesc').innerText=meta?(meta.description||'الموقع لم يوفّر وصفًا للرابط.'):'جاري جلب معاينة الرابط...';$('pvLinkUrl').innerText=ll;var im=$('pvLinkImage');if(meta&&meta.imageUrl){try{var imageUrl=new URL(meta.imageUrl);if(imageUrl.protocol==='http:'||imageUrl.protocol==='https:'){im.src=imageUrl.href;im.style.display='block';}else{im.removeAttribute('src');im.style.display='none';}}catch(e){im.removeAttribute('src');im.style.display='none';}}else{im.removeAttribute('src');im.style.display='none';}
    if(textPreviewCacheUrl!==ll){textPreviewCacheUrl=ll;textPreviewData=null;clearTimeout(textPreviewTimer);textPreviewTimer=setTimeout(function(){(async function(){try{var r=await apiGet('/api/link-preview?url='+encodeURIComponent(ll));if(!r.ok)return;var d=await r.json();var current=(($('bulkTextLinks').value.split('\\n')[0]||'').trim());if(current!==ll)return;textPreviewData={input:ll,target:d.target||ll,hostname:d.hostname||host,title:d.title||'',description:d.description||'',imageUrl:d.imageUrl||''};textLinkPreviewCache[ll]=textPreviewData;updateTextPreview();renderTextQueue();}catch(e){var failedCurrent=(($('bulkTextLinks').value.split('\\n')[0]||'').trim());if(failedCurrent===ll){textPreviewData={input:ll,target:ll,hostname:host,title:'',description:'',imageUrl:'',failed:true};textLinkPreviewCache[ll]=textPreviewData;updateTextPreview();renderTextQueue();}}})();},450);}
  }else{clearTimeout(textPreviewTimer);textPreviewCacheUrl='';textPreviewData=null;card.style.display='none';}}
  if($('urlCounterT'))$('urlCounterT').innerText=$('bulkTextLinks').value.split('\\n').filter(function(x){return x.trim()}).length;
  if($('titleCounterT'))$('titleCounterT').innerText=$('bulkTextTitles').value.split('\\n').filter(function(x){return x.trim()}).length;
  if($('tagCounterT'))$('tagCounterT').innerText=$('bulkTextTags').value.split(/\\s+/).filter(function(x){return x&&x.startsWith('#')}).length;
}catch(e){console.error('preview',e)}}
function renderTextQueue(){try{var a=currentData.accounts[selectedAccountIndex];var list=$('textQueueList');if(!a||!list)return;var q=a.textQueue||[];
  list.innerHTML=q.map(function(x,i){var link=String(x.link||x.url||'').trim();var valid=!!link&&isTextPreviewHttp(link);var data=valid?textLinkPreviewCache[link]:null;if(!data&&valid&&link===textPreviewCacheUrl&&textPreviewData)data=textPreviewData;var host=valid?getTextPreviewHost(link):'';var target=link;var caption=String(x.title||'').trim();var siteTitle=valid?((data&&data.title)||host||caption||'معاينة الرابط'):(caption||'منشور نصي');var description=valid?(data?(data.description||(data.failed?'تعذر جلب بيانات الرابط.':(data.imageUrl?'الموقع لم يوفّر وصفًا.':'الموقع لا يوفّر معاينة للرابط.'))):'جاري جلب معاينة الرابط...'):'هذا المنشور لا يحتوي على رابط.';var image=data&&data.imageUrl&&isTextPreviewHttp(data.imageUrl)?data.imageUrl:'';var media=image?'<img loading="lazy" src="'+escapeHtml(image)+'" alt="">':'<span>'+(valid?(data?(data.failed?'لا توجد معاينة للصورة':(data.imageUrl?'صورة الرابط':'بدون صورة معاينة')):'جارٍ تحميل المعاينة...'):'بدون رابط')+'</span>';var previewUrl=valid?'<a class="text-q-url" href="'+escapeHtml(target)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(target)+'</a>':(link?'<small class="text-q-url">'+escapeHtml(link)+'</small>':'<small class="text-q-url">بدون رابط</small>');var summary='<div class="text-q-summary"><b>📝 '+escapeHtml(caption||'(بدون عنوان)')+'</b><small>'+escapeHtml(link?link.slice(0,65):'منشور بدون رابط')+'</small></div>';var preview='<div class="text-q-preview"><div class="text-q-preview-media">'+media+'</div><div class="text-q-preview-copy"><small>'+escapeHtml(host||(valid?'معاينة الرابط':'منشور نصي'))+'</small><b>'+escapeHtml(siteTitle)+'</b><span class="text-q-description">'+escapeHtml(description)+'</span>'+previewUrl+'</div></div>';return '<div class="qitem text-qitem">'+summary+preview+'<div class="text-q-actions"><button class="mini red" title="حذف هذا البوست" onclick="delTQ('+i+')">X</button><button class="mini ghost" title="رفع في الطابور" onclick="upTQ('+i+')">رفع</button></div></div>'}).join('')||'<p class="hint">طابور النص فاضي.</p>';
  var links=[...new Set(q.map(function(x){return String(x.link||x.url||'').trim()}).filter(function(url){return isTextPreviewHttp(url)}))];var signature=links.join('\\n');if(signature!==textLinkPreviewSignature){textLinkPreviewSignature=signature;clearTimeout(textLinkPreviewTimer);if(!signature){textLinkPreviewTimer=null;}else{textLinkPreviewTimer=setTimeout(function(){var first=$('bulkTextLinks')?(($('bulkTextLinks').value.split('\\n')[0]||'').trim()):'';links.forEach(function(link){if(!(link===first&&textPreviewCacheUrl===link)&&!textLinkPreviewCache[link]&&!textLinkPreviewPending[link]){textLinkPreviewPending[link]=true;textLinkPreviewJobs.push(link)}});runTextLinkPreviewJobs();},450);}}
}catch(e){console.error('renderTextQueue',e)}}
function delTQ(i){try{currentData.accounts[selectedAccountIndex].textQueue.splice(i,1);var a=currentData.accounts[selectedAccountIndex];if($('bulkTextLinks'))$('bulkTextLinks').value=(a.textQueue||[]).map(function(x){return x.link||''}).join('\\n');if($('bulkTextTitles'))$('bulkTextTitles').value=(a.textQueue||[]).map(function(x){return x.title||''}).join('\\n');updText();renderTextQueue();updateTextPreview();}catch(e){}}
function upTQ(i){try{if(i===0)return;var q=currentData.accounts[selectedAccountIndex].textQueue;var tmp=q[i-1];q[i-1]=q[i];q[i]=tmp;var a=currentData.accounts[selectedAccountIndex];if($('bulkTextLinks'))$('bulkTextLinks').value=(a.textQueue||[]).map(function(x){return x.link||''}).join('\\n');if($('bulkTextTitles'))$('bulkTextTitles').value=(a.textQueue||[]).map(function(x){return x.title||''}).join('\\n');updText();renderTextQueue();updateTextPreview();}catch(e){}}
function updateTextToggleBtn(){try{var a=currentData.accounts[selectedAccountIndex];if(!a||!$('textToggleBtn'))return;var on=a.textEnabled===true;var b=$('textToggleBtn');b.innerText=on?'إيقاف النص ⏸':'تفعيل النص ▶';b.className=on?'green':'ghost';var h=$('textStateHint');var lim=clientScheduleLimitForDay(a,'text',clientScheduleDay(a,'text'));if(h)h.innerText=on?('مفعل • اليوم '+Number(a.textPostedToday||0)+'/'+lim):'متوقف';}catch(e){}}
async function toggleTextPosting(){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];await apiPost('/api/toggle',{index:selectedAccountIndex,enabled:!(a.textEnabled===true),target:'text'});await loadData();}
async function toggleTextPostingRow(i,st){await apiPost('/api/toggle',{index:i,enabled:st,target:'text'});await loadData();}
async function testTextPost(btn){btn=btn||document.activeElement;if(btn)btn.disabled=true;try{upd();updText();await apiPost('/api/save',{accounts:currentData.accounts});var r=await apiPost('/api/test-text-post',{index:selectedAccountIndex});var d=await r.json();var s=$('statusText');if(s){s.style.color=d.success?'#4ade80':'#fca5a5';s.innerText=d.success?'تم نشر التجربة النصية بنجاح':'فشل: '+(d.error||'');}}catch(e){}finally{try{if(btn)btn.disabled=false;}catch(e){}setTimeout(loadData,1600);}}
function getVideoTagsPreview(){return ($('bulkVideoTags').value.split(/\\s+/).filter(function(x){return x.startsWith('#')}).slice(0,parseInt($('videoTagsCount').value||'1',10))).join(' ');}
function updateImageToggleBtn(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;var b=$('imageToggleBtn');if(!b)return;var on=a.postingEnabled===true;b.innerText=on?'إيقاف الصور ⏸':'تفعيل الصور ▶';b.className=on?'green':'ghost';var h=$('imageStateHint');var lim=clientScheduleLimitForDay(a,'image',clientScheduleDay(a,'image'));if(h)h.innerText=on?('مفعل • اليوم '+Number(a.postedToday||0)+'/'+lim):'متوقف';}catch(e){}}
async function toggleImagePosting(){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];await apiPost('/api/toggle',{index:selectedAccountIndex,enabled:!(a.postingEnabled===true)});await loadData();}
function fillVideoNums(){try{var hours='',limits='',tags='';for(var h=1;h<=12;h++){var hv=h<10?'0'+h:''+h;hours+='<option value="'+hv+'">الساعة '+hv+'</option>';}for(var i=1;i<=50;i++)limits+='<option value="'+i+'">'+i+' / يوم</option>';for(var j=1;j<=30;j++)tags+='<option value="'+j+'">'+j+' هاشتاج</option>';if($('videoStartHour'))$('videoStartHour').innerHTML=hours;if($('videoEndHour'))$('videoEndHour').innerHTML=hours;if($('videoDailyLimit'))$('videoDailyLimit').innerHTML=limits;if($('videoTagsCount'))$('videoTagsCount').innerHTML=tags;}catch(e){console.error('fillVideoNums',e)}}
function fillVideoEditor(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;$('videoStartHour').value=String(a.videoStartHour||'07');$('videoStartAmPm').value=String(a.videoStartAmPm||'PM');$('videoEndHour').value=String(a.videoEndHour||'01');$('videoEndAmPm').value=String(a.videoEndAmPm||'AM');$('videoPostMode').value=a.videoPostMode||'random';$('videoIntervalMinutes').value=String(a.videoIntervalMinutes||15);$('videoDailyLimit').value=String(a.videoDailyLimit||12);$('videoTagsCount').value=a.videoRandomTagsCount||'1';$('bulkVideoUrls').value=(a.videoQueue||[]).map(function(x){return x.url||''}).join('\\n');$('bulkVideoTitles').value=(a.videoQueue||[]).map(function(x){return x.title||''}).join('\\n');$('bulkVideoTags').value=a.videoGlobalTags||'';fillScheduleControls(a,'video');updateVideoPreview();renderVideoQueue();updateVideoToggleBtn();}catch(e){console.error('fillVideoEditor',e)}}
function updateVideoPreview(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;var urls=$('bulkVideoUrls').value.split('\\n').map(function(x){return x.trim()}).filter(Boolean);var titles=$('bulkVideoTitles').value.split('\\n');var u=urls[0]||'';var title=(titles[0]||'').trim()||((typeof videoTitleCache!=='undefined'&&videoTitleCache[u]&&videoTitleCache[u].title)||'').trim();var tags=getVideoTagsPreview();var content=[title,tags].filter(Boolean).join('\\n')||'(فيديو)';$('pvHandle3').innerText=a.handle||'—';$('pvAv3').innerText=(a.handle||'V')[0].toUpperCase();$('pvVideoText').innerHTML=escapeHtml(content).replace(/#(\\S+)/g,'<span class="ptags">#$1</span>');$('urlCounterV').innerText=urls.length;$('titleCounterV').innerText=$('bulkVideoTitles').value.split('\\n').filter(function(x){return x.trim()}).length;$('tagCounterV').innerText=$('bulkVideoTags').value.split(/\\s+/).filter(function(x){return x&&x.startsWith('#')}).length;var video=$('pvVideo'),note=$('pvVideoNote');if(!u){clearTimeout(videoPreviewTimer);videoPreviewRequest='';videoPreviewResolved='';video.pause();video.removeAttribute('src');video.load();video.style.display='none';note.innerText='أدخل رابط MP4 أو صفحة فيديو لعرض المعاينة.';return;}if(videoPreviewRequest===u&&videoPreviewResolved){video.style.display='block';if(video.getAttribute('src')!==videoPreviewResolved){video.src=videoPreviewResolved;video.load();}note.innerText='معاينة الفيديو • '+(videoPreviewSize?Math.round(videoPreviewSize/1048576)+' MB':'الحجم غير معلن');return;}video.style.display='none';if(video.getAttribute('src')){video.pause();video.removeAttribute('src');video.load();}if(videoPreviewRequest!==u){videoPreviewRequest=u;videoPreviewResolved='';videoPreviewSize=0;clearTimeout(videoPreviewTimer);note.innerText='جارٍ فحص رابط الفيديو وتجهيز المعاينة...';videoPreviewTimer=setTimeout(function(){apiGet('/api/video-preview?url='+encodeURIComponent(u)).then(function(r){return r.json()}).then(function(d){if(videoPreviewRequest!==u)return;if(d.success){videoPreviewResolved=d.url||u;videoPreviewSize=Number(d.size||0);try{if(typeof videoTitleCache!=='undefined'){var _c=videoTitleCache[u]||{};if(d.pageTitle&&!_c.title)_c.title=String(d.pageTitle).slice(0,300);_c.direct=d.url||u;_c.size=Number(d.size||0);videoTitleCache[u]=_c;}}catch(e){}updateVideoPreview();try{renderVideoQueue();}catch(e){}}else{note.innerText=d.error||'تعذر عرض المعاينة؛ سيجري فحص الرابط مرة أخرى عند النشر.';}}).catch(function(){if(videoPreviewRequest===u)note.innerText='تعذر تحميل المعاينة الآن؛ سيجري فحص الرابط عند النشر.';});},600);}else if(!videoPreviewResolved){note.innerText='تعذر عرض المعاينة؛ تأكد من أن الفيديو متاح للعامة.';}}catch(e){console.error('videoPreview',e)}}
function renderVideoQueue(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;var q=a.videoQueue||[];var cnt=$('videoQueueCount');if(cnt)cnt.innerText=String(q.length);if(!q.length){$('videoQueueList').innerHTML='<p class="hint">طابور الفيديو فارغ.</p>';scheduleVideoTitleFetch();return;}$('videoQueueList').innerHTML='<p class="hint" style="margin:2px 0 6px">إجمالي الطابور: '+q.length+' فيديو — مرر بالسهم لرؤية الكل (رقم 1 هو الشغال حاليًا / التالي للنشر)</p>'+q.map(function(x,i){var info=(typeof videoTitleCache!=='undefined'&&videoTitleCache[x.url])||null;var manual=String(x.title||'').trim();var autoT=info&&info.title?String(info.title):'';var showTitle=manual||autoT||'(بدون عنوان)';var autoBadge=(!manual&&autoT)?'<span class="video-qbadge auto">عنوان تلقائي من الرابط</span>':'';var nowBadge=i===0?'<span class="video-qbadge now">▶ الشغال حاليًا / التالي</span>':('<span class="hint">#'+(i+1)+'</span>');var status=x.jobId?'<small style="color:#fbbf24">جارٍ المعالجة على Bluesky؛ سيُستكمل تلقائيًا</small>':'';var autoLine=autoT?'<small class="video-qautotitle">🏷️ عنوان الرابط: '+escapeHtml(autoT)+'</small>':((!manual)?'<small>جاري سحب عنوان الرابط...</small>':'');var direct=(info&&info.direct)||'';var playable=direct||(/\\.mp4(\\?|#|$)/i.test(x.url||'')?x.url:'');var media=playable?'<div class="qv-wrap"><button class="mini ghost" data-src="'+escapeHtml(playable)+'" onclick="toggleQVideo(this)">▶ معاينة (دوس للتشغيل - توفير باقة)</button><video class="qv" controls playsinline preload="none" style="display:none;width:100%"></video></div>':'';return '<div class="video-qitem" style="flex-wrap:wrap"><div class="video-qcopy"><b>🎬 '+escapeHtml(showTitle)+' '+nowBadge+'</b>'+autoBadge+'<small>'+escapeHtml(x.url||'')+'</small>'+autoLine+status+media+'</div><div class="video-qactions"><button class="mini red" title="حذف الفيديو" onclick="delVQ('+i+')">X</button><button class="mini ghost" title="رفع في الطابور" onclick="upVQ('+i+')">رفع</button></div></div>';}).join('');scheduleVideoTitleFetch();}catch(e){console.error('renderVideoQueue',e)}}
/* منظومة الفيديو فقط: سحب عناوين الروابط + الروابط المباشرة للمعاينة (لا يمس أي نظام آخر) */
var videoTitleCache=Object.create(null),videoTitlePending=Object.create(null),videoTitleQueue=[],videoTitleActive=0,videoTitleSig='',videoTitleTimer=null;
function runVideoTitleJobs(){while(videoTitleActive<3&&videoTitleQueue.length){(function(link){videoTitleActive++;apiGet('/api/video-preview?url='+encodeURIComponent(link)).then(function(r){return r.json()}).then(function(d){if(d&&d.success){videoTitleCache[link]={title:String((d.pageTitle||'')).slice(0,300),direct:d.url||'',size:Number(d.size||0)};}else{videoTitleCache[link]={title:'',direct:'',failed:true};}}).catch(function(){videoTitleCache[link]={title:'',direct:'',failed:true};}).finally(function(){delete videoTitlePending[link];videoTitleActive--;runVideoTitleJobs();try{renderVideoQueue();updateVideoPreview();}catch(e){}});})(videoTitleQueue.shift());}}
function scheduleVideoTitleFetch(){try{var a=currentData.accounts[selectedAccountIndex];if(!a||!a.videoQueue)return;var links=[];a.videoQueue.forEach(function(x){var u=String(x.url||'').trim();if(u&&!videoTitleCache[u]&&!videoTitlePending[u])links.push(u);});var sig=links.join('\\n');if(sig!==videoTitleSig){videoTitleSig=sig;clearTimeout(videoTitleTimer);if(!links.length){videoTitleTimer=null;}else{videoTitleTimer=setTimeout(function(){links.forEach(function(link){if(!videoTitleCache[link]&&!videoTitlePending[link]){videoTitlePending[link]=true;videoTitleQueue.push(link);}});runVideoTitleJobs();},450);}}}catch(e){}}
function fetchVideoTitlesIntoBoxes(btn){try{if(selectedAccountIndex===null)return;var urls=$('bulkVideoUrls').value.split('\\n');var titles=$('bulkVideoTitles').value.split('\\n');var changed=false;for(var i=0;i<urls.length;i++){var u=(urls[i]||'').trim();if(!u)continue;if((titles[i]||'').trim())continue;var info=videoTitleCache[u];if(info&&info.title){titles[i]=info.title;changed=true;}}if(changed){$('bulkVideoTitles').value=titles.join('\\n');upd();var s=$('statusVideo');if(s){s.style.color='#4ade80';s.innerText='تم ملء العناوين الفارغة من عناوين الروابط';}}else{var missing=urls.filter(function(u,idx){u=(u||'').trim();return u&&!(titles[idx]||'').trim()&&!(videoTitleCache[u]&&videoTitleCache[u].title)});var s2=$('statusVideo');if(s2){s2.style.color='#fbbf24';s2.innerText=missing.length?'جاري سحب العناوين... اضغط مجددًا بعد ثوانٍ':'لا توجد عناوين فارغة أو لا يوجد عنوان متاح على الروابط';}scheduleVideoTitleFetch();}}catch(e){}}
function toggleQVideo(btn){try{var wrap=btn.parentElement;var v=wrap.querySelector('video.qv');if(!v)return;if(v.style.display==='none'){var src=btn.getAttribute('data-src');if(src&&v.getAttribute('src')!==src){v.src=src;}v.style.display='block';try{v.load();}catch(e){}btn.innerText='⏸ إخفاء المعاينة (توفير باقة)';}else{try{v.pause();}catch(e){}v.style.display='none';btn.innerText='▶ معاينة (دوس للتشغيل - توفير باقة)';}}catch(e){}}
var videoPreviewRequest='',videoPreviewResolved='',videoPreviewSize=0,videoPreviewTimer=null;
function updVideo(){try{if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];if(!a)return;var urls=$('bulkVideoUrls').value.split('\\n').map(function(x){return x.trim()});var titles=$('bulkVideoTitles').value.split('\\n');a.videoGlobalTags=$('bulkVideoTags').value;a.videoRandomTagsCount=$('videoTagsCount').value;a.videoPostMode=$('videoPostMode').value;a.videoIntervalMinutes=Math.max(1,Math.min(120,parseInt($('videoIntervalMinutes').value,10)||15));a.videoDailyLimit=parseInt($('videoDailyLimit').value,10)||12;a.videoStartHour=$('videoStartHour').value;a.videoStartAmPm=$('videoStartAmPm').value;a.videoEndHour=$('videoEndHour').value;a.videoEndAmPm=$('videoEndAmPm').value;var old={};(a.videoQueue||[]).forEach(function(x){if(x.url)old[x.url]=x});a.videoQueue=urls.map(function(u,i){u=(u||'').trim();if(!u)return null;var prev=old[u]||{};return{url:u,title:(titles[i]||'').trim(),tags:a.videoGlobalTags,randomTagsCount:a.videoRandomTagsCount,jobId:prev.jobId||'',failCount:prev.failCount||0};}).filter(Boolean);var mode=a.videoPostMode==='regular'?'منتظم':'نافذة نشاط ذكية (بتذبذب يومي)';var next=a.videoNextPostAt&&a.videoNextPostAt>Date.now()?new Date(a.videoNextPostAt).toLocaleString('ar'):'جاهز داخل النافذة';$('smartBoxVideo').innerText='الوضع: '+mode+' • النافذة: من '+a.videoStartHour+' '+a.videoStartAmPm+' إلى '+a.videoEndHour+' '+a.videoEndAmPm+' • الفاصل: '+a.videoIntervalMinutes+' دقيقة • القادم: '+next;updateVideoPreview();renderVideoQueue();updateVideoToggleBtn();}catch(e){console.error('updVideo',e)}}
function delVQ(i){var a=currentData.accounts[selectedAccountIndex];if(!a)return;a.videoQueue.splice(i,1);$('bulkVideoUrls').value=a.videoQueue.map(function(x){return x.url||''}).join('\\n');$('bulkVideoTitles').value=a.videoQueue.map(function(x){return x.title||''}).join('\\n');upd();}
function upVQ(i){if(i<=0)return;var a=currentData.accounts[selectedAccountIndex];if(!a)return;var q=a.videoQueue;var tmp=q[i-1];q[i-1]=q[i];q[i]=tmp;$('bulkVideoUrls').value=q.map(function(x){return x.url||''}).join('\\n');$('bulkVideoTitles').value=q.map(function(x){return x.title||''}).join('\\n');upd();}
function updateVideoToggleBtn(){try{var a=currentData.accounts[selectedAccountIndex];if(!a)return;var b=$('videoToggleBtn');if(!b)return;var on=a.videoEnabled===true;b.innerText=on?'إيقاف الفيديو ⏸':'تفعيل الفيديو ▶';b.className=on?'green':'ghost';var h=$('videoStateHint');var lim=clientScheduleLimitForDay(a,'video',clientScheduleDay(a,'video'));if(h)h.innerText=on?('مفعل • اليوم '+Number(a.videoPostedToday||0)+'/'+lim+(a.videoLastError?' • '+a.videoLastError:'')):(a.videoLastError?'متوقف • '+a.videoLastError:'متوقف');}catch(e){}}
async function toggleVideoPosting(){if(selectedAccountIndex===null)return;var a=currentData.accounts[selectedAccountIndex];await apiPost('/api/toggle',{index:selectedAccountIndex,enabled:!(a.videoEnabled===true),target:'video'});await loadData();}
async function testVideoPost(btn){
  btn=btn||document.activeElement;
  if(btn&&btn.disabled)return;
  if(btn)btn.disabled=true;
  var status=$('statusVideo'),finished=false;
  function showVideoTest(message,color){if(status){status.style.color=color;status.innerText=message;}}
  try{
    if(selectedAccountIndex===null||!currentData.accounts[selectedAccountIndex])throw new Error('اختر حسابًا أولًا');
    upd();
    var save=await apiPost('/api/save',{accounts:currentData.accounts});
    if(!save.ok)throw new Error('تعذر حفظ الإعدادات');
    // Poll the existing job by reusing the same queue item/jobId; do not create a new upload.
    var maxChecks=18,waitMs=5000;
    for(var attempt=1;attempt<=maxChecks;attempt++){
      if(attempt===1)showVideoTest('جارٍ بدء تجربة الفيديو...', '#60a5fa');
      else showVideoTest('الفيديو قيد المعالجة على Bluesky؛ فحص تلقائي '+attempt+'/'+maxChecks+'...', '#fbbf24');
      var r=await apiPost('/api/test-video-post',{index:selectedAccountIndex});
      var d=await r.json().catch(function(){return {};});
      if(d.success){finished=true;showVideoTest('تم نشر الفيديو التجريبي بنجاح', '#4ade80');break;}
      if(!d.processing){finished=true;throw new Error(d.error||'تعذر النشر');}
      if(attempt<maxChecks)await new Promise(function(resolve){setTimeout(resolve,waitMs);});
    }
    if(!finished)showVideoTest('الفيديو ما زال قيد المعالجة. لم نبدأ رفعًا جديدًا؛ اضغط تجربة فيديو لاحقًا لإعادة فحص نفس المهمة.', '#fbbf24');
  }catch(e){showVideoTest('تعذر نشر الفيديو: '+(e.message||'فشل الاتصال'), '#fca5a5');}
  finally{try{if(btn)btn.disabled=false;}catch(e){}setTimeout(loadData,1800);}
}
/* تغليف آمن: نشغّل الأنظمة الحالية ونحدّث إعداد الفيديو داخل صندوقه فقط */
var __origFillNums=fillNums;fillNums=function(){try{__origFillNums();}catch(e){console.error(e)};fillTextNums();fillVideoNums();};
var __origFillEditor=fillEditor;fillEditor=function(){try{__origFillEditor();}catch(e){console.error('fill img',e)};var a=currentData.accounts[selectedAccountIndex];if(a)fillScheduleControls(a,'image');fillTextEditor();fillVideoEditor();updateImageToggleBtn();};
var __origUpd=upd;upd=function(){try{__origUpd();}catch(e){console.error('upd img',e)};updText();updVideo();var a=currentData.accounts[selectedAccountIndex];if(a){readScheduleControls(a,'image');readScheduleControls(a,'text');readScheduleControls(a,'video');}};
var __origRenderAccounts=renderAccounts;renderAccounts=function(){try{__origRenderAccounts();}catch(e){console.error(e)}};


/* ===== إصلاح تجمد زر الربط + رسائل واضحة ===== */
var __origAddAccount=addAccount;addAccount=function(btn){return (async function(){
  try{btn=btn||document.activeElement;if(btn&&btn.disabled)return;if(btn)btn.disabled=true;
    var s=document.getElementById('status');
    var hEl=document.getElementById('handle'),pEl=document.getElementById('appPass');
    var h=(hEl?hEl.value:'').replace(/\\s+/g,'').replace(/^@+/,'').toLowerCase().trim();
    if(h&&h.indexOf('.')===-1)h+='.bsky.social';
    var p=(pEl?pEl.value:'').replace(/[\\r\\n\\t]+/g,'').trim();
    if(s){s.style.color='#5aa2ff';s.innerText='جاري التحقق من الحساب...';}
    if(!h||!p){if(s){s.style.color='#fca5a5';s.innerText='اكتب اليوزر والباسورد الأول';}alert('اكتب اليوزر والباسورد');return;}
    var r=await apiPost('/api/add-account',{handle:h,password:p});
    var d=null;try{d=await r.json();}catch(e){d={error:'رد غير صالح من السيرفر'};}
    if(!r.ok||!d||!d.success){var msg=(d&&d.error)||('خطأ '+r.status);if(s){s.style.color='#fca5a5';s.innerText='فشل الربط: '+msg;}alert(msg);return;}
    currentData.accounts.unshift(d.account);
    try{if(hEl)hEl.value='';if(pEl)pEl.value='';}catch(e){}
    if(s){s.style.color='#4ade80';s.innerText='تم ربط الحساب بنجاح';}
    try{selectAccount(0);}catch(e){}
    await loadData();
  }catch(e){console.error(e);try{var s2=document.getElementById('status');if(s2){s2.style.color='#fca5a5';s2.innerText='فشل الاتصال بالسيرفر';}}catch(_){}alert('فشل الاتصال بالسيرفر');}
  finally{try{if(btn)btn.disabled=false;}catch(e){}}
})();};

function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
fillNums();restoreSystemTab();restorePreviewPanel('imagePreviewPanel','imagePreviewToggle','image');restorePreviewPanel('textPostPreviewPanel','textPostPreviewToggle','text-post');restorePreviewPanel('videoPreviewPanel','videoPreviewToggle','video');restoreTextQueuePreviews();loadData();
</script></body></html>`;
}