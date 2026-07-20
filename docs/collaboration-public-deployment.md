# T8 协作公网反向代理

公网协作必须由 HTTPS 反向代理终止 TLS，T8 网关继续只监听本机回环地址。不要把 `18767` 端口直接暴露到公网，也不要使用明文 HTTP 作为正式公网地址；明文公网会禁用 owner 管理操作和敏感原文件下载。

## 后端环境

把域名替换为实际域名，并把可信代理地址限制为与 T8 直接相连的那一个地址：

```text
T8_COLLAB_HOST=127.0.0.1
T8_COLLAB_PORT=18767
T8_COLLAB_PUBLIC_BASE_URL=https://canvas.example.com/collab
T8_COLLAB_ALLOWED_ORIGINS=https://canvas.example.com
T8_COLLAB_TRUST_PROXY_ADDRESSES=127.0.0.1,::1
```

`T8_COLLAB_TRUST_PROXY_ADDRESSES` 只接受精确 IP，不接受“任意代理”或跳数。若代理运行在容器中，应填写实际直接对端 IP，并把网关绑定到仅该代理可达的私有接口；不要为了省事信任整个公网或任意网段。

`T8_COLLAB_PUBLIC_BASE_URL` 是用户打开的协作入口，路径必须以 `/collab` 结尾；`T8_COLLAB_ALLOWED_ORIGINS` 只填写同源的 `scheme://host[:port]`，不要附带路径。只有来自显式可信代理、主机名匹配且 `X-Forwarded-Proto` 精确为 `https` 的公网请求才会获得完整能力；绕过代理直连网关会继续安全降级。

## 滥用防护默认值

网关同时按真实客户端 IP 和已认证 session 分层计费；可信代理只从 `T8_COLLAB_TRUST_PROXY_ADDRESSES` 的精确直接对端解析 `X-Forwarded-For`。默认预算如下，任一层超额都会拒绝，不能靠轮换 session 绕过 IP 层：

- 邀请兑换：每 IP、每邀请码各 12 次/分钟；
- 上传：每 IP 600 次、1 GiB/分钟；每 session 300 次、512 MiB/分钟；
- 下载：每 IP 600 次/分钟、64 MiB/秒；每 session 300 次/分钟、32 MiB/秒；
- WebSocket：每 IP 64 条连接、120 次握手/分钟；每 session 8 条连接、60 次握手/分钟；消息再按 presence、heartbeat、join、unknown 四类使用 10 秒窗口；
- 活跃限额桶默认最多 4096 个，达到上限时对新身份失败关闭。

对应环境变量以 `T8_COLLAB_INVITE_*`、`T8_COLLAB_UPLOAD_*`、`T8_COLLAB_DOWNLOAD_*`、`T8_COLLAB_WS_*` 和 `T8_COLLAB_RATE_LIMIT_MAX_BUCKETS` 开头。服务端会把数值夹在安全上下限内；正式调大前必须完成连接、吞吐、100 MiB+ 上传、10 万素材和存储增长压测。HTTP 超额响应包含稳定 `429` 与 `Retry-After`，WebSocket 消息超额使用稳定 `1013` 关闭并提示重试窗口。

## 代理示例

- Nginx：`deploy/collaboration/nginx.conf.example`
- Caddy：`deploy/collaboration/Caddyfile.example`

两个示例都保留 `/api/collab/**`、`/ws/collab`、上传请求和 Range 响应的原始路径。Nginx 配置显式透传 WebSocket Upgrade；Caddy 的 `reverse_proxy` 原生支持 WebSocket。示例上传上限为 512 MiB，修改 `T8_COLLAB_MAX_UPLOAD_BYTES` 时必须同步调整代理上限。

Nginx 示例中的证书路径需要替换后再执行：

```text
nginx -t -c /absolute/path/nginx.conf
```

Caddy 示例可先格式化和校验：

```text
caddy fmt --overwrite /absolute/path/Caddyfile
caddy validate --config /absolute/path/Caddyfile
```

只在确认域名已稳定提供 HTTPS 后启用 HSTS；示例默认启用一年 HSTS，试运行域名若仍可能回退 HTTP，应先移除该响应头。

## 上线自检

启动网关并设置公网地址后，从主机管理面板运行“公网自检”。完整通过必须同时验证：

1. `GET /api/collab/health` 可达；
2. 邀请兑换路径可穿过代理，但不会创建真实成员或会话；
3. `/ws/collab` Upgrade 成功；
4. 小型上传请求不被代理缓冲或改写；
5. 单字节 Range 请求返回精确 `206`。

自检失败时不要发布邀请。先核对 DNS、证书/SNI、代理路径、WebSocket Upgrade、请求体上限、Range 响应和可信代理地址；自检使用一次性短期挑战，不会写入项目素材或协作成员数据。
