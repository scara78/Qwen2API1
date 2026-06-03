# 🌌 Qwen-2API Gateway Workstation (v1.0.0 Release)

> 🚀 **基于通义千问 (Qwen Web) 官方通道重构的工业级全栈 OpenAI 兼容格式 API 代理网关**。  
> 汇集了极简高档 Matte Dark 全栈控制台、标准 OpenAI 图像生成接口、多模态附件物理直传与解析、多路并发令牌池调度、容灾失败自动轮转等多项前沿黑科技。

---

## 🌟 核心特性与技术亮点

### 1. 📊 极简扁平化 Matte Dark 控制大屏 (SPA Admin)
* **工业视觉美学**：彻底剔除刺眼闪烁的霓虹与极光特效，重绘为符合 GitHub / Vercel 工业美学的 **Flat Matte Slate & Charcoal** 经典深灰纯色扁平化风格。线条细致，视觉高级，长久使用极度舒适。
* **立体指标大屏**：实时渲染的 API 响应成功率环形图（带中心实时百分比显示）、响应速度趋势折线图、并发排队仪表、令牌池账号数以及后台实时运行日志。
* **在线调试Playground**：内置沉浸式聊天沙盒。完美折叠 Qwen 思考推理过程（思维链推理盒），支持 Deep Research 搜索步骤仪渲染、多媒体通义万相绘画与视频卡片展示。

### 2. 🖼️ 标准图像生成接口 (`/v1/images/generations`)
* **OpenAI 宽高映射**：自动转换第三方工具请求的 OpenAI 标准尺寸（如 `1024x1024`, `1920x1080` 等）为通义千问官方所支持的 aspect ratio（`1:1`, `16:9`, `9:16`, `4:3`, `3:4`）。
* **格式双支持**：支持以 `url` 直接回传图片链接，或者以 `b64_json` 格式直接返回 Base64 图片字节码，无缝对接各类主流第三方绘图客户端。
* **负载均衡与自愈重试**：完美挂载于网关的多账号轮询队列，享受并发限流保护与 3 次透明故障切换重试。

### 3. 🎬📄 多模态附件上传与文档解析 (Base64图片/PDF/音频)
* **智能输入解析**：深度解析 standard OpenAI 数组格式的 `content`，提取出里面的 Base64 图像数据、PDF 文档以及音频文件。
* **同步阿里云 v4 签名算法**：内置手写的 Node 纯算法级阿里云 OSS v4 签名头生成器，获取 StsToken 后直接向阿里云 OSS 节点直传物理文件，并自动完成 PDF 文档后台异步转码，最后物理拼装进 Qwen 官方对话树的 `files` 字段中！
* **独立作用域隔离**：所有文件上传均在动态分配的多账号 Token 槽内进行，防止跨账户文件越权与泄露，确保绝对安全。

### 4. 🛡️ Baxia 风控绕过与 5分钟动态自愈巡检
* **Alibaba WAF 伪装**：采用精心调教的 WebGL Fingerprint 设备指纹伪装与阿里 `wu.json` ETag 机制，高保真生成 `bx-ua` 与 `bx-umidtoken`，从而完全绕过上游文件上传及接口风控的拦截。
* **五分钟容灾自愈**：后台启动了定时巡检，一旦发现某个 Token 暂时受限或掉线，会自动检测网络并在可用时自动唤醒自愈，同时自动保存配置并向管理员提示。

### 5. 🧠 原生多轮对话树链重写与透明自动轮转
* **精确的树指针算法**：底层会自动为 Qwen 官方所需的复杂多轮 node 树自动生成 `fid` 和 `parent_id` 关系指针链，记忆深度、语境保真度直接拉满！
* **3 倍透明容灾重试**：当某个 Token 发生并发上限限流或调用失败时，网关会对客户端保持完全透明，自动剔除该 Token 并轮转至下一个健康 Token，支持最多 3 次快速重试，确保极高稳定性。

### 6. ⚡ 生产级专属王牌功能 (v1.0.0 Enterprise Ready)
* **🔄 原生 Function Calling 工具链完美闭环**：彻底解决工具调用完毕后会话中断返回“空回复”的问题。在 `preprocessMessages` 中自动将 assistant `tool_calls` 反向还原为官方底层深度理解的 XML `<tool_call>` 标签，同时在 `parseSSEStream` 中支持对思考大模型原生工具呼叫的秒级拦截，打造 100% 协议级生命周期闭环。
* **🔑 账号单 Token 手动登录刷新**：支持在前端控制台“令牌管理”面板中，针对个别掉线或接近过期的 Token 进行手动一键刷新或输入最新 JWT 校验登录，再也无需繁琐地删除后重新添加。
* **📁 高性能逆向 Seek 日志分页器**：网关后台日志文件过大时，普通的日志读取极易发生卡死。我们手写了轻量高效的 Seek 逆向读取引擎，先高速统计 `\n`，再自文件尾部向头部执行 reverse seeks 定量提取日志行，配合前端 `◀ 较新` 与 `较旧 ▶` 按钮极致流畅分页加载。
* **📥 一键 Excel 友好 CSV 导出**：调用历史日志一键离线导出为 CSV 文件。数据流首部强行注入 **UTF-8 BOM 字节序 (`\uFEFF`)**，完美解决 Windows 平台下 Excel 打开 CSV 中文字符乱码的行业痛点。
* **🔑 密码与鉴权零绕过加固**：强制管理员访问控制。支持 `ADMIN_PASSWORD` 环境变量和安全密码兜底（默认强制校验 `'admin123'`），严防匿名用户空密码进驻控制台，保障网关接口的绝对安全。
* **🧹 历史快照与老旧模型智能净化**：自动检测并过滤掉官方后台返回的所有带有 `-\d{4}` 快照日期后缀及被淘汰的历史大模型，使客户端（如 LobeChat/NextChat）的大模型选项菜单保持绝对清爽与极简。

