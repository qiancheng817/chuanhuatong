/*
 * 传话筒（chuanhuatong）— Songloft JS 插件（纯插件，无需中间件）
 *
 * 依赖：songloft-plugin-miot（官方 MIoT 插件，负责小米登录 / 设备 / 对话监听 / TTS）
 *
 * 消息流：
 *   孩子对小爱说「告诉爸爸/妈妈，xxx」
 *     -> MIoT 对话监听 -> 本插件自动注册的对话 webhook -> /relay/inbound
 *     -> 本插件推送企业微信（群机器人 webhook，或智能机器人长连接）
 *   大人在企业微信「智能机器人」会话打字
 *     -> 本插件 WebSocket 长连接收到 -> 调 MIoT /mina/tts 让小爱直接播报
 *
 * 活跃 WebSocket 长连接会阻止插件被空闲休眠（宿主 HealthChecker 机制）。
 * 运行环境：Songloft QuickJS（ES2020）。
 */
(function () {
  "use strict";

  var CONFIG_KEY = "config";
  var MESSAGES_KEY = "messages";
  var DEVICE_KEY = "last_device";
  var MAX_MESSAGES = 200;
  var PLUGIN_VERSION = "2.5.0";

  var WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
  var CMD_SUBSCRIBE = "aibot_subscribe";
  var CMD_MSG = "aibot_msg_callback";
  var CMD_RESPOND = "aibot_respond_msg";
  var CMD_SEND = "aibot_send_msg";
  var CMD_PING = "ping";

  // ----------------------------------------------------------------
  // 默认配置
  // ----------------------------------------------------------------
  function defaultConfig() {
    return {
      // 企微智能机器人（长连接）
      botId: "",
      botSecret: "",
      // 群机器人 webhook（孩子→大人，可选；填了优先用它推送）
      groupWebhookUrl: "",
      // 会话 chatid：可手动填写，也会在机器人收到消息时自动记住；二者同一字段
      chatid: "",
      // 唤醒词
      wakeKeywords: [
        "告诉爸爸和妈妈", "告诉爸爸妈妈", "告诉爸妈",
        "告诉爸爸", "告诉妈妈"
      ],
      stripKeyword: true,
      senderName: "孩子",
      replyPrefix: "",            // 播报前缀，留空 = 直接播报
      confirmText: "已转告小爱音箱",
      miotEntry: "miot",
      targetAccountId: "",
      targetDeviceId: ""
    };
  }

  var FIELD_TYPES = {
    botId: "string", botSecret: "string", groupWebhookUrl: "string", chatid: "string",
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

  // 自动注册状态
  var inboundState = {
    url: "",
    registered: false,
    working: false,
    detail: "",
    lastCheckedText: ""
  };

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
    return nowMs().toString(36) + "-" + msgSeq + "-" +
      Math.floor(Math.random() * 1e6).toString(36);
  }
  function trimSlash(s) { return ("" + s).replace(/\/+$/, ""); }

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
  function parseJsonBody(req) {
    if (!req.body) return {};
    try {
      var v = JSON.parse(req.body);
      return (v && typeof v === "object") ? v : null;
    } catch (e) { return null; }
  }

  // ----------------------------------------------------------------
  // 存储（config 是唯一配置出口；chatid 就在 config 内，天然持久化）
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
  }
  async function saveConfig() {
    await songloft.storage.set(CONFIG_KEY, config);
  }
  async function saveDevice() {
    await songloft.storage.set(DEVICE_KEY, lastDevice);
  }

  async function rememberChatid(c) {
    c = ("" + (c || "")).trim();
    if (!c || c === config.chatid) return;
    config.chatid = c;
    await saveConfig();
  }

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
  // 唤醒词（最长优先）
  // ----------------------------------------------------------------
  function matchWake(text) {
    var t = ("" + (text || "")).trim();
    var kws = (config.wakeKeywords || []).slice().sort(function (a, b) {
      return ("" + b).length - ("" + a).length;
    });
    for (var i = 0; i < kws.length; i++) {
      var kw = ("" + kws[i]).trim();
      if (kw && t.indexOf(kw) === 0) {
        var rest = t.slice(kw.length).replace(/^[\s，,：:、]+/, "")
          .replace(/[\s。.！!]+$/, "").trim();
        return { keyword: kw, content: rest };
      }
    }
    return null;
  }

  // ----------------------------------------------------------------
  // 企微推送（孩子 → 大人）
  // ----------------------------------------------------------------
  async function pushToWecom(content) {
    if (config.groupWebhookUrl) {
      var r = await httpRequest("POST", config.groupWebhookUrl, {
        msgtype: "text",
        text: { content: content }
      });
      if (r.ok && r.data && r.data.errcode != null && r.data.errcode !== 0) {
        return { ok: false, error: r.data.errmsg || "群机器人返回错误" };
      }
      if (!r.ok) return { ok: false, error: r.error || ("HTTP " + r.status) };
      return { ok: true, via: "群机器人" };
    }
    if (wecom.state === "open" && config.chatid) {
      var sent = wecom.send(config.chatid, content);
      return sent ? { ok: true, via: "智能机器人" } :
        { ok: false, error: "智能机器人发送失败" };
    }
    return {
      ok: false,
      error: "无可推送通道：请填写群机器人 webhook；或先在智能机器人里发一句话（自动记住会话），也可手动填写 chatid"
    };
  }

  // ----------------------------------------------------------------
  // MIoT TTS（大人 → 小爱播报）
  // ----------------------------------------------------------------
  async function resolveTarget() {
    return {
      account_id: config.targetAccountId || lastDevice.account_id,
      device_id: config.targetDeviceId || lastDevice.device_id
    };
  }

  async function getHostContext() {
    return {
      host: trimSlash(await songloft.plugin.getHostUrl()),
      jwt: await songloft.plugin.getToken()
    };
  }
  function miotApiBase(ctx) {
    return ctx.host + "/api/v1/jsplugin/" + encodeURIComponent(config.miotEntry);
  }
  function buildInboundUrl(ctx) {
    return ctx.host + "/api/v1/jsplugin/chuanhuatong/relay/inbound";
  }
  async function ensureInboundUrl() {
    if (inboundState.url) return inboundState.url;
    try {
      var ctx = await getHostContext();
      inboundState.url = buildInboundUrl(ctx);
    } catch (e) {
      songloft.log.warn("ensureInboundUrl failed: " + e);
    }
    return inboundState.url;
  }

  async function callMiotTTS(speakText) {
    var t = await resolveTarget();
    if (!t.account_id || !t.device_id) {
      return { ok: false, error: "目标音箱未知：请让孩子先说一次，或在高级设置里手动指定 account_id / device_id" };
    }
    var ctx;
    try {
      ctx = await getHostContext();
    } catch (e) {
      return { ok: false, error: "获取宿主地址/JWT 失败：" + e };
    }
    var r = await httpRequest("POST", miotApiBase(ctx) + "/mina/tts", {
      account_id: t.account_id,
      device_id: t.device_id,
      text: speakText
    }, { Authorization: "Bearer " + ctx.jwt });

    if (!r.ok) return { ok: false, error: r.error || ("HTTP " + r.status) };
    if (r.data && r.data.success === false) {
      return { ok: false, error: r.data.error || "MIoT TTS 调用失败" };
    }
    return { ok: true };
  }

  // ----------------------------------------------------------------
  // 入站 webhook 自动注册
  // ----------------------------------------------------------------
  async function queryMiotWebhooks(ctx) {
    var r = await httpRequest(
      "GET", miotApiBase(ctx) + "/conversation/webhooks", null,
      { Authorization: "Bearer " + ctx.jwt }
    );
    if (!r.ok) {
      return { ok: false, error: "无法连接 MIoT（" + (r.error || ("HTTP " + r.status)) +
        "），确认 MIoT 插件已安装、entryPath 为 " + config.miotEntry };
    }
    if (r.data && r.data.success === false) {
      return { ok: false, error: r.data.error || "MIoT 返回错误" };
    }
    return { ok: true, list: Array.isArray(r.data.data) ? r.data.data : [] };
  }

  // 自动注册（幂等）：返回供页面直接提示
  async function registerInbound() {
    inboundState.working = true;
    try {
      var ctx;
      try {
        ctx = await getHostContext();
      } catch (e) {
        inboundState.detail = "获取宿主地址/JWT 失败：" + e;
        inboundState.registered = false;
        return { ok: false, error: inboundState.detail };
      }
      var inboundUrl = buildInboundUrl(ctx);
      inboundState.url = inboundUrl;

      var q = await queryMiotWebhooks(ctx);
      if (!q.ok) {
        inboundState.registered = false;
        inboundState.detail = q.error;
        return { ok: false, error: q.error };
      }

      var exists = false;
      for (var i = 0; i < q.list.length; i++) {
        if (q.list[i] && q.list[i].url === inboundUrl) { exists = true; break; }
      }
      if (exists) {
        inboundState.registered = true;
        inboundState.detail = "";
        inboundState.lastCheckedText = formatTime(nowMs());
        return { ok: true, already: true };
      }

      var r = await httpRequest(
        "POST", miotApiBase(ctx) + "/conversation/webhooks",
        { url: inboundUrl, name: "传话筒" },
        { Authorization: "Bearer " + ctx.jwt }
      );
      if (!r.ok || (r.data && r.data.success === false)) {
        inboundState.registered = false;
        inboundState.detail = (!r.ok)
          ? (r.error || ("HTTP " + r.status))
          : (r.data.error || "MIoT 注册失败");
        return { ok: false, error: inboundState.detail };
      }

      inboundState.registered = true;
      inboundState.detail = "";
      inboundState.lastCheckedText = formatTime(nowMs());
      songloft.log.info("已向 MIoT 注册对话 webhook: " + inboundUrl);
      return { ok: true, already: false };
    } finally {
      inboundState.working = false;
    }
  }

  // ----------------------------------------------------------------
  // 入站（MIoT → 本插件），路径 /relay/inbound 免 JWT
  // ----------------------------------------------------------------
  function extractSpokenTexts(msg) {
    var out = [];
    var answers = msg && msg.message && msg.message.response && msg.message.response.answer;
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
        if (!m) continue;

        var content = config.stripKeyword ? m.content : raw;
        if (!content) continue;

        await addMessage({
          dir: "in", sender: config.senderName, text: content, raw: raw,
          device: lastDevice.device_name, status: "pending", detail: ""
        });

        var r = await pushToWecom("【" + config.senderName + "传话】" + content);
        await setLatest({
          status: r.ok ? "delivered" : "failed",
          detail: r.ok ? "" : (r.error || "推送失败"), via: r.via || ""
        });
        processed.push({ ok: r.ok });
      }
    }
    return jsonOk({ received: list.length, matched: processed.length });
  }

  // ----------------------------------------------------------------
  // 企微智能机器人 WebSocket 长连接
  // ----------------------------------------------------------------
  var wecom = {
    socket: null,
    state: "idle",
    manualStop: false,
    authReqId: "",
    pingTimer: 0,
    reconnectAttempts: 0,

    connect: function () {
      if (!config.botId || !config.botSecret) {
        songloft.log.warn("未配置 botId/botSecret，跳过企微长连接");
        return;
      }
      this.manualStop = false;
      this.state = "connecting";
      var ws;
      try {
        ws = new WebSocket(WECOM_WS_URL);
      } catch (e) {
        songloft.log.error("new WebSocket: " + e);
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
        try { ws.close(); } catch (e) {}
      };
    },

    handleFrame: function (data) {
      var frame;
      try { frame = JSON.parse(data); } catch (e) { return; }

      if (this.state === "authenticating" &&
          frame.headers && frame.headers.req_id === this.authReqId) {
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

      if (this.state !== "open" || frame.cmd !== CMD_MSG) return;

      var body = frame.body || {};
      if (body.msgtype === "text") {
        var content = ((body.text && body.text.content) || "").trim();
        var reqId = frame.headers && frame.headers.req_id;
        // 群聊用 chatid；单聊常无 chatid，回退发送方 userid
        rememberChatid(body.chatid || body.from_userid || "");
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
              headers: reqHeader()
            }));
          } catch (e) {}
        }
      }, 30000);
    },

    handleIncomingText: async function (text, reqId) {
      songloft.log.info("企微收到回话: " + text);
      await addMessage({
        dir: "out", text: text, status: "pending", detail: ""
      });

      var speakText = config.replyPrefix ? (config.replyPrefix + "，" + text) : text;
      var r = await callMiotTTS(speakText);
      await setLatest({
        speakText: speakText,
        status: r.ok ? "broadcast" : "failed",
        detail: r.ok ? "" : (r.error || "播报失败")
      });

      if (reqId) {
        this.respond(reqId, r.ok ? (config.confirmText || "好的")
          : ("转告失败：" + (r.error || "未知错误")));
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
        songloft.log.error("respond: " + e);
        return false;
      }
    },

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
        songloft.log.error("send: " + e);
        return false;
      }
    },

    scheduleReconnect: function () {
      var self = this;
      this.reconnectAttempts += 1;
      var delay = Math.min(
        1000 * Math.pow(2, Math.max(0, this.reconnectAttempts - 1)), 30000);
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

  function reqHeader() {
    return { req_id: CMD_PING + "_" + nowMs() };
  }

  // ----------------------------------------------------------------
  // 配置 / 查询 API（JWT 保护）
  // ----------------------------------------------------------------
  async function handleStatus() {
    await ensureInboundUrl();
    return jsonOk({
      version: PLUGIN_VERSION,
      wecom: {
        wsState: wecom.state,
        botConfigured: !!(config.botId && config.botSecret),
        groupWebhookConfigured: !!config.groupWebhookUrl,
        chatid: config.chatid
      },
      device: lastDevice,
      inbound: inboundState,
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

    if (oldBotId !== config.botId || oldSecret !== config.botSecret) {
      wecom.stop();
      setTimeout(function () { wecom.connect(); }, 500);
    }

    // 保存后自动确保 MIoT webhook 已注册
    setTimeout(function () { registerInbound(); }, 1200);

    return jsonOk({ config: config });
  }

  async function handleInboundStatus() {
    await ensureInboundUrl();
    return jsonOk({ inbound: inboundState });
  }

  async function handleInboundRegister() {
    var r = await registerInbound();
    if (!r.ok) return jsonResponse({ ok: false, error: r.error }, 200);
    return jsonOk({ already: !!r.already, inbound: inboundState });
  }

  async function handleTest(req) {
    var body = parseJsonBody(req);
    if (body == null) return jsonFail("bad json", 400);
    var text = body.text || "传话筒连通性测试";

    if (body.target === "wecom-push") {
      var r = await pushToWecom(text);
      if (!r.ok) return jsonResponse({ ok: false, error: r.error }, 200);
      return jsonOk({ via: r.via });
    }
    if (body.target === "tts") {
      var t = await callMiotTTS(text);
      if (!t.ok) return jsonResponse({ ok: false, error: t.error }, 200);
      return jsonOk({ result: "tts ok" });
    }
    return jsonFail("unknown target（wecom-push / tts）", 400);
  }

  // ----------------------------------------------------------------
  // 生命周期
  // ----------------------------------------------------------------
  function autoRegisterWithRetry() {
    [3000, 8000, 15000, 25000].forEach(function (d) {
      setTimeout(function () { registerInbound(); }, d);
    });
  }

  globalThis.onInit = async function () {
    await loadState();
    songloft.log.info("chuanhuatong v" + PLUGIN_VERSION + " ready; ws=" + wecom.state +
      ", device=" + (lastDevice.device_name || "<none>"));
    if (config.botId && config.botSecret) wecom.connect();
    autoRegisterWithRetry();
  };

  globalThis.onDeinit = function () {
    wecom.stop();
  };

  globalThis.onHTTPRequest = async function (req) {
    try {
      var path = req.path || "/", method = req.method || "GET";

      if (method === "POST" && path === "/relay/inbound") return await handleInbound(req);
      if (method === "GET" && (path === "/" || path === "/api/ping")) {
        return jsonOk({ name: "chuanhuatong", version: PLUGIN_VERSION });
      }
      if (method === "GET" && path === "/api/status") return handleStatus();
      if (method === "GET" && path === "/api/config") return jsonOk({ config: config });
      if (method === "POST" && path === "/api/config") return await handleSetConfig(req);
      if (method === "GET" && path === "/api/messages") {
        var q = parseJsonQuery(req);
        return jsonOk({ messages: messages.slice(0, q.limit), total: messages.length });
      }
      if (method === "POST" && path === "/api/test") return await handleTest(req);
      if (method === "GET" && path === "/api/inbound/status") return await handleInboundStatus();
      if (method === "POST" && path === "/api/inbound/register") return await handleInboundRegister();

      return jsonFail("not found: " + method + " " + path, 404);
    } catch (e) {
      songloft.log.error("onHTTPRequest: " + e);
      return jsonFail("internal: " + e, 500);
    }
  };

  // 小工具：messages limit
  function parseJsonQuery(req) {
    var limit = 100;
    if (req.query) {
      var m = ("" + req.query).match(/(?:^|&)limit=(\d+)/);
      if (m) {
        limit = parseInt(m[1], 10);
        if (!limit || limit <= 0 || limit > MAX_MESSAGES) limit = 100;
      }
    }
    return { limit: limit };
  }
})();
