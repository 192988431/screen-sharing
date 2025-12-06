// signaling-server.ts 修改版本

// 房间管理接口
interface Room {
  id: string;
  createdAt: number;
  lastActivity: number;
  emptySince?: number; // 记录房间开始为空的时间
  participantCount: number; // 当前房间人数
}

// 信令消息类型
interface SignalingMessage {
  type: string;
  roomId?: string;
  sdp?: string;
  candidate?: any;
  error?: string;
}

// WebSocket 连接管理（每个实例独立）
const connections = new Map<string, { creator?: WebSocket; joiner?: WebSocket }>();

// 使用 Deno KV 存储房间信息（跨实例共享）
const kv = await Deno.openKv();

const EMPTY_ROOM_TIMEOUT = 10 * 60 * 1000; // 10分钟空房间超时
const CLEANUP_INTERVAL = 30 * 1000; // 30秒清理一次过期房间

// 生成6位数字房间号
async function generateRoomId(): Promise<string> {
  let roomId: string;
  let exists = true;
  
  while (exists) {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
    const result = await kv.get(["rooms", roomId]);
    exists = result.value !== null;
  }
  
  return roomId!;
}

// 检查房间是否为空
function isRoomEmpty(room: Room): boolean {
  return room.participantCount === 0;
}

// 更新房间人数
async function updateRoomParticipantCount(roomId: string) {
  const conn = connections.get(roomId);
  if (!conn) return;
  
  let count = 0;
  if (conn.creator && conn.creator.readyState === WebSocket.OPEN) {
    count++;
  }
  if (conn.joiner && conn.joiner.readyState === WebSocket.OPEN) {
    count++;
  }
  
  const result = await kv.get<Room>(["rooms", roomId]);
  if (result.value) {
    const room = result.value;
    room.participantCount = count;
    room.lastActivity = Date.now();
    await kv.set(["rooms", roomId], room);
    console.log(`房间 ${roomId} 当前人数: ${count}`);
  }
}

// 清理过期房间
async function cleanupExpiredRooms() {
  const now = Date.now();
  const entries = kv.list<Room>({ prefix: ["rooms"] });
  
  for await (const entry of entries) {
    const room = entry.value;
    // 只清理已经标记为空的房间
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TIMEOUT) {
      console.log(`清理空房间: ${room.id} (空闲时间: ${Math.floor((now - room.emptySince) / 1000)}秒)`);
      await kv.delete(entry.key);
    }
  }
}

// 定期清理任务
setInterval(cleanupExpiredRooms, CLEANUP_INTERVAL);

// 处理信令消息
async function handleSignalingMessage(socket: WebSocket, message: SignalingMessage) {
  console.log(`📨 收到消息: type=${message.type}, roomId=${message.roomId || 'N/A'}`);
  
  switch (message.type) {
    case "create_room":
      console.log(`🏠 处理创建房间请求`);
      await handleCreateRoom(socket);
      break;
      
    case "join_room":
      console.log(`🚪 处理加入房间请求: roomId=${message.roomId}`);
      if (message.roomId) {
        await handleJoinRoom(socket, message.roomId);
      } else {
        console.error(`❌ 加入房间请求缺少 roomId`);
        socket.send(JSON.stringify({
          type: "error",
          error: "缺少房间号"
        }));
      }
      break;
      
    case "webrtc_offer":
      if (message.roomId && message.sdp) {
        await forwardToPeer(socket, message.roomId, {
          type: "webrtc_offer",
          sdp: message.sdp
        });
      }
      break;
      
    case "webrtc_answer":
      if (message.roomId && message.sdp) {
        await forwardToPeer(socket, message.roomId, {
          type: "webrtc_answer", 
          sdp: message.sdp
        });
      }
      break;
      
    case "ice_candidate":
      if (message.roomId && message.candidate) {
        await forwardToPeer(socket, message.roomId, {
          type: "ice_candidate",
          candidate: message.candidate
        });
      }
      break;
      
    case "keepalive":
      // 更新房间活动时间
      for (const [roomId, conn] of connections.entries()) {
        if (conn.creator === socket || conn.joiner === socket) {
          const result = await kv.get<Room>(["rooms", roomId]);
          if (result.value) {
            const room = result.value;
            room.lastActivity = Date.now();
            await kv.set(["rooms", roomId], room);
          }
          break;
        }
      }
      break;
      
    default:
      socket.send(JSON.stringify({
        type: "error",
        error: "未知的消息类型"
      }));
  }
}