---

## 📂 项目结构

```text
├── data/                  # 运行时动态数据库孤立目录 (已加入 .gitignore，安全防漏)
│   ├── tokens.json        # 动态令牌池存储数据库
│   ├── config.json        # 系统动态配置存储数据库
│   └── system.log         # 持久化运行与自愈巡检日志
├── frontend/              # 极美全栈一站式控制台静态资产
│   └── index.html         # 精致极简 Matte Dark SPA 前端主页面
├── src/                   # 网关服务核心源码
│   ├── auth.js            # 令牌池状态、官方校验、物理下线及自愈恢复 Worker
│   ├── chat.js            # Qwen Web 原生 SSE 接口协议序列化与推理流解析
│   ├── db.js              # 基于安全锁并发读写 data/ 动态配置的数据库驱动
│   ├── headers.js         # 防封爬虫请求头防关联混淆混流伪装
│   ├── index.js           # 主服务 Express 路由、鉴权中间件及热配置管理器
│   ├── logger.js          # 持久化 system.log 系统日志记录器
│   ├── models.js          # Qwen 模型官方列表获取与 OpenAI 兼容形态转换
│   ├── openai.js          # OpenAI 规范映射、多模态附件解析、图像生成接口及 3 倍容灾重试
│   └── queue.js           # 物理队列并发控制与排队超时防爆器
├── package.json           # 项目元数据与依赖配置
└── .gitignore             # 极净规则（自动过滤运行时数据与敏感 env）
```

---

## ⚡ 快速开始

### 1. 克隆并安装依赖
```bash
# 克隆项目
git clone https://github.com/henryz78/Qwen2API.git
cd Qwen2API

# 安装核心 Node 依赖
npm install
```

### 2. 配置环境变量
复制根目录下的 `.env.example` 并重命名为 `.env`：
```env
PORT=3000
```
*(网关支持运行时热修改参数，配置、密码与 key 将直接以 JSON 持久化存储在 `data/config.json` 中，无需重启服务)*。

### 3. 启动网关服务
```bash
# 开发热重载模式
npm run dev

# 生产运行模式
npm start
```

服务启动后：
* **控制台面板 SPA**：打开浏览器访问 [http://localhost:3000/admin](http://localhost:3000/admin)
* **OpenAI 兼容对话端点**：`POST http://localhost:3000/v1/chat/completions`
* **OpenAI 兼容画图端点**：`POST http://localhost:3000/v1/images/generations`

---

## ⚙️ 管理员安全与热配置

在面板的 **“系统设置”** 中，您可以热修改以下参数且**即刻生效**：
1. **系统管理密码**：保护控制台，防止未经授权的访问。若为空则无需密码登录控制台。
2. **API 访问 Key**：即 OpenAI 调用时请求头中 `Authorization: Bearer <API_KEY>` 所需的认证密钥。
3. **单 Token 并发数上限**：控制池内单个账号允许的最大瞬时并发查询，默认建议为 10，高风控环境下可设为 2。
4. **排队延迟超时**：在请求堆积时，进入物理并发队列的等待缓冲时间（毫秒），默认建议为 30000 毫秒（30秒）。

---

## 🚀 API 调用示例 (OpenAI 兼容)

### 1. 基础对话 (非流式)
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {"role": "user", "content": "你好，请自我介绍一下。"}
    ]
  }'
```

### 2. 流式推理对话 (支持推理步骤/思考过程折叠)
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {"role": "user", "content": "你好，请详细解释一下什么是量子纠缠。"}
    ],
    "stream": true
  }'
```

### 3. 多模态附件直传 (支持 PDF、图片或音频)
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "分析这张图片里有哪些文字并详细描述它的内容："},
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg=="
            }
          }
        ]
      }
    ]
  }'
```

### 4. 通义万相标准绘图 (`/v1/images/generations`)
```bash
curl http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{
    "prompt": "一只在太空漫步的高科技猫咪，赛博朋克风格",
    "n": 1,
    "size": "1024x1024",
    "response_format": "url"
  }'
```

---

## 🛡️ 免责声明与许可

本软件仅用于个人学习交流与技术研究目的，严禁用于任何商业非法用途。因使用本网关导致的账号封禁或任何关联法律纠纷，均由使用者自行承担。

*Licensed under the MIT License.*
