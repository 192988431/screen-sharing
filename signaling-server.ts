// signaling-server.ts 修改版本

// 房间管理接口
interface Room {
  id: string;
  creator: WebSocket;
  joiner?: WebSocket;
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

// 存储房间信息
const rooms = new Map<string, Room>();
const EMPTY_ROOM_TIMEOUT = 10 * 60 * 1000; // 10分钟空房间超时
const CLEANUP_INTERVAL = 30 * 1000; // 30秒清理一次过期房间

// 生成6位数字房间号
function generateRoomId(): string {
  let roomId: string;
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(roomId));
  return roomId;
}

// 检查房间是否为空
function isRoomEmpty(room: Room): boolean {
  return room.participantCount === 0;
}

// 更新房间人数
function updateRoomParticipantCount(room: Room) {
  let count = 0;
  if (room.creator.readyState === WebSocket.OPEN) {
    count++;
  }
  if (room.joiner && room.joiner.readyState === WebSocket.OPEN) {
    count++;
  }
  room.participantCount = count;
  console.log(`房间 ${room.id} 当前人数: ${count}`);
}

// 清理过期房间
function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    // 更新房间人数
    updateRoomParticipantCount(room);
    
    if (isRoomEmpty(room)) {
      // 如果房间为空，检查是否已经超过空房间超时时间
      const emptySince = room.emptySince || room.lastActivity;
      if (now - emptySince > EMPTY_ROOM_TIMEOUT) {
        console.log(`清理空房间: ${roomId}`);
        rooms.delete(roomId);
      }
    } else {
      // 如果房间不为空，重置emptySince
      room.emptySince = undefined;
    }
  }
}

// 定期清理任务
setInterval(cleanupExpiredRooms, CLEANUP_INTERVAL);

