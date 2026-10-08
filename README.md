# 传话筒 chuanhuatong

[Songloft](https://github.com/songloft-org/songloft) JS 插件：让**小爱音箱**与**企业微信**实现双向传话。

- 孩子在家对小爱说：「**小爱同学，告诉爸爸，我想吃西瓜**」
- 爸爸的企业微信收到机器人推送：「【孩子传话】我想吃西瓜」
- 爸爸直接在机器人会话里打字：「**好，下班买**」
- 小爱音箱自动播报：「**爸爸说，好，下班买**」

## 架构

```
孩子的语音
    │
    ▼
小爱音箱 ──MiNA 云端对话记录（轮询）──► chuanhuatong-bridge（Docker）
                                          │ POST /relay/inbound
                                          ▼
                              Songloft · 传话筒插件（配置 / 记录 / 路由）
                                          │ POST /wecom/send
                                          ▼
                          企业微信智能机器人（WebSocket 长连接）──► 爸爸
爸爸打字 ──► 智能机器人 ──WS──► bridge ──/relay/outbound──► 插件
                                          │ POST /xiaoai/tts
                                          ▼
                                       小爱音箱播报
```

为什么需要 bridge：Songloft 插件运行在 QuickJS 沙箱中，无法直接完成小米账号登录和企业微信 WebSocket 长连接；bridge 是一个轻量协议适配容器，所有消息**仍然经过 Songloft 插件中转、落库、可配置**。

## 组件

| 目录 | 说明 |
|---|---|
| 根目录 `plugin.json` / `src/` / `static/` | Songloft 插件源码与配置页 |
| `dist/chuanhuatong.jsplugin.zip` | 已构建好的插件安装包 |
| `bridge/` | 桥接服务（小爱 + 企微），Docker 部署 |
| `scripts/build.ps1` | 插件构建脚本（Windows PowerShell，无需 Node） |

---

## 部署步骤

### 第一步：创建企业微信智能机器人

1. 打开企业微信客户端 → **工作台 → 智能机器人 → 创建机器人 → 手动创建**
2. 选择 **API 模式创建**
3. 连接方式选择 **「使用长连接」**（无需公网域名 / IP）
4. 保存页面生成的 **Bot ID** 和 **Secret**
5. 配置机器人**可见范围**（包含你自己），保存
6. 在单聊中给机器人发一句话（如「你好」），用于完成会话初始化

> 群聊中使用：在群里 @机器人 发送内容即可。

### 第二步：安装 Songloft 插件

1. 下载本仓库 `dist/chuanhuatong.jsplugin.zip`
2. Songloft 客户端 → 设置 → 插件管理 → 上传该 zip
3. 启用「传话筒」插件，打开插件页面

### 第三步：配置插件

在插件页面填写：

| 配置项 | 说明 | 示例 |
|---|---|---|
| 桥接服务地址 | bridge 的访问地址 | `http://192.168.1.100:8788` |
| 桥接共享密钥 | 自定义随机字符串，插件与 bridge 必须一致 | `my-secret-2026` |
| 企微出站方式 | 桥接长连接（推荐） | `bridge-ws` |
| 唤醒词 | 孩子语音必须以其中一个开头，逗号分隔 | `告诉爸爸,呼叫爸爸` |
| 发送方称呼 | 推送企微时的署名 | `孩子` |
| 小爱播报前缀 | 爸爸回话的播报前缀 | `爸爸说` |
| 企微确认语 | 爸爸发消息后的回执 | `已转告小爱音箱` |

点击「保存配置」。

### 第四步：部署 bridge（Docker）

在 NAS（如飞牛 fnOS）上：

```bash
cd bridge
cp .env.example .env
vi .env        # 按下面的说明填写
docker compose up -d --build
docker compose logs -f
```

`.env` 字段：

```ini
# 小米账号（建议使用一个专门的小米账号，避免风控影响主账号）
MI_USER=你的小米账号
MI_PASS=你的小米密码
MI_DID=客厅小爱音箱            # 设备名称 / deviceID / 序列号，留空用第一台

# 企微智能机器人
WECOM_BOT_ID=第一步保存的 Bot ID
WECOM_BOT_SECRET=第一步保存的 Secret

# Songloft 插件地址（末尾不要带 /）
SONGLOFT_PLUGIN_URL=http://192.168.1.10:58091/api/v1/jsplugin/chuanhuatong
BRIDGE_TOKEN=与插件配置一致的密钥
```

日志看到以下内容即为成功：

```
小爱音箱：客厅小爱音箱（deviceID=...）
bridge HTTP 监听 0.0.0.0:8788
以当前最新对话为基线：...
企业微信智能机器人长连接已建立
```

### 第五步：验证

在插件页面点击：

1. **测试桥接服务** — 检查插件到 bridge 的连通性
2. **测试企微推送** — 企业微信应收到「传话筒连通性测试」
3. **测试小爱播报** — 小爱音箱应播报「传话筒连通性测试」

然后让孩子实际说一次：「小爱同学，告诉爸爸，我放学啦」。

---

## 小米账号两步验证（OTP）

首次登录若触发安全验证，bridge 日志会提示等待验证码：

- 方式一：在 `.env` 中设置 `MI_OTP=收到的验证码`，重启容器
- 方式二：把验证码写入 `bridge/data/otp.txt`，bridge 自动读取，无需重启

登录成功后令牌缓存在 `bridge/data/.mi.token`，后续无需重复登录。

## 常见问题

**Q：测试企微推送提示「无可用 chatid」？**
A：先在企业微信里打开机器人单聊发一句话，或在群里 @机器人 发一句话。

**Q：日志显示插件调用 401？**
A：插件配置页的「桥接共享密钥」与 bridge `.env` 的 `BRIDGE_TOKEN` 不一致。

**Q：孩子说了但企微没收到？**
A：① 确认语音以唤醒词开头；② 查看 bridge 日志轮询是否正常；③ 插件页面「传话记录」中可看到失败原因。

**Q：小爱播报有延迟？**
A：MiNA 对话记录按轮询间隔（默认 3 秒）同步，属于云端 API 方案的正常延迟。

**Q：群机器人 Webhook 模式区别？**
A：该模式只能让孩子→爸爸方向生效（企微群 webhook 不支持接收消息），爸爸回话仍需智能机器人长连接。

## 本地构建

Windows 下执行（无需安装 Node.js）：

```powershell
.\scripts\build.ps1
```

产物输出到 `dist/chuanhuatong.jsplugin.zip`。

## 免责声明

本项目为第三方非营利开源项目，与小米集团、腾讯企业微信无隶属关系；仅供个人家庭场景学习使用。
