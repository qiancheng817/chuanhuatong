/*
 * 传话筒插件配置页逻辑
 * 依赖宿主注入的 window.SongloftPlugin（apiGet / apiPost）。
 */
(function () {
  "use strict";

  var api = (window.SongloftPlugin || {});

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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  // ----------------------------------------------------------------
  // 配置表单
  // ----------------------------------------------------------------
  function fillForm(cfg) {
    document.getElementById("cfg-bridgeUrl").value = cfg.bridgeUrl || "";
    document.getElementById("cfg-bridgeToken").value = cfg.bridgeToken || "";
    document.getElementById("cfg-wecomMode").value = cfg.wecomMode || "bridge-ws";
    document.getElementById("cfg-groupWebhookUrl").value = cfg.groupWebhookUrl || "";
    document.getElementById("cfg-wakeKeywords").value = (cfg.wakeKeywords || []).join(",");
    document.getElementById("cfg-senderName").value = cfg.senderName || "";
    document.getElementById("cfg-replyPrefix").value = cfg.replyPrefix || "";
    document.getElementById("cfg-confirmText").value = cfg.confirmText || "";
    document.getElementById("cfg-stripKeyword").checked = cfg.stripKeyword !== false;
  }

  function readForm() {
    return {
      bridgeUrl: document.getElementById("cfg-bridgeUrl").value.trim(),
      bridgeToken: document.getElementById("cfg-bridgeToken").value,
      wecomMode: document.getElementById("cfg-wecomMode").value,
      groupWebhookUrl: document.getElementById("cfg-groupWebhookUrl").value.trim(),
      wakeKeywords: document.getElementById("cfg-wakeKeywords").value,
      senderName: document.getElementById("cfg-senderName").value.trim() || "孩子",
      replyPrefix: document.getElementById("cfg-replyPrefix").value.trim(),
      confirmText: document.getElementById("cfg-confirmText").value.trim(),
      stripKeyword: document.getElementById("cfg-stripKeyword").checked
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

  // ----------------------------------------------------------------
  // 运行状态
  // ----------------------------------------------------------------
  function badge(on, onText, offText) {
    if (on) return '<span class="badge on">' + onText + "</span>";
    return '<span class="badge off">' + offText + "</span>";
  }

  async function refreshStatus() {
    try {
      var s = await apiGet("/api/status");
      if (!s || !s.ok) return;
      document.getElementById("st-bridge").innerHTML = s.bridge.configured
        ? badge(true, "已配置", "") + " " + escapeHtml(s.bridge.url)
        : badge(false, "", "未配置");
      document.getElementById("st-mode").textContent =
        s.wecom.mode === "group-webhook" ? "群机器人 Webhook" : "桥接长连接";
      document.getElementById("st-webhook").innerHTML =
        s.wecom.groupWebhookConfigured ? badge(true, "已配置", "") : badge(false, "", "未配置");
      document.getElementById("st-keywords").textContent = (s.wakeKeywords || []).join(" / ");
      document.getElementById("st-count").textContent = s.messageCount + " 条";
      document.getElementById("st-time").textContent = s.serverTimeText || "-";
    } catch (e) { /* 忽略刷新失败 */ }
  }

  // ----------------------------------------------------------------
  // 传话记录
  // ----------------------------------------------------------------
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
          delivered: "已送达企微",
          broadcast: "已播报",
          failed: "失败",
          pending: "处理中"
        }[m.status] || m.status;
        var detail = (m.status === "failed" && m.detail)
          ? '<div class="detail">' + escapeHtml(m.detail) + "</div>" : "";
        return '<div class="msg">' +
          '<div class="dir">' + meta.icon + '</div>' +
          '<div class="body">' +
            '<div class="text">' + escapeHtml(m.text) + "</div>" +
            '<div class="meta">' + escapeHtml(meta.label) +
              " · " + escapeHtml(m.timeText || "") +
              '<span class="st ' + escapeHtml(m.status) + '">' + escapeHtml(statusText) + "</span>" +
            "</div>" +
            detail +
          "</div></div>";
      }).join("");
    } catch (e) { /* 忽略 */ }
  }

  // ----------------------------------------------------------------
  // 测试
  // ----------------------------------------------------------------
  async function runTest(target, name) {
    toast(name + "…");
    try {
      var r = await apiPost("/api/test", { target: target });
      if (r && r.ok) {
        toast(name + "成功");
      } else {
        toast(name + "失败：" + (r && r.error ? r.error : "未知错误"), 3500);
      }
    } catch (e) {
      toast(name + "失败：" + e, 3500);
    }
  }

  // ----------------------------------------------------------------
  // 绑定事件 & 初始化
  // ----------------------------------------------------------------
  document.getElementById("save-btn").addEventListener("click", saveConfig);
  document.getElementById("refresh-status").addEventListener("click", refreshStatus);
  document.getElementById("refresh-msgs").addEventListener("click", refreshMessages);
  document.getElementById("test-bridge").addEventListener("click", function () {
    runTest("bridge", "测试桥接服务");
  });
  document.getElementById("test-wecom").addEventListener("click", function () {
    runTest("wecom", "测试企微推送");
  });
  document.getElementById("test-tts").addEventListener("click", function () {
    runTest("tts", "测试小爱播报");
  });

  loadConfig();
  refreshStatus();
  refreshMessages();
  setInterval(refreshStatus, 15000);
  setInterval(refreshMessages, 8000);
})();
