#!/bin/bash
# Claudio-FM 启动脚本 — 强制使用 Node 22
# 用法: ./start.sh

NODE22="/Users/andrew/.workbuddy/binaries/node/versions/22.22.2/bin/node"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 杀掉旧进程
pkill -f "node.*server.js" 2>/dev/null
sleep 1

cd "$SCRIPT_DIR"
$NODE22 server.js