// 处理创建房间
async function handleCreateRoom(socket: WebSocket) {
  const roomId = await generateRoomId();
  
  const room: Room = {
    id: roomId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    participantCount: 1 // 创建者初始人数为1
  };
  
  await kv.set(["rooms", roomId], room);
  
  // 保存 WebSocket 连接
  connections.set(roomId, { creator: socket });
  
  console.log(`✅ 创建新房间: ${roomId}，当前人数: 1`);
  console.log(`📊 房间已保存到 KV`);
  
  socket.send(JSON.stringify({
    type: "room_created",
    roomId: roomId
  }));
}

// 处理加入房间
async function handleJoinRoom(socket: WebSocket, roomId: string) {
  console.log(`📥 收到加入房间请求: ${roomId}`);
  
  const result = await kv.get<Room>(["rooms", roomId]);
  const room = result.value;
  
  if (!room) {
    console.error(`❌ 房间不存在: ${roomId}`);
    socket.send(JSON.stringify({
      type: "error",
      error: "房间不存在"
    }));
    return;
  }
  
  console.log(`✅ 找到房间: ${roomId}`);
  
  // 检查房间是否已满
  const conn = connections.get(roomId);
  if (conn && conn.joiner) {
    console.warn(`⚠️ 房间已满: ${roomId}`);
    socket.send(JSON.stringify({
      type: "error", 
      error: "房间已满"
    }));
    return;
  }
  
  // 将用户添加到房间
  if (conn) {
    conn.joiner = socket;
  } else {
    connections.set(roomId, { joiner: socket });
  }
  
  // 更新房间信息
  room.lastActivity = Date.now();
  room.emptySince = undefined;
  room.participantCount = 2;
  await kv.set(["rooms", roomId], room);
  
  console.log(`✅ 用户成功加入房间: ${roomId}，当前人数: 2`);
  
  // 通知加入者加入成功
  socket.send(JSON.stringify({
    type: "join_success"
  }));
  console.log(`📤 已发送加入成功消息给协助端`);
  
  // 通知房主有用户加入
  const creator = conn?.creator;
  if (creator && creator.readyState === WebSocket.OPEN) {
    creator.send(JSON.stringify({
      type: "peer_joined",
      participantCount: 2
    }));
    console.log(`📤 已发送对等端加入消息给主持端`);
  } else {
    console.log(`⚠️ 主持端连接已关闭，无法通知`);
  }
}

// 转发消息给对等方
async function forwardToPeer(sender: WebSocket, roomId: string, message: any) {
  const conn = connections.get(roomId);
  if (!conn) return;
  
  // 更新房间活动时间
  const result = await kv.get<Room>(["rooms", roomId]);
  if (result.value) {
    const room = result.value;
    room.lastActivity = Date.now();
    await kv.set(["rooms", roomId], room);
  }
  
  let target: WebSocket | undefined;
  
  if (sender === conn.creator) {
    target = conn.joiner;
  } else if (sender === conn.joiner) {
    target = conn.creator;
  }
  
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(message));
  }
}