// 处理信令消息
function handleSignalingMessage(socket: WebSocket, message: SignalingMessage) {
  console.log(`📨 收到消息: type=${message.type}, roomId=${message.roomId || 'N/A'}`);
  
  switch (message.type) {
    case "create_room":
      console.log(`🏠 处理创建房间请求`);
      handleCreateRoom(socket);
      break;
      
    case "join_room":
      console.log(`🚪 处理加入房间请求: roomId=${message.roomId}`);
      if (message.roomId) {
        handleJoinRoom(socket, message.roomId);
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
        forwardToPeer(socket, message.roomId, {
          type: "webrtc_offer",
          sdp: message.sdp
        });
      }
      break;
      
    case "webrtc_answer":
      if (message.roomId && message.sdp) {
        forwardToPeer(socket, message.roomId, {
          type: "webrtc_answer", 
          sdp: message.sdp
        });
      }
      break;
      
    case "ice_candidate":
      if (message.roomId && message.candidate) {
        forwardToPeer(socket, message.roomId, {
          type: "ice_candidate",
          candidate: message.candidate
        });
      }
      break;
      
    case "keepalive":
      // 更新房间活动时间
      for (const room of rooms.values()) {
        if (room.creator === socket || room.joiner === socket) {
          room.lastActivity = Date.now();
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
function handleCreateRoom(socket: WebSocket) {
  const roomId = generateRoomId();
  
  rooms.set(roomId, {
    id: roomId,
    creator: socket,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    participantCount: 1 // 创建者初始人数为1
  });
  
  console.log(`创建新房间: ${roomId}，当前人数: 1`);
  
  socket.send(JSON.stringify({
    type: "room_created",
    roomId: roomId
  }));
}

// 处理加入房间
function handleJoinRoom(socket: WebSocket, roomId: string) {
  console.log(`📥 收到加入房间请求: ${roomId} (类型: ${typeof roomId})`);
  console.log(`📊 当前房间列表: ${Array.from(rooms.keys()).join(', ')}`);
  console.log(`📊 当前房间总数: ${rooms.size}`);
  
  // 调试：检查房间是否存在
  const hasRoom = rooms.has(roomId);
  console.log(`🔍 rooms.has(${roomId}): ${hasRoom}`);
  
  const room = rooms.get(roomId);
  console.log(`🔍 rooms.get(${roomId}): ${room ? '找到' : '未找到'}`);
  
  if (!room) {
    console.error(`❌ 房间不存在: ${roomId}`);
    console.log(`📋 可用房间: ${Array.from(rooms.keys()).join(', ') || '无'}`);
    socket.send(JSON.stringify({
      type: "error",
      error: "房间不存在"
    }));
    return;
  }
  
  console.log(`✅ 找到房间: ${roomId}`);
  console.log(`   - 创建时间: ${new Date(room.createdAt).toISOString()}`);
  console.log(`   - 最后活动: ${new Date(room.lastActivity).toISOString()}`);
  console.log(`   - 房主状态: ${room.creator.readyState === WebSocket.OPEN ? '在线' : '离线'}`);
  console.log(`   - 协助端: ${room.joiner ? '已有' : '空缺'}`);
  
  if (room.joiner) {
    console.warn(`⚠️ 房间已满: ${roomId}`);
    socket.send(JSON.stringify({
      type: "error", 
      error: "房间已满"
    }));
    return;
  }
  
  // 将用户添加到房间
  room.joiner = socket;
  room.lastActivity = Date.now();
  // 房间不再为空，重置emptySince
  room.emptySince = undefined;
  // 更新房间人数
  updateRoomParticipantCount(room);
  
  console.log(`✅ 用户成功加入房间: ${roomId}，当前人数: ${room.participantCount}`);
  
  // 通知加入者加入成功
  socket.send(JSON.stringify({
    type: "join_success"
  }));
  console.log(`📤 已发送加入成功消息给协助端`);
  
  // 通知房主有用户加入
  if (room.creator.readyState === WebSocket.OPEN) {
    room.creator.send(JSON.stringify({
      type: "peer_joined",
      participantCount: room.participantCount
    }));
    console.log(`📤 已发送对等端加入消息给主持端`);
  } else {
    console.log(`⚠️ 主持端连接已关闭，无法通知`);
  }
}

// 转发消息给对等方
function forwardToPeer(sender: WebSocket, roomId: string, message: any) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // 更新房间活动时间
  room.lastActivity = Date.now();
  
  let target: WebSocket | undefined;
  
  if (sender === room.creator) {
    target = room.joiner;
  } else if (sender === room.joiner) {
    target = room.creator;
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
    console.log("WebSocket 连接已建立");
  };

  socket.onmessage = (event) => {
    console.log(`📩 收到原始消息: ${event.data}`);
    try {
      const message: SignalingMessage = JSON.parse(event.data);
      console.log(`✅ 消息解析成功: type=${message.type}`);
      handleSignalingMessage(socket, message);
    } catch (error) {
      console.error("消息解析错误:", error);
      socket.send(JSON.stringify({
        type: "error",
        error: "无效的消息格式"
      }));
    }
  };

  socket.onclose = () => {
    console.log("WebSocket 连接已关闭");
    
    // 查找并更新用户所在的房间
    for (const [roomId, room] of rooms.entries()) {
      if (room.creator === socket || room.joiner === socket) {
        // 更新房间人数
        const previousCount = room.participantCount;
        
        // 清除断开用户的引用
        if (room.creator === socket) {
          console.log(`房主断开连接，房间 ${roomId}`);
          // 如果房主断开，可以考虑直接删除房间或将joiner提升为房主
          // 这里选择直接删除房间
          if (room.joiner && room.joiner.readyState === WebSocket.OPEN) {
            room.joiner.send(JSON.stringify({
              type: "peer_disconnected",
              participantCount: 0
            }));
          }
          rooms.delete(roomId);
          console.log(`房间 ${roomId} 已删除（房主断开）`);
        } else if (room.joiner === socket) {
          console.log(`协助端断开连接，房间 ${roomId}`);
          // 清除joiner引用
          room.joiner = undefined;
          updateRoomParticipantCount(room);
          
          console.log(`用户断开连接，房间 ${roomId} 人数从 ${previousCount} 变为 ${room.participantCount}`);
          
          // 通知房主用户断开连接
          if (room.creator.readyState === WebSocket.OPEN) {
            room.creator.send(JSON.stringify({
              type: "peer_disconnected",
              participantCount: room.participantCount
            }));
          }
          
          // 检查房间是否为空，如果为空则设置emptySince
          if (isRoomEmpty(room)) {
            room.emptySince = Date.now();
            console.log(`房间 ${roomId} 现在为空，将在10分钟后过期`);
          }
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
function handleHttp(req: Request): Response {
  const url = new URL(req.url);
  
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      roomCount: rooms.size,
      timestamp: Date.now()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (url.pathname === "/stats") {
    const roomList = Array.from(rooms.values()).map(room => ({
      id: room.id,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity,
      hasJoiner: !!room.joiner,
      participantCount: room.participantCount,
      isEmpty: isRoomEmpty(room),
      emptySince: room.emptySince
    }));
    
    return new Response(JSON.stringify({
      rooms: roomList,
      totalRooms: rooms.size
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  return new Response("信令服务器运行中", {
    headers: { "Content-Type": "text/plain" }
  });
}

// 主请求处理函数
export function handleRequest(req: Request): Response {
  if (req.headers.get("upgrade") === "websocket") {
    return handleWebSocket(req) as unknown as Response;
  } else {
    return handleHttp(req);
  }
}

// 默认导出对象，包含fetch方法
export default {
  fetch: handleRequest,
};