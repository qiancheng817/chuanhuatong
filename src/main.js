/*
 * 传话筒（chuanhuatong）— Songloft JS 插件
 *
 * 消息流：
 *   小爱音箱（孩子语音） → chuanhuatong-bridge 轮询 MiNA 对话记录
 *     → POST /relay/inbound（本插件）→ 推送企业微信机器人（爸爸）
 *   爸爸在企微机器人会话打字
 *     → chuanhuatong-bridge WebSocket 长连接
 *     → POST /relay/outbound（本插件）→ bridge 调用小爱 TTS 播报
 *
 * 运行环境：Songloft QuickJS（ES2020），仅依赖全局 fetch 与 storage 权限。
 */
(function () {
  "use strict";

  var CONFIG_KEY = "config";
  var MESSAGES_KEY = "messages";
  var MAX_MESSAGES = 200;

  // ------------------------------------------------------------------
  // 默认配置
  // ------------------------------------------------------------------
  function defaultConfig() {
    return {
      // chuanhuatong-bridge 地址，例如 http://192.168.1.20:8788
      bridgeUrl: "",
      // 插件与 bridge 之间的共享密钥（双方必须一致）
      bridgeToken: "",
      // 企微出站方式：bridge-ws = bridge 持有智能机器人长连接（推荐）
      //              group-webhook = 直接调用企微群机器人 webhook（仅孩子→爸爸方向可用）
      wecomMode: "bridge-ws",
      groupWebhookUrl: "",
      // 唤醒词：孩子对小爱说的话必须以其中任意一个开头
      wakeKeywords: ["告诉爸爸", "呼叫爸爸", "通知爸爸"],
      // 推送到企微时是否剥离唤醒词（只保留传话内容）
      stripKeyword: true,
      // 发送方称呼（显示在企微消息中）
      senderName: "孩子",
      // 小爱播报爸爸回话时的前缀，例如“爸爸说”；留空则直接播报内容
      replyPrefix: "爸爸说",
      // 爸爸发完消息后在企微收到的确认语；留空则不确认
      confirmText: "已转告小爱音箱"
    };
  }

  var FIELD_TYPES = {
    bridgeUrl: "string",
    bridgeToken: "string",
    wecomMode: "string",
    groupWebhookUrl: "string",
    wakeKeywords: "array",
    stripKeyword: "bool",
    senderName: "string",
    replyPrefix: "string",
    confirmText: "string"
  };

  function normalizeConfig(incoming) {
    var c = defaultConfig();
    if (!incoming || typeof incoming !== "object") return c;
    Object.keys(FIELD_TYPES).forEach(function (k) {
      if (!(k in incoming) || incoming[k] === null || incoming[k] === undefined) return;
      var v = incoming[k];
      var t = FIELD_TYPES[k];
      if (t === "string") {
        c[k] = ("" + v).trim();
      } else if (t === "bool") {
        c[k] = !!v;
      } else if (t === "array") {
        if (Array.isArray(v)) {
          c[k] = v.map(function (e) { return ("" + e).trim(); }).filter(Boolean);
        } else if (typeof v === "string") {
          c[k] = v.split(/[,，;；\n]/).map(function (e) { return e.trim(); }).filter(Boolean);
        }
      }
    });
    if (c.wecomMode !== "bridge-ws" && c.wecomMode !== "group-webhook") {
      c.wecomMode = "bridge-ws";
    }
    if (!c.wakeKeywords.length) c.wakeKeywords = defaultConfig().wakeKeywords;
    return c;
  }

  var config = defaultConfig();
  var messages = [];
  var msgSeq = 0;

  // ------------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------------
  function nowMs() { return Date.now(); }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function formatTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function nextId() {
    msgSeq += 1;
    return nowMs().toString(36) + "-" + msgSeq + "-" + Math.floor(Math.random() * 1e6).toString(36);
  }

  function trimSlash(s) { return ("" + s).replace(/\/+$/, ""); }

  function getHeaderCI(headers, name) {
    if (!headers) return "";
    var lower = name.toLowerCase();
    for (var k in headers) {
      if (k.toLowerCase() === lower) return headers[k];
    }
    return "";
  }

  function jsonResponse(obj, status) {
    return {
      statusCode: status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj)
    };
  }

  function jsonOk(extra, status) {
    var body = { ok: true };
    if (extra) {
      for (var k in extra) body[k] = extra[k];
    }
    return jsonResponse(body, status || 200);
  }

  function jsonFail(error, status) {
    return jsonResponse({ ok: false, error: "" + error }, status || 400);
  }

  function parseQuery(qs) {
    var out = {};
    if (!qs) return out;
    ("" + qs).split("&").forEach(function (part) {
      if (!part) return;
      var idx = part.indexOf("=");
      var k = decodeURIComponent(idx < 0 ? part : part.slice(0, idx));
      var v = idx < 0 ? "" : decodeURIComponent(part.slice(idx + 1).replace(/\+/g, " "));
      out[k] = v;
    });
    return out;
  }

  function parseJsonObject(req) {
    if (!req.body) return {};
    try {
      var v = JSON.parse(req.body);
      if (v && typeof v === "object") return v;
      return {};
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 存储
  // ------------------------------------------------------------------
  async function loadState() {
    try {
      var saved = await songloft.storage.get(CONFIG_KEY);
      config = normalizeConfig(saved);
    } catch (e) {
      songloft.log.error("load config failed: " + e);
    }
    try {
      var msgs = await songloft.storage.get(MESSAGES_KEY);
      if (Array.isArray(msgs)) messages = msgs;
    } catch (e) {
      songloft.log.error("load messages failed: " + e);
    }
  }

  async function persistConfig() {
    await songloft.storage.set(CONFIG_KEY, config);
  }

  async function persistMessages() {
    await songloft.storage.set(MESSAGES_KEY, messages);
  }

  async function addMessage(rec) {
    rec.id = nextId();
    rec.time = nowMs();
    rec.timeText = formatTime(rec.time);
    messages.unshift(rec);
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(0, MAX_MESSAGES);
    }
    await persistMessages();
    return rec;
  }

  function updateLatest(updates) {
    if (!messages.length) return;
    Object.keys(updates).forEach(function (k) {
      messages[0][k] = updates[k];
    });
    return persistMessages();
  }

  // ------------------------------------------------------------------
  // 鉴权（bridge → 插件）
  // ------------------------------------------------------------------
  function checkBridgeAuth(req) {
    if (!config.bridgeToken) return false;
    var token = getHeaderCI(req.headers, "X-Bridge-Token");
    if (!token) {
      token = parseQuery(req.query).token || "";
    }
    if (!token && req.body) {
      var b = parseJsonObject(req);
      if (b && typeof b.token === "string") token = b.token;
    }
    return token === config.bridgeToken;
  }

  // ------------------------------------------------------------------
  // HTTP 封装
  // ------------------------------------------------------------------
  async function httpRequest(method, url, payload) {
    var init = {
      method: method,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Fetch-Timeout-Ms": "15000"
      }
    };
    if (payload !== undefined && payload !== null) {
      init.body = JSON.stringify(payload);
    }
    var resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, text: "", data: null, error: "network error: " + e };
    }
    var text = "";
    try { text = await resp.text(); } catch (e) {}
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) {}
    }
    return { ok: resp.ok, status: resp.status, text: text, data: data, error: "" };
  }

  function httpPost(url, payload) { return httpRequest("POST", url, payload); }
  function httpGet(url) { return httpRequest("GET", url, null); }

  // ------------------------------------------------------------------
  // 唤醒词匹配
  // ------------------------------------------------------------------
  function matchWake(text) {
    if (!text) return null;
    var t = ("" + text).trim();
    var kws = config.wakeKeywords || [];
    for (var i = 0; i < kws.length; i++) {
      var kw = ("" + kws[i]).trim();
      if (!kw) continue;
      if (t.indexOf(kw) === 0) {
        var rest = t.slice(kw.length).replace(/^[\s，,：:、]+/, "").replace(/[\s。.！!]+$/, "").trim();
        return { keyword: kw, content: rest };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 业务处理：入站（小爱 → 企微）
  // ------------------------------------------------------------------
  async function pushToWecom(text, inboundBody) {
    if (config.wecomMode === "group-webhook") {
      if (!config.groupWebhookUrl) return { ok: false, error: "groupWebhookUrl 未配置" };
      return httpPost(config.groupWebhookUrl, {
        msgtype: "text",
        text: { content: text }
      });
    }
    if (!config.bridgeUrl) return { ok: false, error: "bridgeUrl 未配置" };
    return httpPost(trimSlash(config.bridgeUrl) + "/wecom/send", {
      text: text,
      chatid: (inboundBody && inboundBody.chatid) || ""
    }, { "X-Bridge-Token": config.bridgeToken });
  }

  async function handleInbound(req) {
    if (!checkBridgeAuth(req)) return jsonFail("unauthorized: bridge token 不匹配", 401);

    var body = parseJsonObject(req);
    if (body === null) return jsonFail("bad request body: 需要 JSON", 400);

    var rawText = ("" + (body.text !== undefined && body.text !== null ? body.text :
      (body.query !== undefined ? body.query : ""))).trim();
    if (!rawText) return jsonFail("empty text", 400);

    var match = matchWake(rawText);
    if (!match) {
      // 非传话内容（普通小爱对话），静默忽略
      return jsonOk({ matched: false });
    }

    var content = config.stripKeyword ? match.content : rawText;
    if (!content) {
      return jsonFail("传话内容为空（唤醒词后没有具体内容）", 422);
    }

    await addMessage({
      dir: "in",
      channel: "xiaoai",
      sender: config.senderName,
      text: content,
      raw: rawText,
      device: body.device || "",
      status: "pending",
      detail: ""
    });

    var pushText = "【" + config.senderName + "传话】" + content;
    var r = await pushToWecom(pushText, body);

    if (r.ok && r.data && r.data.ok === false) {
      r = { ok: false, error: r.data.error || r.text || "bridge 返回失败" };
    }

    await updateLatest({
      status: r.ok ? "delivered" : "failed",
      detail: r.ok ? "" : (r.error || r.text || "推送失败")
    });

    if (!r.ok) {
      return jsonResponse({ ok: false, matched: true, error: messages[0].detail }, 502);
    }
    return jsonOk({ matched: true });
  }

  // ------------------------------------------------------------------
  // 业务处理：出站（企微 → 小爱播报）
  // ------------------------------------------------------------------
  async function handleOutbound(req) {
    if (!checkBridgeAuth(req)) return jsonFail("unauthorized: bridge token 不匹配", 401);

    var body = parseJsonObject(req);
    if (body === null) return jsonFail("bad request body: 需要 JSON", 400);

    var text = ("" + (body.text !== undefined && body.text !== null ? body.text : "")).trim();
    if (!text) return jsonFail("empty text", 400);

    await addMessage({
      dir: "out",
      channel: "wecom",
      text: text,
      chatid: body.chatid || "",
      status: "pending",
      detail: ""
    });

    if (!config.bridgeUrl) {
      await updateLatest({ status: "failed", detail: "bridgeUrl 未配置" });
      return jsonFail("bridgeUrl 未配置", 503);
    }

    var speakText = config.replyPrefix ? (config.replyPrefix + "，" + text) : text;
    var r = await httpPost(trimSlash(config.bridgeUrl) + "/xiaoai/tts", {
      text: speakText,
      deviceId: body.deviceId || ""
    }, { "X-Bridge-Token": config.bridgeToken });

    if (r.ok && r.data && r.data.ok === false) {
      r = { ok: false, error: r.data.error || r.text || "bridge 返回失败" };
    }

    await updateLatest({
      speakText: speakText,
      status: r.ok ? "broadcast" : "failed",
      detail: r.ok ? "" : (r.error || r.text || "播报失败")
    });

    if (!r.ok) {
      return jsonResponse({ ok: false, error: messages[0].detail }, 502);
    }
    return jsonResponse({ ok: true, echo: config.confirmText || "" });
  }

  // ------------------------------------------------------------------
  // 配置 / 查询 / 测试 API（需登录 Songloft，JWT 保护）
  // ------------------------------------------------------------------
  function handleGetConfig() {
    return jsonOk({ config: config });
  }

  async function handleSetConfig(req) {
    var body = parseJsonObject(req);
    if (body === null) return jsonFail("bad request body: 需要 JSON", 400);
    var incoming = body.config && typeof body.config === "object" ? body.config : body;
    config = normalizeConfig(incoming);
    await persistConfig();
    songloft.log.info("config updated: bridge=" + config.bridgeUrl + " mode=" + config.wecomMode);
    return jsonOk({ config: config });
  }

  function handleGetMessages(req) {
    var q = parseQuery(req.query);
    var limit = parseInt(q.limit, 10);
    if (!limit || limit <= 0 || limit > MAX_MESSAGES) limit = 100;
    return jsonOk({ messages: messages.slice(0, limit), total: messages.length });
  }

  function handleStatus() {
    return jsonOk({
      bridge: {
        configured: !!config.bridgeUrl,
        url: config.bridgeUrl
      },
      wecom: {
        mode: config.wecomMode,
        groupWebhookConfigured: !!config.groupWebhookUrl
      },
      wakeKeywords: config.wakeKeywords,
      messageCount: messages.length,
      serverTime: nowMs(),
      serverTimeText: formatTime(nowMs())
    });
  }

  async function handleTest(req) {
    var body = parseJsonObject(req);
    if (body === null) return jsonFail("bad request body: 需要 JSON", 400);
    var target = body.target || "";
    var text = body.text || "传话筒连通性测试";

    if (target === "bridge") {
      if (!config.bridgeUrl) return jsonFail("bridgeUrl 未配置", 400);
      var hr = await httpGet(trimSlash(config.bridgeUrl) + "/health");
      if (!hr.ok) return jsonResponse({ ok: false, target: "bridge", error: hr.error || ("HTTP " + hr.status) }, 502);
      return jsonOk({ target: "bridge", result: hr.data || hr.text });
    }

    if (target === "wecom") {
      var wr = await pushToWecom(text, body);
      if (!wr.ok) return jsonResponse({ ok: false, target: "wecom", error: wr.error || wr.text }, 502);
      return jsonOk({ target: "wecom", result: wr.data || "sent" });
    }

    if (target === "tts") {
      if (!config.bridgeUrl) return jsonFail("bridgeUrl 未配置", 400);
      var tr = await httpPost(trimSlash(config.bridgeUrl) + "/xiaoai/tts", {
        text: text
      }, { "X-Bridge-Token": config.bridgeToken });
      if (!tr.ok) return jsonResponse({ ok: false, target: "tts", error: tr.error || tr.text }, 502);
      return jsonOk({ target: "tts", result: tr.data || "sent" });
    }

    return jsonFail("unknown target: " + target + "（可选 bridge / wecom / tts）", 400);
  }

  // ------------------------------------------------------------------
  // 生命周期与入口
  // ------------------------------------------------------------------
  globalThis.onInit = async function () {
    await loadState();
    songloft.log.info("chuanhuatong initialized: bridge=" + (config.bridgeUrl || "<none>") +
      ", mode=" + config.wecomMode);
  };

  globalThis.onDeinit = function () {
    songloft.log.info("chuanhuatong deinitialized");
  };

  globalThis.onHTTPRequest = async function (req) {
    try {
      var path = req.path || "/";
      var method = req.method || "GET";

      if (method === "POST" && path === "/relay/inbound") return await handleInbound(req);
      if (method === "POST" && path === "/relay/outbound") return await handleOutbound(req);

      if (method === "GET" && (path === "/" || path === "/api/ping")) {
        return jsonOk({
          name: "chuanhuatong",
          version: "1.0.0",
          status: "running",
          time: formatTime(nowMs())
        });
      }
      if (method === "GET" && path === "/api/status") return handleStatus();
      if (method === "GET" && path === "/api/config") return handleGetConfig();
      if (method === "POST" && path === "/api/config") return await handleSetConfig(req);
      if (method === "GET" && path === "/api/messages") return handleGetMessages(req);
      if (method === "POST" && path === "/api/test") return await handleTest(req);

      return jsonFail("not found: " + method + " " + path, 404);
    } catch (e) {
      songloft.log.error("onHTTPRequest error: " + e);
      return jsonFail("internal error: " + e, 500);
    }
  };
})();