// WebSocket 连接处理
function handleWebSocket(req: Request): Promise<Response> {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return Promise.resolve(new Response("请求需要升级为 WebSocket", { status: 426 }));
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    console.log(`🔌 WebSocket 连接已建立`);
  };

  socket.onmessage = async (event) => {
    console.log(`📩 收到原始消息: ${event.data}`);
    try {
      const message: SignalingMessage = JSON.parse(event.data);
      console.log(`✅ 消息解析成功: type=${message.type}`);
      await handleSignalingMessage(socket, message);
    } catch (error) {
      console.error("消息解析错误:", error);
      socket.send(JSON.stringify({
        type: "error",
        error: "无效的消息格式"
      }));
    }
  };

  socket.onclose = async () => {
    console.log(`🔌 WebSocket 连接已关闭`);
    
    // 查找并更新用户所在的房间
    for (const [roomId, conn] of connections.entries()) {
      if (conn.creator === socket || conn.joiner === socket) {
        const result = await kv.get<Room>(["rooms", roomId]);
        if (!result.value) continue;
        
        const room = result.value;
        
        // 清除断开用户的引用
        if (conn.creator === socket) {
          console.log(`⚠️ 房主断开连接，房间 ${roomId}`);
          
          // 通知协助端房主断开（如果有协助端）
          if (conn.joiner && conn.joiner.readyState === WebSocket.OPEN) {
            conn.joiner.send(JSON.stringify({
              type: "peer_disconnected",
              participantCount: 0
            }));
          }
          
          // 清除连接
          conn.creator = undefined;
          
          // 更新房间状态
          room.emptySince = Date.now();
          room.participantCount = conn.joiner ? 1 : 0;
          await kv.set(["rooms", roomId], room);
          
          console.log(`✅ 房间 ${roomId} 已标记为空，将在10分钟后自动清理`);
        } else if (conn.joiner === socket) {
          console.log(`⚠️ 协助端断开连接，房间 ${roomId}`);
          
          // 清除joiner引用
          conn.joiner = undefined;
          
          // 更新房间状态
          room.participantCount = conn.creator ? 1 : 0;
          if (room.participantCount === 0) {
            room.emptySince = Date.now();
          }
          await kv.set(["rooms", roomId], room);
          
          // 通知房主用户断开连接
          if (conn.creator && conn.creator.readyState === WebSocket.OPEN) {
            conn.creator.send(JSON.stringify({
              type: "peer_disconnected",
              participantCount: room.participantCount
            }));
          }
          
          console.log(`房间 ${roomId} 人数变为 ${room.participantCount}`);
        }
        
        // 如果房间完全空了，清理连接
        if (!conn.creator && !conn.joiner) {
          connections.delete(roomId);
        }
        
        break;
      }
    }
  };

  socket.onerror = (error) => {
    console.error("WebSocket 错误:", error);
  };

  return Promise.resolve(response);
}

// HTTP 请求处理（用于健康检查）
async function handleHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  if (url.pathname === "/health") {
    const entries = kv.list<Room>({ prefix: ["rooms"] });
    let count = 0;
    for await (const _ of entries) {
      count++;
    }
    
    return new Response(JSON.stringify({
      status: "ok",
      roomCount: count,
      timestamp: Date.now()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (url.pathname === "/stats") {
    const roomList: any[] = [];
    const entries = kv.list<Room>({ prefix: ["rooms"] });
    
    for await (const entry of entries) {
      const room = entry.value;
      roomList.push({
        id: room.id,
        createdAt: room.createdAt,
        lastActivity: room.lastActivity,
        participantCount: room.participantCount,
        isEmpty: isRoomEmpty(room),
        emptySince: room.emptySince
      });
    }
    
    return new Response(JSON.stringify({
      rooms: roomList,
      totalRooms: roomList.length
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  return new Response("信令服务器运行中", {
    headers: { "Content-Type": "text/plain" }
  });
}

// 主请求处理函数
export async function handleRequest(req: Request): Promise<Response> {
  if (req.headers.get("upgrade") === "websocket") {
    return handleWebSocket(req) as unknown as Response;
  } else {
    return await handleHttp(req);
  }
}

// 默认导出对象，包含fetch方法
export default {
  fetch: handleRequest,
};