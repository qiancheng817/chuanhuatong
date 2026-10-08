/* 传话筒插件配置页逻辑（v2 纯插件） */
(function () {
  "use strict";

  var api = window.SongloftPlugin || {};

  function toast(msg, ms) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, ms || 2200);
  }

  function escapeHtml(s) {
    return ("" + s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function apiGet(path) {
    if (api.apiGet) return api.apiGet(path);
    return fetch(path, { headers: { "Accept": "application/json" } }).then(function (r) { return r.json(); });
  }
  function apiPost(path, body) {
    if (api.apiPost) return api.apiPost(path, body || {});
    return fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  // --------------------------------------------------------------
  // 配置表单
  // --------------------------------------------------------------
  function fillForm(c) {
    document.getElementById("cfg-botId").value = c.botId || "";
    document.getElementById("cfg-botSecret").value = c.botSecret || "";
    document.getElementById("cfg-groupWebhookUrl").value = c.groupWebhookUrl || "";
    document.getElementById("cfg-wakeKeywords").value = (c.wakeKeywords || []).join(",");
    document.getElementById("cfg-senderName").value = c.senderName || "";
    document.getElementById("cfg-replyPrefix").value = c.replyPrefix || "";
    document.getElementById("cfg-confirmText").value = c.confirmText || "";
    document.getElementById("cfg-stripKeyword").checked = c.stripKeyword !== false;
    document.getElementById("cfg-miotEntry").value = c.miotEntry || "miot";
    document.getElementById("cfg-targetAccountId").value = c.targetAccountId || "";
    document.getElementById("cfg-targetDeviceId").value = c.targetDeviceId || "";
    setInboundMode(c.inboundMode || "auto", true);
  }

  // --------------------------------------------------------------
  // 入站对接模式切换
  // --------------------------------------------------------------
  function setInboundMode(mode, silent) {
    if (mode !== "auto" && mode !== "manual") mode = "auto";
    document.querySelectorAll("#inbound-seg button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    document.getElementById("pane-auto").classList.toggle("show", mode === "auto");
    document.getElementById("pane-manual").classList.toggle("show", mode === "manual");
  }

  function readForm() {
    return {
      botId: document.getElementById("cfg-botId").value.trim(),
      botSecret: document.getElementById("cfg-botSecret").value,
      groupWebhookUrl: document.getElementById("cfg-groupWebhookUrl").value.trim(),
      wakeKeywords: document.getElementById("cfg-wakeKeywords").value,
      senderName: document.getElementById("cfg-senderName").value.trim() || "孩子",
      replyPrefix: document.getElementById("cfg-replyPrefix").value.trim(),
      confirmText: document.getElementById("cfg-confirmText").value.trim(),
      stripKeyword: document.getElementById("cfg-stripKeyword").checked,
      miotEntry: document.getElementById("cfg-miotEntry").value.trim() || "miot",
      inboundMode: document.querySelector("#inbound-seg button.active")?.getAttribute("data-mode") || "auto",
      targetAccountId: document.getElementById("cfg-targetAccountId").value.trim(),
      targetDeviceId: document.getElementById("cfg-targetDeviceId").value.trim()
    };
  }

  async function loadConfig() {
    try {
      var r = await apiGet("/api/config");
      if (r && r.ok && r.config) fillForm(r.config);
    } catch (e) { toast("加载配置失败：" + e); }
  }

  async function saveConfig() {
    try {
      var r = await apiPost("/api/config", readForm());
      if (r && r.ok) {
        toast("配置已保存");
        if (r.config) fillForm(r.config);
        refreshStatus();
      } else {
        toast("保存失败：" + (r && r.error ? r.error : "未知错误"));
      }
    } catch (e) { toast("保存失败：" + e); }
  }

  // --------------------------------------------------------------
  // 状态
  // --------------------------------------------------------------
  function badge(cls, text) { return '<span class="badge ' + cls + '">' + text + "</span>"; }

  function wsBadge(state) {
    if (state === "open") return badge("on", "已连接");
    if (state === "connecting" || state === "authenticating") return badge("wait", "连接中");
    return badge("off", "未连接");
  }

  async function refreshStatus() {
    try {
      var s = await apiGet("/api/status");
      if (!s || !s.ok) return;

      document.getElementById("st-ws").innerHTML = wsBadge(s.wecom.wsState);
      document.getElementById("st-bot").innerHTML = s.wecom.botConfigured
        ? badge("on", "已配置") : badge("off", "未配置");
      document.getElementById("st-webhook").innerHTML = s.wecom.groupWebhookConfigured
        ? badge("on", "已配置") : badge("off", "未配置");

      var dev = s.miot.lastDevice || {};
      document.getElementById("st-device").textContent = dev.device_name || "未知";

      document.getElementById("st-keywords").textContent = (s.wakeKeywords || []).join(" / ");
      document.getElementById("st-count").textContent = s.messageCount + " 条";
      document.getElementById("st-time").textContent = s.serverTimeText || "-";
    } catch (e) {}
  }

  // --------------------------------------------------------------
  // 入站 webhook 状态 / 注册 / 复制
  // --------------------------------------------------------------
  function renderInbound(ib) {
    if (!ib) return;
    if (ib.url) document.getElementById("inbound-url").value = ib.url;
    var el = document.getElementById("register-status");
    if (ib.checking) {
      el.innerHTML = '<span class="badge wait">检查中</span>';
    } else if (ib.registered) {
      el.innerHTML = badge("on", "已注册") +
        (ib.lastCheckedText ? ' <span style="color:var(--muted)">' + ib.lastCheckedText + "</span>" : "");
    } else {
      el.innerHTML = badge("off", "未注册") +
        (ib.detail ? ' <span style="color:var(--fail)">' + escapeHtml(ib.detail) + "</span>" : "");
    }
  }

  async function refreshInbound() {
    try {
      var r = await apiGet("/api/inbound/status");
      if (r && r.ok && r.inbound) renderInbound(r.inbound);
    } catch (e) {}
  }

  async function doRegister() {
    var el = document.getElementById("register-status");
    el.innerHTML = '<span class="badge wait">注册中…</span>';
    try {
      var r = await apiPost("/api/inbound/register", {});
      if (r && r.ok) {
        toast(r.already ? "webhook 已注册" : "注册成功");
        renderInbound(r.inbound);
      } else {
        el.innerHTML = badge("off", "失败") +
          ' <span style="color:var(--fail)">' + escapeHtml(r && r.error || "未知错误") + "</span>";
        toast("注册失败：" + (r && r.error || "未知错误"), 3500);
      }
    } catch (e) {
      toast("注册失败：" + e, 3500);
    }
  }

  function copyInboundUrl() {
    var input = document.getElementById("inbound-url");
    if (!input.value) { toast("地址还未生成，请先保存配置"); return; }
    input.select();
    var done = false;
    try { done = document.execCommand("copy"); } catch (e) {}
    if (navigator.clipboard) { navigator.clipboard.writeText(input.value); done = true; }
    toast(done ? "地址已复制" : "复制失败，请手动选择");
  }

  // --------------------------------------------------------------
  // 传话记录
  // --------------------------------------------------------------
  var DIR_META = {
    in: { icon: "🔊", label: "孩子 → 爸爸" },
    out: { icon: "💬", label: "爸爸 → 小爱" }
  };

  async function refreshMessages() {
    try {
      var r = await apiGet("/api/messages?limit=50");
      if (!r || !r.ok) return;
      var box = document.getElementById("messages");
      if (!r.messages || !r.messages.length) {
        box.innerHTML = '<div class="empty">暂无传话记录</div>';
        return;
      }
      box.innerHTML = r.messages.map(function (m) {
        var meta = DIR_META[m.dir] || { icon: "•", label: "" };
        var statusText = {
          delivered: "已送达企微", broadcast: "已播报",
          failed: "失败", pending: "处理中"
        }[m.status] || m.status;
        var detail = (m.status === "failed" && m.detail)
          ? '<div class="detail">' + escapeHtml(m.detail) + "</div>" : "";
        return '<div class="msg"><div class="dir">' + meta.icon + '</div>' +
          '<div class="body"><div class="text">' + escapeHtml(m.text) + "</div>" +
          '<div class="meta">' + escapeHtml(meta.label) + " · " + escapeHtml(m.timeText || "") +
          '<span class="st ' + escapeHtml(m.status) + '">' + escapeHtml(statusText) + "</span>" +
          "</div>" + detail + "</div></div>";
      }).join("");
    } catch (e) {}
  }

  // --------------------------------------------------------------
  // 测试
  // --------------------------------------------------------------
  async function runTest(target, name) {
    toast(name + "…");
    try {
      var r = await apiPost("/api/test", { target: target });
      if (r && r.ok) toast(name + "成功");
      else toast(name + "失败：" + (r && r.error ? r.error : "未知错误"), 3500);
    } catch (e) { toast(name + "失败：" + e, 3500); }
  }

  // --------------------------------------------------------------
  // 绑定 & 初始化
  // --------------------------------------------------------------
  document.getElementById("save-btn").addEventListener("click", saveConfig);
  document.getElementById("refresh-status").addEventListener("click", refreshStatus);
  document.getElementById("refresh-msgs").addEventListener("click", refreshMessages);
  document.getElementById("test-wecom").addEventListener("click", function () {
    runTest("wecom-push", "企微推送");
  });
  document.getElementById("test-tts").addEventListener("click", function () {
    runTest("tts", "小爱播报");
  });
  document.getElementById("register-now").addEventListener("click", doRegister);
  document.getElementById("copy-url").addEventListener("click", copyInboundUrl);
  document.querySelectorAll("#inbound-seg button").forEach(function (b) {
    b.addEventListener("click", function () {
      setInboundMode(b.getAttribute("data-mode"));
    });
  });

  loadConfig();
  refreshStatus();
  refreshMessages();
  refreshInbound();
  setInterval(refreshStatus, 10000);
  setInterval(refreshMessages, 8000);
  setInterval(refreshInbound, 15000);
})();
