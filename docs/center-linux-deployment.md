# Linux 中心部署

中心为单个 Node 22 Debian 容器：管理 HTTPS（8443）和既有 relay TLS
（8790）是同一进程的独立监听器。Compose 只部署中心；Hindsight 后端及
数据库使用已有外部服务。HTTP MCP 登记现有端点，Node/npm MCP 在对应目标
的受管目录安装；不自动编排 Python、uv 或 Docker MCP。

## 构建前提

需要 Linux、Docker Engine 和 Compose 插件。先由项目维护者生成并提交与
`center-web/package.json`、`center-server/package.json` 和
`host-core/package.json` 对应的锁文件；这三个目录分别安装，且必须和
`center-contract/` 一起存在。构建不使用宿主机的 node_modules。中心服务
只通过现有 relay 源码使用 Host 模块，Host/Android 不安装中心服务器依赖。
构建包含本地的中心 Web 输出 `center-web/dist`，不访问 Host 的 Web 输出。

在仓库根目录执行（此命令也可用于无 Compose 的镜像构建）：

```sh
sh scripts/center-build.sh
```

该镜像非 root 运行；Node/npm 安装型 MCP 可能需要原生编译工具或目标平台
支持，安装失败应查看中心操作/设备回执，不能视为已部署成功。不要把 Linux
的 node_modules 复制到其他平台。桌面应用仅运行客户端 broker，不启动 Host，
因此不打包 npm，也无需 `npmPath`。Android 由 App 启动桥准备并传入原有
版本化 npm 资产路径，不新增第二份资产。独立 Node Host 可使用其安装的
`host-core` npm 11.6.2 依赖，并通过 HostService 的可选 `npmPath` 显式传入
`npm-cli.js` 绝对路径；未提供时不影响启动，但需要 npm 的安装会报告
`NPM_UNAVAILABLE`。

## 配置和启动

将受信任的 PEM 证书链及私钥分别放到 `center-certs/cert.pem` 和
`center-certs/key.pem`。两监听器使用同一证书；容器以镜像内 `node` 用户
读取挂载目录和文件，需授予该用户读取权限，且不要使私钥对其他用户可读。
证书的域名必须匹配对外地址。保护该目录，不要提交到版本库或复制到镜像。

以下示例在安全的交互式 shell 中执行，将域名替换为真实地址，勿启用
`set -x`；不要把口令、密钥写到 shell 历史或日志。文件必须妥善保护，
拥有 Docker 管理权限者也可读取容器环境变量。生成并保存独立加密密钥与
会话密钥；重启或升级必须保留加密密钥，否则无法解密已保存的凭证。

```sh
umask 077
read -r -s -p '中心所有者口令: ' owner_password; printf '\n'
owner_hash=$(printf %s "$owner_password" | docker run --rm -i e-launcher-center:local node center-server/cli.js password-hash)
unset owner_password
encryption_key=$(docker run --rm e-launcher-center:local node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
session_key=$(docker run --rm e-launcher-center:local node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
cat > center.env <<EOF
CENTER_PUBLIC_URL=https://center.example.com:8443
CENTER_LINK_URL=wss://center.example.com:8790/v1/link
CENTER_ENCRYPTION_KEY_HEX=$encryption_key
CENTER_SESSION_KEY_HEX=$session_key
CENTER_OWNER_PASSWORD_HASH='$owner_hash'
EOF
unset owner_hash encryption_key session_key
docker compose up -d --no-build
```

`center.env` 由 Compose 的 env_file 读取，不是 Docker 构建输入；口令哈希
采用 `scrypt$<16字节salt hex>$<64字节key hex>`，单引号防止 Compose
将其中的 `$` 视为插值。两个 key 各为独立 32 字节的 64 位 hex。
`CENTER_PUBLIC_URL` 和 `CENTER_LINK_URL` 必须是设备可访问的实际地址；
反向代理场景需确保两个 TLS 服务和 WebSocket 路径都正确转发，项目不提供
代理。映射其他主机端口时同步修改这些外部 URL。Compose 固定容器内数据、
端口、Web 和证书路径；可在安全的 `center.env` 中另外设置
`CENTER_NPM_PATH` 为容器内 npm-cli.js 的绝对路径，默认使用中心安装的
固定 npm。不要更换密钥或覆盖数据来“修复”启动失败。

访问管理 HTTPS 地址，使用所有者口令登录并登记设备；Host 和 App 连接中心
并使用设备身份认证后才能运行。Hindsight 的 URL、凭证及 Bot 启用状态在
中心作为普通插件配置，后端服务不由本 Compose 创建。部署、版本、状态以
中心 operation 和设备实际回执为准，不以请求受理或容器启动代替验收。

## 维护和升级

`center-data` Docker volume 保存中心、relay 和受管安装数据；
`center.env` 与 `center-certs/` 在宿主机上，不在该 volume 中。备份前先
停止服务，并将数据归档、加密密钥和证书分开安全保存；归档包含敏感数据。
例如将 `BACKUP_DIR` 指向仓库外的受保护目录：

```sh
docker compose down
umask 077
docker compose run -T --rm --no-deps --entrypoint tar center -C /data -czf - . > "$BACKUP_DIR/center-data.tar.gz"
docker compose up -d --no-build
```

升级前备份并记录原镜像版本及配置；拉取/合并新源码与匹配锁文件后重建
镜像，使用原 volume、原加密密钥和证书重新启动。数据迁移及回滚应按实际
版本说明执行，不假定旧程序能读取升级后的数据库。替换证书后重启容器以
重新加载。停止、备份和恢复期间不要并行修改同一数据卷。

## 验收边界

本说明是部署入口而不是运行结果。上线前需真实验证登录、设备登记、Host
连接、两个 Bot 的配置继承与覆盖、Hindsight、HTTP 和 Node MCP、Skill、
更新/卸载与断线重连。构建和容器启动本身不能证明上述功能正常。
