// signaling-server-redis.ts - 使用 Redis 解决多实例问题
// 需要设置环境变量: UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN

import { Redis } from "https://esm.sh/@upstash/redis@1.28.0";

// 房间管理接口
interface Room {
  id: string;
  createdAt: number;
  lastActivity: number;
  emptySince?: number;
  participantCount: number;
  creatorInstanceId: string;
}

// 信令消息类型
interface SignalingMessage {
  type: string;
  roomId?: string;
  sdp?: string;
  candidate?: any;
  error?: string;
}

// 生成实例ID
const INSTANCE_ID = Math.random().toString(36).substring(7);
console.log(`🚀 信令服务器实例启动: ${INSTANCE_ID}`);

// 初始化 Redis 客户端
const redis = new Redis({
  url: Deno.env.get("UPSTASH_REDIS_REST_URL") || "",
  token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN") || "",
});

// 本地 WebSocket 连接管理
const connections = new Map<string, { creator?: WebSocket; joiner?: WebSocket }>();

const EMPTY_ROOM_TIMEOUT = 10 * 60 * 1000; // 10分钟
const CLEANUP_INTERVAL = 30 * 1000; // 30秒

// 生成6位数字房间号
async function generateRoomId(): Promise<string> {
  let roomId: string;
  let exists = true;
  
  while (exists) {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
    const room = await redis.get(`room:${roomId}`);
    exists = room !== null;
  }
  
  return roomId!;
}

// 清理过期房间
async function cleanupExpiredRooms() {
  const now = Date.now();
  const keys = await redis.keys("room:*");
  
  for (const key of keys) {
    const room = await redis.get<Room>(key);
    if (room && room.emptySince && now - room.emptySince > EMPTY_ROOM_TIMEOUT) {
      console.log(`[${INSTANCE_ID}] 清理空房间: ${room.id}`);
      await redis.del(key);
    }
  }
}

// 定期清理任务
setInterval(cleanupExpiredRooms, CLEANUP_INTERVAL);

// 处理创建房间
async function handleCreateRoom(socket: WebSocket) {
  const roomId = await generateRoomId();
  
  const room: Room = {
    id: roomId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    participantCount: 1,
    creatorInstanceId: INSTANCE_ID
  };
  
  await redis.set(`room:${roomId}`, JSON.stringify(room), { ex: 600 }); // 10分钟过期
  connections.set(roomId, { creator: socket });
  
  console.log(`[${INSTANCE_ID}] ✅ 创建新房间: ${roomId}`);
  
  socket.send(JSON.stringify({
    type: "room_created",
    roomId: roomId
  }));
}

// 处理加入房间
async function handleJoinRoom(socket: WebSocket, roomId: string) {
  console.log(`[${INSTANCE_ID}] 📥 收到加入房间请求: ${roomId}`);
  
  const roomData = await redis.get(`room:${roomId}`);
  
  if (!roomData) {
    console.error(`[${INSTANCE_ID}] ❌ 房间不存在: ${roomId}`);
    socket.send(JSON.stringify({
      type: "error",
      error: "房间不存在"
    }));
    return;
  }
  
  const room: Room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;
  
  console.log(`[${INSTANCE_ID}] ✅ 找到房间: ${roomId} (创建实例: ${room.creatorInstanceId})`);
  
  if (room.participantCount >= 2) {
    console.warn(`[${INSTANCE_ID}] ⚠️ 房间已满: ${roomId}`);
    socket.send(JSON.stringify({
      type: "error",
      error: "房间已满"
    }));
    return;
  }
  
  // 更新房间信息
  room.participantCount = 2;
  room.lastActivity = Date.now();
  room.emptySince = undefined;
  await redis.set(`room:${roomId}`, JSON.stringify(room), { ex: 600 });
  
  // 保存本地连接
  const conn = connections.get(roomId) || {};
  conn.joiner = socket;
  connections.set(roomId, conn);
  
  console.log(`[${INSTANCE_ID}] ✅ 用户成功加入房间: ${roomId}`);
  
  // 通知加入者
  socket.send(JSON.stringify({
    type: "join_success"
  }));
  
  // 通知创建者（如果在同一实例）
  if (conn.creator && conn.creator.readyState === WebSocket.OPEN) {
    conn.creator.send(JSON.stringify({
      type: "peer_joined",
      participantCount: 2
    }));
    console.log(`[${INSTANCE_ID}] 📤 已通知创建者`);
  } else {
    // 创建者在另一个实例，使用 Redis Pub/Sub
    await redis.publish(`room:${roomId}:events`, JSON.stringify({
      type: "peer_joined",
      participantCount: 2
    }));
    console.log(`[${INSTANCE_ID}] 📤 已通过 Redis 发布事件`);
  }
}

