#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
传话筒桥接服务（chuanhuatong-bridge）

职责：
  1. 轮询小爱音箱 MiNA 云端对话记录，把用户的话转发给 Songloft 传话筒插件；
  2. 接收插件下发的企微推送，通过企业微信「智能机器人」WebSocket 长连接发送；
  3. 接收插件下发的 TTS 文本，调用小爱音箱播报；
  4. 长连接接收企微消息，转发给插件（最终由小爱播报）。

对外 HTTP（X-Bridge-Token 鉴权）：
  GET  /health
  POST /wecom/send     {"text": "...", "chatid": "可选"}
  POST /xiaoai/tts     {"text": "...", "deviceId": "可选"}
"""

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from uuid import uuid4

from aiohttp import ClientSession, ClientTimeout, web
from miservice import MiAccount, MiNAService
from wecom_aibot_sdk import WSClient

# --------------------------------------------------------------------
# 配置（环境变量）
# --------------------------------------------------------------------
def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


MI_USER = env("MI_USER")
MI_PASS = env("MI_PASS")
MI_DID = env("MI_DID")  # 音箱 deviceID / 名称 / 序列号，留空使用第一台

BOT_ID = env("WECOM_BOT_ID")
BOT_SECRET = env("WECOM_BOT_SECRET")

PLUGIN_URL = env(
    "SONGLOFT_PLUGIN_URL",
    "http://host.docker.internal:58091/api/v1/jsplugin/chuanhuatong",
)
BRIDGE_TOKEN = env("BRIDGE_TOKEN")

POLL_INTERVAL = float(env("POLL_INTERVAL", "3"))
HTTP_PORT = int(env("BRIDGE_PORT", "8788"))
DATA_DIR = Path(env("DATA_DIR", "/data"))

MI_TOKEN_PATH = str(DATA_DIR / ".mi.token")
BASELINE_FILE = DATA_DIR / "last_conv.txt"
CHAT_CACHE_FILE = DATA_DIR / "last_chat.json"
OTP_FILE = DATA_DIR / "otp.txt"

CONV_API = "https://userprofile.mina.mi.com/device_profile/v2/conversation"
UA_DIALOG = (
    "Mozilla/5.0 (Linux; Android 10; 000; wv) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36 "
    "/XiaoMi/HybridView/ micoSoundboxApp/i appVersion/A_2.4.40"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("chuanhuatong")

state = {
    "device_id": "",
    "device_name": "",
    "hardware": "",
    "chatid": "",
}

http: ClientSession = None  # type: ignore
account: MiAccount = None  # type: ignore
mina: MiNAService = None  # type: ignore
wsclient: WSClient = None  # type: ignore


# --------------------------------------------------------------------
# 小米登录 OTP 回调
# --------------------------------------------------------------------
async def otp_callback(method: str) -> str:
    """等待用户通过 MI_OTP 环境变量或 /data/otp.txt 提供两步验证码。"""
    log.warning("小米账号触发两步验证（%s），等待验证码…", method)
    for _ in range(600):  # 最多等待 20 分钟
        code = env("MI_OTP")
        if not code and OTP_FILE.exists():
            code = OTP_FILE.read_text(encoding="utf-8").strip()
        if code:
            try:
                OTP_FILE.unlink()
            except OSError:
                pass
            os.environ["MI_OTP"] = ""
            log.info("已获取两步验证码")
            return code
        await asyncio.sleep(2)
    raise RuntimeError("等待小米两步验证码超时")


# --------------------------------------------------------------------
# 小爱设备初始化 / 对话记录拉取
# --------------------------------------------------------------------
async def init_devices() -> None:
    devices = await mina.device_list()
    if not devices:
        raise RuntimeError("小米账号下未找到小爱音箱设备")

    dev = None
    if MI_DID:
        for d in devices:
            candidates = [
                str(d.get("deviceID", "")),
                str(d.get("name", "")),
                str(d.get("alias", "")),
                str(d.get("serialNumber", "")),
                str(d.get("miotDID", "")),
            ]
            if MI_DID in candidates:
                dev = d
                break
        if dev is None:
            log.warning("MI_DID=%s 未匹配到设备，将使用第一台设备", MI_DID)
    if dev is None:
        dev = devices[0]

    state["device_id"] = str(dev.get("deviceID", ""))
    state["device_name"] = str(dev.get("alias") or dev.get("name") or "小爱音箱")
    state["hardware"] = str(dev.get("hardware", ""))
    log.info(
        "小爱音箱：%s（deviceID=%s, hardware=%s）",
        state["device_name"], state["device_id"], state["hardware"] or "-",
    )


async def ensure_mina(force: bool = False) -> None:
    if account.token is None:
        account.token = await account.token_store.load_token()
    if force and account.token and "micoapi" in account.token:
        del account.token["micoapi"]
    if not (account.token and "micoapi" in account.token):
        ok = await account.login("micoapi")
        if not ok:
            raise RuntimeError(
                "小米账号登录失败；如触发两步验证，请设置 MI_OTP 环境变量"
                "或向 /data/otp.txt 写入验证码后重试"
            )


async def fetch_records(limit: int = 20) -> list:
    await ensure_mina()
    params = {"limit": str(limit), "requestId": uuid4().hex, "source": "dialogu"}
    if state["hardware"]:
        params["hardware"] = state["hardware"]
    url = CONV_API + "?" + urlencode(params)
    cookies = {
        "userId": str(account.token.get("userId", "")),
        "serviceToken": account.token["micoapi"][1],
        "deviceId": str(account.token.get("deviceId", "")),
    }
    headers = {
        "User-Agent": UA_DIALOG,
        "Referer": "https://userprofile.mina.mi.com/dialogue-note/index.html",
    }
    async with http.get(
        url, cookies=cookies, headers=headers, timeout=ClientTimeout(total=15)
    ) as resp:
        data = await resp.json(content_type=None)

    if data.get("code", -1) != 0:
        message = str(data.get("message", ""))
        if "auth" in message.lower():
            await ensure_mina(force=True)
            raise RuntimeError("service token 失效，已刷新，下轮重试")
        raise RuntimeError("conversation api 异常: " + json.dumps(data, ensure_ascii=False)[:200])

    records = (data.get("data") or {}).get("records") or []
    return records


# --------------------------------------------------------------------
# 插件调用
# --------------------------------------------------------------------
async def call_plugin(path: str, payload: dict):
    url = PLUGIN_URL.rstrip("/") + path
    async with http.post(
        url,
        json=payload,
        headers={"X-Bridge-Token": BRIDGE_TOKEN},
        timeout=ClientTimeout(total=20),
    ) as resp:
        text = await resp.text()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        data = None
    if not (200 <= resp.status < 300):
        log.error("插件调用失败 %s -> %s: %s", path, resp.status, text[:300])
    return resp.status, data, text


# --------------------------------------------------------------------
# 对话记录轮询
# --------------------------------------------------------------------
def read_baseline():
    if BASELINE_FILE.exists():
        try:
            return int(BASELINE_FILE.read_text().strip())
        except ValueError:
            return None
    return None


def write_baseline(t) -> None:
    BASELINE_FILE.write_text(str(int(t)))


async def watcher() -> None:
    last_time = read_baseline()
    if last_time is None:
        recs = await fetch_records(5)
        last_time = int(recs[0]["time"]) if recs else int(time.time() * 1000)
        write_baseline(last_time)
        log.info("以当前最新对话为基线：%s", last_time)

    log.info("小爱对话轮询启动，间隔 %ss", POLL_INTERVAL)
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        try:
            records = await fetch_records(20)
            fresh = sorted(
                [r for r in records if int(r.get("time", 0)) > last_time],
                key=lambda r: int(r.get("time", 0)),
            )
            for r in fresh:
                query = r.get("query", "")
                t = int(r.get("time", last_time))
                if query:
                    await call_plugin("/relay/inbound", {
                        "text": query,
                        "timestamp": t,
                        "device": state["device_name"],
                        "answers": len(r.get("answers") or []),
                    })
                if t > last_time:
                    last_time = t
                    write_baseline(last_time)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("轮询小爱对话记录出错，%ss 后继续", POLL_INTERVAL)


# --------------------------------------------------------------------
# 企微长连接事件
# --------------------------------------------------------------------
def remember_chat(chatid: str, chattype: str) -> None:
    if not chatid:
        return
    state["chatid"] = chatid
    CHAT_CACHE_FILE.write_text(
        json.dumps(
            {"chatid": chatid, "chattype": chattype, "updated": int(time.time())},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


async def on_text(frame) -> None:
    body = frame.body or {}
    content = (body.get("text") or {}).get("content", "").strip()
    if not content:
        return
    chattype = body.get("chattype", "single")
    chatid = body.get("chatid") or body.get("from_userid", "")
    remember_chat(chatid, chattype)

    log.info("企微收到回话：%s（chat=%s）", content, chatid)
    try:
        _, data, _ = await call_plugin("/relay/outbound", {
            "text": content,
            "chatid": chatid,
            "chattype": chattype,
        })
    except Exception:
        log.exception("转发企微回话到插件失败")
        return

    echo = ""
    if isinstance(data, dict) and data.get("ok"):
        echo = data.get("echo", "")
    if echo:
        try:
            await wsclient.reply(frame, {"msgtype": "text", "text": {"content": echo}})
        except Exception:
            log.exception("发送企微确认消息失败")


async def on_enter(frame) -> None:
    body = frame.body or {}
    chatid = body.get("chatid") or body.get("from_userid", "")
    chattype = body.get("chattype", "single")
    remember_chat(chatid, chattype)
    try:
        await wsclient.reply_welcome(frame, {
            "msgtype": "text",
            "text": {"content": "传话筒已连接，直接输入文字即可让小爱音箱播报。"},
        })
    except Exception:
        log.exception("发送欢迎语失败")


# --------------------------------------------------------------------
# 对外 HTTP 服务
# --------------------------------------------------------------------
async def health(_req) -> web.Response:
    return web.json_response({
        "ok": True,
        "service": "chuanhuatong-bridge",
        "device": state["device_name"],
        "wecom": wsclient is not None and wsclient.is_connected,
        "time": int(time.time()),
    })


def require_auth(fn):
    async def wrapper(request: web.Request) -> web.Response:
        if not BRIDGE_TOKEN:
            return web.json_response(
                {"ok": False, "error": "服务端未配置 BRIDGE_TOKEN"}, status=500
            )
        token = request.headers.get("X-Bridge-Token", "") or request.query.get("token", "")
        if token != BRIDGE_TOKEN:
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        return await fn(request)
    return wrapper


@require_auth
async def http_wecom_send(request: web.Request) -> web.Response:
    body = await request.json()
    text = body.get("text", "")
    if not text:
        return web.json_response({"ok": False, "error": "empty text"}, status=400)
    chatid = body.get("chatid") or state["chatid"]
    if not chatid:
        return web.json_response(
            {"ok": False, "error": "无可用 chatid：请先在机器人会话里发一条消息"},
            status=400,
        )
    if wsclient is None or not wsclient.is_connected:
        return web.json_response(
            {"ok": False, "error": "企微长连接未连接"}, status=503
        )
    try:
        await wsclient.send_message(
            chatid, {"msgtype": "markdown", "markdown": {"content": text}}
        )
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)
    return web.json_response({"ok": True})


@require_auth
async def http_xiaoai_tts(request: web.Request) -> web.Response:
    body = await request.json()
    text = body.get("text", "")
    if not text:
        return web.json_response({"ok": False, "error": "empty text"}, status=400)
    device_id = body.get("deviceId") or state["device_id"]
    try:
        ok = await mina.text_to_speech(device_id, text)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)
    if not ok:
        return web.json_response({"ok": False, "error": "小爱 TTS 调用失败"}, status=502)
    return web.json_response({"ok": True})


# --------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------
async def main() -> None:
    if not MI_USER or not MI_PASS:
        sys.exit("错误：请配置 MI_USER / MI_PASS（小米账号）")
    if not BRIDGE_TOKEN:
        sys.exit("错误：请配置 BRIDGE_TOKEN（与插件共享的密钥）")
    if not BOT_ID or not BOT_SECRET:
        log.warning("未配置 WECOM_BOT_ID / WECOM_BOT_SECRET，企微双向传话不可用")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if CHAT_CACHE_FILE.exists():
        try:
            cached = json.loads(CHAT_CACHE_FILE.read_text(encoding="utf-8"))
            state["chatid"] = cached.get("chatid", "")
        except (ValueError, OSError):
            pass

    global http, account, mina, wsclient
    http = ClientSession()
    account = MiAccount(http, MI_USER, MI_PASS, MI_TOKEN_PATH, otp_callback=otp_callback)
    mina = MiNAService(account)
    await init_devices()

    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_post("/wecom/send", http_wecom_send)
    app.router.add_post("/xiaoai/tts", http_xiaoai_tts)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", HTTP_PORT).start()
    log.info("bridge HTTP 监听 0.0.0.0:%s", HTTP_PORT)

    tasks = [asyncio.create_task(watcher())]

    if BOT_ID and BOT_SECRET:
        wsclient = WSClient({"bot_id": BOT_ID, "secret": BOT_SECRET})
        wsclient.on("message.text", on_text)
        wsclient.on("event.enter_chat", on_enter)
        await wsclient.connect_async()
        log.info("企业微信智能机器人长连接已建立")

    stop = asyncio.Event()
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if wsclient is not None:
            await wsclient.disconnect()
        await runner.cleanup()
        await http.close()
        log.info("bridge 已停止")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
