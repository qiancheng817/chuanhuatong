/*
 * 传话筒（chuanhuatong）v2 — Songloft JS 插件（纯插件，无需中间件）
 *
 * 依赖：songloft-plugin-miot（官方 MIoT 插件，负责小米登录 / 设备 / 对话监听 / TTS）
 *
 * 消息流：
 *   孩子对小爱说「告诉爸爸，xxx」
 *     -> MIoT 对话监听 webhook POST /relay/inbound（本插件，免 JWT）
 *     -> 本插件推送企业微信（群机器人 webhook，或智能机器人长连接）
 *   爸爸在企业微信「智能机器人」会话打字
 *     -> 本插件 WebSocket 长连接（wss://openws.work.weixin.qq.com）收到
 *     -> 调用 MIoT 的 /mina/tts（宿主 JWT）让小爱播报「爸爸说，xxx」
 *
 * 活跃的 WebSocket 长连接会阻止插件被空闲休眠（宿主 HealthChecker 机制）。
 * 运行环境：Songloft QuickJS（ES2020）。
 */
(function () {
  "use strict";

  var CONFIG_KEY = "config";
  var MESSAGES_KEY = "messages";
  var DEVICE_KEY = "last_device";
  var CHATID_KEY = "last_chatid";
  var MAX_MESSAGES = 200;

  var WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
  var CMD_SUBSCRIBE = "aibot_subscribe";
  var CMD_MSG = "aibot_msg_callback";
  var CMD_RESPOND = "aibot_respond_msg";
  var CMD_SEND = "aibot_send_msg";
  var CMD_PING = "ping";

  // ----------------------------------------------------------------
  // 默认配置 / 规范化
  // ----------------------------------------------------------------
  function defaultConfig() {
    return {
      // 企微智能机器人（长连接：接收爸爸回话 + 可选主动推送）
      botId: "",
      botSecret: "",
      // 企微群机器人 webhook（孩子→爸爸推送，最简单可靠）；留空则走智能机器人长连接
      groupWebhookUrl: "",
      // 唤醒词：孩子语音必须以其中一个开头（三种称呼，含常见口语变体）
      wakeKeywords: [
        "告诉爸爸和妈妈", "告诉爸爸妈妈", "告诉爸妈",
        "告诉爸爸", "告诉妈妈"
      ],
      stripKeyword: true,
      senderName: "孩子",
      // 回话播报前缀：留空则直接播报内容
      replyPrefix: "",
      confirmText: "已转告小爱音箱",
      // MIoT 插件 entryPath
      miotEntry: "miot",
      // 目标音箱（留空则使用最近一次 webhook 上报的设备）
      targetAccountId: "",
      targetDeviceId: ""
    };
  }

  var FIELD_TYPES = {
    botId: "string", botSecret: "string", groupWebhookUrl: "string",
    wakeKeywords: "array", stripKeyword: "bool",
    senderName: "string", replyPrefix: "string", confirmText: "string",
    miotEntry: "string", targetAccountId: "string", targetDeviceId: "string"
  };

  function normalizeConfig(incoming) {
    var c = defaultConfig();
    if (!incoming || typeof incoming !== "object") return c;
    Object.keys(FIELD_TYPES).forEach(function (k) {
      if (!(k in incoming) || incoming[k] == null) return;
      var v = incoming[k], t = FIELD_TYPES[k];
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
    if (!c.miotEntry) c.miotEntry = "miot";
    if (!c.wakeKeywords.length) c.wakeKeywords = defaultConfig().wakeKeywords;
    return c;
  }

  var config = defaultConfig();
  var messages = [];
  var msgSeq = 0;
  var lastDevice = { account_id: "", device_id: "", device_name: "" };
  var lastChatid = "";

  // ----------------------------------------------------------------
  // 工具
  // ----------------------------------------------------------------
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
  function uuid() {
    return "id-" + nowMs().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36) +
      "-" + (++msgSeq);
  }

  function jsonResponse(obj, status) {
    return {
      statusCode: status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj)
    };
  }
  function jsonOk(extra, status) {
    var b = { ok: true };
    if (extra) for (var k in extra) b[k] = extra[k];
    return jsonResponse(b, status || 200);
  }
  function jsonFail(error, status) {
    return jsonResponse({ ok: false, error: "" + error }, status || 400);
  }
  function parseQuery(qs) {
    var out = {};
    if (!qs) return out;
    ("" + qs).split("&").forEach(function (part) {
      if (!part) return;
      var i = part.indexOf("=");
      var key = decodeURIComponent(i < 0 ? part : part.slice(0, i));
      var val = i < 0 ? "" : decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
      out[key] = val;
    });
    return out;
  }
  function parseJsonBody(req) {
    if (!req.body) return {};
    try {
      var v = JSON.parse(req.body);
      return (v && typeof v === "object") ? v : null;
    } catch (e) { return null; }
  }

  // ----------------------------------------------------------------
  // 存储
  // ----------------------------------------------------------------
  async function loadState() {
    try {
      config = normalizeConfig(await songloft.storage.get(CONFIG_KEY));
    } catch (e) { songloft.log.error("load config: " + e); }
    try {
      var m = await songloft.storage.get(MESSAGES_KEY);
      if (Array.isArray(m)) messages = m;
    } catch (e) {}
    try {
      var d = await songloft.storage.get(DEVICE_KEY);
      if (d && typeof d === "object") lastDevice = d;
    } catch (e) {}
    try {
      lastChatid = ("" + (await songloft.storage.get(CHATID_KEY) || ""));
    } catch (e) {}
  }
  async function saveConfig() { await songloft.storage.set(CONFIG_KEY, config); }
  async function saveDevice() { await songloft.storage.set(DEVICE_KEY, lastDevice); }
  async function saveChatid() { await songloft.storage.set(CHATID_KEY, lastChatid); }

  async function addMessage(rec) {
    rec.id = nextId();
    rec.time = nowMs();
    rec.timeText = formatTime(rec.time);
    messages.unshift(rec);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(0, MAX_MESSAGES);
    await songloft.storage.set(MESSAGES_KEY, messages);
    return rec;
  }
  async function setLatest(updates) {
    if (!messages.length) return;
    for (var k in updates) messages[0][k] = updates[k];
    await songloft.storage.set(MESSAGES_KEY, messages);
  }

  // ----------------------------------------------------------------
  // HTTP 封装
  // ----------------------------------------------------------------
  async function httpRequest(method, url, payload, extraHeaders) {
    var init = {
      method: method,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    };
    if (extraHeaders) for (var h in extraHeaders) init.headers[h] = extraHeaders[h];
    if (payload != null) init.body = JSON.stringify(payload);
    var resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, text: "", data: null, error: "network: " + e };
    }
    var text = "";
    try { text = await resp.text(); } catch (e) {}
    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) {} }
    return { ok: resp.ok, status: resp.status, text: text, data: data };
  }

  // ----------------------------------------------------------------
  // 唤醒词
  // ----------------------------------------------------------------
  function matchWake(text) {
    var t = ("" + (text || "")).trim();
    // 按关键词长度降序匹配（最长优先），防止「告诉爸爸和妈妈」被「告诉爸爸」抢先命中
    var kws = (config.wakeKeywords || []).slice().sort(function (a, b) {
      return ("" + b).length - ("" + a).length;
    });
    for (var i = 0; i < kws.length; i++) {
      var kw = ("" + kws[i]).trim();
      if (kw && t.indexOf(kw) === 0) {
        var rest = t.slice(kw.length).replace(/^[\s，,：:、]+/, "").replace(/[\s。.！!]+$/, "").trim();
        return { keyword: kw, content: rest };
      }
    }
    return null;
  }

  // ----------------------------------------------------------------
  // 企微推送（孩子 → 爸爸）
  // ----------------------------------------------------------------
  async function pushToWecom(content) {
    // 优先：群机器人 webhook（无需会话、最可靠）
    if (config.groupWebhookUrl) {
      var r = await httpRequest("POST", config.groupWebhookUrl, {
        msgtype: "text",
        text: { content: content }
      });
      if (r.ok && r.data && r.data.errcode != null && r.data.errcode !== 0) {
        return { ok: false, error: r.data.errmsg || "群机器人返回错误" };
      }
      if (!r.ok) return { ok: false, error: r.error || ("HTTP " + r.status) };
      return { ok: true, via: "group-webhook" };
    }
    // 回退：智能机器人长连接主动推送（需要爸爸的 chatid）
    if (wecom.state === "open" && lastChatid) {
      var sent = wecom.send(lastChatid, content);
      return sent ? { ok: true, via: "aibot-ws" } : { ok: false, error: "智能机器人发送失败" };
    }
    return { ok: false, error: "未配置群机器人 webhook，且智能机器人长连接/会话不可用" };
  }

  // ----------------------------------------------------------------
  // MIoT TTS（爸爸 → 小爱播报）
  // ----------------------------------------------------------------
  async function resolveTarget() {
    var accountId = config.targetAccountId || lastDevice.account_id;
    var deviceId = config.targetDeviceId || lastDevice.device_id;
    return { account_id: accountId, device_id: deviceId };
  }

  async function callMiotTTS(speakText) {
    var t = await resolveTarget();
    if (!t.account_id || !t.device_id) {
      return { ok: false, error: "目标音箱未知：请让孩子先说一次（自动记住设备），或在配置中手动指定" };
    }
    var host = "";
    var jwt = "";
    try {
      host = trimSlash(await songloft.plugin.getHostUrl());
      jwt = await songloft.plugin.getToken();
    } catch (e) {
      return { ok: false, error: "获取宿主地址/JWT 失败：" + e };
    }
    var url = host + "/api/v1/jsplugin/" + encodeURIComponent(config.miotEntry) + "/mina/tts";
    var r = await httpRequest("POST", url, {
      account_id: t.account_id,
      device_id: t.device_id,
      text: speakText
    }, { Authorization: "Bearer " + jwt });

    if (!r.ok) return { ok: false, error: r.error || ("HTTP " + r.status + " " + r.text) };
    if (r.data && r.data.success === false) {
      return { ok: false, error: r.data.error || "MIoT TTS 调用失败" };
    }
    return { ok: true };
  }

  // ----------------------------------------------------------------
  // 入站 webhook（MIoT 对话监听 → 本插件）
  // 路径 /relay/inbound 已在 publicPaths，无需 JWT
  // ----------------------------------------------------------------
  function extractSpokenTexts(msg) {
    // msg = ConversationMessage { message: { response: { answer: [...] } } }
    var out = [];
    var inner = msg && msg.message;
    var answers = inner && inner.response && inner.response.answer;
    if (Array.isArray(answers)) {
      answers.forEach(function (a) {
        var t = a.question || (a.intention && a.intention.query) || "";
        if (t) out.push("" + t);
      });
    }
    return out;
  }

  async function handleInbound(req) {
    var body = parseJsonBody(req);
    if (body == null) return jsonFail("bad json", 400);

    // 记住上报设备（用于后续 TTS 回传）
    if (body.account_id || body.device_id) {
      lastDevice = {
        account_id: "" + (body.account_id || ""),
        device_id: "" + (body.device_id || ""),
        device_name: "" + (body.device_name || "")
      };
      await saveDevice();
    }

    var list = Array.isArray(body.messages) ? body.messages : [];
    var processed = [];

    for (var i = 0; i < list.length; i++) {
      var texts = extractSpokenTexts(list[i]);
      for (var j = 0; j < texts.length; j++) {
        var raw = texts[j];
        var m = matchWake(raw);
        if (!m) continue; // 非传话内容，忽略

        var content = config.stripKeyword ? m.content : raw;
        if (!content) continue;

        await addMessage({
          dir: "in",
          channel: "xiaoai",
          sender: config.senderName,
          text: content,
          raw: raw,
          device: lastDevice.device_name,
          status: "pending",
          detail: ""
        });

        var pushText = "【" + config.senderName + "传话】" + content;
        var r = await pushToWecom(pushText);

        await setLatest({
          status: r.ok ? "delivered" : "failed",
          detail: r.ok ? "" : (r.error || "推送失败"),
          via: r.via || ""
        });
        processed.push({ text: content, ok: r.ok, error: r.ok ? "" : r.error });
      }
    }

    // 对 MIoT webhook 始终返回 200，避免其重试
    return jsonOk({ received: list.length, matched: processed.length, results: processed });
  }

  // ----------------------------------------------------------------
  // 企微智能机器人 WebSocket 长连接
  // ----------------------------------------------------------------
  var wecom = {
    socket: null,
    state: "idle",        // idle | connecting | authenticating | open
    manualStop: false,
    authReqId: "",
    pingTimer: 0,
    reconnectAttempts: 0,

    reset: function () {
      this.socket = null;
      this.pingTimer = 0;
    },

    connect: function () {
      if (!config.botId || !config.botSecret) {
        songloft.log.warn("企微智能机器人未配置 botId/botSecret，跳过长连接");
        return;
      }
      this.manualStop = false;
      this.state = "connecting";
      var ws;
      try {
        ws = new WebSocket(WECOM_WS_URL);
      } catch (e) {
        songloft.log.error("new WebSocket failed: " + e);
        this.scheduleReconnect();
        return;
      }
      this.socket = ws;
      var self = this;

      ws.onopen = function () {
        self.state = "authenticating";
        self.authReqId = CMD_SUBSCRIBE + "_" + nowMs();
        ws.send(JSON.stringify({
          cmd: CMD_SUBSCRIBE,
          headers: { req_id: self.authReqId },
          body: { bot_id: config.botId, secret: config.botSecret }
        }));
      };

      ws.onmessage = function (ev) { self.handleFrame(ev.data); };

      ws.onclose = function () {
        self.state = "idle";
        if (self.pingTimer) { clearInterval(self.pingTimer); self.pingTimer = 0; }
        if (!self.manualStop) self.scheduleReconnect();
      };

      ws.onerror = function () {
        // close 事件会随后触发并负责重连
        try { ws.close(); } catch (e) {}
      };
    },

    handleFrame: function (data) {
      var frame;
      try { frame = JSON.parse(data); } catch (e) { return; }

      // 认证结果
      if (this.state === "authenticating" &&
          (frame.headers && frame.headers.req_id === this.authReqId)) {
        if (frame.errcode === 0) {
          this.state = "open";
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          songloft.log.info("企微智能机器人长连接已建立");
        } else {
          songloft.log.error("企微认证失败: " + frame.errmsg);
          this.state = "idle";
          try { this.socket.close(); } catch (e) {}
        }
        return;
      }

      if (this.state !== "open") return;

      // 心跳响应 / 其他 ack
      if (frame.cmd !== CMD_MSG) return;

      var body = frame.body || {};
      if (body.msgtype === "text") {
        var content = (body.text && body.text.content || "").trim();
        var reqId = frame.headers && frame.headers.req_id;
        var chatid = body.chatid || "";
        if (chatid) { lastChatid = "" + chatid; saveChatid(); }
        if (content) this.handleIncomingText(content, reqId);
      }
    },

    startHeartbeat: function () {
      var self = this;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(function () {
        if (self.state === "open" && self.socket) {
          try {
            self.socket.send(JSON.stringify({
              cmd: CMD_PING,
              headers: { req_id: CMD_PING + "_" + nowMs() }
            }));
          } catch (e) {}
        }
      }, 30000);
    },

    // 处理爸爸的回话：记录 → 调 MIoT TTS → 回执
    handleIncomingText: async function (text, reqId) {
      songloft.log.info("企微收到回话: " + text);
      await addMessage({
        dir: "out",
        channel: "wecom",
        text: text,
        status: "pending",
        detail: ""
      });

      var speakText = config.replyPrefix ? (config.replyPrefix + "，" + text) : text;
      var r = await callMiotTTS(speakText);

      await setLatest({
        speakText: speakText,
        status: r.ok ? "broadcast" : "failed",
        detail: r.ok ? "" : (r.error || "播报失败")
      });

      // 被动回复确认（必须在收到消息后较短时间内）
      if (reqId) {
        var replyText = r.ok
          ? (config.confirmText || "好的")
          : ("转告失败：" + (r.error || "未知错误"));
        this.respond(reqId, replyText);
      }
    },

    respond: function (reqId, text) {
      try {
        this.socket.send(JSON.stringify({
          cmd: CMD_RESPOND,
          headers: { req_id: reqId },
          body: { msgtype: "text", text: { content: text } }
        }));
        return true;
      } catch (e) {
        songloft.log.error("企微 respond 失败: " + e);
        return false;
      }
    },

    // 主动推送（给指定 chatid）
    send: function (chatid, text) {
      try {
        this.socket.send(JSON.stringify({
          cmd: CMD_SEND,
          headers: { req_id: CMD_SEND + "_" + nowMs() },
          body: {
            chatid: "" + chatid,
            msgtype: "markdown",
            markdown: { content: text }
          }
        }));
        return true;
      } catch (e) {
        songloft.log.error("企微 send 失败: " + e);
        return false;
      }
    },

    scheduleReconnect: function () {
      var self = this;
      this.reconnectAttempts += 1;
      var delay = Math.min(1000 * Math.pow(2, Math.max(0, this.reconnectAttempts - 1)), 30000);
      songloft.log.warn("企微长连接断开，" + Math.round(delay / 1000) + "s 后重连");
      setTimeout(function () {
        if (!self.manualStop) self.connect();
      }, delay);
    },

    stop: function () {
      this.manualStop = true;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = 0; }
      this.state = "idle";
      try { if (this.socket) this.socket.close(); } catch (e) {}
    }
  };

  // ----------------------------------------------------------------
  // 配置 / 查询 / 测试 API（JWT 保护）
  // ----------------------------------------------------------------
  function handleStatus() {
    return jsonOk({
      wecom: {
        wsState: wecom.state,
        botConfigured: !!(config.botId && config.botSecret),
        groupWebhookConfigured: !!config.groupWebhookUrl,
        chatid: lastChatid
      },
      miot: {
        entry: config.miotEntry,
        lastDevice: lastDevice
      },
      wakeKeywords: config.wakeKeywords,
      messageCount: messages.length,
      serverTimeText: formatTime(nowMs())
    });
  }

  async function handleSetConfig(req) {
    var body = parseJsonBody(req);
    if (body == null) return jsonFail("bad json", 400);
    var incoming = body.config && typeof body.config === "object" ? body.config : body;
    var oldBotId = config.botId, oldSecret = config.botSecret;
    config = normalizeConfig(incoming);
    await saveConfig();

    // 机器人凭据变化时重连
    if (oldBotId !== config.botId || oldSecret !== config.botSecret) {
      wecom.stop();
      setTimeout(function () { wecom.connect(); }, 500);
    }
    songloft.log.info("config saved; ws=" + wecom.state);
    return jsonOk({ config: config });
  }

  async function handleTest(req) {
    var body = parseJsonBody(req);
    if (body == null) return jsonFail("bad json", 400);
    var target = body.target || "";
    var text = body.text || "传话筒连通性测试";

    if (target === "wecom-push") {
      var r = await pushToWecom(text);
      if (!r.ok) return jsonResponse({ ok: false, error: r.error }, 502);
      return jsonOk({ result: "sent via " + r.via });
    }
    if (target === "tts") {
      var t = await callMiotTTS(text);
      if (!t.ok) return jsonResponse({ ok: false, error: t.error }, 502);
      return jsonOk({ result: "tts ok" });
    }
    return jsonFail("unknown target: " + target + "（wecom-push / tts）", 400);
  }

  // ----------------------------------------------------------------
  // 生命周期
  // ----------------------------------------------------------------
  globalThis.onInit = async function () {
    await loadState();
    songloft.log.info("chuanhuatong initialized; lastDevice=" +
      (lastDevice.device_name || "<none>") + ", ws=" + wecom.state);
    if (config.botId && config.botSecret) wecom.connect();
  };

  globalThis.onDeinit = function () {
    wecom.stop();
    songloft.log.info("chuanhuatong deinitialized");
  };

  globalThis.onHTTPRequest = async function (req) {
    try {
      var path = req.path || "/", method = req.method || "GET";

      if (method === "POST" && path === "/relay/inbound") return await handleInbound(req);

      if (method === "GET" && (path === "/" || path === "/api/ping")) {
        return jsonOk({ name: "chuanhuatong", version: "2.0.0", time: formatTime(nowMs()) });
      }
      if (method === "GET" && path === "/api/status") return handleStatus();
      if (method === "GET" && path === "/api/config") return jsonOk({ config: config });
      if (method === "POST" && path === "/api/config") return await handleSetConfig(req);
      if (method === "GET" && path === "/api/messages") {
        var q = parseQuery(req.query);
        var limit = parseInt(q.limit, 10);
        if (!limit || limit <= 0 || limit > MAX_MESSAGES) limit = 100;
        return jsonOk({ messages: messages.slice(0, limit), total: messages.length });
      }
      if (method === "POST" && path === "/api/test") return await handleTest(req);

      return jsonFail("not found: " + method + " " + path, 404);
    } catch (e) {
      songloft.log.error("onHTTPRequest: " + e);
      return jsonFail("internal: " + e, 500);
    }
  };
})();