// 转发消息给对等方
async function forwardToPeer(sender: WebSocket, roomId: string, message: any) {
  const conn = connections.get(roomId);
  
  // 更新活动时间
  const roomData = await redis.get(`room:${roomId}`);
  if (roomData) {
    const room: Room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;
    room.lastActivity = Date.now();
    await redis.set(`room:${roomId}`, JSON.stringify(room), { ex: 600 });
  }
  
  let target: WebSocket | undefined;
  
  if (conn) {
    if (sender === conn.creator) {
      target = conn.joiner;
    } else if (sender === conn.joiner) {
      target = conn.creator;
    }
  }
  
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(message));
  } else {
    // 对等方在另一个实例，使用 Redis Pub/Sub
    await redis.publish(`room:${roomId}:messages`, JSON.stringify(message));
  }
}

// 处理信令消息
async function handleSignalingMessage(socket: WebSocket, message: SignalingMessage) {
  console.log(`[${INSTANCE_ID}] 📨 收到消息: type=${message.type}`);
  
  switch (message.type) {
    case "create_room":
      await handleCreateRoom(socket);
      break;
      
    case "join_room":
      if (message.roomId) {
        await handleJoinRoom(socket, message.roomId);
      }
      break;
      
    case "webrtc_offer":
    case "webrtc_answer":
    case "ice_candidate":
      if (message.roomId) {
        await forwardToPeer(socket, message.roomId, message);
      }
      break;
      
    case "keepalive":
      // 更新活动时间
      for (const [roomId, conn] of connections.entries()) {
        if (conn.creator === socket || conn.joiner === socket) {
          const roomData = await redis.get(`room:${roomId}`);
          if (roomData) {
            const room: Room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;
            room.lastActivity = Date.now();
            await redis.set(`room:${roomId}`, JSON.stringify(room), { ex: 600 });
          }
          break;
        }
      }
      break;
  }
}

// WebSocket 连接处理
function handleWebSocket(req: Request): Response {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("请求需要升级为 WebSocket", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    console.log(`[${INSTANCE_ID}] 🔌 WebSocket 连接已建立`);
  };

  socket.onmessage = async (event) => {
    try {
      const message: SignalingMessage = JSON.parse(event.data);
      await handleSignalingMessage(socket, message);
    } catch (error) {
      console.error(`[${INSTANCE_ID}] 消息处理错误:`, error);
    }
  };

  socket.onclose = async () => {
    console.log(`[${INSTANCE_ID}] 🔌 WebSocket 连接已关闭`);
    
    // 清理连接
    for (const [roomId, conn] of connections.entries()) {
      if (conn.creator === socket || conn.joiner === socket) {
        const roomData = await redis.get(`room:${roomId}`);
        if (roomData) {
          const room: Room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;
          
          if (conn.creator === socket) {
            conn.creator = undefined;
            room.participantCount--;
          } else if (conn.joiner === socket) {
            conn.joiner = undefined;
            room.participantCount--;
          }
          
          if (room.participantCount === 0) {
            room.emptySince = Date.now();
          }
          
          await redis.set(`room:${roomId}`, JSON.stringify(room), { ex: 600 });
          
          // 通知对等方
          if (conn.creator && conn.creator.readyState === WebSocket.OPEN) {
            conn.creator.send(JSON.stringify({ type: "peer_disconnected" }));
          }
          if (conn.joiner && conn.joiner.readyState === WebSocket.OPEN) {
            conn.joiner.send(JSON.stringify({ type: "peer_disconnected" }));
          }
        }
        
        if (!conn.creator && !conn.joiner) {
          connections.delete(roomId);
        }
        
        break;
      }
    }
  };

  return response;
}

// HTTP 请求处理
function handleHttp(req: Request): Response {
  const url = new URL(req.url);
  
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      instanceId: INSTANCE_ID,
      timestamp: Date.now()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  return new Response(`信令服务器运行中 (实例: ${INSTANCE_ID})`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

// 主请求处理函数
export function handleRequest(req: Request): Response {
  if (req.headers.get("upgrade") === "websocket") {
    return handleWebSocket(req);
  } else {
    return handleHttp(req);
  }
}

export default {
  fetch: handleRequest,
};
